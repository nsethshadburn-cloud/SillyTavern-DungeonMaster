// The turn loop: what happens after the player sends a message.
// 1) triage (code, then the local helper)  2) dice  3) maybe a random event
// 4) DM (Claude) only if needed  5) actors reply  6) bookkeeping.

import { ST } from './st.js';
import { settings, currentSpend, modelFor } from './settings.js';
import { campaign, saveMeta, saveDoc } from './campaign.js';
import { callLocal, BudgetError } from './llm.js';
import { askDm, maybeCondenseNotes, resetStableCache } from './dm.js';
import { modelLabel } from '../core/models.js';
import { makeSpeak, refreshStandingPrompt, speakerCandidates } from './actors.js';
import { postNarration, postOoc, postDiceCard, postNote, dmType } from './messages.js';
import { statsForName } from './sheets.js';
import { pickNpcVoice, voiceLine, stopVoices } from './voices.js';
import { normalizeMap, applyPositions, placeMissing } from '../core/grid.js';
import { openMap, refreshMap, closeMap } from '../ui/map.js';
import { beginTurn } from '../ui/status.js';
import { ruleTriage, helperTriagePrompt, parseHelperTriage } from '../core/triage.js';
import { tickPlayerTurn, dmReasons, applyDmPacing, updateFun, isFillerMessage } from '../core/pacing.js';
import { eventChance, eligibleEvents, pickEvent, guessSetting, normalizeEvent } from '../core/deck.js';
import { roll, judge, formatModifier, random01 } from '../core/dice.js';
import { applyStateChanges, addNpcs, startCombat, addToInitiative, endCombat, lookupModifier, changeHp, worldFlags, ensureParty, applyPresence, isAway } from '../core/world.js';
import { budgetStatus, formatUsd } from '../core/budget.js';
import { matchName, nameKey, trimToTokens } from '../core/text.js';

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
 * @param {{force?: string|null, oocText?: string}} opts force = a reason to call the DM regardless
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
        if (rerunRequested) {
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
                const { system, user } = helperTriagePrompt({
                    player: meta.persona.name,
                    message: trimToTokens(playerText, 500),
                    recent: recentForHelper(),
                    speakers: candidates,
                    scene: `${c.docs.world.location || 'unknown'}; ${meta.standing || ''}`,
                    away: Object.entries(c.docs.world.away ?? {}).map(([n, where]) => `${n} (${where})`),
                });
                const raw = await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: Number(s.helperMaxTokens) || 160, profileId: s.helperProfileId });
                const h = parseHelperTriage(raw, candidates);
                if (!rule.category) triage.category = h.category;
                triage.stalled = h.stalled;
                triage.speakers = h.speakers;
                triage.helperChoseSpeakers = true;
                engaged = h.engaged;
                // Who is the player talking to? A known NPC answers locally; a stranger needs the DM.
                if (h.addressed && !/^(dm|dungeon master|narrator|everyone|nobody|none)$/i.test(h.addressed)) {
                    const npcNames = (c.docs.npcs || []).map(n => n.name);
                    const known = matchName(h.addressed, [...meta.party.map(p => p.name), ...npcNames, meta.persona.name]);
                    if (!known) triage.unknownAddressee = h.addressed;
                    else if (npcNames.includes(known)) triage.speakers = [known, ...triage.speakers.filter(s => s !== known)].slice(0, 2);
                }
                step.done(`${triage.category}${triage.unknownAddressee ? ` · talking to ${triage.unknownAddressee} (new)` : ''}${triage.speakers.length ? ` → ${triage.speakers.join(', ')}` : ''}`);
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
            tickPlayerTurn(pacing, meta.options.length, { filler: !triage.ooc && isFillerMessage(playerText, engaged) });
        }
    }
    if (signal.aborted) throw new Error('aborted');

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
            result = await askDm({
                reasons,
                playerMessage: playerText,
                rollResolution,
                events,
                oocText: opts.oocText || triage.oocText || '',
            }, { signal, model });
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
        await applyDmTurn(c, result.turn, status, signal, { events });
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
        await localReplies(c, triage, playerText, status, signal);
        meta.stats.localTurns = (meta.stats.localTurns || 0) + 1;
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

/** No DM this turn: the right character(s) answer locally. */
async function localReplies(c, triage, playerText, status, signal) {
    const speakers = localSpeakers(c, triage, playerText);
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
    c.docs.rolls_log.push({ at: new Date().toISOString(), who: meta.persona.name, what: pr.skill, kind: pr.kind, natural, mod, total, dc: pr.dc, success: judged.success });
    saveDoc('rolls_log');
    if (pr.kind === 'initiative' && c.docs.world.combat) {
        addToInitiative(c.docs.world, meta.persona.name, total);
        saveDoc('world');
    }
    status.note(`You rolled ${total}${mark ? ` ${mark}` : ''}`);
    if (pr.kind === 'damage') return `${meta.persona.name} rolled ${total} damage for: ${pr.reason || pr.skill}. Apply it (state_changes.hp) and narrate.`;
    return `${meta.persona.name} rolled ${natural ?? '?'} on the d${pr.die || 20} ${formatModifier(mod)} (${source}) = ${total}${pr.dc !== null ? ` vs hidden DC ${pr.dc}: ${judged.success ? 'SUCCESS' : 'FAILURE'}` : ''}${natural === 20 ? ' (natural 20)' : natural === 1 ? ' (natural 1)' : ''}. Roll was for: ${pr.reason || pr.skill}.${pr.kind === 'attack' && judged.success && pr.damage ? ` On a hit, ask the player to roll damage (${pr.damage}) with player_roll kind "damage".` : ''}`;
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
export async function applyDmTurn(c, t, status, signal, { events = [] } = {}) {
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
    if (t.scene) {
        if (t.scene.location) world.location = t.scene.location;
        if (t.scene.setting) world.setting = guessSetting(world.location, t.scene.setting);
        if (t.scene.time) {
            if (/morning|dawn/.test(t.scene.time) && /night|evening/.test(world.time || '')) world.day = (world.day || 1) + 1;
            world.time = t.scene.time;
        }
    }
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
    if (t.start_combat && !world.combat) {
        const companions = meta.party.map(p => ({ name: p.name, stats: statsForName(p.name, meta) }));
        const combat = startCombat(world, t.start_combat, companions);
        combat.map = normalizeMap(t.start_combat.map || {});
        combat.positions = {};
        mapChanged = true;
        initiativeCard = `⚔️ **Initiative**\n${combat.order.map(o => `- ${o.name}: **${o.init}**`).join('\n')}\n*(${meta.persona.name}: roll your own initiative when asked)*`;
    }
    if (world.combat?.map) {
        const friends = [meta.persona.name, ...meta.party.map(p => p.name)];
        const foes = Object.keys(world.combat.enemies || {});
        const { positions, rejected } = applyPositions(world.combat.map, world.combat.positions, t.positions);
        world.combat.positions = placeMissing(world.combat.map, placeMissing(world.combat.map, positions, friends, 'party'), foes, 'enemy');
        // Downed enemies leave the board.
        for (const [name, e] of Object.entries(world.combat.enemies || {})) {
            if (e.hp <= 0) delete world.combat.positions[name];
        }
        if (rejected.length) console.warn('[Dungeon Master] Ignored invalid map moves:', rejected);
        mapChanged = true;
    }
    if (t.end_combat && world.combat) {
        endCombat(world);
        closeMap();
        status.note('Combat over');
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
    if (t.standing_direction) meta.standing = t.standing_direction;
    if (t.objective) meta.objective = t.objective;
    refreshStandingPrompt();
    saveDoc('world');

    // What the player sees, in order.
    if (t.ooc) await postOoc(t.ooc);
    if (t.narration) {
        await postNarration(t.narration);
        voiceLine({ kind: 'dm', text: t.narration });
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
        const card = r.hidden
            ? `🎲 Someone rolls in secret…`
            : `🎲 **${r.who}** · ${r.what}: ${result.detail} = **${result.total}** ${mark}${vs}${nat}${damageText}${outcomeText(r, judged)}`;
        await postDiceCard(card, { roll: { ...r, total: result.total, natural: result.natural, success: judged.success } });
        c.docs.rolls_log.push({ at: new Date().toISOString(), who: r.who, what: r.what, notation: r.notation, total: result.total, natural: result.natural, dc: r.dc, success: judged.success });
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
    if (mapChanged && world.combat) {
        if (t.start_combat) openMap();
        else refreshMap();
    }

    // Companions and NPCs speak, in order, each with only their brief. Away companions stay silent.
    for (const d of t.directions) {
        if (signal.aborted) throw new Error('aborted');
        const speaker = d.speaker;
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
}

/** Opening scene after the wizard built the campaign. */
export async function runOpening(opening) {
    const c = campaign();
    if (!c) return;
    const status = beginTurn('Opening scene');
    try {
        const t = opening;
        await applyDmTurn(c, t, status, new AbortController().signal);
        status.finish('The adventure begins');
    } catch (error) {
        console.error(error);
        status.finish('Opening had a problem');
        toastr.error(String(error?.message || error), 'Dungeon Master');
    }
}

/** Ask the DM directly (from /dm or the DM Screen). */
export async function askDmNow(text = '') {
    const c = campaign();
    if (!c) {
        toastr.info('No Dungeon Master campaign in this chat.', 'Dungeon Master');
        return;
    }
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
