// Cost estimation and budget checks. Pure module.
// SillyTavern's Claude proxy does not return token usage, so costs are
// ESTIMATES from text length. The Anthropic console has the real numbers.

import { estimateTokens } from './text.js';

/** Claude only caches a prefix this long or longer. */
export const MIN_CACHE_TOKENS = 1024;

/** Cache writes cost more than plain input: 1.25× for the 5-minute cache, 2× for the 1-hour one. */
export function cacheWriteMultiplier(ttlMinutes) {
    return Number(ttlMinutes) >= 60 ? 2 : 1.25;
}

/**
 * @param {{blocks:Array<{text:string, tokens?:number, cache?:'hit'|'write'|'none'}>, outputText:string, thinkingAllowance:number,
 *          prices:{input:number, output:number, cacheRead:number}, writeMultiplier?:number}} p
 * blocks are the prompt in order; prices are USD per million tokens.
 * A block marked 'hit' or 'write' only counts as cached once the prompt up to it reaches MIN_CACHE_TOKENS.
 */
export function estimateCallCost(p) {
    const per = (tokens, price) => tokens * (price || 0) / 1_000_000;
    const writeMultiplier = p.writeMultiplier ?? 1.25;
    let prefix = 0;
    let inputTokens = 0;
    let inputCost = 0;
    for (const block of p.blocks) {
        const tokens = Number.isFinite(block.tokens) ? block.tokens : estimateTokens(block.text);
        prefix += tokens;
        inputTokens += tokens;
        const cacheable = prefix >= MIN_CACHE_TOKENS;
        if (cacheable && block.cache === 'hit') inputCost += per(tokens, p.prices.cacheRead);
        else if (cacheable && block.cache === 'write') inputCost += per(tokens, p.prices.input) * writeMultiplier;
        else inputCost += per(tokens, p.prices.input);
    }
    const output = estimateTokens(p.outputText) + (p.thinkingAllowance || 0);
    return {
        inputTokens,
        outputTokens: output,
        usd: round6(inputCost + per(output, p.prices.output)),
    };
}

export function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** "Night" rolls over at 6am so a session past midnight stays one night. */
export function nightKey(date = new Date()) {
    const d = new Date(date.getTime() - 6 * 3600 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @returns {{level:'ok'|'tight'|'blocked', monthUsd:number, nightUsd:number, monthPct:number}}
 */
export function budgetStatus({ monthUsd = 0, nightUsd = 0, monthlyCap = 20, nightlySoftCap = 0 }) {
    const monthPct = monthlyCap > 0 ? monthUsd / monthlyCap : 0;
    let level = 'ok';
    if (monthlyCap > 0 && monthPct >= 1) level = 'blocked';
    else if (monthlyCap > 0 && monthPct >= 0.8) level = 'tight';
    else if (nightlySoftCap > 0 && nightUsd >= nightlySoftCap) level = 'tight';
    return { level, monthUsd: round6(monthUsd), nightUsd: round6(nightUsd), monthPct };
}

export function formatUsd(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
}

function round6(n) {
    return Math.round(n * 1e6) / 1e6;
}
