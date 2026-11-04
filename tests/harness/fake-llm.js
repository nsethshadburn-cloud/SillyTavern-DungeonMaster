// A fake of src/st/llm.js: the table's answers are scripted (a queue of rulings for the referee, a
// queue of stories for the storyteller, each a JSON object or a function of the prompt), every
// prompt is kept for assertions, and the local model answers from its own queue.
export class BudgetError extends Error { }

export const llm = {
    /** Scripted referee replies, oldest first: a string, an object (JSON-encoded), or a function (call args) => string|object. */
    referee: [],
    /** Scripted storyteller replies, oldest first. */
    story: [],
    /** Scripted replies for any other Claude call (the opening the wizard asks for, a recap), oldest first. */
    claude: [],
    /** Scripted local replies, oldest first. */
    local: [],
    /** Every Claude call made: {system, layers, user, model, label}. */
    calls: [],
    localCalls: [],
    /** The last referee call and the last storyteller call. */
    get lastReferee() { return [...this.calls].reverse().find(c => /^referee/.test(c.label)) ?? null; },
    get lastStory() { return [...this.calls].reverse().find(c => /^storyteller/.test(c.label)) ?? null; },
    reset() { this.referee = []; this.story = []; this.claude = []; this.local = []; this.calls = []; this.localCalls = []; },
};

export function resolveDmConnection() {
    return { profile: null, model: 'claude-sonnet-5-5' };
}

export async function callClaude(args) {
    llm.calls.push(args);
    const queue = /^referee/.test(args.label) ? llm.referee : /^storyteller/.test(args.label) ? llm.story : llm.claude;
    if (!queue.length) throw new Error(`no scripted reply for "${args.label}"`);
    let next = queue.shift();
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
