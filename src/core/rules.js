// Common-sense rules for a place's plan: what any real building (or dungeon) obeys, whoever planned
// it (Claude, or the algorithm in architect.js). They run on the plan before any wall is drawn, so a
// jail cell has one barred door and no other way out, a vault is locked, a bedroom isn't a corridor,
// stairs don't come up in a bathroom, and the front door isn't in the pantry. Every rule is
// idempotent (running it twice changes nothing) and says what it fixed. Pure module.
//
// The plan here is normalizePlan's shape: {kind, building, condition, floors, rooms, links, guards,
// start}. Rooms: {id, name, type, floor, size, lit, exit, windows, items, traps, props, marks}.
// Links: {a, b, via: door|arch|locked|secret|stairs|cell, key, dc, state?}.

import { nameKey } from './text.js';

/** Rooms you live or keep things in: one way in (two for a bedroom with its own bath or closet). */
const PRIVATE = { bedroom: 2, master_bedroom: 3, bathroom: 1, nursery: 2, pantry: 2, storage: 1, vault: 1, wine_cellar: 2, study: 2, office: 2, cell: 1, armory: 1, attic: 1, servants_quarters: 2 };
/** Where the stairs between floors may come up: halls and working rooms, never someone's bedroom or a cell. */
const NO_STAIRS = new Set(['bedroom', 'master_bedroom', 'bathroom', 'nursery', 'cell', 'vault', 'armory', 'study', 'office', 'music_room', 'trophy_room', 'dining_room', 'parlor', 'ballroom', 'throne_room', 'conservatory']);
/** Where a building's way out may be. */
const EXIT_OK = new Set(['foyer', 'hallway', 'tavern', 'shop', 'guard_room', 'kitchen', 'stable', 'smithy', 'workshop', 'chapel', 'room', 'gallery', 'cave', 'office']);
/** A secret door leads somewhere worth hiding. */
const SECRET_WORTHY = new Set(['study', 'library', 'vault', 'cell', 'cellar', 'wine_cellar', 'crypt', 'laboratory', 'storage', 'chapel', 'master_bedroom', 'bedroom', 'torture_chamber', 'office', 'throne_room', 'attic', 'cave', 'room']);
/** Hubs: the rooms other rooms open off. */
const HUB = ['hallway', 'foyer', 'gallery', 'guard_room', 'tavern', 'throne_room', 'cave', 'chapel', 'room'];
/** Dark by nature (nobody lights a cell or a cellar for visitors). */
const DARK = new Set(['cell', 'cellar', 'wine_cellar', 'crypt', 'vault', 'attic', 'storage', 'cave', 'torture_chamber']);
/** No windows: underground, or nobody would put one there. */
const WINDOWLESS = new Set(['vault', 'cellar', 'wine_cellar', 'crypt', 'pantry', 'armory']);
/** Sizes that make sense for a type (smallest and largest allowed). */
const SIZE_ORDER = ['tiny', 'small', 'medium', 'large', 'huge'];
const SIZE_RANGE = { cell: ['tiny', 'small'], bathroom: ['tiny', 'small'], pantry: ['tiny', 'small'], storage: ['tiny', 'medium'], vault: ['tiny', 'medium'], nursery: ['small', 'medium'], study: ['small', 'medium'], office: ['small', 'medium'], ballroom: ['large', 'huge'], throne_room: ['large', 'huge'], foyer: ['medium', 'huge'], dining_room: ['medium', 'huge'], tavern: ['medium', 'huge'] };
/** Items that open things. */
const KEYLIKE = /\bkeys?\b|key ring|keyring/i;

const roomOf = (plan, id) => plan.rooms.find(r => r.id === id);
const linksOf = (plan, id) => plan.links.filter(l => l.a === id || l.b === id);
const other = (l, id) => (l.a === id ? l.b : l.a);
const linked = (plan, a, b) => plan.links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
function addLink(plan, a, b, via, extra = {}) {
    if (a === b || linked(plan, a, b)) return false;
    const ra = roomOf(plan, a), rb = roomOf(plan, b);
    plan.links.push({ a, b, via: ra && rb && ra.floor !== rb.floor ? 'stairs' : via, key: '', dc: 15, ...extra });
    return true;
}
function removeLink(plan, l) { plan.links.splice(plan.links.indexOf(l), 1); }
function newId(plan, base) { let id = base; let n = 1; while (plan.rooms.some(r => r.id === id)) id = `${base}${++n}`; return id; }
function newRoom(plan, fields) {
    const room = { id: newId(plan, fields.id || 'X'), name: 'Room', type: 'room', floor: plan.floors[0].id, size: '', lit: null, description: '', props: [], marks: [], traps: [], items: [], exit: false, windows: '', ...fields };
    room.id = newId(plan, fields.id || 'X');
    plan.rooms.push(room);
    return room;
}

/**
 * The best room on a floor for `room` to open off: a hub on its floor that isn't private, a cell or
 * the room itself (a hallway first, then the foyer and other hubs), else anything public there.
 */
function anchorFor(plan, room, { avoid = [] } = {}) {
    const sameFloor = plan.rooms.filter(r => r.floor === room.floor && r.id !== room.id && !avoid.includes(r.id) && r.type !== 'cell' && !PRIVATE[r.type]);
    for (const t of HUB) {
        const hit = sameFloor.filter(r => r.type === t).sort((a, b) => linksOf(plan, b.id).length - linksOf(plan, a.id).length)[0];
        if (hit) return hit;
    }
    return sameFloor[0] ?? null;
}

/** A floor's main hub (where stairs and the cell block hang off). */
function hubOf(plan, floorId) {
    return anchorFor(plan, { id: '', floor: floorId });
}

// ---------- the rules ----------

/** How many cells line one cell block (a big jail has several blocks). */
const CELLS_PER_BLOCK = 8;
const BLOCK_NAMES = ['Cell Block', 'East Cell Block', 'West Cell Block', 'North Cell Block', 'South Cell Block', 'Old Cell Block', 'New Cell Block', 'Back Cell Block'];

/**
 * Jail cells: every cell has exactly ONE door, a barred cell door (locked), onto a cell block of
 * its floor (a hallway; made if there isn't one, joined to whatever the cells opened onto; at most
 * eight cells to a block, so a big jail has several blocks off the first). No other doors, arches
 * or stairs; a single hidden way out (a loose stone, a tunnel) may stay as a secret door. Barred
 * windows or none; never the way out; dark; tiny or small.
 */
function cells(plan) {
    const log = [];
    const jail = /prison|jail|gaol|lockup|brig|stockade|barracks|guard/.test(plan.kind || '');
    for (const f of plan.floors) {
        const list = plan.rooms.filter(r => r.floor === f.id && r.type === 'cell');
        if (!list.length) continue;
        const ids = new Set(list.map(r => r.id));
        const cellsOn = r => linksOf(plan, r.id).filter(l => ids.has(other(l, r.id)) && l.via === 'cell').length;
        // The blocks: hallways already used as one, else the hallway the cells mostly open onto
        // (never a hidden passage reached only by secret doors), else a new one.
        const blocks = plan.rooms.filter(r => r.floor === f.id && r.cellBlock).sort((a, b) => cellsOn(b) - cellsOn(a));
        if (!blocks.length) {
            const hidden = r => linksOf(plan, r.id).some(l => l.via === 'secret') && linksOf(plan, r.id).every(l => l.via === 'secret' || (ids.has(other(l, r.id)) && l.via !== 'cell'));
            const hall = plan.rooms.filter(r => r.floor === f.id && r.type === 'hallway' && !ids.has(r.id) && !hidden(r) && !r.exit)
                .sort((a, b) => linksOf(plan, b.id).filter(l => ids.has(other(l, b.id))).length - linksOf(plan, a.id).filter(l => ids.has(other(l, a.id))).length)[0];
            if (hall) blocks.push(hall);
        }
        const need = Math.ceil(list.length / CELLS_PER_BLOCK);
        while (blocks.length < need) {
            const b = newRoom(plan, { id: `CB${f.id}`, name: blocks.length ? BLOCK_NAMES[blocks.length % BLOCK_NAMES.length] : 'Cell block', type: 'hallway', floor: f.id, size: 'long', windows: 'none', description: '' });
            blocks.push(b);
            log.push(`${f.name}: added a cell block hallway for its cells`);
        }
        for (const [i, b] of blocks.entries()) {
            b.cellBlock = true;
            if (!['long', 'medium', 'large'].includes(b.size)) b.size = 'long';
            if (jail && !/cell|block|brig/i.test(b.name)) {
                const base = BLOCK_NAMES[i % BLOCK_NAMES.length];
                const want = f.level > 0 ? `Upper ${base}` : f.level < 0 ? `Lower ${base}` : base;
                b.name = plan.rooms.some(r => r !== b && r.name === want) ? `${want} ${f.id}${i ? i + 1 : ''}` : want;
            }
        }
        // Each cell belongs to one block: the one it already opens onto by a cell door if that block has room.
        const count = new Map(blocks.map(b => [b.id, 0]));
        const home = new Map();
        for (const cell of list) {
            const on = linksOf(plan, cell.id).find(l => l.via === 'cell' && count.has(other(l, cell.id)) && count.get(other(l, cell.id)) < CELLS_PER_BLOCK);
            if (on) { home.set(cell.id, other(on, cell.id)); count.set(other(on, cell.id), count.get(other(on, cell.id)) + 1); }
        }
        for (const cell of list) {
            if (home.has(cell.id)) continue;
            const b = blocks.slice().sort((x, y) => count.get(x.id) - count.get(y.id))[0];
            home.set(cell.id, b.id);
            count.set(b.id, count.get(b.id) + 1);
        }
        const formerly = new Set();
        let secretKept = false;
        for (const cell of list) {
            for (const l of linksOf(plan, cell.id)) {
                const o = other(l, cell.id);
                if (o === home.get(cell.id) && l.via === 'cell') continue;
                // One hidden way out is allowed (a loose stone, the tunnel someone dug), to a non-cell.
                if (l.via === 'secret' && !ids.has(o) && !secretKept) { secretKept = true; continue; }
                if (!ids.has(o) && !count.has(o)) formerly.add(o);
                removeLink(plan, l);
                log.push(`${cell.name}: removed a ${l.via} to ${roomOf(plan, o)?.name ?? o} (a cell has one barred door)`);
            }
            if (!linked(plan, home.get(cell.id), cell.id)) plan.links.push({ a: home.get(cell.id), b: cell.id, via: 'cell', key: '', dc: 15 });
            if (cell.exit) { cell.exit = false; log.push(`${cell.name}: a cell is never the way out`); }
            cell.windows = cell.windows === 'none' ? 'none' : 'barred';
            cell.lit = false;
            if (!['tiny', 'small'].includes(cell.size)) cell.size = 'tiny';
        }
        // The first block joins whatever the cells used to open onto (a guard room), or the floor's hub;
        // the other blocks open off the first.
        const first = blocks[0];
        const joinTo = [...formerly].map(id => roomOf(plan, id)).filter(r => r && !count.has(r.id));
        if (!linksOf(plan, first.id).some(l => !ids.has(other(l, first.id)) && !count.has(other(l, first.id)))) {
            const to = joinTo[0] ?? anchorFor(plan, first, { avoid: [...ids, ...count.keys()] }) ?? plan.rooms.find(r => !ids.has(r.id) && !count.has(r.id));
            if (to) addLink(plan, first.id, to.id, 'door');
        }
        for (const r of joinTo) if (!linked(plan, first.id, r.id) && r.floor === first.floor && !PRIVATE[r.type] && r.type !== 'cell') addLink(plan, first.id, r.id, 'door');
        for (const b of blocks.slice(1)) if (!linksOf(plan, b.id).some(l => !ids.has(other(l, b.id)))) addLink(plan, first.id, b.id, 'door');
    }
    return log;
}

/** Starting locked up: the party's cell stays locked, and the keys are somewhere in the jail, outside it. */
function lockedIn(plan) {
    const start = roomOf(plan, plan.start);
    if (start?.type !== 'cell') return [];
    const all = plan.rooms.flatMap(r => r.items.map(i => ({ i, r })));
    if (all.some(({ i, r }) => KEYLIKE.test(i.name) && /cell/i.test(i.name) && r.id !== start.id)) return [];
    // Any "cell keys" left inside the cell move out; the keys go where a jailer keeps them.
    for (const it of start.items.filter(i => KEYLIKE.test(i.name))) start.items.splice(start.items.indexOf(it), 1);
    const holder = plan.rooms.find(r => r.type === 'guard_room') ?? plan.rooms.find(r => r.type === 'office') ?? plan.rooms.find(r => r.cellBlock) ?? plan.rooms.find(r => r.id !== start.id && r.type !== 'cell');
    if (!holder) return [];
    holder.items.push({ name: 'ring of cell keys', hidden: false, note: 'on a hook by the door' });
    return [`the cell keys hang in ${holder.name}, not in ${start.name}`];
}

/** Vaults, treasuries and armories: one way in, and it's locked (with a key kept elsewhere). */
function strongrooms(plan) {
    const log = [];
    for (const r of plan.rooms.filter(x => x.type === 'vault' || x.type === 'armory')) {
        const ways = linksOf(plan, r.id).filter(l => l.via !== 'secret');
        if (!ways.length) continue;
        // Keep the one into its best neighbour (a hall, an office); the rest re-route there.
        const rank = l => { const o = roomOf(plan, other(l, r.id)); return (l.via === 'locked' ? -10 : 0) + (['office', 'study', 'hallway', 'guard_room'].includes(o?.type) ? -5 : 0) + (o?.type === 'stairs' ? 0 : 0); };
        const keep = ways.slice().sort((a, b) => rank(a) - rank(b))[0];
        for (const l of ways) if (l !== keep) {
            const o = other(l, r.id);
            removeLink(plan, l);
            addLink(plan, other(keep, r.id), o, 'door');
            log.push(`${r.name}: one way in (moved a door to ${roomOf(plan, other(keep, r.id))?.name})`);
        }
        if (keep.via !== 'locked' && keep.via !== 'stairs' && plan.condition !== 'ruined') {
            keep.via = 'locked';
            log.push(`${r.name}: its door is locked`);
        }
        if (keep.via === 'locked' && !keep.key && plan.condition !== 'ruined') keep.key = `${r.type === 'vault' ? 'vault' : 'armory'} key`;
        r.windows = 'none';
    }
    return log;
}

/** Every key for a locked door is somewhere sensible: with whoever runs the place, never behind its own door. */
function keysKept(plan) {
    const log = [];
    for (const l of plan.links.filter(x => x.via === 'locked' && x.key)) {
        const holderOf = plan.rooms.find(r => r.items.some(i => nameKey(i.name) === nameKey(l.key)));
        if (holderOf && holderOf.id !== l.a && holderOf.id !== l.b) continue;
        if (holderOf) holderOf.items = holderOf.items.filter(i => nameKey(i.name) !== nameKey(l.key));
        const inside = new Set([l.a, l.b]);
        const keeper = ['office', 'study', 'master_bedroom', 'guard_room', 'bedroom', 'servants_quarters', 'kitchen']
            .map(t => plan.rooms.find(r => r.type === t && !inside.has(r.id))).find(Boolean)
            ?? plan.rooms.find(r => !inside.has(r.id) && r.type !== 'cell');
        if (!keeper) continue;
        keeper.items.push({ name: l.key, hidden: true, note: '' });
        log.push(`${l.key} kept in ${keeper.name}`);
    }
    return log;
}

/**
 * Private rooms aren't corridors: a bedroom, bath, closet, pantry, study or office opens off one
 * room (a bedroom may also have its bath or dressing room). Rooms that were reached THROUGH it now
 * open off the same hall it does. Secret doors don't count.
 */
function privateRooms(plan) {
    const log = [];
    if (plan.condition === 'ruined') return log; // a ruin is a maze: rooms through rooms
    for (const r of plan.rooms) {
        const max = PRIVATE[r.type];
        if (!max || r.type === 'cell') continue;
        const ways = linksOf(plan, r.id).filter(l => l.via !== 'secret');
        if (ways.length <= max) continue;
        // Keep the link to its hall (or the busiest public room), then the private rooms it serves.
        const score = l => { const o = roomOf(plan, other(l, r.id)); if (!o) return 99; if (l.via === 'stairs') return 50; if (HUB.includes(o.type)) return 0; if (PRIVATE[o.type] && (r.type === 'bedroom' || r.type === 'master_bedroom') && ['bathroom', 'storage', 'nursery'].includes(o.type)) return 1; return PRIVATE[o.type] ? 30 : 10; };
        const sorted = ways.slice().sort((a, b) => score(a) - score(b));
        const main = sorted[0];
        const hall = other(main, r.id);
        for (const l of sorted.slice(max)) {
            const o = other(l, r.id);
            removeLink(plan, l);
            const or = roomOf(plan, o);
            if (l.via === 'stairs') addLink(plan, hubOf(plan, r.floor)?.id ?? hall, o, 'stairs');
            else addLink(plan, hall, o, l.via === 'locked' ? 'locked' : 'door', l.via === 'locked' ? { key: l.key } : {});
            log.push(`${r.name} isn't a corridor: ${or?.name ?? o} now opens off ${roomOf(plan, hall)?.name ?? hall}`);
        }
    }
    return log;
}

/** Stairs come up in halls and working rooms, never in a bedroom, a bath, a cell or a vault. */
function stairsWhereTheyBelong(plan) {
    const log = [];
    for (const l of plan.links.filter(x => x.via === 'stairs')) {
        for (const end of ['a', 'b']) {
            const r = roomOf(plan, l[end]);
            if (!r || !NO_STAIRS.has(r.type)) continue;
            const hub = anchorFor(plan, r, { avoid: [l.a, l.b] });
            if (!hub) continue;
            const was = r.name;
            const otherEnd = l[end === 'a' ? 'b' : 'a'];
            if (linked(plan, hub.id, otherEnd)) { removeLink(plan, l); } else l[end] = hub.id;
            addLink(plan, hub.id, r.id, 'door');
            log.push(`stairs moved from ${was} to ${hub.name}`);
            break;
        }
    }
    return log;
}

/** Kitchens work: the pantry opens off the kitchen, the kitchen serves the dining room. */
function kitchens(plan) {
    const log = [];
    for (const k of plan.rooms.filter(r => r.type === 'kitchen')) {
        for (const p of plan.rooms.filter(r => r.type === 'pantry' && r.floor === k.floor)) {
            if (linked(plan, k.id, p.id)) continue;
            for (const l of linksOf(plan, p.id).filter(x => x.via !== 'secret' && x.via !== 'stairs')) removeLink(plan, l);
            addLink(plan, k.id, p.id, 'door');
            log.push(`${p.name} opens off ${k.name}`);
        }
        const dining = plan.rooms.find(r => r.type === 'dining_room' && r.floor === k.floor);
        if (dining && !linked(plan, k.id, dining.id) && plan.condition !== 'ruined') {
            addLink(plan, k.id, dining.id, 'door');
            log.push(`${k.name} serves ${dining.name}`);
        }
    }
    return log;
}

/** A bathroom opens off a bedroom or a hall, never a kitchen, dining room or another bath. */
function baths(plan) {
    const log = [];
    for (const b of plan.rooms.filter(r => r.type === 'bathroom')) {
        for (const l of linksOf(plan, b.id)) {
            const o = roomOf(plan, other(l, b.id));
            if (!o || l.via === 'secret' || ['bedroom', 'master_bedroom', 'hallway', 'foyer', 'servants_quarters'].includes(o.type)) continue;
            removeLink(plan, l);
            const to = plan.rooms.find(r => r.floor === b.floor && ['master_bedroom', 'bedroom'].includes(r.type) && linksOf(plan, r.id).length < 3) ?? anchorFor(plan, b);
            if (to) addLink(plan, to.id, b.id, 'door');
            log.push(`${b.name}: moved off ${o.name}`);
        }
    }
    return log;
}

/**
 * The way out of a building is where people come and go (an entrance hall, a corridor, a shop
 * floor, a back door in the kitchen), on the floor nearest the ground: never a bedroom, a bath, a
 * cell, a vault or an upstairs room.
 */
function wayOut(plan) {
    const log = [];
    if (!plan.building) return log;
    const ground = plan.floors.slice().sort((a, b) => Math.abs(a.level) - Math.abs(b.level))[0]?.id;
    for (const r of plan.rooms.filter(x => x.exit)) {
        if (EXIT_OK.has(r.type) && r.floor === ground && !r.cellBlock) continue;
        r.exit = false;
        const to = plan.rooms.find(x => x.floor === ground && x.type === 'foyer') ?? plan.rooms.find(x => x.floor === ground && EXIT_OK.has(x.type) && !x.cellBlock) ?? plan.rooms.find(x => x.floor === ground && x.type !== 'cell');
        if (to) { to.exit = true; log.push(`the way out moved from ${r.name} to ${to.name}`); }
    }
    return log;
}

/** A secret door leads somewhere worth hiding (a study, a vault, a crypt), never just between two halls. */
function secrets(plan) {
    const log = [];
    for (const l of plan.links.filter(x => x.via === 'secret')) {
        const a = roomOf(plan, l.a), b = roomOf(plan, l.b);
        if (!a || !b || SECRET_WORTHY.has(a.type) || SECRET_WORTHY.has(b.type) || a.hidden || b.hidden) continue;
        l.via = 'door';
        log.push(`a secret door between ${a.name} and ${b.name} became a plain door (nothing to hide)`);
    }
    return log;
}

/** Light, windows and size that fit the room. */
function fittings(plan) {
    const log = [];
    for (const r of plan.rooms) {
        if (DARK.has(r.type) && r.lit === true && r.type !== 'storage') { r.lit = false; log.push(`${r.name} is dark`); }
        if (WINDOWLESS.has(r.type) && r.windows !== 'none') r.windows = 'none';
        const range = SIZE_RANGE[r.type];
        if (range && r.size && r.size !== 'long') {
            const i = SIZE_ORDER.indexOf(r.size), lo = SIZE_ORDER.indexOf(range[0]), hi = SIZE_ORDER.indexOf(range[1]);
            if (i >= 0 && (i < lo || i > hi)) { r.size = SIZE_ORDER[Math.min(hi, Math.max(lo, i))]; log.push(`${r.name} resized to ${r.size}`); }
        }
    }
    return log;
}

/** Guards walk rounds on their own floor through rooms that join up; nobody hostile starts in the party's room. */
function patrols(plan) {
    const log = [];
    for (const g of plan.guards || []) {
        const home = roomOf(plan, g.room);
        if (!home) continue;
        g.patrol = (g.patrol || []).filter(id => roomOf(plan, id)?.floor === home.floor && roomOf(plan, id)?.type !== 'cell');
        if (g.hostile !== false && g.room === plan.start && !g.here) {
            const next = linksOf(plan, g.room).map(l => roomOf(plan, other(l, g.room))).find(r => r && r.floor === home.floor && r.type !== 'cell');
            if (next) { g.room = next.id; log.push(`${g.name} starts in ${next.name}, not on top of the party`); }
        }
    }
    return log;
}

/** A jail is staffed: a turnkey watching every cell block, someone on the door. (After the cells are organized into blocks.) */
function staffed(plan) {
    const log = [];
    if (!/prison|jail|gaol|stockade|lockup|penitentiary|brig\b|detention|holding|barracks|garrison/i.test(`${plan.kind || ''} ${plan.name || ''}`)) return log;
    plan.guards ??= [];
    let n = plan.guards.filter(g => /^Turnkey \d+$/.test(g.name)).length;
    const post = (rm, what) => {
        if (!rm || plan.guards.some(g => g.hostile === false && (g.room === rm.id || (g.patrol || []).includes(rm.id)))) return;
        let name;
        do { n++; name = `Turnkey ${n}`; } while (plan.guards.some(g => g.name === name));
        plan.guards.push({ name, description: `a turnkey, ${what}`, room: rm.id, patrol: [rm.id], hostile: false, role: 'guard' });
        log.push(`${name} posted in ${rm.name} (${what})`);
    };
    for (const hall of plan.rooms.filter(r => r.type === 'hallway')) {
        const cells = linksOf(plan, hall.id).map(l => roomOf(plan, other(l, hall.id))).filter(r => r?.type === 'cell');
        if (cells.length >= 2) post(hall, 'watching the cells');
    }
    post(plan.rooms.find(r => r.exit) ?? plan.rooms.find(r => r.type === 'guard_room'), 'on the door');
    return log;
}

/** The rules, in the order they run. */
export const RULES = [
    { id: 'cells', says: 'A jail cell has exactly one door, a locked barred cell door onto its cell block; at most one hidden way out; barred windows; never the way out.', run: cells },
    { id: 'locked_in', says: 'Starting in a cell: it stays locked and the cell keys are kept outside it, where a jailer would keep them.', run: lockedIn },
    { id: 'strongrooms', says: 'A vault or armory has one way in, and it is locked.', run: strongrooms },
    { id: 'private', says: 'Bedrooms, baths, closets, pantries, studies and offices open off one room; they are not corridors.', run: privateRooms },
    { id: 'kitchens', says: 'The pantry opens off the kitchen; the kitchen serves the dining room.', run: kitchens },
    { id: 'baths', says: 'A bathroom opens off a bedroom or a hall.', run: baths },
    { id: 'stairs', says: 'Stairs come up in halls and working rooms, never in bedrooms, baths, cells or vaults.', run: stairsWhereTheyBelong },
    { id: 'secrets', says: 'A secret door leads somewhere worth hiding.', run: secrets },
    { id: 'keys', says: 'Every lock\'s key is kept somewhere sensible, never behind its own door.', run: keysKept },
    { id: 'way_out', says: 'A building\'s way out is an entrance, hall, shop floor or back door on the ground floor.', run: wayOut },
    { id: 'fittings', says: 'Cellars, cells and crypts are dark; vaults and cellars have no windows; rooms are sized for what they are.', run: fittings },
    { id: 'patrols', says: 'Guards patrol their own floor, and nobody hostile starts on top of the party.', run: patrols },
    { id: 'staffed', says: 'A jail has a turnkey watching every cell block and someone on the door.', run: staffed },
];

/** Run every rule on a plan (in place). Returns what was fixed, as plain lines. */
export function applyRules(plan) {
    const log = [];
    for (const rule of RULES) log.push(...rule.run(plan));
    return log;
}

// ---------- after the walls are drawn ----------

/**
 * Checks on a built place, for the rules geometry has to keep: each cell has exactly one door and
 * it's a cell door; every opening in a room's walls is a door (walls are solid). Returns problems.
 */
export function checkPlace(place) {
    const problems = [];
    const charAt = (f, x, y) => { const m = place.floors.find(fl => fl.id === f)?.map; return m ? (m.rows[m.h - 1 - y]?.[x] ?? '%') : '%'; };
    const doorAt = new Map(Object.values(place.doors).map(d => [`${d.floor}:${d.x},${d.y}`, d]));
    const windowAt = new Set(Object.values(place.windows || {}).map(w => `${w.floor}:${w.x},${w.y}`));
    const exitAt = new Set((place.exits || []).map(e => `${e.floor}:${e.x},${e.y}`));
    const roomAtSq = (f, x, y) => Object.values(place.rooms).find(r => r.floor === f && x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h);
    const SOLID = new Set(['#', '%', 'I', 'H', '|', 'U', 'T']);
    for (const rm of Object.values(place.rooms)) {
        const { x: rx, y: ry, w, h } = rm.rect;
        const openings = [];
        for (let x = rx - 1; x <= rx + w; x++) for (let y = ry - 1; y <= ry + h; y++) {
            const edge = x === rx - 1 || x === rx + w || y === ry - 1 || y === ry + h;
            const corner = (x === rx - 1 || x === rx + w) && (y === ry - 1 || y === ry + h);
            if (!edge || corner) continue;
            const k = `${rm.floor}:${x},${y}`;
            const ch = charAt(rm.floor, x, y);
            if (doorAt.has(k)) { openings.push(doorAt.get(k)); continue; }
            if (windowAt.has(k) || exitAt.has(k) || SOLID.has(ch)) continue;
            // An open square in the wall line: fine only if it's the same room (a round room's curve) or stairs.
            const there = roomAtSq(rm.floor, x, y);
            if (there?.id === rm.id || ch === '<' || ch === '>') continue;
            problems.push(`${rm.name} (${rm.id}) has a gap in its wall at ${x},${y} ('${ch}')`);
        }
        if (rm.type === 'cell') {
            const ways = openings.filter(d => d.kind !== 'secret');
            if (ways.length !== 1) problems.push(`${rm.name} (${rm.id}) has ${ways.length} doors (a cell has exactly one)`);
            else if (ways[0].kind !== 'cell') problems.push(`${rm.name} (${rm.id}) has a ${ways[0].kind} door instead of a cell door`);
        }
    }
    return problems;
}
