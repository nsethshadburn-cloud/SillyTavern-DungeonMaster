// NPCs as real SillyTavern characters. Each NPC gets a character card (tagged with the campaign),
// joins the campaign's group chat when they're needed, and leaves again after NPC_IDLE_TURNS player
// turns without speaking. Their replies then go through SillyTavern's own generation exactly like
// a party member's: the player's selected formats, reasoning parsing, swipes and all.
// The card stays, so a returning NPC keeps their card, voice and history.

import { ST, findCharacterIndex, currentGroup } from './st.js';
import { campaign, saveDoc } from './campaign.js';
import { pronounsFor } from '../core/notes.js';

/** Player turns an NPC may sit completely unused in the group before they leave it (or they die). */
export const NPC_IDLE_TURNS = 100;

function cardDescription(npc, c) {
    return [
        `${npc.name} is a character in the campaign "${c.meta.title}".`,
        npc.description || '',
        `${npc.name} uses ${pronounsFor(npc.gender)} pronouns.`,
        npc.stats ? `Capabilities: ${npc.stats}.` : '',
    ].filter(Boolean).join('\n');
}

function campaignTag(c) {
    return `D&D NPC: ${c.meta.title}`.slice(0, 60);
}

/** The character index of the NPC's card, creating the card on first use. */
export async function ensureNpcCard(npc) {
    const c = campaign();
    let chid = npc.avatar ? findCharacterIndex(npc.avatar) : -1;
    if (chid !== -1) return chid;

    const form = new FormData();
    form.append('ch_name', npc.name);
    form.append('description', cardDescription(npc, c));
    form.append('personality', npc.attitude ? `${npc.attitude} toward the party` : '');
    form.append('scenario', '');
    form.append('first_mes', '');
    form.append('mes_example', '');
    form.append('creator_notes', `Created by the Dungeon Master extension for "${c.meta.title}". Safe to delete once the campaign is over.`);
    form.append('talkativeness', '0.5');
    form.append('fav', 'false');
    form.append('tags', 'D&D NPC');
    const res = await fetch('/api/characters/create', {
        method: 'POST',
        headers: ST.getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`Couldn't create a character card for ${npc.name} (${res.status}).`);
    const avatar = (await res.text()).trim();
    await ST.getCharacters();
    chid = findCharacterIndex(avatar);
    if (chid === -1) throw new Error(`The card for ${npc.name} was created but SillyTavern didn't list it.`);
    npc.avatar = avatar;
    saveDoc('npcs');
    try {
        await ST.context().executeSlashCommandsWithOptions(`/tag-add name=${JSON.stringify(avatar)} ${JSON.stringify(campaignTag(c))}`);
    } catch (error) {
        console.warn('[Dungeon Master] tagging the NPC card failed', error);
    }
    return chid;
}

/** Make sure the NPC's card is in the current group chat. Returns its character index. */
export async function ensureNpcMember(npc) {
    const chid = await ensureNpcCard(npc);
    const group = currentGroup();
    if (!group) throw new Error('Campaign chats are group chats; no group is open.');
    const avatar = ST.characters[chid].avatar;
    if (!group.members.includes(avatar)) {
        group.members.push(avatar);
        await ST.editGroup(group.id, true, false);
    }
    return chid;
}

/** The campaign NPC a character message or card belongs to, if any. */
export function npcForName(name) {
    const c = campaign();
    if (!c || !name) return null;
    return (c.docs.npcs || []).find(n => n.name === name || (n.avatar && n.avatar === name)) ?? null;
}

/** Note that an NPC was just used, so they stay in the group. */
export function touchNpc(npc) {
    const c = campaign();
    if (!c || !npc) return;
    npc.lastActiveTurn = c.meta.turn;
    saveDoc('npcs');
}

/** Take NPCs out of the group chat (their cards stay; they can be added back later). */
export async function removeNpcsFromGroup(npcs) {
    const group = currentGroup();
    if (!group) return;
    const avatars = new Set(npcs.map(n => n.avatar).filter(Boolean));
    const before = group.members.length;
    group.members = group.members.filter(m => !avatars.has(m));
    if (group.members.length !== before) await ST.editGroup(group.id, true, false);
}

/** NPCs who sat unused for NPC_IDLE_TURNS player turns leave the group (their cards stay). */
export async function rotateIdleNpcs() {
    const c = campaign();
    const group = currentGroup();
    if (!c || !group) return [];
    const removed = [];
    for (const npc of c.docs.npcs || []) {
        if (!npc.avatar || !group.members.includes(npc.avatar)) continue;
        if (c.meta.turn - (npc.lastActiveTurn ?? c.meta.turn) < NPC_IDLE_TURNS) continue;
        group.members = group.members.filter(m => m !== npc.avatar);
        removed.push(npc.name);
    }
    if (removed.length) await ST.editGroup(group.id, true, false);
    return removed;
}
