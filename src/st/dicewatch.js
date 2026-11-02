// Reads SillyTavern's dice rolls ("Amber rolls a d20. The result is: 17 (17)") while the DM is
// waiting for a roll, so the player doesn't have to type the number in again.
// SillyTavern posts these as system messages without firing an event, so we watch the chat.

import { ST } from './st.js';
import { settings } from './settings.js';
import { campaign, saveMeta } from './campaign.js';
import { parseRollMessage, collectRoll } from '../core/rollmsg.js';
import { nameKey } from '../core/text.js';

let observer = null;
let onComplete = () => {};

/** Start watching. onRollComplete() runs a turn; the result waits in meta.pendingRoll.autoResult. */
export function startDiceWatch(onRollComplete) {
    onComplete = onRollComplete;
    const chatEl = document.getElementById('chat');
    if (!chatEl || observer) return;
    observer = new MutationObserver(() => scan());
    observer.observe(chatEl, { childList: true });
}

/** Look at chat messages added since the roll was requested. */
export function scan() {
    const c = campaign();
    if (!c || c.meta.paused || settings().autoReadDice === false) return;
    // The request is still open in the chat but meta lost it (a resync, an undo, a reload mid-roll): take it back from the card.
    if (!c.meta.pendingRoll) {
        const chat = ST.chat;
        for (let i = chat.length - 1; i >= 0 && i >= chat.length - 12; i--) {
            const dm = chat[i]?.extra?.dungeon_master;
            if (!dm) continue;
            if (dm.roll || dm.combat) break;
            if (dm.request && !dm.request.autoResult && !dm.request.cancelled && Number.isInteger(dm.request.chatIndex)) { c.meta.pendingRoll = { ...dm.request }; chat[i].extra.dungeon_master.request = c.meta.pendingRoll; console.info('[Dungeon Master] roll request recovered from the chat'); break; }
        }
    }
    const pr = c.meta.pendingRoll;
    if (!pr || pr.autoResult) return;
    if (!Number.isInteger(pr.chatIndex)) return; // requested by an older version: typed rolls only
    const chat = ST.chat;
    // Messages were deleted since the request: don't wait for the chat to grow past the old spot.
    if (pr.chatIndex > chat.length) pr.chatIndex = chat.length;
    if ((pr.scanned ?? 0) > chat.length) pr.scanned = chat.length;
    pr.scanned = Math.max(pr.scanned ?? pr.chatIndex, pr.chatIndex);
    let changed = false;
    for (; pr.scanned < chat.length; pr.scanned++) {
        const m = chat[pr.scanned];
        if (!m?.is_system) continue;
        const roll = parseRollMessage(m.mes);
        if (!roll || nameKey(roll.who) !== nameKey(c.meta.persona.name)) continue;
        pr.dice = [...(pr.dice ?? []), ...roll.rolls.map(value => ({ sides: roll.sides, value }))];
        changed = true;
    }
    if (!changed) return;
    const result = collectRoll(pr, pr.dice);
    if (result.done) {
        pr.autoResult = { natural: result.natural, total: result.total };
        c.meta.lastAutoRoll = { at: Date.now(), natural: result.natural, total: result.total };
        saveMeta();
        onComplete();
    } else {
        saveMeta();
    }
}
