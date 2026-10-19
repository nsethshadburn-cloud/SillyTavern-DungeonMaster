// Random event deck: decides WHEN an event is due and WHICH event fits.
// Pure module (no SillyTavern imports).

import { random01 } from './dice.js';

export const EVENT_SETTINGS = ['road', 'town', 'wild', 'dungeon', 'sea', 'any'];
export const EVENT_TYPES = ['combat', 'social', 'loot', 'weird', 'weather', 'moral', 'travel', 'mystery'];

/**
 * Normalize a raw event entry from events.json.
 * @param {any} raw
 */
export function normalizeEvent(raw) {
    const settings = toList(raw.settings ?? raw.setting ?? ['any']).map(s => String(s).toLowerCase());
    return {
        id: String(raw.id),
        title: String(raw.title ?? raw.id),
        seed: String(raw.seed ?? ''),
        settings: settings.length ? settings : ['any'],
        type: String(raw.type ?? 'weird').toLowerCase(),
        danger: clamp(Number(raw.danger ?? 1), 1, 5),
        weight: Math.max(0, Number(raw.weight ?? 1)),
        cooldown: Math.max(0, Number(raw.cooldown ?? 40)),
        once: Boolean(raw.once),
        requires: toList(raw.requires ?? []).map(String),
        enabled: raw.enabled !== false,
    };
}

/**
 * Chance that an event fires at this eligible moment.
 * Grows with quiet turns since the last event; suppressed by combat, climaxes and high fun.
 * @param {{turnsSinceEvent:number, inCombat:boolean, tension:number, fun:number, frequency:'rare'|'normal'|'frequent'|string}} ctx
 * @param {{base?:number, growth?:number, cap?:number}} tuning
 */
export function eventChance(ctx, tuning = {}) {
    if (ctx.inCombat) return 0;
    if (ctx.tension >= 9) return 0; // Don't interrupt a climax.
    const freq = { rare: 0.5, normal: 1, frequent: 1.6, off: 0 }[ctx.frequency] ?? 1;
    if (freq === 0) return 0;
    const base = tuning.base ?? 0.04;
    const growth = tuning.growth ?? 0.025;
    const cap = tuning.cap ?? 0.45;
    const minGap = 6; // At least a few turns of breathing room after an event.
    if (ctx.turnsSinceEvent < minGap) return 0;
    let chance = base + growth * (ctx.turnsSinceEvent - minGap);
    chance *= freq;
    // Players clearly enjoying a moment: back off.
    if (ctx.fun >= 2.2) chance *= 0.35;
    else if (ctx.fun >= 1.6) chance *= 0.7;
    return clamp(chance, 0, cap * Math.max(1, freq));
}

/**
 * Filter the deck to events that fit right now.
 * @param {ReturnType<typeof normalizeEvent>[]} deck
 * @param {{setting:string, danger:number, flags:Set<string>|string[], turn:number, history:Record<string,{lastTurn:number,count:number}>}} ctx
 */
export function eligibleEvents(deck, ctx) {
    const flags = ctx.flags instanceof Set ? ctx.flags : new Set(ctx.flags || []);
    const setting = String(ctx.setting || 'any').toLowerCase();
    const maxDanger = clamp(Number(ctx.danger ?? 3), 1, 5);
    return deck.filter(ev => {
        if (!ev.enabled || ev.weight <= 0) return false;
        if (!(ev.settings.includes('any') || ev.settings.includes(setting) || setting === 'any')) return false;
        if (ev.danger > maxDanger + 1) return false; // One step spicier than the scene is allowed.
        const hist = ctx.history?.[ev.id];
        if (hist) {
            if (ev.once && hist.count > 0) return false;
            if (ctx.turn - hist.lastTurn < ev.cooldown) return false;
        }
        for (const req of ev.requires) {
            const negate = req.startsWith('!');
            const key = negate ? req.slice(1) : req;
            if (negate ? flags.has(key) : !flags.has(key)) return false;
        }
        return true;
    });
}

/**
 * Weighted random pick. Recently used TYPES are down-weighted so the
 * story doesn't get three bandit attacks in a row.
 * @param {ReturnType<typeof normalizeEvent>[]} candidates
 * @param {string[]} recentTypes most recent last
 */
export function pickEvent(candidates, recentTypes = [], rng = random01) {
    if (!candidates.length) return null;
    const recent = recentTypes.slice(-3);
    const weights = candidates.map(ev => {
        let w = ev.weight;
        const repeats = recent.filter(t => t === ev.type).length;
        w *= Math.pow(0.45, repeats);
        return w;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    let r = rng() * sum;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r < 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
}

/** Map a free-text location to a deck setting. */
export function guessSetting(location = '', explicit = '') {
    const e = String(explicit || '').toLowerCase();
    if (EVENT_SETTINGS.includes(e)) return e;
    const t = String(location || '').toLowerCase();
    if (/\b(ship|boat|sea|ocean|harbor|harbour|dock|coast|river|lake|beach)\b/.test(t)) return 'sea';
    if (/\b(dungeon|crypt|tomb|cave|cavern|ruin|ruins|mine|sewer|catacomb|vault|tunnel|lair|temple ruins)\b/.test(t)) return 'dungeon';
    if (/\b(road|highway|trail|path|caravan|crossroad|bridge|pass)\b/.test(t)) return 'road';
    if (/\b(town|city|village|inn|tavern|market|street|alley|district|castle|keep|precinct|station|shop|plaza|square|manor|palace|guild)\b/.test(t)) return 'town';
    if (/\b(forest|woods|jungle|swamp|marsh|desert|mountain|hill|plain|field|tundra|wild|wilderness|grove|valley|canyon|camp)\b/.test(t)) return 'wild';
    return 'any';
}

function toList(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined || v === '') return [];
    return String(v).split(/[,|]/).map(s => s.trim()).filter(Boolean);
}

function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
}
