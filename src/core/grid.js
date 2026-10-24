// Battle grid: chess-style coordinates, terrain and token positions.
// Claude only ever sees and writes plain text (rows of characters and "d4"-style squares),
// never images, so the map costs very few tokens. Pure module.

export const MIN_SIZE = 4;
export const MAX_SIZE = 16;

/** Terrain characters Claude may use in map rows. */
export const TERRAIN = Object.freeze({
    '.': { name: 'floor', walk: true, cover: false },
    '#': { name: 'wall', walk: false, cover: true },
    '~': { name: 'water', walk: true, cover: false },
    '^': { name: 'rough ground', walk: true, cover: false },
    'T': { name: 'cover (tree, crate, pillar)', walk: false, cover: true },
    '+': { name: 'door', walk: true, cover: false },
    'o': { name: 'pit or hole', walk: false, cover: false },
});

export const TERRAIN_LEGEND = Object.entries(TERRAIN).map(([ch, t]) => `${ch} ${t.name}`).join(', ');

const COLS = 'abcdefghijklmnop';

export function colName(x) {
    return COLS[x] ?? '?';
}

/** x: 0 = column a; y: 0 = row 1 (bottom row, like a chess board). */
export function toCoord(x, y) {
    return `${colName(x)}${y + 1}`;
}

/** "d4" → {x:3, y:3}; null if invalid or off the map. */
export function parseCoord(text, map) {
    const m = String(text ?? '').trim().toLowerCase().match(/^([a-p])\s*(\d{1,2})$/);
    if (!m) return null;
    const x = COLS.indexOf(m[1]);
    const y = Number(m[2]) - 1;
    if (map && (x < 0 || y < 0 || x >= map.w || y >= map.h)) return null;
    return { x, y };
}

function clampSize(n, fallback) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, v));
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

export function normalizeMap(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const rowsIn = Array.isArray(r.rows) ? r.rows.map(String) : [];
    const w = clampSize(r.width ?? rowsIn[0]?.length, 8);
    const h = clampSize(r.height ?? rowsIn.length, 8);
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
    return { w, h, rows };
}

/** Terrain character at a square (rows are stored top to bottom). */
export function terrainAt(map, x, y) {
    const row = map.rows[map.h - 1 - y];
    return row?.[x] ?? '.';
}

export function isWalkable(map, x, y) {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
    return TERRAIN[terrainAt(map, x, y)]?.walk !== false;
}

/** 5e-style grid distance in squares (diagonals count as 1). */
export function distance(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Apply position updates {name: "d4"}; invalid or blocked squares are ignored.
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
        if (!p || !isWalkable(map, p.x, p.y)) {
            rejected.push(`${name}→${coord}`);
            continue;
        }
        next[name] = toCoord(p.x, p.y);
    }
    return { positions: next, rejected };
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
    return `${lines.join('\n')}\n(@ = someone stands there) Positions: ${tokens || 'none'}\nLegend: ${TERRAIN_LEGEND}.`;
}
