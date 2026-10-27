// Exploring a generated place: which room a square is in, fog of war (what the party can see and
// has seen), walking paths, guards on patrol, the DM's view of the place, and the DM's changes
// (doors, traps, items, guards). Pure module.

import { PROPS, TERRAIN, HEAVY, terrainAt, propsAt, colName, parseCoord } from './grid.js';
import { doorChar, ensureIds } from './layout.js';
import { nameKey } from './text.js';

const OUTDOOR = new Set(['town', 'forest', 'camp', 'swamp', 'snow', 'desert']);
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
        for (const p of map.props || []) {
            const rad = PROPS[p.type]?.light;
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
                    if (zone && zone !== own) continue;
                    if (!zone && room && !inRing(x, y)) continue;
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
 */
export function findPath(place, floorId, from, to, { knownOnly = true, blocked = new Set() } = {}) {
    const map = floorById(place, floorId).map;
    const known = (x, y) => !knownOnly || isExplored(place, floorId, x, y);
    if (!walkable(place, floorId, to.x, to.y) || !known(to.x, to.y)) return null;
    const key = (x, y) => y * map.w + x;
    const prev = new Map([[key(from.x, from.y), null]]);
    const queue = [[from.x, from.y]];
    for (let qi = 0; qi < queue.length; qi++) {
        const [x, y] = queue[qi];
        if (x === to.x && y === to.y) {
            const path = [];
            let k = key(x, y);
            while (prev.get(k) !== null) { path.unshift([k % map.w, Math.floor(k / map.w)]); k = prev.get(k); }
            return path;
        }
        for (const [dx, dy] of DIRS8) {
            const nx = x + dx, ny = y + dy, k = key(nx, ny);
            if (prev.has(k) || !walkable(place, floorId, nx, ny) || !known(nx, ny) || blocked.has(`${nx},${ny}`)) continue;
            // Diagonal steps can't squeeze between two walls or through a doorway.
            if (dx && dy && (!walkable(place, floorId, x + dx, y) || !walkable(place, floorId, x, y + dy) || terrainAt(map, nx, ny) === '+' || terrainAt(map, x, y) === '+' || terrainAt(map, nx, ny) === '/' || terrainAt(map, x, y) === '/')) continue;
            prev.set(k, key(x, y));
            queue.push([nx, ny]);
        }
    }
    return null;
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
            g = where ? placePerson(place, name, where, { floor, info }) : null;
            if (!g) { log.push(`couldn't place ${name} (no square or room given)`); continue; }
            if (raw.description) g.description = String(raw.description).slice(0, 240);
            if (typeof raw.hostile === 'boolean') g.hostile = raw.hostile;
            if (Array.isArray(raw.patrol)) g.patrol = raw.patrol.map(id => findRoom(place, id)?.id).filter(Boolean);
            if (!g.patrol.length && g.room) g.patrol = [g.room];
            g.state = raw.state === 'alert' ? 'alert' : 'patrol';
            log.push(`${g.name} at ${coord(g.x, g.y)}`);
            continue;
        }
        const v = String(raw);
        if (/^(gone|dead|left|removed)$/i.test(v)) { if (g) g.state = 'gone'; }
        else if (/^(alert|hunting|chasing)$/i.test(v)) { if (g) g.state = 'alert'; }
        else if (/^(calm|patrol|patrolling)$/i.test(v)) { if (g) g.state = 'patrol'; }
        else {
            // A square or a room: move them there (someone new appears there).
            g = placePerson(place, name, v, { floor });
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
    // New things the DM puts on the map (a barricade, bars, a cave-in...). On purpose, so they may block a door.
    for (const a of Array.isArray(c.add_props) ? c.add_props : []) {
        const type = String(a?.type || '').toLowerCase().replace(/[\s-]+/g, '_');
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
export function placePerson(place, name, where, { floor = place.state?.floor, info = {}, taken = null } = {}) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return null;
    // Squares other people already stand on (party and the place's people), unless told otherwise.
    const busy = f => taken ?? new Set([...Object.entries(place.state?.positions || {}).map(([, p]) => p), ...Object.values(place.guards).filter(g => g.state !== 'gone' && nameKey(g.name) !== nameKey(clean))].filter(p => p && p.floor === f).map(p => `${p.x},${p.y}`));
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
    const room = roomAt(place, floorId, spot.x, spot.y)?.id ?? null;
    let g = personByName(place, clean);
    if (!g) {
        g = place.guards[clean] = { name: clean, description: String(info.description || '').slice(0, 240), hostile: info.hostile === true, room, patrol: room ? [room] : [], step: 0, floor: floorId, x: spot.x, y: spot.y, state: 'patrol' };
        if (info.gender === 'male' || info.gender === 'female') g.gender = info.gender;
    }
    Object.assign(g, { floor: floorId, x: spot.x, y: spot.y, room: room ?? g.room ?? null });
    if (g.state === 'gone') g.state = 'patrol';
    return g;
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
        if (g.state === 'gone' || g.patrol.length < 2 || r() > chance) continue;
        g.step = ((g.step ?? 0) + 1) % g.patrol.length;
        moveGuardTo(place, g, g.patrol[g.step], r);
        moved.push({ name: g.name, room: g.room });
    }
    return moved;
}

/** Guards the party can see right now. */
export function visibleGuards(place, floorId, visible) {
    const map = floorById(place, floorId).map;
    return Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === floorId && visible[g.y * map.w + g.x]);
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
            lines.push(`- ${rm.id} ${rm.name} [${rm.type}${rm.lit ? ', lit' : ', dark'}${rm.exit ? ', has the way out' : ''}]${rm.description ? `: ${rm.description}` : ''}`);
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
    const guards = Object.values(place.guards).filter(g => g.state !== 'gone').map(g => `${g.name} in ${g.room ?? 'a corridor'}${g.floor === floor.id ? ` at ${coord(g.x, g.y)}` : ''}${g.state === 'alert' ? ' (ALERT)' : ''}`);
    if (guards.length) lines.push(`People now: ${guards.join('; ')}.`);
    const waiting = Object.entries(st.waiting || {}).filter(([, w]) => w).map(([n]) => `${n} (stayed at ${coord(st.positions[n]?.x ?? 0, st.positions[n]?.y ?? 0)}${st.positions[n] ? `, ${roomAt(place, st.positions[n].floor, st.positions[n].x, st.positions[n].y)?.name ?? 'a corridor'}` : ''})`);
    if (waiting.length) lines.push(`Companions who chose not to follow: ${waiting.join('; ')}.`);
    const people = { ...st.positions };
    for (const g of Object.values(place.guards)) if (g.state !== 'gone') people[g.name] = { floor: g.floor, x: g.x, y: g.y };
    const area = room?.rect ?? (lead ? { x: lead.x - 4, y: lead.y - 4, w: 9, h: 9 } : null);
    if (area) lines.push(`Map here (floor ${floor.id}; columns ${colName(0)}.., rows 1.. from the bottom):`, cropText(place, floor.id, area, people));
    return lines.join('\n');
}
