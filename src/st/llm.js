// Model calls: Claude (the DM) and the local model (helper / NPC voices).
// Claude goes through SillyTavern's own backend, so your saved API key is used and never exposed.

import { ST, waitUntilIdle } from './st.js';
import { settings, profileById, connectionProfiles, recordSpend, currentSpend, pricesFor, modelFor } from './settings.js';
import { estimateCallCost, budgetStatus, cacheWriteMultiplier } from '../core/budget.js';
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

/** The connection for Claude calls, and the main DM model. Per-job models come from modelFor(). */
export function resolveDmConnection() {
    const s = settings();
    let profile = profileById(s.dmProfileId);
    if (!profile) profile = connectionProfiles().find(p => p.api === 'claude') ?? null;
    return {
        profile,
        model: s.dmModel || profile?.model || 'claude-sonnet-5-5',
    };
}

// What Claude has probably cached, per model: prompt-prefix hash -> last time it was sent.
// Only used for the cost ESTIMATE; Claude does the real caching.
const cacheSeen = new Map();

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return String(h);
}

/** Sent between context layers so the roles alternate; it never changes, so it caches. */
const LAYER_ACK = 'Noted.';

export class BudgetError extends Error { }

/**
 * Call Claude.
 * The prompt is sent in layers, most stable first, so Claude's prompt cache can reuse them:
 *   system  = rules, bible, sheets (cached with claude.enableSystemPromptCache)
 *   layers  = slower-changing context, each its own user message (cached with claude.cachingAtDepth: 2)
 *   user    = what changes every call
 * @param {{system:string, layers?:string[], user:string, task?:string, model?:string, maxTokens?:number, label:string, effort?:string, force?:boolean, signal?:AbortSignal}} p
 *  task = the job (core/models.js TASKS) whose model to use; model = use exactly this model instead
 * @returns {Promise<{text:string, usd:number, inputTokens:number, outputTokens:number, ms:number, model:string}>}
 */
export async function callClaude({ system, layers = [], user, task = '', model: modelOverride = '', maxTokens, label, effort, force = false, signal = null }) {
    const s = settings();
    const status = budgetStatus({ ...currentSpend(), monthlyCap: Number(s.monthlyCap), nightlySoftCap: Number(s.nightlySoftCap) });
    if (status.level === 'blocked' && !force) {
        throw new BudgetError('Monthly Claude budget reached.');
    }
    const { profile, model: mainModel } = resolveDmConnection();
    const model = modelOverride || (task ? modelFor(task) : mainModel);
    const ctx = ST.context();
    const started = Date.now();
    const messages = [{ role: 'system', content: system }];
    for (const layer of layers) {
        messages.push({ role: 'user', content: layer }, { role: 'assistant', content: LAYER_ACK });
    }
    messages.push({ role: 'user', content: user });
    const request = {
        stream: false,
        messages,
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

    const cost = estimateCallCost({
        blocks: cacheStates(model, [system, ...layers.flatMap(l => [l, LAYER_ACK])], user),
        outputText: text,
        thinkingAllowance: Number(s.thinkingAllowance) || 0,
        prices: pricesFor(model),
        writeMultiplier: cacheWriteMultiplier(s.cacheTtlMinutes),
    });
    recordSpend(cost.usd);
    if (!text) {
        throw new Error(`Claude returned an empty reply (${label}). It may have declined the request; try rephrasing or check the server console.`);
    }
    return { text, usd: cost.usd, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, ms, model };
}

/** Mark each cacheable block as a likely cache hit or write (estimate only), then remember what was sent. */
function cacheStates(model, cacheable, user) {
    const s = settings();
    const blocks = [];
    const now = Date.now();
    const ttl = (Number(s.cacheTtlMinutes) || 5) * 60 * 1000;
    let prefix = model;
    for (const text of cacheable) {
        prefix = hashString(prefix + '\u0000' + text);
        if (!s.cachingEnabled) {
            blocks.push({ text, cache: 'none' });
            continue;
        }
        const seen = cacheSeen.get(prefix);
        blocks.push({ text, cache: seen && now - seen < ttl ? 'hit' : 'write' });
        cacheSeen.set(prefix, now);
    }
    if (cacheSeen.size > 200) {
        for (const [k, at] of cacheSeen) if (now - at > ttl) cacheSeen.delete(k);
    }
    blocks.push({ text: user, cache: 'none' });
    return blocks;
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
