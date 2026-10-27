// Posting messages into the chat: DM narration, NPC lines, dice cards, out-of-character replies.
// DM/NPC messages deliberately skip CHARACTER_MESSAGE_RENDERED so SillyTavern's TTS doesn't
// try to voice names that aren't characters; our own voice player handles them.

import { ST, EXT_PATH } from './st.js';

export const DM_NAME = 'Dungeon Master';
export const DM_AVATAR = `${EXT_PATH}/assets/dm.svg`;
export const NPC_AVATAR = `${EXT_PATH}/assets/npc.svg`;
export const DICE_AVATAR = `${EXT_PATH}/assets/dice.svg`;

function stamp() {
    return new Date().toISOString();
}

function baseMessage(name, text, { avatar, hidden = false, type = 'narration', data = {} } = {}) {
    const message = {
        name,
        is_user: false,
        is_system: hidden,
        send_date: stamp(),
        mes: String(text ?? ''),
        force_avatar: avatar,
        extra: {
            api: 'manual',
            model: 'dungeon master',
            gen_id: Date.now(),
            dungeon_master: { type, ...data },
        },
    };
    message.swipe_id = 0;
    message.swipes = [message.mes];
    message.swipe_info = [{ send_date: message.send_date, gen_started: null, gen_finished: null, extra: structuredClone(message.extra) }];
    return message;
}

async function push(message, { emitReceived = true } = {}) {
    ST.chat.push(message);
    const id = ST.chat.length - 1;
    ST.chatMetadata.tainted = true;
    if (emitReceived) await ST.eventSource.emit(ST.eventTypes.MESSAGE_RECEIVED, id, 'extension');
    ST.addOneMessage(message);
    await ST.saveChat();
    return id;
}

/** DM narration (visible to the local model as context). */
export async function postNarration(text) {
    if (!text?.trim()) return null;
    return push(baseMessage(DM_NAME, text.trim(), { avatar: DM_AVATAR, type: 'narration' }));
}

/** Out-of-character DM reply (hidden from the local model's prompt). */
export async function postOoc(text) {
    if (!text?.trim()) return null;
    return push(baseMessage(DM_NAME, `*(OOC)* ${text.trim()}`, { avatar: DM_AVATAR, hidden: true, type: 'ooc' }), { emitReceived: false });
}

/** The player's own out-of-character question (asked with /dm or the DM Screen), so it shows in the chat. */
export async function postPlayerOoc(name, text) {
    if (!text?.trim()) return null;
    const message = baseMessage(name, `*(OOC)* ${text.trim()}`, { hidden: true, type: 'ooc' });
    message.is_user = true;
    delete message.force_avatar;
    return push(message, { emitReceived: false });
}

/** A line spoken by an NPC (voiced by the local model). */
export async function postNpc(name, text, npc = null) {
    if (!text?.trim()) return null;
    return push(baseMessage(name, text.trim(), { avatar: NPC_AVATAR, type: 'npc', data: { npc: npc?.name ?? name } }));
}

/** A dice card. Hidden from the local model; the DM sees results through its own summaries. */
export async function postDiceCard(markdown, data = {}) {
    return push(baseMessage('Dice', markdown, { avatar: DICE_AVATAR, hidden: true, type: 'roll', data }), { emitReceived: false });
}

/** A small system-style note from the extension (hidden from prompts). */
export async function postNote(markdown, type = 'note') {
    return push(baseMessage(DM_NAME, markdown, { avatar: DM_AVATAR, hidden: true, type }), { emitReceived: false });
}

export function dmType(message) {
    return message?.extra?.dungeon_master?.type ?? null;
}
