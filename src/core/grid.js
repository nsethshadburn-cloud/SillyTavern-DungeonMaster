// Battle grid: chess-style coordinates, terrain and token positions.
// Claude only ever sees and writes plain text (rows of characters and "d4"-style squares),
// never images, so the map costs very few tokens. Pure module.

export const MIN_SIZE = 4;
/** Largest map Claude draws itself (rows of characters). */
export const MAX_SIZE = 16;
/** Largest generated floor (a mansion floor, a town). */
export const MAX_PLACE_SIZE = 64;

/** Terrain characters Claude may use in map rows. "." is the theme's own floor (stone, planks, grass...). */
export const TERRAIN = Object.freeze({
    '.': { name: 'floor (the theme\'s usual floor)', walk: true, cover: false },
    '_': { name: 'wooden planks', walk: true, cover: false },
    '=': { name: 'flagstones or cobbles', walk: true, cover: false },
    ',': { name: 'grass', walk: true, cover: false },
    ':': { name: 'dirt or mud', walk: true, cover: false },
    '^': { name: 'rubble or rough ground (difficult)', walk: true, cover: false },
    '~': { name: 'shallow water (difficult)', walk: true, cover: false },
    'w': { name: 'deep water', walk: false, cover: false },
    'L': { name: 'lava', walk: false, cover: false },
    'o': { name: 'pit or hole', walk: false, cover: false },
    '#': { name: 'wall', walk: false, cover: true },
    'T': { name: 'tree outdoors, stone pillar indoors', walk: false, cover: true },
    '+': { name: 'closed door', walk: true, cover: false },
    '/': { name: 'open door', walk: true, cover: false },
    'D': { name: 'locked door', walk: false, cover: true },
    '<': { name: 'stairs up', walk: true, cover: false },
    '>': { name: 'stairs down', walk: true, cover: false },
    'b': { name: 'bridge or walkway', walk: true, cover: false },
    '|': { name: 'window', walk: false, cover: true, seeThrough: true },
    'H': { name: 'barred window', walk: false, cover: true, seeThrough: true },
    'U': { name: 'broken window', walk: false, cover: true, seeThrough: true },
    'I': { name: 'iron bars', walk: false, cover: false, seeThrough: true },
    'J': { name: 'locked cell door', walk: false, cover: false, seeThrough: true },
    'j': { name: 'cell door', walk: true, cover: false, seeThrough: true },
    '%': { name: 'nothing (outside the building)', walk: false, cover: true },
});

/** Map themes: they set the palette and what "." and "#" look like. */
export const THEMES = Object.freeze(['dungeon', 'crypt', 'cave', 'mine', 'sewer', 'castle', 'temple', 'prison', 'tavern', 'library', 'house', 'mansion', 'cabin', 'town', 'forest', 'jungle', 'camp', 'swamp', 'snow', 'desert', 'ship']);

/**
 * Things placed on top of the terrain: "blocks" = can't stand there; "light" = radius in squares;
 * "wall" = hangs on a wall square; "decal" = painted on the floor under everything; "size" = [w, h]
 * it usually takes (any prop can be given its own w and h).
 */
export const PROPS = Object.freeze({
    chest: { name: 'chest', blocks: true }, barrel: { name: 'barrel', blocks: true, cover: true }, crate: { name: 'crate', blocks: true, cover: true },
    table: { name: 'table', blocks: true, cover: true }, chair: { name: 'chair' }, bed: { name: 'bed', blocks: true }, bookshelf: { name: 'bookshelf', blocks: true, cover: true },
    torch: { name: 'wall torch', light: 3 }, brazier: { name: 'brazier', blocks: true, light: 4 }, campfire: { name: 'campfire', blocks: true, light: 4 }, candles: { name: 'candles', light: 2 },
    altar: { name: 'altar', blocks: true, cover: true }, statue: { name: 'statue', blocks: true, cover: true }, pillar: { name: 'pillar', blocks: true, cover: true }, throne: { name: 'throne', blocks: true },
    coffin: { name: 'coffin', blocks: true, cover: true }, well: { name: 'well', blocks: true }, fountain: { name: 'fountain', blocks: true }, cage: { name: 'cage', blocks: true },
    anvil: { name: 'anvil', blocks: true }, cauldron: { name: 'cauldron', blocks: true }, lever: { name: 'lever' }, rug: { name: 'rug' }, banner: { name: 'banner' },
    bones: { name: 'bones' }, skull: { name: 'skull' }, web: { name: 'spider web' }, pot: { name: 'pot or urn' }, sack: { name: 'sacks' }, trap: { name: 'trap (known)' },
    boulder: { name: 'boulder', blocks: true, cover: true }, bush: { name: 'bush', cover: true }, log: { name: 'fallen log', cover: true }, stalagmite: { name: 'stalagmite', blocks: true, cover: true },
    crystal: { name: 'crystals', blocks: true }, mushroom: { name: 'mushrooms' }, tent: { name: 'tent', blocks: true }, cart: { name: 'cart', blocks: true, cover: true },
    // Furniture
    wardrobe: { name: 'wardrobe', blocks: true, cover: true }, dresser: { name: 'dresser', blocks: true }, nightstand: { name: 'nightstand', blocks: true },
    desk: { name: 'desk', blocks: true, cover: true }, sofa: { name: 'sofa', blocks: true, cover: true, size: [2, 1] }, armchair: { name: 'armchair', blocks: true },
    fireplace: { name: 'fireplace', wall: true, light: 3 }, chandelier: { name: 'chandelier', light: 4, ceiling: true }, piano: { name: 'piano', blocks: true, cover: true, size: [2, 1] },
    clock: { name: 'grandfather clock', blocks: true }, painting: { name: 'painting', wall: true }, mirror: { name: 'mirror', wall: true },
    armor: { name: 'suit of armor', blocks: true, cover: true }, weaponrack: { name: 'weapon rack', blocks: true }, cabinet: { name: 'cabinet', blocks: true, cover: true },
    bathtub: { name: 'bathtub', blocks: true, size: [2, 1] }, pew: { name: 'pew', blocks: true, cover: true, size: [3, 1] }, counter: { name: 'counter', blocks: true, cover: true, size: [3, 1] },
    workbench: { name: 'workbench', blocks: true, cover: true }, forge: { name: 'forge', blocks: true, light: 3 }, plant: { name: 'potted plant', blocks: true },
    // Horror and dungeon
    rack: { name: 'torture rack', blocks: true, size: [1, 2] }, chains: { name: 'wall shackles', wall: true }, iron_maiden: { name: 'iron maiden', blocks: true, cover: true },
    stocks: { name: 'stocks', blocks: true }, slab: { name: 'stone slab', blocks: true, cover: true }, hooks: { name: 'meat hooks', ceiling: true },
    kennel: { name: 'kennel', blocks: true, cover: true }, petbed: { name: 'pet bed' }, bowl: { name: 'food bowl' },
    // Town and outdoors
    sign: { name: 'sign', wall: true }, lamppost: { name: 'lamppost', blocks: true, light: 3 }, fence: { name: 'fence', blocks: true },
    flowers: { name: 'flower bed' }, hay: { name: 'hay bales', blocks: true, cover: true },
    // Greenery
    bigtree: { name: 'great tree', blocks: true, cover: true, size: [2, 2] }, palm: { name: 'palm tree', blocks: true, cover: true }, fern: { name: 'ferns' },
    tallgrass: { name: 'tall grass', cover: true }, reeds: { name: 'reeds', cover: true }, lilypad: { name: 'lily pads', decal: true }, trough: { name: 'trough', blocks: true },
    tombstone: { name: 'gravestone', blocks: true, cover: true }, stall: { name: 'market stall', blocks: true, cover: true, size: [2, 2] },
    // Marks on the floor
    debris: { name: 'broken pieces', decal: true },
    blood: { name: 'blood', decal: true }, scratches: { name: 'scratch marks', decal: true }, papers: { name: 'scattered papers', decal: true },
    stain: { name: 'stain', decal: true }, ash: { name: 'charred remains', decal: true },
});

/** Furniture too heavy to shove without a roll (the DM rules on it). Everything else that blocks can be pushed freely. */
/** Hiding places: inside (only your eyes peek out), underneath, or crouched behind. */
export const HIDE = Object.freeze({
    wardrobe: 'in', barrel: 'in', chest: 'in', coffin: 'in', cabinet: 'in', hay: 'in', tent: 'in', kennel: 'in', bush: 'in', cart: 'under', trough: 'behind',
    bed: 'under', table: 'under', desk: 'under', counter: 'behind', workbench: 'under', pew: 'under', stall: 'behind',
    tallgrass: 'in', reeds: 'in', fern: 'in', bigtree: 'behind', palm: 'behind',
    bookshelf: 'behind', statue: 'behind', pillar: 'behind', crate: 'behind', boulder: 'behind', altar: 'behind', throne: 'behind', sofa: 'behind',
    dresser: 'behind', armor: 'behind', piano: 'behind', clock: 'behind', tombstone: 'behind', cauldron: 'behind', fireplace: 'behind', stalagmite: 'behind', fountain: 'behind', well: 'behind', plant: 'behind', anvil: 'behind',
});

/** Furniture you can use: sit on it, or lie down (and sleep) on it. */
export const SEATS = Object.freeze({
    chair: 'sit', armchair: 'sit', sofa: 'sit', throne: 'sit', pew: 'sit', log: 'sit', stocks: 'sit',
    bed: 'lie', petbed: 'lie', hay: 'lie', bathtub: 'lie', coffin: 'lie', slab: 'lie',
});

export const HEAVY = new Set(['bookshelf', 'wardrobe', 'piano', 'iron_maiden', 'forge', 'anvil', 'statue', 'altar', 'coffin', 'cabinet', 'armor', 'throne', 'bathtub', 'counter', 'pew', 'bed', 'rack', 'slab', 'stocks', 'kennel', 'cage', 'boulder', 'well', 'fountain', 'stall', 'cart', 'clock', 'hay', 'trough', 'tombstone', 'pillar', 'workbench', 'weaponrack', 'sofa', 'dresser', 'desk', 'tent', 'stalagmite', 'crystal', 'cauldron', 'brazier', 'campfire', 'lamppost', 'fence']);

/** Furniture with a back and a front: drawn turned so its back is against the wall it stands by. */
export const ORIENTED = new Set(['bed', 'sofa', 'armchair', 'chair', 'piano', 'wardrobe', 'dresser', 'desk', 'cabinet', 'throne', 'clock', 'weaponrack', 'pew', 'kennel', 'altar', 'workbench', 'iron_maiden', 'bookshelf', 'counter', 'nightstand']);

/** Sign icons, by trade. Claude names the building's trade; the code picks the icon. */
export const SIGN_ICONS = Object.freeze(['anvil', 'mug', 'bed', 'bread', 'potion', 'swords', 'shield', 'scroll', 'horseshoe', 'sun', 'coins', 'needle', 'fish', 'book', 'gem', 'skull', 'key', 'hammer', 'wheat', 'meat', 'boot', 'crown', 'music', 'candle', 'flower']);

export const PROPS_LEGEND = Object.keys(PROPS).join(', ');

export const TERRAIN_LEGEND = Object.entries(TERRAIN).map(([ch, t]) => `${ch} ${t.name}`).join(', ');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Column name: a..z, then aa, ab... like a spreadsheet (big floors are wider than 26). */
export function colName(x) {
    if (!Number.isInteger(x) || x < 0) return '?';
    return x < 26 ? LETTERS[x] : `${LETTERS[Math.floor(x / 26) - 1] ?? '?'}${LETTERS[x % 26]}`;
}

function colIndex(name) {
    if (name.length === 1) return LETTERS.indexOf(name);
    return (LETTERS.indexOf(name[0]) + 1) * 26 + LETTERS.indexOf(name[1]);
}

/** x: 0 = column a; y: 0 = row 1 (bottom row, like a chess board). */
export function toCoord(x, y) {
    return `${colName(x)}${y + 1}`;
}

/** "d4" → {x:3, y:3}; null if invalid or off the map. */
export function parseCoord(text, map) {
    const m = String(text ?? '').trim().toLowerCase().match(/^([a-z]{1,2})\s*(\d{1,3})$/);
    if (!m) return null;
    const x = colIndex(m[1]);
    const y = Number(m[2]) - 1;
    if (map && (x < 0 || y < 0 || x >= map.w || y >= map.h)) return null;
    return { x, y };
}

function clampSize(n, fallback, max = MAX_SIZE) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(MIN_SIZE, v));
}

/**
 * Normalize a map from the DM: {width, height, rows:[top row ... bottom row]}.
 * Unknown characters become floor; short rows are padded; extra rows/cols are cut.
 */
/** The map on screen: the battle map during a fight, otherwise the DM's scene map (if any). */
export function activeMap(world) {
    if (world?.combat?.map) return world.combat;
    if (world?.sceneMap?.map) return world.sceneMap;
    return null;
}

/** Does a prop (which may cover several squares, from its bottom-left corner) cover this square? */
export function propCovers(p, x, y) {
    return x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);
}

/** Every visible prop on a square, bottom first (rugs and marks, then furniture). */
export function propsAt(map, x, y) {
    return (map.props || []).filter(p => !p.hidden && propCovers(p, x, y));
}

/** The prop that matters on a square: something solid first, then furniture, then rugs and marks. */
export function propAt(map, x, y) {
    const here = propsAt(map, x, y);
    return here.find(p => PROPS[p.type]?.blocks) ?? here.find(p => !PROPS[p.type]?.decal && p.type !== 'rug') ?? here[0] ?? null;
}

function normalizeProps(raw, w, h, max = 60) {
    const list = Array.isArray(raw) ? raw
        : raw && typeof raw === 'object' ? Object.entries(raw).map(([at, type]) => ({ at, type }))
            : [];
    const out = [];
    for (const item of list) {
        const at = typeof item === 'string' ? item.split('@')[1] : item?.at;
        const type = String(typeof item === 'string' ? item.split('@')[0] : item?.type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        const p = parseCoord(at, { w, h });
        if (!p || !PROPS[type] || out.some(o => o.x === p.x && o.y === p.y && o.type === type)) continue;
        const [dw, dh] = PROPS[type].size || [1, 1];
        const pw = Math.max(1, Math.min(8, Math.round(Number(item?.w) || dw), w - p.x));
        const ph = Math.max(1, Math.min(8, Math.round(Number(item?.h) || dh), h - p.y));
        const prop = { x: p.x, y: p.y, type, label: typeof item === 'object' && item.label ? String(item.label).slice(0, 40) : '' };
        if (pw > 1) prop.w = pw;
        if (ph > 1) prop.h = ph;
        if (type === 'sign') prop.icon = signIcon(item?.icon || item?.label || '');
        out.push(prop);
        if (out.length >= max) break;
    }
    return out;
}

/** The sign icon for a trade or name ("The Rusty Anvil", "blacksmith" -> anvil). */
export function signIcon(text) {
    const t = String(text || '').toLowerCase();
    if (SIGN_ICONS.includes(t)) return t;
    const rules = [
        [/smith|forge|anvil|metal/, 'anvil'], [/tavern|pub|ale|beer|bar\b|mug|drink/, 'mug'], [/inn|lodg|rest|bed|hostel/, 'bed'],
        [/bak|bread|pastr/, 'bread'], [/alchem|potion|apothec|herb|heal|elixir/, 'potion'], [/weapon|sword|blade/, 'swords'],
        [/armou?r|shield/, 'shield'], [/general|store|goods|supply|trad|scroll|scribe|post|letter/, 'scroll'], [/stable|horse|farrier/, 'horseshoe'],
        [/temple|church|shrine|chapel|priest/, 'sun'], [/bank|money|coin|exchange|gold|lender/, 'coins'], [/tailor|cloth|seam|weav/, 'needle'],
        [/fish|harbo|dock|net/, 'fish'], [/book|librar|sage|wizard|magic/, 'book'], [/jewel|gem|gold ?smith/, 'gem'], [/undert|grave|coffin|necro|bone/, 'skull'],
        [/lock|key|vault/, 'key'], [/carpent|build|mason|hammer|tool/, 'hammer'], [/farm|mill|grain|wheat|granary/, 'wheat'], [/butcher|meat/, 'meat'],
        [/cobbl|shoe|boot|leather/, 'boot'], [/guard|watch|keep|castle|hall|court|town hall|noble|lord/, 'crown'], [/bard|music|theat|song/, 'music'],
        [/candle|chandler|wax|lamp/, 'candle'], [/flower|garden|florist/, 'flower'],
    ];
    return rules.find(([re]) => re.test(t))?.[1] ?? 'scroll';
}

export function normalizeMap(raw, { max = MAX_SIZE } = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const rowsIn = Array.isArray(r.rows) ? r.rows.map(String) : [];
    const w = clampSize(r.width ?? rowsIn[0]?.length, 8, max);
    const h = clampSize(r.height ?? rowsIn.length, 8, max);
    const rows = [];
    for (let i = 0; i < h; i++) {
        const src = (rowsIn[i] ?? '').replace(/\s+/g, '');
        let row = '';
        for (let x = 0; x < w; x++) {
            const ch = src[x] ?? '.';
            row += TERRAIN[ch] ? ch : '.';
        }
        rows.push(row);
    }
    const theme = THEMES.includes(String(r.theme ?? '').toLowerCase()) ? String(r.theme).toLowerCase() : 'dungeon';
    return { w, h, rows, theme, props: normalizeProps(r.props, w, h, max > MAX_SIZE ? 600 : 60), seed: Number(r.seed) || Math.floor(Math.random() * 1e9) };
}

/** Terrain character at a square (rows are stored top to bottom). */
export function terrainAt(map, x, y) {
    const row = map.rows[map.h - 1 - y];
    return row?.[x] ?? '.';
}

export function isWalkable(map, x, y) {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
    if (propsAt(map, x, y).some(p => PROPS[p.type]?.blocks)) return false;
    return TERRAIN[terrainAt(map, x, y)]?.walk !== false;
}

/** 5e-style grid distance in squares (diagonals count as 1). */
export function distance(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** The nearest open square to (x, y), spiralling out; null if none within reach. */
export function nearestWalkable(map, x, y, taken = new Set(), reach = 4) {
    for (let d = 0; d <= reach; d++) {
        for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
            const c = toCoord(x + dx, y + dy);
            if (isWalkable(map, x + dx, y + dy) && !taken.has(c)) return { x: x + dx, y: y + dy };
        }
    }
    return null;
}

/**
 * Apply position updates {name: "d4"}. A blocked or taken square becomes the nearest open one;
 * squares off the map are ignored.
 * @returns {{positions: Record<string,string>, rejected: string[]}}
 */
export function applyPositions(map, positions, updates) {
    const next = { ...(positions || {}) };
    const rejected = [];
    for (const [name, coord] of Object.entries(updates || {})) {
        if (coord === null || coord === '' || /^(gone|removed|dead|fled)$/i.test(String(coord))) {
            delete next[name];
            continue;
        }
        const p = parseCoord(coord, map);
        const taken = new Set(Object.entries(next).filter(([n]) => n !== name).map(([, c]) => c));
        const spot = p ? nearestWalkable(map, p.x, p.y, taken) : null;
        if (!spot) {
            rejected.push(`${name}→${coord}`);
            continue;
        }
        next[name] = toCoord(spot.x, spot.y);
    }
    return { positions: next, rejected };
}

/**
 * Put anyone without a square near `center` (walking distance, through open squares), at least
 * `minSteps` away: newcomers to a fight on a big floor arrive close by, not across the building.
 */
export function placeNear(map, positions, names, center, minSteps = 3) {
    const next = { ...(positions || {}) };
    const missing = names.filter(n => !next[n]);
    if (!missing.length || !center) return next;
    const taken = new Set(Object.values(next));
    const seen = new Set([`${center.x},${center.y}`]);
    const queue = [[center.x, center.y, 0]];
    const spots = [];
    for (let i = 0; i < queue.length && queue.length < 4000; i++) {
        const [x, y, d] = queue[i];
        if (d >= minSteps && !taken.has(toCoord(x, y))) spots.push({ x, y });
        if (spots.length >= missing.length * 3 || d > 14) break;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
            if (seen.has(k) || !isWalkable(map, nx, ny)) continue;
            seen.add(k);
            queue.push([nx, ny, d + 1]);
        }
    }
    // Closer squares are a fallback when the room is small.
    if (spots.length < missing.length) for (const [x, y] of queue) if (!taken.has(toCoord(x, y)) && !(x === center.x && y === center.y) && !spots.some(s => s.x === x && s.y === y)) spots.push({ x, y });
    for (const name of missing) {
        const s = spots.shift();
        if (!s) break;
        next[name] = toCoord(s.x, s.y);
        taken.add(next[name]);
    }
    return next;
}

/** Put anyone without a square somewhere sensible: party on the bottom rows, others on top. */
export function placeMissing(map, positions, names, side = 'party') {
    const next = { ...(positions || {}) };
    const taken = new Set(Object.values(next));
    const rowsOrder = side === 'party'
        ? [...Array(map.h).keys()]
        : [...Array(map.h).keys()].reverse();
    for (const name of names) {
        if (next[name]) continue;
        let placed = false;
        for (const y of rowsOrder) {
            for (let x = 0; x < map.w && !placed; x++) {
                const c = toCoord(x, y);
                if (!taken.has(c) && isWalkable(map, x, y)) {
                    next[name] = c;
                    taken.add(c);
                    placed = true;
                }
            }
            if (placed) break;
        }
    }
    return next;
}

/** Compact text version of the battle map for Claude. */
export function renderMapText(map, positions = {}) {
    const header = '    ' + [...Array(map.w).keys()].map(colName).join(' ');
    const lines = [header];
    const tokenAt = {};
    for (const [name, c] of Object.entries(positions)) {
        const p = parseCoord(c, map);
        if (p) tokenAt[`${p.x},${p.y}`] = name;
    }
    for (let y = map.h - 1; y >= 0; y--) {
        let row = '';
        for (let x = 0; x < map.w; x++) {
            row += (tokenAt[`${x},${y}`] ? '@' : terrainAt(map, x, y)) + ' ';
        }
        lines.push(`${String(y + 1).padStart(2, ' ')}  ${row.trimEnd()}`);
    }
    const tokens = Object.entries(positions).map(([n, c]) => `${n} ${c}`).join('; ');
    const props = (map.props || []).map(p => `${p.type}${p.label ? ` (${p.label})` : ''} ${toCoord(p.x, p.y)}`).join(', ');
    return `Theme: ${map.theme || 'dungeon'}\n${lines.join('\n')}\n(@ = someone stands there) Positions: ${tokens || 'none'}\nProps: ${props || 'none'}\nLegend: ${TERRAIN_LEGEND}.`;
}

// ---------- movement in combat ----------

/** Squares a speed in feet allows (30 ft = 6 squares). */
export function speedSquares(stats, fallback = 6) {
    const ft = Number(stats?.speed);
    return Number.isFinite(ft) && ft > 0 ? Math.max(1, Math.floor(ft / 5)) : fallback;
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Every square someone can reach from `from` within `max` squares of movement: walls and blocking
 * things in the way, no squeezing diagonally past a wall corner, rubble and shallow water cost 2.
 * Other people's squares can be passed but not ended on (`blocked`).
 * @returns {Map<string, number>} "x,y" -> movement used
 */
export function reachable(map, from, max, blocked = new Set()) {
    const cost = new Map([[`${from.x},${from.y}`, 0]]);
    const queue = [[from.x, from.y, 0]];
    while (queue.length) {
        queue.sort((a, b) => a[2] - b[2]);
        const [x, y, used] = queue.shift();
        if (used > (cost.get(`${x},${y}`) ?? Infinity)) continue;
        for (const [dx, dy] of STEPS) {
            const nx = x + dx, ny = y + dy;
            if (!isWalkable(map, nx, ny)) continue;
            if (dx && dy && (!isWalkable(map, x + dx, y) || !isWalkable(map, x, y + dy))) continue;
            const ch = terrainAt(map, nx, ny);
            const next = used + (ch === '^' || ch === '~' ? 2 : 1);
            if (next > max || next >= (cost.get(`${nx},${ny}`) ?? Infinity)) continue;
            cost.set(`${nx},${ny}`, next);
            queue.push([nx, ny, next]);
        }
    }
    for (const k of blocked) if (k !== `${from.x},${from.y}`) cost.delete(k);
    return cost;
}

/**
 * The closest square to `to` that someone can actually reach this round (their speed, around walls).
 * Returns `to` itself when it's in reach.
 */
export function clampMove(map, from, to, max, blocked = new Set()) {
    const reach = reachable(map, from, max, blocked);
    if (reach.has(`${to.x},${to.y}`)) return to;
    let best = from, bestD = Infinity, bestUsed = 0;
    for (const [k, used] of reach) {
        const [x, y] = k.split(',').map(Number);
        const d = Math.max(Math.abs(x - to.x), Math.abs(y - to.y));
        if (d < bestD || (d === bestD && used < bestUsed)) { best = { x, y }; bestD = d; bestUsed = used; }
    }
    return best;
}
