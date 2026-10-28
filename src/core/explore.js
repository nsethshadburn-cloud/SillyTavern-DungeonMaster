// Exploring a generated place: which room a square is in, fog of war (what the party can see and
// has seen), walking paths, guards on patrol, the DM's view of the place, and the DM's changes
// (doors, traps, items, guards). Pure module.

import { PROPS, TERRAIN, HEAVY, HIDE, SEATS, terrainAt, propsAt, colName, parseCoord } from './grid.js';
import { doorChar, ensureIds } from './layout.js';
import { nameKey, matchName } from './text.js';

const OUTDOOR = new Set(['town', 'forest', 'camp', 'swamp', 'snow', 'desert', 'jungle']);
/** Squares you can't see through. Windows and open doors are see-through. */
const OPAQUE = new Set(['#', '%', '+', 'D', 'T']);
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function floorById(place, id) {
    return place.floors.find(f => f.id === id) ?? place.floors[0];
}

/** The room whose floor covers this square (walls and corridors: none). */
export function roomAt(place, floorId, x, y) {
    for (const rm of Object.values(place.rooms)) {
        if (rm.floor !== floorId) continue;
        const r = rm.rect;
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return rm;
    }
    return null;
}

export function doorAt(place, floorId, x, y) {
    return Object.values(place.doors).find(d => d.floor === floorId && d.x === x && d.y === y) ?? null;
}

/** Stairs on this square: where they lead. */
export function stairsAt(place, floorId, x, y) {
    for (const s of place.stairs) {
        if (s.a.floor === floorId && s.a.x === x && s.a.y === y) return s.b;
        if (s.b.floor === floorId && s.b.x === x && s.b.y === y) return s.a;
    }
    return null;
}

export function exitAt(place, floorId, x, y) {
    return place.exits.find(e => e.floor === floorId && e.x === x && e.y === y) ?? null;
}

// ---------- fog of war ----------

const litCache = new WeakMap();

/** Squares that are lit: outdoors, lit rooms (with their walls), and around light sources. */
export function litMask(place, floorId) {
    const map = floorById(place, floorId).map;
    const cached = litCache.get(map);
    if (cached && cached.version === (map.version || 0)) return cached.mask;
    const mask = new Uint8Array(map.w * map.h);
    if (OUTDOOR.has(map.theme) || place.fog === false) mask.fill(1);
    else {
        for (const rm of Object.values(place.rooms)) {
            if (rm.floor !== floorId || !rm.lit) continue;
            const r = rm.rect;
            for (let x = r.x - 1; x <= r.x + r.w; x++) for (let y = r.y - 1; y <= r.y + r.h; y++) if (x >= 0 && y >= 0 && x < map.w && y < map.h) mask[y * map.w + x] = 1;
        }
        const fireLit = Object.entries(map.fire || {}).map(([k, f]) => { const [x, y] = k.split(',').map(Number); return { x, y, type: '', hidden: false, rad: 1 + f.heat }; });
        for (const p of [...(map.props || []), ...fireLit]) {
            const rad = p.rad ?? PROPS[p.type]?.light;
            if (!rad || p.hidden) continue;
            for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
                const x = p.x + dx, y = p.y + dy;
                if (x >= 0 && y >= 0 && x < map.w && y < map.h && dx * dx + dy * dy <= rad * rad) mask[y * map.w + x] = 1;
            }
        }
    }
    litCache.set(map, { version: map.version || 0, mask });
    return mask;
}

function lineOfSight(map, x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    let x = x0, y = y0;
    while (!(x === x1 && y === y1)) {
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
        if (x === x1 && y === y1) return true;
        if (OPAQUE.has(terrainAt(map, x, y))) return false;
    }
    return true;
}

const zoneCache = new WeakMap();
const barCache = new WeakMap();
const BARS = new Set(['I', 'J', 'j', 'H']);

/** Which rooms see into each other through bars (a cell and its hallway): zone -> Set of zones. */
function barLinks(map, z) {
    const hit = barCache.get(map);
    if (hit && hit.version === (map.version || 0)) return hit.links;
    const links = new Map();
    const add = (a, b) => { if (!a || !b || a === b) return; if (!links.has(a)) links.set(a, new Set()); links.get(a).add(b); };
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        if (!BARS.has(terrainAt(map, x, y))) continue;
        const zone = (xx, yy) => (xx < 0 || yy < 0 || xx >= map.w || yy >= map.h ? 0 : z.grid[yy * map.w + xx]);
        for (const [a, b] of [[zone(x - 1, y), zone(x + 1, y)], [zone(x, y - 1), zone(x, y + 1)]]) { add(a, b); add(b, a); }
    }
    barCache.set(map, { version: map.version || 0, links });
    return links;
}

/** Which room's floor each square is (index + 1), 0 for corridors, doorways and walls. */
function zones(place, floorId) {
    const map = floorById(place, floorId).map;
    const cached = zoneCache.get(map);
    if (cached) return cached;
    const z = { grid: new Int16Array(map.w * map.h), rooms: [] };
    for (const rm of Object.values(place.rooms)) {
        if (rm.floor !== floorId) continue;
        z.rooms.push(rm);
        const n = z.rooms.length, r = rm.rect;
        for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) z.grid[y * map.w + x] = n;
    }
    zoneCache.set(map, z);
    return z;
}

/**
 * What the party sees right now on one floor. You only see the space you're in: the room you're
 * standing in (its floor, walls and doors), or the corridor. Another room stays dark until you step
 * inside it, even if it's lit and the door is open. Within your own space, walls, closed doors and
 * pillars block the view, and in the dark you only see lit squares and what's close by.
 * @param {Array<{x:number,y:number}>} viewers
 */
export function computeVisible(place, floorId, viewers, { radius = 11, near = 2 } = {}) {
    const map = floorById(place, floorId).map;
    const lit = litMask(place, floorId);
    const vis = new Uint8Array(map.w * map.h);
    const z = zones(place, floorId);
    const open = OUTDOOR.has(map.theme) || !z.rooms.length;
    const through = barLinks(map, z);
    for (const v of viewers) {
        const own = z.grid[v.y * map.w + v.x];
        const room = own ? z.rooms[own - 1] : null;
        const inRing = (x, y) => room && x >= room.rect.x - 1 && x <= room.rect.x + room.rect.w && y >= room.rect.y - 1 && y <= room.rect.y + room.rect.h;
        if (room?.lit) {
            const r = room.rect;
            for (let x = r.x - 1; x <= r.x + r.w; x++) for (let y = r.y - 1; y <= r.y + r.h; y++) if (x >= 0 && y >= 0 && x < map.w && y < map.h) vis[y * map.w + x] = 1;
        }
        for (let x = Math.max(0, v.x - radius); x <= Math.min(map.w - 1, v.x + radius); x++) {
            for (let y = Math.max(0, v.y - radius); y <= Math.min(map.h - 1, v.y + radius); y++) {
                const i = y * map.w + x;
                if (vis[i]) continue;
                const d = Math.max(Math.abs(x - v.x), Math.abs(y - v.y));
                if (!open && d > 1) {
                    const zone = z.grid[i];
                    // Another room's floor: not until you're in it. From inside a room: only its own walls and doors.
                    if (zone && zone !== own && !through.get(own)?.has(zone)) continue;
                    if (!zone && room && !inRing(x, y) && ![...(through.get(own) ?? [])].some(zn => { const rr = z.rooms[zn - 1]?.rect; return rr && x >= rr.x - 1 && x <= rr.x + rr.w && y >= rr.y - 1 && y <= rr.y + rr.h; })) continue;
                }
                if (!lit[i] && d > near) continue;
                if (lineOfSight(map, v.x, v.y, x, y)) vis[i] = 1;
            }
        }
    }
    return vis;
}

/** Add what's visible to what's been explored. Returns how many squares were new. */
export function reveal(place, floorId, visible) {
    const map = floorById(place, floorId).map;
    const had = place.state.explored[floorId] || '0'.repeat(map.w * map.h);
    const out = had.split('');
    let added = 0;
    for (let i = 0; i < visible.length; i++) if (visible[i] && out[i] !== '1') { out[i] = '1'; added++; }
    if (added) place.state.explored[floorId] = out.join('');
    return added;
}

export function isExplored(place, floorId, x, y) {
    const map = floorById(place, floorId).map;
    return (place.state.explored[floorId] ?? '')[y * map.w + x] === '1';
}

/** Mark whole rooms as explored (the party found a floor plan, or the DM says they know a room). */
export function revealRooms(place, ids) {
    for (const id of ids) {
        const rm = place.rooms[id];
        if (!rm) continue;
        const map = floorById(place, rm.floor).map;
        const vis = new Uint8Array(map.w * map.h);
        const r = rm.rect;
        for (let x = r.x - 1; x <= r.x + r.w; x++) for (let y = r.y - 1; y <= r.y + r.h; y++) if (x >= 0 && y >= 0 && x < map.w && y < map.h) vis[y * map.w + x] = 1;
        reveal(place, rm.floor, vis);
    }
}

// ---------- walking ----------

/** Can someone stand on (or walk through) this square? Closed doors open as you walk in; locked ones don't. */
export function walkable(place, floorId, x, y) {
    const map = floorById(place, floorId).map;
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
    const ch = terrainAt(map, x, y);
    // Something solid in the way (furniture, or a barricade shoved into a doorway) blocks it.
    if (propsAt(map, x, y).some(p => PROPS[p.type]?.blocks)) return false;
    if (ch === '+') return true;
    if (TERRAIN[ch]?.walk === false) return false;
    return ch !== '%';
}

/**
 * Shortest walk to a square through explored, walkable squares (diagonals allowed, no cutting
 * corners). Returns the steps after the start, or null.
 * toward: running into the dark. Uses the real map (not what's explored) and, when the square
 * can't be reached (a wall, a locked door), goes as close to it as the way allows.
 */
export function findPath(place, floorId, from, to, { knownOnly = true, blocked = new Set(), toward = false, isGoal = null } = {}) {
    const map = floorById(place, floorId).map;
    const known = (x, y) => toward || !knownOnly || isExplored(place, floorId, x, y);
    if (!toward && !isGoal && (!walkable(place, floorId, to.x, to.y) || !known(to.x, to.y))) return null;
    const key = (x, y) => y * map.w + x;
    const prev = new Map([[key(from.x, from.y), null]]);
    const queue = [[from.x, from.y]];
    const pathTo = k => {
        const path = [];
        while (prev.get(k) !== null) { path.unshift([k % map.w, Math.floor(k / map.w)]); k = prev.get(k); }
        return path;
    };
    const far = (x, y) => Math.max(Math.abs(x - to.x), Math.abs(y - to.y)) * 1000 + Math.abs(x - to.x) + Math.abs(y - to.y);
    let best = key(from.x, from.y), bestFar = far(from.x, from.y);
    for (let qi = 0; qi < queue.length; qi++) {
        const [x, y] = queue[qi];
        if (isGoal ? qi > 0 && isGoal(x, y) : x === to.x && y === to.y) return pathTo(key(x, y));
        // Stairs and ways out are where a walk ends, not somewhere to stop near.
        if (toward && far(x, y) < bestFar && terrainAt(map, x, y) !== '<' && terrainAt(map, x, y) !== '>') { best = key(x, y); bestFar = far(x, y); }
        for (const [dx, dy] of DIRS8) {
            const nx = x + dx, ny = y + dy, k = key(nx, ny);
            if (prev.has(k) || !walkable(place, floorId, nx, ny) || !known(nx, ny) || blocked.has(`${nx},${ny}`)) continue;
            // Stepping on stairs takes you to another floor: only walk onto them when they're where you're going.
            if ((nx !== to.x || ny !== to.y) && (terrainAt(map, nx, ny) === '<' || terrainAt(map, nx, ny) === '>')) continue;
            // Diagonal steps can't squeeze between two walls or through a doorway.
            if (dx && dy && (!walkable(place, floorId, x + dx, y) || !walkable(place, floorId, x, y + dy) || terrainAt(map, nx, ny) === '+' || terrainAt(map, x, y) === '+' || terrainAt(map, nx, ny) === '/' || terrainAt(map, x, y) === '/')) continue;
            prev.set(k, key(x, y));
            queue.push([nx, ny]);
        }
    }
    return toward ? pathTo(best) : null;
}

/** An open pit (or hole) stays dangerous after it's sprung; darts and the like are spent. */
const OPEN_TRAP = /pit|hole|trapdoor|chasm|shaft/i;

/**
 * Does `name` know about this trap? They found it, saw it go off, were told about it, or it was
 * set in plain sight ("*"). Companions walk around the traps they know about.
 */
export function knowsTrap(trap, name) {
    if (trap.state === 'sprung') return true;
    if (trap.state !== 'found') return false;
    return (trap.knownBy ?? []).some(n => n === '*' || nameKey(n) === nameKey(name));
}

/** Squares of live traps `name` knows about on a floor (a known plate, an open pit): to walk around. */
export function trapsKnownTo(place, floorId, name) {
    return Object.values(place.traps).filter(t => t.floor === floorId && (t.state === 'found' || (t.state === 'sprung' && OPEN_TRAP.test(t.kind))) && knowsTrap(t, name)).map(t => `${t.x},${t.y}`);
}

/** The player tells `to` about the traps they know of (every found one: they're on the map). Returns what `to` learned. */
export function tellTraps(place, to) {
    const learned = [];
    for (const t of Object.values(place.traps)) {
        if (t.state !== 'found' || knowsTrap(t, to)) continue;
        (t.knownBy ??= []).push(to);
        learned.push(t);
    }
    return learned;
}

/** `name` now knows about these traps (they found them). */
export function learnTraps(traps, name) {
    for (const t of traps) if (!knowsTrap(t, name)) (t.knownBy ??= []).push(name);
}

/** How a trap shows when it catches someone, from its name. */
export function trapLook(kind) {
    const k = String(kind || '').toLowerCase();
    return /\bnet\b/.test(k) ? 'net'
        : /pit|hole|trapdoor|chasm|shaft/.test(k) ? 'pit'
            : /bear|jaw|clamp|leg.?hold/.test(k) ? 'jaws'
                : /gas|poison|cloud|spore|fume/.test(k) ? 'gas'
                    : /fire|flame|burn|glyph|rune|explo|lightning|spark/.test(k) ? 'fire'
                        : /block|boulder|ceiling|crush|stone|rock|collapse/.test(k) ? 'crush'
                            : /alarm|bell|chime|gong/.test(k) ? 'alarm'
                                : /blade|scythe|spike|spear|saw|axe|stake/.test(k) ? 'blades'
                                    : /dart|arrow|needle|bolt|plate/.test(k) ? 'darts'
                                        : 'snare';
}

/**
 * Who a trap is holding right now ({trap, look, at}), or null: only while they're still on its
 * square (moved off it, by the DM or someone pulling them out, they're free).
 */
export function caughtNow(place, name) {
    const c = place.state.caught?.[name];
    const pos = place.state.positions[name];
    const trap = c && place.traps[c.trap];
    if (!c || !pos || !trap || trap.floor !== pos.floor || trap.x !== pos.x || trap.y !== pos.y) return null;
    return { ...c, kind: trap.kind };
}

/** Let someone go (their save worked, or the DM frees them). */
export function release(place, name) {
    if (!place.state.caught?.[name]) return false;
    delete place.state.caught[name];
    return true;
}

/**
 * Someone steps onto (x, y). A hidden trap springs (and shows); a known one goes off unless they
 * cross it carefully; an open pit swallows them. Returns what the DM needs to rule on, or ''.
 */
export function stepOn(place, name, floorId, x, y, { player = false } = {}) {
    const trap = Object.values(place.traps).find(t => t.floor === floorId && t.x === x && t.y === y
        && (t.state === 'hidden' || t.state === 'found' || (t.state === 'sprung' && OPEN_TRAP.test(t.kind))));
    if (!trap) return '';
    // Caught: held right there (and shown) until their save frees them or the DM does.
    place.state.caught ??= {};
    place.state.caught[name] = { trap: trap.id, look: trapLook(trap.kind), at: Date.now() };
    if (place.state.hidden?.[name]) delete place.state.hidden[name];
    if (place.state.pose?.[name]) delete place.state.pose[name];
    const room = place.rooms[trap.room]?.name ?? 'a passage';
    const dc = `DC ${trap.dc}${trap.save ? ` ${trap.save} save` : ''}. ${trap.effect}.`;
    const dmg = `kind "save"${trap.save ? ` (${trap.save})` : ''}, dc ${trap.dc}, with the trap's damage dice in "damage" (and "half": true if a success still takes half) so the code applies it`;
    const roll = (player ? `Ask for the save (player_roll, ${dmg})` : `Roll ${name}'s save (npc_rolls, ${dmg})`) + `. ${name} is CAUGHT in it (the map shows it and they can't move): a successful save frees them by itself; on a failure you decide what happens next and set place_changes.free ["${name}"] when they get loose`;
    if (trap.state === 'hidden') {
        trap.state = 'sprung';
        const map = floorById(place, floorId).map;
        const prop = map.props.find(p => p.trap === trap.id);
        if (prop) { prop.hidden = false; map.version = (map.version || 0) + 1; }
        return `${name} stepped on a hidden ${trap.kind} (${trap.id}) in ${room}: ${dc} ${roll} and narrate it.`;
    }
    if (trap.state === 'found') return `${name} stepped onto the ${trap.kind} (${trap.id}) in ${room} that the party already knew about, and it goes off: ${dc} ${roll} for the save and narrate it; mark it "sprung" (or "disarmed" if it breaks) in place_changes.`;
    return `${name} walked into the open ${trap.kind} (${trap.id}) in ${room}: ${dc} ${roll} and narrate the fall.`;
}

/**
 * A new trap on a square: in place.traps (so stepping on it sets it off and a search can find it)
 * with its prop on the map. Hidden ones aren't drawn until found or sprung.
 */
export function addTrap(place, floorId, x, y, { kind = '', dc = 13, save = '', effect = '', hidden = false } = {}) {
    let n = Object.keys(place.traps).length + 1;
    while (place.traps[`T${n}`]) n++;
    const id = `T${n}`;
    const name = String(kind || 'trap').slice(0, 60);
    const trap = {
        id, room: roomAt(place, floorId, x, y)?.id ?? null, floor: floorId, x, y, kind: name, knownBy: hidden ? [] : ['*'],
        dc: Math.min(25, Math.max(8, Math.round(Number(dc)) || 13)), save: String(save || '').slice(0, 24),
        effect: String(effect || '').slice(0, 240) || `the ${name} goes off`, state: hidden ? 'hidden' : 'found',
    };
    place.traps[id] = trap;
    const map = floorById(place, floorId).map;
    map.props.push({ x, y, type: 'trap', hidden, trap: id, label: name });
    ensureIds(place);
    bump(place, floorId);
    return trap;
}

/**
 * Trap pictures with no trap behind them (an older DM turn put one down with add_props): make them
 * real traps, visible ones, so they go off. Returns how many were fixed.
 */
export function adoptTrapProps(place) {
    let n = 0;
    for (const f of place.floors) {
        for (const p of [...(f.map.props || [])]) {
            if (p.type !== 'trap' || (p.trap && place.traps[p.trap])) continue;
            f.map.props = f.map.props.filter(q => q !== p);
            addTrap(place, f.id, p.x, p.y, { kind: p.label || 'trap', hidden: false });
            n++;
        }
    }
    return n;
}

/**
 * A companion following someone: their own shortest way to a free square close to the leader (next
 * to them if there's room, else within two or three), not the leader's footprints. Returns up to
 * `steps` squares, or [] when they're already close or can't get closer.
 */
export function followSteps(place, floorId, from, leader, { taken = new Set(), steps = 1, avoid = [] } = {}) {
    const dist = (x, y) => Math.max(Math.abs(x - leader.x), Math.abs(y - leader.y));
    const blocked = new Set([...taken, `${leader.x},${leader.y}`]);
    const careful = new Set([...blocked, ...avoid]);
    // Room next to the player first (then within two, three when it's crowded); at each distance, a
    // way around their known traps if there is one.
    for (const near of [1, 2, 3]) {
        if (dist(from.x, from.y) <= near) return [];
        for (const set of avoid.length ? [careful, blocked] : [blocked]) {
            const isGoal = (x, y) => dist(x, y) <= near && !set.has(`${x},${y}`) && !stairsAt(place, floorId, x, y);
            const path = findPath(place, floorId, from, leader, { knownOnly: false, blocked: set, isGoal });
            if (path?.length) return path.slice(0, steps);
        }
    }
    return [];
}

// ---------- hiding ----------

/**
 * How `name` is hidden right now ({prop, mode, what}), or null. Checked against where they stand:
 * inside or under a thing means on its square, behind it means right beside it. So it's never stale
 * (walked off, moved by the DM, carried away).
 */
export function hiddenNow(place, name) {
    const h = place.state.hidden?.[name];
    const pos = place.state.positions[name];
    if (!h || !pos) return null;
    const prop = (floorById(place, pos.floor).map.props || []).find(p => p.id === h.prop);
    if (!prop) return null;
    const w = prop.w || 1, ht = prop.h || 1;
    const on = pos.x >= prop.x && pos.x < prop.x + w && pos.y >= prop.y && pos.y < prop.y + ht;
    const beside = pos.x >= prop.x - 1 && pos.x <= prop.x + w && pos.y >= prop.y - 1 && pos.y <= prop.y + ht;
    if (h.mode === 'behind' ? !beside : !on) return null;
    return { ...h, what: prop.label || PROPS[prop.type]?.name || prop.type };
}

// ---------- sitting and lying down ----------

const covers = (p, x, y) => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);

/**
 * How `name` is resting right now ({prop, pose: 'sit'|'lie'|'sleep', what, type, side}), or null.
 * Only while they're still on the thing (walking off, or being moved, ends it).
 */
export function poseNow(place, name) {
    const s = place.state.pose?.[name];
    const pos = place.state.positions[name];
    if (!s || !pos) return null;
    const prop = (floorById(place, pos.floor).map.props || []).find(p => p.id === s.prop);
    if (!prop || !covers(prop, pos.x, pos.y)) return null;
    return { ...s, what: prop.label || PROPS[prop.type]?.name || prop.type, type: prop.type, side: prop.side || 'n' };
}

/**
 * `name` sits on, lies down on or goes to sleep on a thing on their floor (onto one of its squares
 * nobody else is on). how = 'sit' | 'lie' | 'sleep' (a bed can be sat on too). Returns {pose, what} or null.
 */
export function restOn(place, name, propId, how = '') {
    const pos = place.state.positions[name];
    const prop = pos && (floorById(place, pos.floor).map.props || []).find(p => p.id === propId);
    const kind = prop && SEATS[prop.type];
    if (!kind) return null;
    const pose = how === 'sleep' ? 'sleep' : how === 'sit' || kind === 'sit' ? 'sit' : 'lie';
    const others = new Set(Object.entries(place.state.positions).filter(([n, p]) => n !== name && p.floor === pos.floor).map(([, p]) => `${p.x},${p.y}`));
    let spot = null;
    for (let y = prop.y; y < prop.y + (prop.h || 1) && !spot; y++) for (let x = prop.x; x < prop.x + (prop.w || 1) && !spot; x++) if (!others.has(`${x},${y}`)) spot = { x, y };
    if (!spot) return null;
    Object.assign(pos, spot);
    if (place.state.hidden?.[name]) delete place.state.hidden[name];
    place.state.pose ??= {};
    place.state.pose[name] = { prop: prop.id, pose, at: Date.now() };
    return { pose, what: prop.label || PROPS[prop.type]?.name || prop.type };
}

/** Get up (walking anywhere does this too). */
export function standUp(place, name) {
    if (place.state.pose?.[name]) delete place.state.pose[name];
}

/**
 * `name` hides in, under or behind a thing on their floor. Inside or underneath, they move onto its
 * square; behind it, they crouch beside it. Returns {mode, what}, or null if it can't hide anyone.
 */
export function hideIn(place, name, propId) {
    const pos = place.state.positions[name];
    const prop = pos && (floorById(place, pos.floor).map.props || []).find(p => p.id === propId);
    const mode = prop && HIDE[prop.type];
    if (!mode) return null;
    const w = prop.w || 1, ht = prop.h || 1;
    if (mode !== 'behind') Object.assign(pos, { x: prop.x, y: prop.y });
    else if (!(pos.x >= prop.x - 1 && pos.x <= prop.x + w && pos.y >= prop.y - 1 && pos.y <= prop.y + ht)) Object.assign(pos, freeNear(place, pos.floor, prop.x, prop.y));
    place.state.hidden ??= {};
    place.state.hidden[name] = { prop: prop.id, mode, at: Date.now() };
    if (place.state.pose?.[name]) delete place.state.pose[name];
    return { mode, what: prop.label || PROPS[prop.type]?.name || prop.type };
}

/** A free square next to (x, y) for a companion to stand on. */
export function freeNear(place, floorId, x, y, taken = new Set()) {
    for (let d = 1; d <= 3; d++) {
        for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
            const nx = x + dx, ny = y + dy;
            const ch = terrainAt(floorById(place, floorId).map, nx, ny);
            if (walkable(place, floorId, nx, ny) && ch !== '+' && !stairsAt(place, floorId, nx, ny) && !taken.has(`${nx},${ny}`)) return { x: nx, y: ny };
        }
    }
    return { x, y };
}

// ---------- changes ----------

function bump(place, floorId) {
    const map = floorById(place, floorId).map;
    map.version = (map.version || 0) + 1;
}

export function setDoorState(place, door, state) {
    door.state = state;
    const map = floorById(place, door.floor).map;
    const rows = map.rows.map(r => r.split(''));
    rows[map.h - 1 - door.y][door.x] = doorChar(door);
    map.rows = rows.map(r => r.join(''));
    bump(place, door.floor);
}

function findByIdOrName(list, key) {
    return list[key] ?? Object.values(list).find(x => nameKey(x.name) === nameKey(key) || nameKey(x.kind) === nameKey(key)) ?? null;
}

/**
 * Apply the DM's changes to a place. Returns plain lines for the turn's status ("D4 is open").
 * changes: {doors: {D4: "open"}, traps: {T2: "found"}, items: {I3: "taken"}, guards: {"Graves": "G4" | "ab14" | "gone" | "alert"},
 *           rooms: {G4: {lit: true}}, reveal: ["G7"]}
 * floor: the party's floor (squares like "ab14" are on it)
 */
export function applyPlaceChanges(place, changes, { floor = place.state?.floor } = {}) {
    const log = [];
    const c = changes && typeof changes === 'object' ? changes : {};
    for (const [id, raw] of Object.entries(c.doors || {})) {
        const door = place.doors[id] ?? Object.values(place.doors).find(d => d.id.toLowerCase() === String(id).toLowerCase());
        if (!door) continue;
        const want = String(raw).toLowerCase();
        const state = { open: 'open', opened: 'open', unlocked: 'closed', closed: 'closed', close: 'closed', locked: 'locked', lock: 'locked', broken: 'broken', break: 'broken', found: 'closed', revealed: 'closed', hidden: 'hidden', walled: 'walled', bricked: 'walled' }[want];
        if (!state) continue;
        if (want === 'found' && door.state !== 'hidden') continue;
        setDoorState(place, door, state);
        log.push(`${door.id} ${want}`);
    }
    for (const [id, raw] of Object.entries(c.traps || {})) {
        const trap = findByIdOrName(place.traps, id);
        if (!trap) continue;
        const state = { found: 'found', spotted: 'found', disarmed: 'disarmed', sprung: 'sprung', triggered: 'sprung' }[String(raw).toLowerCase()];
        if (!state) continue;
        // The DM revealing a trap in the story: the party all hear about it.
        if (state === 'found' && trap.state === 'hidden') trap.knownBy = ['*'];
        trap.state = state;
        const prop = floorById(place, trap.floor).map.props.find(p => p.trap === trap.id);
        if (prop) prop.hidden = state === 'disarmed';
        bump(place, trap.floor);
        log.push(`${trap.kind} ${state}`);
    }
    for (const [id, raw] of Object.entries(c.items || {})) {
        const item = findByIdOrName(place.items, id);
        if (!item) continue;
        const v = String(raw);
        if (/^(taken|picked|carried|gone)/i.test(v)) item.state = 'taken';
        else if (/^(found|revealed|spotted)/i.test(v)) { item.hidden = false; item.found = true; }
        else if (place.rooms[v]) { item.room = v; item.floor = place.rooms[v].floor; item.state = 'here'; }
        log.push(`${item.name}: ${v}`);
    }
    for (const [name, raw] of Object.entries(c.guards || {})) {
        let g = personByName(place, name);
        // Someone new on the map, or moved: {"at": "ab14" | "room": "G5", "description": "the cook", "hostile": false}.
        if (raw && typeof raw === 'object') {
            const where = raw.at ?? raw.square ?? raw.room ?? (g ? { floor: g.floor, x: g.x, y: g.y } : null);
            const info = { description: raw.description, hostile: raw.hostile === true };
            g = where ? placePerson(place, name, where, { floor, info, arrive: true }) : null;
            if (!g) { log.push(`couldn't place ${name} (no square or room given)`); continue; }
            if (raw.description) g.description = String(raw.description).slice(0, 240);
            if (typeof raw.hostile === 'boolean') g.hostile = raw.hostile;
            if (Array.isArray(raw.patrol)) g.patrol = raw.patrol.map(id => findRoom(place, id)?.id).filter(Boolean);
            if (!g.patrol.length && g.room) g.patrol = [g.room];
            g.state = raw.state === 'alert' ? 'alert' : 'patrol';
            setIntent(g, raw.intent, raw.target);
            log.push(`${g.name} at ${coord(g.x, g.y)}${g.intent ? ` (${g.intent}${g.target ? ` ${g.target}` : ''})` : ''}`);
            continue;
        }
        const v = String(raw);
        if (/^(gone|dead|left|removed)$/i.test(v)) { if (g) g.state = 'gone'; }
        else if (/^(alert)$/i.test(v)) { if (g) g.state = 'alert'; }
        else if (/^(hunting|chasing|attacking|attack)$/i.test(v)) { if (g) { g.state = 'alert'; setIntent(g, 'attack'); } }
        else if (/^(fleeing|flee|running|runs away)$/i.test(v)) { if (g) setIntent(g, 'flee'); }
        else if (/^(following|follow)$/i.test(v)) { if (g) setIntent(g, 'follow'); }
        else if (/^(calm|patrol|patrolling|stay|staying)$/i.test(v)) { if (g) { g.state = 'patrol'; setIntent(g, /^stay/i.test(v) ? 'stay' : ''); } }
        else {
            // A square or a room: move them there (someone new appears there).
            g = placePerson(place, name, v, { floor, arrive: true });
            if (!g) { log.push(`couldn't place ${name} at ${v}`); continue; }
        }
        if (g) log.push(`${g.name}: ${v}`);
    }
    for (const [id, v] of Object.entries(c.rooms || {})) {
        const rm = place.rooms[id];
        if (!rm || !v || typeof v !== 'object') continue;
        if (typeof v.lit === 'boolean') {
            rm.lit = v.lit;
            const area = floorById(place, rm.floor).map.areas?.find(a => a.room === id);
            if (area) area.lit = v.lit;
            bump(place, rm.floor);
        }
    }
    if (Array.isArray(c.reveal) && c.reveal.length) { revealRooms(place, c.reveal.map(String)); log.push(`revealed ${c.reveal.join(', ')}`); }
    ensureIds(place);
    // Things on the map: smashed, removed, moved.
    for (const [id, raw] of Object.entries(c.props || {})) {
        const found = propById(place, id);
        if (!found) continue;
        const v = raw && typeof raw === 'object' ? raw : { state: String(raw) };
        const st = String(v.state || '').toLowerCase();
        if (/^(broken|smashed|destroyed|debris)$/.test(st)) { const name = found.prop.label || PROPS[found.prop.type]?.name || id; smashProp(place, id); log.push(`${name} smashed`); continue; }
        if (/^(removed|gone|taken)$/.test(st)) { const map = floorById(place, found.floor).map; map.props = map.props.filter(p => p !== found.prop); bump(place, found.floor); log.push(`${id} removed`); continue; }
        const to = v.move ?? v.to ?? (/^[nsew]$/.test(st) ? st : null);
        if (to) { const r = moveProp(place, id, to, { force: true }); log.push(r.ok ? `${id} moved` : `${id} couldn't move: ${r.why}`); }
        if (typeof v.obstacle === 'boolean') found.prop.obstacle = v.obstacle;
    }
    // New traps the DM sets: real traps (they go off when stepped on), not just a picture.
    // add_props with type "trap" counts too.
    const newTraps = [...(Array.isArray(c.add_traps) ? c.add_traps : []), ...(Array.isArray(c.add_props) ? c.add_props : []).filter(a => /^trap$/i.test(String(a?.type || '').trim()))];
    for (const a of newTraps) {
        const floorId = a?.floor && place.floors.some(f => f.id === a.floor) ? a.floor : place.state.floor;
        const at = parseCoord(a?.at, floorById(place, floorId).map);
        if (!at) continue;
        const t = addTrap(place, floorId, at.x, at.y, { kind: a.kind || a.label || a.name, dc: a.dc, save: a.save, effect: a.effect, hidden: a.hidden === true || a.hidden === 'true' });
        log.push(`${t.kind} (${t.id}) set at ${a.at}${t.state === 'hidden' ? ', hidden' : ''}`);
    }
    // New things the DM puts on the map (a barricade, bars, a cave-in...). On purpose, so they may block a door.
    for (const a of Array.isArray(c.add_props) ? c.add_props : []) {
        const type = String(a?.type || '').toLowerCase().replace(/[\s-]+/g, '_');
        if (type === 'trap') continue;
        const floorId = a?.floor && place.floors.some(f => f.id === a.floor) ? a.floor : place.state.floor;
        const map = floorById(place, floorId).map;
        const at = parseCoord(a?.at, map);
        if (!PROPS[type] || !at) continue;
        const prop = { x: at.x, y: at.y, type, obstacle: a.obstacle !== false && PROPS[type].blocks, ...(a.label ? { label: String(a.label).slice(0, 40) } : {}) };
        if (Number(a.w) > 1) prop.w = Math.min(8, Math.round(Number(a.w)));
        if (Number(a.h) > 1) prop.h = Math.min(8, Math.round(Number(a.h)));
        map.props.push(prop);
        ensureIds(place);
        bump(place, floorId);
        log.push(`${type} added at ${a.at}`);
    }
    // Hiding: {"Amber": "p12"} hides them in/under/behind that thing; "out" brings them out.
    for (const [who, raw] of Object.entries(c.hide || {})) {
        const name = matchName(who, Object.keys(place.state.positions));
        if (!name) continue;
        if (/^(out|none|no|false|leave|left)$/i.test(String(raw).trim())) {
            if (place.state.hidden?.[name]) { delete place.state.hidden[name]; log.push(`${name} out of hiding`); }
            continue;
        }
        const pos = place.state.positions[name];
        const map = floorById(place, pos.floor).map;
        const want = String(raw).trim().toLowerCase();
        const prop = (map.props || []).find(p => String(p.id).toLowerCase() === want) ?? (map.props || []).filter(p => HIDE[p.type] && (p.label || PROPS[p.type]?.name || p.type).toLowerCase().includes(want)).sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y))[0];
        const r = prop && hideIn(place, name, prop.id);
        if (r) { bump(place, pos.floor); log.push(`${name} hides ${r.mode} the ${r.what}`); }
    }
    // Free from a trap: ["Amber"] or "all".
    for (const who of c.free === 'all' ? Object.keys(place.state.caught || {}) : Array.isArray(c.free) ? c.free : c.free ? [c.free] : []) {
        const name = matchName(String(who), Object.keys(place.state.caught || {}));
        if (name && release(place, name)) log.push(`${name} is free of the trap`);
    }
    // Sitting and lying: {"Judy Hopps": "sleep p7" | "sit armchair" | "lie bed" | "stand"}.
    for (const [who, raw] of Object.entries(c.pose || {})) {
        const name = matchName(who, Object.keys(place.state.positions));
        if (!name) continue;
        const [verb, ...rest] = String(raw).trim().toLowerCase().split(/\s+/);
        if (/^(stand|up|none|out|get)/.test(verb)) { if (place.state.pose?.[name]) { standUp(place, name); log.push(`${name} stands up`); } continue; }
        const how = ['sit', 'lie', 'sleep'].includes(verb) ? verb : '';
        const want = (how ? rest : [verb, ...rest]).join(' ');
        const pos = place.state.positions[name];
        const props = floorById(place, pos.floor).map.props || [];
        const prop = props.find(p => String(p.id).toLowerCase() === want) ?? props.filter(p => SEATS[p.type] && (p.label || PROPS[p.type]?.name || p.type).toLowerCase().includes(want || (how === 'sit' ? 'chair' : 'bed'))).sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y))[0];
        const r = prop && restOn(place, name, prop.id, how);
        if (r) { bump(place, pos.floor); log.push(`${name} ${r.pose === 'sit' ? 'sits on' : r.pose === 'sleep' ? 'sleeps on' : 'lies on'} the ${r.what}`); }
    }
    // Windows: by id, by room, or all of them ("all": "barred").
    for (const [key, raw] of Object.entries(c.windows || {})) {
        const state = { barred: 'barred', bars: 'barred', broken: 'broken', smashed: 'broken', intact: 'intact', fixed: 'intact', repaired: 'intact', unbarred: 'intact' }[String(raw).toLowerCase()];
        if (!state) continue;
        const all = Object.values(place.windows || {});
        const rm = place.rooms[key];
        const hits = key === 'all' ? all : rm ? all.filter(w => w.floor === rm.floor && w.x >= rm.rect.x - 1 && w.x <= rm.rect.x + rm.rect.w && w.y >= rm.rect.y - 1 && w.y <= rm.rect.y + rm.rect.h) : all.filter(w => w.id.toLowerCase() === key.toLowerCase());
        for (const w of hits) setWindowState(place, w, state);
        if (hits.length) log.push(`${key === 'all' ? 'every window' : key} ${state}`);
    }
    return log;
}

// ---------- things on the map: smash, push, windows ----------

export function propById(place, id) {
    for (const f of place.floors) {
        const prop = f.map.props.find(p => p.id === id);
        if (prop) return { prop, floor: f.id };
    }
    return null;
}

/** Smashed: the thing becomes broken pieces on the floor that anyone can walk over. */
export function smashProp(place, id) {
    const found = propById(place, id);
    if (!found) return false;
    const p = found.prop;
    p.was = p.was || p.type;
    p.label = `broken ${p.label || PROPS[p.type]?.name || p.type}`;
    p.type = 'debris';
    delete p.obstacle;
    delete p.side;
    bump(place, found.floor);
    return true;
}

const DIR = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] };

/** Is this light enough to shove without a roll? */
export function isLight(prop) {
    return PROPS[prop.type]?.blocks && !HEAVY.has(prop.type) && (prop.w || 1) * (prop.h || 1) <= 2;
}

/**
 * Push something one square (n/s/e/w) or move it to a square ("ab14"). It can go onto open floor or
 * into a doorway (that's a barricade: the door is blocked until it's moved away), not into walls,
 * other furniture or people. force = the DM moves it (any size).
 * @returns {{ok:boolean, why?:string}}
 */
export function moveProp(place, id, to, { force = false, people = [] } = {}) {
    const found = propById(place, id);
    if (!found) return { ok: false, why: 'not found' };
    const { prop, floor } = found;
    const map = floorById(place, floor).map;
    let nx, ny;
    if (DIR[to]) { nx = prop.x + DIR[to][0]; ny = prop.y + DIR[to][1]; }
    else { const pt = parseCoord(to, map); if (!pt) return { ok: false, why: 'no such square' }; nx = pt.x; ny = pt.y; }
    if (!force && !isLight(prop)) return { ok: false, why: 'too heavy to shove without a roll' };
    const w = prop.w || 1, h = prop.h || 1;
    let door = null;
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) {
        const x = nx + i, y = ny + j;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) return { ok: false, why: 'off the map' };
        const ch = terrainAt(map, x, y);
        if (ch === '+' || ch === '/') door = doorAt(place, floor, x, y);
        else if (TERRAIN[ch]?.walk === false || ch === '<' || ch === '>') return { ok: false, why: 'something is in the way' };
        if (map.props.some(p => p !== prop && PROPS[p.type]?.blocks && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1))) return { ok: false, why: 'something is in the way' };
        if (people.some(pp => pp.floor === floor && pp.x === x && pp.y === y)) return { ok: false, why: 'someone is standing there' };
    }
    prop.x = nx; prop.y = ny;
    // Shoved into a doorway: a barricade, there on purpose.
    prop.obstacle = Boolean(door) || undefined;
    if (door) prop.barricades = door.id; else delete prop.barricades;
    bump(place, floor);
    return { ok: true, door: door?.id };
}

export function windowAt(place, floorId, x, y) {
    return Object.values(place.windows || {}).find(w => w.floor === floorId && w.x === x && w.y === y) ?? null;
}

export function setWindowState(place, win, state) {
    win.state = state;
    const map = floorById(place, win.floor).map;
    const rows = map.rows.map(r => r.split(''));
    rows[map.h - 1 - win.y][win.x] = state === 'barred' ? 'H' : state === 'broken' ? 'U' : '|';
    map.rows = rows.map(r => r.join(''));
    bump(place, win.floor);
}

// ---------- guards ----------

function freeInRoom(place, rm, r = Math.random) {
    const map = floorById(place, rm.floor).map;
    const tiles = [];
    for (let x = rm.rect.x; x < rm.rect.x + rm.rect.w; x++) for (let y = rm.rect.y; y < rm.rect.y + rm.rect.h; y++) if (walkable(place, rm.floor, x, y) && terrainAt(map, x, y) === '.') tiles.push({ x, y });
    return tiles.length ? tiles[Math.floor(r() * tiles.length)] : { x: rm.rect.x, y: rm.rect.y };
}

export function moveGuardTo(place, g, roomId, r = Math.random) {
    const rm = place.rooms[roomId];
    if (!rm) return;
    const at = freeInRoom(place, rm, r);
    Object.assign(g, { room: roomId, floor: rm.floor, x: at.x, y: at.y });
}

/** The nearest square someone can stand on, spiralling out from (x, y); null if none within reach. */
export function openSquareNear(place, floorId, x, y, taken = new Set(), reach = 8) {
    const map = floorById(place, floorId).map;
    const cx = Math.min(map.w - 1, Math.max(0, x)), cy = Math.min(map.h - 1, Math.max(0, y));
    for (let d = 0; d <= reach; d++) {
        for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
            const nx = cx + dx, ny = cy + dy;
            if (walkable(place, floorId, nx, ny) && !taken.has(`${nx},${ny}`)) return { x: nx, y: ny };
        }
    }
    return null;
}

/** A room by its id ("G5") or its name ("the kitchen"). */
export function findRoom(place, ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return place.rooms[s] ?? Object.values(place.rooms).find(r => r.id.toLowerCase() === s.toLowerCase() || nameKey(r.name || '') === nameKey(s.replace(/^the\s+/i, ''))) ?? null;
}

/** Words that name a thing, not a someone: items, furniture, food, light. */
const THING_WORDS = new RegExp(`\\b(${[...new Set([...Object.values(PROPS).map(p => p.name), ...Object.keys(PROPS)].flatMap(n => String(n).toLowerCase().split(/[^a-z]+/)).filter(w => w.length > 2 && !['the', 'and', 'wall', 'known', 'great', 'old', 'fallen'].includes(w))), 'tin', 'oil', 'lamp', 'lantern', 'key', 'keys', 'bottle', 'flask', 'vial', 'potion', 'scroll', 'book', 'books', 'coin', 'coins', 'gold', 'sword', 'dagger', 'bow', 'arrow', 'arrows', 'shield', 'bag', 'pouch', 'box', 'ring', 'amulet', 'necklace', 'letter', 'note', 'notes', 'map', 'rope', 'torch', 'candle', 'bread', 'food', 'meat', 'cheese', 'apple', 'wine', 'ale', 'water', 'gem', 'gems', 'jewel', 'jewels', 'ledger', 'journal', 'diary', 'lockpick', 'lockpicks', 'tools', 'kit', 'cloak', 'boots', 'gloves', 'hat', 'coat', 'armor', 'armour', 'helmet', 'blanket', 'pillow', 'plate', 'cup', 'mug', 'bucket', 'shovel', 'pick', 'hammer', 'nails', 'chain', 'chains', 'lock', 'door', 'window', 'floor', 'stairs', 'wall', 'item', 'items', 'thing', 'things', 'supplies', 'rations', 'tinderbox', 'matches', 'crowbar', 'mirror'].join('|')})\\b`, 'i');
/** Creature words that win over a thing word ("guard dog", "rat in a barrel"). */
const BEING_WORDS = /\b(man|woman|men|women|boy|girl|child|guard|guards|soldier|knight|captain|warden|jailer|butler|maid|servant|cook|priest|monk|nun|thief|bandit|cultist|merchant|keeper|lord|lady|king|queen|prince|princess|old|young|dog|hound|wolf|rat|rats|cat|bear|spider|snake|bat|bats|goblin|orc|troll|ogre|skeleton|zombie|ghoul|ghost|wraith|vampire|demon|devil|dragon|beast|creature|monster|golem|elemental|slime|ooze|horse|crow|raven|boar|guardian|sentry|watchman|prisoner|stranger|figure|master|mistress|sergeant|brother|sister|father|mother|smith|innkeeper|owner|hunter|farmer|apprentice|scholar|wizard|witch|mage|sorcerer|cleric|paladin|ranger|rogue|bard|druid|healer|doctor|nurse|steward|chamberlain|noble|baron|duke|count|countess|page|squire|executioner|torturer|inquisitor|assassin|spy|mercenary|pirate|sailor|baby|twin|handler|turnkey|gaoler|dwarf|elf|halfling|gnome|human|hag|imp|kobold|gnoll|minotaur|harpy|wyvern|basilisk|mimic|specter|spectre|lich|mummy|banshee|shade|mastiff|stray|mutt|puppy|kitten|owl|hawk|eagle|toad|frog|crocodile|shark)\b/i;

/** Does a name look like an object (a tin of lamp oil, a ledger) rather than a person or creature? */
export function looksLikeThing(name) {
    const s = String(name || '').trim();
    if (!s) return true;
    if (BEING_WORDS.test(s)) return false;
    // A name with a thing word in it and no creature word: an object (a proper name like "Graves" has neither).
    return THING_WORDS.test(s);
}

/** Find someone among a place's people by name. */
export function personByName(place, name) {
    return place.guards[name] ?? Object.values(place.guards).find(g => nameKey(g.name) === nameKey(name)) ?? null;
}

/**
 * Put someone on a place's map, or move them: to a square ("ab14", on `floor`), a room ("G5" or its
 * name), or {floor, x, y}. A blocked square becomes the nearest open one. Anyone new becomes one of
 * the place's people (drawn on the map, listed for the DM) with `info` ({description, hostile}).
 * @returns the person, or null if `where` isn't a square or room of this place
 */
export function placePerson(place, name, where, { floor = place.state?.floor, info = {}, taken = null, arrive = false } = {}) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return null;
    // Only people and creatures stand on the map: an item named here ("Tin of lamp oil") is not someone.
    if (!personByName(place, clean) && looksLikeThing(clean)) return null;
    // Squares other people already stand on (party and the place's people), unless told otherwise.
    const busy = f => taken ?? new Set([...Object.entries(place.state?.positions || {}).map(([, p]) => p), ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.state !== 'dead' && nameKey(g.name) !== nameKey(clean))].filter(p => p && p.floor === f).map(p => `${p.x},${p.y}`));
    let spot = null, floorId = floor ?? place.floors[0].id;
    if (where && typeof where === 'object' && Number.isFinite(where.x)) {
        floorId = where.floor ?? floorId;
        spot = openSquareNear(place, floorId, where.x, where.y, busy(floorId));
    } else {
        // Room ids ("G4") look like squares: an exact room id wins, then a square ("ab14"), then a room name.
        const exact = place.rooms[String(where ?? '').trim()];
        const pt = exact ? null : parseCoord(where, floorById(place, floorId).map);
        if (pt) spot = openSquareNear(place, floorId, pt.x, pt.y, busy(floorId));
        else {
            const rm = exact ?? findRoom(place, where);
            if (!rm) return null;
            floorId = rm.floor;
            spot = freeInRoom(place, rm);
        }
    }
    if (!spot) return null;
    let g = personByName(place, clean);
    // Someone new never pops up in plain sight of the party: they come in through the nearest door,
    // stairs or way in the party can't see, and walk to where they were meant to be.
    let goal = null;
    if (arrive && (!g || g.state === 'gone')) {
        const door = arrivalSpot(place, floorId, spot, busy(floorId));
        if (door) { goal = spot; spot = door; }
    }
    const room = roomAt(place, floorId, spot.x, spot.y)?.id ?? null;
    if (!g) {
        g = place.guards[clean] = { name: clean, description: String(info.description || '').slice(0, 240), hostile: info.hostile === true, room, patrol: room ? [room] : [], step: 0, floor: floorId, x: spot.x, y: spot.y, state: 'patrol' };
        if (info.gender === 'male' || info.gender === 'female') g.gender = info.gender;
    }
    Object.assign(g, { floor: floorId, x: spot.x, y: spot.y, room: room ?? g.room ?? null });
    if (goal) { g.goal = { x: goal.x, y: goal.y }; if (!g.intent) g.intent = 'goto'; }
    if (g.state === 'gone') g.state = 'patrol';
    return g;
}

/**
 * Where someone new comes in from, if where they're meant to be is in sight of the party (or right
 * next to them): the nearest door, staircase or way out on that floor that nobody in the party can
 * see, preferring one they can walk from to the spot. Null when the spot is already out of sight.
 */
export function arrivalSpot(place, floorId, spot, taken = new Set()) {
    const viewers = Object.values(place.state?.positions || {}).filter(p => p && p.floor === floorId);
    if (!viewers.length) return null;
    const map = floorById(place, floorId).map;
    const seen = computeVisible(place, floorId, viewers);
    const inSight = (x, y) => seen[y * map.w + x] || viewers.some(v => Math.max(Math.abs(v.x - x), Math.abs(v.y - y)) <= 4);
    if (!inSight(spot.x, spot.y)) return null;
    const all = [
        ...Object.values(place.doors || {}).filter(d => d.floor === floorId && d.state !== 'hidden' && d.state !== 'walled').map(d => ({ x: d.x, y: d.y })),
        ...(place.stairs || []).flatMap(s => [s.a, s.b]).filter(e => e.floor === floorId),
        ...(place.exits || []).filter(e => e.floor === floorId),
    ];
    const dist = w => Math.abs(w.x - spot.x) + Math.abs(w.y - spot.y);
    for (const w of all.filter(w => !inSight(w.x, w.y)).sort((a, b) => dist(a) - dist(b))) {
        const at = openSquareNear(place, floorId, w.x, w.y, taken, 2);
        if (at && !inSight(at.x, at.y)) return at;
    }
    // Every way in is in plain sight (one lit hall): they walk in through the one farthest from the party.
    const gap = w => Math.min(...viewers.map(v => Math.max(Math.abs(v.x - w.x), Math.abs(v.y - w.y))));
    const far = all.filter(w => gap(w) > 3).sort((a, b) => gap(b) - gap(a))[0];
    return far ? openSquareNear(place, floorId, far.x, far.y, taken, 2) : null;
}

/**
 * Anyone other than the party who ended up in the party's own position list (older versions put
 * NPCs there; the map never drew them) becomes one of the place's people. Returns how many moved.
 */
export function adoptStrays(place, partyNames) {
    const party = new Set(partyNames.map(nameKey));
    let n = 0;
    for (const [name, p] of Object.entries(place.state?.positions || {})) {
        if (party.has(nameKey(name))) continue;
        delete place.state.positions[name];
        if (p && Number.isFinite(p.x) && !personByName(place, name)) placePerson(place, name, p);
        n++;
    }
    return n;
}

/** Guards on patrol walk to their next room now and then. Returns who moved where. */
export function tickGuards(place, r = Math.random, chance = 0.5) {
    const moved = [];
    for (const g of Object.values(place.guards)) {
        if (g.state === 'gone' || g.state === 'dead' || g.patrol.length < 2 || (g.intent && g.intent !== 'wander') || r() > chance) continue;
        g.step = ((g.step ?? 0) + 1) % g.patrol.length;
        moveGuardTo(place, g, g.patrol[g.step], r);
        moved.push({ name: g.name, room: g.room });
    }
    return moved;
}

/** Guards the party can see right now. */
export function visibleGuards(place, floorId, visible) {
    const map = floorById(place, floorId).map;
    return Object.values(place.guards).filter(g => g.state !== 'gone' && g.state !== 'dead' && g.floor === floorId && visible[g.y * map.w + g.x]);
}

/** What people on the map can be set on doing, besides standing about or walking their rounds. */
export const INTENTS = ['attack', 'follow', 'flee', 'stay', 'wander'];

/** Set what someone is set on doing (and who at); "" or junk clears it. */
export function setIntent(g, intent, target = '') {
    const want = String(intent ?? '').toLowerCase().trim();
    if (want === '' || !INTENTS.includes(want)) { if (intent !== undefined && want === '') { delete g.intent; delete g.target; } return; }
    g.intent = want;
    if (want === 'attack') { g.hostile = true; g.state = 'alert'; }
    if (target) g.target = String(target).slice(0, 60); else if (want !== 'attack' && want !== 'follow') delete g.target;
}

/**
 * People with somewhere to be take up to `steps` steps: hunters (intent "attack") and hangers-on
 * ("follow") close in on whoever they're after (the nearest of the party if nobody in particular),
 * the frightened ("flee") get away from the party. Doors on the way open. A hunter who reaches
 * their quarry strikes once (they're "engaged" until the next turn clears it).
 * Returns [{name, target}] for each hunter who just reached someone.
 */
export function moveHunters(place, floorId, partyNames, steps = 1) {
    const struck = [];
    const party = partyNames.filter(n => place.state.positions[n]?.floor === floorId);
    if (!party.length) return struck;
    const busy = except => new Set([
        ...party.filter(n => n !== except).map(n => `${place.state.positions[n].x},${place.state.positions[n].y}`),
        ...Object.values(place.guards).filter(o => o.state !== 'gone' && o.state !== 'dead' && o.floor === floorId && o.name !== except).map(o => `${o.x},${o.y}`),
    ]);
    const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    for (const g of Object.values(place.guards)) {
        if (g.state === 'gone' || g.state === 'dead' || g.floor !== floorId) continue;
        // On their way in to where they were meant to be (they came in through a door out of sight).
        if (g.intent === 'goto' && g.goal) {
            const path = findPath(place, floorId, g, g.goal, { knownOnly: false, blocked: busy(g.name), isGoal: (x, y) => Math.max(Math.abs(x - g.goal.x), Math.abs(y - g.goal.y)) <= 1 });
            for (const [x, y] of (path || []).slice(0, steps)) { const d = doorAt(place, floorId, x, y); if (d && d.state === 'closed') setDoorState(place, d, 'open'); Object.assign(g, { x, y }); }
            if (!path || Math.max(Math.abs(g.x - g.goal.x), Math.abs(g.y - g.goal.y)) <= 1) { delete g.goal; delete g.intent; }
            g.room = roomAt(place, floorId, g.x, g.y)?.id ?? g.room;
            continue;
        }
        if (!['attack', 'follow', 'flee'].includes(g.intent)) continue;
        const named = g.target && party.find(n => nameKey(n) === nameKey(g.target));
        const quarry = named ?? [...party].sort((a, b) => dist(g, place.state.positions[a]) - dist(g, place.state.positions[b]))[0];
        const q = place.state.positions[quarry];
        if (g.intent === 'flee') {
            for (let i = 0; i < steps; i++) {
                const taken = busy(g.name);
                const away = (x, y) => Math.min(...party.map(n => dist({ x, y }, place.state.positions[n])));
                let best = null;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                    const nx = g.x + dx, ny = g.y + dy;
                    if (!walkable(place, floorId, nx, ny) || taken.has(`${nx},${ny}`) || stairsAt(place, floorId, nx, ny)) continue;
                    if (away(nx, ny) > away(g.x, g.y) && (!best || away(nx, ny) > away(best.x, best.y))) best = { x: nx, y: ny };
                }
                if (!best) break;
                Object.assign(g, best);
            }
        } else {
            const path = followSteps(place, floorId, g, q, { taken: busy(g.name), steps });
            for (const [x, y] of path) {
                const d = doorAt(place, floorId, x, y);
                if (d && d.state === 'closed') setDoorState(place, d, 'open');
                Object.assign(g, { x, y });
            }
            if (g.intent === 'attack' && dist(g, q) <= 1 && !g.engaged) {
                g.engaged = true;
                struck.push({ name: g.name, target: quarry });
            }
        }
        g.room = roomAt(place, floorId, g.x, g.y)?.id ?? g.room;
    }
    return struck;
}

/** Someone died on the map: their body stays where they fell for a few turns. */
export function killPerson(place, name, turn) {
    const g = personByName(place, name);
    if (!g || g.state === 'gone') return null;
    Object.assign(g, { state: 'dead', deadTurn: turn });
    delete g.intent; delete g.target; delete g.engaged;
    return g;
}

/** Bodies that have lain there `turns` turns are cleared away. Returns how many went. */
export function clearBodies(place, turn, turns = 3) {
    let n = 0;
    for (const g of Object.values(place.guards || {})) if (g.state === 'dead' && turn - (g.deadTurn ?? turn) >= turns) { g.state = 'gone'; n++; }
    return n;
}

/** A new turn: hunters who struck may strike again (if their quarry is still in reach after it). */
export function clearEngaged(place) {
    for (const g of Object.values(place.guards || {})) delete g.engaged;
}

// ---------- someone taken away, inside this place ----------

/** Where a captive is likely kept, best first. */
const HOLDS = ['cell', 'kennel', 'torture_chamber', 'vault', 'storage', 'cellar', 'crypt', 'cave', 'attic', 'room'];
const ELSEWHERE = /\b(outside|in town|the town|village|camp\b|the road|forest|woods|treeline|back home|went home|left the|another place|far away|miles)\b/i;
const INSIDE = /\b(here|inside|somewhere in|deeper|further in|below|down in|upstairs|cell|cage|caged|kennel|dungeon|cellar|crypt|prison|jail|locked (?:up|away|in)|captive|held|imprisoned|chained|taken (?:away|deeper|below))\b/i;

/**
 * A companion the DM split off ("caged somewhere in the dungeon"): are they inside this place, and
 * where? A room the words name; else, if they're held here, the likeliest room for a captive that the
 * party hasn't been in, as far from the player as possible. Returns {roomId, caged} or null when the
 * words put them somewhere else (outside, back in town) or nowhere in particular.
 */
export function heldRoom(place, where, from = null) {
    const text = String(where || '');
    const words = nameKey(text);
    if (!words) return null;
    const named = Object.values(place.rooms).filter(r => r.name && words.includes(nameKey(r.name))).sort((a, b) => b.name.length - a.name.length)[0];
    const placeNamed = place.name && words.includes(nameKey(place.name));
    if (!named && !placeNamed && (ELSEWHERE.test(text) || !INSIDE.test(text))) return null;
    const caged = /\bcage|caged|kennel\b/i.test(text);
    if (named) return { roomId: named.id, caged };
    const visited = new Set(place.state?.visited || []);
    const dist = r => (from && r.floor === from.floor ? Math.abs(r.rect.x + r.rect.w / 2 - from.x) + Math.abs(r.rect.y + r.rect.h / 2 - from.y) : 1000);
    const want = /\bcell|locked|jail|prison/i.test(text) ? ['cell', ...HOLDS] : caged ? ['kennel', 'cell', ...HOLDS] : HOLDS;
    for (const unseenOnly of [true, false]) {
        for (const t of want) {
            const list = Object.values(place.rooms).filter(r => r.type === t && (!unseenOnly || !visited.has(r.id)));
            if (list.length) return { roomId: list.sort((a, b) => dist(b) - dist(a))[0].id, caged };
        }
    }
    const any = Object.values(place.rooms).filter(r => !visited.has(r.id)).sort((a, b) => dist(b) - dist(a))[0] ?? Object.values(place.rooms).sort((a, b) => dist(b) - dist(a))[0];
    return any ? { roomId: any.id, caged } : null;
}

// ---------- the DM's view ----------

const coord = (x, y) => `${colName(x)}${y + 1}`;

function doorLine(place, d, fromRoom) {
    const other = d.rooms.find(id => id && id !== fromRoom);
    const where = d.exit ? 'OUTSIDE (the way out)' : d.enter ? `building ${d.enter}` : other ? `${other} ${place.rooms[other]?.name ?? ''}` : 'a corridor';
    const bits = [d.kind !== 'door' ? d.kind : '', d.key ? `key: ${d.key}` : '', d.kind === 'locked' && !d.key ? `pick DC ${d.dc ?? 15}` : '', d.kind === 'secret' ? `find DC ${d.dc ?? 15}` : ''].filter(Boolean).join(', ');
    return `${d.id}→${where}${bits ? ` (${bits})` : ''}`;
}

/**
 * The whole place as the DM knows it (secrets included). Changes rarely, so it sits in the cached
 * part of the prompt; current door states, guards and positions are in placeView.
 */
export function placeSummary(place) {
    const lines = [`# PLACE: ${place.name} (${place.kind}${place.floors.length > 1 ? `, ${place.floors.length} floors` : ''}, ${Object.keys(place.rooms).length || Object.keys(place.buildings).length} ${Object.keys(place.rooms).length ? 'rooms' : 'buildings'}). You designed it; the code built the map.`];
    if (place.summary) lines.push(place.summary);
    for (const f of place.floors.slice().sort((a, b) => b.level - a.level)) {
        const rooms = Object.values(place.rooms).filter(r => r.floor === f.id);
        if (!rooms.length) continue;
        lines.push('', `## ${f.name} (floor ${f.id})`);
        for (const rm of rooms) {
            const doors = Object.values(place.doors).filter(d => d.rooms.includes(rm.id)).map(d => doorLine(place, d, rm.id));
            const stairs = place.stairs.filter(s => s.a.room === rm.id || s.b.room === rm.id).map(s => { const o = s.a.room === rm.id ? s.b : s.a; return `stairs ${s.id}→${o.room} (${floorById(place, o.floor).name})`; });
            const traps = Object.values(place.traps).filter(t => t.room === rm.id).map(t => `${t.id} ${t.kind} at ${coord(t.x, t.y)} DC ${t.dc}${t.save ? ` ${t.save}` : ''}: ${t.effect}`);
            const items = Object.values(place.items).filter(i => i.room === rm.id).map(i => `${i.id} ${i.name}${i.hidden ? ' (hidden)' : ''}${i.note ? ` ${i.note}` : ''}`);
            lines.push(`- ${rm.id} ${rm.name} [${rm.type}${rm.lit ? ', lit' : ', dark'}${rm.exit ? ', has the way out' : ''}]${rm.description ? `: ${rm.description}` : rm.hint ? ` (notes: ${rm.hint})` : ''}`);
            lines.push(`  exits: ${[...doors, ...stairs].join('; ') || 'none'}${traps.length ? ` | traps: ${traps.join('; ')}` : ''}${items.length ? ` | items: ${items.join('; ')}` : ''}`);
        }
    }
    const buildings = Object.values(place.buildings);
    if (buildings.length) {
        lines.push('', '## Buildings');
        for (const b of buildings) lines.push(`- ${b.id} ${b.name} [${b.kind}]${b.sign ? ` sign: "${b.sign}"` : ''}${b.keeper ? ` run by ${b.keeper}` : ''}${b.description ? `: ${b.description}` : ''}`);
    }
    const guards = Object.values(place.guards);
    if (guards.length) {
        lines.push('', '## People on the map');
        for (const g of guards) lines.push(`- ${g.name}${g.hostile !== false ? ' (hostile)' : ''}: ${g.description}${g.patrol.length > 1 ? ` Patrols ${g.patrol.join('→')}.` : ` Stays in ${g.room ?? 'a corridor'}.`}`);
    }
    return lines.join('\n');
}

/** A text crop of the map around a square: terrain, people (@) and what's on the squares. */
export function cropText(place, floorId, rect, people = {}) {
    const map = floorById(place, floorId).map;
    const x0 = Math.max(0, rect.x - 2), y0 = Math.max(0, rect.y - 2), x1 = Math.min(map.w - 1, rect.x + rect.w + 1), y1 = Math.min(map.h - 1, rect.y + rect.h + 1);
    const at = {};
    for (const [name, p] of Object.entries(people)) if (p && p.floor === floorId) at[`${p.x},${p.y}`] = name;
    const header = '     ' + Array.from({ length: x1 - x0 + 1 }, (_, i) => colName(x0 + i).padEnd(3)).join('');
    const lines = [header];
    for (let y = y1; y >= y0; y--) {
        let row = '';
        for (let x = x0; x <= x1; x++) row += (at[`${x},${y}`] ? '@' : terrainAt(map, x, y)).padEnd(3);
        lines.push(`${String(y + 1).padStart(3)}  ${row.trimEnd()}`);
    }
    const props = (map.props || []).filter(p => !p.hidden && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && (!PROPS[p.type]?.decal || p.type === 'debris')).map(p => `${p.label || PROPS[p.type]?.name || p.type} ${p.id ?? ''} ${coord(p.x, p.y)}${p.obstacle ? ' (blocking on purpose)' : ''}`.replace(/ {2}/g, ' '));
    const wins = Object.values(place.windows || {}).filter(w => w.floor === floorId && w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1).map(w => `${w.id} ${coord(w.x, w.y)} ${w.state}`);
    const who = Object.entries(people).filter(([, p]) => p && p.floor === floorId && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map(([n, p]) => `${n} ${coord(p.x, p.y)}`);
    return `${lines.join('\n')}\n(@ = someone; | window, H barred window, U broken window) People: ${who.join('; ') || 'none'}\nThings (ids for place_changes.props): ${props.join(', ') || 'none'}${wins.length ? `\nWindows: ${wins.join(', ')}` : ''}`;
}

/** What's going on in the place right now, for every DM call while the party is inside. */
export function placeView(place, partyNames) {
    const st = place.state;
    const lead = st.positions[partyNames[0]];
    const floor = floorById(place, lead?.floor ?? st.floor);
    const room = lead ? roomAt(place, floor.id, lead.x, lead.y) : null;
    const lines = [`Current: ${floor.name} (floor ${floor.id}), ${room ? `in ${room.id} ${room.name}` : lead ? `in a corridor at ${coord(lead.x, lead.y)}` : 'position unknown'}.`];
    if (st.visited.length) lines.push(`Rooms the party has been in: ${st.visited.join(', ')}.`);
    const changed = Object.values(place.doors).filter(d => (d.kind === 'locked' && d.state !== 'locked') || (d.kind === 'secret' && d.state !== 'hidden') || d.state === 'open' || d.state === 'broken').map(d => `${d.id} ${d.state === 'closed' && d.kind === 'locked' ? 'unlocked' : d.state === 'closed' && d.kind === 'secret' ? 'found' : d.state}`);
    if (changed.length) lines.push(`Doors now: ${changed.join(', ')}.`);
    const traps = Object.values(place.traps).filter(t => t.state !== 'hidden').map(t => `${t.id} ${t.state}`);
    if (traps.length) lines.push(`Traps known/used: ${traps.join(', ')}.`);
    const taken = Object.values(place.items).filter(i => i.state === 'taken' || i.found).map(i => `${i.id} ${i.name} ${i.state === 'taken' ? 'taken' : 'found'}`);
    if (taken.length) lines.push(`Items: ${taken.join(', ')}.`);
    const bodies = Object.values(place.guards).filter(g => g.state === 'dead').map(g => `${g.name} at ${coord(g.x, g.y)}`);
    if (bodies.length) lines.push(`Bodies on the floor (dead; cleared away after a few turns): ${bodies.join('; ')}.`);
    const guards = Object.values(place.guards).filter(g => g.state !== 'gone' && g.state !== 'dead').map(g => `${g.name} in ${g.room ?? 'a corridor'}${g.floor === floor.id ? ` at ${coord(g.x, g.y)}` : ''}${g.state === 'alert' ? ' (ALERT)' : ''}${g.intent && g.intent !== 'wander' ? ` [${{ attack: 'going after', follow: 'following', flee: 'running from the party', stay: 'staying put', goto: 'on their way in, now at the edge of where the party can see' }[g.intent]}${g.target && ['attack', 'follow'].includes(g.intent) ? ` ${g.target}` : g.intent === 'attack' || g.intent === 'follow' ? ' the nearest of the party' : ''}]` : ''}`);
    lines.push(guards.length ? `People now (the only ones on the map; put anyone else you narrate here or on their way on it): ${guards.join('; ')}.` : 'People now: nobody else is on the map (put anyone you narrate here or on their way on it).');
    const party = partyNames.filter(n => st.positions[n]).map(n => {
        const p = st.positions[n], h = hiddenNow(place, n);
        const rm = roomAt(place, p.floor, p.x, p.y);
        const trapped = caughtNow(place, n);
        const rest = poseNow(place, n);
        const resting = rest ? `, ${rest.pose === 'sit' ? 'sitting on' : rest.pose === 'sleep' ? 'asleep on' : 'lying on'} the ${rest.what} (${rest.prop})` : '';
        return `${n} at ${coord(p.x, p.y)}${p.floor !== floor.id ? ` (floor ${p.floor})` : ''} in ${rm?.name ?? 'a corridor'}: ${h ? `HIDING ${h.mode} the ${h.what} (${h.prop})` : 'not hiding, out in the open'}${resting}${trapped ? `, CAUGHT in the ${trapped.kind} (${trapped.trap}): held until their save succeeds or you free them (place_changes.free)` : ''}`;
    });
    if (party.length) lines.push(`Party now (live from the map, the truth whatever earlier messages said): ${party.join('; ')}.`);
    const waiting = Object.entries(st.waiting || {}).filter(([, w]) => w).map(([n]) => `${n} (stayed at ${coord(st.positions[n]?.x ?? 0, st.positions[n]?.y ?? 0)}${st.positions[n] ? `, ${roomAt(place, st.positions[n].floor, st.positions[n].x, st.positions[n].y)?.name ?? 'a corridor'}` : ''})`);
    if (waiting.length) lines.push(`Companions who chose not to follow: ${waiting.join('; ')}.`);
    const people = { ...st.positions };
    for (const g of Object.values(place.guards)) if (g.state !== 'gone') people[g.name] = { floor: g.floor, x: g.x, y: g.y };
    const area = room?.rect ?? (lead ? { x: lead.x - 4, y: lead.y - 4, w: 9, h: 9 } : null);
    if (area) lines.push(`Map here (floor ${floor.id}; columns ${colName(0)}.., rows 1.. from the bottom):`, cropText(place, floor.id, area, people));
    return lines.join('\n');
}
