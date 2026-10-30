// What a character said out loud, for the speech bubble on the map: the parts of their reply inside
// quotation marks (the notes ask for dialogue in quotes), else the reply without its *actions*.
// Pure module.

const MAX_BUBBLE = 260;

/**
 * The spoken words in a reply. Several quoted bits are joined in order. With no quotes at all, the
 * text without *actions* and markup stands in. '' when there is nothing to say.
 */
export function dialogueOf(text, max = MAX_BUBBLE) {
    // Models mix “curly” and "straight" quotes in one reply; pairing them by kind would put the
    // *action* between two lines inside the bubble. One kind of quote, paired in order.
    const t = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/[“”„‟«»]/g, '"');
    const parts = t.split('"');
    const quotes = [];
    for (let i = 1; i < parts.length; i += 2) {
        // An odd quote at the end is a line the model forgot to close: still spoken.
        const q = parts[i].replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
        if (q.length >= 2) quotes.push(q);
    }
    let out = quotes.join(' ');
    if (!out) out = t.replace(/\*[^*]*\*/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
    return out;
}

/** How long the words take to appear, in ms: the voice's own length when there is one, else a reading pace. */
export function typingMs(chars, voiceSeconds = 0) {
    const n = Math.max(1, Number(chars) || 1);
    if (Number.isFinite(voiceSeconds) && voiceSeconds > 0.5) return Math.max(600, Math.min(voiceSeconds * 900, n * 120));
    return Math.max(500, Math.min(n * 22, 7000));
}

/** How long a bubble lingers after the character has finished talking, in ms. */
export const LINGER_MS = 5000;
