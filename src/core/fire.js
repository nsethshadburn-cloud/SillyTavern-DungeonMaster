// Fire and other things that sit on map squares and change turn by turn.
// Every square has a burn rating (how easily it catches, how many turns it burns), from its floor,
// wall or door and the things standing on it. Fire spreads each turn to burnable squares next to
// it, flares up, burns down, and leaves charred floors and walls and ash where furniture stood.
// Spell effects (fog, ice, poison...) cover an area for a few turns. All state lives on the map
// object itself, so it works the same on a place's floor, a battle map or a scene map.
// Pure module (no SillyTavern imports).

import { terrainAt, propsAt, colName } from './grid.js';

/** The floor and wall each theme is built from (same as the map art). */
const THEME_MATERIAL = {
    dungeon: ['stone', 'brick'], crypt: ['stone', 'brick'], cave: ['rock', 'rock'], mine: ['dirt', 'rock'], sewer: ['stone', 'brick'],
    castle: ['flag', 'stoneblock'], temple: ['marble', 'stoneblock'], prison: ['stone', 'brick'], tavern: ['planks', 'timber'],
    library: ['parquet', 'panel'], house: ['planks', 'timber'], mansion: ['parquet', 'wallpaper'], cabin: ['planks', 'log'],
    town: ['grass', 'plaster'], forest: ['grass', 'hedge'], camp: ['dirt', 'hedge'], swamp: ['mud', 'hedge'], snow: ['snow', 'rock'],
    desert: ['sand', 'sandstone'], ship: ['deck', 'timber'],
};
const OUTDOOR = new Set(['forest', 'camp', 'swamp', 'snow', 'desert', 'town']);

/** [how easily it catches 0-1, how many turns it burns]. Anything not listed doesn't burn. */
const MATERIAL_BURN = {
    planks: [0.3, 4], deck: [0.3, 4], parquet: [0.3, 4], carpet: [0.45, 3], grass: [0.45, 1],
    timber: [0.22, 7], log: [0.2, 8], panel: [0.28, 5], wallpaper: [0.22, 5], hedge: [0.4, 3],
};
export const PROP_BURN = {
    hay: [0.95, 3], sack: [0.7, 2], papers: [0.95, 1], web: [0.95, 1], banner: [0.8, 2], rug: [0.6, 3], tent: [0.8, 3], bush: [0.6, 2], flowers: [0.3, 1],
    crate: [0.5, 4], barrel: [0.45, 5], chest: [0.35, 5], table: [0.35, 5], chair: [0.5, 3], bed: [0.55, 5], bookshelf: [0.6, 6], wardrobe: [0.4, 7],
    dresser: [0.4, 6], nightstand: [0.45, 3], desk: [0.4, 5], sofa: [0.55, 5], armchair: [0.55, 4], piano: [0.3, 7], clock: [0.35, 5], cabinet: [0.4, 6],
    pew: [0.35, 6], counter: [0.35, 7], workbench: [0.35, 6], kennel: [0.5, 4], petbed: [0.7, 2], stall: [0.6, 4], fence: [0.45, 3], cart: [0.4, 5],
    log: [0.3, 7], coffin: [0.35, 5], weaponrack: [0.3, 3], painting: [0.6, 2], stocks: [0.35, 4], rack: [0.35, 4], plant: [0.3, 2], mushroom: [0.1, 1],
    throne: [0.3, 6], trough: [0.2, 3], sign: [0.4, 2],
};
/** Turns a door or a tree burns, and how easily. */
const DOOR_BURN = [0.4, 4], TREE_BURN = [0.35, 8], BRIDGE_BURN = [0.35, 5];
/** Fire damage per turn for standing in it, by how hot it burns there (1-3). */
export const FIRE_DAMAGE = { 1: '1d4', 2: '1d6', 3: '2d6' };
/** Spell and hazard effects the DM can put on the map. lightning/thunder are a one-off flash. */
export const EFFECT_TYPES = ['fog', 'smoke', 'darkness', 'ice', 'web', 'poison', 'acid', 'holy', 'water', 'lightning', 'thunder'];
/** The air of a place, just for the look. */
export const AMBIENCES = ['rain', 'snow', 'dust', 'ash', 'mist', 'leaves', 'fireflies', 'sand', 'none'];

const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const key = (x, y) => `${x},${y}`;
const inside = (map, x, y) => x >= 0 && y >= 0 && x < map.w && y < map.h;
const isWallChar = ch => ch === '#';

function areaAt(map, x, y, wall) {
    const areas = map.areas || [];
    for (const a of areas) if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
    if (wall) for (const a of areas) if (x >= a.x - 1 && x <= a.x + a.w && y >= a.y - 1 && y <= a.y + a.h) return a;
    return null;
}

/** What a square is made of: {floor, wall} material names. */
export function materialAt(map, x, y) {
    const ch = terrainAt(map, x, y);
    const [floor, wall] = THEME_MATERIAL[map.theme] ?? THEME_MATERIAL.dungeon;
    const area = areaAt(map, x, y, isWallChar(ch));
    if (isWallChar(ch)) return { wall: area?.wall || wall };
    const named = { '_': 'planks', '=': 'cobble', ',': 'grass', ':': 'dirt' }[ch];
    return { floor: named ?? area?.floor ?? floor };
}

/** How burnable a square is right now: {catch: 0-1, fuel: turns}. Burnt-out squares have nothing left. */
export function burnRating(map, x, y) {
    if (!inside(map, x, y) || map.burnt?.[key(x, y)]) return { catch: 0, fuel: 0 };
    const ch = terrainAt(map, x, y);
    let base = [0, 0];
    if (ch === '+' || ch === '/' || ch === 'D') base = DOOR_BURN;
    else if (ch === 'T') base = OUTDOOR.has(map.theme) ? TREE_BURN : [0, 0];
    else if (ch === 'b') base = BRIDGE_BURN;
    else if (['~', 'w', 'L', 'o', '%', '|', 'H', 'U', 'I', 'J', 'j', '^'].includes(ch)) base = [0, 0];
    else {
        const m = materialAt(map, x, y);
        base = MATERIAL_BURN[m.wall ?? m.floor] ?? [0, 0];
    }
    let [c, fuel] = base;
    for (const p of propsAt(map, x, y)) {
        const b = PROP_BURN[p.type];
        if (b) { c = Math.max(c, b[0]); fuel += b[1]; }
    }
    return { catch: c, fuel };
}

function bump(map) {
    map.version = (map.version || 0) + 1;
}

function setTerrain(map, x, y, ch) {
    const row = map.h - 1 - y;
    map.rows[row] = map.rows[row].slice(0, x) + ch + map.rows[row].slice(x + 1);
}

/** Squares within a radius (in squares) of (x, y), on the map. */
function around(map, x, y, radius) {
    const out = [];
    const r = Math.max(0, Math.round(radius));
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (dx * dx + dy * dy > r * r + r * 0.6) continue;
        if (inside(map, x + dx, y + dy)) out.push([x + dx, y + dy]);
    }
    return out;
}

/**
 * Set fire at (x, y) and everything burnable within radius squares (Fireball: 4). Squares that
 * can't burn stay as they are, unless fuel is given (spilled oil): then they burn that long.
 * Returns how many squares caught.
 */
export function ignite(map, x, y, { radius = 0, heat = 2, fuel = 0 } = {}) {
    map.fire ??= {};
    let lit = 0;
    for (const [sx, sy] of around(map, x, y, radius)) {
        const k = key(sx, sy);
        if (map.fire[k]) { map.fire[k].heat = Math.max(map.fire[k].heat, Math.min(3, heat)); continue; }
        const b = burnRating(map, sx, sy);
        const f = b.fuel || (fuel > 0 && !isWallChar(terrainAt(map, sx, sy)) && !['~', 'w', '%'].includes(terrainAt(map, sx, sy)) ? Math.round(fuel) : 0);
        if (f <= 0) continue;
        map.fire[k] = { heat: Math.max(1, Math.min(3, heat)), fuel: f };
        lit++;
    }
    flash(map, x, y, radius, 'fire');
    bump(map);
    return lit;
}

/** Put fire out around (x, y). Returns how many squares stopped burning. */
export function extinguish(map, x, y, { radius = 0 } = {}) {
    let n = 0;
    for (const [sx, sy] of around(map, x, y, radius)) if (map.fire?.[key(sx, sy)]) { delete map.fire[key(sx, sy)]; n++; }
    if (n) { flash(map, x, y, radius, 'steam'); bump(map); }
    return n;
}

/** A one-off burst the map plays once (a fireball going off, a lightning bolt). */
function flash(map, x, y, radius, kind) {
    map.flashes = [...(map.flashes || []).filter(f => Date.now() - f.at < 4000), { x, y, radius, kind, at: Date.now() }].slice(-6);
}

/**
 * A square burns out: it stays charred, the burnable things on it are gone (ash in their place),
 * a door burns away (an open doorway), a tree becomes a stump. Returns the names of what was destroyed.
 */
function burnOut(map, x, y) {
    map.burnt ??= {};
    map.burnt[key(x, y)] = 1;
    const ch = terrainAt(map, x, y);
    if (ch === '+' || ch === 'D') setTerrain(map, x, y, '/');
    if (ch === 'T' && OUTDOOR.has(map.theme)) setTerrain(map, x, y, ':');
    const gone = propsAt(map, x, y).filter(p => PROP_BURN[p.type]?.[1] > 0 && p.type !== 'ash');
    if (!gone.length) return [];
    map.burntProps = [...(map.burntProps || []), ...gone.map(p => p.id).filter(Boolean)];
    map.props = map.props.filter(p => !gone.includes(p));
    for (const p of gone) {
        if (['web', 'papers', 'flowers', 'rug', 'banner', 'painting', 'sign'].includes(p.type)) continue;
        map.props.push({ x: p.x, y: p.y, type: 'ash', label: `charred ${p.label || p.type}`, ...(p.id ? { id: `${p.id}a` } : {}) });
    }
    return gone.map(p => p.label || p.type);
}

/**
 * One turn of fire: it spreads from squares burning hot enough to burnable squares next to it
 * (more likely the hotter it burns and the more burnable they are; not diagonally between two
 * walls), then every burning square uses up a turn of fuel, flaring up while there's plenty and
 * dying down near the end, and burns out when there's none left.
 * @returns {{burning:number, caught:string[], out:string[], destroyed:string[]}}
 */
export function tickFire(map, { rng = Math.random } = {}) {
    const fire = map.fire || {};
    const keys = Object.keys(fire);
    const result = { burning: 0, caught: [], out: [], destroyed: [] };
    if (!keys.length) return result;
    const caught = new Map();
    for (const k of keys) {
        const f = fire[k];
        if (f.heat < 2) continue;
        const [x, y] = k.split(',').map(Number);
        for (const [dx, dy] of DIRS8) {
            const nx = x + dx, ny = y + dy, nk = key(nx, ny);
            if (fire[nk] || caught.has(nk) || map.burnt?.[nk]) continue;
            if (dx && dy && isWallChar(terrainAt(map, x + dx, y)) && isWallChar(terrainAt(map, x, y + dy))) continue;
            const b = burnRating(map, nx, ny);
            if (!b.fuel || !b.catch) continue;
            if (rng() < b.catch * (f.heat / 3) * (dx && dy ? 0.6 : 1)) caught.set(nk, b.fuel);
        }
    }
    for (const k of keys) {
        const f = fire[k];
        f.fuel -= 1;
        f.heat = f.fuel >= 2 ? Math.min(3, f.heat + 1) : Math.max(1, f.heat - 1);
        if (f.fuel > 0) continue;
        delete fire[k];
        const [x, y] = k.split(',').map(Number);
        result.destroyed.push(...burnOut(map, x, y));
        result.out.push(k);
    }
    for (const [k, fuel] of caught) fire[k] = { heat: 1, fuel };
    map.fire = fire;
    result.caught = [...caught.keys()];
    result.burning = Object.keys(fire).length;
    bump(map);
    return result;
}

/** Put a spell or hazard effect on the map. lightning/thunder only flash once. */
export function addEffect(map, type, x, y, { radius = 2, turns = 3 } = {}) {
    if (!EFFECT_TYPES.includes(type)) return false;
    if (type === 'lightning' || type === 'thunder') { flash(map, x, y, radius, type); bump(map); return true; }
    map.effects = [...(map.effects || []).filter(e => !(e.type === type && e.x === x && e.y === y)), { type, x, y, radius: Math.max(0, Math.min(12, Math.round(radius))), turns: Math.max(1, Math.min(100, Math.round(turns))) }];
    if (type === 'water') extinguish(map, x, y, { radius });
    bump(map);
    return true;
}

/** Effects last their turns, then fade. Returns the ones that ended. */
export function tickEffects(map) {
    const ended = [];
    for (const e of map.effects || []) if (--e.turns <= 0) ended.push(e);
    if (ended.length) { map.effects = map.effects.filter(e => e.turns > 0); bump(map); }
    return ended;
}

/** Remove effects of a type (or all) around a square. */
export function clearEffects(map, x, y, { radius = 0, type = '' } = {}) {
    const before = (map.effects || []).length;
    map.effects = (map.effects || []).filter(e => (type && e.type !== type) || Math.hypot(e.x - x, e.y - y) > radius + e.radius);
    if (map.effects.length !== before) bump(map);
    return before - map.effects.length;
}

/** Light from fire: {x, y, rad} for each burning square. */
export function fireLights(map) {
    return Object.entries(map.fire || {}).map(([k, f]) => { const [x, y] = k.split(',').map(Number); return { x, y, rad: 1 + f.heat }; });
}

/** Is (x, y) on fire? Its heat (1-3), or 0. */
export function fireAt(map, x, y) {
    return map.fire?.[key(x, y)]?.heat ?? 0;
}

/** Which effects cover (x, y). */
export function effectsAt(map, x, y) {
    return (map.effects || []).filter(e => Math.hypot(e.x - x, e.y - y) <= e.radius + 0.3);
}

/**
 * What the DM needs to know: where fire burns (by area, with squares), what burnt out, the effects
 * on the map. nameAt(x, y) names the room a square is in (or '').
 */
export function fireSummary(map, nameAt = () => '') {
    const lines = [];
    const fire = Object.entries(map.fire || {});
    if (fire.length) {
        const byArea = new Map();
        for (const [k, f] of fire) {
            const [x, y] = k.split(',').map(Number);
            const name = nameAt(x, y) || (terrainAt(map, x, y) === '#' ? 'walls' : 'passages');
            const a = byArea.get(name) ?? { n: 0, hot: 0, squares: [] };
            a.n++; a.hot = Math.max(a.hot, f.heat); if (a.squares.length < 12) a.squares.push(`${colName(x)}${y + 1}`);
            byArea.set(name, a);
        }
        lines.push(`FIRE burning on ${fire.length} square${fire.length > 1 ? 's' : ''} (the code spreads it each turn and burns anyone standing in it): ${[...byArea].map(([n, a]) => `${n}: ${a.n} (${a.hot === 3 ? 'raging' : a.hot === 2 ? 'burning' : 'catching'}; ${a.squares.join(' ')}${a.n > a.squares.length ? ' ...' : ''})`).join('; ')}.`);
    }
    const burnt = Object.keys(map.burnt || {}).length;
    if (burnt) lines.push(`Burnt out: ${burnt} square${burnt > 1 ? 's' : ''} (charred, nothing left to burn).`);
    if (map.effects?.length) lines.push(`Effects on the map: ${map.effects.map(e => `${e.type} at ${colName(e.x)}${e.y + 1} radius ${e.radius} (${e.turns} turn${e.turns > 1 ? 's' : ''} left)`).join('; ')}.`);
    if (map.ambience) lines.push(`Ambience: ${map.ambience}.`);
    return lines.join('\n');
}

/**
 * A battle fought on a copy of a place's floor: put what burned (fire, charred squares, burnt
 * doors, destroyed furniture and its ash, effects) back onto the floor's own map.
 */
export function mergeBurn(from, to) {
    if (!from || !to) return;
    to.fire = from.fire ? JSON.parse(JSON.stringify(from.fire)) : undefined;
    to.burnt = from.burnt ? { ...from.burnt } : undefined;
    to.effects = from.effects ? JSON.parse(JSON.stringify(from.effects)) : undefined;
    if (from.ambience) to.ambience = from.ambience;
    for (const k of Object.keys(from.burnt || {})) {
        const [x, y] = k.split(',').map(Number);
        const ch = terrainAt(from, x, y);
        if (inside(to, x, y) && terrainAt(to, x, y) !== ch) setTerrain(to, x, y, ch);
    }
    const gone = new Set(from.burntProps || []);
    if (gone.size) {
        to.props = (to.props || []).filter(p => !gone.has(p.id));
        const have = new Set(to.props.map(p => p.id));
        for (const p of from.props || []) if (p.type === 'ash' && !have.has(p.id)) to.props.push({ ...p });
        to.burntProps = [...gone];
    }
    bump(to);
}
