// The turn loop: what happens after the player sends a message.
// 1) triage (code, then the local helper)  2) dice  3) maybe a random event
// 4) DM (Claude) only if needed  5) actors reply  6) bookkeeping.

import { ST } from './st.js';
import { settings, currentSpend, modelFor, mapsOn } from './settings.js';
import { campaign, saveMeta, saveDoc } from './campaign.js';
import { callLocal, callClaude, BudgetError } from './llm.js';
import { askDm, maybeCondenseNotes, resetStableCache } from './dm.js';
import { modelLabel } from '../core/models.js';
import { rotateIdleNpcs, removeNpcsFromGroup, touchNpc } from './npccards.js';
import { withDmThinking } from '../ui/thinking.js';
import { makeSpeak, refreshStandingPrompt, speakerCandidates, markSceneStart } from './actors.js';
import { postNarration, postOoc, postPlayerOoc, postDiceCard, postNote, dmType } from './messages.js';
import { statsForName, levelCharacterSheet } from './sheets.js';
import { pickNpcVoice, voiceLine, stopVoices } from './voices.js';
import { normalizeMap, applyPositions, placeMissing, placeNear, parseCoord, toCoord, clampMove, speedSquares } from '../core/grid.js';
import { applyPlaceChanges, floorById, roomAt, computeVisible, placePerson, personByName, adoptStrays, openSquareNear, tellTraps, killPerson, markNoticed, inTheFight, matchPerson, EARSHOT } from '../core/explore.js';
import { applyMapEffects, fireTurn } from './fire-turn.js';
import { mergeBurn } from '../core/fire.js';
import { requestBuild, enterPlace, leavePlace, currentPlace, savePlace, atlasEntry, tickPlace, watchTurn, partyOnMap, look, takeMapAction, goTargets, companionGoTo, searchForTraps, takeTrapEvents, setStance, lockedReason, trappedIn, freeFromTrap, placeHeld, targetFor, rememberTarget, approachSpot, huntersTurn, resetWalked, applyMapSync, syncContext, syncNight } from './atlas.js';
import { openMap, refreshMap, closeMap, playAnim, chooseOnMap } from '../ui/map.js';
import { targetLine } from '../core/targets.js';
import { mapSyncPrompt, parseMapSync } from '../core/mapsync.js';
import { beginTurn } from '../ui/status.js';
import { ruleTriage, helperTriagePrompt, parseHelperTriage, companionActionPrompt, parseCompanionAction } from '../core/triage.js';
import { tickPlayerTurn, dmReasons, applyDmPacing, updateFun, isFillerMessage } from '../core/pacing.js';
import { eventChance, eligibleEvents, pickEvent, guessSetting, normalizeEvent } from '../core/deck.js';
import { roll, judge, formatModifier, random01, saveDamage } from '../core/dice.js';
import { applyStateChanges, addNpcs, startCombat, addToInitiative, endCombat, lookupModifier, changeHp, worldFlags, ensureParty, applyPresence, isAway, conditionsOf, noteSeen, applyNoticed, isHere, attackDamage } from '../core/world.js';
import { bookkeeperPrompt, parseBookkeeping } from '../core/bookkeeper.js';
import { budgetStatus, formatUsd } from '../core/budget.js';
import { matchName, nameKey, trimToTokens, extractJson } from '../core/text.js';
import { applySceneCard, pushTimeline, applyTableRules } from '../core/state.js';
import { snapshotTurn, sealTurn } from './undo.js';
import { expireConditions, takeRest, spend, dying, deathSave } from '../core/upkeep.js';
import { mergeMind } from '../core/minds.js';
import { standingOf, setStanding, standingFor } from '../core/access.js';

let running = false;
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

/**
 * A player message sent while a side flow held the turn (a companion looking around, companions
 * reacting to you coming and going, the opening) asked for a rerun: run it now that we're free.
 */
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
 *  placeEvent = what just happened while exploring a map (a sprung trap, a guard coming into view)
 * A roll read from SillyTavern's dice waits in meta.pendingRoll.autoResult (see dicewatch.js).
 */
export async function runTurn(opts = {}) {
    const c = campaign();
    if (!c || c.meta.paused) return;
    if (running) {
        rerunRequested = true;
        return;
    }
    running = true;
    const controller = new AbortController();
    const onStop = () => controller.abort();
    ST.eventSource.on(ST.eventTypes.GENERATION_STOPPED, onStop);
    const status = beginTurn('Dungeon Master');
    const turnStart = ST.chat.length;
    // The state before this turn, so deleting its narration can undo it (undo.js).
    const snap = snapshotTurn(c);
    try {
        if (opts.moved) await movedTurn(c, status, controller.signal);
        else await turnBody(c, opts, status, controller.signal);
        // The books and the map: in the background, so the next move never waits on them.
        if (!controller.signal.aborted) { queueBookkeeping(c, turnStart); queueMapSync(c, turnStart); }
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
        running = false;
        // A companion set off a trap while walking somewhere after the DM had already ruled: rule on it now.
        const sprung = takeTrapEvents();
        if (sprung.length) setTimeout(() => runTurn({ force: 'explore', placeEvent: sprung.join(' ') }), 50);
        else if (rerunRequested) {
            rerunRequested = false;
            setTimeout(() => runTurn(), 50);
        }
    }
}

async function turnBody(c, opts, status, signal) {
    const s = settings();
    const meta = c.meta;
    const pacing = meta.pacing;
    const autoRoll = meta.pendingRoll?.autoResult ?? null;
    const playerText = opts.force === 'manual' || autoRoll ? '' : lastPlayerMessage();
    meta.stats.lastTurnUsd = 0;
    // Last turn's map sync finishes first, so this turn starts from a map that matches the story.
    await mapSyncing;
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
        const rule = ruleTriage(playerText, { pendingRoll: meta.pendingRoll, inCombat: pacing.inCombat });
        triage = { ...triage, ...rule };
        let engaged = null;
        if (rule.needsHelper && s.useHelper) {
            const step = status.step('Reading your move (local helper)');
            try {
                const candidates = speakerCandidates();
                // Companions here, and what's around them on the map, so the helper can spot a task ("Judy, search that crate").
                const helpers = meta.party.map(p => p.name).filter(n => candidates.includes(n));
                const onMap = currentPlace(c);
                const places = c.docs.world.combat || !helpers.length || !onMap ? [] : goTargets(c, helpers[0]).filter(p => onMap.place.rooms[p.id]);
                const { system, user } = helperTriagePrompt({
                    mapOn: Boolean(onMap) && mapsOn() && !c.docs.world.combat,
                    companions: helpers,
                    places,
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
                if (who) triage.task = { ...h.task, who, go: places.some(p => p.id === h.task.go) ? h.task.go : '' };
                triage.thing = h.thing;
                // Warned about a trap: they learn every trap the player knows about, and walk around them.
                const warned = h.warned && matchName(h.warned, helpers);
                const here = warned && currentPlace(c);
                if (here) {
                    const learned = tellTraps(here.place, warned);
                    if (learned.length) { savePlace(here.key, c); status.note(`${warned} knows about the ${learned.map(t => t.kind).join(', ')} now`); }
                }
                if (!rule.category) triage.category = h.category;
                triage.stalled = h.stalled;
                triage.speakers = h.speakers;
                triage.helperChoseSpeakers = true;
                pacing.refusalStreak = h.refusing ? (pacing.refusalStreak ?? 0) + 1 : 0;
                engaged = h.engaged;
                // Who is the player talking to? A known NPC answers locally; a stranger needs the DM.
                if (h.addressed && !/^(dm|dungeon master|narrator|everyone|nobody|none)$/i.test(h.addressed)) {
                    const npcNames = (c.docs.npcs || []).map(n => n.name);
                    const known = matchName(h.addressed, [...meta.party.map(p => p.name), ...npcNames, meta.persona.name]);
                    if (!known) triage.unknownAddressee = h.addressed;
                    else if (npcNames.includes(known)) {
                        triage.speakers = [known, ...triage.speakers.filter(s => s !== known)].slice(0, 2);
                        touchNpc(c.docs.npcs.find(n => n.name === known));
                    }
                }
                step.done(`${triage.category}${triage.task ? ` · ${triage.task.who}: ${triage.task.what || 'a task'}${triage.task.dm ? ' (DM decides)' : ''}` : ''}${triage.unknownAddressee ? ` · talking to ${triage.unknownAddressee} (new)` : ''}${triage.speakers.length ? ` → ${triage.speakers.join(', ')}` : ''}`);
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
    // A new player turn: walking starts counting again, hunters may strike again.
    if (!opts.force && !autoRoll) resetWalked();
    if (!opts.force && !autoRoll) await upkeepTurn(c, status);
    // ---------- What they act on, exactly ----------
    // "Smash the bookshelf", "Judy, open the kennel": which one, on the map. One clear match is it;
    // several in reach and the player picks on the map. Then whoever does it walks up to it first,
    // and the DM is told exactly which one.
    let target = null;
    if (triage.thing && !autoRoll && mapsOn() && currentPlace(c) && !c.docs.world.combat && !signal.aborted) {
        const actor = triage.task?.who || meta.persona.name;
        const found = targetFor(c, actor, triage.thing);
        let pick = found.pick ?? null;
        if (found.choices) {
            const step = status.step(`Which ${found.choices[0].name}? Pick it on the map`);
            pick = await chooseOnMap({ title: `Which ${found.choices[0].name}${actor === meta.persona.name ? '' : ` for ${actor}`}?`, choices: found.choices, signal });
            step.done(pick ? `${pick.name}, ${pick.where}` : 'none picked');
        }
        if (signal.aborted) throw new Error('aborted');
        if (pick) {
            rememberTarget(c, actor, pick.id);
            target = { actor, id: pick.id, kind: pick.kind, name: pick.name, where: pick.where, line: targetLine(pick), reached: false };
            if (triage.task && triage.task.who === actor) triage.task.go = pick.id;
            else target.reached = await approachSpot(pick, () => refreshMap(), { inTurn: true });
            status.note(`${actor} → the ${pick.name} (${pick.where})`);
        }
    }
    let placeEvent = [opts.placeEvent, ...takeTrapEvents()].filter(Boolean).join(' ');
    // The player picked something on the map (smash the bookshelf, pry the bars): the DM rules on it.
    const picked = !autoRoll ? takeMapAction() : '';
    if (picked) placeEvent = [picked, placeEvent].filter(Boolean).join(' ');
    // Fire and effects move on one step each player turn (they never spread while you just walk).
    if (!opts.force && !autoRoll) {
        const burned = await fireTurn(c, status);
        if (burned) placeEvent = [placeEvent, burned].filter(Boolean).join(' ');
    }
    if (!opts.force && !autoRoll && !pacing.inCombat) {
        const spotted = tickPlace(c);
        if (spotted.length) placeEvent = [placeEvent, `${spotted.map(g => `${g.name} (${g.description || 'a guard'}${g.down ? `, ${g.down === 'bound' ? 'tied up' : g.down}` : ''})`).join(' and ')} ${spotted.length > 1 ? 'come' : 'comes'} into view nearby. Decide whether they notice the party (roll for it) and what they do.`].filter(Boolean).join(' ');
        const watched = watchTurn(c);
        if (watched) placeEvent = [placeEvent, watched].filter(Boolean).join(' ');
        // Anyone set on the party (a guard dog let loose) closes in a turn's worth.
        const hunt = huntersTurn(c);
        if (hunt) placeEvent = [placeEvent, hunt].filter(Boolean).join(' ');
    }

    // A companion was told to do something: they walk there now, in the background, while the DM
    // (if the result needs deciding) works out what they find. Their reply waits for both.
    let taskWalk = null, taskWent = '';
    if (triage.task?.go && !signal.aborted) {
        const { who, go } = triage.task;
        // Told to hide there, or sit or lie down on it: they do when they get there.
        const what = String(triage.task.what || '').toLowerCase();
        const how = { hide: /\bhide|duck|crouch behind|get (in|under|behind)\b/.test(what), pose: /\bsleep\b/.test(what) ? 'sleep' : /\b(lie|lay) down\b/.test(what) ? 'lie' : /\bsit\b/.test(what) ? 'sit' : '' };
        taskWalk = companionGoTo(c, who, go, how).then(went => { taskWent = went; if (went) status.note(`${who} goes to the ${went}`); }).catch(() => { });
    }

    // ---------- 2. Player roll resolution ----------
    let rollResolution = '';
    let criticalRoll = false;
    if (triage.rollResult && meta.pendingRoll) {
        rollResolution = await resolvePlayerRoll(c, triage.roll, status);
        const last = c.docs.rolls_log.at(-1);
        criticalRoll = Boolean(last && last.kind !== 'damage' && (last.natural === 1 || last.natural === 20));
    }

    // ---------- 3. Random event (Claude decides whether one fits) ----------
    const b = budget();
    let events = [];
    if (!pacing.inCombat && b.level !== 'blocked' && opts.force !== 'opening') {
        events = await maybeDrawEvents(c, status, b.level === 'tight');
    }

    // The companion's walk finishes before the DM rules: if they set off a trap on the way, that comes first.
    if (taskWalk) {
        await taskWalk;
        const sprung = takeTrapEvents();
        if (sprung.length) { placeEvent = [placeEvent, ...sprung].filter(Boolean).join(' '); if (triage.task) triage.task.dm = false; }
    }

    // ---------- 4. Does the DM step in? ----------
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
    if (placeEvent && !reasons.includes('explore')) reasons.push('explore');
    if (triage.task?.dm && !reasons.includes('companion_task')) reasons.push('companion_task');
    // The player went up to something to act on it: the DM says what happens.
    if (target && target.actor === meta.persona.name && !reasons.length && triage.category !== 'banter') reasons.push('explore');
    // Nobody would answer this locally (alone, or nobody nearby would reply): the world responds.
    if (!reasons.length && !opts.force && !triage.rollResult && !localSpeakers(c, triage, playerText).length) reasons = ['solo'];
    if (b.level === 'blocked' && reasons.length) {
        status.note('Budget reached: the DM is resting (local-only)');
        reasons = [];
    }

    if (reasons.length) {
        const model = modelFor(reasons, { criticalRoll });
        const step = status.step(`DM is thinking (${modelLabel(model)}) · ${reasons.join(', ')}`);
        let result;
        try {
            result = await withDmThinking('The Dungeon Master is thinking', () => askDm({
                reasons,
                playerMessage: playerText,
                rollResolution,
                events,
                oocText: opts.oocText || triage.oocText || '',
                placeEvent,
                companionTask: triage.task?.dm ? { name: triage.task.who, what: triage.task.what, went: target?.actor === triage.task.who ? target.line : triage.task.go ? goTargets(c, triage.task.who).find(p => p.id === triage.task.go)?.name ?? '' : '' } : null,
                target,
            }, { signal, model }));
            step.done(`${summarizeTurn(result.turn)} · ${modelLabel(result.model)}${result.escalated ? ' (handed up)' : ''}`, result.usd);
            turnUsd += result.usd;
        } catch (error) {
            step.fail(error);
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
        await taskWalk;
        // Quiet exploring: the player is moving, searching or working a lock, not talking to anyone.
        const quiet = !triage.ooc && !triage.speakers?.length && (['action', 'risky_action', 'scene_move'].includes(triage.category) || (opts.force === 'explore' && !/first meeting/.test(opts.placeEvent || '')));
        await applyDmTurn(c, result.turn, status, signal, { events, reasons, quiet });
        // A beat landed: the pressure ladder starts over from the bottom.
        if (result.turn.beats_completed.length) meta.lastDriftStageCalled = 0;
        meta.stats.lastTurnUsd = turnUsd;
        if (Math.random() < 0.15) {
            maybeCondenseNotes().catch(err => console.warn('[Dungeon Master] notes condense failed', err));
        }
    } else {
        if (rollResolution) {
            // A roll without a DM call can't happen (roll_result always calls the DM), but be safe.
            await postNote(rollResolution);
        }
        await taskWalk;
        await localReplies(c, triage, playerText, status, signal);
        meta.stats.localTurns = (meta.stats.localTurns || 0) + 1;
        await ruleOnCompanionAttempts(c, localReplies.lastSpeakers || [], status, signal, { moved: taskWent ? [triage.task.who] : [] });
    }
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

let mapSyncing = Promise.resolve();

function queueMapSync(c, fromIndex) {
    mapSyncing = mapSyncing.then(() => mapSync(c, fromIndex)).catch(error => console.warn('[Dungeon Master] map sync failed', error));
}

/**
 * After a turn, the story and the map are put back in step: a model (the local helper by default,
 * Haiku when there's no helper or the setting says so) reads what was just said next to what the
 * map shows and lists what's missing (a dog that burst out of a kennel, Judy walking over to it,
 * Judy ducking behind a crate, a door kicked in). Every change is checked against the real map in
 * code (core/mapsync.js) before anyone moves; party members walk there. Shown on a 🗺️ card.
 */
async function mapSync(c, fromIndex) {
    const s = settings();
    const how = s.mapSync ?? 'local';
    if (how === 'off' || campaign() !== c || !mapsOn() || c.docs.world.combat) return;
    const said = ST.chat.slice(fromIndex).filter(m => m.mes && !m.is_user && !/^\s*(📜|🗺️|📈)/u.test(m.mes));
    if (!said.length) return;
    const ctx = syncContext(c);
    if (!ctx) return;
    const story = trimToTokens(said.map(m => `${m.name}: ${String(m.mes).replace(/<[^>]+>/g, ' ')}`).join('\n\n'), 1200, true);
    const { system, user } = mapSyncPrompt({ ...ctx, story });
    const local = how === 'local' && s.useHelper;
    const raw = local
        ? await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 400, profileId: s.helperProfileId })
        : (await callClaude({ system, user, task: 'map_sync', maxTokens: 500, label: 'Map sync' })).text;
    if (campaign() !== c) return;
    const ops = parseMapSync(raw, ctx.known, { story });
    if (!ops.length) return;
    // Don't walk anyone while the player is mid-walk or a new turn is running: wait for it.
    const log = await applyMapSync(c, ops);
    if (!log.length) return;
    saveDoc('world');
    await postDiceCard(`🗺️ Map: ${log.join(' · ')}`, { state: true });
    // Someone who just went for the party and is already on them: that's the next thing to rule on.
    const sprung = takeTrapEvents();
    if (sprung.length && !running) setTimeout(() => runTurn({ force: 'explore', placeEvent: sprung.join(' ') }), 50);
}

/**
 * The party walked a good way on the map (a dozen squares) without a chat turn: the world takes a
 * turn too. Fire spreads, patrols move, hunters close in, and the world's clock ticks. The DM is
 * called only when something happens, or when the world is due to act anyway.
 */
async function movedTurn(c, status, signal) {
    const meta = c.meta, pacing = meta.pacing;
    status.note('You moved a good way: the world moves too');
    let placeEvent = '';
    const burned = await fireTurn(c, status);
    if (burned) placeEvent = burned;
    if (!pacing.inCombat) {
        const spotted = tickPlace(c);
        if (spotted.length) placeEvent = [placeEvent, `${spotted.map(g => `${g.name} (${g.description || 'a guard'}${g.down ? `, ${g.down === 'bound' ? 'tied up' : g.down}` : ''})`).join(' and ')} ${spotted.length > 1 ? 'come' : 'comes'} into view nearby. Decide whether they notice the party (roll for it) and what they do.`].filter(Boolean).join(' ');
        const watched = watchTurn(c);
        if (watched) placeEvent = [placeEvent, watched].filter(Boolean).join(' ');
        const hunt = huntersTurn(c);
        if (hunt) placeEvent = [placeEvent, hunt].filter(Boolean).join(' ');
    }
    refreshMap();
    if (Number.isFinite(pacing.worldClock)) pacing.worldClock -= 1;
    else pacing.localTurnsSinceDM++;
    const b = budget();
    const due = dmReasons({ pacing, triage: {}, eventDue: false, checkinEvery: Number(settings().checkinEvery) || 5, budgetBlocked: b.level === 'blocked', budgetTight: b.level === 'tight', lastDriftStageCalled: meta.lastDriftStageCalled }).filter(r => r === 'checkin');
    const reasons = [...(placeEvent ? ['explore'] : []), ...due];
    if (!reasons.length || b.level === 'blocked' || signal.aborted) return;
    const here = currentPlace(c);
    const lead = here?.place.state.positions[meta.persona.name];
    const room = lead ? roomAt(here.place, lead.floor, lead.x, lead.y)?.name : '';
    const event = [placeEvent, `The party has been moving about ${here?.place.name ?? 'the area'} on the map${room ? ` and is now in ${room}` : ''}.`].join(' ');
    const model = modelFor(reasons, {});
    const step = status.step(`DM is thinking (${modelLabel(model)}) · ${reasons.join(', ')}`);
    try {
        const result = await withDmThinking('The Dungeon Master is thinking', () => askDm({ reasons, placeEvent: event }, { signal, model }));
        step.done(`${summarizeTurn(result.turn)} · ${modelLabel(result.model)}`, result.usd);
        await applyDmTurn(c, result.turn, status, signal, { reasons });
        meta.stats.lastTurnUsd = result.usd;
    } catch (error) {
        step.fail(error);
        if (error instanceof BudgetError) throw error;
    }
}

/**
 * The companions in a fight around the player: with them (not away, not held somewhere else) and, on
 * a map, on the same floor and in sight or close by. A companion caged across the dungeon, or waiting
 * two floors up, is not in it: no initiative, no square beside the player, no turns.
 */
export function fighters(c) {
    const w = c.docs.world, here = currentPlace(c);
    return c.meta.party.map(p => p.name).filter(n => !isAway(w, n) && (!here || inTheFight(here.place, c.meta.persona.name, n)));
}

/** The party members in the current fight (the player first). */
function fightParty(c) {
    return [c.meta.persona.name, ...(c.docs.world.combat?.party ?? c.meta.party.map(p => p.name))];
}

/**
 * Each round: a companion who wasn't in the fight but is now (freed from her cage, came down the
 * stairs, caught up) joins it: the code rolls her initiative and she takes her square. Returns lines.
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
        const here = currentPlace(c);
        const p = here?.place.state.positions[name];
        if (w.combat.map && p && w.combat.inPlace && p.floor === w.combat.inPlace.floor) w.combat.positions[name] = toCoord(p.x, p.y);
        lines.push(`${name} joins the fight: initiative **${r?.total ?? 10}**`);
    }
    return lines;
}

/** Who an attack is at: the DM's target, or someone its own words name, or (an enemy attacking) the player. */
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

let bookkeeping = Promise.resolve();
function queueBookkeeping(c, fromIndex) {
    bookkeeping = bookkeeping.then(() => bookkeep(c, fromIndex)).catch(error => console.warn('[Dungeon Master] bookkeeping failed', error));
}

/**
 * After a turn, the local model reads what was just said (the DM's narration, companions' and NPCs'
 * replies) next to the tracked status, and fills in what the story says happened that isn't on the
 * books yet (someone passed out or can't walk, an item changed hands). Checked in code first (known
 * conditions, people who are here, nothing twice); shown on a 📜 card.
 */
async function bookkeep(c, fromIndex) {
    const s = settings();
    if (!s.useHelper || s.bookkeeper === false || campaign() !== c) return;
    // Only the DM's narration is evidence: what companions and NPCs say is the local model's own
    // guesswork ("open the latch" doesn't open it), and enemies' and map people's state is the DM's.
    const said = ST.chat.slice(fromIndex).filter(m => !m.is_user && m.mes && dmType(m) === 'narration');
    if (!said.length) return;
    const story = trimToTokens(said.map(m => `${m.name}: ${m.mes}`).join('\n\n'), 1200, true);
    const w = c.docs.world;
    const party = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
    const present = [];
    const own = n => w.inventory?.[matchName(n, Object.keys(w.inventory || {})) ?? ''] ?? [];
    const { system, user } = bookkeeperPrompt({
        status: party.map(n => ({ name: n, hp: w.party[n] ? `${w.party[n].hp}/${w.party[n].hp_max}` : '', conditions: conditionsOf(w, n), items: own(n) })),
        shared: w.items || [],
        others: present.map(n => `${n}${conditionsOf(w, n).length ? ` (${conditionsOf(w, n).join(', ')})` : ''}`),
        story,
    });
    const raw = await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 300, profileId: s.helperProfileId });
    const changes = parseBookkeeping(raw, {
        names: party,
        itemNames: party,
        story,
        conditionsOf: n => conditionsOf(w, n),
        itemsOf: n => [...own(n), ...(w.items || [])],
        allItems: [...(w.items || []), ...Object.values(w.inventory || {}).flat()],
    });
    if (!changes) return;
    const log = applyStateChanges(w, changes, c.meta.party.map(p => p.name), { turn: c.meta.turn });
    if (!log.length) return;
    saveDoc('world');
    await postDiceCard(`📜 Bookkeeping: ${log.join(' · ')}`, { state: true });
    refreshMap();
}

/**
 * Walking into a new room, a companion may go and look at something there on their own (about one
 * room in three): only if they haven't agreed to stick by the player's side, aren't hurt, held or
 * staying behind, and something there would catch their eye. They walk over, roll their own
 * Investigation (it can turn up a trap or something hidden in the room), and say what they found.
 * All local: the helper decides, the dice are code, the actor speaks. No Claude call.
 */
export async function companionCuriosity(c, roomId) {
    const s = settings();
    const cur = currentPlace(c);
    if (running || !cur || !s.useHelper || c.docs.world.combat || random01() > 1 / 3) return;
    const { key, place } = cur;
    const lead = place.state.positions[c.meta.persona.name];
    const room = place.rooms[roomId];
    if (!lead || !room) return;
    const free = c.meta.party.map(p => p.name).filter(n => {
        const p = place.state.positions[n];
        return p && p.floor === lead.floor && roomAt(place, p.floor, p.x, p.y)?.id === roomId && !place.state.waiting?.[n] && c.meta.stance?.[n] !== 'close' && !lockedReason(c, n);
    });
    if (!free.length) return;
    const name = free[Math.floor(random01() * free.length)];
    const things = goTargets(c, name).filter(t => !/next door/.test(t.name));
    if (!things.length) return;
    running = true;
    const status = beginTurn(`${name} looks around`);
    try {
        const member = c.meta.party.find(p => p.name === name);
        const system = 'You decide one thing about a character in a roleplay. Reply with JSON only.';
        const user = [
            `${name}: ${trimToTokens(member?.summary || '', 200)}`,
            c.meta.standing ? `Right now: ${c.meta.standing}` : '',
            `${name} just walked into ${room.name} with ${c.meta.persona.name}.${room.description ? ` ${trimToTokens(room.description, 120)}` : ''}`,
            `Things here: ${things.map(t => `${t.id} = ${t.name}`).join('; ')}`,
            `Would ${name}, being who they are, go and look at one of these on their own right now (curious, suspicious, drawn to it)? Most of the time they just stay with the group: only if one would really catch their eye.`,
            'JSON: {"go": "the id, or empty", "why": "a few words"}',
        ].filter(Boolean).join('\n');
        const pick = extractJson(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 60, profileId: s.helperProfileId })) || {};
        const thing = things.find(t => t.id === String(pick.go ?? '').trim());
        if (!thing) { status.finish(`${name} stays with you`); return; }
        const went = await companionGoTo(c, name, thing.id, { stay: false });
        if (!went) { status.finish(`${name} stays with you`); return; }
        // Their own check.
        const stats = statsForName(name, c.meta);
        const { mod } = lookupModifier(stats, { kind: 'check', skill: 'Investigation', ability: 'INT' });
        const die = roll('1d20');
        const total = (die?.total ?? 10) + mod;
        await postDiceCard(`🎲 **${name}** · Investigation (looking at the ${went} on their own): d20 (${die?.natural ?? '?'}) ${formatModifier(mod)} = **${total}**`);
        c.docs.rolls_log.push({ at: new Date().toISOString(), who: name, what: 'Investigation (on their own)', kind: 'check', natural: die?.natural ?? null, mod, total, dc: null, success: null });
        saveDoc('rolls_log');
        const search = searchForTraps(c, name, total);
        // Something hidden in this room turns up for a good look.
        const items = total >= 12 ? Object.values(place.items).filter(i => i.room === roomId && i.state !== 'taken' && !i.found) : [];
        for (const i of items) i.found = true;
        if (items.length) savePlace(key, c);
        if (search?.found.length) { await postNote(`⚠️ ${name} spots: ${search.found.join(', ')}.`); refreshMap(); }
        const found = [...items.map(i => i.name), ...(search?.found ?? [])];
        const brief = `You went over to look at the ${went} on your own (${String(pick.why || 'it caught your eye').slice(0, 80)}). Your Investigation roll was ${total}. ${found.length ? `You found: ${found.join(', ')}. ` : 'You found nothing special. '}Say it to ${c.meta.persona.name} in a line or two, in character.`;
        const step = status.step(`${name} is responding`);
        await makeSpeak(name, brief, { signal: new AbortController().signal, length: 'short' });
        step.done();
        status.finish(`${name} looked at the ${went}`);
    } catch (error) {
        console.warn('[Dungeon Master] companion curiosity failed', error);
        status.finish('');
    } finally {
        running = false;
        runQueuedTurn();
    }
}

/**
 * You came back to a companion you'd left (or walked in on one who's locked up), or walked away
 * from one who's staying. Each one decides, in character, whether they'd say anything right now
 * (local model; often they won't); if so they speak, all locally (no Claude call): asking what you
 * found, begging to be let out, telling you to be careful.
 * list: [{name, kind: 'back' | 'held' | 'left' | 'left-held', room, since?, turns?, why?, refused?}]
 */
export async function companionsSeeYou(c, list) {
    const s = settings();
    if (running || !s.useHelper || c.docs.world.combat || !list.length) return;
    running = true;
    const player = c.meta.persona.name;
    const status = beginTurn('Your companions');
    try {
        for (const g of list.slice(0, 2)) {
            const member = c.meta.party.find(p => p.name === g.name);
            if (!member) continue;
            const moment = g.kind === 'back' ? `${player} just came back to ${g.room || 'where you were'}, where you stayed behind${g.turns > 0 ? ` (${g.turns} turn${g.turns > 1 ? 's' : ''} ago)` : ''}${g.since?.length ? `; since leaving you they went through ${g.since.slice(-4).join(', ')}` : ''}. You're coming along with them again.`
                : g.kind === 'held' ? `${player} just walked into ${g.room || 'the room'} where you are locked up${g.why ? ` (${g.why.replace(/\s*\(on the map:.*\)$/, '')})` : ''}. You can't get out by yourself.`
                    : g.kind === 'left-held' ? `${player} is walking out of ${g.room || 'the room'} and leaving you here, still locked up.`
                        : `${player} is walking out of ${g.room || 'the room'}; you're staying here${g.refused ? ' (your choice)' : ''}.`;
            // Would they say anything? Often not.
            const decide = [
                `${g.name}: ${trimToTokens(member.summary || '', 200)}`,
                c.meta.standing ? `Right now: ${c.meta.standing}` : '',
                `Moment: ${moment}`,
                `Would ${g.name}, being who they are, say something to ${player} right now? Only if it fits: someone left alone a short while may just nod; someone trapped and desperate will call out. Reply JSON: {"speak": true or false, "what": "a few words: what they'd want to say"}`,
            ].filter(Boolean).join('\n');
            const pick = extractJson(await callLocal({ system: 'You decide one thing about a character in a roleplay. Reply with JSON only.', messages: [{ role: 'user', content: decide }], maxTokens: 60, profileId: s.helperProfileId })) || {};
            if (!(pick.speak === true || pick.speak === 'true')) { status.note(`${g.name} says nothing`); continue; }
            const brief = g.kind === 'back' ? `${moment} React in a line or two, in character${g.since?.length ? ': ask what they found or what happened, if you would' : ''}. You want to say: ${String(pick.what || '').slice(0, 100)}.`
                : g.kind === 'held' ? `${moment} React in character, a line or two: plead with ${player} to get you out, tell them anything you know that would help (who has the key, how the lock works). You want to say: ${String(pick.what || '').slice(0, 100)}.`
                    : `${moment} Say one short line as they go, in character. You want to say: ${String(pick.what || '').slice(0, 100)}.`;
            const step = status.step(`${g.name} speaks`);
            await makeSpeak(g.name, brief, { signal: new AbortController().signal, length: 'short' });
            step.done();
        }
        status.finish('');
    } catch (error) {
        console.warn('[Dungeon Master] companion reaction failed', error);
        status.finish('');
    } finally {
        running = false;
        runQueuedTurn();
    }
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

function summarizeTurn(t) {
    const bits = [];
    if (t.narration) bits.push('narration');
    if (t.player_roll) bits.push(`asks ${t.player_roll.skill}`);
    if (t.npc_rolls.length) bits.push(`${t.npc_rolls.length} roll(s)`);
    if (t.directions.length) bits.push(`→ ${t.directions.map(d => d.speaker).join(', ')}`);
    if (t.new_npcs.length) bits.push(`+${t.new_npcs.length} NPC`);
    if (t.beats_completed.length) bits.push(`beat ${t.beats_completed.join(', ')}`);
    return bits.join(' · ') || 'no changes';
}

/**
 * Who answers locally: the helper's pick (which may be nobody), else whoever the player named,
 * else a companion who is with the player. Companions who split off never answer.
 */
function localSpeakers(c, triage, playerText) {
    const candidates = speakerCandidates();
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
async function ruleOnCompanionAttempts(c, names, status, signal, { moved = [] } = {}) {
    const s = settings();
    if (!s.useHelper) return;
    for (const name of names) {
        if (!c.meta.party.some(p => p.name === name)) continue;
        const msg = [...ST.chat].reverse().find(m => !m.is_user && m.name === name);
        if (!msg?.mes) continue;
        let attempt;
        // Already walked where the player told them: don't move them again.
        const places = c.docs.world.combat || moved.includes(name) ? [] : goTargets(c, name);
        try {
            const { system, user } = companionActionPrompt({ name, message: trimToTokens(msg.mes, 500), scene: `${c.docs.world.location || 'unknown'}; ${c.meta.standing || ''}`, places, player: c.meta.persona.name, askStance: Boolean(currentPlace(c)) && !c.docs.world.combat });
            attempt = parseCompanionAction(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 100, profileId: s.helperProfileId }), places, msg.mes);
        } catch {
            continue;
        }
        // Coming along, sticking close, or staying behind: what they said in their reply.
        if (attempt.stance && !attempt.go) await setStance(c, name, attempt.stance, status);
        if (attempt.go && !signal.aborted) {
            const went = await companionGoTo(c, name, attempt.go, { hide: attempt.hide, pose: attempt.pose });
            if (went) status.note(attempt.hide ? `${name} hides ${went}` : /^(sit|lie|sleep) on /.test(went) ? `${name} goes to ${went}` : `${name} goes to the ${went} and stays there`);
        }
        if (!attempt.attempt || signal.aborted) continue;
        const reasons = ['companion_action'];
        const model = modelFor(reasons);
        const step = status.step(`DM rules on ${name}'s attempt (${modelLabel(model)}): ${attempt.what || 'something risky'}`);
        try {
            const result = await withDmThinking(`The Dungeon Master is ruling on ${name}'s attempt`, () => askDm({ reasons, companionAction: { name, what: attempt.what, text: msg.mes } }, { signal, model }));
            step.done(summarizeTurn(result.turn), result.usd);
            await applyDmTurn(c, result.turn, status, signal);
            c.meta.stats.lastTurnUsd = (c.meta.stats.lastTurnUsd || 0) + result.usd;
        } catch (error) {
            step.fail(error);
        }
        return; // one ruling per turn
    }
}

/** After a companion's reply the DM directed: if they said they go somewhere, they walk there on the map. */
async function companionMovesOnMap(c, name, status, signal) {
    const s = settings();
    if (!s.useHelper || c.docs.world.combat || !c.meta.party.some(p => p.name === name)) return;
    const places = goTargets(c, name);
    if (!currentPlace(c)) return;
    const msg = [...ST.chat].reverse().find(m => !m.is_user && m.name === name);
    if (!msg?.mes) return;
    try {
        const { system, user } = companionActionPrompt({ name, message: trimToTokens(msg.mes, 500), scene: c.docs.world.location || '', places, askAttempt: false, player: c.meta.persona.name, askStance: true });
        const { go, hide, pose, stance } = parseCompanionAction(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 80, profileId: s.helperProfileId }), places, msg.mes);
        if (stance && !go) await setStance(c, name, stance, status);
        if (!go || signal.aborted) return;
        const went = await companionGoTo(c, name, go, { hide, pose });
        if (went) status.note(hide ? `${name} hides ${went}` : /^(sit|lie|sleep) on /.test(went) ? `${name} goes to ${went.replace(/ on /, ' on ')}` : `${name} goes to the ${went} and stays there`);
    } catch (error) {
        console.warn('[Dungeon Master] companion move check failed', error);
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
        const here = currentPlace(c);
        if (here && markNoticed(here.place, pr.spot.seer, pr.spot.seen, noticed)) savePlace(here.key, c);
    }
    const mark = judged.success === true ? '✔' : judged.success === false ? '✘' : '';
    const flair = natural === 20 ? ' — **natural 20!**' : natural === 1 ? ' — natural 1…' : '';
    const dcText = pr.dc !== null && pr.kind !== 'damage' ? ` vs ${pr.kind === 'attack' ? 'AC' : 'DC'} ${pr.dc}` : '';
    const card = pr.kind === 'damage'
        ? `🎲 **${meta.persona.name}** — damage: **${total}**`
        : `🎲 **${meta.persona.name}** — ${pr.skill}: d${pr.die || 20} (${natural ?? '?'}) ${formatModifier(mod)} = **${total}** ${mark}${dcText}${flair}`;
    await postDiceCard(card, { roll: { who: meta.persona.name, ...pr, natural, total, success: judged.success } });
    if (pr.kind === 'attack') playAnim(meta.persona.name, 'attack');
    c.docs.rolls_log.push({ at: new Date().toISOString(), who: meta.persona.name, what: pr.skill, kind: pr.kind, natural, mod, total, dc: pr.dc, success: judged.success });
    saveDoc('rolls_log');
    if (pr.kind === 'initiative' && c.docs.world.combat) {
        addToInitiative(c.docs.world, meta.persona.name, total);
        saveDoc('world');
    }
    status.note(`You rolled ${total}${mark ? ` ${mark}` : ''}`);
    // Caught in a trap: a save that works gets you loose.
    let saveHurt = '';
    if (pr.kind === 'save' && judged.success === true && freeFromTrap(c, meta.persona.name)) {
        await postNote(`🪤 ${meta.persona.name} gets loose!`);
        saveHurt += ` ${meta.persona.name} got loose from the trap.`;
        refreshMap();
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
    const search = pr.kind !== 'damage' && /perception|investigation|search/i.test(`${pr.skill} ${pr.reason || ''}`) ? searchForTraps(c, meta.persona.name, total) : null;
    if (search?.found.length) { await postNote(`⚠️ Searching ${search.room}, ${meta.persona.name} spots: ${search.found.join(', ')}.`); refreshMap(); }
    const searchText = search ? ` Searching ${search.room} with that roll, the code revealed: ${search.found.length ? search.found.join(', ') : 'no traps'} (traps the roll didn't beat stay hidden; say nothing about them).` : '';
    if (pr.kind === 'damage') return `${meta.persona.name} rolled ${total} damage for: ${pr.reason || pr.skill}. Apply it (state_changes.hp) and narrate.`;
    return searchText + saveHurt + `${meta.persona.name} rolled ${natural ?? '?'} on the d${pr.die || 20} ${formatModifier(mod)} (${source}) = ${total}${pr.dc !== null ? ` vs hidden DC ${pr.dc}: ${judged.success ? 'SUCCESS' : 'FAILURE'}` : ''}${natural === 20 ? ' (natural 20)' : natural === 1 ? ' (natural 1)' : ''}. Roll was for: ${pr.reason || pr.skill}.${pr.kind === 'attack' && judged.success && pr.damage ? ` On a hit, ask the player to roll damage (${pr.damage}) with player_roll kind "damage".` : ''}`;
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
function outcomeText(r, judged) {
    const text = judged.success === false ? r.on_fail : r.on_success;
    return text ? ` → ${text}` : '';
}

/** Apply everything the DM decided, in a sensible order. */
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
    const enemies = [...foes.values()].map(name => {
        const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
        const stats = String(npc?.stats || '');
        return { name: npc?.name ?? name, ac: Number(/\bAC\s*(\d+)/i.exec(stats)?.[1]) || 12, hp: Number(/\bHP\s*(\d+)/i.exec(stats)?.[1]) || 10, dex: 0, sprite: npc?.sprite || '' };
    });
    return { enemies, map: null };
}

export async function applyDmTurn(c, t, status, signal, { events = [], reasons = [], quiet = false } = {}) {
    const meta = c.meta;
    const world = c.docs.world;
    // Maps off: anything about maps in the DM's answer is ignored (the story stays in the chat).
    if (!mapsOn()) {
        Object.assign(t, { build_place: null, enter_place: '', scene_map: null, place_changes: null, map_effects: null, positions: {} });
        if (t.start_combat) t.start_combat.map = null;
    }

    // New NPCs (with voices).
    if (t.new_npcs.length) {
        const added = addNpcs(c.docs.npcs, t.new_npcs, t.scene?.location || world.location);
        for (const npc of added) {
            npc.voice = pickNpcVoice(npc, c.docs.npcs);
        }
        if (added.length) status.note(`New: ${added.map(n => n.name).join(', ')}`);
        saveDoc('npcs');
    }

    // Scene.
    const prevLocation = world.location;
    // Inside a built place the location IS the place: a room name the DM sends would make every NPC
    // "elsewhere" and wipe the scene card. Rooms are tracked by the map. Leaving or moving on still counts.
    const stayingInside = Boolean(currentPlace(c)) && !t.leave_place && !t.build_place && !t.enter_place;
    if (t.scene) {
        if (t.scene.location && stayingInside && nameKey(t.scene.location) !== nameKey(world.location)) { status.note(`Location stays ${world.location} (the map tracks the room)`); t.scene.location = world.location; }
        if (t.scene.location) world.location = t.scene.location;
        if (t.scene.setting) world.setting = guessSetting(world.location, t.scene.setting);
        if (t.scene.time) {
            if (/morning|dawn/.test(t.scene.time) && /night|evening/.test(world.time || '')) world.day = (world.day || 1) + 1;
            world.time = t.scene.time;
            syncNight(c);
        }
    }
    // A new place: the old scene card no longer applies. A new scene: NPCs forget the last one.
    const newPlace = Boolean(t.scene?.location && prevLocation && nameKey(t.scene.location) !== nameKey(prevLocation));
    const newScene = newPlace || Boolean(t.scene?.changed);
    world.sceneCard = applySceneCard(world.sceneCard, t.scene_card, { newPlace, partyNames: [meta.persona.name, ...meta.party.map(p => p.name)] });
    // Who split off from the player, and who is back.
    applyPresence(world, meta.party.map(p => p.name), t.party_away, t.party_back);
    // Back with the player: no longer held or waiting anywhere on the map.
    const herePlace = currentPlace(c);
    if (herePlace && t.party_back.length) {
        for (const n of t.party_back) { const m = matchName(n, meta.party.map(p => p.name)); if (m) { delete herePlace.place.state.waiting?.[m]; delete herePlace.place.state.held?.[m]; } }
        savePlace(herePlace.key, c);
    }
    // Taken somewhere in this place (caged in the dungeon): they're put in a real room to find.
    const held = placeHeld(c);
    if (held.length) status.note(`${held.join(', ')} put on the map where the story keeps them`);
    // NPCs who get briefs are "here".
    for (const d of t.directions) {
        const npc = c.docs.npcs.find(n => nameKey(n.name) === nameKey(d.speaker));
        if (npc) npc.lastSeen = world.location;
    }

    // State, combat, pacing, plot.
    const changeLog = applyStateChanges(world, t.state_changes, c.meta.party.map(p => p.name), { turn: meta.turn });
    let initiativeCard = '';
    let mapChanged = false;
    // An attack rolled outside a fight starts one, so moves are limited even when the DM forgot start_combat.
    if (!world.combat && !t.start_combat && !t.end_combat) {
        const auto = combatFromAttacks(c, t);
        if (auto) {
            t.start_combat = auto;
            status.note(`Fight started (an attack was rolled)${auto.enemies.length ? `: ${auto.enemies.map(e => e.name).join(', ')}` : ''}`);
        }
    }
    if (t.start_combat && !world.combat) {
        // Only companions with the player are in it: not one caged elsewhere, away, or out of reach.
        const inFight = fighters(c);
        const left = meta.party.map(p => p.name).filter(n => !inFight.includes(n));
        if (left.length) status.note(`Not in the fight (elsewhere or out of reach): ${left.join(', ')}`);
        const companions = inFight.map(n => ({ name: n, stats: statsForName(n, meta) }));
        const combat = startCombat(world, t.start_combat, companions);
        combat.party = inFight;
        // Inside a place the fight is always on the place's own map, where everyone already stands
        // (never a new battle map). Elsewhere: a mapped room becomes the battle map unless the DM sent one.
        const here = currentPlace(c);
        const roomMap = !here && !t.start_combat.map && world.sceneMap?.map ? world.sceneMap : null;
        if (here) {
            const floorId = here.place.state.positions[meta.persona.name]?.floor ?? here.place.state.floor;
            combat.map = JSON.parse(JSON.stringify(floorById(here.place, floorId).map));
            combat.inPlace = { key: here.key, floor: floorId };
            combat.positions = Object.fromEntries(Object.entries(here.place.state.positions).filter(([n, p]) => p.floor === floorId && (n === meta.persona.name || inFight.includes(n))).map(([n, p]) => [n, toCoord(p.x, p.y)]));
            // The place's people on this floor join the board where they stand: the enemies among
            // them, and anyone the party can see (bystanders stay on the map during the fight).
            const seen = computeVisible(here.place, floorId, Object.values(here.place.state.positions).filter(p => p.floor === floorId));
            // An enemy the DM names is the person already on the map ("Watchman" is Turnkey Wren):
            // they fight from where they stand, and are the same person when the fight ends.
            combat.aliases = {};
            for (const ename of Object.keys(combat.enemies || {})) {
                const g = matchPerson(here.place, floorId, ename, seen);
                if (!g) continue;
                if (nameKey(g.name) !== nameKey(ename)) combat.aliases[ename] = g.name;
                combat.positions[ename] = toCoord(g.x, g.y);
                if (g.wasHostile === undefined) g.wasHostile = g.hostile === true;
                g.hostile = true; g.state = 'alert'; delete g.down; delete g.fought;
            }
            const foeKeys = new Set(Object.keys(combat.enemies || {}).map(nameKey));
            const standIns = new Set(Object.values(combat.aliases).map(nameKey));
            for (const g of Object.values(here.place.guards)) {
                if (g.state === 'gone' || g.floor !== floorId || standIns.has(nameKey(g.name))) continue;
                if (foeKeys.has(nameKey(g.name)) || seen[g.y * combat.map.w + g.x]) combat.positions[g.name] = toCoord(g.x, g.y);
            }
            // A fight is loud: whoever belongs here, awake and not in it, within earshot, can hear it (the DM decides if they come).
            const lead = here.place.state.positions[meta.persona.name];
            const inIt = new Set([...foeKeys, ...standIns]);
            const dist = g => (lead ? Math.max(Math.abs(g.x - lead.x), Math.abs(g.y - lead.y)) : 99);
            const hears = Object.values(here.place.guards)
                .filter(g => g.state !== 'gone' && g.state !== 'dead' && !g.down && g.hostile !== true && g.floor === floorId && !inIt.has(nameKey(g.name)) && dist(g) <= EARSHOT * 2)
                .map(g => `${g.name} (${g.description || 'someone who belongs here'}, ${dist(g)} squares away${g.role === 'guard' ? ', a guard' : ''})`);
            here.place.state.fight = { turn: meta.turn, hears };
        } else if (mapsOn()) {
            combat.map = roomMap ? roomMap.map : normalizeMap(t.start_combat.map || {});
            combat.positions = roomMap ? { ...(roomMap.positions || {}) } : {};
        }
        mapChanged = true;
        initiativeCard = `⚔️ **Initiative**\n${combat.order.map(o => `- ${o.name}: **${o.init}**`).join('\n')}\n*(${meta.persona.name}: roll your own initiative when asked)*`;
    }
    if (world.combat?.map) {
        const friends = fightParty(c);
        const foes = Object.keys(world.combat.enemies || {});
        // The party moves at most their speed each round (twice that when dashing), around walls.
        const moves = { ...(t.positions || {}) };
        for (const name of friends) {
            const from = parseCoord(world.combat.positions?.[name], world.combat.map), to = parseCoord(moves[name], world.combat.map);
            if (!from || !to || t.start_combat) continue;
            const others = new Set(Object.entries(world.combat.positions || {}).filter(([n]) => n !== name && !(world.combat.enemies?.[n]?.hp <= 0)).map(([, cd]) => parseCoord(cd, world.combat.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
            const max = speedSquares(statsForName(name, meta)) * (t.dashing.some(n => nameKey(n) === nameKey(name)) ? 2 : 1);
            const ok = clampMove(world.combat.map, from, to, max, others);
            if (ok.x !== to.x || ok.y !== to.y) status.note(`${name} can only get to ${toCoord(ok.x, ok.y)} this round`);
            moves[name] = toCoord(ok.x, ok.y);
        }
        const { positions, rejected } = applyPositions(world.combat.map, world.combat.positions, moves);
        if (world.combat.inPlace) {
            const lead = parseCoord(positions[meta.persona.name], world.combat.map);
            world.combat.positions = placeNear(world.combat.map, placeNear(world.combat.map, positions, friends, lead, 1), foes, lead, 3);
        } else {
            world.combat.positions = placeMissing(world.combat.map, placeMissing(world.combat.map, positions, friends, 'party'), foes, 'enemy');
        }
        // Downed enemies stay where they fell (a body on the board) for the whole fight.
        for (const e of Object.values(world.combat.enemies || {})) if (e.hp <= 0) e.downRound ??= world.combat.round || 1;
        if (rejected.length) console.warn('[Dungeon Master] Ignored invalid map moves:', rejected);
        mapChanged = true;
    }
    // Each DM combat turn is a new round (a roll's result finishes the round it was asked in).
    if (world.combat && !t.start_combat && reasons.includes('combat_round') && !reasons.includes('roll_result')) {
        world.combat.round = (world.combat.round || 1) + 1;
        const joined = joinLateFighters(c);
        if (joined.length) await postDiceCard(`⚔️ ${joined.join(' · ')}`, { combat: true });
        const ended = expireConditions(world, { round: world.combat.round });
        if (ended.length) await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true });
        await deathSaves(c);
    }
    // A fight over: what lasts only the fight ends.
    if (t.end_combat) {
        const ended = expireConditions(world, { combatOver: true });
        if (ended.length) await postDiceCard(`📜 ${ended.join(' · ')}`, { state: true });
    }
    // A rest: HP, hit dice, spell slots and abilities in code (the DM only says it happened).
    if (t.rest) {
        const rested = takeRest(world, t.rest, [meta.persona.name, ...meta.party.map(p => p.name).filter(n => !isAway(world, n))], n => statsForName(n, meta), roll);
        if (rested.length) await postDiceCard(`📜 ${t.rest === 'long' ? 'Long rest' : 'Short rest'}: ${rested.join(' · ')}`, { state: true });
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
    if (t.end_combat && world.combat?.inPlace) {
        // Back to exploring: the party stays where the fight left them.
        const here = currentPlace(c);
        if (here) {
            const floorId = world.combat.inPlace.floor, map = floorById(here.place, floorId).map;
            mergeBurn(world.combat.map, map);
            const party = new Set([meta.persona.name, ...meta.party.map(p => p.name)].map(nameKey));
            for (const name of partyOnMap(c)) {
                const pt = parseCoord(world.combat.positions?.[name], map);
                if (pt) here.place.state.positions[name] = { floor: floorId, x: pt.x, y: pt.y };
            }
            const deadNames = new Set((t.npcs_dead || []).map(nameKey));
            for (const [name, e] of Object.entries(world.combat.enemies || {})) {
                // The map's own person when the DM called them something else.
                const pname = world.combat.aliases?.[name] ?? name;
                const pt = parseCoord(world.combat.positions?.[name], map);
                if (pt) placePerson(here.place, pname, { floor: floorId, x: pt.x, y: pt.y }, { info: { hostile: true } });
                const g = personByName(here.place, pname);
                if (e.hp <= 0) {
                    // Dead only when the DM says so; otherwise down and out (knocked out, bleeding) where they fell.
                    const dead = deadNames.has(nameKey(name)) || deadNames.has(nameKey(pname)) || (e.conditions || []).some(x => /\b(dead|slain|killed)\b/i.test(x));
                    if (dead) killPerson(here.place, pname, meta.turn);
                    else if (g) { g.down = 'unconscious'; g.state = 'alert'; delete g.intent; delete g.target; }
                    continue;
                }
                // Alive at the end: someone who wasn't an enemy before the fight (a guard who yielded) isn't one now,
                // unless the DM sets an intent; the DM is told they fought.
                if (g) {
                    if (g.wasHostile === false) { g.hostile = false; g.state = 'alert'; g.fought = true; delete g.intent; delete g.target; }
                    delete g.wasHostile;
                }
            }
            delete here.place.state.fight;
            for (const [name, cd] of Object.entries(world.combat.positions || {})) {
                const g = personByName(here.place, name), pt = parseCoord(cd, map);
                if (g && pt && !party.has(nameKey(name)) && !world.combat.enemies?.[name]) Object.assign(g, { floor: floorId, x: pt.x, y: pt.y, room: roomAt(here.place, floorId, pt.x, pt.y)?.id ?? g.room });
            }
            savePlace(here.key, c);
        }
    }
    if (t.end_combat && world.combat) {
        const finalPositions = world.combat.positions;
        const sameRoom = world.sceneMap?.map && world.combat.map === world.sceneMap.map;
        endCombat(world);
        if (sameRoom) {
            world.sceneMap.positions = finalPositions;
            refreshMap();
        } else if (!world.sceneMap) {
            closeMap();
        }
        status.note('Combat over');
    }
    // Scene maps outside combat (a dungeon room where exact squares matter).
    if (t.scene_map === 'close' && world.sceneMap) {
        world.sceneMap = null;
        if (!world.combat) closeMap();
    } else if (t.scene_map && typeof t.scene_map === 'object') {
        world.sceneMap = { title: t.scene_map.title || world.location || 'Map', map: normalizeMap(t.scene_map), positions: {} };
        mapChanged = true;
    }
    const inside = currentPlace(c);
    const partyNames = [meta.persona.name, ...meta.party.map(p => p.name)];
    const strays = inside ? adoptStrays(inside.place, partyNames) : 0;
    if (inside && (strays || t.place_changes || (!world.combat && Object.keys(t.positions || {}).length))) {
        const { key, place } = inside;
        const floorId = place.state.positions[meta.persona.name]?.floor ?? place.state.floor;
        if (t.place_changes) {
            const log = applyPlaceChanges(place, t.place_changes, { floor: floorId, turn: meta.turn });
            if (log.length) status.note(`Map: ${log.join(', ')}`);
        }
        if (!world.combat) {
            const map = floorById(place, floorId).map;
            const missed = [];
            // Caught and taken somewhere: access set to "prisoner" or "none" this turn lets the DM move them.
            const captured = new Set();
            for (const [who, spec] of Object.entries(t.place_changes?.access || {})) {
                if (typeof spec !== 'string' || !/^(prisoner|none|intruder|nowhere)$/i.test(spec.trim())) continue;
                for (const n of (who === '*' || who === 'party' ? partyNames : [matchName(who, partyNames)].filter(Boolean))) captured.add(n);
            }
            for (const [name, coord] of Object.entries(t.positions || {})) {
                if (coord === null || /^(gone|removed|dead|fled|left)$/i.test(String(coord))) {
                    const g = personByName(place, name);
                    if (g) g.state = 'gone';
                    continue;
                }
                const member = partyNames.find(n => nameKey(n) === nameKey(name));
                if (member) {
                    // Outside a fight the party moves itself (the map, or the sync walking them): the DM
                    // only moves someone who can't move on their own (carried, dragged).
                    if (!lockedReason(c, member) && !captured.has(member)) { missed.push(`${name} → ${coord} (they move themselves; only someone restrained, or just captured with access "prisoner"/"none", can be moved)`); continue; }
                    const pt = parseCoord(coord, map);
                    const spot = pt && openSquareNear(place, floorId, pt.x, pt.y);
                    if (spot) {
                        place.state.positions[member] = { floor: floorId, ...spot };
                        if (place.state.hidden?.[member]) delete place.state.hidden[member];
                        if (place.state.pose?.[member]) delete place.state.pose[member];
                        // Locked up again: wherever they were put is their cell now.
                        const cell = captured.has(member) && standingOf(place, member).label === 'prisoner' ? roomAt(place, floorId, spot.x, spot.y) : null;
                        if (cell) { setStanding(place, member, standingFor('prisoner', { home: cell.id })); status.note(`${member} is held in ${cell.name}`); }
                    }
                    else missed.push(`${name} → ${coord}`);
                    continue;
                }
                const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
                const info = { description: npc ? [npc.role, npc.description].filter(Boolean).join('. ') : '', hostile: npc?.attitude === 'hostile', gender: npc?.gender };
                if (!placePerson(place, npc?.name ?? name, coord, { floor: floorId, info, arrive: !personByName(place, npc?.name ?? name) })) missed.push(`${name} → ${coord}`);
            }
            if (missed.length) status.note(`Couldn't place on the map: ${missed.join(', ')}`);
        }
        look(c, key, place);
        savePlace(key, c);
        mapChanged = true;
    }
    if (t.map_effects && applyMapEffects(c, t.map_effects, status)) mapChanged = true;
    if (!world.combat && world.sceneMap?.map) {
        const friends = [meta.persona.name, ...meta.party.map(p => p.name).filter(n => !isAway(world, n))];
        const { positions } = applyPositions(world.sceneMap.map, world.sceneMap.positions, t.positions);
        world.sceneMap.positions = placeMissing(world.sceneMap.map, positions, friends, 'party');
        mapChanged = true;
    }
    // NPCs who died leave the group chat.
    if (t.npcs_dead.length) {
        const dead = new Set(t.npcs_dead.map(n => n.toLowerCase()));
        const fallen = (c.docs.npcs || []).filter(n => dead.has(n.name.toLowerCase()));
        for (const npc of fallen) npc.dead = true;
        // Their body stays on the map where they fell for a few turns.
        const where = currentPlace(c);
        if (where) { for (const n of t.npcs_dead) killPerson(where.place, n, meta.turn); savePlace(where.key, c); }
        if (fallen.length) {
            saveDoc('npcs');
            await removeNpcsFromGroup(fallen);
        }
    }
    applyDmPacing(meta.pacing, t, { worldEvery: Number(settings().checkinEvery) || 5 });
    if (t.beats_completed.length) {
        meta.lastDriftStageCalled = 0;
        for (const beat of t.beats_completed) {
            const re = new RegExp(`- \\[ \\] (${beat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`);
            c.docs.plot = c.docs.plot.replace(re, '- [x] $1');
        }
        saveDoc('plot');
        status.note(`Plot beat done: ${t.beats_completed.join(', ')}`);
    }
    if (t.notes_add) {
        c.docs.notes = `${c.docs.notes ? c.docs.notes + '\n' : ''}- (turn ${meta.turn}) ${t.notes_add}`;
        saveDoc('notes');
    }
    if (t.story_add) {
        c.docs.story = `${c.docs.story ? c.docs.story + '\n\n' : ''}${t.story_add}`;
        saveDoc('story');
    }
    if (events.length) {
        const use = t.event?.use || '';
        const chosen = events.find(e => e.id === use);
        if (chosen) {
            recordEvent(c, chosen, 'used');
            status.note(`Random event: ${chosen.title}`);
        } else if (use === 'custom') {
            recordEvent(c, { title: t.event.text || 'Custom event', type: 'custom' }, 'custom');
            status.note('Random event: the DM made one up to fit');
        } else {
            // Nothing fit right now. Reset the clock so we don't ask again next turn.
            recordEvent(c, { title: `(declined: ${events.map(e => e.title).join(', ')})` }, 'declined');
            status.note('No random event: nothing fit the moment');
        }
    }
    // What just visibly changed: companions see it until the DM's next turn, so they don't redo it,
    // and then in their timeline with when and where it happened.
    meta.happened = t.happened || '';
    if (t.happened) meta.timeline = pushTimeline(meta.timeline, { day: world.day, time: world.time, place: world.location, text: t.happened });
    if (t.table_rules_add.length || t.table_rules_remove.length) {
        meta.tableRules = applyTableRules(meta.tableRules, t.table_rules_add, t.table_rules_remove);
        status.note('Table rules updated');
    }
    if (t.standing_direction) meta.standing = t.standing_direction;
    if (t.objective) meta.objective = t.objective;
    // What each companion knows (rare, full-text updates).
    for (const [name, text] of Object.entries(t.knowledge_update || {})) {
        const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (member) {
            meta.knowledge ??= {};
            meta.knowledge[member.name] = text;
        }
    }
    // Their inner state: only the fields the DM sent change.
    for (const [name, update] of Object.entries(t.mind_update || {})) {
        const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!member) continue;
        meta.minds ??= {};
        meta.minds[member.name] = mergeMind(meta.minds[member.name], update);
        status.note(`${member.name}'s mind: ${Object.keys(update).join(', ')}`);
    }
    // Level a companion up or down when the player asked for it.
    for (const [name, level] of Object.entries(t.level_change || {})) {
        const member = meta.party.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (member) await levelUp(c, member, level, status);
    }
    refreshStandingPrompt();
    saveDoc('world');

    // What the player sees, in order.
    if (t.ooc) await postOoc(t.ooc);
    if (t.narration) {
        const id = await postNarration(t.narration);
        if (newScene && id !== null) await markSceneStart(id);
        voiceLine({ kind: 'dm', text: t.narration });
    } else if (newScene) {
        await markSceneStart(ST.chat.findLastIndex(m => !m.is_system));
    }
    // A fight is on but the player hasn't rolled initiative yet: nobody acts before that. Anyone's
    // rolls the DM sent anyway wait (the DM runs them in order once the player's number is in).
    if (world.combat && !world.combat.order.some(o => o.name === meta.persona.name)) {
        if (t.npc_rolls.length) { status.note(`Held back ${t.npc_rolls.length} roll(s): initiative first`); t.npc_rolls = []; }
        if (t.player_roll?.kind !== 'initiative') t.player_roll = { kind: 'initiative', skill: 'Initiative', ability: 'DEX', die: 20, dc: null, advantage: 'none', reason: 'The fight is on: roll initiative. Nobody acts until you have.', damage: '', half: false, bonus: null, spot: null };
    }
    // Who has noticed whom, when the DM says so outright.
    if (t.noticed) {
        const seen = applyNoticed(world, t.noticed);
        if (seen.length) status.note(seen.join('; '));
        const here = currentPlace(c);
        if (here) { for (const [seer, list] of Object.entries(t.noticed)) for (const n of [].concat(list ?? [])) markNoticed(here.place, seer, String(n), true); savePlace(here.key, c); }
    }
    if (initiativeCard) await postDiceCard(initiativeCard, { combat: true });
    if (changeLog.length) await postDiceCard(`📜 ${changeLog.join(' · ')}`, { state: true });

    // Companion/NPC/enemy rolls: code-rolled, shown openly WITH what happened.
    const outcomesBySpeaker = {};
    for (const r of t.npc_rolls) {
        if (signal.aborted) throw new Error('aborted');
        const result = roll(r.notation);
        if (!result) continue;
        // An attack always lands on someone and always does damage: who it's at (named, or read from
        // its own words), against their AC when the DM left it out, with the DM's dice or the attacker's.
        if (r.kind === 'attack') {
            r.target = attackTarget(c, r);
            if (r.dc === null && r.target) r.dc = armorOf(c, r.target);
            if (!r.damage) r.damage = attackDice(c, r);
        }
        const judged = judge(result.total, r.dc, result.natural, r.kind);
        let damageText = '';
        if (r.kind === 'attack' && judged.success && r.damage && r.target) {
            let dmg = roll(r.damage);
            if (dmg && judged.critical) {
                const extra = roll(r.damage.replace(/[+-]\s*\d+\s*$/, ''));
                if (extra) dmg = { ...dmg, total: dmg.total + extra.total, detail: `${dmg.detail} + crit ${extra.detail}` };
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
            noteSeen(world, r.spot.seer, r.spot.seen, noticed);
            const here = currentPlace(c);
            if (here && markNoticed(here.place, r.spot.seer, r.spot.seen, noticed)) savePlace(here.key, c);
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
        // Caught in a trap: a save that works gets them loose.
        const caughtWho = r.kind === 'save' ? matchName(r.who, [meta.persona.name, ...meta.party.map(p => p.name)]) : null;
        if (caughtWho && judged.success === true && trappedIn(c, caughtWho) && freeFromTrap(c, caughtWho)) damageText += ' · gets loose!';
        const mark = judged.success === true ? '✔' : judged.success === false ? '✘' : '';
        const vs = r.dc !== null ? ` vs ${r.kind === 'attack' ? 'AC' : 'DC'} ${r.dc}` : '';
        const nat = result.natural === 20 ? ' (natural 20!)' : result.natural === 1 ? ' (natural 1)' : '';
        const card = `🎲 **${r.who}** · ${r.what}: ${result.detail} = **${result.total}** ${mark}${vs}${nat}${damageText}${outcomeText(r, judged)}`;
        await postDiceCard(card, { roll: { ...r, total: result.total, natural: result.natural, success: judged.success } });
        if (r.kind === 'attack') playAnim(matchName(r.who, Object.keys(world.combat?.positions || {})) ?? r.who, 'attack');
        c.docs.rolls_log.push({ at: new Date().toISOString(), who: r.who, what: r.what, notation: r.notation, total: result.total, natural: result.natural, dc: r.dc, success: judged.success });
        if (/perception|investigation|search/i.test(r.what || '')) {
            const searcher = matchName(r.who, [meta.persona.name, ...meta.party.map(p => p.name)]);
            const search = searcher ? searchForTraps(c, searcher, result.total) : null;
            if (search?.found.length) { await postNote(`⚠️ ${searcher} spots: ${search.found.join(', ')}.`); refreshMap(); }
        }
        const outcome = judged.success === false ? r.on_fail : r.on_success;
        if (outcome) {
            const key = matchName(r.who, [...meta.party.map(p => p.name), ...c.docs.npcs.map(n => n.name)]) || r.who;
            outcomesBySpeaker[key] = `${outcomesBySpeaker[key] ? outcomesBySpeaker[key] + ' ' : ''}Your ${r.what} ${judged.success === false ? 'failed' : 'worked'}: ${outcome}`;
        }
    }
    if (t.npc_rolls.length) {
        saveDoc('rolls_log');
        saveDoc('world');
    }
    if (mapChanged && (world.combat || world.sceneMap || currentPlace(c))) {
        if (t.start_combat || (t.scene_map && typeof t.scene_map === 'object')) openMap();
        else refreshMap();
    }
    // Leaving a place, going back to one that's already built.
    if (t.leave_place) leavePlace(c);
    if (t.enter_place && !t.build_place) {
        const entry = atlasEntry(t.enter_place, c);
        // Already there (the DM named it again): nobody moves, the map stays as it is.
        const here = currentPlace(c);
        const already = here && (here.key === entry?.key || here.place.parent?.key === entry?.key);
        if (entry && !already) await enterPlace(entry.key, { quiet: true }).catch(error => status.note(`Couldn't open ${t.enter_place}: ${error.message}`));
    }

    // Someone still on their way in whom the DM has speaking now has arrived.
    const hereNow = currentPlace(c);
    if (hereNow) {
        for (const d of t.directions) {
            const g = personByName(hereNow.place, d.speaker);
            if (!g || g.intent !== 'goto' || !g.goal) continue;
            const spot = openSquareNear(hereNow.place, g.floor, g.goal.x, g.goal.y, new Set(Object.values(hereNow.place.state.positions).filter(p => p.floor === g.floor).map(p => `${p.x},${p.y}`)));
            if (spot) Object.assign(g, spot, { room: roomAt(hereNow.place, g.floor, spot.x, spot.y)?.id ?? g.room });
            delete g.goal; delete g.intent;
        }
    }
    // Companions and NPCs speak, in order, each with only their brief. Away companions stay silent.
    for (const d of t.directions) {
        if (signal.aborted) throw new Error('aborted');
        const speaker = d.speaker;
        const deadNpc = (c.docs.npcs || []).find(n => n.dead && nameKey(n.name) === nameKey(speaker));
        if (deadNpc) {
            status.note(`${deadNpc.name} is dead`);
            continue;
        }
        if (isAway(world, speaker)) {
            status.note(`${speaker} isn't with you right now`);
            continue;
        }
        const extra = outcomesBySpeaker[matchName(speaker, Object.keys(outcomesBySpeaker)) ?? ''] ?? '';
        // In a fight, or while just exploring (nobody talking to them): one short line.
        const length = meta.pacing.inCombat || quiet ? 'short' : d.length;
        const step = status.step(`${speaker} is responding`);
        try {
            await makeSpeak(speaker, [d.direction, extra].filter(Boolean).join(' '), { signal, length });
            step.done();
            await companionMovesOnMap(c, speaker, status, signal);
        } catch (error) {
            step.fail(error);
        }
    }

    // The player's roll request comes last so it's the final thing on screen.
    if (t.player_roll) {
        const pr = t.player_roll;
        if (pr.kind === 'damage') pr.die = 100;
        // "Roll damage" with nothing to roll: the dice come from the sheet (doubled after a natural 20).
        if (pr.kind === 'damage' && !pr.damage) {
            const lastHit = [...c.docs.rolls_log].reverse().find(r => r.who === meta.persona.name && r.kind === 'attack');
            pr.damage = attackDamage(statsForName(meta.persona.name, meta), `${pr.reason} ${pr.skill}`, { critical: lastHit?.natural === 20 });
            if (pr.damage) status.note(`Damage dice from the sheet: ${pr.damage}`);
        }
        if (pr.kind === 'initiative') pr.dc = null;
        meta.pendingRoll = pr;
        const adv = pr.advantage && pr.advantage !== 'none' ? ` (with **${pr.advantage}**: roll two d20, keep the ${pr.advantage === 'advantage' ? 'higher' : 'lower'})` : '';
        const what = pr.kind === 'damage'
            ? `roll damage **${pr.damage || 'for your hit'}** and type the total`
            : `roll a **d${pr.die || 20}** for **${pr.skill}${pr.ability ? ` (${pr.ability})` : ''}**${adv} and type the number you rolled`;
        const auto = settings().autoReadDice !== false ? ' (or roll with SillyTavern\'s dice: it\'s read automatically)' : '';
        await postDiceCard(`🎲 **${meta.persona.name}**, ${what}${auto}.${pr.reason ? `\n*${pr.reason}*` : ''}`, { request: pr });
        // Dice rolled from here on are read automatically (dicewatch.js).
        pr.chatIndex = ST.chat.length;
    }
    saveMeta();
    // A new map: asks first for big ones, plays the building animation, then opens it.
    if (t.build_place) {
        try {
            await requestBuild(t.build_place, { status, signal });
        } catch (error) {
            status.note(`Map not built: ${error.message}`);
            toastr.error(String(error?.message || error), 'Dungeon Master');
        }
    }
}

/** Opening scene after the wizard built the campaign. */
export async function runOpening(opening) {
    const c = campaign();
    if (!c) return;
    // A message sent during the opening waits for it, like during any turn.
    running = true;
    const status = beginTurn('Opening scene');
    try {
        await applyDmTurn(c, opening, status, new AbortController().signal, { reasons: ['opening'] });
        status.finish('The adventure begins');
    } catch (error) {
        console.error(error);
        status.finish('Opening had a problem');
        toastr.error(String(error?.message || error), 'Dungeon Master');
    } finally {
        running = false;
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

export { dmType };
