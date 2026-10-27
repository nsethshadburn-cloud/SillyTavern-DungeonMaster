// Place generator: turns Claude's plan (rooms, what connects to what, traps, keys, guards) into
// real floors. Claude decides what the place is; this code decides the geometry, which Claude would
// get wrong (doors that don't line up, stairs that go nowhere). Same plan + same seed = same place.
// Pure module.

import { PROPS, THEMES, MAX_PLACE_SIZE, signIcon, ORIENTED } from './grid.js';
import { ROOM_SIZES, recipeFor, roomType, WALLPAPER_HUES, CARPET_HUES } from './rooms.js';
import { nameKey } from './text.js';

// ---------- small helpers ----------
function rng(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const pickR = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const str = v => (v === null || v === undefined ? '' : String(v).trim());
const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const K = (x, y) => `${x},${y}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const propType = t => str(t).toLowerCase().replace(/[\s-]+/g, '_');

const VIA = ['door', 'arch', 'locked', 'secret', 'stairs'];
const KIND_THEME = { mansion: 'mansion', manor: 'mansion', estate: 'mansion', house: 'house', castle: 'castle', keep: 'castle', fortress: 'castle', tower: 'castle', palace: 'castle', dungeon: 'dungeon', prison: 'prison', jail: 'prison', asylum: 'prison', cave: 'cave', caves: 'cave', cavern: 'cave', mine: 'mine', crypt: 'crypt', tomb: 'crypt', catacombs: 'crypt', temple: 'temple', church: 'temple', cathedral: 'temple', monastery: 'temple', sewer: 'sewer', sewers: 'sewer', ship: 'ship', cabin: 'cabin', lodge: 'cabin', tavern: 'tavern', inn: 'tavern', library: 'library', academy: 'library' };
/** Themes where mansion-style walls and floors (wallpaper, carpet) would look wrong. */
const ROUGH = new Set(['dungeon', 'cave', 'crypt', 'prison', 'sewer', 'mine']);

// ---------- the plan ----------

/**
 * Every room must be reachable. A group of rooms with no link to the rest (a tower or a cellar the
 * plan forgot the stairs to) gets one: a door to a room on the same floor if there is one, otherwise
 * stairs from the nearest level.
 */
function connectRooms(rooms, floors, links, start) {
    const parent = Object.fromEntries(rooms.map(r => [r.id, r.id]));
    const find = id => (parent[id] === id ? id : (parent[id] = find(parent[id])));
    for (const l of links) parent[find(l.a)] = find(l.b);
    const level = id => floors.find(f => f.id === rooms.find(r => r.id === id)?.floor)?.level ?? 0;
    for (;;) {
        const main = find(start);
        const cut = rooms.filter(r => find(r.id) !== main);
        if (!cut.length) return;
        const group = cut.filter(r => find(r.id) === find(cut[0].id));
        const joined = rooms.filter(r => find(r.id) === main);
        let best = null;
        for (const a of group) for (const b of joined) {
            const cost = a.floor === b.floor ? 0 : 1 + Math.abs(level(a.id) - level(b.id));
            if (!best || cost < best.cost) best = { a, b, cost };
        }
        links.push({ a: best.b.id, b: best.a.id, via: best.a.floor === best.b.floor ? 'door' : 'stairs', key: '', dc: 15 });
        parent[find(best.a.id)] = main;
    }
}

/** Validate a place plan from Claude. Never throws; fills sensible defaults. */
export function normalizePlan(raw) {
    const d = obj(raw);
    const kind = str(d.kind).toLowerCase() || 'site';
    const floors = [];
    for (const [i, f] of arr(d.floors).slice(0, 6).entries()) {
        let id = str(f?.id) || `F${i}`;
        while (floors.some(x => x.id === id)) id += 'x';
        floors.push({ id, name: str(f?.name) || `Floor ${i + 1}`, level: Number.isFinite(Number(f?.level)) ? Math.round(Number(f.level)) : i });
    }
    if (!floors.length) floors.push({ id: 'F0', name: 'Ground floor', level: 0 });
    const floorOf = v => floors.find(f => f.id === str(v))?.id ?? floors.find(f => nameKey(f.name) === nameKey(v))?.id ?? floors[0].id;
    const rooms = [];
    for (const [i, r] of arr(d.rooms).slice(0, 80).entries()) {
        let id = str(r?.id) || `R${i + 1}`;
        while (rooms.some(x => x.id === id)) id += 'b';
        const size = str(r?.size).toLowerCase();
        rooms.push({
            id,
            name: str(r?.name).slice(0, 60) || `Room ${i + 1}`,
            type: roomType(r?.type || r?.name),
            floor: floorOf(r?.floor),
            size: ROOM_SIZES[size] ? size : '',
            lit: typeof r?.lit === 'boolean' ? r.lit : null,
            description: str(r?.description).slice(0, 700),
            props: arr(r?.props).map(p => (typeof p === 'string' ? { type: p } : obj(p))).map(p => ({ type: propType(p.type), count: clamp(Math.round(Number(p.count)) || 1, 1, 8), label: str(p.label).slice(0, 40) })).filter(p => PROPS[p.type] && p.type !== 'sign').slice(0, 16),
            marks: arr(r?.marks ?? r?.decor).map(propType).filter(t => PROPS[t]?.decal).slice(0, 8),
            traps: arr(r?.traps).slice(0, 3).map(t => obj(t)).map(t => ({ kind: str(t.kind || t.name).slice(0, 60) || 'trap', dc: clamp(Math.round(Number(t.dc)) || 13, 8, 25), save: str(t.save).slice(0, 24), effect: str(t.effect).slice(0, 240), hidden: t.hidden !== false })),
            items: arr(r?.items).slice(0, 6).map(it => (typeof it === 'string' ? { name: it } : obj(it))).map(it => ({ name: str(it.name).slice(0, 60), hidden: it.hidden === true, note: str(it.note ?? it.where).slice(0, 160) })).filter(it => it.name),
            exit: r?.exit === true,
            windows: ['barred', 'none', 'normal'].includes(str(r?.windows).toLowerCase()) ? str(r.windows).toLowerCase() : '',
        });
    }
    if (!rooms.length) rooms.push({ id: 'R1', name: 'Room', type: 'room', floor: floors[0].id, size: '', lit: null, description: '', props: [], marks: [], traps: [], items: [], exit: true });
    const has = id => rooms.some(r => r.id === id);
    // Links may name a room by id ("G1") or by name ("the gatehouse").
    const roomRef = v => { const t = str(v); if (has(t)) return t; const k = nameKey(t.replace(/^thes+/i, '')); return (rooms.find(r => r.id.toLowerCase() === t.toLowerCase()) ?? rooms.find(r => nameKey(r.name.replace(/^thes+/i, '')) === k))?.id ?? ''; };
    const links = [];
    for (const l of arr(d.links).slice(0, 200)) {
        const a = roomRef(l?.a ?? l?.from), b = roomRef(l?.b ?? l?.to);
        if (!has(a) || !has(b) || a === b) continue;
        let via = str(l?.via).toLowerCase();
        if (!VIA.includes(via)) via = /stair|ladder|lift/.test(via) ? 'stairs' : /lock|bar|seal/.test(via) ? 'locked' : /secret|hidden/.test(via) ? 'secret' : /arch|open|gap/.test(via) ? 'arch' : 'door';
        const ra = rooms.find(r => r.id === a), rb = rooms.find(r => r.id === b);
        if (ra.floor !== rb.floor) via = 'stairs';
        else if (via === 'stairs') via = 'door';
        if (links.some(x => (x.a === a && x.b === b) || (x.a === b && x.b === a))) continue;
        links.push({ a, b, via, key: via === 'locked' ? str(l?.key).slice(0, 60) : '', dc: Number.isFinite(Number(l?.dc)) ? clamp(Math.round(Number(l.dc)), 8, 25) : (via === 'secret' ? 15 : 15) });
    }
    // Guards are hostile; "people" are everyone else who lives or works there (a cook, a prisoner).
    const guards = [...arr(d.guards).map(g => ({ ...obj(g), hostile: obj(g).hostile !== false })), ...arr(d.people).map(g => ({ ...obj(g), hostile: obj(g).hostile === true }))].slice(0, 20).map(g => ({
        name: str(g.name).slice(0, 60),
        description: str(g.description).slice(0, 240),
        room: has(str(g.room)) ? str(g.room) : '',
        patrol: arr(g.patrol).map(str).filter(has).slice(0, 8),
        hostile: g.hostile,
        sprite: str(g.sprite).slice(0, 30),
    })).filter(g => g.name && (g.room || g.patrol.length));
    for (const g of guards) if (!g.room) g.room = g.patrol[0];
    const start = roomRef(d.start) || rooms[0].id;
    connectRooms(rooms, floors, links, start);
    // Every big place has a way out: the start's floor gets one if Claude named none.
    if (!rooms.some(r => r.exit) && kind !== 'interior') {
        const ground = floors.slice().sort((a, b) => Math.abs(a.level) - Math.abs(b.level))[0].id;
        (rooms.find(r => r.floor === ground && r.type === 'foyer') ?? rooms.find(r => r.floor === ground) ?? rooms[0]).exit = true;
    }
    const themeIn = str(d.theme).toLowerCase();
    const theme = THEMES.includes(themeIn) ? themeIn : KIND_THEME[kind] ?? 'dungeon';
    return {
        normalized: true,
        name: str(d.name).slice(0, 80) || 'Unnamed place',
        kind,
        theme,
        fog: typeof d.fog === 'boolean' ? d.fog : true,
        barred: d.barred_windows === true,
        summary: str(d.summary).slice(0, 1200),
        floors, rooms, links, guards, start,
    };
}

// ---------- floor layout ----------

/** Tiles of one floor while it's being built: I = room inside, W = wall, C = corridor. */
class FloorGrid {
    constructor() { this.cells = new Map(); }
    get(x, y) { return this.cells.get(K(x, y)); }
    ring(rect) {
        const out = [];
        for (let x = rect.x - 1; x <= rect.x + rect.w; x++) { out.push([x, rect.y - 1]); out.push([x, rect.y + rect.h]); }
        for (let y = rect.y; y < rect.y + rect.h; y++) { out.push([rect.x - 1, y]); out.push([rect.x + rect.w, y]); }
        return out;
    }
    canPlace(rect, gap = 0) {
        for (let x = rect.x - gap; x < rect.x + rect.w + gap; x++) for (let y = rect.y - gap; y < rect.y + rect.h + gap; y++) if (this.cells.has(K(x, y))) return false;
        if (gap) return this.canPlace(rect, 0) && !this.ring({ x: rect.x - gap, y: rect.y - gap, w: rect.w + gap * 2, h: rect.h + gap * 2 }).some(([x, y]) => this.cells.has(K(x, y)));
        for (const [x, y] of this.ring(rect)) { const c = this.get(x, y); if (c && c.t !== 'W') return false; }
        return true;
    }
    place(rect, id) {
        for (let x = rect.x; x < rect.x + rect.w; x++) for (let y = rect.y; y < rect.y + rect.h; y++) this.cells.set(K(x, y), { t: 'I', room: id });
        for (const [x, y] of this.ring(rect)) {
            const c = this.get(x, y);
            if (c) c.rooms.push(id); else this.cells.set(K(x, y), { t: 'W', rooms: [id] });
        }
    }
}

function isCorner(rect, x, y) {
    return (x === rect.x - 1 || x === rect.x + rect.w) && (y === rect.y - 1 || y === rect.y + rect.h);
}

/** Wall squares shared by two rooms that touch, with inside floor on both sides. */
function sharedWall(A, B) {
    const out = [];
    const overlap = (a0, a1, b0, b1) => [Math.max(a0, b0), Math.min(a1, b1)];
    if (A.x + A.w === B.x - 1 || B.x + B.w === A.x - 1) {
        const x = A.x + A.w === B.x - 1 ? A.x + A.w : A.x - 1;
        const [y0, y1] = overlap(A.y, A.y + A.h - 1, B.y, B.y + B.h - 1);
        for (let y = y0; y <= y1; y++) out.push([x, y]);
    } else if (A.y + A.h === B.y - 1 || B.y + B.h === A.y - 1) {
        const y = A.y + A.h === B.y - 1 ? A.y + A.h : A.y - 1;
        const [x0, x1] = overlap(A.x, A.x + A.w - 1, B.x, B.x + B.w - 1);
        for (let x = x0; x <= x1; x++) out.push([x, y]);
    }
    return out;
}

function tryAdjacent(grid, r, P, w, h) {
    for (const side of shuffle(r, ['e', 'w', 'n', 's'])) {
        const horizontal = side === 'e' || side === 'w';
        const span = horizontal ? P.h + h - 1 : P.w + w - 1;
        const base = horizontal ? P.y - h + 1 : P.x - w + 1;
        const center = horizontal ? P.y + (P.h - h) / 2 : P.x + (P.w - w) / 2;
        // Near the middle first, with a little jitter (computed once, so the sort is consistent).
        const offsets = [...Array(span).keys()].map(i => ({ o: base + i, d: Math.abs(base + i - center) + r() * 3 })).sort((a, b) => a.d - b.d).map(x => x.o);
        for (const o of offsets) {
            const rect = side === 'e' ? { x: P.x + P.w + 1, y: o, w, h } : side === 'w' ? { x: P.x - 1 - w, y: o, w, h } : side === 'n' ? { x: o, y: P.y + P.h + 1, w, h } : { x: o, y: P.y - 1 - h, w, h };
            if (sharedWall(P, rect).length >= Math.min(2, horizontal ? h : w) && grid.canPlace(rect)) return rect;
        }
    }
    return null;
}

function tryNear(grid, r, P, w, h) {
    for (let d = 3; d < 26; d++) {
        const cands = [];
        for (let o = -d - w; o <= d + P.w; o++) { cands.push({ x: P.x + o, y: P.y + P.h + d, w, h }, { x: P.x + o, y: P.y - d - h, w, h }); }
        for (let o = -d - h; o <= d + P.h; o++) { cands.push({ x: P.x + P.w + d, y: P.y + o, w, h }, { x: P.x - d - w, y: P.y + o, w, h }); }
        for (const rect of shuffle(r, cands)) if (grid.canPlace(rect, 1)) return rect;
    }
    return null;
}

/** Multi-source search for a corridor between two rooms. Returns [doorA, path..., doorB] or null. */
function carveCorridor(grid, A, B, idA, idB, bounds) {
    const ends = (rect, id) => {
        const out = [];
        for (const [x, y] of grid.ring(rect)) {
            if (isCorner(rect, x, y)) continue;
            const c = grid.get(x, y);
            if (!c || c.t !== 'W' || c.rooms.length > 1 || c.door) continue;
            const ox = x < rect.x ? x - 1 : x >= rect.x + rect.w ? x + 1 : x;
            const oy = y < rect.y ? y - 1 : y >= rect.y + rect.h ? y + 1 : y;
            const o = grid.get(ox, oy);
            if (!o || o.t === 'C') out.push({ door: [x, y], out: [ox, oy] });
        }
        return out;
    };
    const starts = ends(A, idA), goals = new Map(ends(B, idB).map(e => [K(...e.out), e]));
    if (!starts.length || !goals.size) return null;
    const prev = new Map(), queue = [];
    for (const s of starts) { const k = K(...s.out); if (!prev.has(k)) { prev.set(k, { from: null, start: s }); queue.push(s.out); } }
    for (let qi = 0; qi < queue.length; qi++) {
        const [x, y] = queue[qi], k = K(x, y);
        if (goals.has(k)) {
            const path = [];
            let cur = k, node = prev.get(k);
            while (node) { path.unshift(cur.split(',').map(Number)); if (!node.from) break; cur = node.from; node = prev.get(cur); }
            return { doorA: node.start.door, path, doorB: goals.get(k).door };
        }
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy, nk = K(nx, ny);
            if (prev.has(nk) || nx < bounds.x0 || ny < bounds.y0 || nx > bounds.x1 || ny > bounds.y1) continue;
            const c = grid.get(nx, ny);
            if (c && c.t !== 'C') continue;
            prev.set(nk, { from: k });
            queue.push([nx, ny]);
        }
    }
    return null;
}

function roomDims(r, room, shrink) {
    const recipe = recipeFor(room.type);
    const order = ['tiny', 'small', 'medium', 'large', 'huge'];
    let size = room.size || recipe.size || 'medium';
    if (shrink && size !== 'long') size = order[Math.max(0, order.indexOf(size) - shrink)] ?? 'small';
    const [[w0, h0], [w1, h1]] = ROOM_SIZES[size] ?? ROOM_SIZES.medium;
    let w = int(r, w0, w1), h = int(r, h0, h1);
    if (size === 'long' && r() < 0.5) [w, h] = [h, w];
    else if (size !== 'long' && r() < 0.5) [w, h] = [h, w];
    return { w, h };
}

function buildFloor(r, plan, floor, rects, shrink, doors) {
    const grid = new FloorGrid();
    const here = plan.rooms.filter(x => x.floor === floor.id);
    const sameFloor = plan.links.filter(l => l.via !== 'stairs' && here.some(x => x.id === l.a) && here.some(x => x.id === l.b));
    const neighbors = id => sameFloor.filter(l => l.a === id || l.b === id).map(l => (l.a === id ? l.b : l.a));
    const dims = Object.fromEntries(here.map(x => [x.id, roomDims(r, x, shrink)]));
    // Start from the entrance (or the most connected room) and grow outward along the links.
    const anchor = here.find(x => x.id === plan.start) ?? here.find(x => x.exit) ?? here.slice().sort((a, b) => neighbors(b.id).length - neighbors(a.id).length)[0];
    const order = [], seen = new Set();
    const visit = id => { const queue = [id]; seen.add(id); while (queue.length) { const cur = queue.shift(); order.push(cur); for (const n of shuffle(r, neighbors(cur))) if (!seen.has(n)) { seen.add(n); queue.push(n); } } };
    if (anchor) visit(anchor.id);
    for (const x of here) if (!seen.has(x.id)) visit(x.id);
    const corridorNeeded = [];
    for (const id of order) {
        const { w, h } = dims[id];
        if (!Object.keys(rects).some(k => here.some(x => x.id === k))) {
            rects[id] = { x: 0, y: 0, w, h };
            grid.place(rects[id], id);
            continue;
        }
        let rect = null;
        for (const n of neighbors(id).filter(n => rects[n])) { rect = tryAdjacent(grid, r, rects[n], w, h); if (rect) break; }
        if (!rect) {
            const near = rects[neighbors(id).find(n => rects[n])] ?? rects[order.find(o => rects[o])];
            rect = tryNear(grid, r, near, w, h) ?? tryNear(grid, r, near, Math.max(3, w - 2), Math.max(3, h - 2));
        }
        if (!rect) { failWhy = `no room to fit "${plan.rooms.find(x => x.id === id)?.name}" on ${floor.name}`; return null; }
        rects[id] = rect;
        grid.place(rect, id);
    }
    // Doors: through a shared wall when two linked rooms touch, otherwise a corridor between them.
    const all = Object.entries(rects).filter(([id]) => here.some(x => x.id === id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, rc] of all) { minX = Math.min(minX, rc.x - 1); minY = Math.min(minY, rc.y - 1); maxX = Math.max(maxX, rc.x + rc.w); maxY = Math.max(maxY, rc.y + rc.h); }
    const bounds = { x0: minX - 4, y0: minY - 4, x1: maxX + 4, y1: maxY + 4 };
    for (const l of sameFloor) {
        const wallTiles = sharedWall(rects[l.a], rects[l.b]).filter(([x, y]) => !grid.get(x, y)?.door);
        if (wallTiles.length) {
            const [x, y] = wallTiles[Math.floor(wallTiles.length / 2)];
            grid.get(x, y).door = true;
            doors.push({ floor: floor.id, x, y, link: l, rooms: [l.a, l.b] });
        } else corridorNeeded.push(l);
    }
    const corridors = [];
    for (const l of corridorNeeded) {
        const c = carveCorridor(grid, rects[l.a], rects[l.b], l.a, l.b, bounds);
        if (!c) continue;
        for (const [x, y] of c.path) if (!grid.get(x, y)) grid.cells.set(K(x, y), { t: 'C' });
        for (const [door, id] of [[c.doorA, l.a], [c.doorB, l.b]]) { grid.get(...door).door = true; doors.push({ floor: floor.id, x: door[0], y: door[1], link: l, rooms: [id, null], corridor: true }); }
        corridors.push(c);
    }
    // Walls around corridors.
    for (const [k, c] of [...grid.cells]) {
        if (c.t !== 'C') continue;
        const [x, y] = k.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (!grid.get(x + dx, y + dy)) grid.cells.set(K(x + dx, y + dy), { t: 'W', rooms: [] });
    }
    return grid;
}

// ---------- furnishing ----------

function roomTiles(rect) {
    const out = [];
    for (let x = rect.x; x < rect.x + rect.w; x++) for (let y = rect.y; y < rect.y + rect.h; y++) out.push([x, y]);
    return out;
}

/** Furnish one room on a finished floor. ctx: {chars (2D, [y][x]), props, blocked:Set, reserved:Set} */
function furnish(r, room, rect, ctx, theme) {
    const recipe = recipeFor(room.type);
    const inside = (x, y) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    const charAt = (x, y) => ctx.chars[y]?.[x] ?? '%';
    const free = (x, y) => inside(x, y) && !ctx.blocked.has(K(x, y)) && !ctx.reserved.has(K(x, y)) && charAt(x, y) === '.';
    const area = rect.w * rect.h;
    const targets = roomTiles(rect).filter(([x, y]) => ctx.reserved.has(K(x, y)));
    const stillConnected = () => {
        if (targets.length < 2) return true;
        const seen = new Set([K(...targets[0])]), queue = [targets[0]];
        while (queue.length) { const [x, y] = queue.shift(); for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy, k = K(nx, ny); if (!seen.has(k) && inside(nx, ny) && !ctx.blocked.has(k)) { seen.add(k); queue.push([nx, ny]); } } }
        return targets.every(t => seen.has(K(...t)));
    };
    const put = (type, x, y, w = 1, h = 1, extra = {}) => {
        const blocks = PROPS[type]?.blocks;
        const tiles = [];
        for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) {
            const tx = x + i, ty = y + j;
            if (blocks ? !free(tx, ty) : !inside(tx, ty) || charAt(tx, ty) !== '.') return null;
            tiles.push(K(tx, ty));
        }
        if (blocks) { for (const k of tiles) ctx.blocked.add(k); if (!stillConnected()) { for (const k of tiles) ctx.blocked.delete(k); return null; } }
        const prop = { x, y, type, ...extra };
        if (ORIENTED.has(type) && !prop.side) {
            // Back to the nearest wall.
            const d = { s: y - rect.y, n: rect.y + rect.h - (y + h), w: x - rect.x, e: rect.x + rect.w - (x + w) };
            prop.side = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
        }
        if (w > 1) prop.w = w;
        if (h > 1) prop.h = h;
        ctx.props.push(prop);
        return prop;
    };
    // Squares against each wall, with the wall's side.
    const sides = { n: [], s: [], e: [], w: [] };
    for (let x = rect.x; x < rect.x + rect.w; x++) { sides.n.push([x, rect.y + rect.h - 1]); sides.s.push([x, rect.y]); }
    for (let y = rect.y; y < rect.y + rect.h; y++) { sides.w.push([rect.x, y]); sides.e.push([rect.x + rect.w - 1, y]); }
    const wallSquares = [];
    for (let x = rect.x; x < rect.x + rect.w; x++) { wallSquares.push([x, rect.y + rect.h, 's']); wallSquares.push([x, rect.y - 1, 'n']); }
    for (let y = rect.y; y < rect.y + rect.h; y++) { wallSquares.push([rect.x - 1, y, 'e']); wallSquares.push([rect.x + rect.w, y, 'w']); }
    const wallFree = new Set(wallSquares.filter(([x, y]) => charAt(x, y) === '#').map(([x, y]) => K(x, y)));
    const corners = [[rect.x, rect.y], [rect.x + rect.w - 1, rect.y], [rect.x, rect.y + rect.h - 1], [rect.x + rect.w - 1, rect.y + rect.h - 1]];
    const longX = rect.w >= rect.h;

    const placeOne = (type, where, opt = {}) => {
        const def = PROPS[type];
        let [along, depth] = opt.size ?? def?.size ?? [1, 1];
        if (where === 'onwall') {
            const spots = shuffle(r, wallSquares.filter(([x, y]) => wallFree.has(K(x, y))));
            const s = spots[0];
            if (!s) return null;
            wallFree.delete(K(s[0], s[1]));
            const p = { x: s[0], y: s[1], type, facing: s[2], ...(opt.label ? { label: opt.label } : {}) };
            ctx.props.push(p);
            return p;
        }
        if (where === 'center') {
            let w = along, h = depth;
            if (opt.fill || opt.long || opt.runner) {
                const len = Math.max(1, (longX ? rect.w : rect.h) - (opt.long ? 4 : 2));
                const thick = opt.runner ? Math.min(2, Math.max(1, (longX ? rect.h : rect.w) - 4)) : opt.long ? ((longX ? rect.h : rect.w) >= 6 ? 2 : 1) : Math.max(1, (longX ? rect.h : rect.w) - 2);
                [w, h] = longX ? [len, thick] : [thick, len];
            } else if (!longX && w !== h) [w, h] = [h, w];
            const x = rect.x + Math.floor((rect.w - w) / 2), y = rect.y + Math.floor((rect.h - h) / 2);
            const p = put(type, x, y, w, h, opt.extra) ?? (w > 1 || h > 1 ? put(type, x, y, Math.max(1, w - 1), Math.max(1, h - 1), opt.extra) : null);
            if (p && opt.long) for (let i = 0; i < (p.w || 1); i++) for (let j = 0; j < (p.h || 1); j++) {
                // Chairs along the long sides of a dining table.
                if (longX) { if (j === 0 && r() < 0.85) put('chair', p.x + i, p.y - 1, 1, 1, { side: 's' }); if (j === (p.h || 1) - 1 && r() < 0.85) put('chair', p.x + i, p.y + (p.h || 1), 1, 1, { side: 'n' }); }
                else { if (i === 0 && r() < 0.85) put('chair', p.x - 1, p.y + j, 1, 1, { side: 'w' }); if (i === (p.w || 1) - 1 && r() < 0.85) put('chair', p.x + (p.w || 1), p.y + j, 1, 1, { side: 'e' }); }
            }
            return p;
        }
        if (where === 'wall') {
            for (const side of shuffle(r, ['n', 's', 'e', 'w'])) {
                const horiz = side === 'n' || side === 's';
                const w = horiz ? along : depth, h = horiz ? depth : along;
                const line = sides[side];
                for (const [lx, ly] of shuffle(r, line)) {
                    const x = side === 'e' ? rect.x + rect.w - w : horiz ? lx : rect.x;
                    const y = side === 'n' ? rect.y + rect.h - h : side === 's' ? rect.y : ly;
                    const p = put(type, x, y, w, h, { ...(opt.extra ?? {}), side });
                    if (p) return p;
                }
            }
            return null;
        }
        if (where === 'corner') {
            for (const [x, y] of shuffle(r, corners)) { const p = put(type, x, y, 1, 1, opt.extra); if (p) return p; }
            where = 'any';
        }
        // any / floor / ceiling
        const tiles = shuffle(r, roomTiles(rect));
        for (const [x, y] of tiles) {
            if (where !== 'floor' && where !== 'ceiling' && (x === rect.x || x === rect.x + rect.w - 1 || y === rect.y || y === rect.y + rect.h - 1) && r() < 0.6) continue;
            if (where === 'ceiling' && (Math.abs(x - (rect.x + rect.w / 2)) > rect.w / 3 || Math.abs(y - (rect.y + rect.h / 2)) > rect.h / 3)) continue;
            if (where === 'floor' || where === 'ceiling') { if (charAt(x, y) === '.') { const p = { x, y, type, ...(opt.extra ?? {}) }; ctx.props.push(p); return p; } continue; }
            const p = put(type, x, y, along, depth, opt.extra);
            if (p) return p;
        }
        return null;
    };

    const rough = ROUGH.has(theme);
    for (const [type, where, [lo, hi], opt = {}] of recipe.items) {
        if (rough && ['painting', 'mirror', 'chandelier'].includes(type) && !['crypt', 'chapel'].includes(room.type)) continue;
        let n = int(r, lo, hi);
        if (area < 16) n = Math.min(n, Math.max(lo, 1));
        else if (area > 60) n = Math.max(n, hi);
        const extra = type === 'rug' ? { hue: pickR(r, CARPET_HUES) } : undefined;
        if (opt.rows && type === 'pew') {
            // Rows of pews facing the far wall.
            for (let i = 0; i < n; i++) {
                const y = rect.y + 1 + i * 2;
                if (y >= rect.y + rect.h - 2) break;
                const len = Math.max(2, Math.floor((rect.w - 3) / 2));
                put('pew', rect.x + 1, y, len, 1);
                put('pew', rect.x + rect.w - 1 - len, y, len, 1);
            }
            continue;
        }
        for (let i = 0; i < n; i++) placeOne(type, where, { ...opt, extra });
    }
    // What Claude asked for in this room.
    for (const p of room.props) {
        const d = PROPS[p.type];
        const where = d.wall ? 'onwall' : d.ceiling ? 'ceiling' : d.decal ? 'floor' : d.blocks && d.cover ? 'wall' : 'any';
        for (let i = 0; i < p.count; i++) placeOne(p.type, where, { label: p.label, extra: p.label ? { label: p.label } : undefined });
    }
    for (const m of room.marks) placeOne(m, 'floor');
}

// ---------- the whole place ----------

function areaStyle(r, room, theme, level = 0) {
    const recipe = recipeFor(room.type);
    let floor = recipe.floor, wall = recipe.wall;
    // Dungeons, caves and anything below ground get rough stone instead of wallpaper and carpet.
    if (ROUGH.has(theme) || level < 0) {
        if (['carpet', 'parquet', 'tiles', 'marble', 'planks'].includes(floor)) floor = theme === 'cave' || theme === 'mine' ? 'rock' : 'stone';
        if (['wallpaper', 'panel', 'plaster', 'timber', 'stoneblock'].includes(wall)) wall = theme === 'cave' || theme === 'mine' ? 'rock' : 'brick';
    } else if (theme === 'cabin') {
        if (['wallpaper', 'panel', 'plaster', 'stoneblock'].includes(wall)) wall = 'log';
        if (['carpet', 'parquet', 'marble'].includes(floor)) floor = 'planks';
    }
    const a = { floor, wall };
    if (floor === 'carpet') a.hue = pickR(r, CARPET_HUES);
    if (floor === 'tiles') a.hue = pickR(r, [40, 200, 0, 120]);
    if (wall === 'wallpaper') a.wallHue = pickR(r, WALLPAPER_HUES);
    if (recipe.grime) a.grime = recipe.grime;
    return a;
}

/**
 * Build a place from a normalized plan. Tries a few layouts (shrinking rooms if a floor gets too
 * big), then furnishes, places traps, items, keys and guards, and makes sure it can be solved.
 * @returns {object} the place (see DESIGN.md "Places")
 */
let failWhy = '';

export function generatePlace(planIn, seed = 1) {
    let plan = planIn?.normalized ? planIn : normalizePlan(planIn);
    // A floor with more rooms than fit gets split: its far half becomes a level of its own, up the stairs.
    for (let split = 0; split <= 4 && plan; split++) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const place = tryBuild(plan, (seed + attempt * 7919) >>> 0, Math.floor(attempt / 2));
            if (place) return place;
        }
        plan = splitBusiestFloor(plan);
    }
    throw new Error(`Couldn't lay out "${planIn?.name ?? 'the place'}": ${failWhy || 'the rooms would not fit together'}.`);
}

/**
 * The floor with the most rooms, split in two: the rooms farthest from its way in (walking the
 * links) move to a new level above it (below it, for cellars), and the links that now cross
 * between the two become stairs. Null if no floor is big enough to split.
 */
export function splitBusiestFloor(plan) {
    const byFloor = plan.floors.map(f => [f, plan.rooms.filter(r => r.floor === f.id)]).sort((a, b) => b[1].length - a[1].length);
    const [floor, rooms] = byFloor[0] ?? [];
    if (!floor || rooms.length < 6) return null;
    const ids = new Set(rooms.map(r => r.id));
    const links = plan.links.filter(l => ids.has(l.a) && ids.has(l.b));
    const anchor = rooms.find(r => r.id === plan.start) ?? rooms.find(r => r.exit) ?? rooms[0];
    const order = [anchor.id], seen = new Set(order);
    for (let i = 0; i < order.length; i++) {
        for (const l of links) {
            const n = l.a === order[i] ? l.b : l.b === order[i] ? l.a : null;
            if (n && !seen.has(n)) { seen.add(n); order.push(n); }
        }
    }
    for (const r of rooms) if (!seen.has(r.id)) order.push(r.id);
    const half = Math.ceil(order.length / 2);
    const moving = new Set(order.slice(half));
    let id = `${floor.id}u`;
    while (plan.floors.some(f => f.id === id)) id += 'u';
    const down = floor.level < 0;
    const wing = { id, name: `${floor.name}, ${down ? 'lower' : 'upper'} level`, level: floor.level + (down ? -1 : 1) };
    const rooms2 = plan.rooms.map(r => (moving.has(r.id) ? { ...r, floor: id } : r));
    const floorOf = Object.fromEntries(rooms2.map(r => [r.id, r.floor]));
    const links2 = plan.links.map(l => (floorOf[l.a] !== floorOf[l.b] ? { ...l, via: 'stairs' } : l));
    // The new level must be reachable: stairs between the last room kept and the first one moved.
    if (!links2.some(l => moving.has(l.a) !== moving.has(l.b) && ids.has(l.a) && ids.has(l.b))) links2.push({ a: order[half - 1], b: order[half], via: 'stairs' });
    return { ...plan, floors: [...plan.floors, wing], rooms: rooms2, links: links2 };
}

function tryBuild(plan, seed, shrink) {
    const r = rng(seed);
    const rects = {}, doorsRaw = [], grids = {};
    const floors = plan.floors.slice().sort((a, b) => a.level - b.level);
    for (const floor of floors) {
        if (!plan.rooms.some(x => x.floor === floor.id)) continue;
        const grid = buildFloor(r, plan, floor, rects, shrink, doorsRaw);
        if (!grid) return null;
        grids[floor.id] = grid;
    }
    const place = {
        version: 1, kind: plan.kind, name: plan.name, theme: plan.theme, fog: plan.fog, seed, summary: plan.summary,
        floors: [], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: null },
    };
    const chars = {}, offsets = {};
    for (const floor of floors) {
        const grid = grids[floor.id];
        if (!grid) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k of grid.cells.keys()) { const [x, y] = k.split(',').map(Number); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        const w = maxX - minX + 3, h = maxY - minY + 3;
        if (w > MAX_PLACE_SIZE || h > MAX_PLACE_SIZE) { failWhy = `${floor.name} came out bigger than ${MAX_PLACE_SIZE}x${MAX_PLACE_SIZE} squares`; return null; }
        const ox = 1 - minX, oy = 1 - minY;
        offsets[floor.id] = [ox, oy];
        const c = [...Array(h)].map(() => Array(w).fill('%'));
        for (const [k, cell] of grid.cells) { const [x, y] = k.split(',').map(Number); c[y + oy][x + ox] = cell.t === 'W' ? '#' : '.'; }
        chars[floor.id] = c;
        place.floors.push({ id: floor.id, name: floor.name, level: floor.level, map: { w, h, rows: [], theme: plan.theme, props: [], areas: [], roofs: [], seed: seed + floors.indexOf(floor) } });
    }
    const floorMap = id => place.floors.find(f => f.id === id)?.map;
    const levelOf = id => plan.floors.find(f => f.id === id)?.level ?? 0;
    // Rooms in final coordinates.
    for (const room of plan.rooms) {
        const rc = rects[room.id];
        if (!rc) continue;
        const [ox, oy] = offsets[room.floor];
        const rect = { x: rc.x + ox, y: rc.y + oy, w: rc.w, h: rc.h };
        const lit = room.lit ?? recipeFor(room.type).lit ?? false;
        place.rooms[room.id] = { id: room.id, name: room.name, type: room.type, floor: room.floor, rect, lit, description: room.description, exit: room.exit };
        floorMap(room.floor).areas.push({ ...rect, ...areaStyle(r, room, plan.theme, levelOf(room.floor)), lit, room: room.id });
    }
    // Doors.
    let doorN = 0;
    const doorAt = new Map();
    const addDoor = (floor, x, y, kind, rooms, extra = {}) => {
        const id = `D${++doorN}`;
        const state = kind === 'locked' ? 'locked' : kind === 'secret' ? 'hidden' : kind === 'arch' ? 'open' : 'closed';
        const door = { id, floor, x, y, kind, state, rooms, ...extra };
        place.doors[id] = door;
        doorAt.set(`${floor}:${x},${y}`, door);
        chars[floor][y][x] = doorChar(door);
        return door;
    };
    for (const d of doorsRaw) {
        const [ox, oy] = offsets[d.floor];
        const x = d.x + ox, y = d.y + oy;
        if (doorAt.has(`${d.floor}:${x},${y}`)) continue;
        // A locked or secret corridor is locked (or hidden) at its far end only.
        const kind = d.corridor && ['locked', 'secret'].includes(d.link.via) && d.rooms[0] === d.link.a ? 'door' : d.link.via;
        addDoor(d.floor, x, y, kind, d.rooms, d.link.key ? { key: d.link.key, dc: d.link.dc } : { dc: d.link.dc });
    }
    // Stairs between floors.
    const reserved = new Set();
    const reserve = (floor, x, y) => reserved.add(`${floor}:${x},${y}`);
    for (const d of Object.values(place.doors)) for (const [dx, dy] of DIRS) reserve(d.floor, d.x + dx, d.y + dy);
    const pickInside = (roomId, prefer = 'edge') => {
        const room = place.rooms[roomId], c = chars[room.floor];
        const tiles = shuffle(r, roomTiles(room.rect)).filter(([x, y]) => c[y][x] === '.' && !reserved.has(`${room.floor}:${x},${y}`));
        const edge = tiles.filter(([x, y]) => x === room.rect.x || y === room.rect.y || x === room.rect.x + room.rect.w - 1 || y === room.rect.y + room.rect.h - 1);
        // A small room with doors all round may have no free square left: stairs still go in (never dropped).
        return (prefer === 'edge' && edge.length ? edge : tiles)[0] ?? shuffle(r, roomTiles(room.rect)).find(([x, y]) => c[y][x] === '.') ?? null;
    };
    let stairN = 0;
    for (const l of plan.links.filter(x => x.via === 'stairs')) {
        const a = place.rooms[l.a], b = place.rooms[l.b];
        if (!a || !b) continue;
        const pa = pickInside(a.id), pb = pickInside(b.id);
        if (!pa || !pb) continue;
        const up = levelOf(a.floor) < levelOf(b.floor);
        chars[a.floor][pa[1]][pa[0]] = up ? '<' : '>';
        chars[b.floor][pb[1]][pb[0]] = up ? '>' : '<';
        for (const [f, [x, y]] of [[a.floor, pa], [b.floor, pb]]) { reserve(f, x, y); for (const [dx, dy] of DIRS) reserve(f, x + dx, y + dy); }
        place.stairs.push({ id: `S${++stairN}`, a: { floor: a.floor, x: pa[0], y: pa[1], room: a.id }, b: { floor: b.floor, x: pb[0], y: pb[1], room: b.id } });
    }
    // Ways out: a door in an outside wall of each exit room; windows on outside walls of lit rooms above ground.
    const outsideOf = {};
    for (const room of Object.values(place.rooms)) {
        const c = chars[room.floor], rc = room.rect;
        const outer = [];
        for (let x = rc.x; x < rc.x + rc.w; x++) { outer.push([x, rc.y - 1, 0, -1], [x, rc.y + rc.h, 0, 1]); }
        for (let y = rc.y; y < rc.y + rc.h; y++) { outer.push([rc.x - 1, y, -1, 0], [rc.x + rc.w, y, 1, 0]); }
        const outside = outer.filter(([x, y, dx, dy]) => c[y]?.[x] === '#' && (c[y + dy]?.[x + dx] ?? '%') === '%' && !doorAt.has(`${room.floor}:${x},${y}`));
        outsideOf[room.id] = outside;
        if (room.exit && outside.length) {
            const [x, y] = outside[Math.floor(outside.length / 2)];
            const d = addDoor(room.floor, x, y, 'door', [room.id, null], { exit: true });
            place.exits.push({ floor: room.floor, x, y, door: d.id });
        }
        const pr = plan.rooms.find(x => x.id === room.id);
        if (pr?.windows !== 'none' && (pr?.windows === 'barred' || pr?.windows === 'normal' || (!ROUGH.has(plan.theme) && levelOf(room.floor) >= 0 && room.type !== 'vault'))) {
            const bars = pr?.windows === 'barred' || (plan.barred && pr?.windows !== 'normal');
            outside.forEach(([x, y], i) => { if (i % 3 === 1 && c[y][x] === '#' && !doorAt.has(`${room.floor}:${x},${y}`)) c[y][x] = bars ? 'H' : '|'; });
        }
    }
    // An exit room walled in by other rooms on this layout isn't a way out here. The place still needs
    // one: if no exit room reached the outside, the lowest room above ground with an outside wall gets the door.
    for (const rm of Object.values(place.rooms)) if (rm.exit && !place.exits.some(e => place.doors[e.door]?.rooms.includes(rm.id))) rm.exit = false;
    if (!place.exits.length) {
        const pick = Object.values(place.rooms).filter(rm => outsideOf[rm.id]?.length).sort((a, b) => Math.abs(levelOf(a.floor)) - Math.abs(levelOf(b.floor)))[0];
        if (!pick) { failWhy = 'no room has an outside wall for a way out'; return null; }
        const [x, y] = outsideOf[pick.id][Math.floor(outsideOf[pick.id].length / 2)];
        const d = addDoor(pick.floor, x, y, 'door', [pick.id, null], { exit: true });
        place.exits.push({ floor: pick.floor, x, y, door: d.id });
        pick.exit = true;
    }
    // Keep the squares in front of every door (the way out included), every staircase and every window clear.
    for (const d of Object.values(place.doors)) for (const [dx, dy] of DIRS) reserve(d.floor, d.x + dx, d.y + dy);
    for (const f of Object.keys(chars)) chars[f].forEach((row, y) => row.forEach((ch, x) => { if (ch === '|' || ch === 'H') for (const [dx, dy] of DIRS) reserve(f, x + dx, y + dy); }));
    // Furniture.
    for (const room of plan.rooms) {
        const pr = place.rooms[room.id];
        if (!pr) continue;
        const map = floorMap(pr.floor);
        const blocked = new Set();
        const res = new Set([...reserved].filter(k => k.startsWith(`${pr.floor}:`)).map(k => k.slice(pr.floor.length + 1)));
        furnish(r, room, pr.rect, { chars: chars[pr.floor], props: map.props, blocked, reserved: res }, plan.theme);
    }
    // Traps, items, keys, guards.
    const blockedAt = (floor, x, y) => floorMap(floor).props.some(p => PROPS[p.type]?.blocks && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    const freeTile = (roomId, avoidEdge = false) => {
        const room = place.rooms[roomId], c = chars[room.floor];
        const tiles = shuffle(r, roomTiles(room.rect)).filter(([x, y]) => c[y][x] === '.' && !blockedAt(room.floor, x, y) && !reserved.has(`${room.floor}:${x},${y}`));
        return (avoidEdge ? tiles.filter(([x, y]) => x > room.rect.x && y > room.rect.y && x < room.rect.x + room.rect.w - 1 && y < room.rect.y + room.rect.h - 1) : [])[0] ?? tiles[0] ?? null;
    };
    let trapN = 0, itemN = 0;
    for (const room of plan.rooms) {
        const pr = place.rooms[room.id];
        if (!pr) continue;
        for (const t of room.traps) {
            const at = freeTile(room.id, true);
            if (!at) continue;
            const id = `T${++trapN}`;
            place.traps[id] = { id, room: room.id, floor: pr.floor, x: at[0], y: at[1], kind: t.kind, dc: t.dc, save: t.save, effect: t.effect, state: t.hidden ? 'hidden' : 'found' };
            floorMap(pr.floor).props.push({ x: at[0], y: at[1], type: 'trap', hidden: t.hidden, trap: id, label: t.kind });
        }
        for (const it of room.items) {
            const holder = floorMap(pr.floor).props.find(p => ['chest', 'desk', 'cabinet', 'dresser', 'wardrobe', 'table', 'nightstand', 'workbench', 'counter'].includes(p.type) && p.x >= pr.rect.x && p.x < pr.rect.x + pr.rect.w && p.y >= pr.rect.y && p.y < pr.rect.y + pr.rect.h);
            const at = holder ? [holder.x, holder.y] : freeTile(room.id);
            if (!at) continue;
            const id = `I${++itemN}`;
            place.items[id] = { id, name: it.name, room: room.id, floor: pr.floor, x: at[0], y: at[1], hidden: it.hidden, note: it.note || (holder ? `in the ${PROPS[holder.type].name}` : ''), state: 'here' };
        }
    }
    // A key for every keyed lock, even if Claude forgot to place it (the solver moves it if needed).
    for (const d of Object.values(place.doors)) {
        if (d.kind !== 'locked' || !d.key) continue;
        if (Object.values(place.items).some(i => nameKey(i.name) === nameKey(d.key))) continue;
        const roomIds = Object.keys(place.rooms).filter(id => !d.rooms.includes(id));
        const roomId = pickR(r, roomIds.length ? roomIds : Object.keys(place.rooms));
        const at = freeTile(roomId);
        if (!at) continue;
        const id = `I${++itemN}`;
        place.items[id] = { id, name: d.key, room: roomId, floor: place.rooms[roomId].floor, x: at[0], y: at[1], hidden: true, note: '', state: 'here' };
    }
    for (const g of plan.guards) {
        const room = place.rooms[g.room];
        if (!room) continue;
        const at = freeTile(room.id);
        if (!at) continue;
        place.guards[g.name] = { name: g.name, description: g.description, hostile: g.hostile !== false, ...(g.sprite ? { sprite: g.sprite } : {}), room: room.id, patrol: g.patrol.length ? g.patrol.filter(id => place.rooms[id]?.floor === room.floor) : [room.id], step: 0, floor: room.floor, x: at[0], y: at[1], state: 'patrol' };
    }
    // Rows (top row first) and the start.
    for (const f of place.floors) {
        const c = chars[f.id];
        f.map.rows = c.slice().reverse().map(row => row.join(''));
    }
    const startRoom = place.rooms[plan.start] ?? Object.values(place.rooms)[0];
    const at = freeTile(startRoom.id, true) ?? freeTile(startRoom.id);
    place.start = { floor: startRoom.floor, x: at?.[0] ?? startRoom.rect.x, y: at?.[1] ?? startRoom.rect.y, room: startRoom.id };
    place.state.floor = startRoom.floor;
    for (const f of place.floors) place.state.explored[f.id] = '0'.repeat(f.map.w * f.map.h);
    clearDoorways(place);
    ensureIds(place);
    // A layout where some room can never be reached is thrown away (the next attempt uses another seed).
    // Repairs may add doors: keep furniture out of those doorways too.
    if (solvePlace(place, r)) { clearDoorways(place); return place; }
    failWhy = `some rooms can't be reached (${Object.values(place.rooms).filter(rm => !new Set(reachable(place).roomsReached).has(rm.id)).map(rm => rm.name).slice(0, 4).join(', ')})`;
    return null;
}

/**
 * Nothing the generator placed may stand in a doorway, in front of a door, on or by a staircase, or
 * in front of a window. Only something put there on purpose (an obstacle: a barricade, a cave-in)
 * may block one. Also run on places loaded from older versions. Returns how many were moved out.
 */
export function clearDoorways(place) {
    let removed = 0;
    const spots = [];
    for (const d of Object.values(place.doors)) spots.push([d.floor, d.x, d.y, true]);
    for (const s of place.stairs) { spots.push([s.a.floor, s.a.x, s.a.y, true]); spots.push([s.b.floor, s.b.x, s.b.y, true]); }
    for (const f of place.floors) f.map.rows.forEach((row, i) => [...row].forEach((ch, x) => { if (ch === '|' || ch === 'H' || ch === 'U') spots.push([f.id, x, f.map.h - 1 - i, false]); }));
    for (const [floor, x, y, self] of spots) {
        const map = place.floors.find(f => f.id === floor)?.map;
        if (!map) continue;
        const squares = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        if (self) squares.push([x, y]);
        const before = map.props.length;
        map.props = map.props.filter(p => p.obstacle || !PROPS[p.type]?.blocks || !squares.some(([sx, sy]) => sx >= p.x && sx < p.x + (p.w || 1) && sy >= p.y && sy < p.y + (p.h || 1)));
        if (map.props.length !== before) { removed += before - map.props.length; map.version = (map.version || 0) + 1; }
    }
    return removed;
}

/** Ids for props (p1, p2...) and a list of windows (W1...), so the DM can name what changes. */
export function ensureIds(place) {
    let n = 0, w = 0;
    for (const f of place.floors) for (const p of f.map.props) { const m = /^p(\d+)$/.exec(p.id || ''); if (m) n = Math.max(n, Number(m[1])); }
    for (const f of place.floors) for (const p of f.map.props) if (!p.id) p.id = `p${++n}`;
    place.windows ??= {};
    for (const win of Object.values(place.windows)) { const m = /^W(\d+)$/.exec(win.id); if (m) w = Math.max(w, Number(m[1])); }
    for (const f of place.floors) f.map.rows.forEach((row, i) => [...row].forEach((ch, x) => {
        if (ch !== '|' && ch !== 'H' && ch !== 'U') return;
        const y = f.map.h - 1 - i;
        if (Object.values(place.windows).some(v => v.floor === f.id && v.x === x && v.y === y)) return;
        const id = `W${++w}`;
        place.windows[id] = { id, floor: f.id, x, y, state: ch === 'H' ? 'barred' : ch === 'U' ? 'broken' : 'intact' };
    }));
}

export function doorChar(door) {
    if (door.state === 'hidden' || door.state === 'walled') return '#';
    if (door.kind === 'arch' || door.state === 'broken') return '.';
    if (door.state === 'locked') return 'D';
    return door.state === 'open' ? '/' : '+';
}

// ---------- solvable? ----------

const WALK = new Set(['.', ',', ':', '_', '=', '<', '>', '~', 'b', '^', '+', '/', 'D']); // windows (| H U) are not a way through

/**
 * Who can reach what from the start, treating locked doors as open once their key is reachable
 * (or always, if they have no key: they can be picked), and secret doors as findable.
 */
export function reachable(place) {
    const charAt = (f, x, y) => { const m = place.floors.find(fl => fl.id === f)?.map; return m ? (m.rows[m.h - 1 - y]?.[x] ?? '%') : '%'; };
    const doorAt = new Map(Object.values(place.doors).map(d => [`${d.floor}:${d.x},${d.y}`, d]));
    const stairsAt = new Map();
    for (const s of place.stairs) { stairsAt.set(`${s.a.floor}:${s.a.x},${s.a.y}`, s.b); stairsAt.set(`${s.b.floor}:${s.b.x},${s.b.y}`, s.a); }
    const keys = new Set();
    let opened = true, seen;
    while (opened) {
        opened = false;
        seen = new Set();
        const queue = [[place.start.floor, place.start.x, place.start.y]];
        seen.add(`${place.start.floor}:${place.start.x},${place.start.y}`);
        while (queue.length) {
            const [f, x, y] = queue.shift();
            const link = stairsAt.get(`${f}:${x},${y}`);
            const next = DIRS.map(([dx, dy]) => [f, x + dx, y + dy]);
            if (link) next.push([link.floor, link.x, link.y]);
            for (const [nf, nx, ny] of next) {
                const k = `${nf}:${nx},${ny}`;
                if (seen.has(k)) continue;
                const door = doorAt.get(k);
                const ch = charAt(nf, nx, ny);
                let ok = WALK.has(ch);
                if (door) ok = door.kind !== 'locked' || !door.key || keys.has(nameKey(door.key)) || door.state === 'open';
                if (!ok) continue;
                seen.add(k);
                queue.push([nf, nx, ny]);
            }
        }
        for (const it of Object.values(place.items)) {
            if (seen.has(`${it.floor}:${it.x},${it.y}`) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has(`${it.floor}:${it.x + dx},${it.y + dy}`))) {
                if (!keys.has(nameKey(it.name))) { keys.add(nameKey(it.name)); opened = true; }
            }
        }
    }
    const roomsReached = Object.values(place.rooms).filter(rm => roomTiles(rm.rect).some(([x, y]) => seen.has(`${rm.floor}:${x},${y}`))).map(rm => rm.id);
    return { seen, keys, roomsReached };
}

/**
 * A cut-off room with nothing reachable right next to it: dig a corridor from one of its walls,
 * through the empty space around the building, to the nearest wall with reachable floor behind it,
 * with a door at each end. False if there's no way.
 */
function tunnel(place, cut, seen) {
    const map = place.floors.find(f => f.id === cut.floor).map;
    const rows = map.rows.map(row => row.split(''));
    const at = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? null : rows[map.h - 1 - y][x]);
    const set = (x, y, ch) => { rows[map.h - 1 - y][x] = ch; };
    const inRoom = (x, y) => x >= cut.rect.x && x < cut.rect.x + cut.rect.w && y >= cut.rect.y && y < cut.rect.y + cut.rect.h;
    const K = (x, y) => `${x},${y}`;
    const prev = new Map(), queue = [];
    for (const [x, y] of roomTiles({ x: cut.rect.x - 1, y: cut.rect.y - 1, w: cut.rect.w + 2, h: cut.rect.h + 2 })) {
        if (at(x, y) !== '#' || isCorner(cut.rect, x, y) || !DIRS.some(([dx, dy]) => inRoom(x + dx, y + dy))) continue;
        prev.set(K(x, y), null);
        queue.push([x, y]);
    }
    let end = null;
    for (let i = 0; i < queue.length && !end; i++) {
        const [x, y] = queue[i];
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy, k = K(nx, ny);
            if (prev.has(k)) continue;
            const ch = at(nx, ny);
            // A wall with reachable floor right behind it: the far end.
            if (ch === '#' && i > 0 && DIRS.some(([ex, ey]) => seen.has(`${cut.floor}:${nx + ex},${ny + ey}`))) { prev.set(k, K(x, y)); end = [nx, ny]; break; }
            if (ch !== '%') continue;
            prev.set(k, K(x, y));
            queue.push([nx, ny]);
        }
    }
    if (!end) return false;
    const path = [];
    for (let k = K(...end); k; k = prev.get(k)) path.push(k.split(',').map(Number));
    path.forEach(([x, y], i) => set(x, y, i === 0 || i === path.length - 1 ? '+' : '.'));
    for (const [x, y] of path.slice(1, -1)) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (at(x + dx, y + dy) === '%') set(x + dx, y + dy, '#');
    for (const [x, y] of [path[0], path[path.length - 1]]) {
        const id = `D${Object.keys(place.doors).length + 1}t`;
        place.doors[id] = { id, floor: cut.floor, x, y, kind: 'door', state: 'closed', rooms: [inRoom(...DIRS.map(([dx, dy]) => [x + dx, y + dy]).find(([a, b]) => inRoom(a, b)) ?? [-1, -1]) ? cut.id : null, null] };
    }
    map.rows = rows.map(row => row.join(''));
    return true;
}

/** Fix what can't be reached: move keys that sit behind their own lock, add doors to cut-off rooms. */
export function solvePlace(place, r = Math.random) {
    for (let round = 0; round < 80; round++) {
        const { seen, keys, roomsReached } = reachable(place);
        const reached = new Set(roomsReached);
        // A key the party can never get to: move it somewhere they can.
        const stuck = Object.values(place.doors).find(d => d.kind === 'locked' && d.key && !keys.has(nameKey(d.key)));
        if (stuck) {
            const item = Object.values(place.items).find(i => nameKey(i.name) === nameKey(stuck.key));
            const options = [...reached].filter(id => !stuck.rooms.includes(id));
            const roomId = pickR(r, options.length ? options : [...reached]);
            const room = place.rooms[roomId];
            const map = place.floors.find(f => f.id === room.floor).map;
            const tiles = roomTiles(room.rect).filter(([x, y]) => map.rows[map.h - 1 - y][x] === '.' && seen.has(`${room.floor}:${x},${y}`));
            if (item && tiles.length) { const [x, y] = pickR(r, tiles); Object.assign(item, { room: roomId, floor: room.floor, x, y, note: '' }); continue; }
            stuck.key = '';
            continue;
        }
        const cut = Object.values(place.rooms).find(rm => !reached.has(rm.id));
        if (!cut) return true;
        // Punch a door from the cut-off room into anything reachable next to it.
        const map = place.floors.find(f => f.id === cut.floor).map;
        const rows = map.rows.map(s => s.split(''));
        const at = (x, y) => rows[map.h - 1 - y]?.[x] ?? '%';
        let done = false;
        for (const [x, y] of shuffle(r, roomTiles({ x: cut.rect.x - 1, y: cut.rect.y - 1, w: cut.rect.w + 2, h: cut.rect.h + 2 }))) {
            if (at(x, y) !== '#' || isCorner(cut.rect, x, y)) continue;
            const inside = DIRS.map(([dx, dy]) => [x + dx, y + dy]).find(([ix, iy]) => ix >= cut.rect.x && ix < cut.rect.x + cut.rect.w && iy >= cut.rect.y && iy < cut.rect.y + cut.rect.h);
            const opposite = inside && [2 * x - inside[0], 2 * y - inside[1]];
            if (!opposite || !seen.has(`${cut.floor}:${opposite[0]},${opposite[1]}`)) continue;
            const id = `D${Object.keys(place.doors).length + 1}x`;
            const other = Object.values(place.rooms).find(rm => rm.floor === cut.floor && opposite[0] >= rm.rect.x && opposite[0] < rm.rect.x + rm.rect.w && opposite[1] >= rm.rect.y && opposite[1] < rm.rect.y + rm.rect.h);
            place.doors[id] = { id, floor: cut.floor, x, y, kind: 'door', state: 'closed', rooms: [cut.id, other?.id ?? null] };
            rows[map.h - 1 - y][x] = '+';
            map.rows = rows.map(rw => rw.join(''));
            done = true;
            break;
        }
        if (!done && !tunnel(place, cut, seen)) return false;
    }
    return false;
}

// ---------- towns ----------

const BUILDING_SIZES = { small: [5, 4], medium: [6, 5], large: [8, 6] };

/** Validate a town plan from Claude. */
export function normalizeTownPlan(raw) {
    const d = obj(raw);
    const buildings = arr(d.buildings).slice(0, 14).map((b, i) => obj(b)).map((b, i) => ({
        id: str(b.id) || `B${i + 1}`,
        name: str(b.name).slice(0, 60) || `Building ${i + 1}`,
        kind: str(b.kind || b.type).toLowerCase().slice(0, 40) || 'house',
        sign: str(b.sign).slice(0, 40),
        size: BUILDING_SIZES[str(b.size).toLowerCase()] ? str(b.size).toLowerCase() : 'medium',
        enterable: b.enterable !== false,
        description: str(b.description).slice(0, 500),
        keeper: str(b.keeper).slice(0, 60),
    }));
    return {
        normalized: true,
        name: str(d.name).slice(0, 80) || 'Town',
        kind: 'town',
        theme: 'town',
        layout: str(d.layout).toLowerCase() === 'crossroads' ? 'crossroads' : 'road',
        summary: str(d.summary).slice(0, 1200),
        features: arr(d.features).map(f => str(f).toLowerCase()).filter(Boolean).slice(0, 12),
        buildings,
        fog: d.fog === true,
    };
}

/** Build a town: a main road (and a cross road) lined with roofed buildings, signs, a square and greenery. */
export function generateTown(planIn, seed = 1) {
    const plan = planIn?.normalized ? planIn : normalizeTownPlan(planIn);
    const r = rng(seed);
    const feats = new Set(plan.features);
    const wantsSquare = ['square', 'market', 'fountain', 'plaza', 'well'].some(f => [...feats].some(x => x.includes(f)));
    const north = [], south = [];
    plan.buildings.forEach((b, i) => (i % 2 ? south : north).push(b));
    const dims = b => { const [w, d] = BUILDING_SIZES[b.size]; return { w: w + int(r, 0, 1), d: d + int(r, 0, 1) }; };
    const sized = new Map(plan.buildings.map(b => [b.id, dims(b)]));
    const cross = plan.layout === 'crossroads';
    const rowWidth = list => list.reduce((n, b) => n + sized.get(b.id).w + 2, 0);
    let W = Math.max(26, Math.max(rowWidth(north) + (wantsSquare ? 9 : 0), rowWidth(south)) + 6 + (cross ? 4 : 0));
    W = Math.min(W, MAX_PLACE_SIZE);
    const dS = Math.max(4, ...south.map(b => sized.get(b.id).d)), dN = Math.max(4, ...north.map(b => sized.get(b.id).d));
    const margin = 3;
    const roadY = margin + dS + 1;
    const H = Math.min(MAX_PLACE_SIZE, roadY + 2 + 1 + dN + margin);
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = ch; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const crossX = cross ? Math.floor(W / 2) - 1 : -10;
    for (let x = 0; x < W; x++) { set(x, roadY, '='); set(x, roadY + 1, '='); }
    if (cross) for (let y = 0; y < H; y++) { set(crossX, y, '='); set(crossX + 1, y, '='); }
    const map = { w: W, h: H, rows: [], theme: 'town', props: [], areas: [], roofs: [], seed };
    const place = {
        version: 1, kind: 'town', name: plan.name, theme: 'town', fog: plan.fog, seed, summary: plan.summary,
        floors: [{ id: 'F0', name: plan.name, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    let doorN = 0;
    const lay = (list, side) => {
        let x = 3;
        const squareAt = side === 'n' && wantsSquare ? Math.floor(list.length / 2) : -1;
        list.forEach((b, i) => {
            if (i === squareAt) {
                // The town square: cobbles, a fountain or well, market stalls.
                const sw = 8, y0 = roadY + 2;
                for (let sx = x; sx < x + sw; sx++) for (let sy = y0; sy < y0 + Math.min(dN, 6); sy++) set(sx, sy, '=');
                if ([...feats].some(f => f.includes('fountain')) || !feats.has('well')) map.props.push({ x: x + 3, y: y0 + 1, type: 'fountain', w: 2, h: 2 });
                if ([...feats].some(f => f.includes('well'))) map.props.push({ x: x + (feats.has('fountain') ? 6 : 3), y: y0 + Math.min(dN, 6) - 2, type: 'well' });
                if ([...feats].some(f => f.includes('market'))) { map.props.push({ x, y: y0 + 3, type: 'stall', w: 2, h: 2 }); map.props.push({ x: x + 6, y: y0 + 3, type: 'stall', w: 2, h: 2 }); }
                x += sw + 1;
            }
            const { w, d } = sized.get(b.id);
            if (cross && x + w >= crossX - 1 && x <= crossX + 2) x = crossX + 3;
            if (x + w > W - 2) return;
            const y = side === 'n' ? roadY + 3 : roadY - 1 - d;
            const frontY = side === 'n' ? y : y + d - 1;
            for (let bx = x; bx < x + w; bx++) for (let by = y; by < y + d; by++) set(bx, by, '#');
            const dx = x + Math.floor(w / 2);
            set(dx, frontY, '+');
            // Windows on the front, a path to the road, a roof over the rest.
            for (let bx = x + 1; bx < x + w - 1; bx++) if (bx !== dx && Math.abs(bx - dx) % 2 === 0) set(bx, frontY, '|');
            const pathY = side === 'n' ? frontY - 1 : frontY + 1;
            set(dx, pathY, '=');
            // Each house its own front: plaster in different tints, timber framing, brick, stone or logs.
            const look = pickR(r, [
                { wall: 'plaster', wallColor: [pickR(r, [42, 30, 50, 15, 200, 90]), int(r, 18, 35), int(r, 62, 76)] },
                { wall: 'timber', wallColor: [pickR(r, [38, 30, 45]), int(r, 20, 30), int(r, 56, 70)] },
                { wall: 'brick', wallColor: [pickR(r, [8, 14, 20, 25]), int(r, 30, 45), int(r, 30, 40)] },
                { wall: 'stoneblock', wallColor: [pickR(r, [30, 40, 210]), int(r, 6, 12), int(r, 46, 58)] },
                { wall: 'log', wallColor: [26, int(r, 35, 45), int(r, 26, 34)] },
            ]);
            map.areas.push({ x, y, w, h: d, ...look, building: b.id });
            map.roofs.push({ x, y: side === 'n' ? y + 1 : y, w, h: d - 1, ridge: 'h', hue: pickR(r, [8, 16, 24, 200, 210, 30, 350]), style: /farm|stable|barn/.test(b.kind) ? 'thatch' : /temple|church|bank|hall|guard/.test(b.kind) ? 'slate' : 'shingle' });
            const id = `D${++doorN}`;
            place.doors[id] = { id, floor: 'F0', x: dx, y: frontY, kind: 'door', state: 'closed', rooms: [null, null], enter: b.id };
            place.buildings[b.id] = { ...b, door: id, rect: { x, y, w, h: d }, interior: null };
            // A sign for any shop or public building, hanging over the street.
            if (b.kind !== 'house' || b.sign) {
                const sx = dx + 1 < x + w - 1 ? dx + 1 : dx - 1;
                set(sx, frontY, '#');
                map.props.push({ x: sx, y: frontY, type: 'sign', facing: side === 'n' ? 's' : 'n', icon: signIcon(`${b.kind} ${b.sign} ${b.name}`), label: b.sign || b.name });
            }
            // Flowers or barrels by the door.
            const sideX = dx - 1 >= x ? dx - 1 : dx + 1;
            if (get(sideX, pathY) === '.') map.props.push({ x: sideX, y: pathY, type: /tavern|inn|brew|store|shop|smith/.test(b.kind) ? pickR(r, ['barrel', 'crate']) : 'flowers' });
            if (/stable|farm/.test(b.kind)) { map.props.push({ x: x + w, y: pathY, type: 'hay' }); map.props.push({ x: x - 1, y: pathY, type: 'trough' }); }
            x += w + int(r, 1, 3);
            // Now and then a fence or a bush in the gap.
            if (r() < 0.35 && get(x - 1, y) === '.') map.props.push({ x: x - 1, y: side === 'n' ? y : y, type: 'fence', h: Math.max(1, d - 1) });
        });
    };
    lay(north, 'n');
    lay(south, 's');
    // Lampposts along the road, a cart, trees around the edge, a pond or a graveyard if asked for.
    for (let x = 4, i = 0; x < W - 2; x += 7, i++) { const y = i % 2 ? roadY + 2 : roadY - 1; if (get(x, y) === '.') map.props.push({ x, y, type: 'lamppost' }); }
    if (r() < 0.8) map.props.push({ x: int(r, 2, W - 4), y: roadY, type: 'cart' });
    if ([...feats].some(f => f.includes('pond') || f.includes('lake'))) {
        const px = int(r, 2, W - 8), py = H - 3;
        for (let i = 0; i < 6; i++) for (let j = -1; j <= 0; j++) if (get(px + i, py + j) === '.' && (i > 0 && i < 5 || j === 0)) set(px + i, py + j, '~');
    }
    if ([...feats].some(f => f.includes('grave') || f.includes('cemetery'))) {
        const gx = W - 9, gy = 0;
        for (let i = 0; i < 5; i++) if (get(gx + i * 2, gy + 1) === '.') map.props.push({ x: gx + i * 2, y: gy + 1, type: 'tombstone' });
        map.props.push({ x: gx - 1, y: gy + 2, type: 'fence', w: 10 });
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
        if (get(x, y) !== '.') continue;
        const edge = Math.min(y, H - 1 - y);
        if (edge <= 1 && r() < 0.45 && !map.props.some(p => p.x === x && p.y === y)) set(x, y, 'T');
        else if (r() < 0.025 && !map.props.some(p => p.x === x && p.y === y)) map.props.push({ x, y, type: pickR(r, ['bush', 'bush', 'flowers', 'boulder']) });
    }
    // The road's ends lead out of town.
    for (const y of [roadY, roadY + 1]) { place.exits.push({ floor: 'F0', x: 0, y }, { floor: 'F0', x: W - 1, y }); }
    if (cross) for (const x of [crossX, crossX + 1]) { place.exits.push({ floor: 'F0', x, y: 0 }, { floor: 'F0', x, y: H - 1 }); }
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    place.start = { floor: 'F0', x: 1, y: roadY, room: null };
    place.state.explored.F0 = '1'.repeat(W * H);
    return place;
}

/** What a building looks like inside, by its trade (code only: no Claude call). */
const INTERIORS = [
    [/tavern|inn|pub|alehouse/, b => ({ theme: 'tavern', rooms: [['Common room', 'tavern', 'large'], ['Kitchen', 'kitchen', 'small'], ['Cellar', 'cellar', 'small', -1], ['Guest room', 'bedroom', 'small', 1], ['Guest room', 'bedroom', 'small', 1]] })],
    [/smith|forge/, () => ({ theme: 'house', rooms: [['Forge', 'smithy', 'medium'], ['Shop front', 'shop', 'small'], ['Back room', 'bedroom', 'small']] })],
    [/temple|church|chapel|shrine/, () => ({ theme: 'temple', rooms: [['Nave', 'chapel', 'large'], ['Vestry', 'study', 'small']] })],
    [/bank|vault|exchange/, () => ({ theme: 'castle', rooms: [['Hall', 'office', 'medium'], ['Vault', 'vault', 'small', 0, 'locked']] })],
    [/stable|barn|farm/, () => ({ theme: 'house', rooms: [['Stable', 'stable', 'large'], ['Tack room', 'storage', 'small']] })],
    [/guard|watch|jail|town ?hall|barracks/, () => ({ theme: 'castle', rooms: [['Front hall', 'guard_room', 'medium'], ['Office', 'office', 'small'], ['Cells', 'cell', 'small', 0, 'locked']] })],
    [/library|scribe|sage|wizard/, () => ({ theme: 'library', rooms: [['Library', 'library', 'large'], ['Study', 'study', 'small']] })],
    [/alchem|apothec|herb|potion/, () => ({ theme: 'house', rooms: [['Shop', 'shop', 'small'], ['Workroom', 'laboratory', 'small']] })],
    [/shop|store|market|bak|tailor|butcher|cobbl|jewel|general|goods|trader/, () => ({ theme: 'house', rooms: [['Shop', 'shop', 'medium'], ['Storeroom', 'storage', 'small'], ['Living room', 'bedroom', 'small']] })],
    [/mansion|manor|estate/, () => ({ theme: 'mansion', rooms: [['Entrance hall', 'foyer', 'medium'], ['Parlor', 'parlor', 'medium'], ['Dining room', 'dining_room', 'medium'], ['Kitchen', 'kitchen', 'small'], ['Bedroom', 'master_bedroom', 'medium', 1], ['Study', 'study', 'small', 1]] })],
    [/.*/, () => ({ theme: 'house', rooms: [['Main room', 'parlor', 'medium'], ['Kitchen', 'kitchen', 'small'], ['Bedroom', 'bedroom', 'small']] })],
];

/** A building's inside, generated the first time the party walks in. */
export function generateInterior(building, seed = 1) {
    const recipe = INTERIORS.find(([re]) => re.test(`${building.kind} ${building.name}`))[1](building);
    const levels = [...new Set(recipe.rooms.map(rm => rm[3] ?? 0))].sort((a, b) => a - b);
    const floors = levels.map(l => ({ id: `F${l < 0 ? 'm' + -l : l}`, name: l < 0 ? 'Cellar' : l === 0 ? 'Ground floor' : 'Upstairs', level: l }));
    const fid = l => floors.find(f => f.level === l).id;
    const rooms = recipe.rooms.map(([name, type, size, level = 0], i) => ({ id: `R${i + 1}`, name, type, size, floor: fid(level), description: i === 0 ? building.description : '', exit: i === 0 }));
    const links = [];
    const main = rooms[0];
    rooms.slice(1).forEach((rm, i) => {
        const lock = recipe.rooms[i + 1][4];
        const sameFloorHub = rooms.find(x => x.floor === rm.floor && x !== rm && rooms.indexOf(x) < rooms.indexOf(rm));
        links.push({ a: sameFloorHub?.id ?? main.id, b: rm.id, via: rm.floor !== (sameFloorHub ?? main).floor ? 'stairs' : lock || 'door' });
    });
    // Whoever works or lives there is inside, in the main room.
    const people = building.keeper ? [{ name: building.keeper, description: building.description || `works at ${building.name}`, room: main.id }] : [];
    const plan = normalizePlan({ name: building.name, kind: 'interior', theme: recipe.theme, fog: false, floors, rooms, links, people, start: main.id, summary: building.description });
    const place = generatePlace(plan, seed);
    place.kind = 'interior';
    for (const f of place.floors) place.state.explored[f.id] = '1'.repeat(f.map.w * f.map.h);
    return place;
}
