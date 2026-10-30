// The player's say in a fight, through SillyTavern's own popups: whether their turn is done after
// they act (they may still move or do more), and whether they react before an enemy's hit lands
// (Uncanny Dodge and the like halve it; anything else is put to the DM). Off with the "turn
// prompts" setting. Nothing here touches the story: the answers go back to the orchestrator.

import { ST } from './st.js';
import { settings } from './settings.js';

const escape = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Are the prompts on? */
export function turnPromptsOn() {
    return settings().turnPrompts !== false;
}

/**
 * After the player's action has been resolved: is their turn over? They may still have movement
 * (tap a square on the map, or say where they go) or a bonus action.
 * @returns {Promise<boolean>} true = end the turn now
 */
export async function askEndTurn(player) {
    const r = await ST.callGenericPopup(
        `<h3>Done with your turn, ${escape(player)}?</h3><p>You can still move (tap a square on the map, or say where you go), or do something else this turn. When you end it, everyone after you acts.</p>`,
        ST.POPUP_TYPE.CONFIRM, '', { okButton: 'End my turn', cancelButton: 'Not yet' });
    return r === ST.POPUP_RESULT.AFFIRMATIVE || r === true || r === 1;
}

/**
 * A guard has caught the player loose and told them to come along: go quietly (back to the cell now),
 * or not (he comes after them and grabs).
 * @returns {Promise<boolean>} true = go quietly
 */
export async function askGiveIn(guard, player) {
    const r = await ST.callGenericPopup(
        `<h3>${escape(guard)} has you, ${escape(player)}</h3><p>He orders you back to your cell. Go quietly, and he walks you there and locks the door. Refuse, and he comes after you: each time he reaches you he grabs, and you roll to slip free. Three slips and he draws his weapon.</p>`,
        ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Go quietly', cancelButton: 'Not a chance' });
    return r === ST.POPUP_RESULT.AFFIRMATIVE || r === true || r === 1;
}

/**
 * An enemy's attack has hit the player and the damage is known: do they react before it lands?
 * @param {{who: string, what: string, total: number, dc: number|null, damage: number, detail: string}} hit
 * @returns {Promise<{kind: 'take'} | {kind: 'half'} | {kind: 'other', text: string}>}
 */
export async function askReaction(hit) {
    const r = await ST.callGenericPopup(
        `<h3>${escape(hit.who)} hits you</h3><p>${escape(hit.what || 'Attack')}: <b>${hit.total}</b>${hit.dc !== null ? ` vs AC ${hit.dc}` : ''} · <b>${hit.damage}</b> damage (${escape(hit.detail)}).</p><p>React before it lands? <i>Uncanny Dodge</i> and the like halve it. Anything else (a spell, a feature, an item) goes to the DM to rule on, and the damage waits.</p>`,
        ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Take the hit', cancelButton: false, customButtons: ['Half damage (Uncanny Dodge…)', 'React another way…'] });
    if (r === ST.POPUP_RESULT.CUSTOM1 || r === 1001) return { kind: 'half' };
    if (r === ST.POPUP_RESULT.CUSTOM2 || r === 1002) {
        const text = await ST.callGenericPopup(
            `<h3>Your reaction</h3><p>Say what you do as ${escape(hit.who)}'s blow comes in. The DM rules on it; the damage waits until then.</p>`,
            ST.POPUP_TYPE.INPUT, '', { okButton: 'React', cancelButton: 'Take the hit after all' });
        if (typeof text === 'string' && text.trim()) return { kind: 'other', text: text.trim().slice(0, 300) };
    }
    return { kind: 'take' };
}
