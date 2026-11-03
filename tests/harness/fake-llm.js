// A fake of src/st/llm.js: the DM's answers are scripted (a queue of JSON turns, or functions of the
// prompt), every prompt is kept for assertions, and the local model answers from its own queue.
export class BudgetError extends Error { }

export const llm = {
    /** Scripted Claude replies, oldest first: a string, an object (JSON-encoded), or a function (call args) => string|object. */
    claude: [],
    /** Scripted local replies, oldest first. */
    local: [],
    /** Every Claude call made: {system, layers, user, model, label}. */
    calls: [],
    localCalls: [],
    reset() { this.claude = []; this.local = []; this.calls = []; this.localCalls = []; },
};

export function resolveDmConnection() {
    return { profile: null, model: 'claude-sonnet-5-5' };
}

export async function callClaude(args) {
    llm.calls.push(args);
    if (!llm.claude.length) throw new Error(`no scripted DM reply for "${args.label}"`);
    let next = llm.claude.shift();
    if (typeof next === 'function') next = next(args);
    const text = typeof next === 'string' ? next : JSON.stringify(next);
    return { text, usd: 0.001, inputTokens: 100, outputTokens: 50, ms: 1, model: args.model || 'claude-sonnet-5-5' };
}

export function callLocal(args) {
    llm.localCalls.push(args);
    const next = llm.local.shift();
    return Promise.resolve(typeof next === 'function' ? next(args) : (next ?? '{}'));
}

export function cleanLocalOutput(text) { return String(text ?? ''); }
