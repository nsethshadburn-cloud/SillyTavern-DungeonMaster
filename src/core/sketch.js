// The sketch: a small picture of the scene, drawn from the DM's scene card every turn. It never
// decides anything. The story is the truth outside a fight; the sketch only shows it: a room or a
// patch of ground, the people in it where the card's "spots" put them, the card's objects as
// furniture. When a fight starts with no battle map of its own, the sketch becomes the battle map,
// so everyone keeps their square. Pure module (no SillyTavern imports).

import { normalizeMap, themeFor, PROPS, toCoord, parseCoord, isWalkable } from './grid.js';
import { nameKey } from './text.js';
import { looksLikeThing } from './people.js';

/** Where someone stands, in the DM's words: a closed list, like the referee's. */
export const ZONES = Object.freeze(['beside', 'near', 'across', 'door', 'outside']);
export const ZONE_WORDS = 'beside (within arm\'s reach of the player) | near (a few paces off) | across (the far side of the room or clearing) | door (at the way in or out) | outside (not in the scene: out of sight, in another room)';

const W = 12, H = 9;
/** Themes with no walls: open ground, the way out is the bottom edge. */
const OPEN = new Set(['forest', 'jungle', 'camp', 'swamp', 'snow', 'desert', 'town', 'warren']);
/** The player's square: bottom middle, a few steps in from the door. */
const HOME = Object.freeze({ x: 6, y: 3 });
const DOOR = Object.freeze({ x: 6, y: 0 });

/** Words in an object's name or look → a prop the painter knows. First match wins. */
const PROP_WORDS = [
    [/\b(campfire|camp ?fire|cook ?fire|fire pit|hearth fire)\b/, 'campfire'], [/\b(hearth|fireplace)\b/, 'fireplace'], [/\b(bonfire|pyre)\b/, 'bonfire'], [/\b(brazier)\b/, 'brazier'], [/\b(candles?|candelabra)\b/, 'candles'],
    [/\b(torch|lantern|lamp|sconce)\b/, 'torch'], [/\b(chest|strongbox|coffer|trunk)\b/, 'chest'], [/\b(barrels?|cask|keg)\b/, 'barrel'], [/\b(crates?|box|boxes)\b/, 'crate'],
    [/\b(bed|cot|bunk|pallet)\b/, 'bed'], [/\b(table|board)\b/, 'table'], [/\b(desk|writing)\b/, 'desk'], [/\b(counter|bar\b|bar top)\b/, 'counter'], [/\b(chair|stool)\b/, 'chair'],
    [/\b(bookshelf|shelves|shelf|books)\b/, 'bookshelf'], [/\b(altar)\b/, 'altar'], [/\b(statue|idol)\b/, 'statue'], [/\b(throne)\b/, 'throne'], [/\b(cage|kennel)\b/, 'cage'],
    [/\b(anvil|forge)\b/, 'anvil'], [/\b(cauldron|pot|kettle)\b/, 'cauldron'], [/\b(well)\b/, 'well'], [/\b(fountain)\b/, 'fountain'], [/\b(coffin|casket|sarcophagus)\b/, 'coffin'],
    [/\b(boulder|rock|stone)\b/, 'boulder'], [/\b(bush|shrub|thicket|bramble)\b/, 'bush'], [/\b(log|stump)\b/, 'log'], [/\b(tree|oak|pine|elm)\b/, 'bigtree'], [/\b(tent)\b/, 'tent'],
    [/\b(wagon|carriage|coach)\b/, 'wagon'], [/\b(cart|barrow)\b/, 'cart'], [/\b(hay|straw)\b/, 'hay'], [/\b(sack|bag|pack)\b/, 'sack'], [/\b(bones?|skeleton)\b/, 'bones'], [/\b(skull)\b/, 'skull'],
    [/\b(rug|carpet)\b/, 'rug'], [/\b(banner|flag|tapestry)\b/, 'banner'], [/\b(wardrobe|armoire|closet)\b/, 'wardrobe'], [/\b(cabinet|cupboard|dresser)\b/, 'cabinet'],
    [/\b(pillar|column|post)\b/, 'pillar'], [/\b(weapons? rack|rack of)\b/, 'weaponrack'], [/\b(armou?r)\b/, 'armor'], [/\b(workbench|bench)\b/, 'workbench'], [/\b(gravestone|tombstone|grave)\b/, 'tombstone'],
    [/\b(stall|booth)\b/, 'stall'], [/\b(fence|rail)\b/, 'fence'], [/\b(trough)\b/, 'trough'], [/\b(web)\b/, 'web'], [/\b(lever|switch)\b/, 'lever'], [/\b(mushrooms?|fungus)\b/, 'mushroom'],
    [/\b(fire|flames?|embers)\b/, 'campfire'],
];

/**
 * The prop that fits an object of the scene card ("Dawnlamp: squat brass lamp on the table" → torch),
 * or '' for none. The name says what it is; its look only helps when the name doesn't. A thing by its
 * name (a ledger, a key) is never a prop, whatever it lies on.
 */
export function propForObject(name, look = '') {
    const byName = PROP_WORDS.find(([re]) => re.test(String(name).toLowerCase()));
    if (byName) return PROPS[byName[1]] ? byName[1] : '';
    if (looksLikeThing(name)) return '';
    const byLook = PROP_WORDS.find(([re]) => re.test(String(look).toLowerCase()));
    return byLook && PROPS[byLook[1]] ? byLook[1] : '';
}

/** A stable number for a name, so the same person lands on the same square turn after turn. */
export function hashName(name) {
    let h = 0;
    for (const ch of nameKey(name)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
}

/** The zone the card gives someone, or the default for who they are. */
export function zoneOf(spots, name, { companion = false } = {}) {
    const key = nameKey(name);
    const given = Object.entries(spots || {}).find(([n]) => nameKey(n) === key)?.[1];
    const z = String(given || '').toLowerCase().trim();
    if (ZONES.includes(z)) return z;
    return companion ? 'beside' : 'near';
}

/** The sketch's identity: a new place or theme is a new picture; the same one keeps its squares. */
export function sketchKey(card, theme) {
    return `${nameKey(String(card?.place || '')).split(' ').slice(0, 6).join(' ')}|${theme}`;
}

/** The theme for the scene: the card's first words ("Eel Street at dusk, lamplight from the inn" is a street), then the rest, then the location, then the setting. */
export function sketchTheme(card, world) {
    const place = String(card?.place || '');
    const head = place.split(/[,;.:]/)[0];
    const byHead = themeFor('', head);
    if (head.trim() && (byHead !== 'dungeon' || /dungeon/i.test(head))) return byHead;
    return themeFor(world?.setting, `${place} ${world?.location || ''}`);
}

/** The empty room or clearing: walls around it and a door at the bottom indoors; open ground outdoors. */
export function sketchMap(theme, seed = 1) {
    const open = OPEN.has(theme);
    const rows = [];
    for (let r = 0; r < H; r++) {
        const y = H - 1 - r;
        let row = '';
        for (let x = 0; x < W; x++) {
            const edge = x === 0 || x === W - 1 || y === 0 || y === H - 1;
            if (open) row += y === DOOR.y && x === DOOR.x ? ':' : ',';
            else if (y === DOOR.y && x === DOOR.x) row += '+';
            else row += edge ? '#' : '.';
        }
        rows.push(row);
    }
    return normalizeMap({ theme, width: W, height: H, rows, props: [], seed });
}

/** Candidate squares for a zone: rings of preference, each in a fixed order (a name's hash picks a stable one in the first ring with room). */
function zoneRings(zone) {
    const ring = (r) => { const out = []; for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) out.push({ x: HOME.x + dx, y: HOME.y + dy }); return out; };
    let rings = [];
    if (zone === 'beside') rings = [ring(1), ring(2)];
    else if (zone === 'near') rings = [ring(2), ring(3), ring(1)];
    else if (zone === 'across') { const far = []; for (let y = H - 2; y >= H - 4; y--) for (let x = 2; x < W - 2; x++) far.push({ x, y }); rings = [far]; }
    else if (zone === 'door') rings = [[{ x: DOOR.x, y: DOOR.y + 1 }, { x: DOOR.x - 1, y: DOOR.y + 1 }, { x: DOOR.x + 1, y: DOOR.y + 1 }], [{ x: DOOR.x, y: DOOR.y + 2 }, { x: DOOR.x - 1, y: DOOR.y + 2 }, { x: DOOR.x + 1, y: DOOR.y + 2 }]];
    return rings.map(r => r.filter(p => p.x > 0 && p.x < W - 1 && p.y > 0 && p.y < H - 1));
}

/**
 * Draw (or redraw) the sketch from the scene card.
 * @param {object|null} card the world's scene card {place, people, objects, spots}
 * @param {{world:object, player:string, party:string[], away?:string[], previous?:object|null, npcs?:string[]}} o
 *  party = companion names; away = companions not with the player; previous = the last sketch (world.sketch), kept where it still fits
 * @returns {{key:string, map:object, positions:Record<string,string>, zones:Record<string,string>, objects:Record<string,string>}|null}
 */
export function buildSketch(card, { world, player, party = [], away = [], previous = null, npcs = [] }) {
    if (!card || (!card.place && !Object.keys(card.people || {}).length)) return null;
    const theme = sketchTheme(card, world);
    const key = sketchKey(card, theme);
    const same = previous && previous.key === key && previous.map;
    const map = same ? previous.map : sketchMap(theme, hashName(key) % 1e9 || 1);
    const spots = card.spots || {};
    // Who is in the picture: the player, companions with them, and everyone the card names.
    const people = [player, ...party.filter(n => !away.includes(n))];
    for (const n of Object.keys(card.people || {})) if (!people.some(p => nameKey(p) === nameKey(n)) && !away.some(a => nameKey(a) === nameKey(n))) people.push(n);
    const zones = {};
    for (const n of people) zones[n] = n === player ? 'player' : zoneOf(spots, n, { companion: party.includes(n) });
    // Objects: the card's, as props, on squares nobody stands on; the same object keeps its square.
    const objects = {};
    const props = [];
    const taken = new Set();
    // A square a prop may stand on: open ground, nothing there yet, never the player's own ring (they stand at home with company) and never the doorway.
    const freeSq = (x, y) => isWalkable({ ...map, props: [] }, x, y) && !taken.has(`${x},${y}`) && Math.max(Math.abs(x - HOME.x), Math.abs(y - HOME.y)) > 1 && !(x === DOOR.x && y === DOOR.y + 1);
    const free = (x, y, w = 1, h = 1) => { for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) if (!freeSq(x + dx, y + dy)) return false; return true; };
    const spotsForProps = [];
    for (let y = H - 2; y >= 1; y--) for (let x = 1; x < W - 1; x++) spotsForProps.push({ x, y });
    for (const [name, look] of Object.entries(card.objects || {}).slice(0, 8)) {
        const type = propForObject(name, look);
        if (!type) continue;
        const [pw, ph] = PROPS[type].size || [1, 1];
        const prev = same ? previous.objects?.[name] : null;
        let at = prev ? parseCoord(prev, map) : null;
        if (!at || !free(at.x, at.y, pw, ph)) {
            const start = hashName(name) % spotsForProps.length;
            at = null;
            for (let i = 0; i < spotsForProps.length && !at; i++) { const p = spotsForProps[(start + i) % spotsForProps.length]; if (free(p.x, p.y, pw, ph)) at = p; }
        }
        if (!at) continue;
        const wall = PROPS[type].wall;
        // A wall prop (a torch) hangs on the nearest wall square; everything else stands on the floor.
        if (wall && !OPEN.has(theme)) { const wx = at.x < W / 2 ? 0 : W - 1; props.push({ id: `s${props.length}`, type, x: wx, y: at.y, label: name }); objects[name] = toCoord(wx, at.y); continue; }
        props.push({ id: `s${props.length}`, type, x: at.x, y: at.y, label: name, ...(PROPS[type].size ? { w: pw, h: ph } : {}) });
        for (let dx = 0; dx < pw; dx++) for (let dy = 0; dy < ph; dy++) taken.add(`${at.x + dx},${at.y + dy}`);
        objects[name] = toCoord(at.x, at.y);
    }
    const drawn = { ...map, props, version: (map.version || 0) + (same && JSON.stringify(props) === JSON.stringify(map.props) ? 0 : 1) };
    // People: the player at home; everyone else in their zone, on the square they had if it still fits.
    const positions = {};
    const standing = new Set();
    const put = (n, p) => { positions[n] = toCoord(p.x, p.y); standing.add(`${p.x},${p.y}`); };
    put(player, HOME);
    for (const n of people) {
        if (n === player) continue;
        const zone = zones[n];
        if (zone === 'outside') continue;
        const prev = same && previous.zones?.[n] === zone ? parseCoord(previous.positions?.[n], drawn) : null;
        if (prev && isWalkable(drawn, prev.x, prev.y) && !standing.has(`${prev.x},${prev.y}`)) { put(n, prev); continue; }
        for (const ring of zoneRings(zone)) {
            const squares = ring.filter(p => isWalkable(drawn, p.x, p.y) && !standing.has(`${p.x},${p.y}`));
            if (!squares.length) continue;
            put(n, squares[hashName(n) % squares.length]);
            break;
        }
    }
    return { key, map: drawn, positions, zones, objects };
}

/** The player tapped a square on the sketch: their figure goes there (a picture, nothing more). */
export function moveOnSketch(sketch, name, x, y) {
    if (!sketch?.map || !isWalkable(sketch.map, x, y)) return false;
    if (Object.entries(sketch.positions).some(([n, cd]) => n !== name && cd === toCoord(x, y))) return false;
    sketch.positions[name] = toCoord(x, y);
    return true;
}
