// What the plugin tells the roleplay model (Skyfall, Orion, ...). These are editable in the
// settings, like a small system prompt of their own, with a "reset to default" for each.
// Pure module (no SillyTavern imports).
//
// Placeholders the plugin fills in: {{player}} {{party}} {{location}} {{present}} {{situation}}
// {{goal}} {{brief}} {{length}} {{npc}} {{description}} {{pronouns}} {{attitude}} {{knowledge}}
// {{scenecard}} {{people}} {{timeline}} {{rules}} {{avoid}} {{room}} {{things}} {{exits}} {{here}} {{known}}.
// SillyTavern's own macros ({{char}}, {{user}}, ...) also work. A line containing a plugin
// placeholder that's empty is dropped, so empty fields never leave half-sentences behind.

import { estimateTokens, trimToTokens } from './text.js';

export const DEFAULT_TEMPLATES = Object.freeze({
    scene: [
        '[Roleplay notes for {{char}}. Follow them, never mention them.',
        '- You play only {{char}}, traveling with {{player}}. Never speak or act for {{player}} or anyone else.',
        '- You are a companion, not the storyteller. Don\'t invent places, people, clues, threats or events, and don\'t move the scene somewhere new. React to what is happening right now.',
        '- Keep replies to 3-4 sentences: mostly dialogue, only a little description of what {{char}} does.',
        '- Everything {{char}} says out loud goes inside "double quotation marks"; actions and thoughts stay outside them.',
        '- Where: {{location}}',
        '- Also here: {{present}}',
        '- Right now: {{situation}}',
        '- Goal: {{goal}}]',
    ].join('\n'),
    brief: [
        '[Game master\'s note for this reply only. Never mention it or quote it.',
        '{{brief}}',
        'Length: {{length}}.]',
    ].join('\n'),
    state: [
        '[What is true right now. Keep every detail consistent with it (where everyone is, hands, restraints, light, objects); never contradict it.',
        '{{scenecard}}',
        'People {{char}} knows of: {{people}}',
        'Earlier (oldest first; keep these times straight): {{timeline}}',
        'Always true in this story: {{rules}}]',
    ].join('\n'),
    happened: '[Just happened, already done (react to it; never redo it): {{happened}}]',
    knowledge: [
        '[What {{char}} knows about the story so far. Background for this reply; don\'t recite it.',
        '{{knowledge}}]',
    ].join('\n'),
    avoid: '[{{char}} has been repeating these lately. Use different words and gestures this time: {{avoid}}]',
    room: [
        '[The room {{char}} is in right now on the map. Use what is really here; don\'t invent other furniture or exits.',
        '{{room}}',
        'Right here with {{char}}: {{here}}',
        'In it: {{things}}',
        'Ways out: {{exits}}',
        'Rooms {{char}} knows of in this place: {{known}}',
        'Never name a room, door, passage, route or item that is not listed above: {{char}} doesn\'t know the rest of this place.]',
    ].join('\n'),
    combat: '[A fight is happening. The game master narrates every action and result. {{char}} only says one short line or quick reaction: no actions, no describing the fight.]',
    npc: [
        '[You play only {{npc}}, a side character in this story.',
        '{{description}}',
        '{{npc}} uses {{pronouns}} pronouns.',
        'Attitude toward the party: {{attitude}}.',
        'Everything {{npc}} says out loud goes inside "double quotation marks".',
        'Never speak or act for {{player}} or {{party}}, and never narrate the scene. Reply with one or two short lines of dialogue and at most one brief action. Don\'t invent new plot.]',
    ].join('\n'),
});

/** Older defaults, so saved settings that were never edited can move to the current ones. */
export const OLD_DEFAULTS = Object.freeze({
    npcLast: 'Never speak or act for {{player}} or {{party}}. Reply with 1-3 sentences, mostly dialogue. Don\'t invent new plot.]',
    long: 'up to two short paragraphs',
    sceneV30: [
        '[Roleplay notes for {{char}}. Follow them, never mention them.',
        '- You play only {{char}}, traveling with {{player}}. Never speak or act for {{player}} or anyone else.',
        '- You are a companion, not the storyteller. Don\'t invent places, people, clues, threats or events, and don\'t move the scene somewhere new. React to what is happening right now.',
        '- Keep replies to 3-4 sentences: mostly dialogue, only a little description of what {{char}} does.',
        '- Where: {{location}}',
        '- Also here: {{present}}',
        '- Right now: {{situation}}',
        '- Goal: {{goal}}]',
    ].join('\n'),
    npcV30: [
        '[You play only {{npc}}, a side character in this story.',
        '{{description}}',
        '{{npc}} uses {{pronouns}} pronouns.',
        'Attitude toward the party: {{attitude}}.',
        'Never speak or act for {{player}} or {{party}}, and never narrate the scene. Reply with one or two short lines of dialogue and at most one brief action. Don\'t invent new plot.]',
    ].join('\n'),
    room: [
        '[The room {{char}} is in right now on the map. Use what is really here; don\'t invent other furniture or exits.',
        '{{room}}',
        'In it: {{things}}',
        'Ways out: {{exits}}]',
    ].join('\n'),
    roomV33: [
        '[The room {{char}} is in right now on the map. Use what is really here; don\'t invent other furniture or exits.',
        '{{room}}',
        'In it: {{things}}',
        'Ways out: {{exits}}',
        'Rooms {{char}} knows of in this place: {{known}}',
        'Never name a room, door, passage, route or item that is not listed above: {{char}} doesn\'t know the rest of this place.]',
    ].join('\n'),
});

export const DEFAULT_LENGTHS = Object.freeze({
    short: 'one short sentence',
    normal: '3-4 sentences, mostly dialogue, only a little action',
    long: '4-6 sentences at most',
});

const PLUGIN_KEYS = ['player', 'party', 'location', 'present', 'situation', 'goal', 'brief', 'length', 'npc', 'description', 'pronouns', 'attitude', 'knowledge', 'happened', 'scenecard', 'people', 'timeline', 'rules', 'avoid', 'room', 'things', 'exits', 'known', 'here'];
const KEY_RE = new RegExp(`\\{\\{(${PLUGIN_KEYS.join('|')})\\}\\}`, 'g');

/**
 * Fill a template. A line with any empty plugin placeholder is removed.
 * If the removed line was the one carrying the closing "]", the bracket is kept.
 * @param {string} template
 * @param {Record<string, string>} vars
 */
export function renderTemplate(template, vars) {
    const lines = String(template ?? '').split('\n');
    const out = [];
    let lostClosingBracket = false;
    for (const line of lines) {
        const keys = [...line.matchAll(KEY_RE)].map(m => m[1]);
        if (keys.length && keys.some(k => !String(vars[k] ?? '').trim())) {
            if (/\]\s*$/.test(line)) lostClosingBracket = true;
            continue;
        }
        // A list ("- ..." lines) after a label starts on its own line.
        out.push(line.replace(KEY_RE, (_, k, offset) => {
            const v = String(vars[k] ?? '').trim();
            return line.slice(0, offset).trim() && (v.includes('\n') || v.startsWith('- ')) ? `\n${v}` : v;
        }).replace(/[ \t]+\n/g, '\n'));
    }
    let text = out.join('\n').trim();
    if (lostClosingBracket && text.startsWith('[') && !text.endsWith(']')) text += ']';
    return text;
}

/**
 * How many tokens the note may take: the player's "max tokens added to local prompts" setting,
 * and never more than a sixth of what the live context leaves after the response. The context size
 * and response length are SillyTavern's current settings, so a smaller model is respected.
 * @param {{injectionMaxTokens?: number}} s settings
 * @param {{maxContext?: number, responseLength?: number}} live
 */
export function noteBudget(s, { maxContext = 0, responseLength = 0 } = {}) {
    const wanted = Number(s?.injectionMaxTokens) || DEFAULT_NOTE_TOKENS;
    const free = Number(maxContext) > 0 ? Math.floor(Math.max(0, Number(maxContext) - (Number(responseLength) || 0)) / 6) : Infinity;
    return Math.max(MIN_NOTE_TOKENS, Math.min(wanted, free));
}

export const DEFAULT_NOTE_TOKENS = 600;
export const MIN_NOTE_TOKENS = 150;

/** When the note is too long, these parts give way first (the brief, "happened" and the combat line never do). */
export const SHRINK_ORDER = Object.freeze(['avoid', 'knowledge', 'room', 'state', 'scene']);

/**
 * Fit the note's parts into a token budget. parts: [{key, text}] in display order. Parts are
 * shortened in SHRINK_ORDER (the least important first, dropped entirely when they can't help),
 * so the DM's brief and what just happened always arrive whole. Returns the texts, in order.
 */
export function fitNote(parts, maxTokens) {
    const out = parts.map(p => ({ ...p }));
    const total = () => out.reduce((n, p) => n + estimateTokens(p.text), 0);
    let over = total() - maxTokens;
    for (const key of SHRINK_ORDER) {
        if (over <= 0) break;
        const part = out.find(p => p.key === key && p.text);
        if (!part) continue;
        const have = estimateTokens(part.text);
        // A little margin for the "…]" that closes a shortened part, so the cut never spills over.
        const keep = have - over - 2;
        // Too little left to say anything useful: drop the part instead of leaving a stub.
        part.text = keep < 40 ? '' : trimToTokens(part.text, keep).replace(/\s*…$/, '…]');
        over = total() - maxTokens;
    }
    return out.map(p => p.text).filter(Boolean);
}

/** Map a DM length word to the user's wording. */
export function lengthText(length, lengths = DEFAULT_LENGTHS) {
    const key = ['short', 'normal', 'long'].includes(String(length)) ? String(length) : 'normal';
    return String(lengths?.[key] || DEFAULT_LENGTHS[key]);
}

/** Pronouns phrase from a gender word. */
export function pronounsFor(gender) {
    if (gender === 'male') return 'he/him';
    if (gender === 'female') return 'she/her';
    return '';
}
