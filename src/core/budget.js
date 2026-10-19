// Cost estimation and budget checks. Pure module.
// SillyTavern's Claude proxy does not return token usage, so costs are
// ESTIMATES from text length. The Anthropic console has the real numbers.

import { estimateTokens } from './text.js';

/**
 * @param {{stableText:string, volatileText:string, outputText:string, thinkingAllowance:number,
 *          prices:{input:number, output:number, cacheRead:number, cacheWrite:number}, cacheHit:boolean, cachingEnabled:boolean}} p
 * prices are USD per million tokens
 */
export function estimateCallCost(p) {
    const stable = estimateTokens(p.stableText);
    const volatile = estimateTokens(p.volatileText);
    const output = estimateTokens(p.outputText) + (p.thinkingAllowance || 0);
    const per = (tokens, price) => tokens * (price || 0) / 1_000_000;
    let inputCost;
    if (p.cachingEnabled && stable >= 1024) {
        inputCost = p.cacheHit ? per(stable, p.prices.cacheRead) : per(stable, p.prices.cacheWrite);
        inputCost += per(volatile, p.prices.input);
    } else {
        inputCost = per(stable + volatile, p.prices.input);
    }
    const outputCost = per(output, p.prices.output);
    return {
        inputTokens: stable + volatile,
        outputTokens: output,
        usd: round6(inputCost + outputCost),
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
