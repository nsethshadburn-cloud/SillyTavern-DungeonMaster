// The bookkeeper: after a turn, the local model reads what was just said (the DM's narration, the
// companions' and NPCs' replies) next to the tracked status, and lists what the story says happened
// that the tracking doesn't show yet (Judy passed out, the key changed hands). Everything it says
// is checked here before it's applied: known conditions only, people who are there, nothing added
// twice, nothing removed that isn't there.
// Pure module (no SillyTavern imports).

import { extractJson, matchName, nameKey } from './text.js';

/** The conditions the bookkeeper may set, and the words that mean them. */
const CONDITIONS = [
    ['unconscious', /\b(unconscious|knocked out|passed out|out cold|blacked out|fainted)\b/],
    ["can't walk", /\b(can'?t walk|cannot walk|unable to walk|can'?t stand|too (?:hurt|injured|weak|wounded) to (?:walk|move|stand)|immobil)/],
    ['asleep', /\b(asleep|sleeping)\b/],
    ['poisoned', /\bpoison/],
    ['prone', /\b(prone|knocked down|on the ground)\b/],
    ['frightened', /\b(frightened|terrified)\b/],
    ['charmed', /\bcharmed\b/],
    ['blinded', /\bblind/],
    ['deafened', /\bdeaf/],
    ['exhausted', /\bexhaust/],
    ['grappled', /\b(grappled|grabbed|pinned)\b/],
    ['paralyzed', /\bparaly/],
    ['stunned', /\bstun/],
    ['incapacitated', /\bincapacitat/],
    ['restrained (rope)', /\b(tied up|bound|restrained|rope)\b/],
    ['cuffed', /\b(cuff|manacle|shackl)/],
    ['caged', /\bcage/],
    ['invisible', /\binvisib/],
];

/** One of the known conditions for a phrase, or null. */
export function conditionWord(text) {
    const t = String(text ?? '').toLowerCase().trim();
    if (!t) return null;
    return CONDITIONS.find(([, re]) => re.test(t))?.[0] ?? null;
}

/**
 * The prompt for the local model.
 * @param {{status: {name:string, hp?:string, conditions:string[], items:string[]}[], shared:string[], others:string[], story:string}} p
 */
export function bookkeeperPrompt({ status, shared = [], others = [], story }) {
    const system = 'You keep the books for a tabletop roleplaying game. Reply with ONE line of JSON and nothing else.';
    const user = [
        'Tracked right now:',
        ...status.map(s => `- ${s.name}:${s.hp ? ` HP ${s.hp};` : ''} conditions: ${s.conditions.length ? s.conditions.join(', ') : 'none'}; carries: ${s.items.length ? s.items.join(', ') : 'nothing noted'}`),
        `Shared pack: ${shared.length ? shared.join(', ') : 'nothing noted'}`,
        others.length ? `Other people here: ${others.join(', ')}` : '',
        '',
        'What just happened in the story:',
        story,
        '',
        'Which changes does the story say ACTUALLY happened just now that the tracked list does not show yet? Only clear facts the story states, never guesses, plans, threats or things that might happen.',
        `- conditions someone gained, from this list only: ${CONDITIONS.map(([c]) => c).join(', ')}; or lost (woke up, got up, was untied, was cured)`,
        '- items someone picked up, was given or now carries; items someone lost, dropped, handed over or used up',
        'JSON: {"conditions_add": {"Name": ["condition"]}, "conditions_remove": {"Name": ["condition"]}, "items_add": {"Name": ["item"]}, "items_remove": {"Name": ["item"]}} with empty objects when nothing changed.',
    ].filter(Boolean).join('\n');
    return { system, user };
}

/**
 * Check the model's answer against what's tracked and return the state_changes to apply (or null).
 * @param {string} text the model's reply
 * @param {{names:string[], itemNames?:string[], conditionsOf:(name:string)=>string[], itemsOf:(name:string)=>string[], allItems:string[]}} known
 *   names = whose conditions may change (the party and the people here); itemNames = who carries tracked
 *   items (the party); itemsOf = what someone carries (their own and the shared pack)
 */
export function parseBookkeeping(text, { names, itemNames = names, conditionsOf, itemsOf, allItems }) {
    const data = extractJson(text);
    if (!data || typeof data !== 'object') return null;
    const entries = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : []);
    const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean).slice(0, 4);
    const has = (arr, x) => arr.some(y => nameKey(y) === nameKey(x));
    const out = { conditions_add: {}, conditions_remove: {}, items_add: {}, items_remove: {} };
    for (const [who, conds] of entries(data.conditions_add)) {
        const name = matchName(who, names);
        if (!name) continue;
        const now = conditionsOf(name).map(c => conditionWord(c) ?? c);
        const add = [...new Set(list(conds).map(conditionWord).filter(Boolean))].filter(c => !has(now, c));
        if (add.length) out.conditions_add[name] = add;
    }
    for (const [who, conds] of entries(data.conditions_remove)) {
        const name = matchName(who, names);
        if (!name) continue;
        // Only what they actually have (by its tracked wording).
        const now = conditionsOf(name);
        const remove = list(conds).map(conditionWord).filter(Boolean).flatMap(w => now.filter(c => (conditionWord(c) ?? c) === w));
        if (remove.length) out.conditions_remove[name] = [...new Set(remove)];
    }
    const removed = [];
    for (const [who, items] of entries(data.items_remove)) {
        const name = matchName(who, itemNames);
        if (!name) continue;
        const theirs = itemsOf(name);
        const remove = list(items).map(i => theirs.find(t => nameKey(t) === nameKey(i) || nameKey(t).includes(nameKey(i)))).filter(Boolean);
        if (remove.length) { out.items_remove[name] = [...new Set(remove)]; removed.push(...remove); }
    }
    // Nothing tracked twice, except something handed over this turn (it leaves one person for another).
    for (const [who, items] of entries(data.items_add)) {
        const name = matchName(who, itemNames);
        if (!name) continue;
        const add = list(items).map(i => i.slice(0, 40)).filter(i => !has(allItems, i) || has(removed, i));
        if (add.length) out.items_add[name] = [...new Set(add)];
    }
    for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
    return Object.keys(out).length ? out : null;
}
