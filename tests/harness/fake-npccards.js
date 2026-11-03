// A fake of src/st/npccards.js: an NPC who speaks becomes a character in the fake chat on the spot.
import { fake } from './fake-st.js';

export const NPC_IDLE_TURNS = 100;
export async function ensureNpcCard(npc) { return npc; }
export async function ensureNpcMember(npc) {
    let idx = fake.characters.findIndex(c => c.name === npc.name);
    if (idx === -1) { fake.characters.push({ name: npc.name, avatar: `${npc.name.toLowerCase().replace(/\W+/g, '_')}.png`, description: npc.description || '' }); idx = fake.characters.length - 1; fake.groups[0].members.push(fake.characters[idx].avatar); }
    return idx;
}
export function npcForName() { return null; }
export function touchNpc() { }
export async function removeNpcsFromGroup() { }
export async function rotateIdleNpcs() { return []; }
