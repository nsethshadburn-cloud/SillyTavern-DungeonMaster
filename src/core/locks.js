// Locks: every locked door has its own difficulty, set by the kind of place (a cottage's latch, a
// mansion's study, a jail's cells, a bank's vault), what the door guards, and a little chance.
// Picking one is a roll the code makes (Sleight of Hand, or Thieves' Tools if the sheet has them
// and they're better); a few failures in a row at the same door may draw attention. Pure module.

import { nameKey } from './text.js';
import { lookupModifier } from './world.js';

/** How hard locks are in a kind of place (a DC before the door's own adjustments). */
const PLACE_DC = [
    [/cottage|hut|shack|cabin|farm|hovel|camp|tent/, 10],
    [/house|home|lodge|mill|lighthouse/, 11],
    [/tavern|inn|pub|shop|store|smithy|bakery|market|stable|warehouse/, 12],
    [/cave|mine|sewer/, 11],
    [/crypt|tomb|catacomb|barrow|ossuary/, 13],
    [/temple|church|chapel|monastery|abbey|library|academy|school/, 13],
    [/dungeon|ruin|lair|ship|galleon/, 14],
    [/barracks|garrison|guard|watch/, 14],
    [/mansion|manor|estate|villa|chateau|hall|tower|observatory/, 15],
    [/prison|jail|gaol|stockade|asylum/, 15],
    [/castle|keep|palace|fortress|citadel/, 16],
    [/bank|vault|treasury|mint|guild|exchange/, 17],
];
/** What the door guards makes it harder (or easier). */
const ROOM_DC = { vault: 3, armory: 2, office: 1, study: 1, master_bedroom: 1, laboratory: 1, cell: 1, storage: -1, pantry: -2, bedroom: 0, wine_cellar: 0, cellar: -1, kennel: -1, attic: -1 };

/** A small number from text, the same every time (so a door's lock never changes). */
function hash(text) {
    let h = 2166136261;
    for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/**
 * A locked door's difficulty: the place's base, what's behind it, the kind of door (a barred cell
 * door is sturdier), how kept up the place is, and up to two either way. Stored on the door once.
 */
export function lockDc(place, door) {
    if (Number.isFinite(door.lockDc)) return door.lockDc;
    const words = `${place.kind || ''} ${place.name || ''}`.toLowerCase();
    let dc = PLACE_DC.find(([re]) => re.test(words))?.[1] ?? 13;
    const behind = (door.rooms || []).map(id => place.rooms?.[id]?.type).filter(Boolean);
    dc += Math.max(0, ...behind.map(t => ROOM_DC[t] ?? 0)) + Math.min(0, ...behind.map(t => ROOM_DC[t] ?? 0));
    if (door.kind === 'cell') dc += 2;
    if (place.condition === 'ruined') dc -= 1;
    dc += (hash(`${place.seed ?? place.name}:${door.id}`) % 5) - 2;
    door.lockDc = Math.max(8, Math.min(25, dc));
    return door.lockDc;
}

/** The lock in words (the number stays hidden, like the DM's other DCs). */
export function lockWords(dc) {
    return dc <= 10 ? 'a simple lock' : dc <= 13 ? 'a decent lock' : dc <= 16 ? 'a good lock' : dc <= 19 ? 'a hard lock' : 'a masterwork lock';
}

/** The best way someone has to pick a lock: Thieves' Tools if their sheet lists them and they're better, else Sleight of Hand. */
export function pickModifier(stats) {
    const hand = lookupModifier(stats, { kind: 'check', skill: 'Sleight of Hand', ability: 'DEX' });
    const loose = s => String(s).toLowerCase().replace(/[^a-z]+/g, '');
    const toolKey = Object.keys(stats?.tools ?? {}).find(k => loose(k) === 'thievestools');
    const tools = toolKey && Number.isFinite(Number(stats.tools[toolKey])) ? { mod: Number(stats.tools[toolKey]), source: toolKey } : null;
    return tools && tools.mod > hand.mod ? { mod: tools.mod, skill: "Thieves' Tools" } : { mod: hand.mod, skill: 'Sleight of Hand' };
}

/**
 * A failed attempt at a door: counted per picker. After two or three in a row (decided per door) —
 * or a natural 1, a snapped pick — it's time to see whether anyone noticed. Returns {count, alarm}.
 */
export function notePickFailure(door, name, natural) {
    door.picks ??= {};
    const count = (door.picks[name] ?? 0) + 1;
    const limit = 2 + (hash(`${door.id}:${name}`) % 2);
    const alarm = natural === 1 || count >= limit;
    door.picks[name] = alarm ? 0 : count;
    return { count, alarm };
}

/** The key someone carries for this door, if any (by the door's key name). */
export function keyFor(door, carried = []) {
    if (!door.key) return null;
    const k = nameKey(door.key);
    return carried.find(i => nameKey(i) === k || nameKey(i).includes(k) || (k.includes(nameKey(i)) && /key/.test(nameKey(i)))) ?? null;
}
