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

const VIA = ['door', 'arch', 'locked', 'secret', 'stairs', 'cell'];
const KIND_THEME = { jungle: 'jungle', rainforest: 'jungle', forest: 'forest', woods: 'forest', swamp: 'swamp', marsh: 'swamp', mansion: 'mansion', manor: 'mansion', estate: 'mansion', house: 'house', castle: 'castle', keep: 'castle', fortress: 'castle', tower: 'castle', palace: 'castle', dungeon: 'dungeon', prison: 'prison', jail: 'prison', asylum: 'prison', cave: 'cave', caves: 'cave', cavern: 'cave', mine: 'mine', crypt: 'crypt', tomb: 'crypt', catacombs: 'crypt', temple: 'temple', church: 'temple', cathedral: 'temple', monastery: 'temple', sewer: 'sewer', sewers: 'sewer', ship: 'ship', cabin: 'cabin', lodge: 'cabin', tavern: 'tavern', inn: 'tavern', library: 'library', academy: 'library' };
/** Themes where mansion-style walls and floors (wallpaper, carpet) would look wrong. */
const ROUGH = new Set(['dungeon', 'cave', 'crypt', 'prison', 'sewer', 'mine']);
/** Places that are kept up unless the story says otherwise; and words that mean they aren't. */
const KEPT_KINDS = /mansion|manor|estate|house|home|palace|castle|keep|fortress|citadel|temple|church|cathedral|monastery|abbey|shrine|prison|jail|gaol|stockade|asylum|tavern|inn|library|academy|school|tower|ship|lodge|cabin|cottage|farmhouse|mill|lighthouse|theater|theatre|bathhouse|observatory|store|guild|bank|museum|hospital|barracks|office|shop|hall/;
const RUINED_WORDS = /abandon|ruin|derelict|haunted|forgotten|crumbl|collapsed|overgrown|decay|desert(ed)?|lost|ancient|old dungeon|sunken|flooded/;
/** Mess that a kept-up place doesn't have lying around (furniture stays). */
const MESS = new Set(['bones', 'skull', 'blood', 'scratches', 'web', 'debris', 'rubble', 'puddle', 'cracks', 'moss', 'rat', 'trash', 'broken_glass']);
/** Places that are a building: their inside and their outside are separate maps (outside: the grounds). */
const BUILDING_KINDS = /mansion|manor|estate|house|home|cottage|hut|shack|palace|castle|keep|fortress|citadel|tower|temple|church|cathedral|chapel|monastery|abbey|shrine|prison|jail|gaol|stockade|asylum|tavern|inn|library|academy|school|cabin|lodge|guild|bank|museum|hospital|barracks|office|shop|store|hall|barn|farmhouse|mill|lighthouse|warehouse|theater|theatre|bathhouse|observatory/;
/** Buildings big enough that a handful of rooms would be pitiful: they get a full plan. */
export const GRAND_KINDS = /mansion|manor|estate|palace|castle|keep|fortress|citadel|chateau|villa/;

/**
 * Add the usual rooms of a kind of building (from the town interiors) until it has `want` rooms
 * inside: on the right floors, joined to the entrance hall (stairs between floors), the entrance
 * hall holding the front door.
 */
function addUsualRooms(rooms, floors, links, isOut, want, words) {
    const recipe = INTERIORS.find(([re]) => re.test(words))[1]({ kind: words, name: words }).rooms;
    const extra = /mansion|manor|estate|palace|castle|chateau|villa/.test(words) ? [['Library', 'library', 'medium', 0], ['Master bedroom', 'master_bedroom', 'medium', 1], ['Guest room', 'bedroom', 'small', 1], ['Servants\' quarters', 'servants_quarters', 'small', 0], ['Wine cellar', 'cellar', 'small', -1], ['Upstairs hall', 'hallway', 'long', 1]] : [];
    const floorFor = level => {
        let f = floors.find(x => x.level === level);
        if (!f) { f = { id: level < 0 ? 'C' : level === 0 ? 'G' : `U${level}`, name: level < 0 ? 'Cellar' : level === 0 ? 'Ground floor' : 'Upstairs', level }; while (floors.some(x => x.id === f.id)) f.id += 'x'; floors.push(f); }
        return f.id;
    };
    const inside = () => rooms.filter(r => !isOut(r));
    let n = 0;
    for (const [name, type, size, level = 0] of [...recipe, ...extra]) {
        if (inside().length >= want) break;
        const t = roomType(type);
        if (inside().some(r => r.type === t && t !== 'bedroom')) continue;
        let id = `H${++n}`;
        while (rooms.some(r => r.id === id)) id = `H${++n}`;
        rooms.push({ id, name, type: t, floor: floorFor(level), size, lit: null, description: '', props: [], marks: [], traps: [], items: [], exit: false, windows: '' });
    }
    // Join them up: the entrance hall (or the first room on the ground) is the hub of its floor and has
    // the front door; every other floor's first room is reached by stairs from it.
    const ground = floorFor(0);
    const hub = inside().find(r => r.floor === ground && r.type === 'foyer') ?? inside().find(r => r.floor === ground);
    if (!hub) return;
    if (!inside().some(r => r.exit)) hub.exit = true;
    const linked = id => links.some(l => l.a === id || l.b === id);
    for (const r of inside()) {
        if (r === hub || linked(r.id)) continue;
        const floorHub = r.floor === ground ? hub : inside().find(x => x.floor === r.floor && x !== r && linked(x.id));
        if (floorHub) links.push({ a: floorHub.id, b: r.id, via: 'door', key: '', dc: 15 });
        else links.push({ a: hub.id, b: r.id, via: 'stairs', key: '', dc: 15 });
    }
}

/** Rooms that are really outside (a garden, a courtyard): on a building's grounds, never inside it. */
const OUTDOOR_TYPES = new Set(['courtyard', 'graveyard']);
const OUTDOOR_NAMES = /garden|yard|orchard|lawn|grounds|field|outside|exterior|porch|patio|terrace|veranda|graveyard|cemetery|pasture|paddock|meadow/;
/** Hazards that come from decay, not from someone setting a trap. */
const DECAY = /rot|crumbl|collaps|loose|weak|unstable|sagging|cave-?in|falling ceiling/;

// ---------- the plan ----------

/**
 * A jail is organized: on each floor with two or more cells, every cell opens onto one cell-block
 * hallway (the hallway already linked to the most cells, or a new one) through a barred cell door,
 * and the cells sit in rows along it. Whatever a cell was linked to links to the hallway instead.
 */
function organizeCells(rooms, floors, links) {
    for (const f of floors) {
        const cells = rooms.filter(r => r.floor === f.id && r.type === 'cell');
        if (cells.length < 2) continue;
        const ids = new Set(cells.map(r => r.id));
        const linkedCells = r => links.filter(l => (l.a === r.id && ids.has(l.b)) || (l.b === r.id && ids.has(l.a))).length;
        let hall = rooms.filter(r => r.floor === f.id && !ids.has(r.id) && r.type === 'hallway').sort((a, b) => linkedCells(b) - linkedCells(a))[0];
        if (!hall) {
            let id = `CB${f.id}`;
            while (rooms.some(r => r.id === id)) id += 'b';
            hall = { id, name: 'Cell block', type: 'hallway', floor: f.id, size: 'long', lit: null, description: 'A row of barred cells on either side of a narrow walk.', props: [], marks: [], traps: [], items: [], exit: false, windows: 'none' };
            rooms.push(hall);
        }
        hall.cellBlock = true;
        const others = new Set();
        for (let i = links.length - 1; i >= 0; i--) {
            const l = links[i];
            const cell = ids.has(l.a) ? l.a : ids.has(l.b) ? l.b : null;
            if (!cell) continue;
            const other = cell === l.a ? l.b : l.a;
            if (!ids.has(other) && other !== hall.id) others.add(other);
            links.splice(i, 1);
        }
        for (const c of cells) links.push({ a: hall.id, b: c.id, via: 'cell', key: '', dc: 15 });
        // The guard room (or whatever the cells opened onto) now connects through the hallway.
        for (const o of others) if (!links.some(l => (l.a === o && l.b === hall.id) || (l.b === o && l.a === hall.id))) {
            const or = rooms.find(r => r.id === o);
            links.push({ a: hall.id, b: o, via: or && or.floor !== hall.floor ? 'stairs' : 'door', key: '', dc: 15 });
        }
    }
}

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
    const roomRef = v => { const t = str(v); if (has(t)) return t; const k = nameKey(t.replace(/^the\s+/i, '')); return (rooms.find(r => r.id.toLowerCase() === t.toLowerCase()) ?? rooms.find(r => nameKey(r.name.replace(/^the\s+/i, '')) === k))?.id ?? ''; };
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
    let start = roomRef(d.start) || rooms[0].id;
    // A building: its outdoor rooms (garden, courtyard, yard...) go on its grounds, a separate map
    // outside; the inside never has outdoors in it. The rooms that opened onto them get the front door.
    const nameWords = str(d.name).toLowerCase();
    const building = !/ruin|dungeon|cave|crypt|mine|sewer|camp/.test(kind) && (BUILDING_KINDS.test(kind) || BUILDING_KINDS.test(nameWords));
    const outside = [], outsideGuards = [];
    let startOutside = false;
    if (building) {
        const isOut = r => OUTDOOR_TYPES.has(r.type) || OUTDOOR_NAMES.test(r.name.toLowerCase());
        // A building always has an inside. If the plan is only its grounds (the party is arriving
        // from outside) or barely has rooms, it gets the usual rooms for its kind.
        const grand = GRAND_KINDS.test(`${kind} ${nameWords}`);
        if (rooms.filter(r => !isOut(r)).length < (grand ? 6 : 2)) addUsualRooms(rooms, floors, links, isOut, grand ? 6 : 2, `${kind} ${nameWords}`);
        const out = rooms.filter(isOut);
        if (out.length && out.length < rooms.length) {
            const outIds = new Set(out.map(r => r.id));
            for (const l of links) {
                if (outIds.has(l.a) && !outIds.has(l.b)) rooms.find(r => r.id === l.b).exit = true;
                if (outIds.has(l.b) && !outIds.has(l.a)) rooms.find(r => r.id === l.a).exit = true;
            }
            for (const r of out) outside.push({ id: r.id, name: r.name, type: r.type, description: r.description, props: r.props });
            rooms.splice(0, rooms.length, ...rooms.filter(r => !outIds.has(r.id)));
            links.splice(0, links.length, ...links.filter(l => !outIds.has(l.a) && !outIds.has(l.b)));
            for (const g of guards.filter(g => outIds.has(g.room))) outsideGuards.push({ ...g, room: g.room });
            guards.splice(0, guards.length, ...guards.filter(g => !outIds.has(g.room)).map(g => ({ ...g, patrol: g.patrol.filter(id => !outIds.has(id)) })));
            if (outIds.has(start)) { startOutside = true; start = (rooms.find(r => r.exit) ?? rooms[0]).id; }
        }
    }
    organizeCells(rooms, floors, links);
    connectRooms(rooms, floors, links, start);
    // A building has a front door (onto its grounds), on the floor nearest the ground. Anywhere else a
    // way out is only there if Claude named one: the DM moves the story on to the next place.
    if (!rooms.some(r => r.exit) && (building || kind === 'interior')) {
        const ground = floors.slice().sort((a, b) => Math.abs(a.level) - Math.abs(b.level))[0].id;
        (rooms.find(r => r.floor === ground && r.type === 'foyer') ?? rooms.find(r => r.floor === ground) ?? rooms[0]).exit = true;
    }
    const themeIn = str(d.theme).toLowerCase();
    const theme = THEMES.includes(themeIn) ? themeIn : KIND_THEME[kind] ?? 'dungeon';
    // Kept up (orderly, tidy), worn (lived in, a bit run down) or ruined (a maze, mess, decay).
    const condIn = str(d.condition).toLowerCase();
    const words = `${str(d.name)} ${kind} ${str(d.summary)} ${str(d.why)}`.toLowerCase();
    const condition = ['kept', 'worn', 'ruined'].includes(condIn) ? condIn : RUINED_WORDS.test(words) ? 'ruined' : KEPT_KINDS.test(kind) ? 'kept' : 'ruined';
    // A kept-up place has no decay hazards: anything like that becomes a trap someone set on purpose.
    if (condition === 'kept') for (const r of rooms) for (const t of r.traps) if (DECAY.test(t.kind.toLowerCase())) t.kind = 'pressure plate (darts)';
    return {
        normalized: true,
        name: str(d.name).slice(0, 80) || 'Unnamed place',
        kind,
        theme,
        // A lit, lived-in home has no fog of war: you can see its rooms. Dark or ruined places keep it.
        fog: building && condition !== 'ruined' && rooms.filter(r => r.lit ?? recipeFor(r.type).lit).length * 2 >= rooms.length ? false : typeof d.fog === 'boolean' ? d.fog : true,
        building, outside, outsideGuards, startOutside,
        exterior: Object.fromEntries(Object.entries(obj(d.exterior)).map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase().replace(/^(l|u|h|e|t)$/, m => m.toUpperCase()) : v])),
        barred: d.barred_windows === true,
        summary: str(d.summary).slice(0, 1200),
        condition,
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
    // A jail's cell block, or (in a kept-up place) the floor's main hallway, goes down first as a
    // spine: the hallway, with the rooms off it in two neat rows along its sides.
    const linkedTo = id => sameFloor.filter(l => l.a === id || l.b === id).map(l => (l.a === id ? l.b : l.a));
    const block = here.find(x => x.cellBlock);
    const spine = block ?? (plan.condition === 'kept'
        ? here.filter(x => ['hallway', 'gallery', 'foyer'].includes(x.type) && linkedTo(x.id).length >= 3).sort((a, b) => linkedTo(b.id).length - linkedTo(a.id).length)[0]
        : null);
    const placed = new Set();
    if (spine) {
        const along = (block ? sameFloor.filter(l => l.via === 'cell' && (l.a === spine.id || l.b === spine.id)).map(l => (l.a === spine.id ? l.b : l.a)) : linkedTo(spine.id)).slice(0, 28);
        const size = id => (block ? { w: 3, h: 3 } : dims[id]);
        // Each room goes on the side that's shorter so far.
        const sides = [[], []], len = [0, 0];
        for (const id of along) { const s = len[0] <= len[1] ? 0 : 1; sides[s].push(id); len[s] += size(id).w + 1; }
        const hallH = block ? 2 : Math.min(3, Math.max(2, Math.round(Math.max(...along.map(id => size(id).w), 3) / 4)));
        rects[spine.id] = { x: 0, y: 0, w: Math.max(5, Math.max(...len) - 1), h: hallH };
        grid.place(rects[spine.id], spine.id);
        placed.add(spine.id);
        sides.forEach((ids, s) => {
            let x = 0;
            for (const id of ids) {
                const { w, h } = size(id);
                const rect = { x, y: s === 0 ? hallH + 1 : -1 - h, w, h };
                if (!grid.canPlace(rect)) continue;
                rects[id] = rect;
                grid.place(rect, id);
                placed.add(id);
                x += w + 1;
            }
        });
    }
    for (const id of order) {
        if (placed.has(id)) continue;
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
function furnish(r, room, rect, ctx, theme, condition = 'ruined') {
    const recipe = recipeFor(room.type);
    const inside = (x, y) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    const charAt = (x, y) => ctx.chars[y]?.[x] ?? '%';
    const free = (x, y) => inside(x, y) && !ctx.blocked.has(K(x, y)) && !ctx.reserved.has(K(x, y)) && charAt(x, y) === '.';
    const area = rect.w * rect.h;
    const targets = roomTiles(rect).filter(([x, y]) => ctx.reserved.has(K(x, y)));
    const stillConnected = () => {
        if (targets.length < 2) return true;
        const seen = new Set([K(...targets[0])]), queue = [targets[0]];
        while (queue.length) {
            const [x, y] = queue.shift();
            if ((x !== targets[0][0] || y !== targets[0][1]) && (charAt(x, y) === '<' || charAt(x, y) === '>')) continue;
            for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy, k = K(nx, ny); if (!seen.has(k) && inside(nx, ny) && !ctx.blocked.has(k)) { seen.add(k); queue.push([nx, ny]); } }
        }
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
        if (condition === 'kept' && MESS.has(type)) continue;
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
        const style = areaStyle(r, room, plan.theme, levelOf(room.floor));
        // Grime: a kept-up place is clean; a ruin is filthier than usual.
        if (plan.condition === 'kept') delete style.grime; else if (plan.condition === 'ruined' && style.grime) style.grime = Math.min(1, style.grime * 1.3);
        floorMap(room.floor).areas.push({ ...rect, ...style, lit, room: room.id });
    }
    // Doors.
    let doorN = 0;
    const doorAt = new Map();
    const addDoor = (floor, x, y, kind, rooms, extra = {}) => {
        const id = `D${++doorN}`;
        const state = kind === 'locked' || kind === 'cell' ? 'locked' : kind === 'secret' ? 'hidden' : kind === 'arch' ? 'open' : 'closed';
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
    // The fronts of the cells: iron bars either side of the cell door.
    for (const d of Object.values(place.doors)) {
        if (d.kind !== 'cell') continue;
        const [ra, rb] = d.rooms.map(id => place.rooms[id]);
        if (!ra || !rb) continue;
        for (const [x, y] of sharedWall(ra.rect, rb.rect)) if (chars[d.floor][y]?.[x] === '#') chars[d.floor][y][x] = 'I';
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
        // Hedges and fences (a garden left inside a ruin) never get windows.
        if (recipeFor(room.type).wall === 'hedge') continue;
        if (pr?.windows !== 'none' && (pr?.windows === 'barred' || pr?.windows === 'normal' || (!ROUGH.has(plan.theme) && levelOf(room.floor) >= 0 && room.type !== 'vault'))) {
            const bars = pr?.windows === 'barred' || (plan.barred && pr?.windows !== 'normal');
            outside.forEach(([x, y], i) => { if (i % 3 === 1 && c[y][x] === '#' && !doorAt.has(`${room.floor}:${x},${y}`)) c[y][x] = bars ? 'H' : '|'; });
        }
    }
    // An exit room walled in by other rooms on this layout isn't a way out here. The place still needs
    // one: if no exit room reached the outside, the lowest room above ground with an outside wall gets the door.
    for (const rm of Object.values(place.rooms)) if (rm.exit && !place.exits.some(e => place.doors[e.door]?.rooms.includes(rm.id))) rm.exit = false;
    if (!place.exits.length && (plan.building || plan.kind === 'interior' || plan.rooms.some(x => x.exit))) {
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
        furnish(r, room, pr.rect, { chars: chars[pr.floor], props: map.props, blocked, reserved: res }, plan.theme, plan.condition);
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
    // A barred cell door: locked, shut (but unlocked), or swung open.
    if (door.kind === 'cell') return door.state === 'locked' ? 'J' : door.state === 'open' ? '/' : 'j';
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
        walled: d.walled === true || arr(d.features).some(f => /\bwall|fortif|rampart|fortress town|walled/.test(str(f).toLowerCase())),
    };
}

/**
 * A town building's shape on its plot (w wide, d deep; local y = 0 is its front, on the road): an L
 * (a back corner left as a yard), a front gable over the door, a round corner turret, a rounded bay
 * window, a wooden porch, or now and then a plain block. Blocks get their own roofs; rounds (the
 * turret, the bay) are drawn under a cone or a half-dome.
 */
function houseShape(r, w, d) {
    const mid = Math.floor(w / 2);
    const kind = pickR(r, w >= 6 && d >= 5 ? ['L', 'gable', 'tower', 'bay', 'porch', 'L', 'gable', 'rect'] : ['gable', 'bay', 'porch', 'rect', 'L']);
    const blocks = [], rounds = [];
    if (kind === 'L') {
        const cw = Math.max(2, Math.ceil(w * 0.4)), cd = Math.max(2, Math.ceil(d * 0.45)), cutLeft = r() < 0.5;
        blocks.push({ x: 0, y: 0, w, h: d - cd }, { x: cutLeft ? cw : 0, y: d - cd, w: w - cw, h: cd });
    } else if (kind === 'gable') {
        blocks.push({ x: 0, y: 1, w, h: d - 1 }, { x: Math.max(0, mid - 1), y: 0, w: Math.min(3, w), h: Math.min(3, d) });
    } else blocks.push({ x: 0, y: 0, w, h: d });
    if (kind === 'tower') rounds.push({ cx: r() < 0.5 ? 0 : w - 1, cy: 0, rad: 1.3, half: false });
    if (kind === 'bay') { const bx = mid + (r() < 0.5 ? -2 : 2); if (bx >= 1 && bx <= w - 2) rounds.push({ cx: bx, cy: 0, rad: 1, half: true }); }
    return { kind, blocks, rounds, door: { x: mid, y: 0 }, porch: kind === 'porch' };
}

/** How far the town is moved in to fit its walls (2 squares of woods outside, the wall 2 thick, 1 inside). */
const TOWN_WALL_PAD = 5;

/** Bright town colours: plaster in many tints, and roofs in reds, terracotta, greens, blues and purples. */
const ROOF_HUES = [4, 12, 20, 28, 120, 140, 200, 215, 265, 330];
function townLook(r) {
    return pickR(r, [
        { wall: 'plaster', wallColor: [pickR(r, [42, 30, 50, 15, 200, 90, 350, 270, 160, 190, 55]), int(r, 28, 48), int(r, 64, 78)] },
        { wall: 'plaster', wallColor: [pickR(r, [42, 30, 50, 15, 200, 90, 350, 270, 160, 190, 55]), int(r, 28, 48), int(r, 64, 78)] },
        { wall: 'timber', wallColor: [pickR(r, [38, 30, 45, 50]), int(r, 22, 34), int(r, 60, 74)] },
        { wall: 'brick', wallColor: [pickR(r, [8, 14, 20, 25]), int(r, 32, 48), int(r, 32, 42)] },
        { wall: 'stoneblock', wallColor: [pickR(r, [30, 40, 210]), int(r, 6, 12), int(r, 50, 62)] },
        { wall: 'log', wallColor: [26, int(r, 35, 45), int(r, 28, 36)] },
    ]);
}

/**
 * Put a shaped building on its plot in a town. side "n" = north of the road (its front at the bottom
 * row of the plot), "s" = south (front at the top row). Returns the door square.
 */
function buildHouse(map, set, r, b, x, y, w, d, side) {
    const shape = houseShape(r, w, d);
    const toWorld = (lx, ly) => [x + lx, side === 'n' ? y + ly : y + d - 1 - ly];
    const cells = new Set();
    for (const bl of shape.blocks) for (let lx = bl.x; lx < bl.x + bl.w; lx++) for (let ly = bl.y; ly < bl.y + bl.h; ly++) cells.add(K(lx, ly));
    for (const rd of shape.rounds) for (const [lx, ly] of roundTiles(rd)) cells.add(K(lx, ly));
    for (const k of cells) { const [lx, ly] = k.split(',').map(Number); set(...toWorld(lx, ly), '#'); }
    const [dx, dy] = toWorld(shape.door.x, shape.door.y);
    set(dx, dy, '+');
    // Windows along every stretch of front that faces the street.
    for (const k of cells) {
        const [lx, ly] = k.split(',').map(Number);
        if (cells.has(K(lx, ly - 1)) || Math.abs(lx - shape.door.x) < 2 || (lx + ly) % 2) continue;
        set(...toWorld(lx, ly), '|');
    }
    const hue = pickR(r, ROOF_HUES), sat = int(r, 42, 58);
    const style = /farm|stable|barn/.test(b.kind) ? 'thatch' : /temple|church|bank|hall|guard/.test(b.kind) ? 'slate' : 'shingle';
    for (const bl of shape.blocks) {
        const exposed = [...Array(bl.w).keys()].some(i => !cells.has(K(bl.x + i, bl.y - 1)));
        const rows = exposed ? bl.h - 1 : bl.h;
        if (rows <= 0) continue;
        const wy = side === 'n' ? y + bl.y + (exposed ? 1 : 0) : y + d - bl.y - bl.h;
        map.roofs.push({ x: x + bl.x, y: wy, w: bl.w, h: rows, shape: rows >= 2 && bl.w >= 2 ? pickR(r, ['hip', 'gable', 'gable']) : 'gable', ridge: bl.w >= rows ? 'h' : 'v', hue, sat, style });
    }
    for (const rd of shape.rounds) {
        const [wcx, wcy] = toWorld(rd.cx, rd.cy);
        if (rd.half) map.roofs.push({ x: wcx - Math.ceil(rd.rad), w: Math.ceil(rd.rad) * 2 + 1, y: side === 'n' ? wcy - Math.ceil(rd.rad) : wcy + 1, h: Math.ceil(rd.rad), shape: 'apse', up: side !== 'n', hue, sat, style });
        else map.roofs.push({ x: Math.round(wcx - rd.rad), y: Math.round(wcy - rd.rad), w: Math.round(rd.rad * 2) + 1, h: Math.round(rd.rad * 2) + 1, shape: 'cone', hue, sat, style });
    }
    // A wooden porch over the door, on two posts.
    if (shape.porch) {
        const py = side === 'n' ? dy - 1 : dy + 1;
        map.props.push({ x: dx - 1, y: py, type: 'pillar' }, { x: dx + 1, y: py, type: 'pillar' });
        map.roofs.push({ x: dx - 1, y: py, w: 3, h: 1, shape: 'porch' });
    }
    return { dx, dy, porch: shape.porch, cells: [...cells].map(k => toWorld(...k.split(',').map(Number))) };
}

/**
 * A town wall: the town moved in from the edges, a curtain wall (battlements) all round it, round
 * towers at the corners, a gatehouse with two round towers wherever a road goes out, the roads carried
 * on to the edge, and woods outside. Returns the new grid, or null if it would be too big.
 */
function wallTown(place, map, c, r, roads) {
    const pad = TOWN_WALL_PAD, W = map.w + pad * 2, H = map.h + pad * 2;
    if (W > MAX_PLACE_SIZE || H > MAX_PLACE_SIZE) return null;
    const g = [...Array(H)].map(() => Array(W).fill('.'));
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) g[y + pad][x + pad] = c[y][x];
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = ch; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? g[y][x] : '%');
    const shift = o => { if (o && typeof o.x === 'number') { o.x += pad; o.y += pad; } };
    map.props.forEach(shift); map.areas.forEach(shift); map.roofs.forEach(shift);
    Object.values(place.doors).forEach(shift);
    Object.values(place.buildings).forEach(b => shift(b.rect));
    map.w = W; map.h = H;
    // The wall ring, 2 thick, 2 squares in from the edge.
    const a = 2, b = 3, x1 = W - 3, x0 = W - 4, y1 = H - 3, y0 = H - 4;
    const onRing = (x, y) => (x === a || x === b || x === x0 || x === x1) && y >= a && y <= y1 || (y === a || y === b || y === y0 || y === y1) && x >= a && x <= x1;
    for (let x = a; x <= x1; x++) for (let y = a; y <= y1; y++) if (onRing(x, y)) set(x, y, '#');
    map.areas.push({ x: 0, y: 0, w: W, h: H, wall: 'stoneblock', building: 'W' });
    map.roofs.push(
        { x: a, y: a, w: x1 - a + 1, h: 2, shape: 'battlement' }, { x: a, y: y0, w: x1 - a + 1, h: 2, shape: 'battlement' },
        { x: a, y: a + 2, w: 2, h: y0 - a - 2, shape: 'battlement' }, { x: x0, y: a + 2, w: 2, h: y0 - a - 2, shape: 'battlement' },
    );
    // Gates where the roads go out: the road runs through the wall, a round tower either side.
    const towersAt = [];
    for (const rd of roads) {
        if (rd.axis === 'x') {
            for (const ry of rd.at) { const yy = ry + pad; for (let x = 0; x < W; x++) if (x < pad || x >= W - pad) set(x, yy, '='); }
            const lo = Math.min(...rd.at) + pad - 1, hi = Math.max(...rd.at) + pad + 1;
            for (const gx of [a + 0.5, x0 + 0.5]) towersAt.push([gx, lo - 0.8], [gx, hi + 0.8]);
        } else {
            for (const rx of rd.at) { const xx = rx + pad; for (let y = 0; y < H; y++) if (y < pad || y >= H - pad) set(xx, y, '='); }
            const lo = Math.min(...rd.at) + pad - 1, hi = Math.max(...rd.at) + pad + 1;
            for (const gy of [a + 0.5, y0 + 0.5]) towersAt.push([lo - 0.8, gy], [hi + 0.8, gy]);
        }
    }
    for (const [cx, cy] of [[a + 0.5, a + 0.5], [x0 + 0.5, a + 0.5], [a + 0.5, y0 + 0.5], [x0 + 0.5, y0 + 0.5]]) towersAt.push([cx, cy, 2.3]);
    for (const [cx, cy, rad = 1.6] of towersAt) {
        for (const [x, y] of roundTiles({ cx, cy, rad, half: false })) if (get(x, y) !== '=') set(x, y, '#');
        const w = Math.round(rad * 2) + 1;
        map.roofs.push({ x: Math.round(cx - rad), y: Math.round(cy - rad), w, h: w, shape: 'cone', style: 'slate' });
    }
    // Woods outside the walls (the roads kept clear).
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
        const out = x < a || x > x1 || y < a || y > y1;
        if (out && get(x, y) === '.' && r() < 0.55) set(x, y, 'T');
    }
    return { grid: g, pad };
}


/** Build a town: a main road (and a cross road) lined with roofed buildings, signs, a square and greenery. */
export function generateTown(planIn, seed = 1) {
    const plan = planIn?.normalized ? planIn : normalizeTownPlan(planIn);
    const r = rng(seed);
    const feats = new Set(plan.features);
    const wantsSquare = plan.walled || ['square', 'market', 'fountain', 'plaza', 'well'].some(f => [...feats].some(x => x.includes(f)));
    const north = [], south = [];
    plan.buildings.forEach((b, i) => (i % 2 ? south : north).push(b));
    const dims = b => { const [w, d] = BUILDING_SIZES[b.size]; return { w: w + int(r, 0, 1), d: d + int(r, 0, 1) }; };
    const sized = new Map(plan.buildings.map(b => [b.id, dims(b)]));
    const cross = plan.layout === 'crossroads';
    const rowWidth = list => list.reduce((n, b) => n + sized.get(b.id).w + 2, 0);
    // A crowded town: the widest buildings shrink (never below small) until every one fits on its side of the road.
    const roomFor = MAX_PLACE_SIZE - (plan.walled ? TOWN_WALL_PAD * 2 : 0) - 6 - (cross ? 4 : 0);
    for (let guard = 0; guard < 60 && Math.max(rowWidth(north) + (wantsSquare ? 9 : 0), rowWidth(south)) > roomFor; guard++) {
        const row = rowWidth(north) + (wantsSquare ? 9 : 0) >= rowWidth(south) ? north : south;
        const widest = row.map(b => sized.get(b.id)).sort((a, b2) => b2.w - a.w)[0];
        if (!widest || widest.w <= 4) break;
        widest.w -= 1;
    }
    const crowded = Math.max(rowWidth(north) + (wantsSquare ? 9 : 0), rowWidth(south)) > roomFor - 6;
    let W = Math.max(26, Math.max(rowWidth(north) + (wantsSquare ? 9 : 0), rowWidth(south)) + 6 + (cross ? 4 : 0));
    // A walled town leaves room for its walls round it.
    const room = MAX_PLACE_SIZE - (plan.walled ? TOWN_WALL_PAD * 2 : 0);
    W = Math.min(W, room);
    const dS = Math.max(4, ...south.map(b => sized.get(b.id).d)), dN = Math.max(4, ...north.map(b => sized.get(b.id).d));
    const margin = 3;
    const roadY = margin + dS + 1;
    const H = Math.min(room, roadY + 2 + 1 + dN + margin);
    let c = [...Array(H)].map(() => Array(W).fill('.'));
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
            // Each building its own shape (an L, a front gable, a turret, a bay, a porch) and colours.
            const house = buildHouse(map, set, r, b, x, y, w, d, side);
            const dx = house.dx;
            const pathY = side === 'n' ? frontY - 1 : frontY + 1;
            set(dx, pathY, '=');
            map.areas.push({ x, y, w, h: d, ...townLook(r), building: b.id });
            const id = `D${++doorN}`;
            place.doors[id] = { id, floor: 'F0', x: dx, y: frontY, kind: 'door', state: 'closed', rooms: [null, null], enter: b.id };
            place.buildings[b.id] = { ...b, door: id, rect: { x, y, w, h: d }, interior: null };
            // A sign for any shop or public building, hanging over the street.
            const isWallAt = (wx, wy) => house.cells.some(([cx, cy]) => cx === wx && cy === wy);
            if ((b.kind !== 'house' || b.sign) && (isWallAt(dx + 1, frontY) || isWallAt(dx - 1, frontY))) {
                const sx = isWallAt(dx + 1, frontY) ? dx + 1 : dx - 1;
                set(sx, frontY, '#');
                map.props.push({ x: sx, y: frontY, type: 'sign', facing: side === 'n' ? 's' : 'n', icon: signIcon(`${b.kind} ${b.sign} ${b.name}`), label: b.sign || b.name });
            }
            // Flowers or barrels by the door.
            const sideX = dx - 1 >= x ? dx - 1 : dx + 1;
            if (!house.porch && get(sideX, pathY) === '.') map.props.push({ x: sideX, y: pathY, type: /tavern|inn|brew|store|shop|smith/.test(b.kind) ? pickR(r, ['barrel', 'crate']) : 'flowers' });
            if (/stable|farm/.test(b.kind)) { map.props.push({ x: x + w, y: pathY, type: 'hay' }); map.props.push({ x: x - 1, y: pathY, type: 'trough' }); }
            x += w + (crowded ? 1 : int(r, 1, 3));
            // Now and then a fence or a bush in the gap.
            if (r() < 0.35 && get(x - 1, y) === '.') map.props.push({ x: x - 1, y: side === 'n' ? y : y, type: 'fence', h: Math.max(1, d - 1) });
        });
    };
    lay(north, 'n');
    lay(south, 's');
    // Lampposts along the road, a cart, trees around the edge, a pond or a graveyard if asked for.
    for (let x = 4, i = 0; x < W - 2; x += 7, i++) { const y = i % 2 ? roadY + 2 : roadY - 1; if (get(x, y) === '.') map.props.push({ x, y, type: 'lamppost' }); }
    // A cart on the road, never in front of anyone's door.
    if (r() < 0.8) {
        const doors = Object.values(place.doors).map(d => d.x);
        const spots = [...Array(W - 6).keys()].map(i => i + 2).filter(x => doors.every(dx => Math.abs(dx - x) > 2) && (!cross || Math.abs(x - crossX) > 3));
        if (spots.length) map.props.push({ x: pickR(r, spots), y: roadY, type: 'cart' });
    }
    // A pond (asked for, or now and then anyway) in the open ground at the edge of town.
    if ([...feats].some(f => f.includes('pond') || f.includes('lake')) || r() < 0.4) {
        const spots = [];
        for (let x = 5; x < W - 5; x++) for (let y = 3; y < H - 3; y++) { let ok = true; for (let i = -4; ok && i <= 4; i++) for (let j = -3; ok && j <= 3; j++) ok = get(x + i, y + j) === '.'; if (ok) spots.push([x, y]); }
        if (spots.length) addWater(c, W, H, r, 'pond', pickR(r, spots));
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
    // A walled town: walls, towers and gatehouses round it all, the roads out through the gates.
    let pad = 0;
    if (plan.walled) {
        const walled = wallTown(place, map, c, r, [{ axis: 'x', at: [roadY, roadY + 1] }, ...(cross ? [{ axis: 'y', at: [crossX, crossX + 1] }] : [])]);
        if (walled) { c = walled.grid; pad = walled.pad; }
    }
    const MW = map.w, MH = map.h;
    // The road's ends lead out of town.
    for (const y of [roadY + pad, roadY + 1 + pad]) { place.exits.push({ floor: 'F0', x: 0, y }, { floor: 'F0', x: MW - 1, y }); }
    if (cross) for (const x of [crossX + pad, crossX + 1 + pad]) { place.exits.push({ floor: 'F0', x, y: 0 }, { floor: 'F0', x, y: MH - 1 }); }
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    place.start = { floor: 'F0', x: pad + 1, y: roadY + pad, room: null };
    place.state.explored.F0 = '1'.repeat(MW * MH);
    return place;
}

/** What the land around a building looks like, from the words in its plan. */
function groundsTheme(plan) {
    const w = `${plan.name} ${plan.kind} ${plan.summary}`.toLowerCase();
    return /jungle|rainforest|tropic/.test(w) ? 'jungle' : /snow|winter|frozen|frost|tundra|ice\b/.test(w) ? 'snow' : /desert|dune|sand\b|oasis/.test(w) ? 'desert' : /swamp|marsh|bog|bayou|fen\b/.test(w) ? 'swamp' : /\bcity\b|\btown\b|village|street|market|square/.test(w) ? 'town' : 'forest';
}

/** What kind of outdoor area a room of the plan is, from its name and type. */
function yardKind(yd) {
    // The name says what it is (the room types file a garden under courtyard).
    const n = String(yd.name).toLowerCase();
    return /gate|entrance|drive|front yard|approach|porch|veranda/.test(n) ? 'gate'
        : /grave|cemetery|tomb/.test(n) ? 'graveyard'
            : /stable|paddock|pasture|barn|corral/.test(n) ? 'stable'
                : /orchard|grove/.test(n) ? 'orchard'
                    : /garden|lawn|hedge|maze|flower|rose|herb|vegetable|green/.test(n) ? 'garden'
                        : /court|plaza|square|terrace|patio|yard|bailey/.test(n) ? 'courtyard'
                            : yd.type === 'graveyard' ? 'graveyard' : 'garden';
}

/** Building shapes (seen from above) and fronts the plan can ask for. */
export const SHAPES = ['plain', 'L', 'gable', 'U', 'H', 'E', 'T', 'tower', 'castle'];
export const FRONTS = ['flat', 'bay', 'rotunda', 'portico', 'porch'];

/**
 * How a building looks from outside: the plan's "exterior" if it gave one, else what fits its kind.
 * shape: plain block, L / U / H / E with wings (E: a centre pavilion), T (a temple's transepts),
 * tower (one round tower), castle (curtain walls, corner towers, gatehouse, keep, maybe a moat).
 * front: flat, bay (rounded bay windows either side of the door), rotunda (a round entrance hall
 * bulging out, the door in its curve), portico (columns and a roof over the door).
 */
export function exteriorOf(plan, r = Math.random) {
    const e = plan.exterior || {};
    const k = `${plan.kind} ${plan.name}`.toLowerCase();
    const castle = /castle|fortress|citadel|stronghold|\bkeep\b/.test(k) && !/ruin/.test(k);
    const grand = GRAND_KINDS.test(k);
    const shape = SHAPES.includes(e.shape) ? e.shape
        : castle ? 'castle' : /tower|lighthouse|observatory|spire/.test(k) ? 'tower' : grand ? pickR(r, ['U', 'H', 'E', 'U', 'L'])
            : /temple|church|cathedral|chapel|abbey|monastery/.test(k) ? 'T' : pickR(r, ['L', 'gable', 'L', 'gable', 'plain']);
    const front = FRONTS.includes(e.front) ? e.front
        : shape === 'castle' || shape === 'tower' ? 'flat' : grand ? pickR(r, ['rotunda', 'portico', 'bay', 'rotunda'])
            : /temple|church|cathedral|bank|library|academy|museum|hall/.test(k) ? 'portico' : pickR(r, ['porch', 'bay', 'flat', 'porch']);
    const towers = Number.isFinite(Number(e.towers)) && e.towers !== null && e.towers !== '' ? clamp(Math.round(Number(e.towers)), 0, 4) : shape === 'castle' ? 4 : grand ? pickR(r, [0, 2, 2, 4]) : pickR(r, [0, 0, 0, 1]);
    return {
        shape, front, towers, grand: grand || shape === 'castle',
        wall: typeof e.wall === 'boolean' ? e.wall : shape === 'castle',
        moat: typeof e.moat === 'boolean' ? e.moat : shape === 'castle' && r() < 0.5,
    };
}

/**
 * A building's footprint, in squares from the main block's front-left corner (x right, y toward the
 * back; the front is y < 0): blocks (each under its own hipped roof) and rounds (towers under cones,
 * a rotunda or bay windows under half-domes), and where its front door is.
 */
function footprint(ext, bw, bd) {
    const blocks = [], rounds = [];
    const mid = Math.floor(bw / 2);
    let door = { x: mid, y: 0 };
    if (ext.shape === 'tower') {
        const rad = Math.max(3, Math.floor(Math.min(bw, bd) / 2));
        rounds.push({ cx: rad, cy: rad, rad, half: false });
        return { blocks, rounds, door: { x: rad, y: 0 } };
    }
    blocks.push({ x: 0, y: 0, w: bw, h: bd });
    const ww = clamp(Math.round(bw * 0.32), 4, 7), wd = clamp(Math.round(bd * 0.6), 3, 6);
    const wings = { L: [[0, -wd]], U: [[0, -wd], [bw - ww, -wd]], H: [[0, -wd], [bw - ww, -wd], [0, bd], [bw - ww, bd]], E: [[0, -wd], [bw - ww, -wd]] }[ext.shape] ?? [];
    for (const [x, y] of wings) blocks.push({ x, y, w: ww, h: wd });
    if (ext.shape === 'E') { blocks.push({ x: mid - 2, y: -2, w: 5, h: 2 }); door = { x: mid, y: -2 }; }
    if (ext.shape === 'gable') { const gw = bw >= 9 ? 5 : 3; blocks.push({ x: mid - Math.floor(gw / 2), y: -2, w: gw, h: 3 }); door = { x: mid, y: -2 }; }
    if (ext.shape === 'T') { const ty = Math.max(1, Math.floor(bd / 2) - 2); blocks.push({ x: -3, y: ty, w: 3, h: 4 }, { x: bw, y: ty, w: 3, h: 4 }); }
    if (ext.front === 'rotunda' && ext.shape !== 'E' && ext.shape !== 'gable') {
        const rad = bw >= 12 ? 3 : 2;
        rounds.push({ cx: mid, cy: 0, rad, half: true });
        door = { x: mid, y: -rad };
    }
    if (ext.front === 'bay' && ext.shape !== 'E' && ext.shape !== 'gable') {
        const off = Math.max(3, Math.floor(bw / 4));
        for (const bx of [mid - off, mid + off]) {
            const clear = !wings.some(([wx, wy]) => wy < 0 && bx >= wx - 1 && bx <= wx + ww);
            if (bx >= 1 && bx <= bw - 2 && clear) rounds.push({ cx: bx, cy: 0, rad: 1, half: true });
        }
    }
    // Round towers at the outer corners (the front two first).
    if (ext.towers) {
        const xs = blocks.flatMap(b => [b.x, b.x + b.w - 1]), ys = blocks.flatMap(b => [b.y, b.y + b.h - 1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].slice(0, ext.towers)) rounds.push({ cx, cy, rad: 2, half: false });
    }
    return { blocks, rounds, door };
}

/** The squares a round covers (a half round: only its front half, in front of y = cy). */
function roundTiles({ cx, cy, rad, half }) {
    const out = [];
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
        if (half && y >= cy) continue;
        const dy = half ? y - cy + 0.5 : y - cy;
        if ((x - cx) ** 2 + dy ** 2 <= rad * rad + 0.6) out.push([x, y]);
    }
    return out;
}

/**
 * A building's outside, as its own map. The house sits back from the edge, shaped like the real thing
 * (wings round a front court, a round entrance hall, bay windows, corner towers, a columned porch; or a
 * castle's walls, towers, gatehouse and keep), a drive or path leads up to its front door, and its
 * gardens and yards from the plan each get their own spot: beside it (gardens, courtyards, stable
 * yards), behind it (graveyards, orchards), or at the end of the drive (the gate, in a fence or hedge
 * round the grounds). The land around (trees, bushes, rocks for its setting) stays outside the grounds.
 * Walking through the front door goes inside (the interior is its own place). No way out at the edges:
 * the DM moves the story on.
 * @param {object} plan the building's normalized plan (its "outside" rooms, its "exterior")
 * @param {object} inside the generated interior (its ground floor sets the building's size)
 */
export function generateGrounds(plan, inside, seed = 1) {
    const r = rng(seed);
    const theme = groundsTheme(plan);
    const ext = exteriorOf(plan, r);
    const grand = ext.grand;
    const groundFloor = inside.floors.slice().sort((a, b) => Math.abs(a.level) - Math.abs(b.level))[0];
    // A grand house is wide and shallow (a long facade); others follow their ground floor.
    const bd = clamp(Math.round(groundFloor.map.h * 0.45), grand ? 7 : 5, grand ? 9 : 14);
    const bw = clamp(Math.max(Math.round(groundFloor.map.w * 0.55), grand ? Math.round(bd * 1.8) : 0), grand ? 13 : 7, ext.shape === 'castle' ? 16 : 22);
    // Where each outdoor area goes.
    const yards = (plan.outside || []).map(yd => ({ ...yd, kind: yardKind(yd) }));
    const gate = yards.find(y => y.kind === 'gate');
    const rest = yards.filter(y => y !== gate);
    const slots = { left: null, right: null, back: null };
    for (const yd of rest.filter(y => y.kind === 'graveyard' || y.kind === 'orchard')) if (!slots.back) slots.back = yd;
    for (const yd of rest.filter(y => !Object.values(slots).includes(y))) {
        const free = ['right', 'left', 'back'].find(s => !slots[s]);
        if (free) slots[free] = yd;
    }
    if (ext.shape === 'castle') return castleGrounds(plan, ext, theme, bw, bd, slots, gate, r, seed);
    const fp = footprint(ext, bw, bd);
    const cells = new Set();
    for (const b of fp.blocks) for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) cells.add(K(x, y));
    for (const rd of fp.rounds) for (const [x, y] of roundTiles(rd)) cells.add(K(x, y));
    const pts = [...cells].map(k => k.split(',').map(Number));
    const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0])), minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
    const fenced = grand || Boolean(gate);
    const sideW = 9, margin = 3, approach = (grand ? 7 : 5) + (ext.front === 'portico' ? 2 : 0), backH = slots.back ? 8 : 0;
    const left = slots.left ? sideW + 2 : 0, right = slots.right ? sideW + 2 : 0;
    const ox = margin + (fenced ? 1 : 0) + left - minX, oy = approach - minY;
    const W = Math.min(MAX_PLACE_SIZE, ox + maxX + 1 + 2 + right + margin + (fenced ? 1 : 0));
    const H = Math.min(MAX_PLACE_SIZE, oy + maxY + 1 + 2 + backH + margin);
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = ch; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const map = { w: W, h: H, rows: [], theme, props: [], areas: [], roofs: [], seed };
    const taken = (x, y) => map.props.some(p => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    const put = (x, y, type, extra = {}) => { if ('.=:,'.includes(get(x, y)) && !taken(x, y)) map.props.push({ x, y, type, ...extra }); };
    const place = {
        version: 1, kind: 'grounds', name: plan.name, theme, fog: false, seed, summary: plan.summary,
        floors: [{ id: 'F0', name: `Outside ${plan.name}`, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    // The building: its walls, its front door, windows along every exposed front, a roof for each part.
    for (const k of cells) { const [x, y] = k.split(',').map(Number); set(x + ox, y + oy, '#'); }
    const dx = fp.door.x + ox, dy = fp.door.y + oy;
    set(dx, dy, '+');
    const isWall = (x, y) => cells.has(K(x - ox, y - oy));
    for (const k of cells) {
        const [lx, ly] = k.split(',').map(Number), x = lx + ox, y = ly + oy;
        if (isWall(x, y - 1) || Math.abs(x - dx) < 2 || get(x, y) !== '#') continue;
        // A window on every other square of a front that faces out.
        if ((x + y) % 3 === 0) set(x, y, '|');
    }
    const wall = { mansion: 'stoneblock', castle: 'stoneblock', temple: 'stoneblock', prison: 'brick', cabin: 'log', tavern: 'timber', house: 'timber', library: 'stoneblock' }[plan.theme] ?? (grand ? 'stoneblock' : 'plaster');
    const hue = pickR(r, grand ? [8, 16, 24, 200, 210, 30, 350] : ROOF_HUES);
    const style = grand || /castle|temple|prison|library|mansion/.test(plan.theme) ? 'slate' : /cabin|barn|farm/.test(`${plan.theme} ${plan.kind}`) ? 'thatch' : 'shingle';
    for (const b of fp.blocks) {
        const x = b.x + ox, y = b.y + oy;
        map.areas.push({ x, y, w: b.w, h: b.h, wall, building: 'B1' });
        // Leave the front row showing (windows, the door) where it faces out.
        const exposed = [...Array(b.w).keys()].some(i => !isWall(x + i, y - 1));
        map.roofs.push({ x, y: exposed ? y + 1 : y, w: b.w, h: exposed ? b.h - 1 : b.h, shape: 'hip', hue, style, chimney: b === fp.blocks[0] });
    }
    for (const rd of fp.rounds) {
        const x = Math.round(rd.cx - rd.rad) + ox, w = Math.round(rd.rad * 2) + 1;
        if (rd.half) map.roofs.push({ x, y: rd.cy + oy - Math.ceil(rd.rad), w, h: Math.ceil(rd.rad), shape: 'apse', hue, style });
        else map.roofs.push({ x, y: Math.round(rd.cy - rd.rad) + oy, w, h: w, shape: 'cone', hue, style });
    }
    // A wooden porch over the door on two posts, or a columned portico.
    if (ext.front === 'porch') {
        put(dx - 1, dy - 1, 'pillar'); put(dx + 1, dy - 1, 'pillar');
        map.roofs.push({ x: dx - 1, y: dy - 1, w: 3, h: 1, shape: 'porch' });
    }
    if (ext.front === 'portico') {
        for (const px of [dx - 2, dx + 2]) for (const py of [dy - 1, dy - 2]) put(px, py, 'pillar');
        map.roofs.push({ x: dx - 2, y: dy - 2, w: 5, h: 2, shape: 'portico' });
    }
    // The drive (cobbles for a grand house or in town, a dirt path otherwise), wider for a grand one.
    const road = grand || theme === 'town' ? '=' : ':';
    for (let y = dy - 1; y >= 0; y--) { set(dx, y, road); if (grand) set(dx + 1, y, road); }
    if (grand) {
        // Flowers lining the drive, a fountain on the lawn, a low hedge in front of the house.
        for (let y = 2; y < dy - 2; y += 2) { put(dx - 1, y, 'flowers'); put(dx + 2, y, 'flowers'); }
        const fx = dx + 5, fy = Math.max(2, Math.floor((oy + minY) / 2) - 1);
        if (get(fx, fy) === '.' && get(fx + 1, fy + 1) === '.' && !isWall(fx, fy + 2)) put(fx, fy, 'fountain', { w: 2, h: 2 });
        const hedgeY = oy + minY - 1;
        for (let x = ox + minX; x <= ox + maxX; x++) if ((x < dx - 2 || x > dx + 3) && !isWall(x, hedgeY)) put(x, hedgeY, 'bush');
    } else if (ext.front !== 'porch') {
        put(dx - 1, dy - 1, /tavern|inn|shop|store/.test(plan.kind) ? 'barrel' : 'flowers');
        put(dx + 1, dy - 1, 'flowers');
    }
    if (/tavern|inn|shop|store|guild|bank/.test(plan.kind)) {
        const sx = isWall(dx + 2, dy) ? dx + 2 : dx - 2;
        if (isWall(sx, dy)) { set(sx, dy, '#'); map.props.push({ x: sx, y: dy, type: 'sign', facing: 's', icon: signIcon(`${plan.kind} ${plan.name}`), label: plan.name }); }
    }
    place.doors.D1 = { id: 'D1', floor: 'F0', x: dx, y: dy, kind: 'door', state: 'closed', rooms: [null, null], enter: 'B1' };
    place.buildings.B1 = { id: 'B1', name: plan.name, kind: plan.kind, door: 'D1', rect: { x: ox + minX, y: oy + minY, w: maxX - minX + 1, h: maxY - minY + 1 }, interior: null, enterable: true, description: plan.summary };
    // The grounds' edge: a fence (a hedge for a grand house) all round, open where the drive comes in.
    const fx0 = margin - 1, fx1 = W - margin, fy1 = H - 2;
    if (fenced) {
        const hedge = grand ? 'bush' : 'fence';
        for (let x = fx0; x <= fx1; x++) if (x < dx - 1 || x > dx + (grand ? 2 : 1)) put(x, 1, hedge);
        for (let y = 2; y <= fy1; y++) { put(fx0, y, hedge); put(fx1, y, hedge); }
        for (let x = fx0; x <= fx1; x++) put(x, fy1, hedge);
        put(dx - 2, 0, 'lamppost'); put(dx + (grand ? 3 : 2), 0, 'lamppost');
    }
    const bx0 = ox + minX, bx1 = ox + maxX, by0 = oy + minY, by1 = oy + maxY;
    layYards(place, map, { set, get, put, taken }, r, slots, gate, {
        left: { x: margin + (fenced ? 1 : 0), y: by0, w: sideW, h: by1 - by0 + 1 },
        right: { x: bx1 + 3, y: by0, w: sideW, h: by1 - by0 + 1 },
        back: { x: bx0, y: by1 + 3, w: bx1 - bx0 + 1, h: Math.max(3, backH - 3) },
        gate: { x: dx - 2, y: 0, w: 5 + (grand ? 1 : 0), h: 3 },
    }, W, H);
    // The land: thick trees outside the grounds (or at the map's edges), an odd bush or rock on the lawn.
    const inGrounds = (x, y) => fenced ? x > fx0 && x < fx1 && y > 1 && y < fy1 : x > 1 && x < W - 2 && y > 1 && y < H - 2;
    const keep = (x, y) => (x >= bx0 - 1 && x <= bx1 + 1 && y >= by0 - 1 && y <= by1 + 1) || Math.abs(x - dx) <= 2 && y < dy
        || Object.values(place.rooms).some(rm => x >= rm.rect.x - 1 && x <= rm.rect.x + rm.rect.w && y >= rm.rect.y - 1 && y <= rm.rect.y + rm.rect.h);
    wilds(map, c, { get, set, put, taken }, r, theme, W, H, inGrounds, keep, grand);
    outsidePeople(place, plan, r, get, taken, dx, dy);
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    place.start = { floor: 'F0', x: dx, y: 0, room: gate?.id ?? null };
    place.state.explored.F0 = '1'.repeat(W * H);
    return place;
}

/** Each outdoor area of the plan, in its spot, laid out for what it is. */
function layYards(place, map, { set, get, put, taken }, r, slots, gate, rects, W, H) {
    const lay = (yd, rect) => {
        rect = { ...rect, w: Math.max(3, Math.min(rect.w, W - 1 - rect.x)), h: Math.max(3, Math.min(rect.h, H - 2 - rect.y)) };
        place.rooms[yd.id] = { id: yd.id, name: yd.name, type: yd.type, floor: 'F0', rect, lit: true, description: yd.description, exit: false };
        const { x, y, w, h } = rect;
        const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
        if (yd.kind === 'courtyard') {
            for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) set(i, j, '=');
            put(cx - 1, cy - 1, 'fountain', { w: 2, h: 2 });
            for (const [i, j] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) put(i, j, 'statue');
        } else if (yd.kind === 'stable') {
            for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) set(i, j, ':');
            put(x, y + h - 1, 'hay'); put(x + 1, y + h - 1, 'hay'); put(x + w - 1, y + h - 1, 'trough'); put(cx, y, 'cart');
            for (let j = y; j < y + h; j++) put(x + w - 1, j, 'fence');
        } else if (yd.kind === 'graveyard') {
            for (let i = x + 1; i < x + w - 1; i += 2) for (let j = y + 1; j < y + h; j += 2) put(i, j, 'tombstone');
            put(cx, y + h - 1, 'statue');
            for (let i = x; i < x + w; i++) put(i, y, 'fence');
        } else if (yd.kind === 'orchard') {
            for (let i = x + 1; i < x + w - 1; i += 2) for (let j = y + 1; j < y + h - 1; j += 2) set(i, j, 'T');
        } else if (yd.kind !== 'gate') {
            // A garden: beds of flowers in rows either side of a centre path, bushes at the corners, a statue in the middle.
            for (let j = y; j < y + h; j++) set(cx, j, ':');
            for (let i = x; i < x + w; i++) for (let j = y + 1; j < y + h - 1; j += 2) if (i !== cx) put(i, j, 'flowers');
            for (const [i, j] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) put(i, j, 'bush');
            if (h >= 5) put(cx, cy, 'statue');
        }
        for (const p of yd.props || []) if (PROPS[p.type]) for (let k = 0; k < (p.count || 1); k++) {
            for (let tries = 0; tries < 10; tries++) { const i = int(r, x, x + w - 1), j = int(r, y, y + h - 1); if (get(i, j) !== 'T' && !taken(i, j)) { put(i, j, p.type); break; } }
        }
    };
    for (const [slot, yd] of Object.entries(slots)) if (yd && rects[slot]) lay(yd, rects[slot]);
    if (gate && rects.gate) lay(gate, rects.gate);
}

/** Trees, bushes and rocks: thick outside the grounds, now and then on the lawn. */
function wilds(map, c, { get, set, put, taken }, r, theme, W, H, inGrounds, keep, grand) {
    // Outside the grounds: the land, grown thick for its setting (towns: a few trees).
    if (theme === 'town') {
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (get(x, y) === '.' && !keep(x, y) && !taken(x, y) && !inGrounds(x, y) && r() < 0.08) set(x, y, 'T');
    } else growWilds(map, c, W, H, r, theme, (x, y) => inGrounds(x, y) || keep(x, y) || taken(x, y));
    // On the lawn: a garden pond now and then, a bush or rock or flowers here and there.
    if (theme !== 'desert' && theme !== 'snow' && r() < 0.55) {
        const spots = [];
        for (let x = 3; x < W - 3; x++) for (let y = 3; y < H - 3; y++) {
            let ok = inGrounds(x, y);
            for (let i = -2; ok && i <= 2; i++) for (let j = -2; ok && j <= 2; j++) ok = get(x + i, y + j) === '.' && !keep(x + i, y + j) && !taken(x + i, y + j) && inGrounds(x + i, y + j);
            if (ok) spots.push([x, y]);
        }
        if (spots.length) addWater(c, W, H, r, 'pool', pickR(r, spots));
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
        if (get(x, y) !== '.' || keep(x, y) || taken(x, y) || !inGrounds(x, y)) continue;
        if (r() < (grand ? 0.012 : 0.03)) put(x, y, theme === 'desert' ? 'boulder' : pickR(r, ['bush', 'flowers', 'boulder', 'tallgrass']));
    }
}

/** Whoever is out in the yard (from the plan's outdoor rooms). */
function outsidePeople(place, plan, r, get, taken, dx, dy) {
    for (const g of plan.outsideGuards || []) {
        const rm = place.rooms[g.room] ?? Object.values(place.rooms)[0];
        let spot = [dx + 2, Math.max(0, dy - 2)];
        if (rm) for (let tries = 0; tries < 20; tries++) { const i = int(r, rm.rect.x, rm.rect.x + rm.rect.w - 1), j = int(r, rm.rect.y, rm.rect.y + rm.rect.h - 1); if ('.=:,'.includes(get(i, j)) && !taken(i, j)) { spot = [i, j]; break; } }
        place.guards[g.name] = { name: g.name, description: g.description, hostile: g.hostile !== false, ...(g.sprite ? { sprite: g.sprite } : {}), room: rm?.id ?? null, patrol: [rm?.id].filter(Boolean), step: 0, floor: 'F0', x: spot[0], y: spot[1], state: 'patrol' };
    }
}

/**
 * A castle from outside: a curtain wall (battlements along the top) round a bailey, round towers at
 * its corners, a gatehouse in the front wall with the way in through it, maybe a moat with a bridge,
 * and the keep (the castle's inside) in the bailey facing the gate, with turrets on its corners. The
 * plan's yards go in the bailey; the road leads up to the gate from the edge of the map.
 */
function castleGrounds(plan, ext, theme, bw, bd, slots, gate, r, seed) {
    const sideW = 9, margin = 3, moatW = ext.moat ? 4 : 0;
    const left = slots.left ? sideW + 1 : 3, right = slots.right ? sideW + 1 : 3, front = 8, back = slots.back ? 9 : 3;
    // Inner bailey, then the wall (2 thick) round it, the moat and the margin outside.
    const bx0 = margin + moatW + 2, by0 = margin + 2 + moatW + 2;
    const iw = left + bw + right, ih = front + bd + back;
    const W = Math.min(MAX_PLACE_SIZE, bx0 + iw + 2 + moatW + margin), H = Math.min(MAX_PLACE_SIZE, by0 + ih + 2 + moatW + margin);
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = ch; };
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const map = { w: W, h: H, rows: [], theme, props: [], areas: [], roofs: [], seed };
    const taken = (x, y) => map.props.some(p => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    const put = (x, y, type, extra = {}) => { if ('.=:,'.includes(get(x, y)) && !taken(x, y)) map.props.push({ x, y, type, ...extra }); };
    const place = {
        version: 1, kind: 'grounds', name: plan.name, theme, fog: false, seed, summary: plan.summary,
        floors: [{ id: 'F0', name: `Outside ${plan.name}`, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    const wx0 = bx0 - 2, wy0 = by0 - 2, wx1 = bx0 + iw + 1, wy1 = by0 + ih + 1;
    const stone = { wall: 'stoneblock', building: 'W' };
    // The curtain wall.
    for (let x = wx0; x <= wx1; x++) for (let y = wy0; y <= wy1; y++) if (x < bx0 || x >= bx0 + iw || y < by0 || y >= by0 + ih) set(x, y, '#');
    // The gatehouse: a block across the front wall, the way in through it.
    const gx = bx0 + left + Math.floor(bw / 2) - 1;
    for (let x = gx - 2; x <= gx + 3; x++) for (let y = wy0 - 1; y <= by0 + 1; y++) set(x, y, '#');
    for (let y = wy0 - 1; y <= by0 + 1; y++) { set(gx, y, '='); set(gx + 1, y, '='); }
    // Battlements along the walls (the front in two, either side of the gatehouse), the gatehouse roof.
    map.roofs.push(
        { x: wx0, y: wy1 - 1, w: wx1 - wx0 + 1, h: 2, shape: 'battlement' },
        { x: wx0, y: wy0 + 2, w: 2, h: wy1 - wy0 - 3, shape: 'battlement' },
        { x: wx1 - 1, y: wy0 + 2, w: 2, h: wy1 - wy0 - 3, shape: 'battlement' },
        { x: wx0, y: wy0, w: gx - 2 - wx0, h: 2, shape: 'battlement' },
        { x: gx + 4, y: wy0, w: wx1 - gx - 3, h: 2, shape: 'battlement' },
        { x: gx - 2, y: wy0 - 1, w: 6, h: by0 - wy0 + 3, shape: 'battlement' },
    );
    // Round towers at the corners.
    for (const [cx, cy] of [[wx0 + 0.5, wy0 + 0.5], [wx1 - 0.5, wy0 + 0.5], [wx0 + 0.5, wy1 - 0.5], [wx1 - 0.5, wy1 - 0.5]].slice(0, Math.max(ext.towers, 4))) {
        for (const [x, y] of roundTiles({ cx, cy, rad: 2.2, half: false })) set(x, y, '#');
        map.roofs.push({ x: Math.round(cx - 2.5), y: Math.round(cy - 2.5), w: 5, h: 5, shape: 'cone', style: 'slate' });
    }
    map.areas.push({ x: wx0 - 2, y: wy0 - 2, w: wx1 - wx0 + 5, h: wy1 - wy0 + 5, ...stone });
    // The moat, with a bridge to the gate.
    if (ext.moat) {
        for (let x = wx0 - 4; x <= wx1 + 4; x++) for (let y = wy0 - 4; y <= wy1 + 4; y++) {
            const out = x < wx0 - 2 || x > wx1 + 2 || y < wy0 - 2 || y > wy1 + 2;
            if (out && get(x, y) === '.') set(x, y, 'w');
        }
        for (let y = wy0 - 4; y < wy0 - 1; y++) { set(gx, y, 'b'); set(gx + 1, y, 'b'); }
    }
    // The road up to the gate.
    for (let y = 0; y < wy0 - 1; y++) if (get(gx, y) === '.') { set(gx, y, '='); set(gx + 1, y, '='); }
    // The bailey: grass, a cobbled way from the gate to the keep.
    place.rooms.bailey = { id: 'bailey', name: 'The bailey', type: 'courtyard', floor: 'F0', rect: { x: bx0, y: by0, w: iw, h: ih }, lit: true, description: 'The courtyard inside the castle walls.', exit: false };
    // The keep: the castle's inside, facing the gate, with turrets on its front corners.
    const kx = bx0 + left, ky = by0 + front;
    for (let x = kx; x < kx + bw; x++) for (let y = ky; y < ky + bd; y++) set(x, y, '#');
    const kd = gx;
    set(kd, ky, '+');
    for (let x = kx + 1; x < kx + bw - 1; x++) if (Math.abs(x - kd) >= 2 && x % 3 === 0) set(x, ky, '|');
    map.roofs.push({ x: kx, y: ky + 1, w: bw, h: bd - 1, shape: 'battlement' });
    for (const cx of [kx, kx + bw - 1]) {
        for (const [x, y] of roundTiles({ cx, cy: ky, rad: 1.4, half: false })) if (get(x, y) === '.') set(x, y, '#');
        map.roofs.push({ x: cx - 1, y: ky - 1, w: 3, h: 3, shape: 'cone', style: 'slate' });
    }
    for (let y = by0 + 2; y < ky; y++) set(kd, y, '=');
    // Life in the bailey: a well, braziers inside the gate, barrels and crates by the walls, a cart.
    put(kd - 2, by0 + 2, 'brazier'); put(kd + 2, by0 + 2, 'brazier');
    put(kx + bw + 1, ky - 2, 'well');
    for (let i = 0; i < 3; i++) put(bx0 + i, by0 + ih - 1, pickR(r, ['barrel', 'crate', 'crate']));
    put(bx0 + iw - 2, by0 + 3, 'cart');
    place.doors.D1 = { id: 'D1', floor: 'F0', x: kd, y: ky, kind: 'door', state: 'closed', rooms: [null, null], enter: 'B1' };
    place.buildings.B1 = { id: 'B1', name: plan.name, kind: plan.kind, door: 'D1', rect: { x: kx, y: ky, w: bw, h: bd }, interior: null, enterable: true, description: plan.summary };
    layYards(place, map, { set, get, put, taken }, r, slots, null, {
        left: { x: bx0, y: ky, w: left - 1, h: bd },
        right: { x: kx + bw + 2, y: ky, w: right - 2, h: bd },
        back: { x: kx, y: ky + bd + 2, w: bw, h: back - 3 },
    }, W, H);
    // Outside the walls: woods (or scrub) thick at the edges, the road kept clear.
    const inside = (x, y) => x >= wx0 - (ext.moat ? 4 : 2) && x <= wx1 + (ext.moat ? 4 : 2) && y >= wy0 - (ext.moat ? 4 : 2) && y <= wy1 + (ext.moat ? 4 : 2);
    const keep = (x, y) => Math.abs(x - gx - 0.5) <= 2 && y < wy0;
    wilds(map, c, { get, set, put, taken }, r, theme, W, H, inside, keep, true);
    outsidePeople(place, plan, r, get, taken, kd, ky);
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    place.start = { floor: 'F0', x: gx, y: 0, room: gate?.id ?? null };
    place.state.explored.F0 = '1'.repeat(W * H);
    return place;
}

// ---------- wild places: jungles, forests, swamps, clearings ----------

/** Kinds of place that are land, not a building: built as clearings joined by trails. */
export const WILD_KINDS = /jungle|rainforest|forest|woods|\bwood\b|grove|glade|clearing|swamp|marsh|bog|meadow|wilderness|wilds|valley|canyon|oasis|beach|coast|riverbank|river|lakeshore|lake|waterfall|camp|grassland|plains|savanna/;

/** Smooth noise over the map (-1..1), for thickets and clearings that feel natural. */
function smoothNoise(seed, scale = 6) {
    const v = (a, b) => { const h = Math.sin(a * 127.1 + b * 311.7 + seed * 0.013) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; };
    return (x, y) => {
        const sx = x / scale, sy = y / scale, ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
        const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
        const a = v(ix, iy) * (1 - u) + v(ix + 1, iy) * u, b = v(ix, iy + 1) * (1 - u) + v(ix + 1, iy + 1) * u;
        return a * (1 - w) + b * w;
    };
}

/** What land a wild place is, from its words. */
function wildTheme(plan) {
    const w = `${plan.name} ${plan.kind} ${plan.summary} ${plan.theme}`.toLowerCase();
    return /jungle|rainforest|tropic/.test(w) ? 'jungle' : /swamp|marsh|bog|bayou|fen\b/.test(w) ? 'swamp' : /snow|winter|frozen|tundra|ice\b/.test(w) ? 'snow' : /desert|dune|oasis|sand\b|canyon/.test(w) ? 'desert' : 'forest';
}

/**
 * Lay a river (a meandering band: deep water in the middle, shallows along the banks) or a pond (a
 * soft blob) onto the grid. Returns the squares of water.
 */
function addWater(c, W, H, r, kind, at = null) {
    const water = [];
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H && c[y][x] === '.') { c[y][x] = ch; water.push([x, y]); } };
    if (kind === 'river') {
        const across = r() < 0.5, len = across ? W : H, span = across ? H : W;
        const base = span * (0.3 + r() * 0.4), amp = span * (0.08 + r() * 0.1), freq = (1 + r() * 1.5) * Math.PI / len, ph = r() * 6, width = 2 + Math.floor(r() * 2);
        for (let t = 0; t < len; t++) {
            const mid = base + Math.sin(t * freq + ph) * amp + Math.sin(t * freq * 3.1 + ph) * amp * 0.25;
            for (let k = -width - 1; k <= width + 1; k++) {
                const p = Math.round(mid + k), ch = Math.abs(k) <= width - 1 ? 'w' : '~';
                if (across) set(t, p, ch); else set(p, t, ch);
            }
        }
    } else {
        const [cx, cy] = at ?? [Math.floor(W * (0.25 + r() * 0.5)), Math.floor(H * (0.25 + r() * 0.5))];
        const rad = kind === 'pool' ? 2 + r() * 1.5 : 3 + r() * 3, n = smoothNoise(Math.floor(r() * 1e6), 3);
        for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++) {
            const d = Math.hypot(x - cx, (y - cy) * 1.2) / (rad * (1 + n(x, y) * 0.3));
            if (d < 0.6) set(x, y, rad > 3 ? 'w' : '~'); else if (d < 1) set(x, y, '~');
        }
    }
    return water;
}

/**
 * Grow the land: thickets of trees where the noise is high (thick in a jungle, open in a desert), great
 * trees, palms by water in a jungle or desert, and undergrowth (ferns, tall grass, bushes, flowers,
 * mushrooms, logs, rocks), reeds on the banks and lily pads on still water. keep(x, y) = leave clear.
 */
function growWilds(map, c, W, H, r, theme, keep, density = 1) {
    const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? c[y][x] : '%');
    const taken = new Set((map.props || []).flatMap(p => { const out = []; for (let i = 0; i < (p.w || 1); i++) for (let j = 0; j < (p.h || 1); j++) out.push(K(p.x + i, p.y + j)); return out; }));
    const put = (x, y, type, extra = {}) => { const w = extra.w || 1, h = extra.h || 1; for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (taken.has(K(x + i, y + j)) || get(x + i, y + j) !== '.' || keep(x + i, y + j)) return false; map.props.push({ x, y, type, ...extra }); for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) taken.add(K(x + i, y + j)); return true; };
    const n = smoothNoise(Math.floor(r() * 1e6), 6), fine = smoothNoise(Math.floor(r() * 1e6), 2.5);
    const base = { jungle: 0.62, forest: 0.45, swamp: 0.3, snow: 0.32, desert: 0.05 }[theme] * density;
    const nearWater = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => '~w'.includes(get(x + dx, y + dy)));
    const hue = { jungle: [105, 135], forest: [88, 125], swamp: [70, 95], snow: [130, 150], desert: [80, 100] }[theme];
    // Great trees first (they need room), in the thick of the woods.
    for (let x = 1; x < W - 2; x++) for (let y = 1; y < H - 2; y++) {
        if (n(x, y) > 0.15 && r() < (theme === 'jungle' ? 0.05 : theme === 'forest' ? 0.03 : 0.012) * density) put(x, y, 'bigtree', { w: 2, h: 2, hue: Math.round(hue[0] + r() * (hue[1] - hue[0])), ...(theme === 'jungle' && r() < 0.3 ? { blossom: pickR(r, ['#ff5d8f', '#ffb347', '#f5f05a']) } : {}) });
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
        if (get(x, y) === '~' && !keep(x, y) && r() < 0.12 && (theme === 'jungle' || theme === 'swamp' || theme === 'forest')) { map.props.push({ x, y, type: 'lilypad' }); continue; }
        if (get(x, y) !== '.' || keep(x, y) || taken.has(K(x, y))) continue;
        const thick = base + n(x, y) * 0.35 + fine(x, y) * 0.1;
        const wet = nearWater(x, y);
        if (wet && r() < 0.4) { put(x, y, (theme === 'jungle' || theme === 'desert') && r() < 0.35 ? 'palm' : 'reeds'); continue; }
        if (r() < thick) { c[y][x] = 'T'; continue; }
        const under = r();
        if (theme === 'jungle') { if (under < 0.22) put(x, y, 'fern'); else if (under < 0.32) put(x, y, 'tallgrass'); else if (under < 0.36) put(x, y, 'palm'); else if (under < 0.4) put(x, y, 'bush'); else if (under < 0.42) put(x, y, 'flowers'); }
        else if (theme === 'forest') { if (under < 0.08) put(x, y, 'fern'); else if (under < 0.16) put(x, y, 'tallgrass'); else if (under < 0.2) put(x, y, 'bush'); else if (under < 0.22) put(x, y, 'mushroom'); else if (under < 0.24) put(x, y, 'log'); else if (under < 0.26) put(x, y, 'boulder'); else if (under < 0.29) put(x, y, 'flowers'); }
        else if (theme === 'swamp') { if (under < 0.15) put(x, y, 'reeds'); else if (under < 0.22) put(x, y, 'tallgrass'); else if (under < 0.26) put(x, y, 'mushroom'); else if (under < 0.29) put(x, y, 'log'); }
        else if (theme === 'snow') { if (under < 0.04) put(x, y, 'boulder'); else if (under < 0.06) put(x, y, 'bush'); }
        else if (theme === 'desert') { if (under < 0.03) put(x, y, 'boulder'); else if (under < 0.05) put(x, y, 'bush'); }
    }
}

/**
 * A wild place (a jungle, a forest, a swamp, a riverbank, a camp): its "rooms" are spots on the land
 * (a clearing, a waterfall pool, a ruined shrine, a camp), each a clearing, joined by winding trails;
 * a river (bridged where a trail crosses) or ponds; and the land grown thick around them. Traps,
 * hidden things and people of the plan go in their spots. All outdoors: no fog, no walls, no exits.
 */
export function generateWilds(planIn, seed = 1) {
    const plan = planIn?.normalized ? planIn : normalizePlan(planIn);
    const r = rng(seed);
    const theme = wildTheme(plan);
    const spots = plan.rooms.slice(0, 9);
    const W = clamp(30 + spots.length * 4, 32, 56), H = clamp(26 + spots.length * 3, 28, 50);
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    const map = { w: W, h: H, rows: [], theme, props: [], areas: [], roofs: [], seed };
    const place = {
        version: 1, kind: plan.kind || 'wilds', name: plan.name, theme, fog: false, seed, summary: plan.summary,
        floors: [{ id: 'F0', name: plan.name, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: null, state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
    // Water: a river through it or a pond (or a few pools in a swamp, an oasis in a desert).
    const words = `${plan.name} ${plan.summary} ${spots.map(s => s.name).join(' ')}`.toLowerCase();
    const wantsRiver = /river|stream|creek|brook|ford|rapids/.test(words), wantsPond = /pond|lake|pool|lagoon|spring|oasis|waterfall/.test(words);
    if (wantsRiver || (!wantsPond && (theme === 'jungle' ? r() < 0.6 : theme === 'forest' ? r() < 0.45 : false))) addWater(c, W, H, r, 'river');
    if (wantsPond || theme === 'desert' || (theme !== 'snow' && r() < 0.5)) addWater(c, W, H, r, 'pond');
    if (theme === 'swamp') for (let i = 0; i < 4 + Math.floor(r() * 3); i++) addWater(c, W, H, r, 'pool');
    // The spots: clearings spread over the land, each sized to what it is.
    const centers = [];
    for (const sp of spots) {
        const rad = sp.size === 'huge' || sp.size === 'large' ? 5 : sp.size === 'small' || sp.size === 'tiny' ? 3 : 4;
        let best = null;
        for (let tries = 0; tries < 80; tries++) {
            const x = int(r, rad + 2, W - rad - 3), y = int(r, rad + 2, H - rad - 3);
            const room = Math.min(...centers.map(cc => Math.hypot(cc.x - x, cc.y - y) - cc.rad - rad), 99);
            let wet = 0; for (let i = -rad; i <= rad; i++) for (let j = -rad; j <= rad; j++) if ('~w'.includes(c[y + j]?.[x + i])) wet++;
            const score = Math.min(room, 6) * 3 - wet;
            if (!best || score > best.score) best = { x, y, rad, score };
        }
        centers.push({ ...best, sp });
    }
    // Trails between them (each to its nearest already joined), winding a little; bridges over water.
    const trail = new Set();
    const carve = (a, b) => {
        let x = a.x, y = a.y;
        for (let steps = 0; steps < 400 && (x !== b.x || y !== b.y); steps++) {
            if (r() < 0.25) { x += pickR(r, [-1, 1]); } else if (Math.abs(b.x - x) > Math.abs(b.y - y) || (Math.abs(b.x - x) && r() < 0.5)) x += Math.sign(b.x - x); else y += Math.sign(b.y - y);
            x = clamp(x, 1, W - 2); y = clamp(y, 1, H - 2);
            trail.add(K(x, y));
            c[y][x] = '~w'.includes(c[y][x]) || c[y][x] === 'b' ? 'b' : ':';
        }
    };
    const joined = [centers[0]];
    for (const cc of centers.slice(1)) {
        const near = joined.slice().sort((p, q) => Math.hypot(p.x - cc.x, p.y - cc.y) - Math.hypot(q.x - cc.x, q.y - cc.y))[0];
        carve(near, cc);
        joined.push(cc);
    }
    // Clearings: open ground (dirt for a camp), named so the map knows where you are.
    const inClearing = (x, y) => centers.some(cc => Math.hypot(x - cc.x, (y - cc.y) * 1.1) <= cc.rad);
    for (const cc of centers) {
        for (let x = cc.x - cc.rad; x <= cc.x + cc.rad; x++) for (let y = cc.y - cc.rad; y <= cc.y + cc.rad; y++) {
            if (Math.hypot(x - cc.x, (y - cc.y) * 1.1) > cc.rad || c[y]?.[x] === undefined) continue;
            if (c[y][x] === '.' || c[y][x] === 'T') c[y][x] = /camp/.test(`${cc.sp.type} ${cc.sp.name}`.toLowerCase()) ? ':' : '.';
        }
        place.rooms[cc.sp.id] = { id: cc.sp.id, name: cc.sp.name, type: cc.sp.type, floor: 'F0', rect: { x: cc.x - cc.rad, y: cc.y - cc.rad, w: cc.rad * 2 + 1, h: cc.rad * 2 + 1 }, lit: true, description: cc.sp.description, exit: false };
    }
    // The ground: a darker floor under the trees, sunnier glades where the spots are.
    const floorDark = { jungle: [118, 46, 16], forest: [105, 34, 22], swamp: [78, 26, 18] }[theme];
    if (floorDark) {
        for (const cc of centers) map.areas.push({ x: cc.x - cc.rad, y: cc.y - cc.rad, w: cc.rad * 2 + 1, h: cc.rad * 2 + 1, floor: 'grass', floorC: theme === 'jungle' ? [100, 44, 30] : theme === 'swamp' ? [80, 30, 26] : [96, 36, 32], room: cc.sp.id });
        map.areas.push({ x: 0, y: 0, w: W, h: H, floor: 'grass', floorC: floorDark });
    }
    const taken = new Set();
    const put = (x, y, type, extra = {}) => { if (c[y]?.[x] === undefined || !'.:'.includes(c[y][x]) || taken.has(K(x, y)) || trail.has(K(x, y))) return false; map.props.push({ x, y, type, ...extra }); taken.add(K(x, y)); return true; };
    const freeIn = cc => { for (let tries = 0; tries < 40; tries++) { const x = int(r, cc.x - cc.rad + 1, cc.x + cc.rad - 1), y = int(r, cc.y - cc.rad + 1, cc.y + cc.rad - 1); if (c[y]?.[x] && '.:'.includes(c[y][x]) && !taken.has(K(x, y)) && Math.hypot(x - cc.x, y - cc.y) < cc.rad - 0.5) return [x, y]; } return null; };
    // What's in each spot: its plan props, and what fits its name.
    for (const cc of centers) {
        const nm = `${cc.sp.type} ${cc.sp.name}`.toLowerCase();
        const dress = /camp/.test(nm) ? ['campfire', 'tent', 'tent', 'log', 'crate']
            : /shrine|temple|altar|ruin|idol|statue|monolith/.test(nm) ? ['altar', 'statue', 'pillar', 'pillar']
                : /waterfall|pool|spring|pond|lagoon/.test(nm) ? [] : /grave|tomb|barrow/.test(nm) ? ['tombstone', 'tombstone', 'tombstone']
                    : /nest|lair|den/.test(nm) ? ['bones', 'skull', 'boulder'] : ['flowers', 'log', 'boulder'];
        if (/waterfall|pool|spring|pond|lagoon/.test(nm)) addWater(c, W, H, r, 'pool', [cc.x, cc.y + Math.max(1, cc.rad - 2)]);
        if (/ruin/.test(nm)) for (let i = 0; i < 4; i++) { const p = freeIn(cc); if (p) c[p[1]][p[0]] = '^'; }
        for (const type of [...dress, ...cc.sp.props.flatMap(p => Array(p.count || 1).fill(p.type))]) { if (!PROPS[type]) continue; const p = freeIn(cc); if (p) put(p[0], p[1], type); }
        // Traps (hidden until searched or stepped on) and hidden things in this spot.
        cc.sp.traps.forEach(t => { const p = freeIn(cc); if (!p) return; const id = `T${Object.keys(place.traps).length + 1}`; place.traps[id] = { id, room: cc.sp.id, floor: 'F0', x: p[0], y: p[1], kind: t.kind, dc: t.dc, save: t.save, effect: t.effect, state: t.hidden ? 'hidden' : 'found' }; map.props.push({ x: p[0], y: p[1], type: 'trap', hidden: t.hidden, trap: id, label: t.kind }); taken.add(K(...p)); });
        cc.sp.items.forEach(it => { const p = freeIn(cc); if (!p) return; const id = `I${Object.keys(place.items).length + 1}`; place.items[id] = { id, name: it.name, room: cc.sp.id, floor: 'F0', x: p[0], y: p[1], hidden: it.hidden, note: it.note, state: 'here' }; });
    }
    // The land around, grown thick; the clearings and trails stay open.
    growWilds(map, c, W, H, r, theme, (x, y) => inClearing(x, y) || trail.has(K(x, y)));
    // The people of the plan, in their spots.
    for (const g of plan.guards) {
        const cc = centers.find(x => x.sp.id === g.room) ?? centers[0];
        const p = freeIn(cc) ?? [cc.x, cc.y];
        place.guards[g.name] = { name: g.name, description: g.description, hostile: g.hostile !== false, ...(g.sprite ? { sprite: g.sprite } : {}), room: cc.sp.id, patrol: g.patrol.length ? g.patrol : [cc.sp.id], step: 0, floor: 'F0', x: p[0], y: p[1], state: 'patrol' };
    }
    ensureIds(place);
    // Start on dry ground in the starting spot.
    const start = centers.find(cc => cc.sp.id === plan.start) ?? centers[0];
    const dry = (x, y) => '.:='.includes(c[y]?.[x] ?? '#') && !map.props.some(p => PROPS[p.type]?.blocks && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    let sx = start.x, sy = start.y;
    for (let d = 0; d < 8 && !dry(sx, sy); d++) for (let i = -d; i <= d && !dry(sx, sy); i++) for (let j = -d; j <= d; j++) if (dry(start.x + i, start.y + j)) { sx = start.x + i; sy = start.y + j; break; }
    place.start = { floor: 'F0', x: sx, y: sy, room: start.sp.id };
    map.rows = c.slice().reverse().map(row => row.join(''));
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
