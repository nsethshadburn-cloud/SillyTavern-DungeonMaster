// A companion's MIND: what they are like inside right now, kept by the DM (Claude) and never shown
// to the local model, which only ever gets a brief written from it. It is what makes a companion
// continuous from one turn to the next: the same mood until something changes it, a goal of their
// own they keep pushing, feelings about particular people, a private worry. Pure module.

import { matchName } from './text.js';

const MAX_TEXT = 160;
const MAX_FEELINGS = 8;

const clip = v => String(v ?? '').trim().slice(0, MAX_TEXT);

export function emptyMind() {
    return { mood: '', goal: '', feelings: {}, worry: '' };
}

/**
 * A mind update from the DM, checked: strings clipped, feelings as {person: feeling}; a "" value
 * clears that field (a worry that's resolved, a feeling that's gone). Null when nothing usable.
 */
export function normalizeMind(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of ['mood', 'goal', 'worry']) if (raw[key] !== undefined && raw[key] !== null) out[key] = clip(raw[key]);
    if (raw.feelings && typeof raw.feelings === 'object' && !Array.isArray(raw.feelings)) {
        out.feelings = {};
        for (const [who, how] of Object.entries(raw.feelings).slice(0, MAX_FEELINGS)) {
            const n = String(who).trim().slice(0, 60);
            if (n) out.feelings[n] = how === null ? '' : clip(how);
        }
    }
    return Object.keys(out).length ? out : null;
}

/** Apply an update to a mind: only the fields sent change; "" clears a field or a feeling. */
export function mergeMind(mind, update) {
    const base = { ...emptyMind(), ...(mind && typeof mind === 'object' ? mind : {}), feelings: { ...(mind?.feelings || {}) } };
    if (!update) return base;
    for (const key of ['mood', 'goal', 'worry']) if (update[key] !== undefined) base[key] = update[key];
    for (const [who, how] of Object.entries(update.feelings || {})) {
        // "dray" updates the feeling about "Captain Dray"; the fuller name stays.
        const existing = matchName(who, Object.keys(base.feelings));
        if (existing && !how) delete base.feelings[existing];
        else if (how) base.feelings[existing ?? who] = how;
    }
    return base;
}

/** Is there anything in it yet? */
export function mindIsEmpty(mind) {
    return !mind || !(mind.mood || mind.goal || mind.worry || Object.keys(mind.feelings || {}).length);
}

/** The mind as one plain paragraph for the DM. */
export function renderMind(mind) {
    if (mindIsEmpty(mind)) return '';
    const bits = [];
    if (mind.mood) bits.push(`Mood: ${mind.mood}.`);
    if (mind.goal) bits.push(`Own goal: ${mind.goal}.`);
    const feelings = Object.entries(mind.feelings || {}).filter(([, v]) => v);
    if (feelings.length) bits.push(`Feelings: ${feelings.map(([n, v]) => `${n}: ${v}`).join('; ')}.`);
    if (mind.worry) bits.push(`Private worry: ${mind.worry}.`);
    return bits.join(' ');
}

/**
 * The companions' minds for the DM's context: one block per companion, with a MISSING marker for
 * anyone whose mind hasn't been written yet (the DM writes it that turn).
 * @param {string[]} names party members with the player (away ones can be included; the DM decides)
 * @param {Record<string, object>} minds
 */
export function renderMinds(names, minds = {}) {
    return names.map(n => {
        const text = renderMind(minds[n]);
        return `## ${n}\n${text || '(MISSING: write "mind_update" for them this turn: mood, goal, feelings, worry)'}`;
    }).join('\n\n');
}
