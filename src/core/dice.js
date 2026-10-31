// Dice: random numbers, dice notation, and 5e helpers.
// Pure module (no SillyTavern imports) so it can be tested in Node.

/**
 * Cryptographically strong integer in [1, sides].
 * Rejection sampling avoids modulo bias.
 */
export function rollDie(sides) {
    sides = Math.floor(Number(sides));
    if (!Number.isFinite(sides) || sides < 1) return 0;
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj?.getRandomValues) {
        return 1 + Math.floor(Math.random() * sides);
    }
    const limit = Math.floor(0x100000000 / sides) * sides;
    const buf = new Uint32Array(1);
    let value;
    do {
        cryptoObj.getRandomValues(buf);
        value = buf[0];
    } while (value >= limit);
    return 1 + (value % sides);
}

/** Uniform float in [0, 1). */
export function random01() {
    return (rollDie(1000000) - 1) / 1000000;
}

/**
 * Parse dice notation like "1d20+5", "2d6 + 3", "d8", "4d6kh3", "1d20-1", "3".
 * Supports several terms joined by + or -.
 * @returns {{terms: Array<{count:number, sides:number, keep?:{type:'h'|'l', n:number}, sign:number} | {flat:number, sign:number}>} | null}
 */
export function parseNotation(notation) {
    if (notation === null || notation === undefined) return null;
    const text = String(notation).toLowerCase().replace(/\s+/g, '');
    if (!text) return null;
    const termRegex = /([+-]?)(?:(\d*)d(\d+)(?:k([hl])(\d+))?|(\d+))/gy;
    const terms = [];
    let match;
    let consumed = 0;
    while ((match = termRegex.exec(text)) !== null) {
        if (match[0] === '') break;
        const sign = match[1] === '-' ? -1 : 1;
        if (match[3] !== undefined) {
            const count = match[2] ? parseInt(match[2], 10) : 1;
            const sides = parseInt(match[3], 10);
            if (count < 1 || count > 100 || sides < 1 || sides > 1000) return null;
            const term = { count, sides, sign };
            if (match[4]) term.keep = { type: /** @type {'h'|'l'} */ (match[4]), n: Math.min(parseInt(match[5], 10), count) };
            terms.push(term);
        } else {
            terms.push({ flat: parseInt(match[6], 10), sign });
        }
        consumed = termRegex.lastIndex;
    }
    if (consumed !== text.length || !terms.length) return null;
    return { terms };
}

/**
 * Roll dice notation.
 * @param {string} notation e.g. "1d20+5"
 * @param {{advantage?: 'advantage'|'disadvantage'|'none'|string, rng?: (sides:number)=>number}} [options]
 * @returns {{notation:string, total:number, rolls:number[], dropped:number[], modifier:number, natural:number|null, detail:string} | null}
 */
/** The dice in a damage text ("2d4 piercing", "3d6 fire, half on a save", "5"), or ''. */
export function damageDice(text) {
    const m = String(text ?? '').match(/\d*d\d+(?:\s*[+-]\s*\d+)?|^\s*\d+\b/i);
    return m ? m[0].replace(/\s+/g, '').trim() : '';
}

/**
 * Damage from a saving throw: all of it on a failure, half (rounded down) on a success when
 * half is true, else none. Returns {total, half, detail} or null when nothing is taken.
 */
export function saveDamage(damage, failed, half = false, options = {}) {
    const dice = damageDice(damage);
    if (!dice || (!failed && !half)) return null;
    const r = roll(dice, options);
    if (!r) return null;
    const total = failed ? r.total : Math.floor(r.total / 2);
    return total > 0 ? { total, half: !failed, detail: r.detail } : null;
}

export function roll(notation, options = {}) {
    const parsed = parseNotation(notation);
    if (!parsed) return null;
    const rng = options.rng || rollDie;
    const adv = normalizeAdvantage(options.advantage);
    let total = 0;
    let modifier = 0;
    const rolls = [];
    const dropped = [];
    let natural = null;
    const detailParts = [];

    parsed.terms.forEach((term, index) => {
        if ('flat' in term) {
            total += term.sign * term.flat;
            modifier += term.sign * term.flat;
            detailParts.push(`${term.sign < 0 ? '- ' : (index ? '+ ' : '')}${term.flat}`);
            return;
        }
        let faces = [];
        // Advantage/disadvantage applies to a single d20 term.
        if (term.sides === 20 && term.count === 1 && adv !== 'none' && !term.keep) {
            const a = rng(20);
            const b = rng(20);
            const kept = adv === 'advantage' ? Math.max(a, b) : Math.min(a, b);
            const other = kept === a ? b : a;
            faces = [kept];
            dropped.push(other);
            natural = kept;
            detailParts.push(`${index && term.sign > 0 ? '+ ' : ''}${term.sign < 0 ? '- ' : ''}d20 (${a}, ${b} → ${kept})`);
        } else {
            for (let i = 0; i < term.count; i++) faces.push(rng(term.sides));
            if (term.keep) {
                const sorted = [...faces].sort((x, y) => term.keep.type === 'h' ? y - x : x - y);
                const keep = sorted.slice(0, term.keep.n);
                const drop = sorted.slice(term.keep.n);
                dropped.push(...drop);
                faces = keep;
            }
            if (term.sides === 20 && faces.length === 1 && natural === null) natural = faces[0];
            detailParts.push(`${index && term.sign > 0 ? '+ ' : ''}${term.sign < 0 ? '- ' : ''}${term.count}d${term.sides} (${faces.join(', ')})`);
        }
        rolls.push(...faces);
        total += term.sign * faces.reduce((s, v) => s + v, 0);
    });

    return {
        notation: String(notation).replace(/\s+/g, ''),
        total,
        rolls,
        dropped,
        modifier,
        natural,
        detail: detailParts.join(' '),
    };
}

export function normalizeAdvantage(value) {
    const v = String(value ?? '').toLowerCase();
    if (v.startsWith('adv')) return 'advantage';
    if (v.startsWith('dis')) return 'disadvantage';
    return 'none';
}

/** 5e ability score → modifier. */
export function abilityModifier(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 0;
    return Math.floor((n - 10) / 2);
}

export function formatModifier(mod) {
    const n = Number(mod) || 0;
    return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Decide the outcome of a check.
 * Natural 20 / natural 1 matter for attacks; for checks they are flavor
 * (we still flag them so the DM can play them up).
 */
export function judge(total, dc, natural = null, kind = 'check') {
    const result = { success: null, critical: false, fumble: false };
    if (natural === 20) result.critical = true;
    if (natural === 1) result.fumble = true;
    if (dc === null || dc === undefined || dc === '' || !Number.isFinite(Number(dc))) return result;
    if (kind === 'attack') {
        if (natural === 20) { result.success = true; return result; }
        if (natural === 1) { result.success = false; return result; }
    }
    result.success = total >= Number(dc);
    return result;
}

/**
 * Read a die result the player typed, e.g. "14", "I rolled a 17", "nat 20", "rolled 12 total 17".
 * @returns {{natural:number|null, total:number|null}|null}
 */
export function parsePlayerRoll(text, dieSides = 20) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    let natural = null;
    let total = null;
    const nat = t.match(/\bnat(?:ural)?\s*(\d{1,3})\b/);
    if (nat) natural = parseInt(nat[1], 10);
    const tot = t.match(/\b(?:total|totals|for a total of|=)\s*(?:of\s*)?(-?\d{1,3})\b/);
    if (tot) total = parseInt(tot[1], 10);
    if (natural === null) {
        // First standalone number in the message.
        const nums = [...t.matchAll(/(?<![\w.])(\d{1,3})(?![\w.])/g)].map(m => parseInt(m[1], 10));
        const candidates = nums.filter(n => total === null || n !== total);
        if (candidates.length) {
            const first = candidates[0];
            if (first >= 1 && first <= dieSides) natural = first;
            else if (total === null) total = first;
        }
    }
    if (natural !== null && (natural < 1 || natural > dieSides)) natural = null;
    if (natural === null && total === null) return null;
    return { natural, total };
}

/**
 * The dice of a resolved roll request for its card: "(18, 7 → 18, advantage)" when two d20 were
 * rolled for advantage or disadvantage (so nobody wonders whether it was applied), else "(18)".
 * @param {{die?: number, advantage?: string, dice?: Array<{sides: number, value: number}>}} request
 */
export function diceText(request, natural) {
    const adv = request?.advantage && request.advantage !== 'none' ? request.advantage : '';
    const die = Number(request?.die) || 20;
    const both = adv && Array.isArray(request?.dice) ? request.dice.filter(d => Number(d.sides) === die).map(d => Number(d.value)).slice(0, 2) : [];
    return both.length === 2 ? `(${both.join(', ')} → ${natural ?? '?'}, ${adv})` : `(${natural ?? '?'})`;
}
