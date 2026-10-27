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
import { normalizePlan, normalizeTownPlan, generatePlace, generateTown, generateInterior, clearDoorways, ensureIds } from '../core/layout.js';
import { floorById, roomAt, doorAt, stairsAt, exitAt, computeVisible, reveal, findPath, freeNear, setDoorState, tickGuards, visibleGuards, walkable, propById, moveProp, windowAt, adoptStrays, placePerson } from '../core/explore.js';
import { applySceneCard } from '../core/state.js';
import { lookupModifier, isAway, applyPresence, conditionsOf } from '../core/world.js';
import { restraintOf, lockedLine } from '../core/restraints.js';
import { callLocal } from './llm.js';
import { settings } from './settings.js';
import { trimToTokens, extractJson } from '../core/text.js';

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
    if (place) {
        // Places built by older versions: furniture out of doorways, ids for things and windows.
        const moved = clearDoorways(place);
        ensureIds(place);
        places.set(id, place);
        if (moved) savePlace(key, c);
    }
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
    // Older versions kept NPCs the DM placed where the map never drew them: make them the place's people.
    else if (adoptStrays(place, [c.meta.persona.name, ...c.meta.party.map(p => p.name)])) savePlace(at.key, c);
    return place;
}

/** The party's names on the map: the player first, then companions who are with them (or waiting nearby). */
export function partyOnMap(c = campaign()) {
    const waiting = currentPlace(c)?.place.state.waiting ?? {};
    return [c.meta.persona.name, ...c.meta.party.map(p => p.name).filter(n => !isAway(c.docs.world, n) || waiting[n])];
}

/** Why someone can't move themselves right now (tied up, caged, held...), or null. Others can still move them. */
export function lockedReason(c, name) {
    const r = restraintOf(conditionsOf(c.docs.world, name));
    return r.locked ? lockedLine(name, r) : null;
}

/** Say why the player can't move, if they can't. */
function stuck(c) {
    const why = lockedReason(c, c.meta.persona.name);
    if (why) toastr.info(why, 'Map', { timeOut: 4000 });
    return Boolean(why);
}

/** Companions who walk along with the player right now (not the ones who chose to stay, or who can't move). */
function followers(c, place) {
    return partyOnMap(c).slice(1).filter(n => !place.state.waiting?.[n] && !lockedReason(c, n));
}

/** A companion stays where they are (their choice, or the player asked them to wait). */
export async function setWaiting(name, wait, { why = '', quiet = false } = {}) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!c || !cur) return;
    const { key, place } = cur;
    place.state.waiting ??= {};
    const p = place.state.positions[name];
    const room = p ? roomAt(place, p.floor, p.x, p.y) : null;
    if (wait) {
        place.state.waiting[name] = true;
        applyPresence(c.docs.world, c.meta.party.map(m => m.name), { [name]: `stayed behind in ${room?.name ?? 'a passage'} (${place.name})` }, []);
        if (!quiet) await postNote(`🚶 ${name} stays in ${room?.name ?? 'the passage'}${why ? `: ${why}` : ''}.`);
    } else {
        delete place.state.waiting[name];
        applyPresence(c.docs.world, c.meta.party.map(m => m.name), {}, [name]);
        if (!quiet) await postNote(`🚶 ${name} comes along with you again.`);
    }
    saveDoc('world');
    savePlace(key, c);
}

/**
 * Would this companion follow the player out of the room right now? Asked to the local model (free),
 * from the recent chat. Companions normally come along; only a clear reason in the story keeps them.
 */
async function decideFollow(c, name, fromRoom, toRoom) {
    const s = settings();
    if (!s.useHelper) return { follows: true };
    const member = c.meta.party.find(p => p.name === name);
    const recent = [];
    for (let i = ST.chat.length - 1; i >= 0 && recent.length < 8; i--) {
        const m = ST.chat[i];
        if (!m?.mes || m.is_system) continue;
        recent.unshift(`${m.name}: ${trimToTokens(m.mes, 120)}`);
    }
    const player = c.meta.persona.name;
    const system = 'You decide one thing about a character in a roleplay. Reply with JSON only: {"follows": true or false, "why": "under 12 words, in plain words"}.';
    const user = [
        `${name}: ${trimToTokens(member?.summary || '', 200)}`,
        c.meta.knowledge?.[name] ? `What ${name} knows: ${trimToTokens(c.meta.knowledge[name], 200)}` : '',
        c.meta.standing ? `Right now: ${c.meta.standing}` : '',
        `Recent chat:\n${recent.join('\n')}`,
        '',
        `${player} is walking out of ${fromRoom || 'here'} toward ${toRoom || 'somewhere else'}. Does ${name} go with ${player} right now?`,
        `Companions normally stay with ${player}. Answer false only if the recent chat clearly gives ${name} a reason to stay (hurt, angry at ${player}, refusing, told to wait, guarding something, busy with something).`,
    ].filter(Boolean).join('\n');
    try {
        const raw = await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 80, profileId: s.helperProfileId });
        const json = extractJson(raw);
        if (json && json.follows === false) return { follows: false, why: String(json.why || '').slice(0, 120) };
    } catch (error) {
        console.warn('[Dungeon Master] follow check failed', error);
    }
    return { follows: true };
}

// ---------- things on the map ----------

/** What the player just picked on the map (smash this, shove that), for the DM's next turn. */
let mapAction = '';
export function setMapAction(text) { mapAction = String(text || ''); }
export function takeMapAction() { const t = mapAction; mapAction = ''; return t; }

/** Walk up next to a thing (a rect of squares) on the map. Resolves true when standing beside it. */
export async function approachSpot(spot, redraw = () => { }) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!cur) return false;
    const { place } = cur;
    const lead = place.state.positions[c.meta.persona.name];
    const w = spot.w || 1, h = spot.h || 1;
    const near = (x, y) => x >= spot.x - 1 && x <= spot.x + w && y >= spot.y - 1 && y <= spot.y + h;
    if (near(lead.x, lead.y)) return true;
    if (stuck(c)) return false;
    let best = null;
    for (let x = spot.x - 1; x <= spot.x + w; x++) for (let y = spot.y - 1; y <= spot.y + h; y++) {
        if (x >= spot.x && x < spot.x + w && y >= spot.y && y < spot.y + h) continue;
        const p = findPath(place, lead.floor, lead, { x, y });
        if (p && (!best || p.length < best.length)) best = { length: p.length, x, y };
    }
    if (!best) { toastr.info('You can\'t get next to that from here.', 'Map', { timeOut: 2500 }); return false; }
    await walkTo({ x: best.x, y: best.y }, redraw);
    const now = place.state.positions[c.meta.persona.name];
    return near(now.x, now.y);
}

/** Shove something light one square (free). Heavy things go to the DM for a roll instead. */
export function pushProp(id, dir) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!cur) return { ok: false, why: 'no map' };
    const { key, place } = cur;
    const held = lockedReason(c, c.meta.persona.name);
    if (held) return { ok: false, why: held };
    const people = [...Object.values(place.state.positions), ...Object.values(place.guards).filter(g => g.state !== 'gone')];
    const r = moveProp(place, id, dir, { people });
    if (r.ok) { savePlace(key, c); look(c, key, place); }
    return r;
}

/** Climb out through a broken window: out of a town building onto the street beside it, or out of a place. */
export async function climbOut(winId) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!cur) return;
    const { key, place } = cur;
    const win = place.windows?.[winId];
    if (!win || win.state !== 'broken') return;
    if (stuck(c)) return;
    if (place.parent) {
        const town = await loadPlace(place.parent.key, c);
        const door = town?.doors[place.parent.door];
        const b = door?.enter ? town.buildings[door.enter] : null;
        let at = null;
        if (b?.rect) {
            // The window's side of the building (from where it is on the inside map).
            const map = floorById(place, win.floor).map;
            const dx = win.x / Math.max(1, map.w - 1) - 0.5, dy = win.y / Math.max(1, map.h - 1) - 0.5;
            const r = b.rect;
            const want = Math.abs(dx) > Math.abs(dy)
                ? { x: dx > 0 ? r.x + r.w : r.x - 1, y: r.y + Math.floor(r.h / 2) }
                : { x: r.x + Math.floor(r.w / 2), y: dy > 0 ? r.y + r.h : r.y - 1 };
            at = { floor: door.floor, ...freeNear(town, door.floor, want.x, want.y) };
        }
        await postNote(`🪟 ${c.meta.persona.name} climbs out through the broken window.`);
        await enterPlace(place.parent.key, { at, quiet: true });
        return;
    }
    await postNote(`🪟 ${c.meta.persona.name} climbs out through the broken window.`);
    leavePlace(c);
    const { runTurn } = await import('./orchestrator.js');
    await runTurn({ force: 'explore', placeEvent: `The party climbed out of ${place.name} through a broken window (${win.id}) and is outside it now.` });
}

/** Walk up next to someone on the map (for Talk, Attack...). Resolves when the walk is done. */
export async function approach(name, redraw = () => { }) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!cur) return false;
    const { place } = cur;
    const lead = place.state.positions[c.meta.persona.name];
    const other = place.guards[name] ?? place.state.positions[name];
    if (!lead || !other || other.floor !== lead.floor) return false;
    if (Math.max(Math.abs(other.x - lead.x), Math.abs(other.y - lead.y)) <= 1) return true;
    if (stuck(c)) return false;
    let best = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = findPath(place, lead.floor, lead, { x: other.x + dx, y: other.y + dy });
        if (p && (!best || p.length < best.path.length)) best = { path: p, x: other.x + dx, y: other.y + dy };
    }
    if (!best) return false;
    await walkTo({ x: best.x, y: best.y }, redraw);
    return true;
}

// ---------- entering and leaving ----------

/** Put the party somewhere in a place (its start, or a given square), refresh fog, update the scene card. */
export async function enterPlace(key, { at = null, quiet = false } = {}) {
    const c = campaign();
    const place = await loadPlace(key, c);
    if (!place) throw new Error(`No stored map for ${key}.`);
    const st = place.state;
    st.waiting ??= {};
    // Companions who chose to stay don't come along through stairs or doors to another map.
    const names = partyOnMap(c).filter((n, i) => i === 0 || !st.waiting[n]);
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
    // Nobody of the place stands on a party member's square (the start can be a guard's spot).
    const partySquares = new Set(names.map(n => st.positions[n]).filter(p => p?.floor === lead.floor).map(p => `${p.x},${p.y}`));
    for (const g of Object.values(place.guards)) {
        if (g.state !== 'gone' && g.floor === lead.floor && partySquares.has(`${g.x},${g.y}`)) placePerson(place, g.name, { floor: g.floor, x: g.x, y: g.y });
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
    if (stuck(c)) return;
    const { isRunning } = await import('./orchestrator.js');
    if (isRunning()) { toastr.info('The DM is busy. Move when the turn is done.', 'Map', { timeOut: 2500 }); return; }
    const floorId = lead.floor;
    const door = doorAt(place, floorId, target.x, target.y);
    if (door && door.state === 'locked') { toastr.info(`That door is locked (${door.id}). Tell the DM how you deal with it.`, 'Map', { timeOut: 3500 }); return; }
    const others = new Set([
        ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === floorId).map(g => `${g.x},${g.y}`),
        ...Object.entries(place.state.waiting || {}).filter(([n, w]) => w && place.state.positions[n]?.floor === floorId).map(([n]) => `${place.state.positions[n].x},${place.state.positions[n].y}`),
    ]);
    const path = findPath(place, floorId, lead, target, { blocked: others });
    if (!path?.length) { toastr.info(walkable(place, floorId, target.x, target.y) ? 'You can\'t get there from here (yet).' : 'You can\'t stand there.', 'Map', { timeOut: 2500 }); return; }
    walking = true;
    const trail = [{ x: lead.x, y: lead.y }];
    // Leaving the room: each companion in it decides (local model) whether to come along. They
    // stand still until they've decided; on a yes they walk after the player along the same path
    // (a little faster, to catch up), on a no they stay where they are.
    const fromRoom = roomAt(place, floorId, lead.x, lead.y), toRoom = roomAt(place, floorId, target.x, target.y);
    const onFloor = followers(c, place).filter(n => place.state.positions[n]?.floor === floorId);
    const leaving = fromRoom?.id !== toRoom?.id || !fromRoom;
    const deciding = leaving ? onFloor.filter(n => { const p = place.state.positions[n]; return roomAt(place, floorId, p.x, p.y)?.id === fromRoom?.id; }) : [];
    const walkers = onFloor.filter(n => !deciding.includes(n));
    const chasers = new Map(); // name -> how far along the player's path they are (-1 = not started)
    const refused = new Set();
    const pending = deciding.map(n => decideFollow(c, n, fromRoom?.name, toRoom?.name).then(d => {
        if (d.follows) { chasers.set(n, -1); return; }
        refused.add(n);
        redraw();
        return setWaiting(n, true, { why: d.why });
    }));
    const order = () => [...walkers, ...chasers.keys()];
    /** Move companions who decided to come one or two squares further along the player's path. */
    const advanceChasers = () => {
        let moved = false;
        order().forEach((n, i) => {
            if (!chasers.has(n)) return;
            const goal = Math.max(0, trail.length - 2 - i), cur = chasers.get(n);
            if (cur >= goal) return;
            const next = Math.min(goal, cur + 2);
            chasers.set(n, next);
            Object.assign(place.state.positions[n], trail[next]);
            moved = true;
        });
        return moved;
    };
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
            walkers.forEach((n, i) => {
                const spot = trail[trail.length - 2 - i] ?? trail[0];
                if (place.state.positions[n]?.floor === floorId) Object.assign(place.state.positions[n], spot);
            });
            advanceChasers();
            const vis = look(c, key, place);
            redraw();
            await sleep(95);
            if (trap && trap.state === 'hidden') {
                trap.state = 'sprung';
                const room = place.rooms[trap.room];
                event = `${names[0]} stepped on a hidden ${trap.kind} (${trap.id}) in ${room?.name ?? 'a passage'}: DC ${trap.dc}${trap.save ? ` ${trap.save} save` : ''}. ${trap.effect}. Ask for the save (player_roll) and narrate it.`;
                break;
            }
            const newGuard = visibleGuards(place, floorId, vis).find(g => !seenGuards.has(g.name) && g.hostile !== false);
            if (newGuard) { event = `${newGuard.name} (${newGuard.description || 'a guard'}) comes into view in ${place.rooms[newGuard.room]?.name ?? 'a passage'}, ${Math.max(Math.abs(newGuard.x - x), Math.abs(newGuard.y - y))} squares away${newGuard.state === 'alert' ? ', already alert' : ''}. Decide if they notice the party (their passive Perception against the party's Stealth if sneaking), and what they do.`; break; }
            const up = stairsAt(place, floorId, x, y);
            if (up) { handoff = { stairs: up }; break; }
            const exit = exitAt(place, floorId, x, y);
            if (exit) { handoff = { exit }; break; }
            if (d?.enter) { handoff = { building: d }; break; }
            if (d?.exit) { handoff = { exit: d }; break; }
        }
        // Wait for anyone still deciding, then let those who chose to come catch up.
        if (pending.length) {
            await Promise.all(pending);
            while (advanceChasers()) {
                look(c, key, place);
                redraw();
                await sleep(95);
            }
        }
        // Rooms entered on the way; a companion who stayed behind rejoins when you reach them.
        await noteRoom(c, place);
        const here = roomAt(place, lead.floor, lead.x, lead.y);
        // Coming back into their room (or right up to them in a corridor) brings them along again;
        // never on the same walk they decided to stay.
        for (const [n, w] of Object.entries(place.state.waiting || {})) {
            const p = place.state.positions[n];
            if (!w || !p || p.floor !== lead.floor || refused.has(n)) continue;
            const theirs = roomAt(place, p.floor, p.x, p.y);
            const near = !theirs && !here && Math.max(Math.abs(p.x - lead.x), Math.abs(p.y - lead.y)) <= 2;
            if (near || (here && theirs?.id === here.id)) await setWaiting(n, false);
        }
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
    return now.filter(g => !before.has(g.name) && g.hostile !== false);
}
