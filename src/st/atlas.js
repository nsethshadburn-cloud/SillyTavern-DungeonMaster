// The atlas: every map built for a campaign, stored once on the server and reused (never rebuilt).
// A "place" is a big site (every room on every floor, built up front), a town (its buildings'
// insides built the first time you walk in), or a small map. This module stores places, builds new
// ones (asking first for big ones, with the building animation in the chat), and moves the party
// around inside them: click-to-move, fog of war, doors, stairs, traps, guards coming into view.

import { ST, sleep } from './st.js';
import { campaign, saveDoc } from './campaign.js';
import { readJson, writeLater, flushWrites } from './storage.js';
import { statsForName } from './sheets.js';
import { postNarration, postNote } from './messages.js';
import { slug, nameKey } from '../core/text.js';
import { normalizePlan, normalizeTownPlan, generatePlace, generateTown, generateInterior } from '../core/layout.js';
import { floorById, roomAt, doorAt, stairsAt, exitAt, computeVisible, reveal, findPath, freeNear, setDoorState, tickGuards, visibleGuards, walkable } from '../core/explore.js';
import { applySceneCard } from '../core/state.js';
import { lookupModifier } from '../core/world.js';
import { isAway } from '../core/world.js';

const places = new Map(); // `${campaignId}:${key}` -> place

export function placeKey(name) {
    return slug(nameKey(name).replace(/\s+/g, '_'), 40) || 'place';
}

function fileFor(c, key) {
    return `dm_${c.meta.id}_place_${key}.json`;
}

export function atlas(c = campaign()) {
    if (!c) return { places: {} };
    c.docs.atlas ??= { places: {} };
    c.docs.atlas.places ??= {};
    return c.docs.atlas;
}

/** Find a stored place by name (or key). */
export function atlasEntry(name, c = campaign()) {
    const list = atlas(c).places;
    const key = placeKey(name);
    return list[key] ?? Object.values(list).find(e => nameKey(e.name) === nameKey(name)) ?? null;
}

export async function loadPlace(key, c = campaign()) {
    const id = `${c.meta.id}:${key}`;
    if (places.has(id)) return places.get(id);
    const place = await readJson(fileFor(c, key), null);
    if (place) places.set(id, place);
    return place;
}

export function savePlace(key, c = campaign()) {
    const place = places.get(`${c.meta.id}:${key}`);
    if (!place) return;
    writeLater(fileFor(c, key), () => place, 1200);
}

function storePlace(c, key, place, extra = {}) {
    places.set(`${c.meta.id}:${key}`, place);
    atlas(c).places[key] = { key, name: place.name, kind: place.kind, file: fileFor(c, key), built: new Date().toISOString(), floors: place.floors.length, rooms: Object.keys(place.rooms).length, buildings: Object.keys(place.buildings).length, ...extra };
    saveDoc('atlas');
    savePlace(key, c);
}

/** All the place files a campaign has (for deleting it with its chat). */
export function placeFiles(c) {
    return Object.values(atlas(c).places).map(e => e.file).filter(Boolean);
}

export function forgetPlaces() {
    places.clear();
}

/** The place the party is in right now (loaded), or null. */
export function currentPlace(c = campaign()) {
    const at = c?.docs.world.place;
    if (!at?.key) return null;
    const place = places.get(`${c.meta.id}:${at.key}`);
    return place ? { key: at.key, place } : null;
}

/** Load the current place after a chat loads. */
export async function loadCurrentPlace(c = campaign()) {
    const at = c?.docs.world.place;
    if (!at?.key) return null;
    const place = await loadPlace(at.key, c);
    if (!place) c.docs.world.place = null;
    return place;
}

/** The party's names on the map: the player first, then companions who are with them. */
export function partyOnMap(c = campaign()) {
    return [c.meta.persona.name, ...c.meta.party.map(p => p.name).filter(n => !isAway(c.docs.world, n))];
}

// ---------- entering and leaving ----------

/** Put the party somewhere in a place (its start, or a given square), refresh fog, update the scene card. */
export async function enterPlace(key, { at = null, quiet = false } = {}) {
    const c = campaign();
    const place = await loadPlace(key, c);
    if (!place) throw new Error(`No stored map for ${key}.`);
    const names = partyOnMap(c);
    const st = place.state;
    const lead = at ?? (st.positions[names[0]] ?? place.start);
    st.positions[names[0]] = { floor: lead.floor, x: lead.x, y: lead.y };
    const taken = new Set([`${lead.x},${lead.y}`]);
    for (const n of names.slice(1)) {
        const p = st.positions[n];
        if (at || !p || p.floor !== lead.floor) {
            const spot = freeNear(place, lead.floor, lead.x, lead.y, taken);
            st.positions[n] = { floor: lead.floor, ...spot };
        }
        taken.add(`${st.positions[n].x},${st.positions[n].y}`);
    }
    st.floor = lead.floor;
    c.docs.world.place = { key, floor: lead.floor };
    if (place.kind === 'town' || place.kind === 'interior') c.docs.world.location = place.name;
    saveDoc('world');
    look(c, key, place);
    await noteRoom(c, place, { quiet });
    savePlace(key, c);
    const { openMap } = await import('../ui/map.js');
    openMap();
    return place;
}

export function leavePlace(c = campaign()) {
    if (!c?.docs.world.place) return;
    c.docs.world.place = null;
    saveDoc('world');
    import('../ui/map.js').then(m => m.refreshMap());
}

/** Update the fog of war from where the party stands. */
export function look(c, key, place) {
    const names = partyOnMap(c);
    const floorId = place.state.positions[names[0]]?.floor ?? place.state.floor;
    const viewers = names.map(n => place.state.positions[n]).filter(p => p && p.floor === floorId);
    const vis = computeVisible(place, floorId, viewers);
    reveal(place, floorId, vis);
    return vis;
}

/** Entering a room for the first time: its description goes in the chat and the scene card follows. */
async function noteRoom(c, place, { quiet = false } = {}) {
    const lead = place.state.positions[c.meta.persona.name];
    if (!lead) return;
    const room = roomAt(place, lead.floor, lead.x, lead.y);
    const floor = floorById(place, lead.floor);
    const where = room ? `${room.name}${place.floors.length > 1 ? `, ${floor.name}` : ''} in ${place.name}` : `${place.kind === 'town' ? 'the streets of' : 'a passage in'} ${place.name}`;
    c.docs.world.sceneCard = applySceneCard(c.docs.world.sceneCard, { place: `${where}${room ? (room.lit ? ', lit' : ', dark') : ''}`, people: {}, objects: {} }, { newPlace: room?.id !== place.state.lastRoom, partyNames: partyOnMap(c) });
    saveDoc('world');
    if (!room || place.state.visited.includes(room.id)) { place.state.lastRoom = room?.id ?? null; return; }
    place.state.visited.push(room.id);
    place.state.lastRoom = room.id;
    if (!quiet && room.description) await postNarration(`**${room.name}.** ${room.description}`);
}

// ---------- building ----------

let building = false;

/**
 * Build a place the DM asked for (or go back to it if it already exists).
 * @param {{name:string, size:'big'|'small', kind:string, why?:string}} req
 * @param {{plan?: object}} [o] plan = a ready plan (skips asking Claude; used for testing)
 */
export async function requestBuild(req, { status = null, signal = null, plan = null, confirm = true } = {}) {
    const c = campaign();
    if (!c || !req?.name) return null;
    const existing = atlasEntry(req.name, c);
    if (existing) {
        status?.note(`Back to ${existing.name}`);
        return enterPlace(existing.key);
    }
    if (building) return null;
    const big = req.size === 'big';
    const town = /town|village|hamlet|city|outpost|settlement/.test(String(req.kind || '').toLowerCase());
    if (big && confirm) {
        const ok = await ST.callGenericPopup(
            `<h3>Build ${escape(req.name)}?</h3><p>Claude wants to build <b>${escape(req.name)}</b> as a full map${req.why ? `: ${escape(req.why)}` : ''}.</p><p>Every room on every floor is planned once and kept for the rest of the campaign (about $0.15–0.30, a minute or so).</p>`,
            ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Build it', cancelButton: 'Not now' });
        if (ok !== ST.POPUP_RESULT.AFFIRMATIVE && ok !== true && ok !== 1) {
            await postNote(`🗺️ *${escape(req.name)} wasn't built. Ask the DM again any time.*`);
            return null;
        }
    }
    building = true;
    const { startBuildAnimation } = await import('../ui/building.js');
    const anim = await startBuildAnimation(req.name, { big });
    try {
        const { askPlacePlan } = await import('./dm.js');
        anim.cycle(big ? ['Drawing floor plans', 'Deciding what lives where', 'Hiding traps and secret doors', 'Placing keys and locks', 'Writing room descriptions'] : town ? ['Laying out the streets', 'Raising buildings', 'Painting shop signs'] : ['Sketching the place', 'Furnishing it']);
        const raw = plan ?? await askPlacePlan({ ...req, town }, { signal });
        anim.step(town ? 'Building the town' : 'Building the floors');
        await sleep(300);
        const seed = Math.floor(Math.random() * 1e9);
        const place = town ? generateTown(normalizeTownPlan(raw), seed) : generatePlace(normalizePlan({ ...raw, name: raw.name || req.name, kind: raw.kind || req.kind }), seed);
        anim.step(town ? `Raising ${Object.keys(place.buildings).length} buildings` : `Furnishing ${Object.keys(place.rooms).length} rooms`);
        await sleep(400);
        const key = placeKey(place.name || req.name);
        storePlace(c, key, place, { size: big ? 'big' : 'small' });
        await flushWrites();
        const summary = town
            ? `🗺️ **${place.name}** is ready: ${Object.keys(place.buildings).length} buildings. Their insides are built when you walk in.`
            : `🗺️ **${place.name}** is ready: ${place.floors.length > 1 ? `${place.floors.length} floors, ` : ''}${Object.keys(place.rooms).length} rooms.${place.fog ? ' Rooms reveal themselves as you explore.' : ''}`;
        await anim.finish(summary);
        await enterPlace(key);
        return place;
    } catch (error) {
        await anim.fail(String(error?.message || error));
        throw error;
    } finally {
        building = false;
    }
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/** Walk into a town building: its inside is built the first time (code only, free). */
async function enterBuilding(c, townKey, town, door) {
    const b = town.buildings[door.enter];
    if (!b) return;
    if (b.enterable === false) {
        toastr.info(`${b.name} is closed.`, 'Map', { timeOut: 2500 });
        return;
    }
    const key = `${townKey}--${slug(b.id, 12)}`;
    if (!atlas(c).places[key]) {
        const inside = generateInterior(b, Math.floor(Math.random() * 1e9));
        inside.parent = { key: townKey, door: door.id };
        storePlace(c, key, inside, { parent: townKey });
        b.interior = key;
        savePlace(townKey, c);
    }
    await enterPlace(key, { at: null });
}

// ---------- walking ----------

let walking = false;

/** Passive Perception of the best spotter in the party. */
function passivePerception(c) {
    let best = 10;
    for (const n of partyOnMap(c)) {
        const stats = statsForName(n, c.meta);
        const mod = stats ? lookupModifier(stats, { kind: 'check', skill: 'Perception', ability: 'WIS' }).mod : 0;
        best = Math.max(best, 10 + mod);
    }
    return best;
}

/**
 * Walk the party to a square (the player clicked it). Stops early for: a trap (spotted or sprung),
 * a guard coming into view, a locked door, stairs, a building door or the way out.
 * @param {{x:number, y:number}} target
 * @param {(()=>void)} redraw called after each step
 */
export async function walkTo(target, redraw = () => { }) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!c || !cur || walking) return;
    const { key, place } = cur;
    const names = partyOnMap(c);
    const lead = place.state.positions[names[0]];
    if (!lead) return;
    const { isRunning } = await import('./orchestrator.js');
    if (isRunning()) { toastr.info('The DM is busy. Move when the turn is done.', 'Map', { timeOut: 2500 }); return; }
    const floorId = lead.floor;
    const door = doorAt(place, floorId, target.x, target.y);
    if (door && door.state === 'locked') { toastr.info(`That door is locked (${door.id}). Tell the DM how you deal with it.`, 'Map', { timeOut: 3500 }); return; }
    const others = new Set(Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === floorId).map(g => `${g.x},${g.y}`));
    const path = findPath(place, floorId, lead, target, { blocked: others });
    if (!path?.length) { toastr.info(walkable(place, floorId, target.x, target.y) ? 'You can\'t get there from here (yet).' : 'You can\'t stand there.', 'Map', { timeOut: 2500 }); return; }
    walking = true;
    const trail = [{ x: lead.x, y: lead.y }];
    const seenGuards = new Set(visibleGuards(place, floorId, look(c, key, place)).map(g => g.name));
    const passive = passivePerception(c);
    let event = null, handoff = null;
    try {
        for (const [x, y] of path) {
            // A hidden trap on the next square: spotted (stop before it) or sprung (stop on it).
            const trap = Object.values(place.traps).find(t => t.floor === floorId && t.x === x && t.y === y && (t.state === 'hidden' || t.state === 'found'));
            if (trap && trap.state === 'hidden' && passive >= trap.dc) {
                trap.state = 'found';
                const prop = floorById(place, floorId).map.props.find(p => p.trap === trap.id);
                if (prop) prop.hidden = false;
                floorById(place, floorId).map.version = (floorById(place, floorId).map.version || 0) + 1;
                await postNote(`⚠️ Someone notices a ${trap.kind} just ahead (passive Perception ${passive}).`);
                break;
            }
            const d = doorAt(place, floorId, x, y);
            if (d && d.state === 'closed') setDoorState(place, d, 'open');
            lead.x = x; lead.y = y;
            trail.push({ x, y });
            names.slice(1).forEach((n, i) => {
                const spot = trail[trail.length - 2 - i] ?? trail[0];
                if (place.state.positions[n]?.floor === floorId) Object.assign(place.state.positions[n], spot);
            });
            const vis = look(c, key, place);
            redraw();
            await sleep(95);
            if (trap && trap.state === 'hidden') {
                trap.state = 'sprung';
                const room = place.rooms[trap.room];
                event = `${names[0]} stepped on a hidden ${trap.kind} (${trap.id}) in ${room?.name ?? 'a passage'}: DC ${trap.dc}${trap.save ? ` ${trap.save} save` : ''}. ${trap.effect}. Ask for the save (player_roll) and narrate it.`;
                break;
            }
            const newGuard = visibleGuards(place, floorId, vis).find(g => !seenGuards.has(g.name));
            if (newGuard) { event = `${newGuard.name} (${newGuard.description || 'a guard'}) comes into view in ${place.rooms[newGuard.room]?.name ?? 'a passage'}, ${Math.max(Math.abs(newGuard.x - x), Math.abs(newGuard.y - y))} squares away${newGuard.state === 'alert' ? ', already alert' : ''}. Decide if they notice the party (their passive Perception against the party's Stealth if sneaking), and what they do.`; break; }
            const up = stairsAt(place, floorId, x, y);
            if (up) { handoff = { stairs: up }; break; }
            const exit = exitAt(place, floorId, x, y);
            if (exit) { handoff = { exit }; break; }
            if (d?.enter) { handoff = { building: d }; break; }
            if (d?.exit) { handoff = { exit: d }; break; }
        }
        // Rooms entered on the way.
        await noteRoom(c, place);
        if (handoff?.stairs) {
            const s = handoff.stairs;
            await enterPlace(key, { at: { floor: s.floor, x: s.x, y: s.y } });
            toastr.info(`${floorById(place, s.floor).name}`, 'Map', { timeOut: 1800 });
        } else if (handoff?.building) {
            await enterBuilding(c, key, place, handoff.building);
        } else if (handoff?.exit) {
            if (place.parent) {
                // Out of a building, back onto the street in front of its door.
                const town = await loadPlace(place.parent.key, c);
                const td = town?.doors[place.parent.door];
                const outside = td ? freeNear(town, td.floor, td.x, td.y) : null;
                await enterPlace(place.parent.key, { at: outside ? { floor: td.floor, ...outside } : null, quiet: true });
            } else {
                event = `The party walked out of ${place.name} through its way out.`;
                leavePlace(c);
            }
        }
        savePlace(key, c);
        saveDoc('world');
        redraw();
    } finally {
        walking = false;
    }
    if (event) {
        const { runTurn } = await import('./orchestrator.js');
        await runTurn({ force: 'explore', placeEvent: event });
    }
}

/** Patrols move on each player turn. Returns guards that just came into view. */
export function tickPlace(c = campaign()) {
    const cur = currentPlace(c);
    if (!cur || !Object.keys(cur.place.guards).length) return [];
    const { key, place } = cur;
    const floorId = place.state.positions[c.meta.persona.name]?.floor ?? place.state.floor;
    const before = new Set(visibleGuards(place, floorId, look(c, key, place)).map(g => g.name));
    tickGuards(place);
    const now = visibleGuards(place, floorId, look(c, key, place));
    savePlace(key, c);
    return now.filter(g => !before.has(g.name));
}
