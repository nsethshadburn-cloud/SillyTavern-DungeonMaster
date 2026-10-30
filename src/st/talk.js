// A guard or a local who has just seen the party may say a word. Instead of a canned line, the line
// comes from the local model (through the NPC's own card, like any NPC), briefed to be ONE short
// gruff sentence: an order, a warning, a passing remark. Never chatty: one such line per turn at
// most; everyone else that turn says their canned line. Off with the "guards talk" setting.

import { makeSpeak } from './actors.js';
import { postNpc } from './messages.js';
import { settings } from './settings.js';

const queue = [];

/** Something to say, with the canned line to fall back on. */
export function queueTalk(item) {
    queue.push(item);
}

/** Say what's queued: one line through the model, the rest canned. */
export async function drainTalk() {
    const items = queue.splice(0);
    if (!items.length) return;
    const [first, ...rest] = items;
    for (const r of rest) postNpc(r.name, `"${r.fallback}"`).catch(() => { });
    if (settings().guardsTalk === false) { await postNpc(first.name, `"${first.fallback}"`).catch(() => { }); return; }
    try {
        const did = await makeSpeak(first.name, first.brief, { length: 'short' });
        if (!did) await postNpc(first.name, `"${first.fallback}"`);
    } catch (error) {
        console.warn('[Dungeon Master] a line through the local model failed; canned instead', error);
        await postNpc(first.name, `"${first.fallback}"`).catch(() => { });
    }
}
