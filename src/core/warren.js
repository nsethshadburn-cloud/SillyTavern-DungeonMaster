// The tunnels under a camp: a maze of dirt passages shored with timber, with chambers off it (a
// larder, a torture room, cages, the keeper's den, the band's hoard, a bone pit), reached by
// hidden trapdoors: one out in the woods beyond the wall, one under the straw of the prisoner pen,
// one under the rug in the chief's lodge. A way in for an attack, a way out for an escape, and a
// horror of its own either way when the camp is that kind of place. Built like a building's
// inside (its own place; the trapdoors are its ways out), from a seed. Pure module.

import { ensureIds, clearDoorways } from './layout.js';
import { PROPS } from './grid.js';

function rng(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const K = (x, y) => `${x},${y}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [...DIRS, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Map sizes (odd, so the passages fall on a lattice), chambers and traps by the camp's size. */
const SIZES = { small: { W: 31, H: 23, rooms: 3, traps: 3 }, medium: { W: 39, H: 29, rooms: 4, traps: 4 }, big: { W: 47, H: 35, rooms: 5, traps: 5 }, massive: { W: 55, H: 41, rooms: 6, traps: 6 } };

/**
 * The chambers, in the order they're dug (the first ones always). fill: [type, where, count];
 * where = wall (against a wall), corner, center, any, onwall (hung on the wall). marks: floor marks.
 * keeper: whoever lives below sleeps here; captives: the cages; loot: the band's valuables.
 */
const CHAMBERS = {
    horror: [
        { id: 'LARDER', names: ['The Larder', 'The Meat Room', 'The Cold Store'], type: 'pantry', w: 5, h: 5, lit: true, fill: [['hooks', 'any', 2], ['carcass', 'wall', 2], ['slab', 'wall', 1], ['barrel', 'wall', 2], ['sack', 'corner', 1], ['brazier', 'any', 1], ['cauldron', 'any', 1]], marks: [['blood', 6], ['bones', 2]], description: 'Where the meat is kept. It hangs from hooks, and not all of it was animal.' },
        { id: 'QUESTION', names: ['The Question Room', 'The Screaming Room', 'The Rack Room'], type: 'torture_chamber', w: 5, h: 5, lit: true, fill: [['rack', 'wall', 1], ['chains', 'onwall', 3], ['brazier', 'any', 1], ['slab', 'center', 1], ['cage', 'corner', 1], ['hooks', 'any', 1], ['stocks', 'wall', 1]], marks: [['blood', 5], ['scratches', 2], ['bones', 1]], onRack: true, description: 'A rack, hooks, a brazier of irons. The walls are scratched to the height of a hand.' },
        { id: 'CAGES', names: ['The Cages', 'The Holding Pit', 'The Meat Pens'], type: 'cell', w: 5, h: 3, lit: false, door: 'cell', floor: 'mud', fill: [['cage', 'wall', 3], ['chains', 'onwall', 2], ['bowl', 'any', 1], ['hay', 'corner', 1]], marks: [['blood', 2], ['scratches', 2], ['bones', 1]], captives: true, description: 'Cages in the dark, a barred door. Those kept here are kept for later.' },
        { id: 'DEN', names: ['The Gnawer\'s Den', 'The Den Below', 'Old Teeth\'s Hole'], type: 'room', w: 5, h: 5, lit: true, fill: [['bed', 'wall', 1], ['skull', 'any', 3], ['bones', 'any', 2], ['candles', 'any', 1], ['chest', 'corner', 1], ['skullpole', 'any', 1], ['brazier', 'any', 1]], marks: [['blood', 3], ['bones', 2]], keeper: true, description: 'A bed of rags and furs, skulls set round it like company. Something lives down here.' },
        { id: 'BONEPIT', names: ['The Bone Pit', 'The Charnel Hole', 'The Boneyard Below'], type: 'crypt', w: 5, h: 5, lit: false, pit: true, fill: [['skull', 'any', 3], ['bones', 'any', 3], ['candles', 'any', 1]], marks: [['blood', 3], ['bones', 3]], description: 'A hole in the middle of the floor, and what the camp throws into it.' },
        { id: 'HOARD', names: ['The Hoard', 'The Chief\'s Hole', 'The Loot Hole'], type: 'vault', w: 3, h: 3, lit: false, door: 'locked', floor: 'planks', fill: [['chest', 'wall', 2], ['crate', 'wall', 1], ['sack', 'corner', 1]], marks: [['papers', 1]], loot: true, description: 'Boarded over and locked: the band\'s takings.' },
        { id: 'ALTAR', names: ['The Hungry Altar', 'The Skull Niche', 'The Low Shrine'], type: 'chapel', w: 3, h: 5, lit: true, fill: [['altar', 'wall', 1], ['candles', 'any', 2], ['skull', 'any', 3], ['skullpole', 'any', 1]], marks: [['blood', 4]], description: 'An altar of stacked skulls, lit by tallow candles that smell of fat.' },
    ],
    plain: [
        { id: 'HOARD', names: ['The Hoard', 'The Chief\'s Hole', 'The Loot Hole'], type: 'vault', w: 3, h: 3, lit: false, door: 'locked', floor: 'planks', fill: [['chest', 'wall', 2], ['crate', 'wall', 1], ['sack', 'corner', 1]], marks: [['papers', 1]], loot: true, description: 'Boarded over and locked: the band\'s takings.' },
        { id: 'BOLTHOLE', names: ['The Bolt-hole', 'The Hide', 'The Long Sleep'], type: 'room', w: 5, h: 5, lit: true, fill: [['bed', 'wall', 2], ['crate', 'wall', 2], ['barrel', 'corner', 1], ['table', 'any', 1], ['candles', 'any', 1], ['weaponrack', 'wall', 1]], marks: [['debris', 1], ['stain', 1]], keeper: true, description: 'Bunks, water, a week of food: where the band would wait out a siege.' },
        { id: 'CAGES', names: ['The Cells', 'The Dark Cages', 'The Holding Hole'], type: 'cell', w: 5, h: 3, lit: false, door: 'cell', floor: 'mud', fill: [['cage', 'wall', 2], ['chains', 'onwall', 2], ['bowl', 'any', 1], ['hay', 'corner', 1]], marks: [['scratches', 2], ['stain', 1]], captives: true, description: 'Cages for the ones worth a ransom, out of sight and sound.' },
        { id: 'SUMP', names: ['The Sump', 'The Wet Turn', 'The Drowned Room'], type: 'cave', w: 5, h: 5, lit: false, water: true, fill: [['barrel', 'wall', 1], ['mushroom', 'any', 2], ['bones', 'any', 1]], marks: [['stain', 2]], description: 'The tunnel dips and the water stands. Something drips.' },
        { id: 'DEADTURN', names: ['Dead Man\'s Turn', 'The Collapsed Room', 'The Old Dig'], type: 'cave', w: 5, h: 3, lit: false, fill: [['boulder', 'any', 2], ['bones', 'any', 2], ['skull', 'any', 1], ['crate', 'corner', 1]], marks: [['debris', 3]], description: 'Half the roof came down once. Nobody dug out whoever was under it.' },
        { id: 'ARMS', names: ['The Arms Cache', 'The Spear Hole'], type: 'armory', w: 3, h: 5, lit: false, fill: [['weaponrack', 'wall', 2], ['crate', 'wall', 1], ['chest', 'corner', 1]], marks: [['debris', 1]], description: 'Spears, bows and stolen blades, greased against the damp.' },
    ],
};
const KEEPERS = {
    horror: [['the Gnawer', 'who lives below the camp, pale as a grub, teeth filed to points, and eats what the others leave'], ['Old Teeth', 'the camp\'s butcher\'s butcher: blind in one eye, never seen above ground, humming'], ['Mother Gristle', 'who keeps the larder and the cages, kindly as a nurse and worse than any of them'], ['the Thing Below', 'the one even the band fears: huge, silent, kept fed'], ['Hollow Jan', 'thin as a rake, who guides the band through the maze and would not find his way out of it himself']],
    plain: [['Mole', 'the band\'s digger, half-blind from the dark, who knows every turn below'], ['Wick', 'who keeps the lamps and the bolt-hole, and sleeps with a knife'], ['Scab', 'left to mind the tunnels, bored and dangerous'], ['Lanky Dom', 'the one who knows the way: without him the maze is just a maze']],
};
const TRAP_KINDS = [['covered pit', 'DEX', '2d6 bludgeoning, down the hole'], ['tripwire (cave-in)', 'DEX', '2d8 bludgeoning, and the way back buried in earth'], ['hanging blades', 'DEX', '2d6 slashing'], ['spike pit', 'DEX', '2d6 piercing, in the pit'], ['bone-rattle alarm', 'DEX', 'a clatter of bones: the tunnels wake'], ['hunter\'s snare', 'DEX', 'hoisted by one ankle, restrained']];

/**
 * Build the tunnels for a camp's "tunnels" building. building.inside: { size, horror, cannibal,
 * entrances: [{ door, host, label }] (host: the building the trapdoor is in, null for the camp
 * itself), captives: [{ name, description }], items: [{ name, hidden, note }], band }.
 * Returns a place: one floor, theme "warren", fog on, its exits the trapdoors (each with the door
 * it comes up through and the host it belongs to).
 */
export function generateTunnels(building, seed = 1) {
    const r = rng(seed);
    const spec = { size: 'medium', horror: false, cannibal: false, entrances: [], captives: [], items: [], band: 'Bandit', ...(building.inside || {}) };
    const { W, H, rooms: nRooms, traps: nTraps } = SIZES[spec.size] ?? SIZES.medium;
    const c = [...Array(H)].map(() => Array(W).fill('#'));
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = ch; };
    const map = { w: W, h: H, rows: [], theme: 'warren', props: [], areas: [], roofs: [], seed, ambience: 'dust' };
    const place = {
        version: 1, kind: 'interior', name: building.name, theme: 'warren', fog: true, seed, summary: building.description || '',
        floors: [{ id: 'F0', name: building.name, level: -1, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    // ---- the chambers: dug first, on the lattice (odd squares), well apart ----
    const list = (spec.horror ? CHAMBERS.horror : CHAMBERS.plain).slice(0, nRooms);
    const chambers = [];
    const overlaps = (a, b, pad) => a.x - pad < b.x + b.w + pad && a.x + a.w + pad > b.x - pad && a.y - pad < b.y + b.h + pad && a.y + a.h + pad > b.y - pad;
    for (const ch of list) {
        let placed = null;
        for (let t = 0; t < 80 && !placed; t++) {
            const x0 = 3 + 2 * int(r, 0, Math.floor((W - 4 - ch.w - 3) / 2)), y0 = 3 + 2 * int(r, 0, Math.floor((H - 4 - ch.h - 3) / 2));
            if (x0 + ch.w > W - 3 || y0 + ch.h > H - 3) continue;
            const rect = { x: x0, y: y0, w: ch.w, h: ch.h };
            if (chambers.some(o => overlaps(rect, o.rect, 2))) continue;
            placed = { ...ch, rect, name: pick(r, ch.names) };
        }
        if (placed) chambers.push(placed);
    }
    const inRoom = (x, y) => chambers.find(ch => x >= ch.rect.x && x < ch.rect.x + ch.rect.w && y >= ch.rect.y && y < ch.rect.y + ch.rect.h) ?? null;
    for (const ch of chambers) for (let x = ch.rect.x; x < ch.rect.x + ch.rect.w; x++) for (let y = ch.rect.y; y < ch.rect.y + ch.rect.h; y++) set(x, y, '.');
    // ---- the maze: passages between the lattice's cells, a depth-first dig with a few loops ----
    const isCell = (x, y) => x % 2 === 1 && y % 2 === 1 && x > 0 && y > 0 && x < W - 1 && y < H - 1 && !inRoom(x, y);
    const cells = [];
    for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) if (isCell(x, y)) cells.push([x, y]);
    const carved = new Set();
    const dig = (sx, sy) => {
        const stack = [[sx, sy]];
        carved.add(K(sx, sy)); set(sx, sy, '.');
        while (stack.length) {
            const [x, y] = stack[stack.length - 1];
            const next = shuffle(r, DIRS.map(([dx, dy]) => [x + dx * 2, y + dy * 2, x + dx, y + dy])).find(([nx, ny]) => isCell(nx, ny) && !carved.has(K(nx, ny)));
            if (!next) { stack.pop(); continue; }
            const [nx, ny, wx, wy] = next;
            carved.add(K(nx, ny)); set(nx, ny, '.'); set(wx, wy, '.');
            stack.push([nx, ny]);
        }
    };
    for (const [x, y] of shuffle(r, cells)) if (!carved.has(K(x, y))) dig(x, y);
    // Loops: now and then a wall between two passages comes down, so there's more than one way round.
    for (const [x, y] of cells) for (const [dx, dy] of [[2, 0], [0, 2]]) {
        const nx = x + dx, ny = y + dy;
        if (!isCell(nx, ny) || get(x + dx / 2, y + dy / 2) !== '#') continue;
        if (r() < 0.07) set(x + dx / 2, y + dy / 2, '.');
    }
    // Dead ends: some are filled back in, so the maze winds without endless stubs.
    const openN = (x, y) => DIRS.filter(([dx, dy]) => get(x + dx, y + dy) !== '#').length;
    for (let pass = 0; pass < 2; pass++) for (const [x, y] of shuffle(r, cells)) {
        if (get(x, y) !== '.' || openN(x, y) !== 1 || r() > 0.3) continue;
        const [dx, dy] = DIRS.find(([ddx, ddy]) => get(x + ddx, y + ddy) !== '#');
        set(x, y, '#'); set(x + dx, y + dy, '#');
    }
    // ---- doors into the chambers: on a side facing a passage; the cages barred, the hoard locked ----
    let doorN = 0;
    const addDoor = (x, y, kind, state, rooms, extra = {}) => {
        const id = `D${++doorN}`;
        place.doors[id] = { id, floor: 'F0', x, y, kind, state, rooms, ...extra };
        set(x, y, kind === 'cell' ? 'J' : kind === 'arch' ? '.' : state === 'locked' ? 'D' : '+');
        return place.doors[id];
    };
    for (const ch of chambers) {
        const rc = ch.rect, cands = [];
        for (let x = rc.x; x < rc.x + rc.w; x++) { cands.push([x, rc.y - 1, 0, -1], [x, rc.y + rc.h, 0, 1]); }
        for (let y = rc.y; y < rc.y + rc.h; y++) { cands.push([rc.x - 1, y, -1, 0], [rc.x + rc.w, y, 1, 0]); }
        const good = shuffle(r, cands.filter(([x, y, dx, dy]) => get(x, y) === '#' && get(x + dx, y + dy) === '.' && !inRoom(x + dx, y + dy) && x % 2 !== y % 2));
        const want = rc.w >= 5 && rc.h >= 5 && !ch.door && r() < 0.5 ? 2 : 1;
        const chosen = [];
        for (const cnd of good) { if (chosen.length >= want) break; if (chosen.some(o => o[2] === cnd[2] && o[3] === cnd[3])) continue; chosen.push(cnd); }
        for (const [x, y] of chosen) addDoor(x, y, ch.door === 'cell' ? 'cell' : ch.door === 'locked' ? 'locked' : r() < 0.35 ? 'arch' : 'door', ch.door === 'cell' || ch.door === 'locked' ? 'locked' : 'closed', [ch.id, null], ch.door ? { dc: ch.door === 'cell' ? 13 : 14 } : {});
        ch.doors = chosen.map(([x, y]) => [x, y]);
    }
    // ---- everything joined up: whatever a flood from the first passage can't reach gets dug to ----
    // (A shaft already dug counts as a wall here: nobody walks across a ladder hole.)
    const passable = (x, y) => '.+/DJj~'.includes(get(x, y));
    const flood = from => {
        const seen = new Set([K(...from)]), q = [from];
        for (let i = 0; i < q.length; i++) { const [x, y] = q[i]; for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy; if (!seen.has(K(nx, ny)) && passable(nx, ny)) { seen.add(K(nx, ny)); q.push([nx, ny]); } } }
        return seen;
    };
    const anyCell = cells.find(([x, y]) => get(x, y) === '.');
    for (let pass = 0; pass < 40; pass++) {
        const seen = flood(anyCell);
        const unreached = [...cells.filter(([x, y]) => get(x, y) === '.' && !seen.has(K(x, y))), ...chambers.map(ch => [ch.rect.x, ch.rect.y]).filter(([x, y]) => !seen.has(K(x, y)))];
        if (!unreached.length) break;
        // The nearest pair of a reached square and an unreached one two apart, the wall between them dug out.
        let best = null;
        for (const k of seen) {
            const [x, y] = k.split(',').map(Number);
            for (const [dx, dy] of DIRS) { const nx = x + dx * 2, ny = y + dy * 2; if (get(nx, ny) === '.' && !seen.has(K(nx, ny)) && get(x + dx, y + dy) === '#') { const d = Math.min(...unreached.map(([ux, uy]) => Math.abs(ux - nx) + Math.abs(uy - ny))); if (!best || d < best.d) best = { x: x + dx, y: y + dy, d, room: inRoom(nx, ny) }; } }
        }
        if (!best) break;
        if (best.room) { addDoor(best.x, best.y, 'door', 'closed', [best.room.id, null]); best.room.doors.push([best.x, best.y]); }
        else set(best.x, best.y, '.');
    }
    // ---- the ways up: ladder shafts in the passages, as far apart as the maze allows ----
    // A shaft is a dead end of the maze (nobody walks across a ladder hole): a cell with one way
    // out, or one the maze doesn't need to stay in one piece, away from the chambers.
    const farFromRooms = (x, y) => !chambers.some(ch => x >= ch.rect.x - 2 && x < ch.rect.x + ch.rect.w + 2 && y >= ch.rect.y - 2 && y < ch.rect.y + ch.rect.h + 2);
    const sparable = ([x, y]) => {
        if (get(x, y) !== '.' || !farFromRooms(x, y)) return false;
        if (openN(x, y) === 1) return true;
        if (openN(x, y) === 0) return false;
        const other = cells.find(([cx, cy]) => get(cx, cy) === '.' && (cx !== x || cy !== y));
        if (!other) return false;
        const all = flood(other).size;
        set(x, y, '#');
        const without = flood(other).size;
        set(x, y, '.');
        return without === all - 1;
    };
    const shaftCands = cells.filter(([x, y]) => get(x, y) === '.' && farFromRooms(x, y)).sort((a, b) => (openN(a[0], a[1]) === 1 ? 0 : 1) - (openN(b[0], b[1]) === 1 ? 0 : 1)).filter(sparable);
    const shafts = [];
    const corner = pick(r, [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]]);
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    const entrances = spec.entrances.length ? spec.entrances : [{ door: null, host: null, label: 'the woods' }];
    for (const ent of entrances) {
        const left = shaftCands.filter(p => !shafts.some(s => s.x === p[0] && s.y === p[1]) && sparable(p));
        if (!left.length) break;
        const best = shafts.length ? left.sort((p, q) => Math.min(...shafts.map(s => dist(p, [s.x, s.y]))) - Math.min(...shafts.map(s => dist(q, [s.x, s.y])))).at(-1) : left.sort((p, q) => dist(p, corner) - dist(q, corner))[0];
        const [x, y] = best;
        set(x, y, '<');
        const id = `UP${shafts.length + 1}`;
        place.rooms[id] = { id, name: `Shaft to ${ent.label}`, type: 'cave', floor: 'F0', rect: { x: x - 1, y: y - 1, w: 3, h: 3 }, lit: false, description: `A ladder up a dirt shaft to a trapdoor: ${ent.label}.`, exit: true };
        place.exits.push({ floor: 'F0', x, y, door: null, up: { host: ent.host ?? null, door: ent.door }, label: ent.label });
        shafts.push({ x, y, id });
    }
    // ---- rooms and their dressing ----
    const taken = new Set();
    const isTaken = (x, y) => taken.has(K(x, y));
    const doorNear = (x, y) => Object.values(place.doors).some(d => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1);
    const put = (x, y, type, extra = {}) => {
        const w = extra.w || 1, h = extra.h || 1;
        for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (isTaken(x + i, y + j) || get(x + i, y + j) !== '.') return null;
        const p = { x, y, type, ...extra };
        map.props.push(p);
        for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) taken.add(K(x + i, y + j));
        return p;
    };
    for (const ch of chambers) {
        const rc = ch.rect;
        place.rooms[ch.id] = { id: ch.id, name: ch.name, type: ch.type, floor: 'F0', rect: { ...rc }, lit: ch.lit, description: ch.description, exit: false };
        if (ch.floor) map.areas.push({ ...rc, floor: ch.floor });
        if (ch.pit) { set(rc.x + 2, rc.y + 2, 'o'); if (rc.w >= 5 && rc.h >= 5 && r() < 0.6) set(rc.x + 2, rc.y + 1, 'o'); }
        if (ch.water) for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) if (r() < 0.45 && !doorNear(x, y)) set(x, y, '~');
        const inR = (x, y) => x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h;
        const free = () => { const out = []; for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) if (get(x, y) === '.' && !isTaken(x, y) && !doorNear(x, y)) out.push([x, y]); return shuffle(r, out); };
        const wallN = (x, y) => DIRS.filter(([dx, dy]) => get(x + dx, y + dy) === '#').length;
        // Blocking things never cut the room in two: every free square must still reach the doors.
        const stillWhole = (x, y, w, h) => {
            const block = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
            const open = (px, py) => inR(px, py) && '.~'.includes(get(px, py)) && !isTaken(px, py) && !block(px, py);
            const start = []; for (let px = rc.x; px < rc.x + rc.w; px++) for (let py = rc.y; py < rc.y + rc.h; py++) if (open(px, py)) start.push([px, py]);
            if (!start.length) return false;
            const seen = new Set([K(...start[0])]), q = [start[0]];
            for (let i = 0; i < q.length; i++) { const [px, py] = q[i]; for (const [dx, dy] of DIRS) { const nx = px + dx, ny = py + dy; if (!seen.has(K(nx, ny)) && open(nx, ny)) { seen.add(K(nx, ny)); q.push([nx, ny]); } } }
            return seen.size === start.length && ch.doors.every(([dx, dy]) => DIRS.some(([ex, ey]) => seen.has(K(dx + ex, dy + ey))));
        };
        const placeOne = (type, where, extra = {}) => {
            const d = PROPS[type];
            if (!d) return null;
            if (where === 'onwall' || d.wall) {
                // On the wall round the room, facing in.
                const ring = [];
                for (let x = rc.x; x < rc.x + rc.w; x++) { ring.push([x, rc.y - 1, 'n'], [x, rc.y + rc.h, 's']); }
                for (let y = rc.y; y < rc.y + rc.h; y++) { ring.push([rc.x - 1, y, 'e'], [rc.x + rc.w, y, 'w']); }
                const spot = shuffle(r, ring).find(([x, y]) => get(x, y) === '#' && !isTaken(x, y));
                if (!spot) return null;
                const [x, y, facing] = spot;
                taken.add(K(x, y));
                const p = { x, y, type, facing, ...extra };
                map.props.push(p);
                return p;
            }
            const [w, h] = d.size ?? [1, 1];
            const cands = free().filter(([x, y]) => (where === 'wall' ? wallN(x, y) >= 1 : where === 'corner' ? wallN(x, y) >= 2 : where === 'center' ? Math.abs(x - (rc.x + Math.floor(rc.w / 2))) <= 1 && Math.abs(y - (rc.y + Math.floor(rc.h / 2))) <= 1 : true));
            for (const [x, y] of cands) {
                let ok = true;
                for (let i = 0; i < w && ok; i++) for (let j = 0; j < h; j++) if (!inR(x + i, y + j) || get(x + i, y + j) !== '.' || isTaken(x + i, y + j) || doorNear(x + i, y + j)) { ok = false; break; }
                if (!ok || (d.blocks && !stillWhole(x, y, w, h))) continue;
                return put(x, y, type, { ...(w > 1 || h > 1 ? { w, h } : {}), ...extra });
            }
            return null;
        };
        for (const [type, where, n] of ch.fill) for (let i = 0; i < n; i++) placeOne(type, where);
        for (const [type, n] of ch.marks) { const f = free(); for (let i = 0; i < Math.min(n, f.length); i++) map.props.push({ x: f[i][0], y: f[i][1], type }); }
    }
    // ---- the passages: shored with timber (the wall paints its own beams), lit here and there, and what the band leaves in them ----
    const corridorSq = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (get(x, y) === '.' && !inRoom(x, y)) corridorSq.push([x, y]);
    const nearRoom = (x, y, d) => chambers.some(ch => x >= ch.rect.x - d && x < ch.rect.x + ch.rect.w + d && y >= ch.rect.y - d && y < ch.rect.y + ch.rect.h + d);
    for (const [x, y] of corridorSq) {
        // A torch on the wall at every sixth cell or so, so the way is lit in patches.
        if (x % 2 === 1 && y % 2 === 1 && r() < 0.18) {
            const side = DIRS.map(([dx, dy]) => [x + dx, y + dy, dx === 0 ? (dy > 0 ? 's' : 'n') : (dx > 0 ? 'w' : 'e')]).find(([wx, wy]) => get(wx, wy) === '#' && !isTaken(wx, wy));
            if (side) { taken.add(K(side[0], side[1])); map.props.push({ x: side[0], y: side[1], type: 'torch', facing: side[2] }); }
        }
        const dead = openN(x, y) === 1;
        const u = r();
        if (spec.horror) {
            if (u < (nearRoom(x, y, 4) ? 0.12 : 0.04)) map.props.push({ x, y, type: 'blood' });
            else if (u < 0.16) map.props.push({ x, y, type: pick(r, ['bones', 'bones', 'skull', 'scratches']) });
            else if (dead && u < 0.5) put(x, y, pick(r, ['bones', 'skull', 'web']));
        } else {
            if (u < 0.04) map.props.push({ x, y, type: pick(r, ['debris', 'stain', 'bones']) });
            else if (dead && u < 0.4) put(x, y, pick(r, ['web', 'mushroom', 'crate', 'barrel']));
        }
        if (dead && r() < 0.25 && !spec.horror) set(x, y, '~');
    }
    // ---- traps in the passages, never by a door or a shaft ----
    const trapFree = ([x, y]) => get(x, y) === '.' && !isTaken(x, y) && !doorNear(x, y) && !shafts.some(s => Math.abs(s.x - x) <= 2 && Math.abs(s.y - y) <= 2);
    const trapSpots = shuffle(r, corridorSq.filter(trapFree));
    for (let i = 0; i < nTraps && trapSpots.length; i++) {
        const [x, y] = trapSpots.shift();
        const [kind, save, effect] = pick(r, TRAP_KINDS);
        const id = `T${i + 1}`;
        place.traps[id] = { id, room: null, floor: 'F0', x, y, kind, dc: int(r, 11, 14), save, effect, state: 'hidden' };
        map.props.push({ x, y, type: 'trap', hidden: true, trap: id, label: kind });
        taken.add(K(x, y));
    }
    // ---- who's down here: the keeper in the den, captives in the cages, one on the rack ----
    const freeIn = ch => { const out = []; for (let x = ch.rect.x; x < ch.rect.x + ch.rect.w; x++) for (let y = ch.rect.y; y < ch.rect.y + ch.rect.h; y++) if (get(x, y) === '.' && !isTaken(x, y) && !Object.values(place.guards).some(g => g.x === x && g.y === y)) out.push([x, y]); return shuffle(r, out); };
    const den = chambers.find(ch => ch.keeper);
    if (den) {
        const [name, what] = pick(r, spec.horror ? KEEPERS.horror : KEEPERS.plain);
        const p = freeIn(den)[0];
        if (p) place.guards[name] = { name, description: what, hostile: true, role: 'hostile', sprite: spec.horror ? 'human_cannibal' : 'human_bandit', room: den.id, patrol: [den.id, ...chambers.filter(ch => ch !== den && !ch.door).slice(0, 2).map(ch => ch.id)], step: 0, floor: 'F0', x: p[0], y: p[1], state: 'patrol' };
    }
    const cages = chambers.find(ch => ch.captives);
    const captives = spec.captives.slice();
    if (cages) for (const cp of captives.splice(0, 2)) { const p = freeIn(cages)[0]; if (!p) break; place.guards[cp.name] = { name: cp.name, description: cp.description, hostile: false, role: 'prisoner', room: cages.id, patrol: [cages.id], step: 0, floor: 'F0', x: p[0], y: p[1], state: 'patrol', held: true }; }
    const rackRoom = chambers.find(ch => ch.onRack);
    if (rackRoom && spec.horror) { const cp = captives.shift() ?? { name: pick(r, ['the One on the Rack', 'the Screamer', 'Poor Tam']), description: 'strapped to the rack, alive, barely' }; const p = freeIn(rackRoom)[0]; if (p) place.guards[cp.name] = { name: cp.name, description: cp.description, hostile: false, role: 'prisoner', room: rackRoom.id, patrol: [rackRoom.id], step: 0, floor: 'F0', x: p[0], y: p[1], state: 'patrol', held: true }; }
    // ---- the band's valuables in the hoard (in a chest when there is one) ----
    const hoard = chambers.find(ch => ch.loot) ?? den ?? chambers[0];
    for (const it of spec.items) {
        if (!hoard) break;
        const chest = map.props.find(p => p.type === 'chest' && p.x >= hoard.rect.x && p.x < hoard.rect.x + hoard.rect.w && p.y >= hoard.rect.y && p.y < hoard.rect.y + hoard.rect.h);
        const p = chest ? [chest.x, chest.y] : freeIn(hoard)[0];
        if (!p) break;
        const id = `I${Object.keys(place.items).length + 1}`;
        place.items[id] = { id, name: it.name, room: hoard.id, floor: 'F0', x: p[0], y: p[1], hidden: it.hidden === true, note: it.note || (chest ? 'in the chest' : ''), state: 'here' };
    }
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    clearDoorways(place);
    // Where you land: beside the first shaft. Nothing is known until it's seen.
    const first = shafts[0] ?? { x: anyCell[0], y: anyCell[1], id: null };
    const stand = DIRS.map(([dx, dy]) => [first.x + dx, first.y + dy]).find(([x, y]) => get(x, y) === '.' && !map.props.some(p => PROPS[p.type]?.blocks && !p.hidden && p.x === x && p.y === y)) ?? [first.x, first.y];
    place.start = { floor: 'F0', x: stand[0], y: stand[1], room: first.id };
    place.state.explored.F0 = '0'.repeat(W * H);
    place.tunnels = { horror: spec.horror, chambers: chambers.map(ch => ch.id), shafts: shafts.map(s => s.id) };
    return place;
}
