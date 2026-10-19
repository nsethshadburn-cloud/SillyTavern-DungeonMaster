// What the plugin tells the roleplay model (Skyfall, Orion, ...). These are editable in the
// settings, like a small system prompt of their own, with a "reset to default" for each.
// Pure module (no SillyTavern imports).
//
// Placeholders the plugin fills in: {{player}} {{party}} {{location}} {{present}} {{situation}}
// {{goal}} {{brief}} {{length}} {{npc}} {{description}} {{pronouns}} {{attitude}}.
// SillyTavern's own macros ({{char}}, {{user}}, ...) also work. A line containing a plugin
// placeholder that's empty is dropped, so empty fields never leave half-sentences behind.

export const DEFAULT_TEMPLATES = Object.freeze({
    scene: [
        '[Roleplay notes for {{char}}. Follow them, never mention them.',
        '- You play only {{char}}, traveling with {{player}}. Never speak or act for {{player}} or anyone else.',
        '- You are a companion, not the storyteller. Don\'t invent places, people, clues, threats or events, and don\'t move the scene somewhere new. React to what is happening right now.',
        '- Keep replies to 3-4 sentences: mostly dialogue, only a little description of what {{char}} does.',
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
    combat: '[A fight is happening. The game master narrates every action and result. {{char}} only says one short line or quick reaction: no actions, no describing the fight.]',
    npc: [
        '[You play only {{npc}}, a side character in this story.',
        '{{description}}',
        '{{npc}} uses {{pronouns}} pronouns.',
        'Attitude toward the party: {{attitude}}.',
        'Never speak or act for {{player}} or {{party}}. Reply with 1-3 sentences, mostly dialogue. Don\'t invent new plot.]',
    ].join('\n'),
});

export const DEFAULT_LENGTHS = Object.freeze({
    short: 'one short sentence',
    normal: '3-4 sentences, mostly dialogue, only a little action',
    long: 'up to two short paragraphs',
});

const PLUGIN_KEYS = ['player', 'party', 'location', 'present', 'situation', 'goal', 'brief', 'length', 'npc', 'description', 'pronouns', 'attitude'];
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
        out.push(line.replace(KEY_RE, (_, k) => String(vars[k] ?? '').trim()));
    }
    let text = out.join('\n').trim();
    if (lostClosingBracket && text.startsWith('[') && !text.endsWith(']')) text += ']';
    return text;
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
