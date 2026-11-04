// The turn loop: what happens after the player sends a message.
// 1) triage (code, then the local helper)  2) the player's dice  3) maybe a random event
// 4) the table, only if needed: the REFEREE rules (Claude, mechanics only), the code does what the
//    ruling says (dice, books, fight, scene), the STORYTELLER tells it (Claude, prose and briefs)
// 5) actors reply.
//
// The story is the truth outside a fight: the DM narrates, the code keeps the books (HP, conditions,
// gold, items, the clock, the dice) and draws a sketch of the scene from the DM's scene card. In a
// fight the grid is the truth: initiative, movement, reach and damage run on the battle map.

import { ST } from './st.js';
import { ensureAnimalFigures } from './figures.js';
import { settings, currentSpend, modelFor, mapsOn } from './settings.js';
import { campaign, saveMeta, saveDoc } from './campaign.js';
import { callLocal, BudgetError } from './llm.js';
import { maybeCondenseNotes, resetStableCache } from './dm.js';
import { askReferee, dueToAct } from './referee.js';
import { askStoryteller } from './storyteller.js';
import { modelLabel } from '../core/models.js';
import { rotateIdleNpcs, removeNpcsFromGroup, touchNpc } from './npccards.js';
import { withDmThinking } from '../ui/thinking.js';
import { makeSpeak, refreshStandingPrompt, speakerCandidates, markSceneStart, recentRepliesOf } from './actors.js';
import { DM_NAME, postNarration, postOoc, postPlayerOoc, postDiceCard, postNote, dmType } from './messages.js';
import { statsForName, levelCharacterSheet } from './sheets.js';
import { pickNpcVoice, voiceLine, stopVoices } from './voices.js';
import { normalizeMap, themeFor, applyPositions, placeMissing, placeNear, parseCoord, toCoord, clampMove, speedSquares, reachable } from '../core/grid.js';
import { isBeast } from '../core/sprites.js';
import { notAPerson, notAPersonEntry } from '../core/people.js';
import { buildSketch } from '../core/sketch.js';
import { ensureClock, passTime, skipTo, parseDuration, parseWeather, clockText, climateOf, WEATHER_WORDS } from '../core/clock.js';
import { openMap, refreshMap, playAnim, setMapBusy } from '../ui/map.js';
import { beginTurn } from '../ui/status.js';
import { ruleTriage, helperTriagePrompt, parseHelperTriage, companionActionPrompt, parseCompanionAction, companionCombatPrompt, parseCompanionCombat, rollBelongsTo, isEndTurn } from '../core/triage.js';
import { tickPlayerTurn, dmReasons, applyDmPacing, updateFun, isFillerMessage } from '../core/pacing.js';
import { eventChance, eligibleEvents, pickEvent, guessSetting, normalizeEvent } from '../core/deck.js';
import { roll, judge, formatModifier, random01, saveDamage, diceText, doubleDice, diceMax, normalizeNotation } from '../core/dice.js';
import { applyStateChanges, addNpcs, startCombat, addToInitiative, ensureEnemy, dropFallen, endCombat, lookupModifier, changeHp, worldFlags, ensureParty, applyPresence, isAway, conditionsOf, noteSeen, applyNoticed, attackDamage, moveBudget, spendMove, markDash, newRound } from '../core/world.js';
import { budgetStatus, formatUsd } from '../core/budget.js';
import { matchName, nameKey, trimToTokens, repeatedPhrases } from '../core/text.js';
import { turnPromptsOn, askEndTurn, askReaction } from './prompts.js';
import { sfx } from '../ui/sound.js';
import { applySceneCard, pushTimeline, applyTableRules, samePlace } from '../core/state.js';
import { snapshotTurn, sealTurn } from './undo.js';
import { expireConditions, takeRest, spend, dying, deathSave } from '../core/upkeep.js';
import { mergeMind } from '../core/minds.js';

let running = false;
/** A turn (the DM, the opening) is in progress: the map shows it and takes no taps that move anyone. */
function setRunning(on) {
    running = on;
    setMapBusy(on);
}
let rerunRequested = false;
let deck = null;

/** Load the event deck (data/events.json), once. */
export async function loadDeck() {
    if (deck) return deck;
    try {
        const url = new URL('../../data/events.json', import.meta.url);
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json();
        deck = (Array.isArray(data) ? data : data.events || []).map(normalizeEvent);
    } catch (error) {
        console.error('[Dungeon Master] Could not load events.json', error);
        deck = [];
    }
    return deck;
}

export function isRunning() {
    return running;
}

/** A player message sent while a side flow held the turn asked for a rerun: run it now that we're free. */
function runQueuedTurn() {
    if (!rerunRequested) return;
    rerunRequested = false;
    setTimeout(() => runTurn(), 50);
}

function budget() {
    const s = settings();
    return budgetStatus({ ...currentSpend(), monthlyCap: Number(s.monthlyCap), nightlySoftCap: Number(s.nightlySoftCap) });
}

/** Latest player message text. */
function lastPlayerMessage() {
    return lastPlayerEntry()?.mes || '';
}

/** Latest player message, with a key that identifies it even if earlier messages get deleted. */
function lastPlayerEntry() {
    for (let i = ST.chat.length - 1; i >= 0; i--) {
        const m = ST.chat[i];
        if (m?.is_user && !m.is_system) return { mes: m.mes || '', key: `${m.send_date ?? ''}|${String(m.mes ?? '').slice(0, 80)}` };
    }
    return null;
}

function recentForHelper(n = 6) {
    const out = [];
    for (let i = ST.chat.length - 2; i >= 0 && out.length < n; i--) {
        const m = ST.chat[i];
        if (!m?.mes || m.is_system) continue;
        out.unshift(`${m.name}: ${trimToTokens(m.mes, 120)}`);
    }
    return out.join('\n');
}

/**
 * Run one turn.
 * @param {{force?: string|null, oocText?: string, placeEvent?: string}} opts force = a reason to call the DM regardless;
 *  placeEvent = something the code wants ruled on (a reaction to a hit)
 * A roll read from SillyTavern's dice waits in meta.pendingRoll.autoResult (see dicewatch.js).
 */
export async function runTurn(opts = {}) {
    const c = campaign();
    if (!c || c.meta.paused) return;
    if (running) {
        rerunRequested = true;
        return;
    }
    setRunning(true);
    const controller = new AbortController();
    const onStop = () => controller.abort();
    ST.eventSource.on(ST.eventTypes.GENERATION_STOPPED, onStop);
    const status = beginTurn('Dungeon Master');
    // The state before this turn, so deleting its narration can undo it (undo.js).
    const snap = snapshotTurn(c);
    try {
        await turnBody(c, opts, status, controller.signal);
        sealTurn(snap);
        const left = await rotateIdleNpcs();
        if (left.length) status.note(`${left.join(', ')} left the scene`);
        status.finish(`Turn done${c.meta.stats.lastTurnUsd ? ` · ${formatUsd(c.meta.stats.lastTurnUsd)} est.` : ''}`);
    } catch (error) {
        if (controller.signal.aborted) {
            status.note('Stopped');
            status.finish('Stopped by you');
        } else if (error instanceof BudgetError) {
            status.note('Budget reached: local-only mode');
            status.finish('Budget reached');
            toastr.warning('Your monthly Claude budget is used up. The party keeps playing locally; the DM is resting. Raise the cap in the Dungeon Master settings to continue.', 'Dungeon Master', { timeOut: 12000 });
        } else {
            console.error('[Dungeon Master] Turn failed', error);
            status.finish('Something went wrong');
            toastr.error(String(error?.message || error), 'Dungeon Master', { timeOut: 10000 });
        }
    } finally {
        ST.eventSource.removeListener(ST.eventTypes.GENERATION_STOPPED, onStop);
        saveMeta();
        setRunning(false);
        if (rerunRequested) {
            rerunRequested = false;
            setTimeout(() => runTurn(), 50);
        }
    }
}

/** The climate where the party is: the world's setting and the sketch's theme. */
function climateHere(c) {
    return climateOf(c.docs.world.setting, c.docs.world.sketch?.map?.theme || c.docs.world.combat?.map?.theme || '');
}

/** Minutes pass on the world's clock; the weather may turn; the map follows. */
async function tickClock(c, minutes, status) {
    const w = c.docs.world;
    const { weather } = passTime(w, minutes, { climate: climateHere(c) });
    if (weather) {
        status?.note(`The weather turns: ${WEATHER_WORDS[weather]}`);
        await postDiceCard(`🌦️ The weather turns: ${WEATHER_WORDS[weather]}.`, { state: true });
    }
    refreshMap();
    saveDoc('world');
}

async function turnBody(c, opts, status, signal) {
    const s = settings();
    const meta = c.meta;
    const pacing = meta.pacing;
    const autoRoll = meta.pendingRoll?.autoResult ?? null;
    // Only a real player turn acts on their message. A forced turn (the end of a combat turn, a
    // reaction) must not read the last message again.
    let playerText = opts.force || autoRoll ? '' : lastPlayerMessage();
    meta.stats.lastTurnUsd = 0;
    // "I end my turn." typed is the End my turn button.
    if (c.docs.world.combat && turnPromptsOn() && !opts.force && !autoRoll && isEndTurn(playerText)) { opts = { ...opts, force: 'end_turn' }; playerText = ''; c.docs.world.combat.phase = 'others'; saveDoc('world'); status.note('You ended your turn'); }
    // A fight is on when the code has one; a scene the DM labelled "combat" without one never freezes the map.
    if (pacing.inCombat && !c.docs.world.combat) { pacing.inCombat = false; status.note('No fight is running: the map moves again'); }
    let turnUsd = 0;

    // Each player message is handled once, however many times a turn gets triggered for it.
    if (!autoRoll && !opts.force) {
        const entry = lastPlayerEntry();
        if (entry && entry.key === meta.lastHandledPlayer) return;
        meta.lastHandledPlayer = entry?.key ?? null;
    }

    // A roll that was already read from SillyTavern's dice, typed in again: nothing to do.
    if (!autoRoll && !opts.force && !meta.pendingRoll && isRetypedAutoRoll(meta, playerText)) {
        status.note('That roll was already read from your dice');
        return;
    }

    // ---------- 1. Triage ----------
    let triage = { category: null, ooc: false, rollResult: false, stalled: false, speakers: [] };
    if (autoRoll) {
        meta.turn++;
        triage = { ...triage, rollResult: true, roll: autoRoll, category: pacing.inCombat ? 'combat_action' : 'action' };
    } else if (opts.force !== 'manual' && opts.force !== 'opening') {
        meta.turn++;
        pacing.localTurnsSinceDM++;
        const rule = ruleTriage(playerText, { pendingRoll: meta.pendingRoll, inCombat: pacing.inCombat, companions: meta.party.map(p => p.name), player: meta.persona.name });
        // The clock ticks by turn: a few minutes of story each; a minute a round in a fight; nothing for a question out of character.
        if (!rule.ooc && opts.force !== 'end_turn' && opts.force !== 'reaction') await tickClock(c, pacing.inCombat || c.docs.world.combat ? 1 : Math.max(1, Number(s.minutesPerTurn) || 10), status);
        // "((it's the middle of the night))": the player's word on the time of day stands; the clock is set to it.
        const saidTime = rule.ooc ? /\b(?:it'?s|it is|now|make it|let'?s say it'?s|say it'?s|time is)\s+(?:the\s+)?(midnight|middle of the night|dead of night|small hours|late at night|first light|daybreak|dawn|sunrise|early morning|morning|mid-?morning|noon|midday|afternoon|late afternoon|early evening|dusk|sunset|evening|nightfall|late evening|night)\b/i.exec(rule.oocText || playerText) : null;
        if (saidTime) { ensureClock(c.docs.world); skipTo(c.docs.world, saidTime[1].toLowerCase(), { climate: climateHere(c) }); saveDoc('world'); status.note(`Clock set: ${clockText(c.docs.world)}`); }
        triage = { ...triage, ...rule };
        let engaged = null;
        if (rule.needsHelper && s.useHelper) {
            const step = status.step('Reading your move (local helper)');
            try {
                const candidates = speakerCandidates().filter(n => !isBeast((c.docs.npcs || []).find(x => x.name === n) ?? { name: n }));
                const helpers = meta.party.map(p => p.name).filter(n => candidates.includes(n));
                const { system, user } = helperTriagePrompt({
                    companions: helpers,
                    player: meta.persona.name,
                    message: trimToTokens(playerText, 500),
                    recent: recentForHelper(),
                    speakers: candidates,
                    scene: `${c.docs.world.location || 'unknown'}; ${meta.standing || ''}`,
                    away: Object.entries(c.docs.world.away ?? {}).map(([n, where]) => `${n} (${where})`),
                });
                const raw = await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: Math.max(240, Number(s.helperMaxTokens) || 0), profileId: s.helperProfileId });
                const h = parseHelperTriage(raw, candidates);
                const who = h.task && matchName(h.task.who, helpers);
                if (who) triage.task = { ...h.task, who };
                if (!rule.category) triage.category = h.category;
                triage.stalled = h.stalled;
                triage.speakers = h.speakers;
                triage.helperChoseSpeakers = true;
                pacing.refusalStreak = h.refusing ? (pacing.refusalStreak ?? 0) + 1 : 0;
                engaged = h.engaged;
                // Who is the player talking to? A known NPC answers locally; a stranger needs the table.
                if (h.addressed && !/^(dm|dungeon master|narrator|everyone|nobody|none)$/i.test(h.addressed)) {
                    const npcNames = (c.docs.npcs || []).map(n => n.name);
                    const known = matchName(h.addressed, [...meta.party.map(p => p.name), ...npcNames, meta.persona.name]);
                    if (!known) triage.unknownAddressee = h.addressed;
                    else if (npcNames.includes(known)) {
                        triage.speakers = [known, ...triage.speakers.filter(sp => sp !== known)].slice(0, 2);
                        touchNpc(c.docs.npcs.find(n => n.name === known));
                    }
                }
                step.done(`${triage.category}${triage.task ? ` · ${triage.task.who}: ${triage.task.what || 'a task'}${triage.task.dm ? ' (the table decides)' : ''}` : ''}${triage.unknownAddressee ? ` · talking to ${triage.unknownAddressee} (new)` : ''}${triage.speakers.length ? ` → ${triage.speakers.join(', ')}` : ''}`);
            } catch (error) {
                step.fail(error);
                if (!triage.category) triage.category = 'banter';
            }
        } else if (!triage.category) {
            triage.category = 'banter';
        }
        // Typed roll results are mechanics, not story turns: they don't count toward pacing.
        if (!triage.rollResult) {
            updateFun(pacing, { engaged, messageLength: playerText.length });
            const filler = !triage.ooc && isFillerMessage(playerText, engaged);
            tickPlayerTurn(pacing, meta.options.length, { filler, chatting: !filler && ['banter', 'question'].includes(triage.category) });
        }
    }
    if (signal.aborted) throw new Error('aborted');
    if (!opts.force && !autoRoll) await upkeepTurn(c, status);
    let placeEvent = opts.placeEvent || '';
    let events = [];

    // ---------- 2. Player roll resolution ----------
    // Everything the code posts from here (the player's roll, a hit's damage) is part of the table's ruling the storyteller reads.
    const fromIndex = ST.chat.length;
    let rollResolution = '';
    let criticalRoll = false;
    if (triage.rollResult && meta.pendingRoll) {
        rollResolution = await resolvePlayerRoll(c, triage.roll, status);
        const last = c.docs.rolls_log.at(-1);
        criticalRoll = Boolean(last && last.kind !== 'damage' && (last.natural === 1 || last.natural === 20));
    }

    // ---------- 3. Random event (the storyteller decides whether one fits) ----------
    const b = budget();
    if (!pacing.inCombat && b.level !== 'blocked' && opts.force !== 'opening') {
        events = await maybeDrawEvents(c, status, b.level === 'tight');
    }

    // ---------- 4. Does the table step in? ----------
    let reasons = dmReasons({
        pacing,
        triage,
        eventDue: events.length > 0,
        checkinEvery: Number(s.checkinEvery) || 5,
        budgetBlocked: b.level === 'blocked',
        budgetTight: b.level === 'tight',
        lastDriftStageCalled: meta.lastDriftStageCalled,
    });
    if (opts.force) reasons = [...new Set([opts.force, ...reasons])];
    // The world doesn't check in during a fight: the round is the whole world.
    if (c.docs.world.combat) reasons = reasons.filter(r => r !== 'checkin');
    // Calm turns after a fight or a capture: no random event, no pressure push; the player breathes.
    if (Number.isFinite(pacing.calmUntil) && meta.turn < pacing.calmUntil) reasons = reasons.filter(r => r !== 'event' && r !== 'drift' && r !== 'stalled');
    // Turn prompts: the player's message in a fight is THEIR turn (the referee resolves only that); "end_turn" hands the round on.
    const opening = meta.openingRound?.turn === meta.turn ? meta.openingRound : null;
    if (c.docs.world.combat && turnPromptsOn()) {
        const cb = c.docs.world.combat;
        if (opts.force === 'end_turn') cb.phase = 'others';
        else if (opening) cb.phase = 'others';
        else if (!opts.force && !autoRoll && !triage.ooc && cb.order?.some(o => o.name === meta.persona.name)) cb.phase = 'player';
        if (opening) reasons = reasons.map(r => r === 'combat_round' ? 'round_opens' : r);
        else if (cb.phase === 'player' && !opts.force) reasons = reasons.map(r => r === 'combat_round' ? 'player_turn' : r);
        if (opts.force === 'end_turn' || opts.force === 'reaction') reasons = reasons.filter(r => r !== 'combat_round' && r !== 'combat_action');
    } else if (opening) reasons = reasons.map(r => r === 'combat_round' ? 'round_opens' : r);
    // A roll's result in a fight settles that roll and nothing else: the round goes on with the player's next action.
    if (reasons.includes('roll_result') && !opening) reasons = reasons.filter(r => r !== 'combat_round' && r !== 'combat_action');
    if (triage.task?.dm && !reasons.includes('companion_task')) reasons.push('companion_task');
    // Nobody would answer this locally (alone, or nobody nearby would reply): the world responds.
    if (!reasons.length && !opts.force && !triage.rollResult && !localSpeakers(c, triage, playerText).length) reasons = ['solo'];
    if (b.level === 'blocked' && reasons.length) {
        status.note('Budget reached: the table is resting (local-only)');
        reasons = [];
    }

    if (reasons.length) {
        let result;
        try {
            const companionChoices = opts.force === 'end_turn' || opening ? await decideCompanionTurns(c, status, opening?.names).catch(error => { console.warn('[Dungeon Master] companion choices failed', error); return null; }) : null;
            // Quiet exploring: the player is moving, searching or working a lock, not talking to anyone.
            const quiet = !triage.ooc && !triage.speakers?.length && ['action', 'risky_action', 'scene_move'].includes(triage.category);
            result = await consultTable(c, {
                reasons,
                companionChoices,
                playerMessage: playerText,
                rollResolution,
                events,
                oocText: opts.oocText || triage.oocText || '',
                placeEvent,
                companionTask: triage.task?.dm ? { name: triage.task.who, what: triage.task.what } : null,
                mustAct: dueToAct(c, { reasons, opening }),
                fromIndex,
            }, { status, signal, criticalRoll, quiet });
            turnUsd += result.usd;
        } catch (error) {
            if (!signal.aborted) toastr.error(String(error?.message || error), 'Dungeon Master', { timeOut: 10000 });
            if (error instanceof BudgetError) throw error;
            // Fall back to a local reply so the scene doesn't stall.
            await localReplies(c, triage, playerText, status, signal);
            return;
        }
        if (reasons.includes('drift')) {
            meta.lastDriftStageCalled = pacing.driftStage;
            pacing.pressureCallAge = 0;
        }
        if (reasons.includes('stalled')) pacing.fillerStreak = 0;
        if (reasons.includes('deadlock')) pacing.refusalStreak = 0;
        // Their action is resolved: done with the turn, or more to do (movement, a bonus action)?
        const cb = c.docs.world.combat;
        if (cb && turnPromptsOn() && cb.phase === 'player' && !opts.force && !triage.ooc && !meta.pendingRoll && !signal.aborted && !(c.docs.world.party?.[meta.persona.name]?.hp <= 0) && !(meta.lastRoll?.kind === 'initiative' && meta.lastRoll.turn === meta.turn)) {
            if (await askEndTurn(meta.persona.name)) {
                cb.phase = 'others';
                saveDoc('world');
                setTimeout(() => runTurn({ force: 'end_turn' }), 50);
            } else status.note('Your turn goes on: move or act, then end it');
        }
        // A beat landed: the pressure ladder starts over from the bottom.
        if (result.story?.beats_completed?.length) meta.lastDriftStageCalled = 0;
        meta.stats.lastTurnUsd = turnUsd;
        if (Math.random() < 0.15) {
            maybeCondenseNotes().catch(err => console.warn('[Dungeon Master] notes condense failed', err));
        }
    } else {
        if (rollResolution) {
            // A roll without a table call can't happen (roll_result always calls it), but be safe.
            await postNote(rollResolution);
        }
        await localReplies(c, triage, playerText, status, signal);
        await ruleOnCompanionAttempts(c, localReplies.lastSpeakers || [], status, signal);
    }
    // The opening of round 1 is done with (whatever the table made of it): from here the player's turn is theirs.
    if (meta.openingRound) { delete meta.openingRound; if (c.docs.world.combat && turnPromptsOn()) c.docs.world.combat.phase = 'player'; saveMeta(); }
}

/**
 * One turn at the table: the referee rules, the code does what the ruling says, the storyteller
 * tells it. On a turn whose ruling only asks the player for a roll, the storyteller isn't called:
 * the 🎲 card carries the referee's reason, and the story comes with the result.
 * @returns {Promise<{usd: number, ruling: object, story: object|null, escalated: boolean}>}
 */
async function consultTable(c, args, { status, signal, criticalRoll = false, quiet = false } = {}) {
    let usd = 0;
    // 1. The referee rules on the mechanics.
    const refModel = modelFor(['referee']);
    const step = status.step(`Referee rules (${modelLabel(refModel)}) · ${args.reasons.join(', ')}`);
    let ref;
    try {
        ref = await withDmThinking('The referee is ruling', () => askReferee(args, { signal, model: refModel }));
        step.done(summarizeRuling(ref.turn), ref.usd);
        usd += ref.usd;
    } catch (error) {
        step.fail(error);
        throw error;
    }
    // 2. The code does what the ruling says: the dice, the books, the fight, the scene.
    const ruled = await applyRuling(c, ref.turn, status, signal, { reasons: args.reasons, fromIndex: args.fromIndex ?? ST.chat.length });
    // 3. The storyteller tells it, unless nothing is settled yet but a roll asked of the player.
    const rollOnly = Boolean(ruled.request) && !ruled.forStory.settled.length && !ruled.newScene && !ruled.forStory.fact && !Object.keys(ruled.forStory.held).length;
    let story = null;
    if (rollOnly) status.note(`A roll is asked: the storyteller waits for it`);
    else if (!signal.aborted) {
        const model = modelFor(['storyteller'], { criticalRoll });
        const step2 = status.step(`Storyteller (${modelLabel(model)})`);
        try {
            story = await withDmThinking('The storyteller is writing', () => askStoryteller({ ...args, ruling: ruled.forStory }, { signal, model }));
            step2.done(`${summarizeStory(story.turn)} · ${modelLabel(story.model)}${story.escalated ? ' (handed up)' : ''}`, story.usd);
            usd += story.usd;
        } catch (error) {
            // The ruling stands and its cards are posted; the roll request still goes up below.
            step2.fail(error);
            if (error instanceof BudgetError || signal.aborted) throw error;
            toastr.error(String(error?.message || error), 'Dungeon Master', { timeOut: 10000 });
        }
    }
    await applyStory(c, story?.turn ?? null, status, signal, { events: args.events || [], reasons: args.reasons, quiet, ruled, dropped: story?.dropped || [] });
    return { usd, ruling: ref.turn, story: story?.turn ?? null, escalated: Boolean(story?.escalated) };
}

/**
 * The start of each player turn: conditions that have run out come off, and anyone dying rolls their
 * death save (outside fights; in a fight it's once a round).
 */
async function upkeepTurn(c, status) {
    const w = c.docs.world;
    const ended = expireConditions(w, { turn: c.meta.turn });
    if (ended.length) { saveDoc('world'); await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true }); }
    if (!w.combat) await deathSaves(c);
}

/**
 * Death saving throws for everyone at 0 HP who isn't stable or dead (once a round in a fight, once a
 * turn outside one). Companions' are rolled in the open by code; the player is asked to roll theirs.
 */
async function deathSaves(c) {
    const w = c.docs.world, meta = c.meta;
    const tick = `${meta.turn}:${w.combat?.round ?? ''}`;
    if (w.deathTick === tick) return;
    w.deathTick = tick;
    const lines = [];
    for (const name of dying(w)) {
        if (name === meta.persona.name) {
            if (meta.pendingRoll) continue;
            meta.pendingRoll = { kind: 'save', skill: 'Death saving throw', ability: '', die: 20, dc: 10, advantage: 'none', reason: 'You are dying. 10 or higher is a success, a 20 brings you back with 1 HP, a 1 counts as two failures. Three successes and you are stable; three failures and you die.', damage: '', half: false, bonus: 0, death: true };
            await postDiceCard(`🎲 **${meta.persona.name}**, you're dying: roll a **d20** for your **death saving throw** and type the number${settings().autoReadDice !== false ? ' (or roll with SillyTavern\'s dice)' : ''}.`, { request: meta.pendingRoll });
            meta.pendingRoll.chatIndex = ST.chat.length;
            continue;
        }
        const r = roll('1d20');
        const res = deathSave(w, name, r?.natural ?? r?.total ?? 10);
        lines.push(`🎲 **${name}** · death save: **${r?.total}** · ${res.line}`);
    }
    saveDoc('world');
    saveMeta();
    if (lines.length) { await postDiceCard(lines.join('\n'), { state: true }); refreshMap(); }
}

/** The companions in a fight around the player: with them (not away). */
export function fighters(c) {
    const w = c.docs.world;
    return c.meta.party.map(p => p.name).filter(n => !isAway(w, n));
}

/** The party members in the current fight (the player first). */
function fightParty(c) {
    return [c.meta.persona.name, ...(c.docs.world.combat?.party ?? c.meta.party.map(p => p.name))];
}

/**
 * Each round: a companion who wasn't in the fight but is now (came back to the player) joins it:
 * the code rolls her initiative and she takes a square beside the player. Returns lines.
 */
function joinLateFighters(c) {
    const w = c.docs.world, meta = c.meta;
    if (!w.combat) return [];
    w.combat.party ??= meta.party.map(p => p.name).filter(n => w.combat.order.some(o => o.name === n));
    const lines = [];
    for (const name of fighters(c)) {
        if (w.combat.party.includes(name)) continue;
        const mod = lookupModifier(statsForName(name, meta), { kind: 'initiative', skill: 'initiative', ability: 'DEX' }).mod;
        const r = roll(`1d20${mod >= 0 ? '+' : ''}${mod}`);
        addToInitiative(w, name, r?.total ?? 10);
        w.combat.party.push(name);
        lines.push(`${name} joins the fight: initiative **${r?.total ?? 10}**`);
    }
    return lines;
}

/**
 * Someone in the fight who isn't on its roster yet (they joined after it started, or the DM named
 * them for the first time): put them on it with their NPC stats when there are any (HP 10, AC 12
 * otherwise) and roll their initiative in. Returns their name on the roster, or null (the party, nobody, or no fight).
 */
async function enemyHere(c, name, status = null) {
    const world = c.docs.world, meta = c.meta;
    const clean = String(name || '').trim();
    if (!world.combat || !clean || /^(someone|something|somebody|anyone|the party|everyone|nobody|no one|you|them|it)$/i.test(clean)) return null;
    const party = [meta.persona.name, ...meta.party.map(p => p.name)];
    if (matchName(clean, party)) return null;
    const known = matchName(clean, Object.keys(world.combat.enemies || {}));
    if (known) return known;
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(clean)) ?? (c.docs.npcs || []).find(n => matchName(clean, [n.name]));
    const stats = String(npc?.stats || '');
    const hp = Number(/\bHP\s*(\d+)/i.exec(stats)?.[1]) || 10, ac = Number(/\bAC\s*(\d+)/i.exec(stats)?.[1]) || 12;
    const added = ensureEnemy(world, npc?.name ?? clean, { hp, ac, sprite: npc?.sprite || '' });
    if (!added) return null;
    status?.note(`${added} joins the fight (HP ${hp}, AC ${ac})`);
    await postDiceCard(`⚔️ **${added}** joins the fight: HP ${hp}, AC ${ac}, initiative ${world.combat.order.find(o => o.name === added)?.init ?? '?'}.`, { combat: true });
    saveDoc('world');
    return added;
}

/** Who the player's attack is on: the DM's target, a fighter named in the reason, or the only one standing. */
function playerTarget(c, pr) {
    const world = c.docs.world, meta = c.meta;
    const foes = Object.entries(world.combat?.enemies ?? {}).filter(([, e]) => !(e.hp <= 0) && !e.dead).map(([n]) => n);
    const all = [...foes, ...meta.party.map(p => p.name)];
    if (pr.target) return matchName(pr.target, all) ?? pr.target;
    const words = nameKey(`${pr.reason || ''} ${pr.skill || ''}`);
    const named = all.find(n => words.includes(nameKey(n)) || (nameKey(n).split(' ')[0].length > 3 && words.includes(nameKey(n).split(' ')[0])));
    if (named) return named;
    return foes.length === 1 ? foes[0] : '';
}

const RANGED_WORDS = /\b(?:bow|crossbow|sling|javelin|dart|darts|throw|throws|thrown|hurl|hurls|arrow|arrows|bolt|bolts|shoot|shoots|shot|fire|fires|cast|casts|spell|ray|blast|breath|spit|spits)\b/i;
const REACH_WORDS = /\b(?:reach|pike|glaive|halberd|whip|lance|long ?spear)\b/i;

/**
 * Reach: a melee attack from more than a square off (two with a reach weapon) first walks the attacker
 * up as far as a move allows (enemies six squares, the party what's left of their speed this round).
 * Returns null for a ranged attack or no board; else {d, reach, at, moved}, d = squares still between them.
 */
export function closeToTarget(c, who, target, words, status) {
    const world = c.docs.world, meta = c.meta;
    if (!world.combat?.map || !target || RANGED_WORDS.test(String(words || ''))) return null;
    const names = Object.keys(world.combat.positions || {});
    const w = matchName(who, names) ?? who, tgt = matchName(target, names) ?? target;
    const from = parseCoord(world.combat.positions?.[w], world.combat.map), to = parseCoord(world.combat.positions?.[tgt], world.combat.map);
    if (!from || !to) return null;
    const reach = REACH_WORDS.test(String(words || '')) ? 2 : 1;
    let d = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    if (d <= reach) return { d, reach, at: from, moved: false };
    const others = new Set(Object.entries(world.combat.positions || {}).filter(([n]) => n !== w && !(world.combat.enemies?.[n]?.hp <= 0)).map(([, cd]) => parseCoord(cd, world.combat.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
    const isFoe = Boolean(world.combat.enemies?.[w]);
    const budget = isFoe ? 6 : moveBudget(world, w, speedSquares(statsForName(w, meta))).left;
    const ok = clampMove(world.combat.map, from, to, budget, others);
    const moved = ok.x !== from.x || ok.y !== from.y;
    if (moved) { world.combat.positions[w] = toCoord(ok.x, ok.y); if (!isFoe) spendMove(world, w, reachable(world.combat.map, from, budget, others).get(`${ok.x},${ok.y}`) ?? 0); }
    d = Math.max(Math.abs(ok.x - to.x), Math.abs(ok.y - to.y));
    if (d <= reach) status.note(`${w} closes to ${toCoord(ok.x, ok.y)} to reach ${tgt}`);
    return { d, reach, at: ok, moved };
}

function attackTarget(c, r) {
    const meta = c.meta, world = c.docs.world;
    const party = [meta.persona.name, ...meta.party.map(p => p.name)];
    const foes = Object.keys(world.combat?.enemies ?? {});
    const all = [...party, ...foes];
    if (r.target) return matchName(r.target, all) ?? r.target;
    const words = nameKey(`${r.what} ${r.on_success} ${r.on_fail}`);
    const named = all.find(n => nameKey(n) !== nameKey(r.who) && (words.includes(nameKey(n)) || words.includes(nameKey(n).split(' ')[0])));
    if (named) return named;
    return matchName(r.who, party) ? (foes[0] ?? '') : meta.persona.name;
}

/** Someone's armour class: their sheet, or the fight's enemy list. */
function armorOf(c, name) {
    const sheet = statsForName(name, c.meta);
    if (Number.isFinite(Number(sheet?.ac))) return Number(sheet.ac);
    const foes = c.docs.world.combat?.enemies ?? {};
    const foe = foes[matchName(name, Object.keys(foes)) ?? ''];
    return Number.isFinite(Number(foe?.ac)) ? Number(foe.ac) : 12;
}

/** Damage dice for an attack the DM sent without any: from its own words, the attacker's stats, or a plain 1d6. */
/** An enemy's damage dice as the roster has them (start_combat's "damage", else the NPC card's stat block), or null: a party member's weapons are their own choice each turn. */
function rosterDice(c, who) {
    const foes = c.docs.world.combat?.enemies ?? {};
    const foe = foes[matchName(who, Object.keys(foes)) ?? ''];
    if (!foe) return null;
    if (foe.damage && normalizeNotation(foe.damage)) return normalizeNotation(foe.damage);
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(who));
    const fromStats = /\b\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(String(npc?.stats || ''))?.[0];
    return fromStats ? normalizeNotation(fromStats.replace(/\s+/g, '')) || null : null;
}

function attackDice(c, r) {
    const inWords = /\b\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(`${r.on_success} ${r.what}`)?.[0];
    if (inWords) return inWords.replace(/\s+/g, '');
    const foes = c.docs.world.combat?.enemies ?? {};
    const foe = foes[matchName(r.who, Object.keys(foes)) ?? ''];
    if (foe?.damage) return foe.damage;
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(r.who));
    const fromStats = /\b\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(String(npc?.stats || ''))?.[0];
    if (fromStats) return fromStats.replace(/\s+/g, '');
    const sheet = statsForName(r.who, c.meta);
    const weapon = /\b\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(JSON.stringify(sheet?.attacks ?? sheet?.weapons ?? ''))?.[0];
    return weapon ? weapon.replace(/\s+/g, '') : '1d6';
}

/** Rewrite a companion's sheet for a new level and keep their HP in step. */
export async function levelUp(c, member, level, status = null) {
    const step = status?.step(`Rewriting ${member.name}'s sheet for level ${level}`);
    try {
        const r = await levelCharacterSheet(member.avatar, level);
        const hpMax = Number(r.stats?.hp_max);
        const p = c.docs.world.party[member.name];
        if (p && hpMax > 0) {
            const ratio = p.hp_max ? p.hp / p.hp_max : 1;
            p.hp_max = hpMax;
            p.hp = Math.max(1, Math.round(hpMax * ratio));
            saveDoc('world');
        }
        resetStableCache();
        await postNote(`📈 ${member.name} is now level ${level}${hpMax ? ` (HP ${p?.hp ?? hpMax}/${hpMax})` : ''}.`);
        step?.done('', r.usd);
        return r;
    } catch (error) {
        step?.fail(error);
        if (!status) throw error;
    }
}

/** True if the player typed the number of a roll the plugin already read from SillyTavern's dice. */
function isRetypedAutoRoll(meta, text) {
    const last = meta.lastAutoRoll;
    if (!last || Date.now() - last.at > 3 * 60 * 1000) return false;
    const m = String(text ?? '').trim().match(/^(?:nat(?:ural)?\s*)?(\d{1,3})\b[^a-z]*$/i);
    return Boolean(m && [last.natural, last.total].includes(Number(m[1])));
}

function summarizeRuling(t) {
    const bits = [];
    if (t.player_roll) bits.push(`asks ${t.player_roll.skill}`);
    if (t.npc_rolls.length) bits.push(`${t.npc_rolls.length} roll(s)`);
    if (Object.keys(t.held || {}).length) bits.push(`${Object.keys(t.held).join(', ')} hold`);
    if (Object.keys(t.state_changes || {}).length) bits.push('books');
    if (t.scene?.changed) bits.push(`→ ${t.scene.location}`);
    if (t.start_combat) bits.push('fight starts');
    if (t.end_combat) bits.push('fight ends');
    if (t.rest) bits.push(`${t.rest} rest`);
    if (t.clock) bits.push('clock');
    if (t.fact) bits.push('fact');
    return bits.join(' · ') || 'nothing to rule';
}

function summarizeStory(t) {
    const bits = [];
    if (t.narration) bits.push('narration');
    if (t.directions.length) bits.push(`→ ${t.directions.map(d => d.speaker).join(', ')}`);
    if (t.new_npcs.length) bits.push(`+${t.new_npcs.length} NPC`);
    if (t.beats_completed.length) bits.push(`beat ${t.beats_completed.join(', ')}`);
    return bits.join(' · ') || 'silent';
}

/**
 * Who answers locally: the helper's pick (which may be nobody), else whoever the player named,
 * else a companion who is with the player. Companions who split off never answer.
 */
function localSpeakers(c, triage, playerText) {
    const candidates = speakerCandidates().filter(n => !isBeast((c.docs.npcs || []).find(x => x.name === n) ?? { name: n }));
    if (!candidates.length) return [];
    if (triage.speakers?.length) return triage.speakers.filter(n => candidates.includes(n));
    if (triage.helperChoseSpeakers) return [];
    const addressed = candidates.filter(n => new RegExp(`\\b${nameKey(n).split(' ')[0]}\\b`, 'i').test(playerText));
    if (addressed.length) return addressed.slice(0, 2);
    const party = c.meta.party.map(p => p.name).filter(n => candidates.includes(n));
    return party.length ? [party[Math.floor(random01() * party.length)]] : [];
}

/**
 * A companion's free reply (no DM this turn) may attempt something risky on its own: picking a
 * pocket, sneaking off, lying. Then the DM rules on it with a roll, like for the player.
 * Only free replies are checked; replies the DM directed were already ruled on.
 */
async function ruleOnCompanionAttempts(c, names, status, signal) {
    const s = settings();
    if (!s.useHelper) return;
    for (const name of names) {
        if (!c.meta.party.some(p => p.name === name)) continue;
        const msg = [...ST.chat].reverse().find(m => !m.is_user && m.name === name);
        if (!msg?.mes) continue;
        let attempt;
        try {
            const { system, user } = companionActionPrompt({ name, message: trimToTokens(msg.mes, 500), scene: `${c.docs.world.location || 'unknown'}; ${c.meta.standing || ''}` });
            attempt = parseCompanionAction(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 100, profileId: s.helperProfileId }));
        } catch {
            continue;
        }
        if (!attempt.attempt || signal.aborted) continue;
        status.note(`${name} attempts: ${attempt.what || 'something risky'}`);
        try {
            const result = await consultTable(c, { reasons: ['companion_action'], companionAction: { name, what: attempt.what, text: msg.mes }, fromIndex: ST.chat.length }, { status, signal });
            c.meta.stats.lastTurnUsd = (c.meta.stats.lastTurnUsd || 0) + result.usd;
        } catch (error) {
            if (error instanceof BudgetError) throw error;
            console.warn('[Dungeon Master] ruling on a companion attempt failed', error);
        }
        return; // one ruling per turn
    }
}

/** No DM this turn: the right character(s) answer locally. */
async function localReplies(c, triage, playerText, status, signal) {
    const speakers = localSpeakers(c, triage, playerText);
    localReplies.lastSpeakers = speakers;
    // Plain roleplay: no brief, the bot plays the character freely (it still gets the scene note).
    for (const sp of speakers.filter(Boolean)) {
        if (signal.aborted) throw new Error('aborted');
        const step = status.step(`${sp} is responding`);
        try {
            await makeSpeak(sp, '', { signal });
            step.done();
        } catch (error) {
            step.fail(error);
        }
    }
}

/** Ask the player for a roll: the card, and from here on their dice are read automatically. */
async function postRollRequest(c, pr) {
    const meta = c.meta;
    pr.turn = meta.turn;
    meta.pendingRoll = pr;
    const adv = pr.advantage && pr.advantage !== 'none' ? ` (with **${pr.advantage}**: roll two d20, keep the ${pr.advantage === 'advantage' ? 'higher' : 'lower'})` : '';
    const what = pr.kind === 'damage'
        ? `roll damage **${pr.damage || 'for your hit'}** and type the total`
        : `roll a **d${pr.die || 20}** for **${pr.skill}${pr.ability ? ` (${pr.ability})` : ''}**${adv} and type the number you rolled`;
    const auto = settings().autoReadDice !== false ? ' (or roll with SillyTavern\'s dice: it\'s read automatically)' : '';
    await postDiceCard(`🎲 **${meta.persona.name}**, ${what}${auto}.${pr.reason ? `\n*${pr.reason}*` : ''}`, { request: pr });
    // Dice rolled from here on are read automatically (dicewatch.js).
    pr.chatIndex = ST.chat.length;
    saveMeta();
}

async function resolvePlayerRoll(c, parsed, status) {
    const meta = c.meta;
    const pr = meta.pendingRoll;
    meta.pendingRoll = null;
    // A death saving throw: the bare d20, no modifiers.
    if (pr.death) {
        const natural = parsed.natural ?? parsed.total ?? 0;
        const res = deathSave(c.docs.world, meta.persona.name, natural);
        saveDoc('world');
        await postDiceCard(`🎲 **${meta.persona.name}** · death saving throw: **${natural}** · ${res.line}`, { roll: { who: meta.persona.name, ...pr, natural, total: natural, success: natural >= 10 } });
        refreshMap();
        return `${meta.persona.name} rolled a death saving throw: ${natural}. ${res.line} (The code tracked it; narrate it.)`;
    }
    const stats = statsForName(meta.persona.name, meta);
    const { mod, source } = pr.kind === 'damage' ? { mod: 0, source: 'damage' } : lookupModifier(stats, pr);
    let natural = parsed.natural;
    let total;
    if (pr.kind === 'damage') {
        total = parsed.total ?? parsed.natural ?? 0;
        natural = null;
    } else if (parsed.total !== null && parsed.total !== undefined) {
        total = parsed.total;
    } else {
        total = (natural ?? 0) + mod;
    }
    const judged = pr.kind === 'damage' ? { success: null } : judge(total, pr.dc, natural, pr.kind);
    // A roll that decides whether someone is seen: the code keeps who has noticed whom.
    if (pr.spot && judged.success !== null) {
        const noticed = matchName(meta.persona.name, [pr.spot.seer]) ? judged.success : !judged.success;
        noteSeen(c.docs.world, pr.spot.seer, pr.spot.seen, noticed);
        saveDoc('world');
    }
    const mark = judged.success === true ? '✔' : judged.success === false ? '✘' : '';
    const flair = natural === 20 ? ' — **natural 20!**' : natural === 1 ? ' — natural 1…' : '';
    const dcText = pr.dc !== null && pr.kind !== 'damage' ? ` vs ${pr.kind === 'attack' ? 'AC' : 'DC'} ${pr.dc}` : '';
    const card = pr.kind === 'damage'
        ? `🎲 **${meta.persona.name}** — damage: **${total}**`
        : `🎲 **${meta.persona.name}** — ${pr.skill}: d${pr.die || 20} ${diceText(pr, natural)} ${formatModifier(mod)} = **${total}** ${mark}${dcText}${flair}`;
    await postDiceCard(card, { roll: { who: meta.persona.name, ...pr, natural, total, success: judged.success } });
    if (pr.kind === 'attack') playAnim(meta.persona.name, 'attack');
    c.docs.rolls_log.push({ at: new Date().toISOString(), who: meta.persona.name, what: pr.skill, kind: pr.kind, natural, mod, total, dc: pr.dc, success: judged.success });
    saveDoc('rolls_log');
    meta.lastRoll = { kind: pr.kind, turn: meta.turn, skill: pr.skill, total, natural };
    let afterInit = '';
    if (pr.kind === 'initiative' && c.docs.world.combat) {
        addToInitiative(c.docs.world, meta.persona.name, total);
        // Round 1 opens with whoever beat the player, in order; then it's the player's turn, and nobody else acts until they end it.
        const order = c.docs.world.combat.order || [];
        const ahead = order.slice(0, Math.max(0, order.findIndex(o => o.name === meta.persona.name))).map(o => o.name);
        if (turnPromptsOn()) c.docs.world.combat.phase = ahead.length ? 'others' : 'player';
        if (ahead.length) meta.openingRound = { turn: meta.turn, names: ahead };
        afterInit += ahead.length
            ? ` ROUND 1 OPENS: ${ahead.join(', ')} beat ${meta.persona.name}'s ${total} and act now, in that order (an entry in "acts" for each); then it is ${meta.persona.name}'s turn. Nobody below ${meta.persona.name} acts yet.`
            : ` ${meta.persona.name} has the highest initiative: it is their turn first; nobody acts before them.`;
        saveDoc('world');
        // The attack that started the fight was put aside for initiative: it's asked for now, not lost.
        if (meta.afterInitiative) {
            const again = meta.afterInitiative;
            delete meta.afterInitiative;
            // Reach holds for that first attack too: walk up as far as a move allows; still out of reach, no roll.
            if (again.kind === 'attack') again.target = playerTarget(c, again);
            const close = again.kind === 'attack' ? closeToTarget(c, meta.persona.name, again.target, `${again.reason || ''} ${again.skill || ''}`, status) : null;
            if (close && close.d > close.reach) {
                await postNote(`⚠️ ${again.target} is ${close.d} squares off, out of reach even after moving as far as a turn allows: say where you move, or use a ranged weapon.`);
                afterInit += ` The attack that started the fight was NOT rolled: ${again.target} is ${close.d} squares from ${meta.persona.name} (now at ${toCoord(close.at.x, close.at.y)}), out of reach. Say in words where ${again.target} stands; ${meta.persona.name} moves or changes weapon on their turn.`;
            } else {
                await postRollRequest(c, again);
                afterInit += ` The code has asked ${meta.persona.name} for the attack roll that started the fight (${again.skill}${again.target ? ` on ${again.target}` : ''}): don't ask again; it is their first action.`;
            }
        }
    }
    status.note(`You rolled ${total}${mark ? ` ${mark}` : ''}`);
    let saveHurt = afterInit;
    // A hit: the damage roll is asked for right away (the DM used to forget).
    if (pr.kind === 'attack' && judged.success === true) {
        const dice = judged.critical ? (pr.damage ? doubleDice(pr.damage) : attackDamage(statsForName(meta.persona.name, meta), `${pr.reason || ''} ${pr.skill || ''}`, { critical: true })) : pr.damage;
        if (dice) {
            await postRollRequest(c, { kind: 'damage', skill: 'damage', ability: '', die: 100, dc: null, advantage: 'none', reason: `${pr.skill || 'Attack'} hit${judged.critical ? ' (critical: dice doubled)' : ''}`, damage: normalizeNotation(dice) || dice, half: false, bonus: null, spot: null, target: playerTarget(c, pr) });
            saveHurt += ` The code has already asked ${meta.persona.name} to roll damage (${dice}): don't ask again; the hit is a fact, the total comes next.`;
        }
    }
    // A save with damage: the code takes the HP off (all on a failure, half on a success if it says so).
    if (pr.kind === 'save' && pr.damage) {
        const hurt = saveDamage(pr.damage, judged.success === false, pr.half);
        if (hurt) {
            const line = changeHp(c.docs.world, meta.persona.name, -hurt.total, [meta.persona.name, ...meta.party.map(p => p.name)]);
            saveDoc('world');
            playAnim(meta.persona.name, 'hurt');
            await postNote(`💥 ${meta.persona.name} takes **${hurt.total}** damage${hurt.half ? ' (half)' : ''}${line ? ` (${line})` : ''}.`);
            saveHurt = ` The code already applied ${hurt.total} damage${hurt.half ? ' (half, for the success)' : ''}: ${line || 'done'}. Don't apply it again.`;
        }
    }
    if (pr.kind === 'damage') {
        const cap = diceMax(pr.damage);
        if (cap && total > cap) { await postNote(`⚠️ ${total} is more than ${pr.damage} can roll: ${cap} taken.`); total = cap; }
        // The target takes it here and now (registered in the fight if they weren't yet), so the DM never has to bookkeep it.
        const who = pr.target ? (await enemyHere(c, pr.target, status), matchName(pr.target, [...Object.keys(c.docs.world.combat?.enemies ?? {}), ...meta.party.map(p => p.name)])) : null;
        if (who) {
            const line = changeHp(c.docs.world, who, -total, [meta.persona.name, ...meta.party.map(p => p.name)]);
            saveDoc('world');
            fallenInFight(c);
            playAnim(who, 'hurt');
            await postDiceCard(`💥 **${who}** takes **${total}** damage${line ? ` (${line})` : ''}.`, { state: true });
            // The last enemy down: the fight is over here and now, not when the DM remembers end_combat.
            const over = c.docs.world.combat && allEnemiesDown(c.docs.world);
            if (over) await finishCombat(c, status);
            refreshMap();
            return `${meta.persona.name} rolled ${total} damage for: ${pr.reason || pr.skill}. The code already took it off ${who}: ${line || 'applied'}${/\(down\)/.test(line || '') ? ' (0 HP: dead)' : ''}. Don't apply it again (no changes.hp for this hit).${over ? ' Every enemy is down: the code has ended the fight (no fight.end needed); nobody rolls.' : ''}`;
        }
        return `${meta.persona.name} rolled ${total} damage for: ${pr.reason || pr.skill}. Apply it (changes.hp).`;
    }
    return saveHurt + `${meta.persona.name} rolled ${natural ?? '?'} on the d${pr.die || 20} ${formatModifier(mod)} (${source}) = ${total}${pr.dc !== null ? ` vs hidden DC ${pr.dc}: ${judged.success ? 'SUCCESS' : 'FAILURE'}` : ''}${natural === 20 ? ' (natural 20)' : natural === 1 ? ' (natural 1)' : ''}. Roll was for: ${pr.reason || pr.skill}.`;
}

/**
 * Maybe offer random events. Code decides WHEN one could happen; Claude decides whether one
 * fits the moment at all (no traders in a prison cell), picks one, invents one, or declines.
 * @returns {Promise<object[]>} up to 3 candidate events ([] = no event this turn)
 */
async function maybeDrawEvents(c, status, tight) {
    const meta = c.meta;
    const s = settings();
    const chance = eventChance({
        turnsSinceEvent: meta.pacing.turnsSinceEvent,
        inCombat: meta.pacing.inCombat,
        tension: meta.pacing.tension,
        fun: meta.pacing.fun,
        frequency: tight ? 'rare' : (meta.options.eventFrequency || 'normal'),
    }, { base: Number(s.eventBase), growth: Number(s.eventGrowth), cap: Number(s.eventCap) });
    if (chance <= 0 || random01() >= chance) return [];
    const all = await loadDeck();
    const world = c.docs.world;
    let pool = eligibleEvents(all, {
        setting: guessSetting(world.location, world.setting),
        danger: Math.max(1, Math.min(5, Math.round(meta.pacing.tension / 2) + 1)),
        flags: worldFlags(world),
        turn: meta.turn,
        history: meta.eventHistory,
    });
    const picks = [];
    for (let i = 0; i < 3 && pool.length; i++) {
        const ev = pickEvent(pool, [...meta.recentEventTypes, ...picks.map(p => p.type)]);
        if (!ev) break;
        picks.push(ev);
        pool = pool.filter(e => e.id !== ev.id);
    }
    if (picks.length) status.note(`Random event possible: asking the DM if one fits`);
    return picks;
}

function recordEvent(c, { id, title, type }, how) {
    const meta = c.meta;
    if (id) {
        const h = meta.eventHistory[id] ?? { lastTurn: 0, count: 0 };
        h.lastTurn = meta.turn;
        h.count++;
        meta.eventHistory[id] = h;
    }
    if (type) {
        meta.recentEventTypes.push(type);
        if (meta.recentEventTypes.length > 6) meta.recentEventTypes.shift();
    }
    meta.pacing.turnsSinceEvent = 0;
    meta.pendingEvent = null;
    c.docs.events_log.push({ at: new Date().toISOString(), turn: meta.turn, id: id || null, title, how });
    saveDoc('events_log');
}

/** Plain-words outcome line for a dice card. */
function outcomeText(r, judged, noticed = null) {
    // A roll about seeing someone reads from what the code recorded, not the DM's guess at the outcome (written backwards now and then).
    if (r.spot && noticed !== null) return ` → ${r.spot.seer} ${noticed ? 'notices' : "doesn't notice"} ${r.spot.seen}`;
    const text = judged.success === false ? r.on_fail : r.on_success;
    return text ? ` → ${text}` : '';
}

/** Anyone in the fight at 0 HP is dead: out of the order, dead in the roster. The DM narrates a death, never a knockout. */
/** Every enemy in the fight is at 0 HP (none means no: a fight with nobody registered yet is the DM's to end). */
function allEnemiesDown(world) {
    const foes = Object.values(world.combat?.enemies || {});
    return foes.length > 0 && foes.every(e => e.hp <= 0);
}

/**
 * The fight is over, by the DM's end_combat or because the last enemy went down: what lasts only
 * the fight ends, the downed leave the scene card (they were drawn standing on new squares after a
 * fight: a body is the DM's next card to place), the board goes, the sketch is drawn again from the
 * card, and the story breathes for a few turns.
 */
async function finishCombat(c, status) {
    const world = c.docs.world, meta = c.meta;
    if (!world.combat) return;
    const ended = expireConditions(world, { combatOver: true });
    if (ended.length) await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true });
    const down = Object.entries(world.combat.enemies || {}).filter(([, e]) => e.hp <= 0).map(([n]) => n);
    if (world.sceneCard) for (const n of down) {
        const k = matchName(n, Object.keys(world.sceneCard.people || {}));
        if (k) { delete world.sceneCard.people[k]; if (world.sceneCard.spots) delete world.sceneCard.spots[k]; }
    }
    endCombat(world);
    status.note('Combat over');
    await postDiceCard(`⚔️ **The fight is over.** ${[meta.persona.name, ...meta.party.map(p => p.name)].filter(n => world.party?.[n]).map(n => `${n} ${world.party[n].hp}/${world.party[n].hp_max}`).join(' · ')}`, { combat: true });
    // After a fight the story breathes: a few turns with no new people, no alarms, no next guard.
    meta.pacing.calmUntil = (meta.turn || 0) + 3;
    redrawSketch(c);
    saveDoc('world');
}

function fallenInFight(c) {
    const world = c.docs.world;
    if (!world.combat) return;
    let any = false;
    for (const [name, e] of Object.entries(world.combat.enemies || {})) {
        if (!(e.hp <= 0) || e.dead) continue;
        e.dead = true;
        any = true;
        dropFallen(world);
        const npc = (c.docs.npcs || []).find(x => nameKey(x.name) === nameKey(name));
        if (npc) npc.dead = true;
    }
    if (any) saveDoc('npcs');
}

/**
 * A fight the DM didn't start: someone rolled an attack. The enemies are whoever attacks the party
 * and whoever the party attacks, with their stats from the NPC list when the DM gave them.
 */
export function combatFromAttacks(c, t) {
    const partyNames = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
    const inParty = n => Boolean(matchName(String(n || ''), partyNames));
    const attacks = (t.npc_rolls || []).filter(r => r.kind === 'attack');
    if (!attacks.length && t.player_roll?.kind !== 'attack') return null;
    const foes = new Map();
    const add = n => { const name = String(n || '').trim(); if (name && !inParty(name) && !foes.has(nameKey(name))) foes.set(nameKey(name), name); };
    for (const r of attacks) inParty(r.who) ? add(r.target) : add(r.who);
    if (t.player_roll?.kind === 'attack') add(t.player_roll.target);
    const enemies = [...foes.values()].map(name => {
        const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
        const stats = String(npc?.stats || '');
        return { name: npc?.name ?? name, ac: Number(/\bAC\s*(\d+)/i.exec(stats)?.[1]) || 12, hp: Number(/\bHP\s*(\d+)/i.exec(stats)?.[1]) || 10, dex: 0, sprite: npc?.sprite || '' };
    });
    return { enemies, map: null };
}

/** Redraw the sketch of the scene from the scene card (the story is the truth; this is its picture). */
function redrawSketch(c) {
    const world = c.docs.world, meta = c.meta;
    if (!mapsOn()) { world.sketch = null; return; }
    world.sketch = buildSketch(world.sceneCard, {
        world,
        player: meta.persona.name,
        party: meta.party.map(p => p.name),
        away: meta.party.map(p => p.name).filter(n => isAway(world, n)),
        previous: world.sketch,
        npcs: (c.docs.npcs || []).map(n => n.name),
        carried: [...(world.items || []), ...Object.values(world.inventory || {}).flat()],
    });
}

/** The words that make a long clock skip a night's sleep (the player's line, the referee's aside or fact). */
const SLEEP_WORDS = /\b(?:sleep|sleeps|sleeping|slept|asleep|bed|beds|bunk|turn(?:s|ed)? in|bed down|rest(?:s|ed)? (?:till|until|for the night|the night)|for the night|through the night|till (?:morning|dawn|first light)|until (?:morning|dawn|first light)|a night's rest|the night passes)\b/i;

/** The other side of a contest, rolled by the code: {who, skill, total, detail}, or null. */
function contestRoll(c, vs) {
    const meta = c.meta, world = c.docs.world;
    if (!vs?.who) return null;
    const party = [meta.persona.name, ...meta.party.map(p => p.name)];
    const who = matchName(vs.who, [...party, ...Object.keys(world.combat?.enemies ?? {}), ...(c.docs.npcs || []).map(n => n.name)]) ?? vs.who;
    let bonus = vs.bonus;
    if (bonus === null || bonus === undefined) {
        const stats = matchName(who, party) ? statsForName(who, meta) : null;
        bonus = stats ? lookupModifier(stats, { kind: 'check', skill: vs.skill || '', ability: '' }).mod : 2;
    }
    const r = roll(`1d20${bonus >= 0 ? '+' : ''}${bonus}`);
    return r ? { who, skill: vs.skill || 'contest', total: r.total, natural: r.natural, detail: r.detail } : null;
}

/** The cards the code posted since an index (the ruling's dice and books), as plain lines for the storyteller. */
function cardsSince(fromIndex, { settledOnly = false } = {}) {
    return ST.chat.slice(fromIndex).filter(m => !m.is_user && m.mes && (dmType(m) === 'roll' || dmType(m) === 'note') && !m.extra?.dungeon_master?.request && !(settledOnly && m.extra?.dungeon_master?.contest)).map(m => String(m.mes).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Do what the ruling says: the books, the clock, the scene, the fight, everyone's dice. Posts the
 * cards (the player sees the dice before the story), prepares the player's roll request (posted after
 * the story), and returns what the storyteller is told.
 * @returns {Promise<{turn: object, problems: string[], dmOnly: string[], outcomesBySpeaker: Record<string,string>, request: object|null, newScene: boolean, forStory: {fact: string, cards: string[], request: object|null, held: Record<string,string>, moved: string, hp: string}}>}
 */
export async function applyRuling(c, t, status, signal, { reasons = [], fromIndex = ST.chat.length } = {}) {
    const meta = c.meta;
    const world = c.docs.world;
    // What the referee asked for that the code had to drop (a name nobody has): the player sees it, and the
    // referee is told next turn, instead of a claim the tracker doesn't show.
    const problems = [];
    // Things the referee is told next turn without a warning to the player (the code already did the right thing).
    const dmOnly = [...(t.dropped || [])];
    // A roll the referee asked the player to make for a companion ("Judy's DEX save"): the code rolls it for
    // the companion, in the open, like any npc roll. The player rolls only their own.
    if (t.player_roll && (t.player_roll.kind === 'save' || t.player_roll.kind === 'check')) {
        const rawSaid = `${t.player_roll.reason} ${t.player_roll.skill}`.toLowerCase();
        const forWhom = rollBelongsTo(rawSaid, meta.persona.name, meta.party.map(p => p.name));
        if (forWhom) {
            const pr0 = t.player_roll;
            const mod = lookupModifier(statsForName(forWhom, meta), pr0).mod;
            t.npc_rolls = [...(t.npc_rolls || []), { who: forWhom, what: pr0.reason || pr0.skill, notation: `1d20${mod >= 0 ? '+' : ''}${mod}`, dc: pr0.dc, kind: pr0.kind, target: '', damage: pr0.damage || '', half: Boolean(pr0.half), on_success: '', on_fail: '', spot: null, vs: pr0.vs }];
            problems.push(`a roll asked of ${meta.persona.name} was ${forWhom}'s ${pr0.skill}: the code rolled it for ${forWhom} instead (a companion's roll goes in "rolls" with their name; the player rolls only their own)`);
            t.player_roll = null;
        }
    }
    // Maps off: nothing about squares in the ruling is used (the story stays in the chat).
    if (!mapsOn()) {
        Object.assign(t, { positions: {}, dashing: [], free_move: [] });
        if (t.start_combat) t.start_combat.map = null;
    }

    // The clock and the weather are the code's: the referee moves them only on purpose (a time skip, a change in the story).
    ensureClock(world);
    if (t.clock) {
        const before = clockText(world);
        const advance = t.clock.advance ? parseDuration(t.clock.advance) ?? 0 : 0;
        const r = t.clock.set ? skipTo(world, t.clock.set, { climate: climateHere(c) }) : t.clock.advance ? passTime(world, advance, { climate: climateHere(c) }) : null;
        if (r) {
            status.note(`Clock: ${before} → ${clockText(world)}`);
            await postDiceCard(`🕰️ ${t.clock.set ? `Time passes until ${t.clock.set}` : `${t.clock.advance} pass${/^(a|an|one)\b/.test(t.clock.advance) ? 'es' : ''}`}: ${clockText(world)}.${r.weather ? ` The weather turns: ${WEATHER_WORDS[r.weather]}.` : ''}`, { state: true });
            // A night slept through is a long rest: the clock skip alone left the player at 50/60 at dawn.
            const skipped = t.clock.set ? r.skipped ?? 0 : advance;
            if (!t.rest && skipped >= 6 * 60 && SLEEP_WORDS.test(`${lastPlayerMessage()} ${t.ooc || ''} ${t.fact || ''}`)) {
                t.rest = 'long';
                dmOnly.push(`The party slept ${Math.round(skipped / 60)} hours: that is a long rest, and the code took it (HP, hit dice, slots) since you sent only the clock. Sleeping through the night is "rest": "long", with the clock.`);
                status.note('A night slept through: the long rest is the code\'s');
            }
        } else status.note(`Clock: couldn't read "${t.clock.set || t.clock.advance}"`);
    }
    if (t.weather) {
        const kind = parseWeather(t.weather);
        if (kind && kind !== world.weather) { world.weather = kind; status.note(`Weather: ${WEATHER_WORDS[kind]}`); await postDiceCard(`🌦️ The weather turns: ${WEATHER_WORDS[kind]}.`, { state: true }); }
    }
    // Scene.
    const prevLocation = world.location;
    if (t.scene) {
        if (t.scene.location) world.location = t.scene.location;
        if (t.scene.setting) world.setting = guessSetting(world.location, t.scene.setting);
    }
    // A new place: the old scene card no longer applies. A new scene: NPCs forget the last one.
    // A reworded name ("Eel Street" for "Eel Street, Marrow Ford") is the same place, not a move.
    const newPlace = Boolean(t.scene?.location && prevLocation && !samePlace(t.scene.location, prevLocation));
    const newScene = newPlace || Boolean(t.scene?.changed);
    // The card is replaced by the referee's card for the new place; with no card the old one stays (and the referee is told): never an
    // empty picture. The card that then comes for the new place replaces it whole.
    const cardOwed = Boolean(meta.sceneCardOwed);
    world.sceneCard = applySceneCard(world.sceneCard, t.scene_card, { newPlace: (newPlace || cardOwed) && Boolean(t.scene_card), partyNames: [meta.persona.name, ...meta.party.map(p => p.name)] });
    if (newPlace && !t.scene_card) { meta.sceneCardOwed = true; dmOnly.push(`the party moved to "${t.scene.location}" and you sent no card for it: send the full "scene" for the new place (place, people with spots, objects) so the companions and the sketch know where everyone is.`); }
    else if (t.scene_card) meta.sceneCardOwed = false;
    // Who split off from the player, and who is back.
    applyPresence(world, meta.party.map(p => p.name), t.party_away, t.party_back);

    // Anyone the referee hurts, or who attacks or is attacked, is on the fight's roster (HP tracked, a turn in
    // the order) even when the fight's start never named them: a raider who swoops in halfway through.
    if (world.combat) {
        for (const who of Object.keys(t.state_changes?.hp || {})) await enemyHere(c, who, status);
        for (const r of t.npc_rolls || []) if (r.kind === 'attack') { await enemyHere(c, r.who, status); if (r.target) await enemyHere(c, r.target, status); }
    }
    for (const who of Object.keys(t.state_changes?.hp || {})) if (!matchName(who, [...Object.keys(world.party), ...Object.keys(world.combat?.enemies ?? {})])) problems.push(`changes.hp for "${who}" was dropped: nobody by that name is tracked (the party: ${Object.keys(world.party).join(', ')}${world.combat ? `; in the fight: ${Object.keys(world.combat.enemies).join(', ') || 'nobody yet'}` : '; no fight is on, so nobody else has HP: fight.start first'})`);
    // State, combat.
    if (t.state_changes?.items_add && typeof t.state_changes.items_add === 'object' && !Array.isArray(t.state_changes.items_add)) {
        for (const [who, items] of Object.entries(t.state_changes.items_add)) {
            const owner = matchName(who, Object.keys(world.inventory || {}));
            const had = (Array.isArray(items) ? items : [items]).filter(i => owner && (world.inventory[owner] || []).some(x => nameKey(x) === nameKey(i)));
            if (had.length) dmOnly.push(`items_add ${had.map(i => `"${i}"`).join(', ')} for ${owner} was dropped: ${owner} already carries it (it went on the books when it was taken). Send an item once, the turn it changes hands; two of a kind is "2 torches".`);
        }
    }
    const changeLog = applyStateChanges(world, t.state_changes, c.meta.party.map(p => p.name), { turn: meta.turn });
    fallenInFight(c);
    let initiativeCard = '';
    let mapChanged = false;
    // An attack rolled outside a fight starts one, so moves are limited even when the referee forgot fight.start.
    if (!world.combat && !t.start_combat && !t.end_combat) {
        const auto = combatFromAttacks(c, t);
        if (auto) {
            t.start_combat = auto;
            status.note(`Fight started (an attack was rolled)${auto.enemies.length ? `: ${auto.enemies.map(e => e.name).join(', ')}` : ''}`);
        }
    }
    if (t.start_combat && !world.combat) {
        const inFight = fighters(c);
        const left = meta.party.map(p => p.name).filter(n => !inFight.includes(n));
        if (left.length) status.note(`Not in the fight (away): ${left.join(', ')}`);
        const companions = inFight.map(n => ({ name: n, stats: statsForName(n, meta) }));
        const combat = startCombat(world, t.start_combat, companions);
        combat.party = inFight;
        // The round's movement: each fighter's speed in squares, what they've used, who dashed.
        combat.speed = Object.fromEntries([meta.persona.name, ...inFight].map(n => [n, speedSquares(statsForName(n, meta))]));
        combat.moved = {};
        combat.dash = {};
        if (mapsOn()) {
            if (t.start_combat.map) {
                // The referee drew the field: its squares, its starting positions.
                combat.map = normalizeMap({ ...t.start_combat.map, theme: t.start_combat.map.theme || themeFor(world.setting, world.location) });
                combat.positions = {};
            } else if (world.sketch?.map) {
                // The fight is where the party stands: the sketch becomes the battle map, everyone keeps their square.
                combat.map = JSON.parse(JSON.stringify(world.sketch.map));
                combat.positions = { ...world.sketch.positions };
                combat.onSketch = true;
                // The referee's starting squares are for a drawn field; on the sketch everyone starts where they stand.
                t.positions = {};
            } else {
                combat.map = normalizeMap({ theme: themeFor(world.setting, world.location), width: 10, height: 8, rows: [] });
                combat.positions = {};
            }
        }
        mapChanged = true;
        initiativeCard = `⚔️ **Initiative**\n${combat.order.map(o => `- ${o.name}: **${o.init}**`).join('\n')}\n*(${meta.persona.name}: roll your own initiative when asked)*`;
    }
    if (world.combat?.map) {
        const friends = fightParty(c);
        const foes = Object.keys(world.combat.enemies || {});
        // A fighter the referee never put on the board (swooped in, named for the first time) stands near the party, not nowhere.
        const lead = parseCoord(world.combat.positions?.[meta.persona.name], world.combat.map);
        const nowhere = foes.filter(n => !world.combat.positions?.[n] && !(t.positions || {})[n] && !(world.combat.enemies[n].hp <= 0));
        if (nowhere.length && lead) { world.combat.positions = placeNear(world.combat.map, world.combat.positions, nowhere, lead, 3); status.note(`${nowhere.join(', ')} had no square: placed near the party`); mapChanged = true; }
        // The party moves at most their speed each round (twice that when dashing), around walls.
        const moves = { ...(t.positions || {}) };
        for (const name of friends) {
            const from = parseCoord(world.combat.positions?.[name], world.combat.map), to = parseCoord(moves[name], world.combat.map);
            if (!from || !to) continue;
            if (t.start_combat) continue;
            // Not walking (a teleport, a shove, carried): wherever they land, no movement spent.
            if (t.free_move.some(n => nameKey(n) === nameKey(name))) { status.note(`${name} moves without walking (free move)`); continue; }
            const others = new Set(Object.entries(world.combat.positions || {}).filter(([n]) => n !== name && !(world.combat.enemies?.[n]?.hp <= 0)).map(([, cd]) => parseCoord(cd, world.combat.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
            if (t.dashing.some(n => nameKey(n) === nameKey(name))) markDash(world, name);
            const budget = moveBudget(world, name, speedSquares(statsForName(name, meta)));
            const ok = clampMove(world.combat.map, from, to, budget.left, others);
            const cost = reachable(world.combat.map, from, budget.left, others).get(`${ok.x},${ok.y}`) ?? Math.max(Math.abs(ok.x - from.x), Math.abs(ok.y - from.y));
            spendMove(world, name, cost);
            if (ok.x !== to.x || ok.y !== to.y) status.note(`${name} can only get to ${toCoord(ok.x, ok.y)} this round (${budget.left} of ${budget.max} squares were left)`);
            moves[name] = toCoord(ok.x, ok.y);
        }
        // Enemies walk too: their speed a round (twice when dashing), never across the map in one go; the dead stay put.
        for (const name of foes) {
            if (!moves[name]) continue;
            if (world.combat.enemies[name]?.hp <= 0) { delete moves[name]; problems.push(`a move for ${name} was ignored: they're dead`); continue; }
            const from = parseCoord(world.combat.positions?.[name], world.combat.map), to = parseCoord(moves[name], world.combat.map);
            if (!from || !to) continue;
            if (t.start_combat) continue;
            if (t.free_move.some(n => nameKey(n) === nameKey(name))) continue;
            const others = new Set(Object.entries(world.combat.positions || {}).filter(([n]) => n !== name && !(world.combat.enemies?.[n]?.hp <= 0)).map(([, cd]) => parseCoord(cd, world.combat.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
            const ok = clampMove(world.combat.map, from, to, t.dashing.some(n => nameKey(n) === nameKey(name)) ? 12 : 6, others);
            if (ok.x !== to.x || ok.y !== to.y) status.note(`${name} can only get to ${toCoord(ok.x, ok.y)} this round`);
            moves[name] = toCoord(ok.x, ok.y);
        }
        const { positions, rejected } = applyPositions(world.combat.map, world.combat.positions, moves);
        world.combat.positions = placeMissing(world.combat.map, placeMissing(world.combat.map, positions, friends, 'party'), foes, 'enemy');
        fallenInFight(c);
        if (rejected.length) console.warn('[Dungeon Master] Ignored invalid map moves:', rejected);
        mapChanged = true;
    }
    // Each round of the fight is a new round (a roll's result finishes the round it was asked in).
    const roundOver = turnPromptsOn() ? reasons.includes('end_turn') : (reasons.includes('combat_round') && !reasons.includes('roll_result'));
    if (world.combat && !t.start_combat && roundOver) {
        newRound(world);
        if (turnPromptsOn() && world.combat.order.some(o => o.name === meta.persona.name)) world.combat.phase = 'player';
        const joined = joinLateFighters(c);
        if (joined.length) await postDiceCard(`⚔️ ${joined.join(' · ')}`, { combat: true });
        const ended = expireConditions(world, { round: world.combat.round });
        if (ended.length) await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true });
        await deathSaves(c);
    }
    // A rest: HP, hit dice, spell slots and abilities in code (the referee only says it happened).
    if (t.rest) {
        const rested = takeRest(world, t.rest, [meta.persona.name, ...meta.party.map(p => p.name).filter(n => !isAway(world, n))], n => statsForName(n, meta), roll);
        // A rest takes its time: an hour, or the night.
        const r = t.clock ? { weather: null } : passTime(world, t.rest === 'long' ? 8 * 60 : 60, { climate: climateHere(c) });
        await postDiceCard(`📜 ${t.rest === 'long' ? 'Long rest' : 'Short rest'}${rested.length ? `: ${rested.join(' · ')}` : ''} · now ${clockText(world)}${r.weather ? ` · the weather turns: ${WEATHER_WORDS[r.weather]}` : ''}`, { state: true });
    }
    // Time that passed just now (a skip, a rest) ends what has run out.
    if (t.clock || t.rest) {
        const ended = expireConditions(world, { turn: meta.turn, round: world.combat?.round ?? null });
        if (ended.length) await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true });
    }
    // Spell slots, hit dice and limited abilities spent this turn.
    if (t.state_changes?.spend && typeof t.state_changes.spend === 'object') {
        const lines = [];
        for (const [who, items] of Object.entries(t.state_changes.spend)) {
            const name = matchName(who, [meta.persona.name, ...meta.party.map(p => p.name)]);
            if (!name) continue;
            const r = spend(world, name, items, statsForName(name, meta));
            lines.push(...r.log, ...r.refused.map(x => `⚠️ ${x}`));
        }
        if (lines.length) await postDiceCard(`📜 ${lines.join(' · ')}`, { state: true });
    }
    if (t.end_combat && world.combat) {
        await finishCombat(c, status);
        mapChanged = true;
    }
    // NPCs who died leave the group chat.
    if (t.npcs_dead.length) {
        const dead = new Set(t.npcs_dead.map(n => n.toLowerCase()));
        const fallen = (c.docs.npcs || []).filter(n => dead.has(n.name.toLowerCase()));
        for (const npc of fallen) npc.dead = true;
        if (fallen.length) {
            saveDoc('npcs');
            await removeNpcsFromGroup(fallen);
        }
        // The dead leave the scene card too.
        if (world.sceneCard) for (const n of Object.keys(world.sceneCard.people || {})) if (dead.has(n.toLowerCase())) { delete world.sceneCard.people[n]; delete world.sceneCard.spots?.[n]; }
    }
    // Level a companion up or down when the player asked for it.
    for (const [name, level] of Object.entries(t.level_change || {})) {
        const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (member) await levelUp(c, member, level, status);
    }
    // The sketch follows the scene card (outside a fight; a fight has its own board).
    if (!world.combat) { redrawSketch(c); mapChanged = true; }
    saveDoc('world');

    // What the player sees, in order: the referee's answer, then the dice.
    if (t.ooc) await postOoc(t.ooc);
    // A fight is on but the player hasn't rolled initiative yet: nobody acts before that. Anyone's
    // rolls the referee sent anyway wait (it runs them in order once the player's number is in).
    if (world.combat && !world.combat.order.some(o => o.name === meta.persona.name)) {
        if (t.npc_rolls.length) { status.note(`Held back ${t.npc_rolls.length} roll(s): initiative first`); t.npc_rolls = []; }
        if (t.player_roll && t.player_roll.kind !== 'initiative') { meta.afterInitiative = t.player_roll; status.note(`${t.player_roll.skill} roll kept for after initiative`); }
        if (t.player_roll?.kind !== 'initiative') t.player_roll = { kind: 'initiative', skill: 'Initiative', ability: 'DEX', die: 20, dc: null, advantage: 'none', reason: 'The fight is on: roll initiative. Nobody acts until you have.', damage: '', half: false, bonus: null, spot: null, vs: null };
    }
    // Who has noticed whom, when the referee says so outright.
    if (t.noticed) {
        const seen = applyNoticed(world, t.noticed);
        if (seen.length) status.note(seen.join('; '));
    }
    if (initiativeCard) { sfx('drum'); await postDiceCard(initiativeCard, { combat: true }); }
    if (changeLog.length) await postDiceCard(`📜 ${changeLog.join(' · ')}`, { state: true });

    // The player's turn is the player's: an enemy's attack sent in the middle of it waits for end_turn
    // (the referee is told); and the dead roll nothing.
    if (world.combat && t.npc_rolls.length) {
        const partyNow = [meta.persona.name, ...meta.party.map(p => p.name)];
        const dead = t.npc_rolls.filter(r => world.combat.enemies?.[matchName(r.who, Object.keys(world.combat.enemies || {})) ?? '']?.hp <= 0);
        if (dead.length) { problems.push(`rolls for ${[...new Set(dead.map(r => r.who))].join(', ')} were dropped: they're dead (0 HP) and never act again`); t.npc_rolls = t.npc_rolls.filter(r => !dead.includes(r)); }
        if (turnPromptsOn() && world.combat.phase === 'player' && !reasons.includes('end_turn') && !reasons.includes('reaction') && world.combat.order.some(o => o.name === meta.persona.name)) {
            const early = t.npc_rolls.filter(r => r.kind === 'attack' && !matchName(r.who, partyNow));
            if (early.length) { problems.push(`${[...new Set(early.map(r => r.who))].join(', ')} attacked during ${meta.persona.name}'s turn: dropped. Nobody else acts until the code says the turn has ended; then those after the player act.`); t.npc_rolls = t.npc_rolls.filter(r => !early.includes(r)); }
        }
    }
    // Companion/NPC/enemy rolls: code-rolled, shown openly WITH what happened.
    const outcomesBySpeaker = {};
    const reactions = [];
    // The companions' own choices this round: a roll the referee gave them goes on the target they chose (with their weapon's dice); an attack the referee forgot is made for them.
    const choices = world.combat && meta.combatChoices?.turn === meta.turn ? meta.combatChoices.choices : null;
    if (choices) {
        for (const [n, ch] of Object.entries(choices)) {
            if (ch.action === 'use' && ch.item && /potion|elixir|philt|draught|salve|tonic/i.test(ch.item) && !(world.party[n]?.hp <= 0) && !meta.combatChoices.used?.[n]) {
                // The referee already had her drink it (HP up, or the potion taken from her pack): once is enough.
                const hpKey = matchName(n, Object.keys(t.state_changes?.hp || {})), rmKey = matchName(n, Object.keys(t.state_changes?.items_remove || {}));
                const dmDid = (hpKey && !/^\s*-/.test(String(t.state_changes.hp[hpKey]))) || (rmKey && (Array.isArray(t.state_changes.items_remove[rmKey]) ? t.state_changes.items_remove[rmKey] : [t.state_changes.items_remove[rmKey]]).some(x => /potion|elixir|philt|draught|salve|tonic/i.test(String(x))));
                if (dmDid) { (meta.combatChoices.used ??= {})[n] = true; status.note(`${n}'s ${ch.item}: the referee applied it`); continue; }
                const dice = /superior/i.test(ch.item) ? '8d4+8' : /greater/i.test(ch.item) ? '4d4+4' : '2d4+2';
                const r = roll(dice);
                if (r) {
                    const line = changeHp(world, n, r.total, [meta.persona.name, ...meta.party.map(p => p.name)]);
                    applyStateChanges(world, { items_remove: { [n]: [ch.item] } }, meta.party.map(p => p.name), { turn: meta.turn });
                    (meta.combatChoices.used ??= {})[n] = true;
                    await postDiceCard(`🧪 **${n}** drinks the ${ch.item}: **+${r.total}** HP${line ? ` (${line})` : ''}.`, { state: true });
                }
                continue;
            }
            if (ch.action !== 'attack' || !ch.target || world.combat.enemies[ch.target]?.hp <= 0 || world.party[n]?.hp <= 0) continue;
            const mine = t.npc_rolls.filter(r => r.kind === 'attack' && matchName(r.who, [n]));
            for (const r of mine) { if (r.target && !matchName(r.target, [ch.target])) status.note(`${n}'s attack goes on ${ch.target} (their choice), not ${r.target}`); r.target = ch.target; if (ch.damage) r.damage = ch.damage; }
            // The referee had her do something else this round (a check, a hold): no second action from the code.
            const actedFor = t.npc_rolls.some(r => matchName(r.who, [n])) || Object.keys(t.held || {}).some(h => matchName(h, [n]));
            if (!mine.length && !actedFor) { t.npc_rolls.push({ who: n, what: `attacks ${ch.target}${ch.weapon ? ` with ${ch.weapon}` : ''}`, notation: `1d20${ch.toHit >= 0 ? '+' : ''}${ch.toHit}`, dc: null, kind: 'attack', target: ch.target, damage: ch.damage || '', half: false, on_success: '', on_fail: '', spot: null, vs: null }); status.note(`${n}'s attack on ${ch.target} (their choice) added: the referee left it out`); }
        }
    }
    // In a fight, everyone's rolls go in initiative order, whatever order the referee wrote them in.
    if (world.combat?.order?.length && t.npc_rolls.length > 1) {
        const place = n => { const i = world.combat.order.findIndex(o => matchName(n, [o.name])); return i < 0 ? 99 : i; };
        t.npc_rolls = t.npc_rolls.map((r, i) => [r, i]).sort((a, b) => place(a[0].who) - place(b[0].who) || a[1] - b[1]).map(([r]) => r);
    }
    for (const r of t.npc_rolls) {
        if (signal.aborted) throw new Error('aborted');
        // Getting up off the ground is no roll (it costs the move): anyone with free hands just stands.
        if (r.kind !== 'attack' && /\b(?:get|gets|getting|stand|stands|standing|scramble|scrambles|rise|rises|haul|hauls|push|pushes|struggle|struggles|climb|climbs)\b[^.]{0,30}?\b(?:up|feet|upright)\b|\bfrom prone\b/i.test(String(r.what || '')) && !/\b(?:cuff|tied|bound|grappled|pinned|held|caged|trapped|pit|snare|climb out|wall|ledge|rope|slope|bank)\b/i.test(String(r.what || ''))) {
            const who = matchName(r.who, meta.party.map(p => p.name)) ?? r.who;
            const conds = conditionsOf(world, who);
            if (conds.some(x => /^prone\b/i.test(String(x))) && !/cuff|tied|bound|restrain|rope|grappled|pinned/i.test(conds.join(' '))) { applyStateChanges(world, { conditions_remove: { [who]: ['prone'] } }, meta.party.map(p => p.name), { turn: meta.turn }); saveDoc('world'); await postNote(`📜 ${who} gets up (−prone): no roll for that.`); }
            problems.push(`the roll "${r.what}" for ${r.who} was dropped: standing up is never a roll (it costs the move; the code removed "prone"). Roll only what's contested or uncertain.`);
            continue;
        }
        // A contest: the other side rolls first, in the open, and sets the DC.
        if (r.vs) {
            const other = contestRoll(c, r.vs);
            if (other) { await postDiceCard(`🎲 **${other.who}** · ${other.skill} (contest): ${other.detail} = **${other.total}**`, { roll: { who: other.who, what: other.skill, total: other.total, natural: other.natural } }); r.dc = other.total; }
        }
        const result = roll(r.notation);
        if (!result) continue;
        // Down earlier this same turn (a companion's blow came first): the dead roll nothing.
        if (world.combat && r.kind === 'attack') {
            const k = matchName(r.who, Object.keys(world.combat.enemies || {}));
            if (k && world.combat.enemies[k]?.hp <= 0) { problems.push(`${r.who}'s ${r.what || 'attack'} was dropped: they went down to 0 HP before it this turn and never act again`); continue; }
        }
        // An attack always lands on someone and always does damage: who it's at (named, or read from
        // its own words), against their AC when the referee left it out, with the roster's dice.
        if (r.kind === 'attack') {
            r.target = attackTarget(c, r);
            await enemyHere(c, r.who, status);
            await enemyHere(c, r.target, status);
            if (r.dc === null && r.target) r.dc = armorOf(c, r.target);
            const roster = rosterDice(c, r.who);
            if (roster && (!r.damage || normalizeNotation(r.damage) !== normalizeNotation(roster))) {
                if (r.damage) dmOnly.push(`${r.who}'s damage ${r.damage} was replaced by their stat block's ${roster}: an enemy's dice never change between rolls.`);
                r.damage = roster;
            } else if (!r.damage) r.damage = attackDice(c, r);
            // Reach: a melee attack from more than a square off first walks the attacker up as far as a move allows; still out of reach, it's dropped.
            const close = closeToTarget(c, r.who, r.target, `${r.what} ${r.notation}`, status);
            if (close?.moved) mapChanged = true;
            if (close && close.d > close.reach) { problems.push(`${r.who}'s ${r.what || 'attack'} on ${r.target} was dropped: ${close.d} squares apart after moving as far as a turn allows (now at ${toCoord(close.at.x, close.at.y)}), out of reach. Give them a "move" to an adjacent square first, or make it a thrown or ranged attack.`); continue; }
        }
        const judged = judge(result.total, r.dc, result.natural, r.kind);
        let damageText = '';
        let spotNoticed = null;
        if (r.kind === 'attack' && judged.success && r.damage && r.target) {
            let dmg = roll(r.damage);
            if (dmg && judged.critical) {
                const extra = roll(r.damage.replace(/[+-]\s*\d+\s*$/, ''));
                if (extra) dmg = { ...dmg, total: dmg.total + extra.total, detail: `${dmg.detail} + crit ${extra.detail}` };
            }
            // The player's say before an enemy's hit lands: halve it (Uncanny Dodge and the like), or react another way (the referee rules; the damage waits).
            if (dmg && turnPromptsOn() && nameKey(r.target) === nameKey(meta.persona.name) && !signal.aborted) {
                const re = await askReaction({ who: r.who, what: r.what, total: result.total, dc: r.dc, damage: dmg.total, detail: dmg.detail });
                if (re.kind === 'half') dmg = { ...dmg, total: Math.floor(dmg.total / 2), detail: `${dmg.detail}, halved by a reaction` };
                else if (re.kind === 'other') {
                    reactions.push(`REACTION: ${meta.persona.name} reacts to ${r.who}'s ${r.what || 'attack'} (${result.total}${r.dc !== null ? ` vs AC ${r.dc}` : ''}, ${dmg.total} damage NOT applied yet): "${re.text}". Rule on it now: if it works, apply what damage is left (or none) with changes.hp; if it doesn't, apply the full ${dmg.total}. Then carry on from where the round stopped.`);
                    damageText = ` · **${dmg.total}** damage waits: ${meta.persona.name} reacts`;
                    dmg = null;
                }
            }
            if (dmg) {
                const line = changeHp(world, r.target, -dmg.total, [...meta.party.map(p => p.name), meta.persona.name], { critical: judged.critical });
                damageText = ` · **${dmg.total}** damage${line ? ` (${line})` : ''}`;
                const hit = matchName(r.target, [meta.persona.name, ...meta.party.map(p => p.name), ...Object.keys(world.combat?.enemies ?? {})]);
                if (hit) playAnim(hit, 'hurt');
            }
        }
        // Rolls that decide whether someone is seen: the code keeps who has noticed whom.
        if (r.spot && judged.success !== null) {
            const watcherRolled = nameKey(r.who) === nameKey(r.spot.seer) || matchName(r.who, [r.spot.seer]);
            const noticed = watcherRolled ? judged.success : !judged.success;
            spotNoticed = noticed;
            noteSeen(world, r.spot.seer, r.spot.seen, noticed);
        }
        // A save with damage (a trap, a Fireball): taken by the one who rolled, all on a failure, half on a success if it says so.
        // (Dice written only in the failure text, "takes 2d4 piercing damage", count too.)
        const saveDice = r.damage || (/\d*d\d+/i.test(r.on_fail) ? r.on_fail : '');
        if (r.kind === 'save' && saveDice) {
            const hurt = saveDamage(saveDice, judged.success === false, r.half);
            if (hurt) {
                const line = changeHp(world, r.who, -hurt.total, [...meta.party.map(p => p.name), meta.persona.name]);
                damageText = ` · **${hurt.total}** damage${hurt.half ? ' (half)' : ''}${line ? ` (${line})` : ''}`;
                playAnim(r.who, 'hurt');
            }
        }
        // Getting up: a check that works puts them on their feet (the referee forgets conditions_remove).
        const roller = r.kind === 'save' || r.kind === 'check' ? matchName(r.who, [meta.persona.name, ...meta.party.map(p => p.name)]) : null;
        if (roller && judged.success === true && /\b(?:get(?:s|ting)? (?:back )?up|stand(?:s|ing)? up|(?:back )?(?:on|to) (?:his|her|their) feet|rises?|scrambles?)\b/i.test(`${r.what} ${r.on_success}`) && conditionsOf(world, roller).some(x => /^prone\b/i.test(String(x)))) { applyStateChanges(world, { conditions_remove: { [roller]: ['prone'] } }, meta.party.map(p => p.name), { turn: meta.turn }); damageText += ' · up on their feet'; }
        const mark = judged.success === true ? '✔' : judged.success === false ? '✘' : '';
        const vs = r.dc !== null ? ` vs ${r.kind === 'attack' ? 'AC' : 'DC'} ${r.dc}` : '';
        const nat = result.natural === 20 ? ' (natural 20!)' : result.natural === 1 ? ' (natural 1)' : '';
        const card = `🎲 **${r.who}** · ${r.what}: ${result.detail} = **${result.total}** ${mark}${vs}${nat}${damageText}${outcomeText(r, judged, spotNoticed)}`;
        await postDiceCard(card, { roll: { ...r, total: result.total, natural: result.natural, success: judged.success } });
        if (r.kind === 'attack') playAnim(matchName(r.who, Object.keys(world.combat?.positions || {})) ?? r.who, 'attack');
        c.docs.rolls_log.push({ at: new Date().toISOString(), who: r.who, what: r.what, notation: r.notation, total: result.total, natural: result.natural, dc: r.dc, success: judged.success });
        const outcome = r.spot && spotNoticed !== null ? `${r.spot.seer} ${spotNoticed ? 'noticed' : 'did not notice'} ${r.spot.seen}` : judged.success === false ? r.on_fail : r.on_success;
        if (outcome) {
            const key = matchName(r.who, [...meta.party.map(p => p.name), ...c.docs.npcs.map(n => n.name)]) || r.who;
            outcomesBySpeaker[key] = `${outcomesBySpeaker[key] ? outcomesBySpeaker[key] + ' ' : ''}What you just did (${r.what}) ${judged.success === false ? 'failed' : 'worked'}; it has already happened and been told, so react to it in your own way, don't describe it again, and never call it a roll: ${outcome}`;
        }
    }
    fallenInFight(c);
    // The last enemy went down to a companion's blow: the fight is over, whatever the referee sent.
    if (world.combat && allEnemiesDown(world)) {
        await finishCombat(c, status);
        dmOnly.push('Every enemy is down: the code has ended the fight (no fight.end needed).');
        mapChanged = true;
    }
    if (reactions.length) setTimeout(() => runTurn({ force: 'reaction', placeEvent: reactions.join(' ') }), 50);
    if (t.npc_rolls.length) {
        saveDoc('rolls_log');
        saveDoc('world');
    }
    if (mapChanged && (world.combat || world.sketch)) {
        if (t.start_combat) openMap();
        else refreshMap();
    }

    // The player's roll request: prepared here, posted after the story so the companions answer with it on the table.
    let request = null;
    if (t.player_roll && meta.pendingRoll && meta.pendingRoll.turn === meta.turn && !meta.pendingRoll.autoResult) { dmOnly.push(`a roll (${t.player_roll.skill || t.player_roll.kind}) was dropped: the code had already asked ${meta.persona.name} to roll ${meta.pendingRoll.skill || meta.pendingRoll.kind} this turn. Never ask for a roll the code has asked for; wait for the total.`); status.note('Roll already asked for by the code'); }
    else if (t.player_roll) {
        const pr = t.player_roll;
        let outOfReach = false;
        if (pr.kind === 'damage') pr.die = 100;
        // "Roll damage" with nothing to roll: the dice come from the sheet (doubled after a natural 20).
        if (pr.kind === 'damage' && !pr.damage) {
            const lastHit = [...c.docs.rolls_log].reverse().find(r => r.who === meta.persona.name && r.kind === 'attack');
            pr.damage = attackDamage(statsForName(meta.persona.name, meta), `${pr.reason} ${pr.skill}`, { critical: lastHit?.natural === 20 });
            if (pr.damage) status.note(`Damage dice from the sheet: ${pr.damage}`);
        }
        if (pr.kind === 'damage' && pr.damage) pr.damage = normalizeNotation(pr.damage) || pr.damage;
        if (pr.kind === 'initiative') { pr.dc = null; if (pr.advantage && pr.advantage !== 'none' && !/\badvantage\b/i.test(pr.reason || '')) { pr.advantage = 'none'; status.note('Initiative is a plain roll: the advantage was dropped (say why in the reason if there is one)'); } }
        // Getting up, slipping free, working a lock: pinned or cuffed hands make it a roll at disadvantage, and getting up from under someone is DC 15 at least.
        {
            const conds = conditionsOf(world, meta.persona.name).join(' ').toLowerCase();
            const words = `${pr.reason || ''} ${pr.skill || ''}`.toLowerCase();
            const getUp = /\b(?:get(?:s|ting)? up|to (?:his|her|their|your) feet|off the ground|stand(?:s|ing)? up|struggle(?:s)? up|push(?:es|ing)? up)\b/.test(words);
            const wriggle = /\b(?:slip|slips|slipping|wriggle|squirm|work(?:s|ing)? (?:at|the) (?:lock|cuffs)|pick(?:s|ing)? the (?:cuffs|lock)|break free|get free|struggle free)\b/.test(words);
            if (pr.kind !== 'attack' && pr.kind !== 'damage' && (getUp || wriggle) && /pinned|grappled|held down|cuff|shackl|manacle/.test(conds) && pr.advantage !== 'disadvantage') { pr.advantage = 'disadvantage'; status.note(`${/pinned|grappled|held down/.test(conds) ? 'Held down' : 'Cuffed'}: the ${pr.skill || 'roll'} is at disadvantage`); }
            if (getUp && /pinned|grappled|held down/.test(conds) && (pr.dc === null || pr.dc < 15)) { pr.dc = 15; status.note('Getting up from under someone: DC 15'); }
        }
        // A contest: the other side rolls now, in the open, and their total is the number to beat.
        if (pr.vs && pr.kind !== 'attack' && pr.kind !== 'damage' && pr.kind !== 'initiative') {
            const other = contestRoll(c, pr.vs);
            if (other) { await postDiceCard(`🎲 **${other.who}** · ${other.skill} (contest): ${other.detail} = **${other.total}**`, { roll: { who: other.who, what: other.skill, total: other.total, natural: other.natural }, contest: true }); pr.dc = other.total; status.note(`${other.who}'s side of the contest: ${other.total}`); }
        }
        if (pr.kind === 'attack') {
            pr.target = playerTarget(c, pr);
            const foe = world.combat?.enemies?.[pr.target];
            const sheetAc = pr.target && !foe ? statsForName(pr.target, meta)?.ac : null;
            const ac = foe && Number.isFinite(Number(foe.ac)) ? Number(foe.ac) : Number.isFinite(Number(sheetAc)) ? Number(sheetAc) : null;
            if (ac !== null && pr.dc !== ac) { if (pr.dc !== null) dmOnly.push(`the DC ${pr.dc} for the attack on ${pr.target} was replaced by their AC ${ac} (the roster's; it never changes between rolls)`); pr.dc = ac; }
            if (/cuff|shackl|manacle|bound|tied|restrained/i.test(conditionsOf(world, meta.persona.name).join(' ')) && pr.advantage !== 'disadvantage') { pr.advantage = 'disadvantage'; status.note('Cuffed: the attack is at disadvantage'); }
            // Reach holds for the player too: they walk up as far as their move allows; still out of reach, no roll is asked and both sides are told.
            const close = closeToTarget(c, meta.persona.name, pr.target, `${pr.reason || ''} ${pr.skill || ''}`, status);
            if (close?.moved) mapChanged = true;
            if (close && close.d > close.reach) {
                outOfReach = true;
                problems.push(`${meta.persona.name}'s attack on ${pr.target} was not rolled: ${pr.target} is ${close.d} squares off even after moving as far as a turn allows (${meta.persona.name} now at ${toCoord(close.at.x, close.at.y)}), out of reach. ${meta.persona.name}: say where you move, or use a ranged weapon.`);
            }
        }
        if (!outOfReach) request = pr;
    }
    saveMeta();
    saveDoc('world');
    const hpNow = [...[meta.persona.name, ...meta.party.map(p => p.name)].filter(n => world.party?.[n]).map(n => `${n} ${world.party[n].hp}/${world.party[n].hp_max}${world.party[n].conditions?.length ? ` [${world.party[n].conditions.join(', ')}]` : ''}`), ...Object.entries(world.combat?.enemies || {}).map(([n, e]) => `${n} ${e.hp}/${e.hp_max ?? e.hp}${e.hp <= 0 ? ' (dead)' : ''}`)].join('; ');
    const forStory = {
        fact: t.fact || '',
        cards: cardsSince(fromIndex),
        settled: cardsSince(fromIndex, { settledOnly: true }),
        request,
        held: t.held || {},
        moved: newScene ? `${world.location}${world.sceneCard?.place ? `: ${world.sceneCard.place}` : ''}` : '',
        hp: hpNow,
    };
    return { turn: t, problems, dmOnly, outcomesBySpeaker, request, newScene, forStory };
}

/**
 * Tell it: the storyteller's narration, briefs and story updates, after the ruling. With no story
 * (a roll-only turn, or the storyteller failed), the roll request still goes up and the books'
 * warnings are posted.
 * @param {object|null} s the storyteller's turn
 */
export async function applyStory(c, s, status, signal, { events = [], reasons = [], quiet = false, ruled, dropped = [] } = {}) {
    const meta = c.meta;
    const world = c.docs.world;
    const t = ruled.turn;
    const storyProblems = [];
    // The storyteller's own tics ("wrists still locked behind you", nine turns running): named, so they stop.
    const dmTics = repeatedPhrases(recentRepliesOf(DM_NAME, 6), { exclude: [meta.persona.name, ...meta.party.map(p => p.name)] });
    if (dmTics.length) storyProblems.push(`You've repeated these in your last turns: ${dmTics.map(p => `"${p}"`).join(', ')}. Say it differently or leave it out: a standing fact (cuffed hands, the dark, a danger ahead) is stated once, when it changes or matters, not every turn.`);
    if (dropped.length) storyProblems.push(`your reply carried ${dropped.map(k => `"${k}"`).join(', ')}: dropped. The referee rules on dice, the books, moves, fights and the scene; you tell what it settled. Anything the story needs ruled, say in narration or a brief what is attempted, and the referee rules it next turn.`);
    if (s) {
        // New NPCs (with voices). A shop or a candlestick is never one.
        if (s.new_npcs.length) {
            const things = s.new_npcs.filter(n => notAPersonEntry(n));
            if (things.length) { status.note(`Not people, not added: ${things.map(n => n.name).join(', ')}`); ruled.problems.push(`new_npcs dropped ${things.map(n => `"${n.name}"`).join(', ')}: a place or a thing is never an NPC (it belongs in the scene's place or objects)`); }
            const added = addNpcs(c.docs.npcs, s.new_npcs.filter(n => !things.includes(n)), world.location);
            for (const npc of added) {
                npc.voice = pickNpcVoice(npc, c.docs.npcs);
            }
            if (added.length) status.note(`New: ${added.map(n => n.name).join(', ')}`);
            saveDoc('npcs');
        }
        // Who and what arrived in the story this turn goes on the card (never the place: the referee says where the party is).
        if (s.scene_card) {
            world.sceneCard = applySceneCard(world.sceneCard, s.scene_card, { newPlace: false, partyNames: [meta.persona.name, ...meta.party.map(p => p.name)] });
            if (!world.combat) redrawSketch(c);
            saveDoc('world');
        }
        // NPCs who get briefs are "here".
        for (const d of s.directions) {
            const npc = c.docs.npcs.find(n => nameKey(n.name) === nameKey(d.speaker));
            if (npc) npc.lastSeen = world.location;
        }
        if (s.beats_completed.length) {
            meta.lastDriftStageCalled = 0;
            for (const beat of s.beats_completed) {
                const re = new RegExp(`- \\[ \\] (${beat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`);
                c.docs.plot = c.docs.plot.replace(re, '- [x] $1');
            }
            saveDoc('plot');
            status.note(`Plot beat done: ${s.beats_completed.join(', ')}`);
        }
        if (s.notes_add) {
            c.docs.notes = `${c.docs.notes ? c.docs.notes + '\n' : ''}- (turn ${meta.turn}) ${s.notes_add}`;
            saveDoc('notes');
        }
        if (s.story_add) {
            c.docs.story = `${c.docs.story ? c.docs.story + '\n\n' : ''}${s.story_add}`;
            saveDoc('story');
        }
    }
    if (events.length) {
        const use = s?.event?.use || '';
        const chosen = events.find(e => e.id === use);
        if (chosen) {
            recordEvent(c, chosen, 'used');
            status.note(`Random event: ${chosen.title}`);
        } else if (use === 'custom') {
            recordEvent(c, { title: s.event.text || 'Custom event', type: 'custom' }, 'custom');
            status.note('Random event: the storyteller made one up to fit');
        } else {
            // Nothing fit right now. Reset the clock so we don't ask again next turn.
            recordEvent(c, { title: `(declined: ${events.map(e => e.title).join(', ')})` }, 'declined');
            status.note('No random event: nothing fit the moment');
        }
    }
    // Pacing: the story's scene type, tension and pace; the ruling's fight.
    applyDmPacing(meta.pacing, { world_next: s?.world_next ?? null, scene: { type: s?.scene?.type ?? t.scene?.type ?? (t.start_combat ? 'combat' : null), changed: ruled.newScene }, tension: s?.tension ?? null, beats_completed: s?.beats_completed || [], start_combat: t.start_combat, end_combat: t.end_combat }, { worldEvery: Number(settings().checkinEvery) || 5 });
    const oocNow = reasons.includes('ooc') || /^\s*(?:\*?\(\s*ooc\s*\)\*?|\(\(|ooc\s*[:\-]|@?dm\s*[,:\-]|\/rule\b)/i.test(lastPlayerMessage());
    if (s) {
        // What just visibly changed: companions see it until the next story turn, so they don't redo it,
        // and then in their timeline with when and where it happened.
        meta.happened = s.happened || '';
        if (s.happened) meta.timeline = pushTimeline(meta.timeline, { day: world.day, time: world.time, place: world.location, text: s.happened });
        // Table rules come only from the player's own out-of-character words: the premise and the plot are the storyteller's private plan, and companions read the rules.
        if (s.table_rules_add.length) {
            if (!oocNow) { ruled.problems.push(`table_rules_add dropped (${s.table_rules_add.length}): table rules are only what the player settled out of character, in their own OOC words. Your plot, the premise's secrets and what is going to happen stay in your own plan; companions and NPCs read the rules, so a rule would give the story away.`); s.table_rules_add = []; }
        }
        if (s.table_rules_add.length || s.table_rules_remove.length) {
            meta.tableRules = applyTableRules(meta.tableRules, s.table_rules_add, s.table_rules_remove);
            status.note('Table rules updated');
        }
        if (s.standing_direction) meta.standing = s.standing_direction;
        if (s.objective) meta.objective = s.objective;
        // What each companion knows (rare, full-text updates).
        for (const [name, text] of Object.entries(s.knowledge_update || {})) {
            const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
            if (member) {
                meta.knowledge ??= {};
                meta.knowledge[member.name] = text;
            }
        }
        // Their inner state: only the fields the storyteller sent change.
        for (const [name, update] of Object.entries(s.mind_update || {})) {
            const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
            if (!member) continue;
            meta.minds ??= {};
            meta.minds[member.name] = mergeMind(meta.minds[member.name], update);
            status.note(`${member.name}'s mind: ${Object.keys(update).join(', ')}`);
        }
    }
    refreshStandingPrompt();
    saveDoc('world');

    // What the player sees, in order: the story, then the roll it asks for, then the companions.
    if (s?.ooc) await postOoc(s.ooc);
    if (s?.narration) {
        const id = await postNarration(s.narration);
        if (ruled.newScene && id !== null) await markSceneStart(id);
        voiceLine({ kind: 'dm', text: s.narration });
    } else if (ruled.newScene) {
        await markSceneStart(ST.chat.findLastIndex(m => !m.is_system));
    }
    // The player's roll request goes up before the companions speak: they answer with it on the table, and nobody settles a roll that isn't there yet.
    if (ruled.request) await postRollRequest(c, ruled.request);
    for (const d of s?.directions || []) {
        if (signal.aborted) throw new Error('aborted');
        const speaker = d.speaker;
        // A trap, a chest or a ledger can't be briefed to speak, whatever the storyteller called it.
        if (notAPerson(speaker) && !c.meta.party.some(p => p.name === speaker)) { status.note(`${speaker} is a thing, not someone: no line`); continue; }
        const deadNpc = (c.docs.npcs || []).find(n => n.dead && nameKey(n.name) === nameKey(speaker));
        if (deadNpc) {
            status.note(`${deadNpc.name} is dead`);
            continue;
        }
        if (isAway(world, speaker)) {
            status.note(`${speaker} isn't with you right now`);
            continue;
        }
        const extra = ruled.outcomesBySpeaker[matchName(speaker, Object.keys(ruled.outcomesBySpeaker)) ?? ''] ?? '';
        // A roll the player is about to make: the speaker doesn't settle it or act on them first.
        // In her words, not the table's: she doesn't know what a roll is.
        const pr = ruled.request;
        const pendingLine = pr && c.meta.party.some(p => p.name === speaker) ? `(${meta.persona.name} is in the middle of ${pr.kind === 'initiative' ? 'the first moment of a fight that is just breaking out; nobody has struck yet' : pr.kind === 'attack' ? 'a swing at someone, not yet landed' : 'trying something, not yet done'}. Don't settle how it goes, and don't act on ${meta.persona.name} until it has; ${speaker} speaks of what she sees, never of dice, rolls or turns.)` : '';
        // In a fight, or while just exploring (nobody talking to them): one short line.
        const length = meta.pacing.inCombat || quiet ? 'short' : d.length;
        const step = status.step(`${speaker} is responding`);
        try {
            await makeSpeak(speaker, [d.direction, extra, pendingLine].filter(Boolean).join(' '), { signal, length });
            step.done();
        } catch (error) {
            step.fail(error);
        }
    }

    saveMeta();
    // The panel shows the clock, HP and hints as they are now.
    refreshMap();
    // Animals the library can't draw (a parrot, a monkey) get a figure from Claude, in the background.
    ensureAnimalFigures(c, c.docs.npcs || []).catch(() => { });
    // Loud failure: what was dropped is shown to the player now and to the table next turn.
    meta.turnProblems = [...ruled.problems, ...ruled.dmOnly];
    meta.storyProblems = storyProblems;
    if (ruled.problems.length) {
        status.note(`Dropped: ${ruled.problems.join(' · ')}`);
        await postNote(`⚠️ The table asked for something the code couldn't do: ${ruled.problems.join(' · ')}`);
    }
    saveMeta();
}

/** Apply a whole turn (both halves in one object: the wizard's opening). */
export async function applyDmTurn(c, t, status, signal, { events = [], reasons = [], quiet = false } = {}) {
    const ruled = await applyRuling(c, t, status, signal, { reasons });
    await applyStory(c, t, status, signal, { events, reasons, quiet, ruled, dropped: [] });
}

/** Opening scene after the wizard built the campaign. */
export async function runOpening(openingIn) {
    let opening = openingIn;
    const c = campaign();
    if (!c) return;
    // A message sent during the opening waits for it, like during any turn.
    setRunning(true);
    const status = beginTurn('Opening scene');
    try {
        if (!String(opening?.narration || '').trim()) {
            // The design came without an opening: the DM writes one now; failing that, the chat still says how to begin.
            status.note('No opening narration in the design: asking the storyteller for one');
            try {
                const r = await askStoryteller({ reasons: ['opening'], placeEvent: 'The campaign starts now. Write the opening scene: where the party is, what they see, and what is happening, so the player can act.' }, { model: modelFor(['opening']) });
                if (r.turn?.narration) opening = { ...(opening || {}), narration: r.turn.narration, happened: r.turn.happened, new_npcs: [...(opening?.new_npcs || []), ...(r.turn.new_npcs || [])], standing_direction: r.turn.standing_direction || opening?.standing_direction, directions: r.turn.directions?.length ? r.turn.directions : opening?.directions || [], scene_card: opening?.scene_card ? applySceneCard(opening.scene_card, r.turn.scene_card, { partyNames: [c.meta.persona.name, ...c.meta.party.map(p => p.name)] }) : opening?.scene_card };
            } catch (error) { console.warn('[Dungeon Master] opening narration failed', error); }
            if (!String(opening?.narration || '').trim()) opening = { ...(opening || {}), narration: 'The adventure begins. Say what you do, or ask the DM to set the scene.' };
        }
        await applyDmTurn(c, opening, status, new AbortController().signal, { reasons: ['opening'] });
        // What the party starts with (the premise's coin and gear, set by the wizard): on a card, not only in the panel.
        {
            const w = c.docs.world;
            const lines = [];
            if (Number(w.gold) > 0) lines.push(`Gold ${w.gold}`);
            for (const [who, items] of Object.entries(w.inventory || {})) if (Array.isArray(items) && items.length) lines.push(`${who}: ${items.join(', ')}`);
            if (lines.length) await postDiceCard(`📜 Starting out: ${lines.join(' · ')}`, { state: true });
        }
        if (c.docs.world.sketch) openMap();
        status.finish('The adventure begins');
    } catch (error) {
        console.error(error);
        status.finish('Opening had a problem');
        toastr.error(String(error?.message || error), 'Dungeon Master');
    } finally {
        setRunning(false);
        runQueuedTurn();
    }
}

/** Ask the DM directly (from /dm or the DM Screen). */
export async function askDmNow(text = '') {
    const c = campaign();
    if (!c) {
        toastr.info('No Dungeon Master campaign in this chat.', 'Dungeon Master');
        return;
    }
    // Show the player's question in the chat too, not only the DM's answer.
    if (text) await postPlayerOoc(c.meta.persona.name, text);
    await runTurn({ force: text ? 'ooc' : 'manual', oocText: text });
}

/** Stop everything the extension is doing. */
export function stopAll() {
    stopVoices();
}

export function resetCaches() {
    resetStableCache();
}

/** Keep party HP entries in sync with sheets. */
export function syncPartyHp() {
    const c = campaign();
    if (!c) return;
    const members = [
        { name: c.meta.persona.name, hp_max: statsForName(c.meta.persona.name, c.meta)?.hp_max },
        ...c.meta.party.map(p => ({ name: p.name, hp_max: statsForName(p.name, c.meta)?.hp_max })),
    ];
    ensureParty(c.docs.world, members);
    saveDoc('world');
}

/** The sketch for a campaign that was loaded without one (an older save, maps turned on later). */
export function ensureSketch() {
    const c = campaign();
    if (!c || c.docs.world.sketch || c.docs.world.combat) return;
    redrawSketch(c);
    if (c.docs.world.sketch) saveDoc('world');
}

export { dmType };

/**
 * Each companion in the fight decides their own turn (the local model), from what the code knows:
 * the foes and how far and hurt they are, their own weapons and items, who needs help. The DM runs
 * the round with those choices in front of it, and the code puts their rolls on the targets they chose.
 */
async function decideCompanionTurns(c, status, only = null) {
    const s = settings();
    const world = c.docs.world, meta = c.meta, cb = world.combat;
    if (!cb || !s.useHelper) return null;
    const names = meta.party.map(p => p.name).filter(n => !isAway(world, n) && cb.order.some(o => o.name === n) && !(world.party[n]?.hp <= 0) && (!only || only.includes(n)));
    if (!names.length) return null;
    const posOf = n => { const sq = cb.positions?.[n]; return sq && cb.map ? parseCoord(sq, cb.map) : null; };
    const out = {};
    for (const n of names) {
        const me = posOf(n);
        const far = o => (me && o ? Math.max(Math.abs(me.x - o.x), Math.abs(me.y - o.y)) : 2);
        const foes = Object.entries(cb.enemies || {}).filter(([, e]) => !(e.hp <= 0) && !e.dead).map(([fn, e]) => ({ name: fn, hp: e.hp, hpMax: e.hp_max ?? e.hp, ac: e.ac, dist: far(posOf(fn)) }));
        const allies = [meta.persona.name, ...names.filter(x => x !== n)].map(a => ({ name: a, hp: world.party[a]?.hp ?? 0, hpMax: world.party[a]?.hp_max ?? 0, dist: far(posOf(a)), down: world.party[a]?.hp <= 0 }));
        const stats = statsForName(n, meta);
        const weapons = (stats?.attacks || []).filter(a => a?.name).map(a => ({ name: String(a.name), damage: String(a.damage || '1d4'), range: a.range || (/bow|sling|crossbow|dart|javelin|thrown|throw|spear/i.test(String(a.name)) ? 'ranged' : '') }));
        const items = (world.inventory?.[n] || []).map(String);
        const step = status.step(`${n} decides`);
        const { system, user } = companionCombatPrompt({ name: n, hp: world.party[n]?.hp ?? 0, hpMax: world.party[n]?.hp_max ?? 0, conditions: conditionsOf(world, n), foes, allies, weapons, items, player: meta.persona.name });
        const raw = await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 120, profileId: s.helperProfileId });
        const pick = parseCompanionCombat(raw, { foes, allies, weapons, items });
        const w = weapons.find(x => x.name === pick.weapon);
        out[n] = { ...pick, damage: w?.damage || '', toHit: stats ? lookupModifier(stats, { kind: 'attack', skill: pick.weapon || '', ability: '' }).mod : 0 };
        step.done(`${pick.action}${pick.target ? ` ${pick.target}` : ''}${pick.weapon ? ` with ${pick.weapon}` : ''}${pick.why ? ` (${pick.why})` : ''}`);
    }
    meta.combatChoices = { turn: meta.turn, choices: out };
    saveMeta();
    return out;
}
