// The fort builder: a camp or fort as one outdoor map. A palisade of sharpened logs (or stone walls)
// with a main gate and a locked back gate, watchtowers at the corners, sharpened stakes and pits in
// the killing ground outside, and inside: a fire circle, tents and huts, the chief's lodge, prisoner
// pens with cages, a cook fire, supplies, obstacles and traps, and the bandits who hold it. A small
// camp is a few tents behind a wall; a massive one is a war camp with an inner stockade in the middle
// where the prisoners and the chief are kept. Attacking one means getting through the wall; escaping
// one means getting out through the gates. Pure module: a brief in, a place out, from a seed.

import { ensureIds, clearDoorways, normalizePlan, generatePlace } from './layout.js';
import { generateTunnels } from './warren.js';
import { PROPS, MAX_PLACE_SIZE, terrainAt } from './grid.js';
import { nameKey, singular } from './text.js';

// ---------- randomness ----------

function rng(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const K = (x, y) => `${x},${y}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Smooth noise over the map (-1..1), for the woods around the camp. */
function smoothNoise(seed, scale = 6) {
    const v = (a, b) => { const h = Math.sin(a * 127.1 + b * 311.7 + seed * 0.013) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; };
    return (x, y) => {
        const sx = x / scale, sy = y / scale, ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
        const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
        const a = v(ix, iy) * (1 - u) + v(ix + 1, iy) * u, b = v(ix, iy + 1) * (1 - u) + v(ix + 1, iy + 1) * u;
        return a * (1 - w) + b * w;
    };
}

// ---------- what counts as a camp ----------

/** Words that make a place hostile ground (its people attack or seize the party). */
export const HOSTILE_WORDS = /bandit|raider|marauder|brigand|cannibal|reaver|outlaw|warband|horde|cutthroat|pirate|slaver|goblin|orc|hostile|enemy|raiding|war ?camp|hideout|lair|mercenar|cult|captives?|prisoners?|\bcages?\b|slaves?|flesh|man-?eat|eat(?:ing|s)? (?:their|the) (?:captives|prisoners|dead)|stockade|kidnap/i;
const PEACEFUL_WORDS = /caravan|pilgrim|travell?er|merchant|refugee|hunters?'|hunting|woodcutter|picnic|campsite|resting|our camp|the party'?s camp|shepherd|fishing|army camp|soldiers'|expedition|survey/i;

/**
 * Is this place a camp or a fort for the fort builder? A camp, an encampment, a hideout or an
 * outpost always; a fort, a stockade or a stronghold when it's held by bandits, raiders or the
 * like (a lord's castle or keep stays a building, with rooms inside).
 */
export function isCamp(kind = '', name = '') {
    const k = String(kind || '').toLowerCase(), n = String(name || '').toLowerCase();
    if (/\b(camp|encampment|war ?camp|warcamp|hideout|palisade|outpost)\b/.test(k)) return true;
    if (/\b(fort|fortress|stockade|stronghold)\b/.test(k)) return HOSTILE_WORDS.test(`${k} ${n}`);
    if (!k || /^(place|site|location|area|wilds?)$/.test(k)) return /\b(camp|encampment|hideout|outpost)\b/.test(n) || (/\b(fort|stockade|stronghold)\b/.test(n) && HOSTILE_WORDS.test(n));
    return false;
}

/** What kind of camp the brief describes: walls, size, who holds it, the gates. */
export function campSpec(brief) {
    const words = `${brief.kind} ${brief.name} ${brief.mood} ${brief.summary} ${brief.creatures}`.toLowerCase();
    const peaceful = PEACEFUL_WORDS.test(words) && !HOSTILE_WORDS.test(words);
    const hostile = !peaceful && (HOSTILE_WORDS.test(words) || brief.guards === null || brief.guards > 0);
    let walls = ['palisade', 'stone', 'none'].includes(brief.walls) ? brief.walls : '';
    if (!walls) walls = /stone wall|stone-walled|fortress|garrison|citadel|stronghold|\bfort\b/.test(words) ? 'stone' : hostile ? 'palisade' : 'none';
    if (!brief.walls && /palisade|stockade|wooden wall|log wall|timber wall/.test(words)) walls = 'palisade';
    const size = brief.size === 'big' ? (/massive|huge|vast|sprawling|great|war ?camp|warcamp|army|horde|stronghold|hundreds|host\b/.test(words) ? 'massive' : 'big') : brief.size === 'medium' ? 'medium' : 'small';
    const cannibal = /cannibal|flesh-?eat|man-?eat|butcher|skull|gore|wendigo/.test(words);
    const gates = ['open', 'closed', 'locked'].includes(brief.gates) ? brief.gates : (/siege|locked|shut|barred|night/.test(words) ? 'locked' : hostile ? 'closed' : 'open');
    const shape = ['round', 'square'].includes(brief.shape) ? brief.shape : /\b(round|ring|circular|circle)\b/.test(words) ? 'round' : /\b(square|rectangular|rectangle)\b/.test(words) ? 'square' : walls === 'stone' ? 'square' : 'round';
    const pens = hostile && (cannibal || /prison|captive|cage|slave|hostage|kidnap|ransom|abduct|taken|held|pen\b|pens\b/.test(`${words} ${brief.start} ${brief.objective}`.toLowerCase()));
    // Gruesome inside (torture rooms, larders of flesh, blood underfoot): a cannibal camp always, any camp the brief paints that way, never one the brief calls plain.
    const horror = brief.horror === 'plain' ? false : brief.horror === 'gruesome' || cannibal || /horror|gruesome|torture|flay|gore|grisly|nightmare|skinned|butcher/.test(words);
    // Tunnels under the camp: asked for, named in the brief, or (null) left to the dice.
    const tunnels = brief.tunnels === 'yes' ? true : brief.tunnels === 'no' ? false : /tunnel|burrow|warren|underground|beneath|catacomb|below the camp|dug under/.test(words) ? true : null;
    return { walls, size, cannibal, gates, hostile, pens, shape, horror, tunnels };
}

// ---------- names ----------

const BAND_WORDS = ['Bandit', 'Raider', 'Cutthroat', 'Brigand', 'Marauder', 'Reaver', 'Outlaw'];
const CANNIBAL_WORDS = ['Cannibal', 'Flesh-eater', 'Butcher', 'Bone-gnawer', 'Skinner'];
const CHIEF_NAMES = ['Gorruk', 'Vask', 'Hetta', 'Bramm', 'Skarl', 'Oona', 'Dreg', 'Mosk', 'Yrsa', 'Krell', 'Tavi', 'Hadd', 'Ulma', 'Rook', 'Sedge', 'Marrow'];
const CHIEF_EPITHETS = ['the Red', 'One-Eye', 'the Butcher', 'Ironjaw', 'the Quiet', 'Half-hand', 'the Grinning', 'Blackteeth', 'the Hollow', 'Wolfmother', 'the Lame', 'Nine-fingers', 'the Pale', 'Bonecrown'];
const LOOKS = ['in patched leather with a notched axe', 'with a crossbow and a cruel grin', 'scarred, chewing something', 'in a stolen guard\'s breastplate', 'thin and quick with two knives', 'drunk and loud', 'with a bone necklace and a spear', 'young, nervous, with a club', 'bald, tattooed, with a cleaver', 'wrapped in furs, with a bow'];
const CAPTIVES = ['a starved captive in a cage', 'a merchant\'s daughter, bound and silent', 'a half-dead farmer, roped to a post', 'a captured scout, bruised and watchful', 'a whimpering boy of twelve', 'a bandit who crossed the chief, in the cage with the rest'];
const CAMP_NAMES = ['Gallows Hollow', 'the Skull Fence', 'Redstake', 'Crowcamp', 'Bonefire Ridge', 'the Stakes', 'Black Palisade', 'Wolf\'s Rest', 'Ashpit', 'the Kettle'];

// ---------- the brief → a plan ----------

/** Zone roles, in the order they're handed out to the camp's spaces (the first ones matter most). */
const ROLES = {
    small: ['gate', 'fire', 'lodge', 'tents', 'pens', 'supplies', 'cook'],
    medium: ['gate', 'fire', 'lodge', 'pens', 'tents', 'cook', 'supplies', 'tents', 'pit'],
    big: ['gate', 'fire', 'lodge', 'pens', 'tents', 'cook', 'supplies', 'tents', 'pit', 'smithy', 'kennels', 'shrine', 'tents', 'back'],
    massive: ['gate', 'fire', 'keep', 'tents', 'cook', 'supplies', 'tents', 'pit', 'smithy', 'kennels', 'shrine', 'tents', 'back', 'tents', 'watch'],
};
const ZONE_NAMES = {
    gate: ['Gate Yard', 'The Gate', 'Front Yard'], fire: ['Fire Circle', 'The Great Fire', 'Bonfire Ring'], lodge: ['Chief\'s Lodge', 'The Chief\'s Hut', 'War Lodge'], keep: ['Inner Stockade', 'The Inner Ring', 'The Chief\'s Stockade'],
    tents: ['Sleeping Tents', 'Tent Rows', 'The Bedrolls', 'Raiders\' Tents'], pens: ['Prisoner Pens', 'The Cages', 'Slave Pen'], cook: ['Cook Fires', 'The Kettle', 'Butcher\'s Corner'], supplies: ['Supply Dump', 'Loot Pile', 'Stores'],
    pit: ['Fighting Pit', 'The Ring', 'Blood Pit'], smithy: ['Camp Forge', 'The Anvil'], kennels: ['Hound Pens', 'Kennels'], shrine: ['Shrine of Skulls', 'The Bone Altar', 'Totem Ground'], back: ['Back Gate', 'Postern Yard'], watch: ['Watch Yard', 'Drill Ground'],
};
const ZONE_TYPES = { gate: 'guard_room', fire: 'courtyard', lodge: 'master_bedroom', keep: 'courtyard', tents: 'servants_quarters', pens: 'cell', cook: 'kitchen', supplies: 'storage', pit: 'courtyard', smithy: 'smithy', kennels: 'kennel', shrine: 'chapel', back: 'courtyard', watch: 'guard_room' };

/**
 * A camp's plan from a brief: its zones (named spaces inside the wall), who holds it, who's held
 * in it, and what the story put there. The plan comes out already normalized (the fort builder
 * is its own geometry, not rooms and corridors). Same brief and seed, same camp.
 */
export function campFromBrief(brief, seed = 1) {
    const r = rng(seed);
    const spec = campSpec(brief);
    const words = `${brief.kind} ${brief.name} ${brief.summary} ${brief.mood}`.toLowerCase();
    let roles = ROLES[spec.size].slice();
    if (!spec.pens) roles = roles.filter(x => x !== 'pens');
    if (!spec.hostile) roles = roles.filter(x => !['pit', 'shrine', 'kennels', 'keep', 'watch'].includes(x)).map(x => (x === 'lodge' ? 'lodge' : x));
    const used = new Set();
    const nameOf = role => { const list = shuffle(r, !spec.hostile && role === 'lodge' ? ['Elder\'s Tent', 'The Leader\'s Tent', 'Wagon Circle'] : ZONE_NAMES[role]); const n = list.find(x => !used.has(x)) ?? `${list[0]} ${int(r, 2, 9)}`; used.add(n); return n; };
    const rooms = [];
    const room = (id, name, type, extra = {}) => { rooms.push({ id, name, type, floor: 'F0', size: '', lit: true, description: '', hint: '', props: [], marks: [], traps: [], items: [], exit: false, windows: '', ...extra }); return rooms.at(-1); };
    room('APPROACH', pick(r, ['The Approach', 'Before the Gate', 'The Killing Ground']), 'courtyard', { exit: true, description: 'Open ground in front of the main gate, in sight of the wall.' });
    const counts = {};
    for (const role of roles) { counts[role] = (counts[role] ?? 0) + 1; room(`${role.toUpperCase()}${counts[role] > 1 ? counts[role] : ''}`, nameOf(role), ZONE_TYPES[role], { role }); }
    const find = re => rooms.find(x => re.test(`${x.role} ${x.name}`.toLowerCase()));
    // The story's spots: what's in them goes into the zone that fits.
    // (Plain rules in order, never a `&&` chain under `??`: a rule that doesn't match gives false, and
    // false is not null, so a chain like that stops at the first rule and hands back `false` as a room.)
    const ZONE_RULES = [
        [/chief|boss|leader|lodge|war ?lord|captain|tent of|his tent|her tent|command/, () => find(/^lodge|^keep/) ?? find(/^fire/)],
        [/cage|\bpens?\b|prison|captive|slave|hostage|\bcells?\b/, () => find(/^pens|^keep/) ?? find(/^fire/)],
        [/fire|bonfire|circle/, () => find(/^fire/)],
        [/gate|front|entrance/, () => find(/^gate/)],
        [/loot|store|supply|supplies|wagon|cart|plunder/, () => find(/^supplies/)],
        [/cook|kettle|kitchen|butcher|meat/, () => find(/^cook/)],
        [/forge|smith|anvil/, () => find(/^smithy/)],
        [/shrine|altar|totem|idol|skull/, () => find(/^shrine/)],
        [/tent|sleep|bedroll/, () => find(/^tents/)],
        [/outside|woods|tree|approach|hill|ridge/, () => rooms[0]],
    ];
    const zoneFor = text => {
        const t = String(text || '').toLowerCase();
        for (const [re, get] of ZONE_RULES) if (re.test(t)) { const rm = get(); if (rm) return rm; }
        return rooms.find(x => nameKey(x.name).includes(nameKey(t)) || nameKey(t).includes(nameKey(x.name))) ?? find(/^lodge|^keep/) ?? find(/^fire/) ?? rooms[1];
    };
    for (const s of brief.rooms) {
        const rm = zoneFor(`${s.room} ${s.name}`);
        if (s.name && !rm.role) rm.name = cap(s.name);
        if (s.note) rm.description = [rm.description, s.note].filter(Boolean).join(' ');
        for (const it of s.has) rm.items.push({ name: it, hidden: s.hidden, note: s.note });
    }
    // The objective (an item): in the chief's keeping, far from the gate.
    const obj = String(brief.objective || '').trim();
    if (obj && !/escape|get out|flee|leave|freedom/i.test(obj) && !rooms.some(x => x.items.some(it => nameKey(it.name) === nameKey(obj))) && !brief.people.some(p => nameKey(p.name) === nameKey(obj))) (find(/^lodge|^keep/) ?? find(/^fire/)).items.push({ name: obj, hidden: false, note: 'what the party came for' });
    // Who holds the camp: a chief (the brief's leader, or one of ours) and the band.
    const guards = [];
    const band = spec.cannibal ? CANNIBAL_WORDS : brief.creatures ? [cap(singular(brief.creatures))] : BAND_WORDS;
    const chiefIn = brief.people.find(p => p.hostile && /chief|boss|leader|war ?lord|captain|king|queen|lord|matriarch|patriarch|head/i.test(p.what));
    const lodge = find(/^lodge|^keep/) ?? find(/^fire/);
    const chiefName = chiefIn ? chiefIn.name : `${pick(r, CHIEF_NAMES)} ${pick(r, CHIEF_EPITHETS)}`;
    if (spec.hostile) guards.push({ name: chiefName, description: chiefIn ? chiefIn.what : `the chief of this camp, a ${pick(r, band).toLowerCase()} ${pick(r, ['twice the size of the others', 'with a stolen sword and a crown of teeth', 'who never raises his voice', 'with a hostage\'s rings on every finger'])}`, room: lodge.id, patrol: [lodge.id], hostile: true, role: 'hostile', chief: true, sprite: chiefIn?.sprite || '' });
    const want = brief.guards ?? { small: 3, medium: 5, big: 7, massive: 9 }[spec.size];
    const n = spec.hostile ? Math.max(0, Math.min(12, want)) : 0;
    const zones = rooms.filter(x => x.role && x.role !== 'pens');
    let lookouts = 0, gateGuards = 0;
    for (let i = 0; i < n; i++) {
        const w = pick(r, band);
        const kind = i === 0 ? 'gate' : i === 1 || (i % 4 === 1 && lookouts < 4) ? 'lookout' : i === 2 ? 'gate' : 'rover';
        if (kind === 'lookout') lookouts++; else if (kind === 'gate') gateGuards++;
        const home = kind === 'rover' ? pick(r, zones) : find(/^gate/) ?? zones[0];
        const patrol = kind === 'rover' ? [...new Set([home.id, ...shuffle(r, zones).slice(0, int(r, 1, 2)).map(z => z.id)])] : [home.id];
        guards.push({ name: `${w} ${i + 1}`, description: `${kind === 'lookout' ? 'a lookout' : kind === 'gate' ? 'a gate guard' : 'a bandit'} of the camp, ${w.toLowerCase() === 'bandit' ? '' : `a ${w.toLowerCase()} `}${pick(r, LOOKS)}`, room: home.id, patrol, hostile: true, role: 'hostile', duty: kind, sprite: '' });
    }
    // Everyone else the brief put here: other hostiles join the band; the rest are held or kept.
    const people = [];
    for (const p of brief.people) {
        if (p === chiefIn) continue;
        const where = zoneFor(`${p.where} ${p.what}`);
        if (p.hostile) guards.push({ name: p.name, description: p.what, room: where.id, patrol: [where.id], hostile: true, role: 'hostile', sprite: '' });
        else {
            const captive = /captive|prisoner|hostage|cage|slave|held|bound|tied|kidnap/i.test(`${p.what} ${p.where}`);
            const pens = find(/^pens|^keep/);
            people.push({ name: p.name, description: p.what, room: captive && pens ? pens.id : where.id, patrol: [], hostile: false, role: captive ? 'prisoner' : 'resident', sprite: '' });
        }
    }
    const pens = find(/^pens|^keep/);
    if (pens && spec.hostile && !people.some(p => p.room === pens.id)) for (let i = 0; i < int(r, 1, 2); i++) people.push({ name: `Captive ${i + 1}`, description: pick(r, CAPTIVES), room: pens.id, patrol: [], hostile: false, role: 'prisoner', sprite: '' });
    // Where the party is now.
    const startWords = String(brief.start || '').toLowerCase();
    const start = /cage|pen|prison|captive|locked|held|tied|bound|chained|hostage|caught|caged|captured/.test(startWords) && pens ? pens.id
        : /inside|within|among|at the fire|in the camp|by the fire|in (a|the|his|her) tent|guest|sitting with|feast/.test(startWords) ? (find(/^fire/) ?? rooms[1]).id
            : 'APPROACH';
    const nT = brief.traps === 'none' ? 0 : brief.traps === 'many' ? { small: 4, medium: 6, big: 8, massive: 10 }[spec.size] : spec.hostile ? { small: 2, medium: 3, big: 4, massive: 5 }[spec.size] : 0;
    return {
        normalized: true,
        name: brief.name || pick(r, CAMP_NAMES),
        kind: brief.kind || 'camp',
        theme: 'camp',
        fog: true,
        building: false, outside: [], outsideGuards: [], startOutside: start === 'APPROACH', exterior: {}, barred: false,
        summary: [brief.summary, `${brief.name || 'The camp'} is ${{ small: 'a small camp', medium: 'a camp', big: 'a big camp', massive: 'a sprawling war camp' }[spec.size]} ${spec.walls === 'stone' ? 'behind stone walls' : spec.walls === 'palisade' ? 'behind a palisade of sharpened logs' : 'in the open'}${spec.pens ? ', with prisoners kept in cages' : ''}${brief.mood ? `, ${brief.mood}` : ''}.`].filter(Boolean).join(' '),
        condition: 'worn',
        floors: [{ id: 'F0', name: brief.name || 'The camp', level: 0 }],
        rooms, links: [], guards: [...guards, ...people], start,
        fixes: [],
        camp: { ...spec, tunnels: spec.tunnels ?? (spec.hostile && (spec.cannibal ? r() < 0.75 : spec.size === 'small' ? r() < 0.2 : r() < 0.4)), traps: nT, chief: spec.hostile ? chiefName : '' },
    };
}

// ---------- the geometry ----------

const SIZES = { small: { W: 34, H: 30, margin: 6 }, medium: { W: 44, H: 36, margin: 7 }, big: { W: 56, H: 46, margin: 8 }, massive: { W: 64, H: 56, margin: 9 } };
const TRAP_KINDS = [['covered spike pit', 'DEX', '2d6 piercing, in the pit'], ['hunter\'s snare', 'DEX', 'hoisted by one ankle, restrained'], ['bear trap', 'DEX', '1d8 piercing, held fast'], ['tripwire (alarm bells)', 'DEX', 'bells clatter: the whole camp hears'], ['caltrops', 'DEX', '1d4 piercing, speed halved'], ['deadfall log', 'DEX', '2d8 bludgeoning']];

/**
 * Build the camp from its plan (campFromBrief's, or the DM's with the same room roles). Returns a
 * place in the same shape every other builder gives: one floor, rooms (the zones, the huts and the
 * pen), doors (the gates, hut doors, the pen's barred gate), traps, items, guards, exits and a start.
 */
export function generateCamp(plan, seed = 1) {
    const r = rng(seed);
    const spec = { walls: 'palisade', size: 'small', cannibal: false, gates: 'closed', hostile: true, pens: true, traps: 2, shape: 'round', horror: false, tunnels: false, ...(plan.camp || {}) };
    const { W, H, margin } = SIZES[spec.size] ?? SIZES.small;
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = ch; };
    const map = { w: W, h: H, rows: [], theme: 'camp', props: [], areas: [], roofs: [], seed, ambience: 'embers' };
    const place = {
        version: 1, kind: plan.kind || 'camp', name: plan.name, theme: 'camp', fog: true, seed, summary: plan.summary,
        floors: [{ id: 'F0', name: plan.name, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    const walled = spec.walls !== 'none';
    const between = (a, b) => a + r() * (b - a);
    const DIRS8 = [...DIRS, [1, 1], [1, -1], [-1, 1], [-1, -1]];
    // The enclosure: a ring (a palisade is usually round: an ellipse of squares with a little wobble,
    // so no two are alike) or a rectangle (a stone fort), with a bulge on one side for a bigger one.
    const round = spec.shape === 'round';
    const cxm = (W - 1) / 2, cym = (H - 1) / 2, rx = cxm - margin, ry = cym - margin;
    const wob = [between(0.03, 0.07), r() * 6.28, between(0.02, 0.05), r() * 6.28];
    const ellipseIn = (x, y, kx = 1, ky = 1) => { const dx = (x - cxm) / (rx * kx), dy = (y - cym) / (ry * ky); const th = Math.atan2(dy, dx); const k = 1 + wob[0] * Math.sin(2 * th + wob[1]) + wob[2] * Math.sin(3 * th + wob[3]); return dx * dx + dy * dy <= k * k; };
    const main = { x: margin, y: margin, w: W - margin * 2, h: H - margin * 2 };
    const rects = [main];
    if (!round && spec.size !== 'small' && r() < 0.65) {
        const side = pick(r, ['e', 'w', 'n', 's']);
        const bw = int(r, 6, 9), bh = int(r, 6, 9);
        const bx = side === 'e' ? main.x + main.w - 2 : side === 'w' ? main.x - bw + 2 : int(r, main.x + 3, main.x + main.w - bw - 3);
        const by = side === 'n' ? main.y + main.h - 2 : side === 's' ? main.y - bh + 2 : int(r, main.y + 3, main.y + main.h - bh - 3);
        rects.push({ x: clamp(bx, 3, W - bw - 3), y: clamp(by, 3, H - bh - 3), w: bw, h: bh });
    }
    const inside = (x, y) => (round ? ellipseIn(x, y) : rects.some(q => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h));
    // The wall: every square of the enclosure that touches the outside, corners included, so nobody slips through on a diagonal.
    const isWallSq = (x, y) => walled && inside(x, y) && DIRS8.some(([dx, dy]) => !inside(x + dx, y + dy));
    const interior = (x, y) => inside(x, y) && !isWallSq(x, y);
    if (walled) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isWallSq(x, y)) c[y][x] = '#';
    // A gate: a wall square on the side asked for, with open ground outside it and the yard inside.
    const SIDE_OUT = { s: [0, -1], n: [0, 1], w: [-1, 0], e: [1, 0] };
    const gateOn = (side, isIn, isWall, ctr) => {
        const out = SIDE_OUT[side];
        const ideal = { x: Math.round(ctr.cx + out[0] * ctr.ex + (out[0] ? 0 : int(r, -2, 2))), y: Math.round(ctr.cy + out[1] * ctr.ey + (out[1] ? 0 : int(r, -2, 2))) };
        let best = null;
        for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
            const x = ideal.x + i, y = ideal.y + j;
            if (!isWall(x, y) || isIn(x + out[0], y + out[1]) || !isIn(x - out[0], y - out[1]) || isWall(x - out[0], y - out[1])) continue;
            const d = Math.abs(i) + Math.abs(j);
            if (!best || d < best.d) best = { x, y, out, d };
        }
        return best ?? { ...ideal, out };
    };
    const mainC = round ? { cx: cxm, cy: cym, ex: rx, ey: ry } : { cx: main.x + (main.w - 1) / 2, cy: main.y + (main.h - 1) / 2, ex: (main.w - 1) / 2, ey: (main.h - 1) / 2 };
    const annexOn = side => Boolean(rects[1]) && (side === 's' ? rects[1].y < main.y : side === 'n' ? rects[1].y + rects[1].h > main.y + main.h : side === 'e' ? rects[1].x + rects[1].w > main.x + main.w : rects[1].x < main.x);
    const gateSide = pick(r, ['s', 's', 'n', 'e', 'w'].filter(sd => !annexOn(sd)));
    const notional = side => ({ x: Math.round(mainC.cx + SIDE_OUT[side][0] * mainC.ex), y: Math.round(mainC.cy + SIDE_OUT[side][1] * mainC.ey), out: SIDE_OUT[side] });
    const gate = walled ? gateOn(gateSide, inside, isWallSq, mainC) : notional(gateSide);
    const opposite = { s: 'n', n: 's', e: 'w', w: 'e' }[gateSide];
    const backSide = spec.size === 'small' ? null : annexOn(opposite) ? pick(r, ['e', 'w', 'n', 's'].filter(sd => sd !== gateSide && sd !== opposite && !annexOn(sd))) : opposite;
    const back = backSide && walled ? gateOn(backSide, inside, isWallSq, mainC) : null;
    let doorN = 0;
    const addDoor = (x, y, kind, state, rooms, extra = {}) => {
        const id = `D${++doorN}`;
        place.doors[id] = { id, floor: 'F0', x, y, kind, state, rooms, ...extra };
        if (kind !== 'trapdoor') set(x, y, kind === 'cell' ? (state === 'locked' ? 'J' : state === 'open' ? '/' : 'j') : state === 'locked' ? 'D' : state === 'open' ? '/' : '+');
        return place.doors[id];
    };
    if (walled) {
        addDoor(gate.x, gate.y, 'door', spec.gates, ['GATE', 'APPROACH'], { gate: true, name: 'main gate', dc: 15 });
        if (back) addDoor(back.x, back.y, 'door', 'locked', ['BACK', null], { gate: true, name: 'back gate', dc: 15 });
    }
    // The paths out: from each gate to the map's edge, winding a little.
    const path = new Set();
    const carvePath = g => {
        let x = g.x + g.out[0], y = g.y + g.out[1];
        const exits = [];
        for (let steps = 0; steps < 80 && x >= 0 && y >= 0 && x < W && y < H; steps++) {
            if (!inside(x, y)) { path.add(K(x, y)); set(x, y, ':'); if (g.out[0]) { path.add(K(x, y + 1)); set(x, y + 1, ':'); } else { path.add(K(x + 1, y)); set(x + 1, y, ':'); } }
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { exits.push({ floor: 'F0', x, y }); if (g.out[0]) exits.push({ floor: 'F0', x, y: Math.min(H - 1, y + 1) }); else exits.push({ floor: 'F0', x: Math.min(W - 1, x + 1), y }); break; }
            if (r() < 0.2 && steps > 2) { if (g.out[0]) y += pick(r, [-1, 1]); else x += pick(r, [-1, 1]); } else { x += g.out[0]; y += g.out[1]; }
        }
        return exits;
    };
    place.exits.push(...carvePath(gate));
    if (back) place.exits.push(...carvePath(back));
    const nearPath = (x, y, d = 1) => { for (let i = -d; i <= d; i++) for (let j = -d; j <= d; j++) if (path.has(K(x + i, y + j))) return true; return false; };
    const wallDist = (x, y) => { let best = 99; for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) if (isWallSq(x + i, y + j)) best = Math.min(best, Math.max(Math.abs(i), Math.abs(j))); return best; };
    const nearGate = (x, y, d) => Math.max(Math.abs(x - gate.x), Math.abs(y - gate.y)) <= d || (back && Math.max(Math.abs(x - back.x), Math.abs(y - back.y)) <= d);
    // Props: anything placed is remembered so nothing lands on it.
    const taken = new Set();
    const isTaken = (x, y) => taken.has(K(x, y));
    const put = (x, y, type, extra = {}) => {
        const w = extra.w || 1, h = extra.h || 1;
        for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (isTaken(x + i, y + j) || get(x + i, y + j) === '%' || get(x + i, y + j) === '#') return null;
        const p = { x, y, type, ...extra };
        map.props.push(p);
        for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) taken.add(K(x + i, y + j));
        return p;
    };
    // Watchtowers inside the wall at the corners (round: at the diagonals; more on a bigger camp): a
    // 2x2 platform the lookouts stand on, nudged in toward the middle until it stands on open ground.
    const towers = [];
    if (walled) {
        const pts = [];
        if (round) {
            const list = spec.size === 'small' ? shuffle(r, [45, 135, 225, 315]).slice(0, 2) : spec.size === 'massive' ? [0, 45, 90, 135, 180, 225, 270, 315] : spec.size === 'big' ? [45, 135, 225, 315, 90, 270] : [45, 135, 225, 315];
            for (const a of list) { const t = a * Math.PI / 180; pts.push([Math.round(cxm + Math.cos(t) * (rx - 3)), Math.round(cym + Math.sin(t) * (ry - 3))]); }
        } else {
            const corners = [[main.x + 1, main.y + 1], [main.x + main.w - 3, main.y + 1], [main.x + 1, main.y + main.h - 3], [main.x + main.w - 3, main.y + main.h - 3]];
            pts.push(...(spec.size === 'small' ? shuffle(r, corners).slice(0, 2) : corners));
            if (spec.size === 'big' || spec.size === 'massive') pts.push([main.x + Math.floor(main.w / 2) - 1, main.y + 1], [main.x + Math.floor(main.w / 2) - 1, main.y + main.h - 3]);
            if (spec.size === 'massive') pts.push([main.x + 1, main.y + Math.floor(main.h / 2) - 1], [main.x + main.w - 3, main.y + Math.floor(main.h / 2) - 1]);
        }
        for (let [tx, ty] of pts) {
            let ok = false;
            for (let k = 0; k < 6 && !ok; k++) {
                ok = [[0, 0], [1, 0], [0, 1], [1, 1]].every(([i, j]) => interior(tx + i, ty + j));
                if (!ok) { tx += Math.sign(Math.round(cxm) - tx); ty += Math.sign(Math.round(cym) - ty); }
            }
            if (!ok || nearGate(tx, ty, 2) || nearGate(tx + 1, ty + 1, 2)) continue;
            const t = put(tx, ty, 'watchtower', { w: 2, h: 2 });
            if (t) towers.push(t);
        }
        // Torches along the wall, most of them by the gates, so the gate yard is lit at night.
        if (spec.hostile) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (!isWallSq(x, y) || get(x, y) !== '#') continue;
            if (nearGate(x, y, 3) ? r() < 0.45 : r() < 0.05) map.props.push({ x, y, type: 'torch' });
        }
    }
    // The zones: a grid of cells over the main rectangle's inside; the gate's cell is the gate yard,
    // the farthest the chief's; a massive camp walls its middle cell off as the inner stockade.
    const inner = { x: main.x + 1, y: main.y + 1, w: main.w - 2, h: main.h - 2 };
    const nx = spec.size === 'massive' ? 3 : Math.max(2, Math.round(inner.w / 10)), ny = spec.size === 'massive' ? 3 : Math.max(2, Math.round(inner.h / 9));
    const cells = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x0 = inner.x + Math.floor(inner.w * i / nx), x1 = inner.x + Math.floor(inner.w * (i + 1) / nx) - 1;
        const y0 = inner.y + Math.floor(inner.h * j / ny), y1 = inner.y + Math.floor(inner.h * (j + 1) / ny) - 1;
        cells.push({ i, j, rect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, cx: Math.floor((x0 + x1) / 2), cy: Math.floor((y0 + y1) / 2) });
    }
    if (rects[1]) { const b = rects[1]; cells.push({ i: -1, j: -1, rect: { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }, cx: b.x + Math.floor(b.w / 2), cy: b.y + Math.floor(b.h / 2), annex: true }); }
    const gateIn = { x: gate.x + (walled ? -gate.out[0] : 0), y: gate.y + (walled ? -gate.out[1] : 0) };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const roleRooms = Object.values(plan.rooms).filter(rm => rm.role);
    const byRole = role => roleRooms.filter(rm => rm.role === role);
    const gateCell = cells.filter(cl => !cl.annex).sort((p, q) => dist({ x: p.cx, y: p.cy }, gateIn) - dist({ x: q.cx, y: q.cy }, gateIn))[0];
    gateCell.role = 'gate';
    const middle = spec.size === 'massive' ? cells.find(cl => cl.i === 1 && cl.j === 1) : null;
    if (middle) middle.role = 'keep';
    for (const cl of cells) { let n = 0; for (let x = cl.rect.x; x < cl.rect.x + cl.rect.w; x++) for (let y = cl.rect.y; y < cl.rect.y + cl.rect.h; y++) if (interior(x, y)) n++; cl.area = n; }
    const roomy = cells.filter(cl => !cl.role && !cl.annex && cl.area >= 45);
    const farthest = (roomy.length >= 2 ? roomy : cells.filter(cl => !cl.role && !cl.annex)).sort((p, q) => dist({ x: q.cx, y: q.cy }, gateIn) - dist({ x: p.cx, y: p.cy }, gateIn));
    const order = roleRooms.map(rm => rm.role).filter(role => !['gate', 'keep', 'fire'].includes(role));
    // The lodge and the pens far from the gate; the back gate's yard by the back gate; the rest by chance.
    const give = (role, cl) => { if (cl && !cl.role) { cl.role = role; return true; } return false; };
    for (const role of ['lodge', 'pens']) if (order.includes(role)) { const cl = farthest.find(x => !x.role); give(role, cl); order.splice(order.indexOf(role), 1); }
    if (back && order.includes('back')) { const cl = cells.filter(x => !x.role).sort((p, q) => dist({ x: p.cx, y: p.cy }, back) - dist({ x: q.cx, y: q.cy }, back))[0]; give('back', cl); order.splice(order.indexOf('back'), 1); }
    for (const cl of shuffle(r, cells.filter(x => !x.role))) cl.role = order.shift() ?? 'tents';
    // The fire circle: in the middle of the camp (a massive camp: in the yard before the inner stockade).
    const fireAt = middle ? { x: gateCell.cx, y: gateCell.cy } : { x: Math.floor(inner.x + inner.w / 2), y: Math.floor(inner.y + inner.h / 2) };
    const fr = spec.size === 'small' ? 2 : 3;
    const fireRect = { x: fireAt.x - fr, y: fireAt.y - fr, w: fr * 2 + 1, h: fr * 2 + 1 };
    const inFire = (x, y) => x >= fireRect.x && x < fireRect.x + fireRect.w && y >= fireRect.y && y < fireRect.y + fireRect.h;
    // The inner stockade: its own ring round the middle, a locked gate facing the main gate.
    let innerGate = null, innerRect = null, innerOut = null;
    if (middle) {
        let innerIn;
        if (round) {
            const kx = 0.5, ky = 0.5;
            innerIn = (x, y) => ellipseIn(x, y, kx, ky);
            innerRect = { x: Math.floor(cxm - rx * kx), y: Math.floor(cym - ry * ky), w: Math.ceil(rx * kx * 2) + 1, h: Math.ceil(ry * ky * 2) + 1 };
        } else {
            // Three squares bigger than its cell on every side: room for the lodge and the pen with a yard between.
            innerRect = { x: middle.rect.x - 3, y: middle.rect.y - 3, w: middle.rect.w + 6, h: middle.rect.h + 6 };
            innerIn = (x, y) => x >= innerRect.x && x < innerRect.x + innerRect.w && y >= innerRect.y && y < innerRect.y + innerRect.h;
        }
        const innerWall = (x, y) => innerIn(x, y) && DIRS8.some(([dx, dy]) => !innerIn(x + dx, y + dy));
        for (let x = innerRect.x; x < innerRect.x + innerRect.w; x++) for (let y = innerRect.y; y < innerRect.y + innerRect.h; y++) if (innerWall(x, y) && interior(x, y)) set(x, y, '#');
        const ic = { cx: innerRect.x + (innerRect.w - 1) / 2, cy: innerRect.y + (innerRect.h - 1) / 2, ex: (innerRect.w - 1) / 2, ey: (innerRect.h - 1) / 2 };
        const g = gateOn(gateSide, innerIn, (x, y) => innerWall(x, y) && get(x, y) === '#', ic);
        innerGate = addDoor(g.x, g.y, 'door', 'locked', ['KEEP', 'GATE'], { gate: true, name: 'inner gate', dc: 15 });
        innerOut = g.out;
        middle.rect = { x: innerRect.x + 1, y: innerRect.y + 1, w: innerRect.w - 2, h: innerRect.h - 2 };
        middle.cx = Math.round(ic.cx); middle.cy = Math.round(ic.cy);
    }
    const open = (x, y) => interior(x, y) && get(x, y) !== '#';
    // Walking as the path finder walks: any ground that isn't solid (doors count as open, the band
    // has the keys), diagonals never cutting a corner. Used to make sure nothing seals a yard off.
    const SOLID_CH = new Set(['%', '#', 'T', 'o', 'w', 'L']);
    const floodFrom = (from, blocked) => {
        const ground = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !SOLID_CH.has(get(x, y)) && !blocked(x, y);
        const seen = new Set([K(from.x, from.y)]), queue = [[from.x, from.y]];
        for (let qi = 0; qi < queue.length; qi++) {
            const [x, y] = queue[qi];
            for (const [dx, dy] of DIRS8) {
                const nx2 = x + dx, ny2 = y + dy, k = K(nx2, ny2);
                if (seen.has(k) || !ground(nx2, ny2)) continue;
                if (dx && dy && !(ground(x + dx, y) && ground(x, y + dy))) continue;
                seen.add(k); queue.push([nx2, ny2]);
            }
        }
        return seen;
    };
    const blockSet = () => { const out = new Set(); for (const pr of map.props) if (PROPS[pr.type]?.blocks && !pr.hidden) for (let a = 0; a < (pr.w || 1); a++) for (let b = 0; b < (pr.h || 1); b++) out.add(K(pr.x + a, pr.y + b)); return out; };
    const lane = new Set();
    const onLane = (x, y) => lane.has(K(x, y));
    const nearDoorSq = (x, y) => Object.values(place.doors).some(d => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1);
    // Huts and the pen: walled rooms inside a zone, a step away from the palisade and from any gate.
    const hutRects = [];
    const hutFits = (x, y, w, h) => {
        // Its walls on open ground, and open ground in front of where its door will be (the side facing the fire).
        for (let i = -1; i <= w; i++) for (let j = -1; j <= h; j++) {
            const px = x + i, py = y + j;
            if (!open(px, py) || isTaken(px, py) || inFire(px, py) || nearDoorSq(px, py)) return false;
        }
        const dx = fireAt.x - (x + w / 2), dy = fireAt.y - (y + h / 2);
        const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 'n' : 's');
        const front = side === 'e' ? [x + w + 1, y + Math.floor(h / 2)] : side === 'w' ? [x - 2, y + Math.floor(h / 2)] : side === 'n' ? [x + Math.floor(w / 2), y + h + 1] : [x + Math.floor(w / 2), y - 2];
        if (!open(front[0], front[1])) return false;
        return !hutRects.some(q => x < q.x + q.w + 1 && x + w + 1 > q.x && y < q.y + q.h + 1 && y + h + 1 > q.y);
    };
    let bN = 0;
    const buildHut = (cl, w, h, { id, name, type, wall = 'log', floor = 'planks', door = 'door', state = 'closed', dc = null, enter = null }, prefer = null) => {
        // Anywhere in the camp (inside the stockade for the keep), nearest the zone's middle or the point asked for.
        const within = cl.role === 'keep' ? (x, y) => x >= cl.rect.x && x < cl.rect.x + cl.rect.w && y >= cl.rect.y && y < cl.rect.y + cl.rect.h : () => true;
        const spots = [];
        for (let x = inner.x; x + w <= inner.x + inner.w; x++) for (let y = inner.y; y + h <= inner.y + inner.h; y++) if (within(x, y) && within(x + w - 1, y + h - 1) && hutFits(x, y, w, h)) spots.push([x, y]);
        if (!spots.length) return null;
        const want = prefer ?? { x: cl.cx, y: cl.cy };
        spots.sort((p, q) => Math.hypot(p[0] + w / 2 - want.x, p[1] + h / 2 - want.y) - Math.hypot(q[0] + w / 2 - want.x, q[1] + h / 2 - want.y));
        // Never where it would cut part of the camp off: whatever the gate reaches now it must still reach (bar the hut's own squares).
        const blocks = blockSet();
        const before = floodFrom(gateIn, (x, y) => blocks.has(K(x, y)));
        let chosen = null;
        for (const [sx, sy] of spots.slice(0, 24)) {
            const o = { x: sx - 1, y: sy - 1, w: w + 2, h: h + 2 };
            const inO = (x, y) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;
            const after = floodFrom(gateIn, (x, y) => blocks.has(K(x, y)) || inO(x, y));
            let cut = false;
            for (const k of before) { if (after.has(k)) continue; const [x, y] = k.split(',').map(Number); if (!inO(x, y)) { cut = true; break; } }
            if (!cut) { chosen = [sx, sy]; break; }
        }
        if (!chosen) return null;
        const [x, y] = chosen;
        const outer = { x: x - 1, y: y - 1, w: w + 2, h: h + 2 };
        hutRects.push(outer);
        // A building with an inside is solid on this map, under a roof; a pen is open to the sky, its walls a ring.
        const roofed = Boolean(enter);
        for (let i = outer.x; i < outer.x + outer.w; i++) for (let j = outer.y; j < outer.y + outer.h; j++) if (roofed || i === outer.x || j === outer.y || i === outer.x + outer.w - 1 || j === outer.y + outer.h - 1) { set(i, j, '#'); taken.add(K(i, j)); }
        // The door on the side that faces the camp's fire (the way everyone comes), in the middle of it.
        const dx = fireAt.x - (x + w / 2), dy = fireAt.y - (y + h / 2);
        const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 'n' : 's');
        const d = side === 'e' ? { x: outer.x + outer.w - 1, y: y + Math.floor(h / 2) } : side === 'w' ? { x: outer.x, y: y + Math.floor(h / 2) } : side === 'n' ? { x: x + Math.floor(w / 2), y: outer.y + outer.h - 1 } : { x: x + Math.floor(w / 2), y: outer.y };
        const dr = roofed ? addDoor(d.x, d.y, 'door', 'closed', [null, null], { enter }) : addDoor(d.x, d.y, door, state, [id, roomIdOf(cl)], dc ? { dc } : {});
        taken.delete(K(d.x, d.y));
        taken.add(K(d.x + (side === 'e' ? 1 : side === 'w' ? -1 : 0), d.y + (side === 'n' ? 1 : side === 's' ? -1 : 0)));
        if (roofed) {
            // The roof leaves the wall with the door showing, as a town house does.
            const rf = side === 'n' ? { x: outer.x, y: outer.y, w: outer.w, h: outer.h - 1 } : side === 's' ? { x: outer.x, y: outer.y + 1, w: outer.w, h: outer.h - 1 } : side === 'e' ? { x: outer.x, y: outer.y, w: outer.w - 1, h: outer.h } : { x: outer.x + 1, y: outer.y, w: outer.w - 1, h: outer.h };
            map.roofs.push({ ...rf, shape: rf.w >= 3 && rf.h >= 3 ? 'hip' : 'gable', ridge: rf.w >= rf.h ? 'h' : 'v', hue: int(r, 18, 30), sat: int(r, 22, 34), light: int(r, 22, 30), style: pick(r, ['thatch', 'thatch', 'shingle']), chimney: type === 'lodge' });
            map.areas.push({ ...outer, wall, floor, building: enter });
            place.buildings[enter] = { id: enter, name, kind: type, sign: '', keeper: '', description: '', size: 'small', enterable: true, door: dr.id, rect: { ...outer }, interior: null, zone: roomIdOf(cl) };
            return { rect: outer, outer, door: dr, building: place.buildings[enter] };
        }
        place.rooms[id] = { id, name, type, floor: 'F0', rect: { x, y, w, h }, lit: true, description: '', exit: false, hut: true };
        map.areas.push({ x, y, w, h, wall, floor, room: id });
        return { rect: { x, y, w, h }, outer, door: dr };
    };
    const roomIdOf = cl => cl.roomId ?? null;
    // Register the zones as rooms (the plan's named zones, in the roles the cells got).
    const pools = {};
    for (const rm of roleRooms) (pools[rm.role] ??= []).push(rm);
    for (const cl of cells) {
        const rm = (pools[cl.role] ??= []).shift() ?? { id: `${cl.role.toUpperCase()}${int(r, 2, 99)}`, name: pick(r, ZONE_NAMES[cl.role] ?? ['Yard']), type: ZONE_TYPES[cl.role] ?? 'room', description: '', items: [], traps: [] };
        cl.roomId = rm.id; cl.room = rm;
        place.rooms[rm.id] = { id: rm.id, name: rm.name, type: cl.role === 'keep' ? 'courtyard' : rm.type, floor: 'F0', rect: { ...cl.rect }, lit: true, description: rm.description, exit: false, role: cl.role };
    }
    const fireRoom = byRole('fire')[0] ?? { id: 'FIRE', name: 'Fire Circle', type: 'courtyard', description: '', items: [], traps: [] };
    place.rooms[fireRoom.id] = { id: fireRoom.id, name: fireRoom.name, type: 'courtyard', floor: 'F0', rect: { ...fireRect }, lit: true, description: fireRoom.description, exit: false, role: 'fire' };
    const approach = plan.rooms.find(rm => rm.id === 'APPROACH') ?? { id: 'APPROACH', name: 'The Approach', type: 'courtyard', description: '', items: [], traps: [] };
    const apRect = gate.out[1] ? { x: gate.x - 3, y: gate.out[1] < 0 ? gate.y - 5 : gate.y + 1, w: 7, h: 5 } : { x: gate.out[0] < 0 ? gate.x - 5 : gate.x + 1, y: gate.y - 3, w: 5, h: 7 };
    place.rooms[approach.id] = { id: approach.id, name: approach.name, type: 'courtyard', floor: 'F0', rect: { x: clamp(apRect.x, 0, W - apRect.w), y: clamp(apRect.y, 0, H - apRect.h), w: apRect.w, h: apRect.h }, lit: true, description: approach.description, exit: true, role: 'approach' };
    // Fix the gate doors' rooms now the ids are known.
    for (const d of Object.values(place.doors)) {
        if (d.rooms[0] === 'GATE') d.rooms[0] = gateCell.roomId;
        if (d.rooms[1] === 'GATE') d.rooms[1] = gateCell.roomId;
        if (d.rooms[0] === 'BACK') d.rooms[0] = cells.find(cl => cl.role === 'back')?.roomId ?? null;
        if (d.rooms[0] === 'KEEP') d.rooms[0] = middle?.roomId ?? null;
        if (d.rooms[1] === 'APPROACH') d.rooms[1] = approach.id;
    }
    // Free squares of a zone for dressing: open ground, not a lane, not taken, not the fire, not a hut.
    const inHut = (x, y) => hutRects.some(q => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
    const freeIn = (cl, { edge = 0, awayFromWall = 1 } = {}) => {
        const z = cl.rect, out = [];
        for (let x = z.x + edge; x < z.x + z.w - edge; x++) for (let y = z.y + edge; y < z.y + z.h - edge; y++) {
            if (!open(x, y) || onLane(x, y) || isTaken(x, y) || inFire(x, y) || inHut(x, y)) continue;
            if (awayFromWall && DIRS.some(([dx, dy]) => get(x + dx, y + dy) === '#' || '+D/Jj'.includes(get(x + dx, y + dy)))) continue;
            out.push([x, y]);
        }
        return shuffle(r, out);
    };
    const scatter = (cl, types, n, extra = {}) => { const free = freeIn(cl); let k = 0; for (const [x, y] of free) { if (k >= n) break; if (put(x, y, pick(r, types), typeof extra === 'function' ? extra() : extra)) k++; } return k; };
    const mark = (cl, types, n) => { const free = freeIn(cl); for (const [x, y] of free.slice(0, n)) map.props.push({ x, y, type: pick(r, types) }); };
    const tentLook = () => ({ hue: int(r, 18, 48), tone: int(r, 30, 56) });
    const hutDoors = [];
    // A peaceful camp's leader sleeps in a big tent; a band's chief has a log lodge with his strongbox.
    const chiefLodge = (cl, prefer = null) => {
        if (!spec.hostile) { const free = freeIn(cl, { edge: 1 }).find(([x, y]) => !isTaken(x + 1, y) && !isTaken(x, y + 1) && !isTaken(x + 1, y + 1) && open(x + 1, y + 1)); if (free) put(free[0], free[1], 'tent', { w: 2, h: 2, label: 'the elder\'s tent' }); return null; }
        const h = buildHut(cl, spec.size === 'small' ? 3 : 4, spec.size === 'small' ? 2 : 3, { id: `${cl.roomId}H`, name: pick(r, ['Chief\'s Lodge', 'The Chief\'s Hut', 'War Lodge']), type: 'lodge', wall: 'log', floor: 'planks', enter: `B${++bN}` }, prefer);
        if (!h) { bN--; put(cl.cx, cl.cy, 'tent', { w: 2, h: 2, label: 'the chief\'s tent' }); return null; }
        hutDoors.push(h.door);
        h.building.keeper = spec.chief || '';
        h.building.description = `The chief's log lodge: his hall and his bed, his strongbox${spec.cannibal ? ', and what he keeps of his meals' : ''}.`;
        h.building.inside = { kind: 'lodge', size: spec.size, horror: spec.horror, cannibal: spec.cannibal, items: [], guards: [], tunnels: false };
        return h;
    };
    // The camp's other houses: a cannibal camp's flesh house and bone shrine, a band's long house and store house.
    const HOUSES = {
        butchery: { names: ['The Flesh House', 'The Butcher\'s Hut', 'The Smokehouse'], w: 3, h: 2, description: 'Where the camp\'s meat is cut and hung. The smell reaches the gate.', keeper: ['the Butcher', 'Mother Gristle', 'Cleaver Jen', 'the Flayer'] },
        shrine: { names: ['The Bone Shrine', 'House of Skulls', 'The Skull Lodge'], w: 2, h: 2, description: 'A hut of skulls and candles where the band\'s god is fed.', keeper: ['the Bone Priest', 'Old Marrow', 'the Mouth'] },
        longhouse: { names: ['The Long House', 'Bunk Hall', 'The Sleeping Hall'], w: spec.size === 'medium' ? 4 : 5, h: 2, description: 'Bunks for the band, their chests and their drink.', keeper: ['Harl', 'Pim', 'Oska', 'Dunn', 'Wex'] },
        storehouse: { names: ['The Stores', 'The Loot House', 'The Plunder Shed'], w: 3, h: 2, description: 'The band\'s plunder under a roof: crates, casks, locked chests.', keeper: [] },
    };
    const buildHouse = (cl, kind) => {
        const H0 = HOUSES[kind];
        if (!cl || !H0) return null;
        const id = `B${++bN}`;
        const h = buildHut(cl, H0.w, H0.h, { id, name: pick(r, H0.names), type: kind, wall: 'log', floor: 'planks', enter: id });
        if (!h) { bN--; return null; }
        hutDoors.push(h.door);
        h.building.keeper = H0.keeper.length ? pick(r, H0.keeper) : '';
        h.building.description = H0.description;
        h.building.inside = { kind, size: spec.size, horror: spec.horror, cannibal: spec.cannibal, items: [], guards: [], band: spec.cannibal ? 'Cannibal' : 'Raider' };
        return h;
    };
    const buildPen = (cl, prefer = null) => {
        const h = buildHut(cl, spec.size === 'small' ? 3 : cl.role === 'keep' ? 4 : int(r, 4, 5), spec.size === 'small' ? 2 : cl.role === 'keep' ? 3 : int(r, 3, 4), { id: `${cl.roomId}P`, name: pick(r, ['The Pen', 'The Cages', 'Prisoner Pen']), type: 'cell', wall: spec.walls === 'stone' ? 'stoneblock' : 'palisade', floor: 'mud', door: 'cell', state: 'locked', dc: 13 }, prefer);
        if (!h) return null;
        hutDoors.push(h.door);
        const { x, y, w, h: hh } = h.rect;
        if (w >= 5 && hh >= 3) put(x, y, 'cage', { w: 2, h: 2, label: 'a big cage' }); else put(x, y, 'cage');
        put(x + w - 1, y + hh - 1, 'cage');
        if (hh > 2) put(x + w - 1, y, 'hay');
        map.props.push({ x: x + Math.floor(w / 2), y: y + Math.floor(hh / 2), type: 'blood' });
        if (spec.cannibal) map.props.push({ x: x + 1, y: y + hh - 1, type: 'bones' });
        place.rooms[`${cl.roomId}P`].type = 'cell';
        return h;
    };
    // First the huts and the pen (the lanes go round them), then the lanes, then the dressing.
    for (const cl of cells) {
        if (cl.role === 'keep' && innerGate) {
            // The lodge at the far end of the stockade from its gate, the pen at the near end.
            const dx = Math.sign(cl.cx - innerGate.x), dy = Math.sign(cl.cy - innerGate.y);
            chiefLodge(cl, { x: cl.cx + dx * cl.rect.w * 0.3, y: cl.cy + dy * cl.rect.h * 0.3 });
            buildPen(cl, { x: cl.cx - dx * cl.rect.w * 0.3, y: cl.cy - dy * cl.rect.h * 0.3 });
            continue;
        }
        if (cl.role === 'lodge' || cl.role === 'keep') chiefLodge(cl);
        if (cl.role === 'pens' || cl.role === 'keep') buildPen(cl);
    }
    if (spec.hostile) {
        const want = spec.cannibal
            ? [['butchery', 'cook'], ...(spec.size === 'big' || spec.size === 'massive' ? [['shrine', 'shrine']] : [])]
            : [...(spec.size !== 'small' ? [['longhouse', 'tents']] : []), ...(spec.size === 'big' || spec.size === 'massive' ? [['storehouse', 'supplies']] : [])];
        for (const [kind, role] of want) buildHouse(cells.find(x => x.role === role && x !== middle) ?? cells.find(x => !['gate', 'keep', 'fire'].includes(x.role)), kind);
    }
    // Lanes: nothing is ever built on them, so every part of the camp can be walked to. The street
    // runs from the gate to the fire and on to the back gate; each zone has a lane to the street.
    const blockedForLane = (x, y) => { const ch = get(x, y); if ('+D/'.includes(ch)) return false; return !open(x, y) || isTaken(x, y) || (Math.abs(x - fireAt.x) <= 1 && Math.abs(y - fireAt.y) <= 1); };
    const bfs = (from, goal) => {
        const prev = new Map([[K(from.x, from.y), null]]);
        const queue = [from];
        for (let qi = 0; qi < queue.length; qi++) {
            const cur = queue[qi];
            if (goal(cur.x, cur.y) && qi > 0) { const out = []; let k = K(cur.x, cur.y); while (k) { out.push(k); k = prev.get(k); } return out; }
            for (const [dx, dy] of DIRS) {
                const nx2 = cur.x + dx, ny2 = cur.y + dy, k = K(nx2, ny2);
                if (prev.has(k) || blockedForLane(nx2, ny2)) continue;
                prev.set(k, K(cur.x, cur.y)); queue.push({ x: nx2, y: ny2 });
            }
        }
        return null;
    };
    const carveLane = (from, goal, wide = false) => {
        const got = bfs(from, goal);
        if (!got) return false;
        for (const k of got) {
            lane.add(k);
            if (wide) { const [x, y] = k.split(',').map(Number); for (const [dx, dy] of [[1, 0], [0, 1]]) if (open(x + dx, y + dy) && !blockedForLane(x + dx, y + dy)) lane.add(K(x + dx, y + dy)); }
        }
        return true;
    };
    const fireEdge = (x, y) => Math.max(Math.abs(x - fireAt.x), Math.abs(y - fireAt.y)) === 2;
    carveLane(gateIn, fireEdge, true);
    if (innerGate) carveLane(gateIn, (x, y) => x === innerGate.x && y === innerGate.y, true);
    if (back) carveLane({ x: back.x - back.out[0], y: back.y - back.out[1] }, (x, y) => lane.has(K(x, y)) || fireEdge(x, y), true);
    for (const cl of cells) {
        const target = { x: cl.cx, y: cl.cy };
        if (blockedForLane(target.x, target.y)) { const alt = freeIn(cl).find(([x, y]) => !blockedForLane(x, y)); if (!alt) continue; target.x = alt[0]; target.y = alt[1]; }
        if (cl === middle) carveLane({ x: innerGate.x - innerOut[0], y: innerGate.y - innerOut[1] }, (x, y) => x === target.x && y === target.y);
        else carveLane(target, (x, y) => lane.has(K(x, y)) || (x === gateIn.x && y === gateIn.y));
    }
    // The lanes are trodden paths: worn dirt, painted as such.
    for (const k of lane) { const [x, y] = k.split(',').map(Number); if (get(x, y) === '.') set(x, y, ':'); }
    for (const cl of cells) {
        const role = cl.role;
        const dens = Math.max(1, Math.round(cl.rect.w * cl.rect.h / 55));
        if (role === 'lodge') { scatter(cl, ['brazier'], 1); scatter(cl, ['weaponrack', 'crate', 'barrel', 'skullpole'], 2); }
        else if (role === 'pens') { scatter(cl, ['cage'], spec.size === 'small' ? 1 : 2); scatter(cl, ['stocks', 'hay', 'trough', 'bones'], 2); if (spec.cannibal) scatter(cl, ['skullpole'], 1); }
        else if (role === 'keep') { scatter(cl, ['brazier'], 2); scatter(cl, ['campfire'], 1); scatter(cl, ['cage'], 2); scatter(cl, ['tent'], 2, tentLook); scatter(cl, ['skullpole', 'weaponrack', 'crate', 'barrel', 'stocks'], 3 + dens); }
        else if (role === 'gate') { scatter(cl, ['brazier'], 1); scatter(cl, ['crate', 'barrel', 'weaponrack', 'cart', 'sack'], (spec.size === 'small' ? 2 : 3) + dens); scatter(cl, ['spikes'], (spec.size === 'small' ? 1 : 2) + dens, spec.cannibal ? { gory: true } : {}); if (spec.cannibal) scatter(cl, ['skullpole'], 1 + dens); mark(cl, ['debris', 'scratches'], dens); }
        else if (role === 'tents') { const n = Math.max(2, Math.floor(cl.rect.w * cl.rect.h / 14)); const big = freeIn(cl, { edge: 1 }).find(([x, y]) => [[1, 0], [0, 1], [1, 1]].every(([i, j]) => open(x + i, y + j) && !isTaken(x + i, y + j) && !onLane(x + i, y + j) && !inHut(x + i, y + j))); if (big) put(big[0], big[1], 'tent', { w: 2, h: 2, ...tentLook() }); scatter(cl, ['tent'], n, tentLook); scatter(cl, ['campfire'], 1); scatter(cl, ['log', 'barrel', 'crate', 'sack', 'hay', 'weaponrack'], 2 + dens); mark(cl, ['ash', 'debris'], dens); }
        else if (role === 'cook') { scatter(cl, ['campfire'], 1); scatter(cl, ['cauldron'], 1); scatter(cl, ['table', 'barrel', 'sack', 'crate', 'hooks'], 3 + dens); scatter(cl, spec.cannibal ? ['bones', 'skull', 'skullpole', 'stocks'] : ['bones', 'pot'], 2 + dens); mark(cl, spec.cannibal ? ['blood', 'blood', 'ash'] : ['ash', 'stain', 'blood'], 2 + dens); }
        else if (role === 'supplies') { scatter(cl, ['crate', 'barrel', 'sack', 'cart', 'hay'], Math.max(3, Math.floor(cl.rect.w * cl.rect.h / 9))); scatter(cl, ['chest'], 1); mark(cl, ['papers', 'debris'], dens); }
        else if (role === 'pit') { const free = freeIn(cl, { edge: 1 }); if (free.length) { const [px, py] = [cl.cx, cl.cy]; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if ((Math.abs(i) === 2 || Math.abs(j) === 2) && !(i === 0 && j === -2) && open(px + i, py + j) && !onLane(px + i, py + j)) put(px + i, py + j, 'fence'); map.props.push({ x: px, y: py, type: 'blood' }); put(px + 1, py, 'bones'); } scatter(cl, ['stocks', 'weaponrack', 'brazier'], 2); }
        else if (role === 'smithy') { scatter(cl, ['forge'], 1); scatter(cl, ['anvil'], 1); scatter(cl, ['weaponrack', 'workbench', 'barrel', 'crate'], 3); }
        else if (role === 'kennels') { scatter(cl, ['kennel'], 2); scatter(cl, ['bowl', 'bones', 'trough', 'fence'], 3); }
        else if (role === 'shrine') { scatter(cl, ['altar'], 1); scatter(cl, ['skullpole'], 2); scatter(cl, ['skull', 'bones', 'candles', 'brazier'], 3); }
        else if (role === 'back') { scatter(cl, ['crate', 'barrel', 'spikes'], 2); scatter(cl, ['brazier'], 1); }
        else if (role === 'watch') { scatter(cl, ['brazier'], 1); scatter(cl, ['weaponrack', 'spikes', 'hay'], 3); }
        // Obstacles here and there: a fence across the yard, a boulder, a wagon.
        if (r() < 0.6 && role !== 'pit') {
            const free = freeIn(cl, { edge: 1 });
            if (free.length) { const [fx, fy] = free[0]; const vertical = r() < 0.5, len = int(r, 2, 4); let ok = true; for (let k = 0; k < len; k++) if (!free.some(([x, y]) => x === fx + (vertical ? 0 : k) && y === fy + (vertical ? k : 0))) ok = false; if (ok) put(fx, fy, 'fence', vertical ? { h: len } : { w: len }); }
        }
        if (r() < 0.35) scatter(cl, ['boulder', 'cart', 'log'], 1);
        if (spec.hostile) { scatter(cl, ['barrel', 'crate', 'sack', 'log'], dens); mark(cl, ['debris', 'stain', 'scratches'], dens); }
        // A cannibal camp wears its trade: bones, skulls on poles, blood on the ground, stakes with heads on them.
        if (spec.cannibal) { scatter(cl, ['skull', 'bones', 'skullpole'], 1 + dens); scatter(cl, ['spikes'], dens, { gory: true }); mark(cl, ['blood', 'blood', 'bones'], 2 + dens); }
    }
    // The fire circle: the bonfire and the logs round it.
    const fireCl = { rect: fireRect, cx: fireAt.x, cy: fireAt.y, roomId: fireRoom.id };
    // The bonfire: a great 3x3 blaze for a band's camp, a modest one for travellers; ash and bones round it.
    if (spec.hostile) put(fireAt.x - 1, fireAt.y - 1, 'bonfire', { w: 3, h: 3 }); else put(fireAt.x, fireAt.y, 'bonfire');
    for (const [dx, dy] of [[-2, -1], [2, 1], [-1, 2], [1, -2], [2, -2], [-2, 2]]) if (r() < 0.6 && open(fireAt.x + dx, fireAt.y + dy)) map.props.push({ x: fireAt.x + dx, y: fireAt.y + dy, type: spec.cannibal && r() < 0.5 ? 'blood' : 'ash' });
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2]]) if (r() < 0.75 && !onLane(fireAt.x + dx, fireAt.y + dy)) put(fireAt.x + dx, fireAt.y + dy, 'log');
    scatter(fireCl, ['barrel', 'crate', 'sack'], 1);
    if (spec.cannibal) { put(fireAt.x + 3, fireAt.y + 3, 'skullpole'); put(fireAt.x - 3, fireAt.y - 3, 'skullpole'); put(fireAt.x - 3, fireAt.y + 3, 'bones'); put(fireAt.x + 3, fireAt.y - 3, 'spikes', { gory: true }); mark(fireCl, ['blood', 'bones'], 3); }
    // The ground: mud patches inside and by the gate, trampled dirt everywhere.
    const mudSpots = [];
    for (let i = 0; i < (spec.size === 'small' ? 3 : spec.size === 'massive' ? 9 : 6); i++) {
        const mx = int(r, inner.x, inner.x + inner.w - 5), my = int(r, inner.y, inner.y + inner.h - 4), mw = int(r, 3, 5), mh = int(r, 2, 4);
        if (hutRects.some(q => mx < q.x + q.w && mx + mw > q.x && my < q.y + q.h && my + mh > q.y)) continue;
        mudSpots.push({ x: mx, y: my, w: mw, h: mh, floor: 'mud' });
    }
    mudSpots.push(gate.out[1] ? { x: gate.x - 2, y: gate.out[1] > 0 ? gate.y + 1 : gate.y - 4, w: 5, h: 4, floor: 'mud' } : { x: gate.out[0] > 0 ? gate.x + 1 : gate.x - 4, y: gate.y - 2, w: 4, h: 5, floor: 'mud' });
    map.areas.push(...mudSpots);
    // The gates are painted as heavy timber gates, whatever area they fall in.
    map.gates = Object.values(place.doors).filter(d => d.gate).map(d => `${d.x},${d.y}`);
    // The killing ground outside: stakes in a broken ring, pits, then the woods beyond.
    if (walled) {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (inside(x, y) || path.has(K(x, y)) || nearPath(x, y, 1)) continue;
            const d = wallDist(x, y);
            if (d === 2 && r() < (nearGate(x, y, 7) ? 0.75 : 0.5)) put(x, y, 'spikes', spec.cannibal && r() < 0.5 ? { gory: true } : {});
            else if (d === 3 && nearGate(x, y, 7) && r() < 0.3) put(x, y, 'spikes', spec.cannibal ? { gory: true } : {});
            else if (d >= 3 && d <= 5 && r() < 0.03) set(x, y, 'o');
            else if (d >= 2 && d <= 6 && r() < 0.04) set(x, y, '^');
            else if (d >= 3 && d <= 6 && r() < (spec.cannibal ? 0.08 : 0.035)) map.props.push({ x, y, type: pick(r, spec.cannibal ? ['bones', 'skull', 'blood', 'bones'] : ['bones', 'debris', 'ash']) });
        }
    }
    const noise = smoothNoise(Math.floor(r() * 1e6), 6);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (inside(x, y) || path.has(K(x, y)) || nearPath(x, y, 1) || get(x, y) !== '.' || isTaken(x, y)) continue;
        const d = walled ? wallDist(x, y) : Math.max(Math.abs(x - fireAt.x), Math.abs(y - fireAt.y)) - Math.min(inner.w, inner.h) / 2;
        const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
        // The woods start a way off (the band cut the trees nearest the wall), thick at the map's edge.
        const far = spec.size === 'small' ? 5 : 6;
        if (d >= far || (edge <= 1 && d >= 3)) {
            const thick = 0.25 + noise(x, y) * 0.3 + (edge <= 2 ? 0.35 : 0) + (d >= far + 3 ? 0.2 : 0);
            if (r() < thick) { set(x, y, 'T'); continue; }
        }
        const under = r();
        if (d >= 3 && under < 0.05) put(x, y, 'log'); else if (d >= 3 && under < 0.08) put(x, y, 'boulder'); else if (d >= 3 && under < 0.1) put(x, y, 'bush'); else if (under < 0.11 && d >= 3) put(x, y, 'tallgrass');
    }
    // The tunnels: hidden trapdoors, one out in the woods, one under the straw of the pen, one under
    // the chief's rug (that one is inside his lodge). Each is a door into the "tunnels" building.
    const lodgeB = Object.values(place.buildings).find(b => b.kind === 'lodge');
    if (spec.tunnels && spec.hostile) {
        const entrances = [];
        const hatch = (x, y, name) => { const d = addDoor(x, y, 'trapdoor', 'hidden', [null, null], { enter: 'TUN', dc: 15, name, under: get(x, y) }); map.props.push({ x, y, type: 'trapdoor', hidden: true, door: d.id }); taken.add(K(x, y)); return d; };
        let first = null;
        const woods = [];
        for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
            if (inside(x, y) || get(x, y) !== '.' || isTaken(x, y) || path.has(K(x, y)) || nearPath(x, y, 2) || nearDoorSq(x, y)) continue;
            const d = walled ? wallDist(x, y) : 99;
            if (walled && (d < 4 || d > 8)) continue;
            const trees = DIRS8.filter(([dx, dy]) => get(x + dx, y + dy) === 'T').length;
            if (trees >= 1 && DIRS.some(([dx, dy]) => get(x + dx, y + dy) === '.' && !isTaken(x + dx, y + dy))) woods.push([x, y, trees + r()]);
        }
        if (woods.length) {
            const [x, y] = woods.sort((p, q) => q[2] - p[2])[0];
            const d = hatch(x, y, 'a hidden trapdoor in the woods');
            first = d;
            const beside = DIRS.map(([dx, dy]) => [x + dx, y + dy]).find(([bx, by]) => get(bx, by) === '.' && !isTaken(bx, by));
            if (beside) put(beside[0], beside[1], 'log');
            entrances.push({ door: d.id, host: null, label: 'the woods' });
        }
        const penRoom = Object.values(place.rooms).find(rm => rm.hut && rm.type === 'cell');
        if (penRoom && spec.cannibal) {
            const rc = penRoom.rect, spots = [];
            for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) if (open(x, y) && !isTaken(x, y) && !nearDoorSq(x, y)) spots.push([x, y]);
            if (spots.length) { const [x, y] = pick(r, spots); const d = hatch(x, y, 'a trapdoor under the straw of the pen'); first ??= d; entrances.push({ door: d.id, host: null, label: 'the pen' }); }
        }
        if (lodgeB) { lodgeB.inside.tunnels = true; entrances.push({ door: 'DH', host: lodgeB.id, label: 'the chief\'s lodge' }); }
        if (entrances.length) {
            const captiveN = plan.guards.filter(g => g.role === 'prisoner').length;
            place.buildings.TUN = {
                id: 'TUN', name: pick(r, ['The Tunnels', 'The Warren', 'The Holes Below', 'The Under-camp']), kind: 'tunnels', sign: '', keeper: '', size: spec.size, enterable: true,
                description: `A maze of dirt tunnels under the camp, shored with timber: the band's bolt-hole${spec.horror ? ', its larder and its question room' : ' and its hoard'}. Its trapdoors are hidden (${entrances.map(e => e.label).join(', ')}).`,
                door: first?.id ?? lodgeB?.door, rect: first ? { x: first.x, y: first.y, w: 1, h: 1 } : { ...lodgeB.rect }, interior: null,
                inside: { kind: 'tunnels', size: spec.size, horror: spec.horror, cannibal: spec.cannibal, entrances, band: spec.cannibal ? 'Cannibal' : 'Raider', items: [{ name: 'the band\'s takings', hidden: false, note: 'coin, rings and trinkets' }], captives: spec.horror ? [1, 2].map(i => ({ name: `Captive ${captiveN + i}`, description: pick(r, CAPTIVES) })) : [{ name: `Captive ${captiveN + 1}`, description: pick(r, CAPTIVES) }] },
            };
        }
    }
    // Nothing built may cut part of the camp off. Walk everywhere from the gate (doors count as open);
    // any crate, tent or fence that is the only thing between a reached square and an unreached one
    // is a plug, and goes. (Walls and the woods stay: they're the shape of the place.)
    for (let pass = 0; pass < 12; pass++) {
        const plug = new Map();
        for (const [i, pr] of map.props.entries()) if (PROPS[pr.type]?.blocks && !pr.hidden) for (let a = 0; a < (pr.w || 1); a++) for (let b = 0; b < (pr.h || 1); b++) plug.set(K(pr.x + a, pr.y + b), i);
        const ground = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !SOLID_CH.has(get(x, y));
        const reached = floodFrom(gateIn, (x, y) => plug.has(K(x, y)));
        const drop = new Set();
        for (const [k, i] of plug) {
            const [x, y] = k.split(',').map(Number);
            let near = false, far = false;
            for (const [dx, dy] of DIRS8) { const kk = K(x + dx, y + dy); if (!ground(x + dx, y + dy) || plug.has(kk)) continue; if (reached.has(kk)) near = true; else far = true; }
            if (near && far) drop.add(i);
        }
        if (!drop.size) break;
        map.props = map.props.filter((pr, i) => !drop.has(i));
    }
    // The whole map's walls are the palisade (or stone), its gates heavy timber; the huts had theirs first.
    map.areas.push({ x: 0, y: 0, w: W, h: H, wall: spec.walls === 'stone' ? 'stoneblock' : 'palisade', building: 'W' });
    // Traps: in the killing ground beside the path (never on it, never at the gate), and inside by
    // what's worth guarding (the chief's strongbox, the pen), never within a square of any door.
    const doorSq = Object.values(place.doors).map(d => [d.x, d.y]);
    const nearDoor = (x, y) => doorSq.some(([dx, dy]) => Math.abs(dx - x) <= 1 && Math.abs(dy - y) <= 1);
    const trapFree = (x, y) => '.:'.includes(get(x, y)) && !isTaken(x, y) && !nearDoor(x, y) && !onLane(x, y) && !path.has(K(x, y));
    const outsideSpots = shuffle(r, (() => { const out = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!inside(x, y) && trapFree(x, y) && !nearGate(x, y, 3)) { const d = walled ? wallDist(x, y) : 99; if ((walled && d >= 2 && d <= 5 && nearPath(x, y, 1)) || (!walled && nearPath(x, y, 1))) out.push([x, y]); } return out; })());
    const guarded = shuffle(r, map.props.filter(p => ['chest', 'cage', 'altar'].includes(p.type)).flatMap(p => DIRS.map(([dx, dy]) => [p.x + dx, p.y + dy])).filter(([x, y]) => trapFree(x, y) && inside(x, y)));
    const insideSpots = shuffle(r, cells.flatMap(cl => freeIn(cl, { edge: 1 }).filter(([x, y]) => trapFree(x, y)).slice(0, 3)));
    const addTrap = ([x, y], roomId, kindIn = null) => {
        const [kind, save, effect] = kindIn ?? pick(r, TRAP_KINDS);
        const id = `T${Object.keys(place.traps).length + 1}`;
        place.traps[id] = { id, room: roomId, floor: 'F0', x, y, kind, dc: int(r, 11, 14), save, effect, state: 'hidden' };
        map.props.push({ x, y, type: 'trap', hidden: true, trap: id, label: kind });
        taken.add(K(x, y));
    };
    const roomAtSq = (x, y) => Object.values(place.rooms).find(rm => x >= rm.rect.x && x < rm.rect.x + rm.rect.w && y >= rm.rect.y && y < rm.rect.y + rm.rect.h)?.id ?? null;
    let nT = spec.traps;
    const nOut = Math.ceil(nT * 0.6);
    for (let i = 0; i < nOut && outsideSpots.length; i++) { const p = outsideSpots.shift(); addTrap(p, roomAtSq(...p)); nT--; }
    for (let i = 0; i < nT; i++) { const p = guarded.find(([x, y]) => !isTaken(x, y)) ?? insideSpots.find(([x, y]) => !isTaken(x, y)); if (!p) break; addTrap(p, roomAtSq(...p)); }
    // The plan's own traps and items, in their zones.
    for (const rm of plan.rooms) {
        const cl = cells.find(x => x.roomId === rm.id) ?? (rm.id === fireRoom.id ? fireCl : null);
        for (const t of rm.traps ?? []) { const p = (cl ? freeIn(cl, { edge: 1 }) : insideSpots).find(([x, y]) => trapFree(x, y)); if (p) addTrap(p, rm.id, [t.kind, t.save || 'DEX', t.effect]); }
        for (const it of rm.items ?? []) {
            const bld = Object.values(place.buildings).find(b => b.zone === rm.id && b.inside && b.kind === 'lodge');
            if (bld) { bld.inside.items.push({ name: it.name, hidden: it.hidden === true, note: it.note || 'in the chief\'s strongbox' }); continue; }
            const hutId = Object.keys(place.rooms).find(id => id.startsWith(rm.id) && place.rooms[id].hut);
            const hut = hutId ? place.rooms[hutId].rect : null;
            const chest = hut ? map.props.find(p => p.type === 'chest' && p.x >= hut.x && p.x < hut.x + hut.w && p.y >= hut.y && p.y < hut.y + hut.h) : null;
            const p = chest ? [chest.x, chest.y] : (cl ? freeIn(cl) : [])[0] ?? [fireAt.x + 1, fireAt.y + 1];
            const id = `I${Object.keys(place.items).length + 1}`;
            place.items[id] = { id, name: it.name, room: hutId ?? rm.id, floor: 'F0', x: p[0], y: p[1], hidden: it.hidden === true, note: it.note || (chest ? 'in the chest' : ''), state: 'here' };
        }
    }
    // The people: lookouts up on the towers, gate guards at the gate, the chief in the lodge, the
    // band about the camp, captives in the pen.
    const standing = new Set();
    const spotIn = (cl, { pen = false } = {}) => {
        if (!cl) return null;
        const list = pen ? (() => { const id = Object.keys(place.rooms).find(k => k.startsWith(cl.roomId) && place.rooms[k].type === 'cell' && place.rooms[k].hut); const rc = id ? place.rooms[id].rect : cl.rect; const out = []; for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) if (open(x, y) && !isTaken(x, y)) out.push([x, y]); return shuffle(r, out); })() : freeIn(cl, { awayFromWall: 0 });
        const p = list.find(([x, y]) => !standing.has(K(x, y))) ?? [cl.cx, cl.cy];
        standing.add(K(...p));
        return p;
    };
    const cellOf = roomId => cells.find(cl => cl.roomId === roomId) ?? (roomId === fireRoom.id ? fireCl : null);
    let towerN = 0;
    for (const g of plan.guards) {
        if (g.chief && lodgeB) { lodgeB.inside.guards.push({ name: g.name, description: g.description, sprite: g.sprite || '' }); lodgeB.keeper = g.name; continue; }
        const cl = cellOf(g.room) ?? gateCell;
        let p;
        if (g.duty === 'lookout' && towers.length) { const t = towers[towerN++ % towers.length]; p = [t.x + (towerN % 2), t.y + (towerN % 2 ? 0 : 1)]; }
        else if (g.duty === 'gate') { const free = freeIn(gateCell, { awayFromWall: 0 }).filter(([x, y]) => Math.max(Math.abs(x - gateIn.x), Math.abs(y - gateIn.y)) <= 3); p = free.find(([x, y]) => !standing.has(K(x, y))) ?? spotIn(gateCell); standing.add(K(...p)); }
        else if (g.chief) { const hut = Object.values(place.rooms).find(rm => rm.hut && rm.id.startsWith(cl.roomId) && rm.type !== 'cell'); p = hut ? [hut.rect.x + 1, hut.rect.y + Math.floor(hut.rect.h / 2)] : spotIn(cl); if (hut && (isTaken(p[0], p[1]))) p = [hut.rect.x + Math.floor(hut.rect.w / 2), hut.rect.y + Math.floor(hut.rect.h / 2)]; }
        else if (g.role === 'prisoner') p = spotIn(cl, { pen: true });
        else p = spotIn(cl);
        const room = g.chief ? (Object.values(place.rooms).find(rm => rm.hut && rm.id.startsWith(cl.roomId) && rm.type !== 'cell')?.id ?? cl.roomId) : g.role === 'prisoner' ? (Object.keys(place.rooms).find(k => k.startsWith(cl.roomId) && place.rooms[k].type === 'cell' && place.rooms[k].hut) ?? cl.roomId) : cl.roomId;
        const patrol = g.patrol.map(id => (cellOf(id) ? id : null)).filter(Boolean);
        place.guards[g.name] = { name: g.name, description: g.description, hostile: g.hostile !== false, role: g.role || (g.hostile !== false ? 'hostile' : 'resident'), ...(g.sprite ? { sprite: g.sprite } : {}), ...(g.duty === 'lookout' ? { lookout: true } : {}), room, patrol: patrol.length ? patrol : [room], step: 0, floor: 'F0', x: p[0], y: p[1], state: 'patrol' };
        if (g.role === 'prisoner') place.guards[g.name].held = true;
    }
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    clearDoorways(place);
    // Where the party starts: the approach outside, by the fire, or in the pen.
    const startRoom = place.rooms[plan.start] ?? place.rooms[approach.id];
    const penRoom = Object.values(place.rooms).find(rm => rm.hut && rm.type === 'cell' && rm.id.startsWith(plan.start));
    const startIn = penRoom ?? startRoom;
    const dry = (x, y) => '.:='.includes(get(x, y)) && !map.props.some(p => PROPS[p.type]?.blocks && !p.hidden && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1)) && !Object.values(place.guards).some(g => g.x === x && g.y === y);
    let sx = startIn.rect.x + Math.floor(startIn.rect.w / 2), sy = startIn.rect.y + Math.floor(startIn.rect.h / 2);
    const cx0 = sx, cy0 = sy;
    for (let d = 0; d < 8 && !dry(sx, sy); d++) for (let i = -d; i <= d && !dry(sx, sy); i++) for (let j = -d; j <= d; j++) if (dry(cx0 + i, cy0 + j) && (startIn.hut ? cx0 + i >= startIn.rect.x && cx0 + i < startIn.rect.x + startIn.rect.w && cy0 + j >= startIn.rect.y && cy0 + j < startIn.rect.y + startIn.rect.h : true)) { sx = cx0 + i; sy = cy0 + j; break; }
    place.start = { floor: 'F0', x: sx, y: sy, room: startIn.id };
    // What's known: the land outside and the wall itself; the inside only as it's seen.
    const explored = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) explored.push(!inside(x, y) || isWallSq(x, y) ? '1' : '0');
    place.state.explored.F0 = explored.join('');
    place.camp = { walls: spec.walls, size: spec.size, cannibal: spec.cannibal, horror: spec.horror, tunnels: Boolean(place.buildings.TUN), buildings: Object.keys(place.buildings), gate: `D1`, inner: innerGate?.id ?? null };
    return place;
}

// ---------- what's inside the camp's buildings ----------

const TUNNEL_NAMES = ['The Tunnels', 'The Warren', 'The Holes Below', 'The Under-camp'];

/**
 * A hidden trapdoor in a room of a built place, under a rug, into the tunnels (building "TUN").
 * The square keeps its floor: the hatch is a prop that shows once the door is found.
 */
function addHatch(inside, roomId, name, tunnelsName) {
    const rm = inside.rooms[roomId] ?? Object.values(inside.rooms)[0];
    if (!rm) return null;
    const map = inside.floors.find(f => f.id === rm.floor).map;
    const blocked = (x, y) => map.props.some(p => PROPS[p.type]?.blocks && !p.hidden && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    const nearDoor = (x, y) => Object.values(inside.doors).some(d => d.floor === rm.floor && Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1);
    const spots = [];
    for (let x = rm.rect.x; x < rm.rect.x + rm.rect.w; x++) for (let y = rm.rect.y; y < rm.rect.y + rm.rect.h; y++) if ('._=:'.includes(terrainAt(map, x, y)) && !blocked(x, y) && !nearDoor(x, y)) spots.push([x, y, map.props.some(p => p.type === 'rug' && p.x === x && p.y === y) ? 1 : 0]);
    if (!spots.length) return null;
    const [x, y, rug] = spots.sort((p, q) => q[2] - p[2])[0];
    inside.doors.DH = { id: 'DH', floor: rm.floor, x, y, kind: 'trapdoor', state: 'hidden', dc: 12, rooms: [rm.id, null], enter: 'TUN', name, under: terrainAt(map, x, y) };
    if (!rug) map.props.push({ x, y, type: 'rug' });
    map.props.push({ x, y, type: 'trapdoor', hidden: true, door: 'DH' });
    inside.buildings.TUN = { id: 'TUN', name: tunnelsName, kind: 'tunnels', sign: '', keeper: '', description: 'The tunnels under the camp, through the trapdoor.', size: 'small', enterable: true, door: 'DH', rect: { x, y, w: 1, h: 1 }, interior: null };
    ensureIds(inside);
    return inside.doors.DH;
}

/** The inside of one of the camp's houses, planned by its kind and built like any building's inside. */
function houseInterior(place, b, seed) {
    const r = rng(seed);
    const s = b.inside;
    const horror = Boolean(s.horror), cannibal = Boolean(s.cannibal), big = s.size === 'big' || s.size === 'massive';
    const gore = n => (horror ? Array(n).fill('blood') : []);
    const room = (id, name, type, size, props, marks, extra = {}) => ({ id, name, type, size, lit: true, description: '', props: props.map(([type, count, label]) => ({ type, count, label: label || '' })), marks, traps: [], items: [], exit: false, windows: 'none', ...extra });
    let rooms = [], links = [], guards = [], start;
    const captiveName = () => pick(r, ['the Hanging Man', 'the Quiet Girl', 'Poor Wat', 'the One They Keep']);
    if (s.kind === 'lodge') {
        rooms = [
            room('HALL', pick(r, ['The Chief\'s Hall', 'The War Hall', 'The Long Table']), 'room', 'medium', [['table', 1], ['chair', 2], ['weaponrack', 2], ['brazier', 1], ['banner', 1], ['rug', 1], ...(cannibal ? [['skull', 2], ['skullpole', 1]] : [])], [...gore(3), cannibal ? 'bones' : 'stain'], { exit: true, description: 'Where the chief holds court: a long table, the band\'s best weapons on the wall, his trophies.' }),
            room('CHAMBER', pick(r, ['The Chief\'s Chamber', 'The Back Room', 'The Chief\'s Bed']), 'room', 'small', [['bed', 1], ['chest', 1, 'the chief\'s strongbox'], ['candles', 1], ['weaponrack', 1], ['rug', 1], ...(cannibal ? [['skull', 1], ['bones', 1]] : [])], gore(1), { description: 'The chief sleeps here, his strongbox by the bed.' }),
        ];
        links = [{ a: 'HALL', b: 'CHAMBER', via: 'door' }];
        if (cannibal && big) { rooms.push(room('TROPHY', pick(r, ['The Trophy Room', 'The Hall of Faces', 'The Skin Room']), 'room', 'small', [['skull', 3], ['bones', 2], ['hooks', 1], ['carcass', 1], ['chains', 2]], [...gore(3), 'bones'], { description: 'What the chief keeps of the people he has eaten.' })); links.push({ a: 'HALL', b: 'TROPHY', via: 'door' }); }
        for (const it of s.items) rooms[1].items.push(it);
        guards = s.guards.map(g => ({ name: g.name, description: g.description, sprite: g.sprite || '', room: 'CHAMBER', patrol: ['HALL', 'CHAMBER'], hostile: true, role: 'hostile' }));
        start = 'HALL';
    } else if (s.kind === 'butchery') {
        rooms = [
            room('BUTCHERY', pick(r, ['The Cutting Room', 'The Block', 'The Butchery']), 'room', 'medium', [['slab', 2], ['hooks', 2], ['carcass', 2], ['cauldron', 1], ['barrel', 2], ['weaponrack', 1, 'cleavers and saws'], ['brazier', 1], ['cage', 1]], [...gore(6), 'bones', 'bones'], { exit: true, description: 'Blocks and slabs, cleavers on the wall, meat on hooks. The floor is never dry.' }),
            room('LARDER', pick(r, ['The Larder', 'The Hanging Room', 'The Salt Room']), 'pantry', 'small', [['carcass', 2], ['hooks', 1], ['barrel', 1], ['sack', 1], ['crate', 1]], [...gore(3), 'bones'], { description: 'Salted, smoked and hung. Some of it still has hands.' }),
        ];
        links = [{ a: 'BUTCHERY', b: 'LARDER', via: 'door' }];
        if (s.size !== 'small') { rooms.push(room('QUESTION', pick(r, ['The Question Room', 'The Screaming Room', 'The Back Room']), 'torture_chamber', 'small', [], gore(3), { description: 'A rack, hooks, a brazier of irons, and someone on the rack.' })); links.push({ a: 'BUTCHERY', b: 'QUESTION', via: 'door' }); guards.push({ name: captiveName(), description: 'strapped to the rack, alive, barely', room: 'QUESTION', patrol: ['QUESTION'], hostile: false, role: 'prisoner' }); }
        if (b.keeper) guards.push({ name: b.keeper, description: `the camp's butcher, ${pick(r, ['in a leather apron stiff with blood', 'humming, with a cleaver in each hand', 'enormous, gentle-voiced, hands like hams', 'thin and precise, with a boning knife'])}`, room: 'BUTCHERY', patrol: ['BUTCHERY', 'LARDER'], hostile: true, role: 'hostile', sprite: 'human_cannibal' });
        start = 'BUTCHERY';
    } else if (s.kind === 'shrine') {
        rooms = [room('SHRINE', pick(r, ['The Skull Shrine', 'The Altar of Teeth', 'The Hungry God\'s House']), 'room', 'medium', [['altar', 1], ['candles', 3], ['skull', 4], ['bones', 2], ['brazier', 2], ['skullpole', 1], ['banner', 1]], [...gore(4), 'bones'], { exit: true, description: 'An altar of stacked skulls, candles of tallow, offerings of flesh.' })];
        if (big) { rooms.push(room('OSSUARY', pick(r, ['The Ossuary', 'The Bone Room']), 'crypt', 'small', [['skull', 3], ['bones', 3]], gore(2), { description: 'The bones of every meal, sorted and stacked.' })); links.push({ a: 'SHRINE', b: 'OSSUARY', via: 'door' }); }
        if (b.keeper) guards.push({ name: b.keeper, description: `the band's priest, ${pick(r, ['painted with ash, a necklace of teeth', 'blind, chanting, a bone knife at the belt', 'fat and smiling, the first to eat'])}`, room: 'SHRINE', patrol: ['SHRINE'], hostile: true, role: 'hostile', sprite: 'human_cannibal' });
        start = 'SHRINE';
    } else if (s.kind === 'longhouse') {
        rooms = [
            room('BUNKS', pick(r, ['The Bunks', 'The Long Room', 'The Snoring Hall']), 'room', 'medium', [['bed', big ? 5 : 4], ['chest', 2], ['table', 1], ['chair', 2], ['weaponrack', 1], ['candles', 1], ['barrel', 1]], ['stain', 'debris', ...gore(1)], { exit: true, description: 'Bunks, chests, a table with dice on it. The band sleeps here in shifts.' }),
            room('STORE', pick(r, ['The Back Store', 'The Drink Store']), 'storage', 'small', [['barrel', 2], ['sack', 1]], ['debris'], { description: 'Casks and sacks, the band\'s drink and bread.' }),
        ];
        links = [{ a: 'BUNKS', b: 'STORE', via: 'door' }];
        if (b.keeper) guards.push({ name: b.keeper, description: `a ${(s.band || 'raider').toLowerCase()} off watch, asleep in a bunk, boots on`, room: 'BUNKS', patrol: ['BUNKS'], hostile: true, role: 'hostile' });
        start = 'BUNKS';
    } else if (s.kind === 'storehouse') {
        rooms = [room('STORE', pick(r, ['The Plunder', 'The Store Room', 'The Loot']), 'storage', 'medium', [['chest', 3, 'a locked chest'], ['crate', 3], ['barrel', 2], ['sack', 2]], ['papers', 'debris'], { exit: true, description: 'The band\'s plunder: crates of goods, casks, locked chests of coin.', items: [{ name: 'the band\'s plunder', hidden: false, note: 'in the chests' }] })];
        start = 'STORE';
    } else return null;
    const plan = normalizePlan({ name: b.name, kind: 'interior', theme: 'cabin', condition: 'worn', fog: false, floors: [{ id: 'F0', name: b.name, level: 0 }], rooms, links, guards, start, summary: b.description });
    const inside = generatePlace(plan, seed);
    if (!inside) return null;
    inside.kind = 'interior';
    inside.fog = false;
    for (const f of inside.floors) inside.state.explored[f.id] = '1'.repeat(f.map.w * f.map.h);
    for (const g of Object.values(inside.guards)) if (g.role === 'prisoner') g.held = true;
    if (s.tunnels) addHatch(inside, 'CHAMBER', 'a trapdoor under the chief\'s rug', place.buildings.TUN?.name ?? TUNNEL_NAMES[0]);
    return inside;
}

/**
 * The insides of a camp's buildings, built with the camp (same seed, same insides): the chief's
 * lodge (the chief in it, the story's things in his strongbox), a cannibal camp's flesh house and
 * bone shrine, a band's long house and store house, and the tunnels under it all. Returns
 * [{ building, place }]; the caller links them (each inside's parent is the camp, through the
 * building's door; the tunnels' exits each name the host their trapdoor is in).
 */
export function campInteriors(place, seed = 1) {
    const out = [];
    let n = 0;
    for (const b of Object.values(place.buildings || {})) {
        if (!b.inside) continue;
        const s = (Number(seed) || 1) * 31 + (++n) * 7919;
        const inside = b.inside.kind === 'tunnels' ? generateTunnels(b, s) : houseInterior(place, b, s);
        if (!inside) continue;
        inside.hostKind = b.kind;
        out.push({ building: b.id, place: inside });
    }
    return out;
}
