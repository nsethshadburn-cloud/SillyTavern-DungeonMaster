// Reading SillyTavern's dice messages ("Amber rolls a d20. The result is: 17 (17)") so the player
// doesn't have to type the number in again. Pure module.

/**
 * @param {string} text a SillyTavern dice message
 * @returns {{who:string, count:number, sides:number, total:number, rolls:number[]}|null}
 */
export function parseRollMessage(text) {
    const m = String(text ?? '').replace(/<[^>]+>/g, '').trim()
        .match(/^(.+?) rolls an? (\d*)d(\d+)\s*(?:[+-]\s*\d+)?\s*\.\s*The result is:?\s*(-?\d+)\s*(?:\(([^)]*)\))?/i);
    if (!m) return null;
    const count = Number(m[2]) || 1;
    const sides = Number(m[3]);
    const total = Number(m[4]);
    let rolls = String(m[5] ?? '').match(/\d+/g)?.map(Number) ?? [];
    if (rolls.length !== count || rolls.some(r => r < 1 || r > sides)) {
        // No usable breakdown: a single die's result is the total.
        if (count !== 1 || total < 1 || total > sides) return null;
        rolls = [total];
    }
    return { who: m[1].trim(), count, sides, total, rolls };
}

/** Dice and flat bonus in a damage formula like "1d6+5 +3d6 Sneak Attack +6 Assassinate". */
export function damageDice(formula) {
    const text = String(formula ?? '');
    const dice = {};
    for (const [, n, sides] of text.matchAll(/(\d*)\s*d\s*(\d+)/gi)) {
        dice[Number(sides)] = (dice[Number(sides)] ?? 0) + (Number(n) || 1);
    }
    let bonus = 0;
    for (const [, sign, n] of text.replace(/(\d*)\s*d\s*(\d+)/gi, ' ').matchAll(/([+-])\s*(\d+)/g)) {
        bonus += sign === '-' ? -Number(n) : Number(n);
    }
    return { dice, bonus };
}

/**
 * Has the player rolled everything this request needs? Dice of other sizes are ignored.
 * @param {{kind:string, die?:number, advantage?:string, damage?:string}} request the pending roll request
 * @param {Array<{sides:number, value:number}>} rolled single dice read so far, oldest first
 * @returns {{done:false}|{done:true, natural:number|null, total:number|null}}
 *  checks: natural = the kept d20 (the plugin adds the modifier); damage: total = dice + flat bonus
 */
export function collectRoll(request, rolled) {
    if (request.kind === 'damage') {
        const { dice, bonus } = damageDice(request.damage);
        if (!Object.keys(dice).length) return { done: false };
        let total = bonus;
        for (const [sides, need] of Object.entries(dice)) {
            const got = rolled.filter(r => r.sides === Number(sides)).slice(0, need);
            if (got.length < need) return { done: false };
            total += got.reduce((a, r) => a + r.value, 0);
        }
        return { done: true, natural: null, total };
    }
    const sides = Number(request.die) || 20;
    const twoDice = request.advantage === 'advantage' || request.advantage === 'disadvantage';
    const got = rolled.filter(r => r.sides === sides).slice(0, twoDice ? 2 : 1).map(r => r.value);
    if (got.length < (twoDice ? 2 : 1)) return { done: false };
    const natural = request.advantage === 'advantage' ? Math.max(...got) : request.advantage === 'disadvantage' ? Math.min(...got) : got[0];
    return { done: true, natural, total: null };
}
