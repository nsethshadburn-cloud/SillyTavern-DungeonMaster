// A fake of src/ui/status.js: the status strip's notes are kept so a test can read what the code did.
export const status = { notes: [], steps: [], finished: [], reset() { this.notes = []; this.steps = []; this.finished = []; } };

export function beginTurn(title) {
    status.notes.push(`[${title}]`);
    return {
        step(text) { status.steps.push(text); return { done(extra) { if (extra) status.steps.push(`  done: ${extra}`); }, fail(error) { status.steps.push(`  FAILED: ${error?.message || error}`); } }; },
        note(text) { status.notes.push(String(text)); },
        finish(text) { status.finished.push(String(text)); },
    };
}
export function turnHistory() { return []; }
export function hideStatus() { }
