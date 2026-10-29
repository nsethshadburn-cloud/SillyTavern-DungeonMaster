// Undo for deleted DM turns. Before each turn the game state is put aside (HP, conditions, items,
// gold, the fight, who's away, the clock, the map the party is on, a roll the DM is waiting for,
// the timeline, what the companions know and feel, the notes, the plot, the NPC roster); after the
// turn, the messages it wrote are noted. Deleting that turn's DM narration (or every message it
// wrote) puts the state back the way it was before the turn, so the story and the books agree.
// Only the newest turns can be undone (in order): undoing an older one would also wipe out what
// came after it. Kept in memory for this session, the last few turns.

import { ST } from './st.js';
import { campaign, saveDoc, saveMeta } from './campaign.js';
import { currentPlace, replacePlace } from './atlas.js';

const KEEP = 6;
let stack = [];
const META_KEYS = ['turn', 'timeline', 'happened', 'knowledge', 'minds', 'standing', 'objective', 'pacing', 'tableRules', 'eventHistory', 'recentEventTypes', 'lastDriftStageCalled', 'lastHandledPlayer'];
const DOC_KEYS = ['npcs', 'notes', 'story', 'plot'];

const keyOf = m => `${m?.send_date ?? ''}|${String(m?.mes ?? '').slice(0, 60)}`;
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Put the state aside before a turn. Returns the snapshot (pass it to sealTurn after). */
export function snapshotTurn(c = campaign()) {
    if (!c) return null;
    const cur = currentPlace(c);
    return {
        campaign: c.meta.id,
        from: ST.chat.length,
        world: clone(c.docs.world),
        placeKey: cur?.key ?? null,
        place: cur ? clone(cur.place) : null,
        pendingRoll: clone(c.meta.pendingRoll ?? null),
        stance: clone(c.meta.stance ?? {}),
        // What else a turn writes: the companions' knowledge and minds, the timeline, the pacing, the notes.
        meta: clone(Object.fromEntries(META_KEYS.map(k => [k, c.meta[k]]))),
        docs: clone(Object.fromEntries(DOC_KEYS.map(k => [k, c.docs[k]]))),
        messages: [],
        narration: [],
    };
}

/** After the turn: what it wrote. Turns that wrote nothing aren't kept (nothing to delete). */
export function sealTurn(snap) {
    if (!snap) return;
    const made = ST.chat.slice(snap.from).filter(m => m && !m.is_user);
    if (!made.length) return;
    snap.messages = made.map(keyOf);
    snap.narration = made.filter(m => m.extra?.dungeon_master?.type === 'narration').map(keyOf);
    stack.push(snap);
    if (stack.length > KEEP) stack = stack.slice(-KEEP);
}

/** A new chat or campaign: nothing to undo. */
export function forgetTurns() { stack = []; }

/**
 * Messages were deleted: undo the newest turns whose narration (or every message) is gone, newest
 * first. Returns how many turns were undone.
 */
export async function onMessagesDeleted() {
    const c = campaign();
    if (!c || !stack.length) return 0;
    const live = new Set(ST.chat.map(keyOf));
    const gone = snap => (snap.narration.length ? snap.narration.every(k => !live.has(k)) : snap.messages.every(k => !live.has(k)));
    let undone = 0, restore = null;
    while (stack.length && stack.at(-1).campaign === c.meta.id && gone(stack.at(-1))) { restore = stack.pop(); undone++; }
    if (!restore) {
        // An older turn's narration was deleted while newer turns stand: leave the state alone, but say so.
        if (stack.slice(0, -1).some(s => s.campaign === c.meta.id && gone(s))) toastr.info('That wasn\'t the latest turn, so HP, items and the map weren\'t rolled back. Delete the turns after it too, or tell the DM what to change.', 'Dungeon Master', { timeOut: 8000 });
        return 0;
    }
    c.docs.world = restore.world;
    saveDoc('world');
    c.meta.pendingRoll = restore.pendingRoll;
    c.meta.stance = restore.stance;
    for (const [k, v] of Object.entries(restore.meta ?? {})) if (v !== undefined) c.meta[k] = v;
    saveMeta();
    for (const [k, v] of Object.entries(restore.docs ?? {})) if (v !== undefined) { c.docs[k] = v; saveDoc(k); }
    if (restore.placeKey && restore.place) replacePlace(restore.placeKey, restore.place, c);
    const { refreshMap } = await import('../ui/map.js');
    refreshMap();
    const { refreshStandingPrompt } = await import('./actors.js');
    refreshStandingPrompt();
    toastr.info(`Rolled back ${undone > 1 ? `${undone} turns` : 'that turn'}: HP, conditions, items, the clock, the map, the notes and what the companions know are as they were before it.`, 'Dungeon Master', { timeOut: 6000 });
    return undone;
}
