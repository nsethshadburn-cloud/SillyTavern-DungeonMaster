// What the local model is told is true right now: the scene card (place, people's bodies and
// positions, important objects), a short timeline with time anchors, the people a companion
// knows, and the table rules. The DM keeps these up to date; companions and NPCs never see the
// DM's narration, so this is how they stay consistent. Pure module.

import { nameKey } from './text.js';

const MAX_PEOPLE = 10;
const MAX_OBJECTS = 8;
const MAX_TEXT = 180;
export const MAX_TIMELINE = 8;
const MAX_RULES = 12;

export function emptySceneCard() {
    return { place: '', people: {}, objects: {} };
}

function clip(v) {
    return String(v ?? '').trim().slice(0, MAX_TEXT);
}

function entries(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
}

/** Validate a scene card update from the DM. Null when there's nothing usable. */
export function normalizeSceneCard(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = { place: clip(raw.place), people: {}, objects: {} };
    for (const key of ['people', 'objects']) {
        for (const [name, text] of entries(raw[key]).slice(0, key === 'people' ? MAX_PEOPLE : MAX_OBJECTS)) {
            const n = String(name).trim().slice(0, 60);
            // An empty value removes the entry.
            if (n) out[key][n] = text === null ? '' : clip(text);
        }
    }
    if (!out.place && !Object.keys(out.people).length && !Object.keys(out.objects).length) return null;
    return out;
}

function setEntry(map, name, text) {
    const existing = Object.keys(map).find(k => nameKey(k) === nameKey(name));
    if (existing) delete map[existing];
    if (text) map[name] = text;
}

/**
 * Apply the DM's changes to the scene card.
 * newPlace = the party just arrived somewhere else: the old place and objects no longer apply,
 * and only the party's own entries carry over (cuffs stay on when you're marched upstairs).
 * @param {object|null} card
 * @param {object|null} update normalized (normalizeSceneCard)
 * @param {{newPlace?: boolean, partyNames?: string[]}} [o]
 */
export function applySceneCard(card, update, { newPlace = false, partyNames = [] } = {}) {
    const base = card && typeof card === 'object' ? card : emptySceneCard();
    const out = { place: base.place || '', people: { ...(base.people || {}) }, objects: { ...(base.objects || {}) } };
    if (newPlace) {
        out.place = '';
        out.objects = {};
        const party = new Set(partyNames.map(nameKey));
        for (const name of Object.keys(out.people)) if (!party.has(nameKey(name))) delete out.people[name];
    }
    if (update) {
        if (update.place) out.place = update.place;
        for (const [name, text] of Object.entries(update.people || {})) setEntry(out.people, name, text);
        for (const [name, text] of Object.entries(update.objects || {})) setEntry(out.objects, name, text);
    }
    // Keep the newest entries when the DM sends more than fit.
    for (const [key, max] of [['people', MAX_PEOPLE], ['objects', MAX_OBJECTS]]) {
        const list = Object.entries(out[key]);
        if (list.length > max) out[key] = Object.fromEntries(list.slice(-max));
    }
    return out;
}

/**
 * The scene card as plain lines.
 * @param {object|null} card
 * @param {Record<string, string[]>} [conditions] party conditions by name (poisoned, prone...)
 */
export function renderSceneCard(card, conditions = {}) {
    const c = card || emptySceneCard();
    const lines = [];
    if (c.place) lines.push(`Place: ${c.place}`);
    const people = { ...(c.people || {}) };
    for (const [name, list] of Object.entries(conditions || {})) {
        if (!list?.length) continue;
        const key = Object.keys(people).find(k => nameKey(k) === nameKey(name));
        const tag = `[${list.join(', ')}]`;
        if (key) people[key] = `${people[key]} ${tag}`;
        else people[name] = tag;
    }
    for (const [name, text] of Object.entries(people)) if (text) lines.push(`${name}: ${text}`);
    const objects = Object.entries(c.objects || {}).filter(([, t]) => t);
    if (objects.length) lines.push(`Objects: ${objects.map(([n, t]) => `${n}: ${t}`).join('; ')}`);
    return lines.join('\n');
}

/** Remember one "what happened" line with when and where it happened. */
export function pushTimeline(timeline, { day = 1, time = '', place = '', text = '' }) {
    const list = Array.isArray(timeline) ? timeline : [];
    const t = String(text || '').trim();
    if (!t) return list;
    list.push({ day: Number(day) || 1, time: String(time || ''), place: String(place || ''), text: t });
    while (list.length > MAX_TIMELINE) list.shift();
    return list;
}

const NIGHT = /night|evening|dusk/;

/** "Earlier tonight", "Last night", "3 days ago": relative to now, so the model can't misplace it. */
export function whenLabel(entry, now) {
    const diff = (Number(now?.day) || 1) - (Number(entry?.day) || Number(now?.day) || 1);
    const night = NIGHT.test(String(entry?.time || ''));
    if (diff <= 0) return night ? 'Earlier tonight' : 'Earlier today';
    if (diff === 1) return night ? 'Last night' : `Yesterday${entry?.time ? ` (${entry.time})` : ''}`;
    return `${diff} days ago`;
}

/**
 * The timeline as lines, oldest first.
 * @param {Array} timeline
 * @param {{day?: number, time?: string}} now
 * @param {{skipLatest?: boolean}} [o] skipLatest = the newest line is shown separately ("just happened")
 */
export function renderTimeline(timeline, now, { skipLatest = false } = {}) {
    const list = Array.isArray(timeline) ? timeline.slice() : [];
    if (skipLatest) list.pop();
    return list.map(e => `- ${whenLabel(e, now)}${e.place ? `, ${e.place}` : ''}: ${e.text}`).join('\n');
}

/** First sentence of a description, at most `words` words. */
function shortRole(text, words = 14) {
    const first = String(text || '').split(/(?<=[.;!?])\s/)[0].replace(/[.;]\s*$/, '');
    const list = first.split(/\s+/).filter(Boolean);
    return list.length > words ? `${list.slice(0, words).join(' ')}…` : list.join(' ');
}

/**
 * People met so far with their role, so "the captain" and "the commander" are one person.
 * @param {Array} npcs the campaign's NPC roster
 * @param {{max?: number, exclude?: string}} [o]
 */
export function renderPeople(npcs, { max = 8, exclude = '' } = {}) {
    return (npcs || [])
        .filter(n => n?.name && nameKey(n.name) !== nameKey(exclude))
        .slice(-max)
        .map(n => {
            const role = n.role || shortRole(n.description);
            return `- ${n.name}${role ? `: ${role}` : ''}${n.dead ? ' (dead)' : ''}`;
        })
        .join('\n');
}

/** Add and remove table rules (things the player settled out of character). */
export function applyTableRules(rules, add = [], remove = []) {
    let out = Array.isArray(rules) ? rules.slice() : [];
    for (const r of remove || []) {
        const key = nameKey(r);
        if (key) out = out.filter(x => nameKey(x) !== key && !nameKey(x).includes(key));
    }
    for (const r of add || []) {
        const text = String(r || '').trim().slice(0, 200);
        if (text && !out.some(x => nameKey(x) === nameKey(text))) out.push(text);
    }
    return out.slice(-MAX_RULES);
}
