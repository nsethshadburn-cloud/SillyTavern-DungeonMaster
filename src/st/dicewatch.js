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
    const pr = c?.meta.pendingRoll;
    if (!pr || pr.autoResult || c.meta.paused || settings().autoReadDice === false) return;
    if (!Number.isInteger(pr.chatIndex)) return; // requested by an older version: typed rolls only
    const chat = ST.chat;
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
