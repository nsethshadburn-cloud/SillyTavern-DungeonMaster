// Text helpers shared by the extension. Pure module.

/**
 * Pull the first JSON object out of model output (handles ```json fences,
 * leading prose, trailing commas and smart quotes).
 * @returns {any|null}
 */
export function extractJson(text) {
    if (!text) return null;
    let s = String(text);
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1];
    const start = s.indexOf('{');
    if (start === -1) return null;
    // Walk to the matching closing brace, respecting strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    let candidate = end === -1 ? s.slice(start) : s.slice(start, end + 1);
    const attempts = [
        candidate,
        candidate.replace(/,\s*([}\]])/g, '$1'),
        candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, '\'').replace(/,\s*([}\]])/g, '$1'),
    ];
    if (end === -1) {
        // Truncated output: try closing it.
        attempts.push(closeTruncatedJson(candidate));
    }
    for (const a of attempts) {
        try {
            return JSON.parse(a);
        } catch { /* try next */ }
    }
    return null;
}

function closeTruncatedJson(s) {
    let inStr = false;
    let esc = false;
    const stack = [];
    for (const c of s) {
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') stack.pop();
    }
    let out = s;
    if (inStr) out += '"';
    out = out.replace(/,\s*$/, '');
    while (stack.length) out += stack.pop() === '{' ? '}' : ']';
    return out.replace(/,\s*([}\]])/g, '$1');
}

/** Rough token estimate (no tokenizer): ~3.6 characters per token for English prose. */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 3.6);
}

/** Trim text to roughly maxTokens, keeping the END (most recent) if keepEnd. */
export function trimToTokens(text, maxTokens, keepEnd = false) {
    const s = String(text ?? '');
    const maxChars = Math.max(0, Math.floor(maxTokens * 3.6));
    if (s.length <= maxChars) return s;
    return keepEnd ? '…' + s.slice(s.length - maxChars) : s.slice(0, maxChars) + '…';
}

/** Strip a leading "Name:" the model sometimes echoes. */
export function stripSpeakerPrefix(text, name) {
    let s = String(text ?? '').trim();
    if (name) {
        const re = new RegExp(`^\\**${escapeRegex(name)}\\**\\s*:\\s*`, 'i');
        // Models sometimes echo the name more than once ("Name: Name: ...").
        for (let i = 0; i < 3 && re.test(s); i++) s = s.replace(re, '').trim();
    }
    return s.trim();
}

/** Remove a thinking block if the model left one in plain text. */
export function stripThinking(text, suffixes = ['<channel|>', '</think>', '</thinking>']) {
    let s = String(text ?? '');
    for (const suffix of suffixes) {
        const idx = s.lastIndexOf(suffix);
        if (idx !== -1) s = s.slice(idx + suffix.length);
    }
    return s.replace(/^\s*<\|?channel\|?>\s*/i, '').trim();
}

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Safe file-name slug: letters, numbers, _ and - only. */
export function slug(s, max = 40) {
    const out = String(s ?? '')
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s]+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, max);
    return out || 'x';
}

/** Short random id. */
export function shortId() {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) out += chars[b % chars.length];
    return out;
}

/** Normalize a name for loose matching ("Judy Hopps" ~ "judy"). */
export function nameKey(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find best match for a speaker name among candidates (exact, then first-name, then contains). */
export function matchName(name, candidates) {
    const key = nameKey(name);
    if (!key) return null;
    let hit = candidates.find(c => nameKey(c) === key);
    if (hit) return hit;
    hit = candidates.find(c => nameKey(c).split(' ')[0] === key.split(' ')[0]);
    if (hit) return hit;
    hit = candidates.find(c => nameKey(c).includes(key) || key.includes(nameKey(c)));
    return hit ?? null;
}

const STOPWORDS = new Set(('a an and or but so if then than the to of in on at for with from by as into onto up down out over about '
    + 'is are was were be been am it its this that these those there here i you he she we they me him her us them my your his our their '
    + 'not no just do does did don\'t can can\'t will would could should have has had i\'m it\'s that\'s what who how why when where all too very '
    + 'one more some any something back off again still').split(/\s+/));

function phraseTokens(text) {
    return String(text ?? '').toLowerCase().replace(/[\u2018\u2019]/g, '\'').replace(/[*_"\u201c\u201d]/g, ' ').match(/[a-z']+/g) || [];
}

/**
 * Phrases a character keeps reusing across their recent replies (tics like "presses her back
 * against the wall" or "the same"), so their note can ask for something different.
 * Long phrases (4-7 words) count when they show up in 2+ replies; short ones (2-3 words, at least
 * one real word) in 3+ replies. Phrases with an excluded word (names) are skipped.
 * @param {string[]} texts the character's recent replies
 * @param {{exclude?: string[], max?: number}} [o]
 */
export function repeatedPhrases(texts, { exclude = [], max = 5 } = {}) {
    const banned = new Set(exclude.flatMap(n => phraseTokens(n)));
    const docs = texts.map(phraseTokens);
    const kept = [];
    const count = (n) => {
        const seen = new Map();
        for (const words of docs) {
            const here = new Set();
            for (let i = 0; i + n <= words.length; i++) {
                const gram = words.slice(i, i + n);
                if (gram.some(w => banned.has(w)) || gram.every(w => STOPWORDS.has(w))) continue;
                here.add(gram.join(' '));
            }
            for (const g of here) seen.set(g, (seen.get(g) || 0) + 1);
        }
        return seen;
    };
    for (let n = 7; n >= 2; n--) {
        const need = n >= 4 ? 2 : 3;
        for (const [gram, hits] of count(n)) {
            if (hits < need || kept.some(k => k.includes(gram))) continue;
            // Short phrases must not start or end on a filler word ("the same" is fine, "same the" isn't a phrase anyway).
            const words = gram.split(' ');
            if (n < 4 && (STOPWORDS.has(words[words.length - 1]))) continue;
            kept.push(gram);
        }
    }
    return kept.slice(0, max);
}
