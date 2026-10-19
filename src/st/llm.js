// Model calls: Claude (the DM) and the local model (helper / NPC voices).
// Claude goes through SillyTavern's own backend, so your saved API key is used and never exposed.

import { ST, waitUntilIdle } from './st.js';
import { settings, profileById, connectionProfiles, recordSpend, currentSpend } from './settings.js';
import { estimateCallCost, budgetStatus } from '../core/budget.js';
import { stripThinking } from '../core/text.js';

// ---------------- Local model queue ----------------
// KoboldCpp handles one request at a time, so all of OUR local calls go through one queue,
// and each waits for SillyTavern's own generation to finish first.
let localChain = Promise.resolve();

function enqueueLocal(task) {
    const run = localChain.then(async () => {
        await waitUntilIdle();
        return task();
    });
    localChain = run.catch(() => { /* keep the chain alive */ });
    return run;
}

/**
 * Call a local/text model.
 * @param {{system:string, messages:Array<{role:'user'|'assistant'|'system', content:string, name?:string}>, maxTokens:number, profileId?:string, prefill?:string}} p
 * @returns {Promise<string>}
 */
export function callLocal({ system, messages, maxTokens, profileId = '', prefill = '' }) {
    return enqueueLocal(async () => {
        const profile = profileById(profileId);
        let text = '';
        if (profile) {
            const ctx = ST.context();
            const prompt = [{ role: 'system', content: system }, ...messages];
            const result = await ctx.ConnectionManagerRequestService.sendRequest(profile.id, prompt, maxTokens, {
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            });
            text = typeof result === 'string' ? result : (result?.content ?? '');
        } else {
            text = await ST.generateRaw({
                prompt: messages.map(m => ({ ...m })),
                systemPrompt: system,
                responseLength: maxTokens,
                prefill,
                trimNames: false,
            });
        }
        return cleanLocalOutput(text);
    });
}

/** Remove any thinking block using the user's reasoning template, then common fallbacks. */
export function cleanLocalOutput(text) {
    let s = String(text ?? '');
    try {
        const parsed = ST.context().parseReasoningFromString?.(s, { strict: false });
        if (parsed && parsed.reasoning) s = parsed.content;
    } catch { /* ignore */ }
    return stripThinking(s);
}

// ---------------- Claude ----------------

/** Pick the connection to use for the DM. */
export function resolveDmConnection() {
    const s = settings();
    let profile = profileById(s.dmProfileId);
    if (!profile) profile = connectionProfiles().find(p => p.api === 'claude') ?? null;
    return {
        profile,
        model: s.dmModel || profile?.model || 'claude-sonnet-5-5',
    };
}

let lastStableHash = '';
let lastCallAt = 0;

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return String(h);
}

export class BudgetError extends Error { }

/**
 * Call Claude.
 * @param {{system:string, user:string, maxTokens?:number, label:string, effort?:string, force?:boolean, signal?:AbortSignal}} p
 *  system = stable instructions (cache-friendly), user = everything that changes each call
 * @returns {Promise<{text:string, usd:number, inputTokens:number, outputTokens:number, ms:number}>}
 */
export async function callClaude({ system, user, maxTokens, label, effort, force = false, signal = null }) {
    const s = settings();
    const status = budgetStatus({ ...currentSpend(), monthlyCap: Number(s.monthlyCap), nightlySoftCap: Number(s.nightlySoftCap) });
    if (status.level === 'blocked' && !force) {
        throw new BudgetError('Monthly Claude budget reached.');
    }
    const { profile, model } = resolveDmConnection();
    const ctx = ST.context();
    const started = Date.now();
    const request = {
        stream: false,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        model,
        chat_completion_source: 'claude',
        max_tokens: maxTokens || Number(s.dmMaxTokens) || 6000,
        reasoning_effort: effort || s.dmEffort || 'low',
        include_reasoning: false,
        secret_id: profile?.['secret-id'] || undefined,
    };
    let json;
    try {
        json = await ctx.ChatCompletionService.processRequest(request, {}, false, signal);
    } catch (error) {
        throw new Error(`Claude call failed (${label}): ${error?.message || error}. Check the SillyTavern server console for details.`);
    }
    const text = extractClaudeText(json);
    const ms = Date.now() - started;

    const stableHash = hashString(system);
    const cacheHit = s.cachingEnabled && stableHash === lastStableHash && (Date.now() - lastCallAt) < 5 * 60 * 1000;
    lastStableHash = stableHash;
    lastCallAt = Date.now();
    const cost = estimateCallCost({
        stableText: system,
        volatileText: user,
        outputText: text,
        thinkingAllowance: Number(s.thinkingAllowance) || 0,
        prices: { input: Number(s.priceInput), output: Number(s.priceOutput), cacheRead: Number(s.priceCacheRead), cacheWrite: Number(s.priceCacheWrite) },
        cacheHit,
        cachingEnabled: Boolean(s.cachingEnabled),
    });
    recordSpend(cost.usd);
    if (!text) {
        throw new Error(`Claude returned an empty reply (${label}). It may have declined the request; try rephrasing or check the server console.`);
    }
    return { text, usd: cost.usd, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, ms };
}

/** SillyTavern returns {choices, content}; content is Claude's raw block list (thinking + text). */
function extractClaudeText(json) {
    if (!json) return '';
    if (Array.isArray(json.content)) {
        const text = json.content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n').trim();
        if (text) return text;
    }
    return String(json?.choices?.[0]?.message?.content ?? '').trim();
}
