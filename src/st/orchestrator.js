// The turn loop: what happens after the player sends a message.
// 1) triage (code, then the local helper)  2) dice  3) maybe a random event
// 4) DM (Claude) only if needed  5) actors reply  6) bookkeeping.

import { ST } from './st.js';
import { settings, currentSpend, modelFor } from './settings.js';
import { campaign, saveMeta, saveDoc } from './campaign.js';
import { callLocal, BudgetError } from './llm.js';
import { askDm, maybeCondenseNotes, resetStableCache } from './dm.js';
import { modelLabel } from '../core/models.js';
import { rotateIdleNpcs, removeNpcsFromGroup, touchNpc } from './npccards.js';
import { withDmThinking } from '../ui/thinking.js';
import { makeSpeak, refreshStandingPrompt, speakerCandidates, markSceneStart } from './actors.js';
import { postNarration, postOoc, postPlayerOoc, postDiceCard, postNote, dmType } from './messages.js';
import { statsForName, levelCharacterSheet } from './sheets.js';
import { pickNpcVoice, voiceLine, stopVoices } from './voices.js';
import { normalizeMap, applyPositions, placeMissing, placeNear, parseCoord, toCoord, clampMove, speedSquares } from '../core/grid.js';
import { applyPlaceChanges, floorById, roomAt, computeVisible, placePerson, personByName, adoptStrays, openSquareNear } from '../core/explore.js';
import { requestBuild, enterPlace, leavePlace, currentPlace, savePlace, atlasEntry, tickPlace, partyOnMap, look, takeMapAction, goTargets, companionGoTo, searchForTraps, takeTrapEvents } from './atlas.js';
import { openMap, refreshMap, closeMap, playAnim } from '../ui/map.js';
import { beginTurn } from '../ui/status.js';
import { ruleTriage, helperTriagePrompt, parseHelperTriage, companionActionPrompt, parseCompanionAction } from '../core/triage.js';
import { tickPlayerTurn, dmReasons, applyDmPacing, updateFun, isFillerMessage } from '../core/pacing.js';
import { eventChance, eligibleEvents, pickEvent, guessSetting, normalizeEvent } from '../core/deck.js';
import { roll, judge, formatModifier, random01 } from '../core/dice.js';
import { applyStateChanges, addNpcs, startCombat, addToInitiative, endCombat, lookupModifier, changeHp, worldFlags, ensureParty, applyPresence, isAway } from '../core/world.js';
import { budgetStatus, formatUsd } from '../core/budget.js';
import { matchName, nameKey, trimToTokens } from '../core/text.js';
import { applySceneCard, pushTimeline, applyTableRules } from '../core/state.js';

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
    try {
        await turnBody(c, opts, status, controller.signal);
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
                const places = c.docs.world.combat || !helpers.length ? [] : goTargets(c, helpers[0]);
                const { system, user } = helperTriagePrompt({
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
    let placeEvent = [opts.placeEvent, ...takeTrapEvents()].filter(Boolean).join(' ');
    // The player picked something on the map (smash the bookshelf, pry the bars): the DM rules on it.
    const picked = !autoRoll ? takeMapAction() : '';
    if (picked) placeEvent = [picked, placeEvent].filter(Boolean).join(' ');
    if (!opts.force && !autoRoll && !pacing.inCombat) {
        const spotted = tickPlace(c);
        if (spotted.length) placeEvent = `${spotted.map(g => `${g.name} (${g.description || 'a guard'})`).join(' and ')} ${spotted.length > 1 ? 'come' : 'comes'} into view nearby. Decide whether they notice the party and what they do.`;
    }

    // A companion was told to do something: they walk there now, in the background, while the DM
    // (if the result needs deciding) works out what they find. Their reply waits for both.
    let taskWalk = null, taskWent = '';
    if (triage.task?.go && !signal.aborted) {
        const { who, go } = triage.task;
        taskWalk = companionGoTo(c, who, go).then(went => { taskWent = went; if (went) status.note(`${who} goes to the ${went}`); }).catch(() => { });
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
                companionTask: triage.task?.dm ? { name: triage.task.who, what: triage.task.what, went: triage.task.go ? goTargets(c, triage.task.who).find(p => p.id === triage.task.go)?.name ?? '' : '' } : null,
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
        await applyDmTurn(c, result.turn, status, signal, { events, reasons });
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
            const { system, user } = companionActionPrompt({ name, message: trimToTokens(msg.mes, 500), scene: `${c.docs.world.location || 'unknown'}; ${c.meta.standing || ''}`, places });
            attempt = parseCompanionAction(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 100, profileId: s.helperProfileId }), places);
        } catch {
            continue;
        }
        if (attempt.go && !signal.aborted) {
            const went = await companionGoTo(c, name, attempt.go, { hide: attempt.hide });
            if (went) status.note(attempt.hide ? `${name} hides ${went}` : `${name} goes to the ${went} and stays there`);
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
    if (!places.length) return;
    const msg = [...ST.chat].reverse().find(m => !m.is_user && m.name === name);
    if (!msg?.mes) return;
    try {
        const { system, user } = companionActionPrompt({ name, message: trimToTokens(msg.mes, 500), scene: c.docs.world.location || '', places, askAttempt: false });
        const { go, hide } = parseCompanionAction(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 60, profileId: s.helperProfileId }), places);
        if (!go || signal.aborted) return;
        const went = await companionGoTo(c, name, go, { hide });
        if (went) status.note(hide ? `${name} hides ${went}` : `${name} goes to the ${went} and stays there`);
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
    const search = pr.kind !== 'damage' && /perception|investigation|search/i.test(`${pr.skill} ${pr.reason || ''}`) ? searchForTraps(c, meta.persona.name, total) : null;
    if (search?.found.length) { await postNote(`⚠️ Searching ${search.room}, ${meta.persona.name} spots: ${search.found.join(', ')}.`); refreshMap(); }
    const searchText = search ? ` Searching ${search.room} with that roll, the code revealed: ${search.found.length ? search.found.join(', ') : 'no traps'} (traps the roll didn't beat stay hidden; say nothing about them).` : '';
    if (pr.kind === 'damage') return `${meta.persona.name} rolled ${total} damage for: ${pr.reason || pr.skill}. Apply it (state_changes.hp) and narrate.`;
    return searchText + `${meta.persona.name} rolled ${natural ?? '?'} on the d${pr.die || 20} ${formatModifier(mod)} (${source}) = ${total}${pr.dc !== null ? ` vs hidden DC ${pr.dc}: ${judged.success ? 'SUCCESS' : 'FAILURE'}` : ''}${natural === 20 ? ' (natural 20)' : natural === 1 ? ' (natural 1)' : ''}. Roll was for: ${pr.reason || pr.skill}.${pr.kind === 'attack' && judged.success && pr.damage ? ` On a hit, ask the player to roll damage (${pr.damage}) with player_roll kind "damage".` : ''}`;
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

export async function applyDmTurn(c, t, status, signal, { events = [], reasons = [] } = {}) {
    const meta = c.meta;
    const world = c.docs.world;

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
    if (t.scene) {
        if (t.scene.location) world.location = t.scene.location;
        if (t.scene.setting) world.setting = guessSetting(world.location, t.scene.setting);
        if (t.scene.time) {
            if (/morning|dawn/.test(t.scene.time) && /night|evening/.test(world.time || '')) world.day = (world.day || 1) + 1;
            world.time = t.scene.time;
        }
    }
    // A new place: the old scene card no longer applies. A new scene: NPCs forget the last one.
    const newPlace = Boolean(t.scene?.location && prevLocation && nameKey(t.scene.location) !== nameKey(prevLocation));
    const newScene = newPlace || Boolean(t.scene?.changed);
    world.sceneCard = applySceneCard(world.sceneCard, t.scene_card, { newPlace, partyNames: [meta.persona.name, ...meta.party.map(p => p.name)] });
    // Who split off from the player, and who is back.
    applyPresence(world, meta.party.map(p => p.name), t.party_away, t.party_back);
    // NPCs who get briefs are "here".
    for (const d of t.directions) {
        const npc = c.docs.npcs.find(n => nameKey(n.name) === nameKey(d.speaker));
        if (npc) npc.lastSeen = world.location;
    }

    // State, combat, pacing, plot.
    const changeLog = applyStateChanges(world, t.state_changes, c.meta.party.map(p => p.name));
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
        const companions = meta.party.map(p => ({ name: p.name, stats: statsForName(p.name, meta) }));
        const combat = startCombat(world, t.start_combat, companions);
        // Inside a place the fight is always on the place's own map, where everyone already stands
        // (never a new battle map). Elsewhere: a mapped room becomes the battle map unless the DM sent one.
        const here = currentPlace(c);
        const roomMap = !here && !t.start_combat.map && world.sceneMap?.map ? world.sceneMap : null;
        if (here) {
            const floorId = here.place.state.positions[meta.persona.name]?.floor ?? here.place.state.floor;
            combat.map = JSON.parse(JSON.stringify(floorById(here.place, floorId).map));
            combat.inPlace = { key: here.key, floor: floorId };
            combat.positions = Object.fromEntries(Object.entries(here.place.state.positions).filter(([, p]) => p.floor === floorId).map(([n, p]) => [n, toCoord(p.x, p.y)]));
            // The place's people on this floor join the board where they stand: the enemies among
            // them, and anyone the party can see (bystanders stay on the map during the fight).
            const seen = computeVisible(here.place, floorId, Object.values(here.place.state.positions).filter(p => p.floor === floorId));
            const foeKeys = new Set(Object.keys(combat.enemies || {}).map(nameKey));
            for (const g of Object.values(here.place.guards)) {
                if (g.state === 'gone' || g.floor !== floorId) continue;
                if (foeKeys.has(nameKey(g.name)) || seen[g.y * combat.map.w + g.x]) combat.positions[g.name] = toCoord(g.x, g.y);
            }
        } else {
            combat.map = roomMap ? roomMap.map : normalizeMap(t.start_combat.map || {});
            combat.positions = roomMap ? { ...(roomMap.positions || {}) } : {};
        }
        mapChanged = true;
        initiativeCard = `⚔️ **Initiative**\n${combat.order.map(o => `- ${o.name}: **${o.init}**`).join('\n')}\n*(${meta.persona.name}: roll your own initiative when asked)*`;
    }
    if (world.combat?.map) {
        const friends = [meta.persona.name, ...meta.party.map(p => p.name)];
        const foes = Object.keys(world.combat.enemies || {});
        // The party moves at most their speed each round (twice that when dashing), around walls.
        const moves = { ...(t.positions || {}) };
        for (const name of [meta.persona.name, ...meta.party.map(p => p.name)]) {
            const from = parseCoord(world.combat.positions?.[name], world.combat.map), to = parseCoord(moves[name], world.combat.map);
            if (!from || !to || t.start_combat) continue;
            const others = new Set(Object.entries(world.combat.positions || {}).filter(([n]) => n !== name).map(([, cd]) => parseCoord(cd, world.combat.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
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
        // Downed enemies leave the board.
        for (const [name, e] of Object.entries(world.combat.enemies || {})) {
            if (e.hp <= 0) delete world.combat.positions[name];
        }
        if (rejected.length) console.warn('[Dungeon Master] Ignored invalid map moves:', rejected);
        mapChanged = true;
    }
    // Each DM combat turn is a new round (a roll's result finishes the round it was asked in).
    if (world.combat && !t.start_combat && reasons.includes('combat_round') && !reasons.includes('roll_result')) {
        world.combat.round = (world.combat.round || 1) + 1;
    }
    if (t.end_combat && world.combat?.inPlace) {
        // Back to exploring: the party stays where the fight left them.
        const here = currentPlace(c);
        if (here) {
            const floorId = world.combat.inPlace.floor, map = floorById(here.place, floorId).map;
            const party = new Set([meta.persona.name, ...meta.party.map(p => p.name)].map(nameKey));
            for (const name of partyOnMap(c)) {
                const pt = parseCoord(world.combat.positions?.[name], map);
                if (pt) here.place.state.positions[name] = { floor: floorId, x: pt.x, y: pt.y };
            }
            for (const [name, e] of Object.entries(world.combat.enemies || {})) {
                const g = personByName(here.place, name);
                if (e.hp <= 0) { if (g) g.state = 'gone'; continue; }
                const pt = parseCoord(world.combat.positions?.[name], map);
                if (pt) placePerson(here.place, name, { floor: floorId, x: pt.x, y: pt.y }, { info: { hostile: true } });
            }
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
            const log = applyPlaceChanges(place, t.place_changes, { floor: floorId });
            if (log.length) status.note(`Map: ${log.join(', ')}`);
        }
        if (!world.combat) {
            const map = floorById(place, floorId).map;
            const missed = [];
            for (const [name, coord] of Object.entries(t.positions || {})) {
                if (coord === null || /^(gone|removed|dead|fled|left)$/i.test(String(coord))) {
                    const g = personByName(place, name);
                    if (g) g.state = 'gone';
                    continue;
                }
                const member = partyNames.find(n => nameKey(n) === nameKey(name));
                if (member) {
                    const pt = parseCoord(coord, map);
                    const spot = pt && openSquareNear(place, floorId, pt.x, pt.y);
                    if (spot) { place.state.positions[member] = { floor: floorId, ...spot }; if (place.state.hidden?.[member]) delete place.state.hidden[member]; }
                    else missed.push(`${name} → ${coord}`);
                    continue;
                }
                const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
                const info = { description: npc ? [npc.role, npc.description].filter(Boolean).join('. ') : '', hostile: npc?.attitude === 'hostile', gender: npc?.gender };
                if (!placePerson(place, npc?.name ?? name, coord, { floor: floorId, info })) missed.push(`${name} → ${coord}`);
            }
            if (missed.length) status.note(`Couldn't place on the map: ${missed.join(', ')}`);
        }
        look(c, key, place);
        savePlace(key, c);
        mapChanged = true;
    }
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
    if (initiativeCard) await postDiceCard(initiativeCard, { combat: true });
    if (changeLog.length) await postDiceCard(`📜 ${changeLog.join(' · ')}`, { state: true });

    // Companion/NPC/enemy rolls: code-rolled, shown openly WITH what happened.
    const outcomesBySpeaker = {};
    for (const r of t.npc_rolls) {
        if (signal.aborted) throw new Error('aborted');
        const result = roll(r.notation);
        if (!result) continue;
        const judged = judge(result.total, r.dc, result.natural, r.kind);
        let damageText = '';
        if (r.kind === 'attack' && judged.success && r.damage && r.target) {
            let dmg = roll(r.damage);
            if (dmg && judged.critical) {
                const extra = roll(r.damage.replace(/[+-]\s*\d+\s*$/, ''));
                if (extra) dmg = { ...dmg, total: dmg.total + extra.total, detail: `${dmg.detail} + crit ${extra.detail}` };
            }
            if (dmg) {
                const line = changeHp(world, r.target, -dmg.total, [...meta.party.map(p => p.name), meta.persona.name]);
                damageText = ` · **${dmg.total}** damage${line ? ` (${line})` : ''}`;
            }
        }
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
        if (entry) await enterPlace(entry.key, { quiet: true }).catch(error => status.note(`Couldn't open ${t.enter_place}: ${error.message}`));
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
        const length = meta.pacing.inCombat ? 'short' : d.length;
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
        if (rerunRequested) {
            rerunRequested = false;
            setTimeout(() => runTurn(), 50);
        }
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
