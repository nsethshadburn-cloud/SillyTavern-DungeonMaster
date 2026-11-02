// Custody, live: the state machine (core/custody.js) on the map and in the chat, with a one-word
// referee (core/referee.js, a fast model) reading what the player's and the keeper's lines mean.
// The code owns the outcomes: who holds whom, the chase on the map, the grab and trip cards, the
// notes the player sees, the one-line events the DM gets. Nothing here guesses from prose.

import { ST } from './st.js';
import { campaign, saveDoc, saveMeta } from './campaign.js';
import { statsForName } from './sheets.js';
import { postNote, postDiceCard } from './messages.js';
import { callClaude } from './llm.js';
import { settings } from './settings.js';
import { REFEREE_MODEL, thinksByDefault } from '../core/models.js';
import { roll } from '../core/dice.js';
import { lookupModifier, conditionsOf, applyStateChanges, isAway } from '../core/world.js';
import { restraintOf } from '../core/restraints.js';
import { floorById, computeVisible, hiddenNow, standUp, personByName, setIntent, followSteps, doorAt, setDoorState, GUARD_SIGHT, EARSHOT } from '../core/explore.js';
import { outBy } from '../core/notice.js';
import { currentPlace, savePlace, lockedReason, setWaiting, codeRoll, droppedRoll, cancelPendingCard, passivePerceptionOf, stealthThisTurn, dangersFor } from './atlas.js';
import { normalizeRecord, newRecord, onPlayerVerdict, onKeeperVerdict, stepBefore, stepAfter, afterStep, onSlip, onGrab, onTrip, stumbleStep, freed, PLAYER_VERDICTS, KEEPER_VERDICTS, DEFAULT_RADIUS } from '../core/custody.js';
import { REFEREE_SYSTEM, playerLinePrompt, keeperLinePrompt, grabPrompt, parseWord } from '../core/referee.js';

const far = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEYS = new Set(['by', 'radius', 'mode', 'attempts', 'chase', 'lastGrabTurn', 'stumble']);

async function refresh() {
    const { refreshMap } = await import('../ui/map.js');
    refreshMap();
}

/** The player's custody here, tidied (older versions kept escorts, searches and grace turns): {cur, key, place, rec, player, kp, lead, companion} or null. */
function held(c) {
    const cur = currentPlace(c);
    if (!cur) return null;
    const { place } = cur;
    const player = c.meta.persona.name;
    const raw = place.state.custody?.[player];
    const rec = normalizeRecord(raw);
    if (!rec) return null;
    if (Object.keys(raw).some(k => !KEYS.has(k)) || raw.mode !== rec.mode) place.state.custody[player] = rec;
    return { cur, key: cur.key, place, rec: place.state.custody[player], player, kp: place.state.positions[rec.by] ?? personByName(place, rec.by), lead: place.state.positions[player], companion: c.meta.party.some(p => p.name === rec.by) };
}

function store(h, rec) {
    h.place.state.custody ??= {};
    h.place.state.custody[h.player] = rec;
    h.rec = rec;
}

function keeperOut(c, place, by) {
    return place.state.pose?.[by]?.pose === 'sleep' || outBy(conditionsOf(c.docs.world, by)) || Boolean(place.guards[by]?.down);
}

function keeperProne(c, by) {
    return conditionsOf(c.docs.world, by).some(x => /^prone\b/i.test(String(x)));
}

function boundWord(c, player) {
    const look = restraintOf(conditionsOf(c.docs.world, player)).look;
    return look === 'cuffs' ? ', cuffed' : look === 'rope' ? ', tied' : '';
}

/** Can the keeper see the player from where she stands (sight and light; hidden; a Stealth roll this turn when `stealth`)? */
function seesPlayer(c, place, lead, kp, player, by, { stealth = true } = {}) {
    const map = floorById(place, lead.floor).map;
    if (!computeVisible(place, lead.floor, [{ x: kp.x, y: kp.y }], { radius: GUARD_SIGHT })[lead.y * map.w + lead.x]) return false;
    if (hiddenNow(place, player)) return false;
    const st = stealth ? stealthThisTurn(c) : null;
    return !(st && st.total >= passivePerceptionOf(c, by));
}

/** Someone of the place (a jailer) goes after their prisoner: the guard chase does the rest (he follows, grabs when he reaches them, takes them back). */
function jailer(place, by, player, attempts) {
    const g = personByName(place, by);
    if (!g) return;
    setIntent(g, 'follow', player);
    g.seize = { target: player, asked: true, attempts: attempts ?? 0 };
    g.state = 'alert';
}

// ---------- the referee ----------

/** One word from a fast model. On any failure, the "nothing" answer: the code then does nothing, which is always safe. */
async function referee(kind, args, allowed, status = null) {
    const s = settings();
    if (s.referee === false) return allowed[allowed.length - 1];
    const user = kind === 'player' ? playerLinePrompt(args) : kind === 'keeper' ? keeperLinePrompt(args) : grabPrompt(args);
    // Haiku 4.5 by default: it answers without thinking first. A Claude 5 model thinks before it answers
    // and SillyTavern can't tell it not to, so it gets room for the thought (and is slower for it).
    const model = s.taskModels?.referee || REFEREE_MODEL;
    try {
        const { text, ms } = await callClaude({ system: REFEREE_SYSTEM, user, model, maxTokens: thinksByDefault(model) ? 400 : 8, effort: 'auto', label: `referee (${kind})` });
        const word = parseWord(text, allowed);
        status?.note(`Referee: ${word} (${ms} ms)`);
        return word;
    } catch (error) {
        console.warn('[Dungeon Master] referee failed', error);
        status?.note(`Referee failed (${kind}): ${String(error?.message || error).slice(0, 120)}`);
        return allowed[allowed.length - 1];
    }
}

// ---------- the player's words ----------

/**
 * The player's message, in a custody scene: the referee says whether they run, ask her along, give
 * in, or try to trip her, and the code does it. With no custody (or an aside to the DM), the only
 * thing read is a companion grabbing for them. Returns the event for the DM, or ''.
 */
export async function custodyOnPlayerText(c, text, { ooc = false, status = null } = {}) {
    if (!text || c.docs.world.combat) return '';
    const h = held(c);
    const card = h ? pendingCustodyCard(c, h.rec.by) : null;
    if (codeRoll(c) && !card) return '';
    if (!h || ooc) return card ? '' : arrestFromText(c, text, status);
    const verdict = await referee('player', { keeper: h.rec.by, player: h.player, text, mode: h.rec.mode, chase: Boolean(h.rec.chase) }, PLAYER_VERDICTS, status);
    const { rec, event } = onPlayerVerdict(h.rec, verdict);
    if (card) {
        // Her grab (or his trip) is being rolled: giving in calls the roll off and she has him; any other word waits for the dice.
        if (verdict !== 'give') return '';
        cancelPendingCard(c);
        store(h, rec);
        savePlace(h.key, c);
        await postNote(`🎲 You give in: that roll is off. 🔒 ${rec.by} has you (stay within ${rec.radius} squares).`);
        refresh();
        return `${h.player} gives in to ${rec.by} (in their own words) while ${card.trip ? `their ${card.trip.what}` : 'her grab'} was being rolled: that roll is off, the chase is over and ${rec.by} has them. Narrate ${rec.by} taking hold of them and brief her; no roll.`;
    }
    if (event === 'trip') return tripKeeper(c, h, text);
    if (event === 'along') { await setMode(c, h, 'companion', `${h.player} asked ${h.rec.by} along`); return ''; }
    const wasChase = Boolean(h.rec.chase), wasMode = h.rec.mode;
    if (verdict === 'give') {
        store(h, rec);
        savePlace(h.key, c);
        if (wasMode !== 'guard' || wasChase) { await postNote(`🔒 You give in: ${rec.by} has you (stay within ${rec.radius} squares).`); refresh(); }
        return event === 'give' ? `${h.player} gives in to ${rec.by} (in their own words): the chase is off and ${rec.by} has them. Narrate ${rec.by} taking hold of them and brief her; no roll.` : '';
    }
    if (event === 'bolt') return bolt(c, h, rec);
    return '';
}

/** A grab or trip card of this keeper's still waiting for the player's roll, or null. */
function pendingCustodyCard(c, by) {
    const pr = c.meta.pendingRoll;
    return pr && !pr.autoResult && (pr.custody?.keeper === by || pr.trip?.keeper === by) ? pr : null;
}

/**
 * "I run": the chase starts now, by code. In her hands (grappled, pinned) it's wrenching against her
 * hold: the same card as a grab, and torn free the chase is on. A keeper beside them grabs at once (a
 * card); one further off runs after them.
 */
async function bolt(c, h, rec) {
    const { place, key, player, kp, lead } = h;
    if (!lead || !kp || kp.floor !== lead.floor) return '';
    const hold = conditionsOf(c.docs.world, player).find(x => /^(?:grappled|pinned)\b/i.test(String(x)));
    if (hold) {
        // Held by someone else, by a jailer, or a grab already rolled this turn: nothing to run from here.
        if (!h.companion || h.rec.lastGrabTurn === c.meta.turn || keeperOut(c, place, rec.by)) return '';
        if (/\bby\b/i.test(hold) && !new RegExp(`\\b${esc(rec.by.split(' ')[0])}\\b`, 'i').test(hold)) return '';
        store(h, rec);
        return grabCard(c, h, { wrench: true });
    }
    if (lockedReason(c, player)) return '';
    if (keeperOut(c, place, rec.by)) return `${player} makes a break while ${rec.by} is out of it: ${rec.by} notices nothing yet. Narrate the break; the map lets them go.`;
    if (!h.companion) { store(h, rec); jailer(place, rec.by, player, rec.attempts); savePlace(key, c); await postNote(`🔒 You run: ${rec.by} is after you.`); return `${player} says they run from ${rec.by}: the code runs the chase (${rec.by} follows and grabs when they reach them, with rolls). Narrate the break and ${rec.by}'s reaction; don't resolve it.`; }
    store(h, rec);
    await postNote(`🔒 You run: ${rec.by} is after you.`);
    if (place.state.waiting?.[rec.by]) await setWaiting(rec.by, false, { quiet: true });
    c.meta.stance ??= {}; c.meta.stance[rec.by] = 'close'; saveMeta();
    if (keeperProne(c, rec.by)) { await standsUp(c, h); return `${player} runs while ${rec.by} is on the ground: she gets up (no roll: her hands are free, but it costs her the turn) and ${player} gains ground. Narrate the break and brief ${rec.by}; the code runs the chase from here, don't ask for a roll.`; }
    const gap0 = far(lead, kp);
    runKeeperDown(c, place, lead.floor, rec.by, player, 4);
    const gap = far(lead, kp);
    if (gap <= 1 && h.rec.lastGrabTurn !== c.meta.turn) return grabCard(c, h);
    savePlace(key, c);
    refresh();
    return `${player} says they run from ${rec.by} (${gap0} squares off; ${rec.by} ran after them and is ${gap} squares off now): the code rolls the grab when ${rec.by} reaches them. Narrate the break and brief ${rec.by}; don't resolve the chase, and don't ask the player to roll for it.`;
}

// ---------- the keeper's words ----------

/** The keeper's own reply: "stay put" (guard mode) or "lead on" (companion mode, any chase called off), by the referee. */
export async function custodyOnKeeperReply(c, name, status = null) {
    const h = held(c);
    if (!h || h.rec.by !== name || !h.companion || c.docs.world.combat) return;
    const msg = [...ST.chat].reverse().find(m => !m.is_user && m.name === name);
    if (!msg?.mes) return;
    const verdict = await referee('keeper', { keeper: name, player: h.player, text: msg.mes, chase: Boolean(h.rec.chase) }, KEEPER_VERDICTS, status);
    const { rec, event } = onKeeperVerdict(h.rec, verdict);
    if (event) await setMode(c, h, rec.mode, `${name}'s words`);
}

/**
 * Set the mode, with the player told: 🔒 guard (a step beyond her radius is an escape), 🚶 companion
 * (she goes along; a chase is off, and a grab of hers still waiting for the roll is let go).
 */
export async function setMode(c, h, mode, why = '') {
    const rec = { ...h.rec, mode };
    if (mode === 'companion') {
        delete rec.chase; rec.attempts = 0;
        if (c.meta.pendingRoll?.custody?.keeper === rec.by) { cancelPendingCard(c); await postNote(`🎲 ${rec.by} lets go: that roll is off.`); }
    }
    const changed = rec.mode !== h.rec.mode || Boolean(h.rec.chase) !== Boolean(rec.chase);
    store(h, rec);
    savePlace(h.key, c);
    if (!changed) return false;
    await postNote(mode === 'guard' ? `🔒 ${rec.by} has you stay put${why ? ` (${why})` : ''}: a step beyond ${rec.radius} squares is an escape.` : `🚶 ${rec.by} goes along with you${why ? ` (${why})` : ''}: walk where you like; "I run" is the only run.`);
    refresh();
    return true;
}

/** The DM's op or anything else changed the mode by hand: the same notes. */
export async function setCustodyMode(c, player, mode, why = '') {
    const h = held(c);
    if (!h || h.player !== player || (mode !== 'guard' && mode !== 'companion')) return false;
    return setMode(c, h, mode, why);
}

// ---------- the map ----------

/** Where the player's keeper stands as a walk begins (null when nobody holds them, or they can't walk, or she's out of it). */
export function walkStart(c, place, player) {
    const rec = normalizeRecord(place.state.custody?.[player]);
    if (!rec || lockedReason(c, player)) return null;
    const kp = place.state.positions[rec.by] ?? personByName(place, rec.by);
    if (!kp || kp.state === 'gone' || kp.state === 'dead' || kp.down || outBy(conditionsOf(c.docs.world, rec.by))) return null;
    const me = place.state.positions[player];
    return { by: rec.by, x: kp.x, y: kp.y, floor: kp.floor, companion: c.meta.party.some(p => p.name === rec.by), prevGap: me ? far(me, kp) : null };
}

/** Does the keeper trail the player like a follower on a walk? Only when she's going along; guarding, she stays put, and chasing, the chase moves her. */
export function keeperFollows(place, player) {
    const rec = normalizeRecord(place.state.custody?.[player]);
    return !rec || (rec.mode === 'companion' && !rec.chase);
}

/**
 * One step of the player's walk. Mid-chase she runs a few squares for each of his and grabs when she
 * reaches him (a card); walking back into her reach is being caught; out of her sight, she's lost
 * him. In guard mode a step beyond her radius, in her sight, starts the chase. Returns the event
 * for the DM (which ends the walk), or '' to walk on.
 */
export async function onStep(c, cur, start, { runDown = null } = {}) {
    if (!start) return '';
    const h = held(c);
    if (!h || h.rec.by !== start.by) return '';
    const { place, key, player, kp, lead } = h;
    if (!lead || !kp || c.docs.world.combat || codeRoll(c) || kp.floor !== lead.floor || start.floor !== lead.floor || keeperOut(c, place, h.rec.by)) return '';
    const bound = boundWord(c, player);
    const prone = keeperProne(c, h.rec.by);
    const gap0 = far(lead, kp);
    const prevGap = start.prevGap ?? far(start, kp);
    if (stepBefore(h.rec, { gap: gap0, prevGap, keeperProne: prone }) === 'caught') {
        const rec = afterStep(h.rec, 'caught');
        store(h, rec); start.prevGap = gap0; savePlace(key, c);
        await postNote(`🔒 You walked back into ${rec.by}'s reach: caught. She has you (stay within ${rec.radius} squares).`);
        refresh();
        return `${player} walked back up to ${rec.by} mid-chase: caught, by the code (no roll); the chase is over and ${rec.by} has them again (GUARD mode). Narrate ${rec.by} taking hold of them and brief ${rec.by}.`;
    }
    // Mid-chase she runs: a few squares for each of his, so the chase can be seen. Off balance after a
    // missed grab, she stands for a few of his steps instead: that's the gap a slip buys.
    const recovering = Boolean(h.rec.chase && h.rec.stumble);
    if (recovering) store(h, stumbleStep(h.rec));
    if (h.rec.chase && h.companion && !prone && !recovering && runDown) runDown(3);
    const gap = far(lead, kp);
    start.prevGap = gap;
    const sees = seesPlayer(c, place, lead, kp, player, h.rec.by, { stealth: !h.rec.chase });
    const verdict = stepAfter(h.rec, { gap, fromStart: far(lead, start), sees, keeperProne: prone, turn: c.meta.turn, recovering });
    if (!verdict) { if (recovering) savePlace(key, c); return ''; }
    if (!h.companion) {
        if (verdict !== 'start') return '';
        const rec = afterStep(h.rec, 'start');
        store(h, rec); jailer(place, rec.by, player, rec.attempts); savePlace(key, c);
        return `${player} (${rec.by}'s prisoner${bound}) is walking off on their own: ${gap} squares from ${rec.by}, who sees it and goes after them (the code runs the chase: ${rec.by} grabs when they reach them, with rolls, and takes them back). Narrate ${rec.by}'s reaction, brief ${rec.by} if they speak; don't resolve the chase.`;
    }
    const by = h.rec.by;
    switch (verdict) {
        case 'standup':
            await standsUp(c, h);
            return `${player} (${by}'s prisoner${bound}) is making off while ${by} is on the ground: she gets up (no roll: her hands are free, but it costs her the turn) and ${player} gains ground. Narrate it and brief ${by}; the code runs the chase from here, don't ask for a roll.`;
        case 'grab':
            return grabCard(c, h);
        case 'lost':
            store(h, afterStep(h.rec, 'lost')); savePlace(key, c); refresh();
            return `${player} got out of ${by}'s sight (${gap} squares off${place.state.night ? ', in the dark' : ''}): the chase is off, and ${by} stands where she lost them. Decide what she does (calls out, searches: move her with place_changes guards, or lets it go) and brief her; she doesn't see, find or hold them unless you put her where they are.`;
        case 'start': {
            store(h, afterStep(h.rec, 'start'));
            await postNote(`🔒 You stepped beyond ${by}'s ring: she's after you.`);
            if (place.state.waiting?.[by]) await setWaiting(by, false, { quiet: true });
            c.meta.stance ??= {}; c.meta.stance[by] = 'close'; saveMeta();
            if (prone) { await standsUp(c, h); return `${player} (${by}'s prisoner${bound}) is making off while ${by} is on the ground: she gets up (no roll: her hands are free, but it costs her the turn) and ${player} gains ground. Narrate it and brief ${by}; the code runs the chase from here, don't ask for a roll.`; }
            if (runDown) runDown(3);
            const g2 = far(lead, kp);
            start.prevGap = g2;
            if (g2 <= 1) return grabCard(c, h);
            savePlace(key, c); refresh();
            return `${player} (${by}'s prisoner${bound}) is walking off on their own: ${g2} squares from ${by} now, and ${by} can see it. ${by} goes after them (the code keeps ${by} on their heels and rolls the grab when ${by} reaches them; narrate ${by}'s reaction and brief ${by} if they speak: a shout, a warning, an order to stop). Don't resolve the chase yourself, and don't call a walk a bolt: they walked.`;
        }
        default:
            return '';
    }
}

/**
 * A companion keeper running their prisoner down: straight at the player, a square a step, up to
 * `steps` of them, now. Null when there's no such keeper on this floor; else whether she moved.
 */
export function runKeeperDown(c, place, floorId, n, player, steps, { others = new Set() } = {}) {
    const p = n && place.state.positions[n];
    const lead = place.state.positions[player];
    if (!p || !lead || p.floor !== floorId || !c.meta.party.some(m => m.name === n)) return null;
    const gap = () => far(p, lead);
    let moved = false;
    for (let i = 0; i < steps && gap() > 1; i++) {
        const taken = new Set([...others, ...Object.entries(place.state.positions).filter(([m, q]) => m !== n && m !== player && q.floor === floorId).map(([, q]) => `${q.x},${q.y}`)]);
        const s = followSteps(place, floorId, p, lead, { taken, steps: 1, avoid: dangersFor(place, floorId, n), keep: 1 });
        if (!s.length) break;
        const d = doorAt(place, floorId, s[0][0], s[0][1]);
        if (d && d.state === 'closed') setDoorState(place, d, 'open');
        Object.assign(p, { x: s[0][0], y: s[0][1] });
        if (place.state.hidden?.[n]) delete place.state.hidden[n];
        standUp(place, n);
        moved = true;
    }
    return moved;
}

/** She's on the ground: she gets up (hands free: no roll), and that costs her the grab this turn. */
async function standsUp(c, h) {
    const w = c.docs.world;
    applyStateChanges(w, { conditions_remove: { [h.rec.by]: ['prone'] } }, c.meta.party.map(p => p.name), { turn: c.meta.turn });
    saveDoc('world');
    standUp(h.place, h.rec.by);
    store(h, { ...h.rec, lastGrabTurn: c.meta.turn });
    savePlace(h.key, c);
    await postNote(`📜 ${h.rec.by} gets up (−prone): no grab this turn.`);
    refresh();
}

// ---------- the cards ----------

/**
 * The keeper within reach grabs: her Athletics from her sheet against the player's roll to slip free
 * (a card asks for it). An arrest (no custody yet) makes them her prisoner if it lands. A wrench
 * (they're in her hands and run) is the same contest the other way about: torn free, the chase is on.
 */
async function grabCard(c, h, { arrest = false, wrench = false } = {}) {
    const { key, player } = h;
    const by = h.rec.by;
    let attempts = 1;
    if (!arrest) { store(h, onGrab(h.rec, c.meta.turn)); attempts = h.rec.attempts; }
    const stats = statsForName(by, c.meta);
    const mod = stats ? lookupModifier(stats, { kind: 'check', skill: 'Athletics', ability: 'STR' }).mod : 2;
    const theirs = roll(`1d20${mod >= 0 ? '+' : ''}${mod}`);
    const cuffs = restraintOf(conditionsOf(c.docs.world, player)).look;
    const pr = { kind: 'check', skill: 'Acrobatics', ability: 'DEX', die: 20, dc: theirs.total, advantage: cuffs ? 'disadvantage' : 'none', reason: wrench ? `${by} has hold of you; you wrench against it (her Athletics ${theirs.total}). Tear free!` : `${by} grabs for you${arrest ? '' : ' as you make off'} (Athletics ${theirs.total}). Slip free!`, damage: '', half: false, bonus: null, spot: null, turn: c.meta.turn, custody: { keeper: by, attempt: attempts, ...(arrest ? { arrest: true } : {}), ...(wrench ? { wrench: true } : {}) } };
    const dropped = droppedRoll(c);
    c.meta.pendingRoll = pr;
    const auto = settings().autoReadDice !== false ? ' (or roll with SillyTavern\'s dice: it\'s read automatically)' : '';
    await postDiceCard(wrench
        ? `🎲 **${player}** wrenches against **${by}**'s hold: she rolls Athletics d20 ${theirs.detail} = **${theirs.total}** to keep it.\n**${player}**, roll a **d20** for **Acrobatics (DEX)**${cuffs ? ' at **disadvantage** (two dice, the lower counts)' : ''} to tear free and type the number you rolled${auto}.`
        : `🎲 **${by}** grabs for **${player}**${arrest ? '' : ' as they make off'}: Athletics d20 ${theirs.detail} = **${theirs.total}**.\n**${player}**, roll a **d20** for **Acrobatics (DEX)**${cuffs ? ' at **disadvantage** (two dice, the lower counts)' : ''} to slip free and type the number you rolled${auto}.`, { request: pr });
    pr.chatIndex = ST.chat.length;
    saveMeta();
    savePlace(key, c);
    refresh();
    if (wrench) return `${player} (in ${by}'s hold${boundWord(c, player)}) says they run: the code rolled it as a contest (her Athletics ${theirs.total} to keep hold; the player is rolling Acrobatics${cuffs ? ' at disadvantage, bound' : ''}). Don't resolve it and don't ask for a roll: narrate the struggle in a line, brief ${by} for the moment before it lands, and stop. Torn free, the code runs the chase and tells you.${dropped}`;
    if (arrest) return `${by} grabs for ${player}: the code rolled it as a contest (her Athletics ${theirs.total}; ${player} is rolling Acrobatics${cuffs ? ' at disadvantage, bound' : ''}). Don't resolve it and don't ask for a roll: narrate the lunge in a line, brief ${by} for the moment before it lands, and stop. If she gets hold, the code makes ${player} her prisoner and tells you.${dropped}`;
    return `${player} (${by}'s prisoner${boundWord(c, player)}) is getting away; ${by} reaches them and grabs (grab ${attempts}; the player is rolling to slip free: don't resolve it; narrate ${by}'s lunge and a line from her if she speaks, then stop).${dropped}`;
}

/**
 * "I trip Judy", "I shove her off": the player's contested roll against their keeper, by the code:
 * her Athletics or Acrobatics (the better, from her sheet) to keep her feet, against the player's
 * Athletics (a shove) or Acrobatics (a trip), at disadvantage with cuffed hands. A card asks the
 * player; settleTrip reads the total.
 */
async function tripKeeper(c, h, text) {
    const { place, key, player, kp, lead } = h;
    const by = h.rec.by;
    const what = /\b(?:trips?|tripping|tripped|sweeps?|sweeping|hooks?|hooking)\b/i.test(text) ? 'trip' : 'shove';
    if (!lead || !kp || kp.floor !== lead.floor || far(lead, kp) > 1) return `${player} tries to ${what} ${by} from ${lead && kp ? far(lead, kp) : 'some'} squares off: out of reach, so nothing lands. Say so in a line; no roll.`;
    if (h.rec.lastGrabTurn === c.meta.turn) return '';
    const stats = statsForName(by, c.meta);
    const ath = stats ? lookupModifier(stats, { kind: 'check', skill: 'Athletics', ability: 'STR' }).mod : 2;
    const acr = stats ? lookupModifier(stats, { kind: 'check', skill: 'Acrobatics', ability: 'DEX' }).mod : 2;
    const hers = acr > ath ? ['Acrobatics', acr] : ['Athletics', ath];
    const theirs = roll(`1d20${hers[1] >= 0 ? '+' : ''}${hers[1]}`);
    const cuffs = restraintOf(conditionsOf(c.docs.world, player)).look;
    const acrobatic = what === 'trip' ? !/\bathletics\b/i.test(text) : /\bacrobatics\b/i.test(text);
    const pr = { kind: 'check', skill: acrobatic ? 'Acrobatics' : 'Athletics', ability: acrobatic ? 'DEX' : 'STR', die: 20, dc: theirs.total, advantage: cuffs ? 'disadvantage' : 'none', reason: `You try to ${what} ${by} (her ${hers[0]} ${theirs.total} to keep her feet). Beat it!`, damage: '', half: false, bonus: null, spot: null, turn: c.meta.turn, trip: { keeper: by, what } };
    const dropped = droppedRoll(c);
    c.meta.pendingRoll = pr;
    store(h, { ...h.rec, lastGrabTurn: c.meta.turn });
    const auto = settings().autoReadDice !== false ? ' (or roll with SillyTavern\'s dice: it\'s read automatically)' : '';
    await postDiceCard(`🎲 **${player}** tries to ${what} **${by}**: she rolls ${hers[0]} d20 ${theirs.detail} = **${theirs.total}** to keep her feet.\n**${player}**, roll a **d20** for **${pr.skill} (${pr.ability})**${cuffs ? ' at **disadvantage** (two dice, the lower counts)' : ''} and type the number you rolled${auto}.`, { request: pr });
    pr.chatIndex = ST.chat.length;
    saveMeta();
    savePlace(key, c);
    return `${player} tries to ${what} ${by}: the code rolled it as a contest (${by}'s ${hers[0]} ${theirs.total}; the player is rolling ${pr.skill}${cuffs ? ' at disadvantage, cuffed' : ''}). Don't resolve it and don't ask for a roll: narrate the attempt in a line, brief ${by} for the moment before it lands, and stop.${dropped}`;
}

/**
 * The player's roll against a grab came in. A miss: held (condition "grappled"), hers again in
 * guard mode (an arrest makes them her prisoner). A slip: loose for now; she stays after them,
 * and after three slips she can't hold them by hand. Returns the text for the DM.
 */
export async function settleCustody(c, pr, success) {
    const cur = currentPlace(c);
    if (!cur || !pr?.custody) return '';
    const { key, place } = cur;
    const player = c.meta.persona.name;
    const keeper = pr.custody.keeper;
    const w = c.docs.world;
    const raw = place.state.custody?.[player];
    const rec = raw?.by === keeper ? normalizeRecord(raw) : null;
    if (!success) {
        w.party[player] ??= { hp: 10, hp_max: 10, conditions: [] };
        if (!(w.party[player].conditions ??= []).some(x => /grappled/i.test(x))) w.party[player].conditions.push(`grappled (held by ${keeper})`);
        saveDoc('world');
        if (rec) {
            const { rec: next } = onSlip(rec, false);
            place.state.custody[player] = next;
            if (rec.mode !== 'guard' || rec.chase) await postNote(`🔒 ${keeper} has you: stay within ${next.radius} squares.`);
        } else if (pr.custody.arrest && c.meta.party.some(p => p.name === keeper)) {
            place.state.custody ??= {};
            place.state.custody[player] = newRecord(keeper);
            await postNote(`🔒 ${keeper} has you: her prisoner now (stay within ${DEFAULT_RADIUS} squares).`);
        }
        savePlace(key, c);
        refresh();
        return `${keeper} got hold of ${player} and holds them (condition "grappled"; the map won't let ${player} move until it's removed)${!rec && pr.custody.arrest ? `; ${player} is ${keeper}'s prisoner now (custody by the code, GUARD mode)` : ''}. ${keeper} decides what comes next (tighter cuffs, a rope, a warning): narrate it and brief ${keeper}; remove "grappled" when ${keeper} lets go.`;
    }
    const slip = rec ? onSlip(rec, true) : null;
    if (slip) place.state.custody[player] = slip.rec;
    if (pr.custody.wrench) {
        const holds = (w.party[player]?.conditions || []).filter(x => /^(?:grappled|pinned)\b/i.test(String(x)));
        if (holds.length) { w.party[player].conditions = w.party[player].conditions.filter(x => !holds.includes(x)); saveDoc('world'); await postNote(`📜 ${player}: −${holds.join(', −')} (torn free).`); }
    }
    savePlace(key, c);
    refresh();
    const tries = slip ? slip.tries : pr.custody.attempt;
    const got = pr.custody.wrench ? `tore out of ${keeper}'s hold` : `slipped free of ${keeper}'s grab`;
    if (tries >= 3) return `${player} ${got} a third time: ${keeper} can't hold them by hand. Decide what ${keeper} does now (keeps after them on foot, calls out, gives up, draws a weapon: then start_combat) and brief ${keeper}.`;
    return `${player} ${got} (${tries} of 3): ${keeper} is off balance and ${player} has a few steps on her before she runs again; she keeps after them. Narrate it in a line, brief ${keeper} if they speak, and stop: the chase goes on by the code.`;
}

/** The player's trip or shove came in. Landed: she's down (a trip) or knocked back, her hold broken. Missed: she keeps her feet and has hold of them. */
export async function settleTrip(c, pr, success) {
    const cur = currentPlace(c);
    if (!cur || !pr?.trip) return '';
    const { key, place } = cur;
    const player = c.meta.persona.name;
    const keeper = pr.trip.keeper;
    const raw = place.state.custody?.[player];
    const rec = raw?.by === keeper ? normalizeRecord(raw) : null;
    const w = c.docs.world;
    const party = c.meta.party.map(p => p.name);
    w.party[player] ??= { hp: 10, hp_max: 10, conditions: [] };
    w.party[player].conditions ??= [];
    if (success) {
        if (pr.trip.what === 'trip') { applyStateChanges(w, { conditions_add: { [keeper]: ['prone'] } }, party, { turn: c.meta.turn }); await postNote(`📜 ${keeper}: +prone (tripped by ${player}).`); }
        const held = w.party[player].conditions.filter(x => /^(?:grappled|pinned)\b/i.test(x));
        if (held.length) { w.party[player].conditions = w.party[player].conditions.filter(x => !held.includes(x)); await postNote(`📜 ${player}: −${held.join(', −')}.`); }
        saveDoc('world');
        if (rec) place.state.custody[player] = onTrip(rec, true);
        savePlace(key, c);
        refresh();
        return pr.trip.what === 'trip'
            ? `${player}'s trip landed: ${keeper} is on the ground (condition "prone", by the code) and her hold is broken. She gets up on her own next turn (no roll: her hands are free), and the code runs the chase if ${player} goes. Narrate the fall and brief ${keeper}; don't roll anything.`
            : `${player}'s shove landed: ${keeper} is knocked back and her hold is broken; the code runs the chase if ${player} goes. Narrate it and brief ${keeper}; don't roll anything.`;
    }
    const a = place.state.positions[player], b = place.state.positions[keeper];
    const near = a && b && a.floor === b.floor && far(a, b) <= 1;
    if (near && !w.party[player].conditions.some(x => /grappled/i.test(x))) { w.party[player].conditions.push(`grappled (held by ${keeper})`); await postNote(`📜 ${player}: +grappled (held by ${keeper}).`); }
    saveDoc('world');
    if (rec) { place.state.custody[player] = onTrip(rec, false); if (rec.mode !== 'guard' || rec.chase) await postNote(`🔒 ${keeper} has you: stay within ${rec.radius} squares.`); }
    savePlace(key, c);
    refresh();
    return `${player}'s ${pr.trip.what} failed: ${keeper} keeps her feet${near ? ` and has hold of them (condition "grappled", by the code; the map won't let ${player} move until it's removed)` : ''}. Narrate it and brief ${keeper}${near ? '; remove "grappled" when she lets go' : ''}.`;
}

// ---------- between turns ----------

/** A turn passes for a companion keeper. On the ground: she gets up (no roll). Returns the event for the DM, or ''. */
export async function custodyUpkeep(c = campaign()) {
    const h = held(c);
    if (!h || !h.companion || c.docs.world.combat) return '';
    const { rec } = h;
    const w = c.docs.world;
    const conds = conditionsOf(w, rec.by);
    if (outBy(conds) || lockedReason(c, rec.by) || place.state.pose?.[rec.by]?.pose === 'sleep') return '';
    if (conds.some(x => /^prone\b/i.test(String(x)))) {
        await standsUp(c, h);
        return `${rec.by} gets up off the ground (no roll: her hands are free; it costs her this turn's move, so no grab this turn). Narrate it in a line and brief her.`;
    }
    return '';
}

/** Is the player bound (cuffs, rope) or in someone's hands (grappled, pinned) right now, by the books? */
export function boundNow(c) {
    const mine = conditionsOf(c.docs.world, c.meta.persona.name);
    return Boolean(restraintOf(mine).bound) || mine.some(x => /^(?:grappled|pinned)\b/i.test(String(x)));
}

/**
 * The restraints came off this turn (the DM's conditions_remove, a roll that worked, her letting go)
 * and nobody holds them: custody is over, the player told. Only the transition counts: a keeper who
 * holds them by her word alone (no cuffs, no rope) keeps them until the DM ends it. `wasBound` is
 * what the books said before the turn's changes. Returns the line for the DM, or ''.
 */
export async function custodyFreed(c, wasBound) {
    const h = held(c);
    if (!h || !h.companion || !wasBound || boundNow(c)) return '';
    const { place, key, player, rec } = h;
    delete place.state.custody[player];
    savePlace(key, c);
    await postNote(`🔓 You're out of ${rec.by}'s hands: the restraints are off and nobody's holding you. ${rec.by} is a companion again unless she takes you again.`);
    refresh();
    return `${player}'s restraints are off and nobody holds them: they're nobody's prisoner now (custody ended by the code). ${rec.by} may try to take them again (a grab is a contest the code rolls), or let it be; send custody again only when she has hold of them.`;
}

/**
 * A companion who cuffs or ties the player in the story (the DM's narration, the opening's premise)
 * has them: custody by the code, guard mode, with the note. With an enemy at hand the cuffs are
 * theirs and the DM says who holds them. Returns a line for the DM when the player is bound, a
 * companion is at hand and nobody holds them on the map (no chase can run then), else ''.
 */
export async function custodyFromStory(c, text, status = null) {
    const cur = currentPlace(c);
    const player = c.meta.persona.name;
    const w = c.docs.world;
    if (!cur || !text || w.combat || cur.place.state.custody?.[player] || !restraintOf(conditionsOf(w, player)).bound) return '';
    const { place, key } = cur;
    const lead = place.state.positions[player];
    if (!lead) return '';
    if (Object.values(place.guards).some(g => (g.hostile === true || g.intent === 'attack') && g.state !== 'dead' && g.state !== 'gone' && !g.down && g.floor === lead.floor && far(g, lead) <= EARSHOT)) return '';
    const CUFF_WORDS = 'cuff|cuffs|cuffed|handcuff|handcuffs|handcuffed|manacle|manacles|manacled|shackl\\w*|ties|tied|tying|bind|binds|bound|rope|ropes|arrest|arrests|arrested|restrain|restrains|restrained|prisoner|custody';
    const near = n => { const p = place.state.positions[n]; return p && p.floor === lead.floor && far(p, lead) <= 3 && !isAway(w, n); };
    const names = c.meta.party.map(p => p.name);
    const keeper = names.find(n => { const first = esc(n.split(' ')[0]); return near(n) && (new RegExp(`\\b${first}\\b[^.!?]{0,80}\\b(?:${CUFF_WORDS})\\b`, 'i').test(text) || new RegExp(`\\b(?:${CUFF_WORDS})\\b[^.!?]{0,80}\\b${first}\\b`, 'i').test(text)); });
    if (keeper) {
        place.state.custody ??= {};
        place.state.custody[player] = newRecord(keeper);
        savePlace(key, c);
        status?.note(`${player} is ${keeper}'s prisoner (kept within ${DEFAULT_RADIUS} squares)`);
        await postNote(`🔒 ${keeper} has you (from the story): a step beyond ${DEFAULT_RADIUS} squares is an escape.`);
        refresh();
        return '';
    }
    if (names.some(near)) return `${player} is ${restraintOf(conditionsOf(w, player)).look === 'rope' ? 'tied' : 'cuffed'} and nobody's prisoner on the map (no CUSTODY): if a companion has them, send place_changes custody {"${player}": {"by": "<her name>", "radius": 2}} this turn, so the map keeps them together and runs any chase and grab with rolls; if nobody holds them, leave it.`;
    return '';
}

// ---------- a companion taking hold of the player ----------

/**
 * "Judy grabs for Amber's wrists" (the DM's narration, with no roll asked) or "((Judy tries to grab
 * Amber))" (the player's aside): a companion taking hold of the player is the code's contest, never
 * a narrated outcome. A cheap gate (her name, a taking-hold word and him in one sentence), then the
 * referee; she closes in first if she's a few squares off; on the ground she gets up instead. A hold
 * makes them her prisoner. Returns the event for the DM, or ''.
 */
export async function custodyOnNarration(c, text, status = null) {
    return arrestFromText(c, text, status);
}

async function arrestFromText(c, text, status) {
    const cur = currentPlace(c);
    if (!cur || !text || c.docs.world.combat || codeRoll(c)) return '';
    const { place, key } = cur;
    const player = c.meta.persona.name;
    const lead = place.state.positions[player];
    if (!lead) return '';
    const raw = place.state.custody?.[player];
    const conds = conditionsOf(c.docs.world, player);
    const t = String(text).replace(/[*_~`]/g, ' ');
    const pf = esc(player.split(' ')[0]);
    for (const m of c.meta.party) {
        if (raw?.by === m.name) continue;
        if (conds.some(x => /^(?:grappled|pinned)\b/i.test(String(x)) && new RegExp(`\\b${esc(m.name.split(' ')[0])}\\b`, 'i').test(String(x)))) continue;
        const first = esc(m.name.split(' ')[0]);
        if (!new RegExp(`\\b${first}\\b[^.!?]{0,60}\\b(?:grab|grabs|grabbed|grabbing|seize|seizes|seized|seizing|tackle|tackles|tackled|tackling|lunge|lunges|lunged|lunging|hold of|pin|pins|pinned|pinning|wrestle|wrestles|wrestling|catch|catches|catching|caught)\\b[^.!?]{0,60}\\b(?:${pf}|you|your|him|his)\\b`, 'i').test(t)) continue;
        if (await referee('grab', { keeper: m.name, player, text }, ['yes', 'no'], status) !== 'yes') continue;
        const kp = place.state.positions[m.name];
        if (!kp || kp.floor !== lead.floor) continue;
        const kconds = conditionsOf(c.docs.world, m.name);
        if (outBy(kconds) || lockedReason(c, m.name)) return `${m.name} can't grab anyone right now (${outBy(kconds) ? 'out of it' : lockedReason(c, m.name)}): nothing happens; say so in a line.`;
        if (kconds.some(x => /^prone\b/i.test(String(x)))) {
            applyStateChanges(c.docs.world, { conditions_remove: { [m.name]: ['prone'] } }, c.meta.party.map(p => p.name), { turn: c.meta.turn });
            saveDoc('world');
            standUp(place, m.name);
            savePlace(key, c);
            await postNote(`📜 ${m.name} gets up (−prone): no grab this turn.`);
            return `${m.name} is on the ground: she gets up first (no roll; it costs her the lunge) and grabs nobody this turn. Narrate that and stop; don't roll anything.`;
        }
        runKeeperDown(c, place, lead.floor, m.name, player, 3);
        const gap = far(lead, kp);
        if (gap > 1) { savePlace(key, c); refresh(); return `${m.name} goes for ${player} but is still ${gap} squares off: no hold yet (the code moved her closer; she grabs when she reaches them, with a roll). Narrate her coming and stop; don't resolve it.`; }
        return grabCard(c, { cur, key, place, player, kp, lead, companion: true, rec: newRecord(m.name) }, { arrest: true });
    }
    return '';
}
