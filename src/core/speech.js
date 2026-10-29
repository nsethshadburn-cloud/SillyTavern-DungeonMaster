// What a character said out loud, for the speech bubble on the map: the parts of their reply inside
// quotation marks (the notes ask for dialogue in quotes), else the reply without its *actions*.
// Pure module.

const MAX_BUBBLE = 260;

/**
 * The spoken words in a reply. Several quoted bits are joined in order. With no quotes at all, the
 * text without *actions* and markup stands in. '' when there is nothing to say.
 */
export function dialogueOf(text, max = MAX_BUBBLE) {
    const t = String(text ?? '').replace(/<[^>]+>/g, ' ');
    const quotes = [...t.matchAll(/"([^"]{2,})"|“([^”]{2,})”/g)].map(m => (m[1] ?? m[2]).replace(/\s+/g, ' ').trim()).filter(Boolean);
    let out = quotes.join(' ');
    if (!out) out = t.replace(/\*[^*]*\*/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
    return out;
}

/** How long the words take to appear, in ms: the voice's own length when there is one, else a reading pace. */
export function typingMs(chars, voiceSeconds = 0) {
    const n = Math.max(1, Number(chars) || 1);
    if (Number.isFinite(voiceSeconds) && voiceSeconds > 0.5) return Math.max(600, Math.min(voiceSeconds * 900, n * 120));
    return Math.max(600, Math.min(n * 32, 9000));
}

/** How long a bubble lingers after the character has finished talking, in ms. */
export const LINGER_MS = 5000;
