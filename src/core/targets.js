// Which thing on the map someone means ("smash the bookshelf", "Judy, open the kennel"): their
// words matched against the furniture, doors, windows and people they could reach. One match is
// the one; several in the same room means asking the player which. Pure module.

import { PROPS } from './grid.js';
import { floorById, roomAt, isExplored } from './explore.js';
import { colName } from './grid.js';

/** Other words people use for a thing, by the thing's type. */
const WORDS = {
    bookshelf: ['bookcase', 'shelf', 'shelves', 'books'], chest: ['trunk', 'box', 'strongbox', 'coffer', 'lockbox'], crate: ['box', 'boxes'],
    barrel: ['cask', 'keg', 'barrels'], bed: ['cot', 'bunk', 'mattress'], table: ['tables'], chair: ['seat', 'stool'], desk: ['table', 'writing desk'],
    wardrobe: ['closet', 'armoire', 'cupboard'], cabinet: ['cupboard', 'cabinets'], dresser: ['drawers', 'chest of drawers'], kennel: ['doghouse', 'pen', 'crate', 'cage'],
    cage: ['cell', 'pen'], coffin: ['casket', 'sarcophagus'], fireplace: ['hearth', 'fire'], campfire: ['fire'], clock: ['grandfather'], armor: ['suit', 'knight'],
    weaponrack: ['weapons', 'rack'], sack: ['bag', 'bags', 'sacks'], pot: ['urn', 'jar', 'vase'], hay: ['haystack', 'bale', 'straw'], cart: ['wagon', 'wheelbarrow'],
    lever: ['switch'], statue: ['idol', 'figure'], altar: ['shrine'], well: [], sofa: ['couch', 'settee'], armchair: ['chair'], nightstand: ['bedside'],
    tombstone: ['grave', 'headstone'], trough: [], counter: ['bar'], stall: ['booth', 'stand'], bigtree: ['tree'], palm: ['tree'], bush: ['shrub', 'hedge'],
    painting: ['picture', 'portrait'], mirror: [], piano: [], chandelier: [], anvil: [], forge: ['furnace'], cauldron: ['pot'], workbench: ['bench'],
    pew: ['bench'], petbed: ['dog bed'], bowl: ['dish'], boulder: ['rock', 'stone'], log: ['trunk'], web: ['cobweb', 'webs'], tent: [], plant: ['plant'],
};
const STOP = new Set(['the', 'a', 'an', 'that', 'this', 'those', 'these', 'one', 'some', 'my', 'your', 'her', 'his', 'its', 'their', 'our', 'over', 'there', 'here', 'of', 'in', 'on', 'by', 'at', 'to', 'with', 'and', 'it', 'thing', 'big', 'small', 'old', 'little', 'large', 'nearest', 'closest', 'next', 'other']);
const SIDES = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0], northern: [0, 1], southern: [0, -1], eastern: [1, 0], western: [-1, 0] };

/** Plain lower-case words, each also without a plural "s"/"es". */
function tokens(text) {
    const out = [];
    for (const w of String(text ?? '').toLowerCase().match(/[a-z]+/g) || []) {
        out.push(w);
        if (w.length > 3 && w.endsWith('es')) out.push(w.slice(0, -2));
        if (w.length > 3 && w.endsWith('s')) out.push(w.slice(0, -1));
    }
    return out;
}

/** Words a thing answers to, each with a weight: its own name counts double, other words for it once. */
function keysOf(own, other = []) {
    const keys = new Map();
    for (const w of other.flatMap(tokens)) keys.set(w, 1);
    for (const w of own.flatMap(tokens)) keys.set(w, 2);
    return keys;
}

/** A thing's display name. */
export function thingName(p) {
    return p.label || PROPS[p.type]?.name || p.type;
}

/**
 * Everything someone could act on, on one floor, that the party has seen: furniture, doors,
 * windows, people. [{kind, id, name, keys, x, y, w, h, room}]
 */
export function thingsOnFloor(place, floorId, { exclude = [] } = {}) {
    const map = floorById(place, floorId).map;
    const seen = (x, y) => place.fog === false || isExplored(place, floorId, x, y);
    const out = [];
    for (const p of map.props || []) {
        if (p.hidden || p.type === 'trap' || !seen(p.x, p.y)) continue;
        const name = thingName(p);
        out.push({ kind: 'prop', id: p.id, name, keys: keysOf([p.type, name], WORDS[p.type] ?? []), x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 });
    }
    for (const d of Object.values(place.doors || {})) {
        if (d.floor !== floorId || d.state === 'hidden' || d.state === 'walled' || !seen(d.x, d.y)) continue;
        const name = d.kind === 'cell' ? 'cell door' : d.enter || d.exit ? 'front door' : 'door';
        out.push({ kind: 'door', id: d.id, name, keys: keysOf([name, 'door'], ['doorway', 'gate', ...(d.kind === 'cell' ? ['cell', 'bars'] : []), ...(d.state === 'locked' ? ['lock', 'locked'] : [])]), x: d.x, y: d.y, w: 1, h: 1 });
    }
    for (const w of Object.values(place.windows || {})) {
        if (w.floor !== floorId || !seen(w.x, w.y)) continue;
        out.push({ kind: 'window', id: w.id, name: w.state === 'barred' ? 'barred window' : 'window', keys: keysOf(['window'], ['glass', ...(w.state === 'barred' ? ['bars'] : [])]), x: w.x, y: w.y, w: 1, h: 1 });
    }
    for (const g of Object.values(place.guards || {})) {
        if (g.state === 'gone' || g.floor !== floorId || !seen(g.x, g.y) || exclude.includes(g.name)) continue;
        out.push({ kind: 'person', id: g.name, name: g.name, keys: keysOf([g.name, ...(g.state === 'dead' ? ['body', 'corpse'] : [])], tokens(g.description).slice(-3)), x: g.x, y: g.y, w: 1, h: 1 });
    }
    for (const t of out) t.room = roomAt(place, floorId, t.x, t.y)?.id ?? null;
    return out;
}

/** How far from someone a thing is (squares, to its nearest edge). */
function gap(t, pos) {
    const dx = Math.max(t.x - pos.x, 0, pos.x - (t.x + t.w - 1)), dy = Math.max(t.y - pos.y, 0, pos.y - (t.y + t.h - 1));
    return Math.max(dx, dy);
}

/** Where a thing is, in a few words, to tell two apart ("by the north wall of the Library, 3 squares away"). */
export function whereWords(place, floorId, t, pos) {
    const rm = t.room ? place.rooms[t.room] : null;
    let side = '';
    if (rm) {
        const cx = t.x + (t.w - 1) / 2 - (rm.rect.x + (rm.rect.w - 1) / 2), cy = t.y + (t.h - 1) / 2 - (rm.rect.y + (rm.rect.h - 1) / 2);
        const ns = cy > rm.rect.h / 6 ? 'north' : cy < -rm.rect.h / 6 ? 'south' : '';
        const ew = cx > rm.rect.w / 6 ? 'east' : cx < -rm.rect.w / 6 ? 'west' : '';
        side = ns || ew ? `${ns}${ew ? (ns ? '-' : '') + ew : ''} side of ` : 'middle of ';
    }
    const d = pos ? gap(t, pos) : null;
    return `${rm ? `${side}${rm.name}` : 'out in the open'} at ${colName(t.x)}${t.y + 1}${d !== null ? `, ${d <= 1 ? 'right here' : `${d} squares away`}` : ''}`;
}

/**
 * Which thing someone means. `words` are the player's words for it ("the bookshelf", "north door").
 * pos: where the one doing it stands. last: the id they acted on last time (a second "the
 * bookshelf" means the same one).
 * Returns {pick} for one clear match, {choices} when several could be meant (closest first), or
 * {} when nothing on the map fits.
 */
export function resolveTarget(place, pos, words, { last = '', exclude = [] } = {}) {
    if (!pos || !String(words || '').trim()) return {};
    const want = tokens(words).filter(w => !STOP.has(w));
    if (!want.length) return {};
    const all = thingsOnFloor(place, pos.floor, { exclude });
    // Score: how many of their words the thing answers to. Only the best-scoring things count.
    let best = 0, hits = [];
    for (const t of all) {
        const score = want.reduce((n, w) => n + (t.keys.get(w) ?? 0), 0);
        if (!score) continue;
        if (score > best) { best = score; hits = [t]; } else if (score === best) hits.push(t);
    }
    if (!hits.length) return {};
    // "north door", "the east window": the side of the room they named.
    const side = want.map(w => SIDES[w]).find(Boolean);
    if (side && hits.length > 1) {
        const dir = hits.filter(t => (t.x - pos.x) * side[0] + (t.y - pos.y) * side[1] > 0);
        if (dir.length) hits = dir;
    }
    hits.sort((a, b) => gap(a, pos) - gap(b, pos));
    const said = String(words).toLowerCase();
    if (/\b(nearest|closest|this|right here|next to (me|us))\b/.test(said)) return { pick: hits[0] };
    if (last && !/\b(other|another|next|different)\b/.test(said)) { const same = hits.find(t => t.id === last); if (same) return { pick: same }; }
    // In their room (or close by, outside a room) first; then anywhere they've seen on this floor.
    const here = roomAt(place, pos.floor, pos.x, pos.y)?.id ?? null;
    const near = hits.filter(t => (here ? t.room === here : gap(t, pos) <= 8));
    const pool = near.length ? near : hits;
    if (pool.length === 1) return { pick: pool[0] };
    // Several, but one is right beside them and the rest are well away: that one.
    if (gap(pool[0], pos) <= 1 && gap(pool[1], pos) > 3) return { pick: pool[0] };
    return { choices: pool.slice(0, 8) };
}

/** A thing's id, kind and spot for the DM: "the bookshelf (P14, f7)". */
export function targetLine(t) {
    return `the ${t.name} (${t.kind === 'person' ? t.name : t.id}, ${colName(t.x)}${t.y + 1})`;
}
