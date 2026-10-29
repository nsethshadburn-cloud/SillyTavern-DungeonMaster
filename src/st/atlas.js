// The atlas: every map built for a campaign, stored once on the server and reused (never rebuilt).
// A "place" is a big site (every room on every floor, built up front), a town (its buildings'
// insides built the first time you walk in), or a small map. This module stores places, builds new
// ones (asking first for big ones, with the building animation in the chat), and moves the party
// around inside them: click-to-move, fog of war, doors, stairs, traps, guards coming into view.

import { ST, sleep } from './st.js';
import { campaign, saveDoc, saveMeta } from './campaign.js';
import { readJson, writeLater, flushWrites, deleteFile } from './storage.js';
import { statsForName } from './sheets.js';
import { postNarration, postNote, postDiceCard } from './messages.js';
import { lockDc, lockWords, pickModifier, notePickFailure, keyFor } from '../core/locks.js';
import { roll } from '../core/dice.js';
import { slug, nameKey } from '../core/text.js';
import { normalizePlan, normalizeTownPlan, generatePlace, generateTown, generateInterior, generateGrounds, generateWilds, WILD_KINDS, clearDoorways, ensureIds } from '../core/layout.js';
import { floorById, roomAt, doorAt, stairsAt, exitAt, computeVisible, reveal, findPath, isExplored, stepOn, hiddenNow, hideIn, poseNow, restOn, standUp, caughtNow, release, adoptTrapProps, followSteps, trapsKnownTo, learnTraps, freeNear, setDoorState, tickGuards, visibleGuards, walkable, propById, moveProp, windowAt, adoptStrays, placePerson } from '../core/explore.js';
import { applySceneCard } from '../core/state.js';
import { lookupModifier, isAway, applyPresence, conditionsOf, isNight, isLate } from '../core/world.js';
import { restraintOf, lockedLine } from '../core/restraints.js';
import { PROPS, HIDE, colName } from '../core/grid.js';
import { EARSHOT, heldRoom, looksLikeThing, personByName, openSquareNear, moveHunters, clearEngaged, setIntent, applyPlaceChanges, clearBodies, isOut, guardSees, DOWN_WORDS, PATROL_STEPS, OUTDOOR } from '../core/explore.js';
import { ensureClock, weatherAmbience } from '../core/clock.js';
import { outBy } from '../core/notice.js';
import { resolveTarget, whereWords, thingName } from '../core/targets.js';
import { inferStanding, setStanding, standingOf, standingFor, trespassOf } from '../core/access.js';
import { watchParty } from './watch.js';
import { describeRoom, describePrompt, cleanDescription } from '../core/describe.js';
import { normalizeBrief, planFromBrief, townFromBrief, wildsFromBrief, blueprintFor } from '../core/architect.js';
import { callLocal } from './llm.js';
import { settings } from './settings.js';
import { voiceLine } from './voices.js';
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
        // Trap pictures the DM put down before they could be real traps: make them real.
        const traps = adoptTrapProps(place);
        // Items that were put on the map as if they were people ("Tin of lamp oil"): gone.
        let things = 0;
        for (const [k, g] of Object.entries(place.guards || {})) if (looksLikeThing(g.name)) { delete place.guards[k]; things++; }
        // A lit, lived-in home built before v0.20 still had fog of war: you can see its rooms.
        const rooms = Object.values(place.rooms);
        const homey = place.fog && /house|home|cottage|mansion|manor|estate|tavern|inn|shop|store|cabin|lodge|library|temple|church|guild|bank|hall|interior/.test(place.kind) && rooms.length && rooms.filter(r => r.lit).length * 2 >= rooms.length;
        if (homey) place.fog = false;
        places.set(id, place);
        if (moved || traps || homey || things) savePlace(key, c);
    }
    return place;
}

/** Put a place back as it was (undoing a deleted turn): the cached copy changes in place, then it's saved. */
export function replacePlace(key, data, c = campaign()) {
    const id = `${c.meta.id}:${key}`;
    const cached = places.get(id);
    if (cached) { for (const k of Object.keys(cached)) delete cached[k]; Object.assign(cached, data); }
    else places.set(id, data);
    savePlace(key, c);
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
    // Maps off: no place is in play (it comes back if maps are turned on again).
    if (settings().mapTier === 'off') return null;
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
    const cur = currentPlace(c);
    const trapped = cur && caughtNow(cur.place, name);
    if (trapped) return `${name} is caught in the ${trapped.kind}! Their saving throw decides whether they get loose.`;
    const r = restraintOf(conditionsOf(c.docs.world, name));
    return r.locked ? lockedLine(name, r) : null;
}

/** Say why the player can't move, if they can't. */
function stuck(c) {
    const why = lockedReason(c, c.meta.persona.name);
    if (why) toastr.info(why, 'Map', { timeOut: 4000 });
    return Boolean(why);
}

/** Where someone stands in the current place (a party member or one of the place's people), or null. */
function whereIs(place, name) {
    const p = place.state.positions[name] ?? personByName(place, name);
    return p && Number.isFinite(p.x) ? p : null;
}

/** The things in a room (furniture, sacks, hay...), each once, as [{id, name}]. */
function thingsIn(place, rm) {
    const map = floorById(place, rm.floor).map;
    const seen = new Set(), out = [];
    for (const p of map.props || []) {
        if (p.hidden) continue;
        if (p.x >= rm.rect.x + rm.rect.w || p.x + (p.w || 1) <= rm.rect.x || p.y >= rm.rect.y + rm.rect.h || p.y + (p.h || 1) <= rm.rect.y) continue;
        const name = p.label || PROPS[p.type]?.name || p.type;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ id: p.id, name });
    }
    return out;
}

/** The ways out of a room: doors (and where they go), stairs, windows. */
function exitsOf(place, rm) {
    const out = [];
    for (const d of Object.values(place.doors)) {
        if (!d.rooms.includes(rm.id) || d.state === 'hidden' || d.state === 'walled') continue;
        const other = d.rooms.find(id => id && id !== rm.id);
        const what = d.kind === 'cell' ? 'cell door' : 'door';
        out.push(`${d.state === 'locked' ? `locked ${what}` : d.state === 'open' ? `open ${what}` : what} to ${d.exit ? 'the outside' : place.rooms[other]?.name ?? 'a passage'}`);
    }
    for (const s of place.stairs) for (const [e, o] of [[s.a, s.b], [s.b, s.a]]) if (e.room === rm.id) out.push(`stairs to ${place.rooms[o.room]?.name ?? 'another floor'}`);
    const wins = Object.values(place.windows || {}).filter(w => w.room === rm.id);
    if (wins.length) out.push(`${wins.length} window${wins.length > 1 ? 's' : ''}${wins.every(w => w.state === 'barred') ? ' (barred)' : ''}`);
    return out;
}

/** The room someone is in, for their reply note: {room, things, exits} (empty outside a built place). */
export function roomBrief(c, name) {
    const cur = currentPlace(c);
    const pos = cur && whereIs(cur.place, name);
    if (!pos) return { room: '', things: '', exits: '' };
    const rm = roomAt(cur.place, pos.floor, pos.x, pos.y);
    const known = knownRooms(c, cur.place, name, rm);
    if (!rm) return { room: 'A passage between rooms.', things: '', exits: '', known };
    const t = trespassOf(cur.place, name, roomAt);
    return {
        room: `${rm.name}${rm.description ? `: ${rm.description}` : ''}${t ? ` (${name} is not supposed to be here: ${t.why === 'escaped' ? 'an escaped prisoner' : t.why}; anyone who belongs here would object)` : ''}`,
        things: thingsIn(cur.place, rm).map(t => t.name).join(', '),
        exits: exitsOf(cur.place, rm).join('; '),
        known,
    };
}

/**
 * The rooms a companion knows of in this place: the ones the party has been in, and, when their
 * knowledge says they know the place, the rooms of their floor (its name only; no secrets). Nothing
 * else: a companion never gets the whole map.
 */
function knownRooms(c, place, name, here) {
    const names = new Set();
    for (const id of place.state.visited || []) if (place.rooms[id]?.name) names.add(place.rooms[id].name);
    const knowledge = nameKey(c.meta.knowledge?.[name] || '');
    const knowsPlace = knowledge && (knowledge.includes(nameKey(place.name)) || /\bknow(s|n)? (this|the) (place|building|gaol|jail|prison|house|castle|keep|dungeon|manor|mansion|temple|tower|inside and out)\b/.test(knowledge));
    if (knowsPlace && here) for (const r of Object.values(place.rooms)) if (r.floor === here.floor && r.name && !r.hidden) names.add(r.name);
    return [...names].slice(0, 30).join(', ');
}

/** Where a companion could go on their own right now: things in their room, and rooms next door. [{id, name}] */
export function goTargets(c, name) {
    const cur = currentPlace(c);
    const pos = cur && whereIs(cur.place, name);
    if (!pos) return [];
    const rm = roomAt(cur.place, pos.floor, pos.x, pos.y);
    const out = rm ? thingsIn(cur.place, rm).map(t => ({ id: t.id, name: `the ${t.name} (in this room)` })) : [];
    for (const d of Object.values(cur.place.doors)) {
        if (!rm || !d.rooms.includes(rm.id) || d.state === 'locked' || d.state === 'hidden' || d.state === 'walled') continue;
        const other = cur.place.rooms[d.rooms.find(id => id && id !== rm.id)];
        if (other && !out.some(o => o.id === other.id)) out.push({ id: other.id, name: `${other.name} (next door)` });
    }
    return out.slice(0, 24);
}

/**
 * A companion goes somewhere on the map on their own (they said they would): to a thing in their
 * room or to a room next door. They walk there and stay (they no longer follow the player).
 * Returns what they went to, or '' if they can't (tied up, no way there).
 */
export async function companionGoTo(c, name, targetId, { hide = false, pose = '', stay = true } = {}) {
    const cur = currentPlace(c);
    if (!cur || c.docs.world.combat || lockedReason(c, name)) return '';
    const { key, place } = cur;
    const pos = place.state.positions[name];
    if (!pos) return '';
    const map = floorById(place, pos.floor).map;
    const others = new Set([...Object.entries(place.state.positions).filter(([n, p]) => n !== name && p.floor === pos.floor).map(([, p]) => `${p.x},${p.y}`), ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === pos.floor).map(g => `${g.x},${g.y}`)]);
    const prop = (map.props || []).find(p => p.id === targetId);
    const room = place.rooms[targetId];
    // Or a door, a window, or someone on the map: they go and stand beside it.
    const other = prop || room ? null : place.doors[targetId] ?? place.windows?.[targetId] ?? personByName(place, targetId) ?? (place.state.positions[targetId] && targetId !== name ? { ...place.state.positions[targetId], name: targetId } : null);
    const spot = prop ?? (other && other.floor === pos.floor ? other : null);
    let goals = [];
    if (spot) {
        // Right beside it (or on it, if you can stand there: a pile of hay).
        const w = spot.w || 1, h = spot.h || 1;
        for (let x = spot.x - 1; x <= spot.x + w; x++) for (let y = spot.y - 1; y <= spot.y + h; y++) goals.push({ x, y });
        goals = goals.filter(g => walkable(place, pos.floor, g.x, g.y) && !others.has(`${g.x},${g.y}`) && !(g.x === spot.x && g.y === spot.y && !prop));
    } else if (room && room.floor === pos.floor) {
        const spot = openSquareNear(place, pos.floor, room.rect.x + Math.floor(room.rect.w / 2), room.rect.y + Math.floor(room.rect.h / 2), others, 4);
        if (spot) goals.push(spot);
    }
    // Around the traps they know about if there's another way; over them if there isn't.
    const careful = new Set([...others, ...dangersFor(place, pos.floor, name)]);
    let path = null;
    for (const blocked of [careful, others]) {
        for (const g of goals) {
            if (blocked.has(`${g.x},${g.y}`) && blocked !== others) continue;
            const p = g.x === pos.x && g.y === pos.y ? [] : findPath(place, pos.floor, pos, g, { blocked, knownOnly: false });
            if (p && (!path || p.length < path.length)) path = p;
        }
        if (path) break;
    }
    if (!path) return '';
    const { refreshMap } = await import('../ui/map.js');
    let sprung = '';
    for (const [x, y] of path) {
        const d = doorAt(place, pos.floor, x, y);
        if (d && d.state === 'closed') setDoorState(place, d, 'open');
        Object.assign(pos, { x, y });
        sprung = stepOn(place, name, pos.floor, x, y);
        refreshMap();
        await sleep(110);
        if (sprung) break;
    }
    place.state.waiting ??= {};
    if (stay) place.state.waiting[name] = true;
    if (place.state.hidden?.[name]) delete place.state.hidden[name];
    if (sprung) {
        trapEvents.push(sprung);
        savePlace(key, c);
        refreshMap();
        return '';
    }
    standUp(place, name);
    if (hide && prop && HIDE[prop.type]) hideAt(c, name, prop.id);
    else if (pose && prop) restOn(place, name, prop.id, pose);
    savePlace(key, c);
    refreshMap();
    const restingNow = !hide && pose && prop ? poseNow(place, name) : null;
    return prop ? `${hide && HIDE[prop.type] ? `${HIDE[prop.type]} the ` : restingNow ? `${restingNow.pose === 'sit' ? 'sit on' : restingNow.pose === 'sleep' ? 'sleep on' : 'lie on'} the ` : ''}${prop.label || PROPS[prop.type]?.name || prop.type}`
        : room ? room.name : other.name ? other.name : place.doors[targetId] ? 'door' : 'window';
}

/**
 * Someone searched the room they're in (a Perception or Investigation roll of `total`): every
 * hidden trap in that room with a DC at or under the roll shows up on the map. Returns what was found.
 */
export function searchForTraps(c, name, total) {
    const cur = currentPlace(c);
    const pos = cur && whereIs(cur.place, name);
    if (!pos || !Number.isFinite(total)) return null;
    const { key, place } = cur;
    const rm = roomAt(place, pos.floor, pos.x, pos.y);
    const near = t => (rm ? t.room === rm.id : Math.max(Math.abs(t.x - pos.x), Math.abs(t.y - pos.y)) <= 3);
    const inRoom = Object.values(place.traps).filter(t => t.floor === pos.floor && near(t));
    const found = inRoom.filter(t => t.state === 'hidden' && total >= t.dc);
    learnTraps(found, name);
    for (const t of found) {
        t.state = 'found';
        const prop = floorById(place, t.floor).map.props.find(p => p.trap === t.id);
        if (prop) prop.hidden = false;
    }
    if (found.length) { floorById(place, pos.floor).map.version = (floorById(place, pos.floor).map.version || 0) + 1; savePlace(key, c); }
    return { room: rm?.name ?? 'the passage', found: found.map(t => `${t.kind} (${t.id})`), missed: inRoom.filter(t => t.state === 'hidden').length };
}

/** How someone is hidden right now ({prop, mode: 'in'|'under'|'behind', at}), or null. */
export function hiding(c, name) {
    const cur = currentPlace(c);
    return cur ? hiddenNow(cur.place, name) : null;
}

/**
 * Someone hides in, under or behind a thing next to them (they must already be beside it). Inside
 * or underneath, they move onto its square; behind it, they crouch where they are.
 */
export function hideAt(c, name, propId) {
    const cur = currentPlace(c);
    if (!cur) return null;
    const { key, place } = cur;
    const r = hideIn(place, name, propId);
    if (!r) return null;
    savePlace(key, c);
    return { mode: r.mode, name: r.what };
}

/** Who's caught in a trap ({trap, look, at, kind}), or null. */
export function trappedIn(c, name) {
    const cur = currentPlace(c);
    return cur ? caughtNow(cur.place, name) : null;
}

/** A save went their way: they get loose. Returns true if they were caught. */
export function freeFromTrap(c, name) {
    const cur = currentPlace(c);
    if (!cur || !release(cur.place, name)) return false;
    savePlace(cur.key, c);
    return true;
}

/** How someone is resting right now ({pose, what, type, side, prop}), or null. */
export function resting(c, name) {
    const cur = currentPlace(c);
    return cur ? poseNow(cur.place, name) : null;
}

/** Sit, lie down or go to sleep on a thing (they must be beside it). Returns {pose, what} or null. */
export function restAt(c, name, propId, how = '') {
    const cur = currentPlace(c);
    if (!cur) return null;
    const r = restOn(cur.place, name, propId, how);
    if (r) savePlace(cur.key, c);
    return r;
}

/** Get up. */
export function getUp(c, name) {
    const cur = currentPlace(c);
    if (!cur?.place.state.pose?.[name]) return;
    standUp(cur.place, name);
    savePlace(cur.key, c);
}

/** Come out of hiding (walking anywhere does this too). */
export function unhide(c, name) {
    const cur = currentPlace(c);
    if (!cur?.place.state.hidden?.[name]) return;
    delete cur.place.state.hidden[name];
    savePlace(cur.key, c);
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
        place.state.leftAt ??= {};
        place.state.leftAt[name] = { turn: c.meta.turn, seen: place.state.visited.length };
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
 * Companions the DM sent away who are really somewhere in this place (caged in the dungeon, locked
 * in a cell upstairs): put them in that room on the map, held there (a cage if the story says so),
 * so the player can find them. They stay put ("waiting") until the player reaches them and they're
 * free to move; then they come along again. Away somewhere else (back in town): off the map as before.
 * Returns the names placed.
 */
export function placeHeld(c) {
    const cur = currentPlace(c);
    if (!cur) return [];
    const { key, place } = cur;
    const w = c.docs.world;
    const lead = place.state.positions[c.meta.persona.name];
    const placed = [];
    place.state.waiting ??= {};
    place.state.held ??= {};
    for (const [name, where] of Object.entries(w.away ?? {})) {
        if (place.state.held[name] === where) continue;          // already put where these words say
        if (place.state.waiting[name] && !place.state.held[name]) continue; // stayed behind on their own: they're where they stood
        const spot = heldRoom(place, where, lead);
        if (!spot) continue;
        const rm = place.rooms[spot.roomId];
        const others = new Set([...Object.entries(place.state.positions).filter(([n]) => n !== name).map(([, p]) => `${p.x},${p.y}`), ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === rm.floor).map(g => `${g.x},${g.y}`)]);
        const at = openSquareNear(place, rm.floor, rm.rect.x + Math.floor(rm.rect.w / 2), rm.rect.y + Math.floor(rm.rect.h / 2), others, 4);
        if (!at) continue;
        place.state.positions[name] = { floor: rm.floor, x: at.x, y: at.y };
        if (place.state.hidden?.[name]) delete place.state.hidden[name];
        if (place.state.pose?.[name]) delete place.state.pose[name];
        place.state.waiting[name] = true;
        place.state.held[name] = where;
        if (spot.caged && !conditionsOf(w, name).some(x => /cage/i.test(x))) { w.party[name] ??= { hp: 10, hp_max: 10, conditions: [] }; (w.party[name].conditions ??= []).push('caged'); }
        w.away[name] = `${where} (on the map: ${rm.name}, ${rm.id})`;
        place.state.held[name] = w.away[name];
        if (standingOf(place, name).label === 'prisoner' || spot.caged) setStanding(place, name, standingFor('prisoner', { home: rm.id }));
        placed.push(name);
    }
    if (placed.length) { savePlace(key, c); saveDoc('world'); }
    return placed;
}

/**
 * What a companion agreed to in the chat: "close" (stays right by the player's side: never wanders
 * off), "follow" (comes along), "stay" (stays behind). Set from their own reply, never from a menu.
 */
export async function setStance(c, name, stance, status = null) {
    if (!['close', 'follow', 'stay'].includes(stance)) return;
    c.meta.stance ??= {};
    const before = c.meta.stance[name];
    c.meta.stance[name] = stance;
    saveMeta();
    const waiting = currentPlace(c)?.place.state.waiting?.[name];
    if (stance === 'stay' && !waiting) await setWaiting(name, true, { why: 'their choice' });
    else if (stance !== 'stay' && waiting) await setWaiting(name, false);
    else if (before !== stance) status?.note(stance === 'close' ? `${name} sticks by your side` : `${name} follows you`);
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
export async function approachSpot(spot, redraw = () => { }, { inTurn = false } = {}) {
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
    await walkTo({ x: best.x, y: best.y }, redraw, { inTurn });
    const now = place.state.positions[c.meta.persona.name];
    return near(now.x, now.y);
}

/** What the party carries (everyone's and the shared pack), for keys. */
function carriedItems(c) {
    const w = c.docs.world;
    return [...Object.values(w.inventory ?? {}).flat(), ...(w.items ?? [])].map(String);
}

/** A locked door at a square, and what can be done about it: its lock in words, a key you carry. */
export function lockedDoorInfo(c, door) {
    const cur = currentPlace(c);
    if (!cur || !door) return null;
    const dc = lockDc(cur.place, door);
    return { words: lockWords(dc), key: keyFor(door, carriedItems(c)) };
}

/**
 * Pick a locked door's lock: walk up to it, then the code rolls d20 + Sleight of Hand (or Thieves'
 * Tools if they're better) against the door's own DC, on an open dice card. Success opens it. Two or
 * three failures in a row (or a natural 1) call the DM to decide whether anyone heard. No Claude
 * call otherwise.
 */
export async function pickLock(doorId, redraw = () => { }) {
    const c = campaign();
    const cur = currentPlace(c);
    const door = cur?.place.doors[doorId];
    if (!door || door.state !== 'locked') return;
    const { isRunning } = await import('./orchestrator.js');
    if (isRunning()) { toastr.info('The DM is busy. Try the lock when the turn is done.', 'Map', { timeOut: 2500 }); return; }
    if (stuck(c)) return;
    if (!(await approachSpot({ x: door.x, y: door.y }, redraw))) return;
    const { key, place } = cur;
    const player = c.meta.persona.name;
    const dc = lockDc(place, door);
    const { mod, skill } = pickModifier(statsForName(player, c.meta));
    const die = roll('1d20');
    const natural = die?.natural ?? die?.total ?? 10;
    const total = natural + mod;
    const ok = natural !== 1 && (natural === 20 || total >= dc);
    const what = door.kind === 'cell' ? 'the cell door' : 'the lock';
    c.docs.rolls_log.push({ at: new Date().toISOString(), who: player, what: `${skill} (picking ${door.id})`, kind: 'check', natural, mod, total, dc, success: ok });
    saveDoc('rolls_log');
    if (ok) {
        setDoorState(place, door, 'open');
        delete door.picks;
        await postDiceCard(`🎲 **${player}** · ${skill} (picking ${what}, ${lockWords(dc)}): d20 (${natural}) ${mod >= 0 ? '+' : ''}${mod} = **${total}** ✔ · it clicks open.`, { roll: { who: player, what: skill, natural, total, success: true } });
        look(c, key, place);
        savePlace(key, c);
        redraw();
        // Done in plain view of someone who belongs here: they saw it.
        const seenBy = watchersSeeing(c, place, door.floor, player);
        if (seenBy.length) await callDm(`${seenBy.join(' and ')} watched ${player} pick the lock of ${door.id} (${doorRooms(place, door)}) and open it. Decide what they do about it (a guard: challenge, alarm, or going after them; anyone else: shout, run, or look the other way), brief them if they speak, and set an intent if they go after someone.`);
        return;
    }
    const { count, alarm } = notePickFailure(door, player, natural);
    savePlace(key, c);
    await postDiceCard(`🎲 **${player}** · ${skill} (picking ${what}, ${lockWords(dc)}): d20 (${natural}) ${mod >= 0 ? '+' : ''}${mod} = **${total}** ✘${natural === 1 ? ' · the pick snaps with a loud scrape.' : ` · it won't give (${count} tr${count > 1 ? 'ies' : 'y'}).`}`, { roll: { who: player, what: skill, natural, total, success: false } });
    if (!alarm) return;
    // Enough noise and time: does anyone notice? The DM decides (Haiku), told who could hear.
    const listeners = Object.values(place.guards).filter(g => g.state !== 'gone' && g.state !== 'dead' && g.floor === door.floor && Math.max(Math.abs(g.x - door.x), Math.abs(g.y - door.y)) <= EARSHOT)
        .map(g => `${g.name} (${Math.max(Math.abs(g.x - door.x), Math.abs(g.y - door.y))} squares away)`);
    const rooms = door.rooms.map(id => place.rooms[id]?.name).filter(Boolean).join(' / ');
    const { runTurn } = await import('./orchestrator.js');
    await runTurn({ force: 'explore', placeEvent: `${player} has been working at the lock of ${door.id} (${rooms || 'a door'}) and failed ${natural === 1 ? 'badly: the pick snapped with a loud scrape' : `${count} times in a row: it's taking time and making noise`}. ${listeners.length ? `Within earshot: ${listeners.join(', ')}. Decide whether any of them notices (roll their Perception with "spot" against ${player}'s Stealth, or decide it's too quiet) and what they do.` : 'Nobody on the map is close enough to hear. Something else may happen, or nothing (a short line is fine).'} The lock is still shut; ${player} can keep trying.` });
}

/** Unlock a door with the key someone in the party carries: walk up, it opens. No roll. */
export async function unlockWithKey(doorId, redraw = () => { }) {
    const c = campaign();
    const cur = currentPlace(c);
    const door = cur?.place.doors[doorId];
    if (!door || door.state !== 'locked') return;
    const item = keyFor(door, carriedItems(c));
    if (!item) return;
    const { isRunning } = await import('./orchestrator.js');
    if (isRunning()) { toastr.info('The DM is busy. Try the lock when the turn is done.', 'Map', { timeOut: 2500 }); return; }
    if (stuck(c)) return;
    if (!(await approachSpot({ x: door.x, y: door.y }, redraw))) return;
    setDoorState(cur.place, door, 'open');
    await postNote(`🔑 ${c.meta.persona.name} unlocks the door with the ${item}.`);
    look(c, cur.key, cur.place);
    savePlace(cur.key, c);
    redraw();
    const seenBy = watchersSeeing(c, cur.place, door.floor, c.meta.persona.name);
    if (seenBy.length) await callDm(`${seenBy.join(' and ')} watched ${c.meta.persona.name} unlock ${door.id} (${doorRooms(cur.place, door)}) with the ${item} and open it. Decide whether that was theirs to do and what the watcher does about it; brief them if they speak.`);
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
    const leadRoom = roomAt(place, lead.floor, lead.x, lead.y);
    const inLeadRoom = () => {
        if (!leadRoom) return null;
        const tiles = [];
        for (let x = leadRoom.rect.x; x < leadRoom.rect.x + leadRoom.rect.w; x++) for (let y = leadRoom.rect.y; y < leadRoom.rect.y + leadRoom.rect.h; y++) {
            if (walkable(place, lead.floor, x, y) && !taken.has(`${x},${y}`) && !stairsAt(place, lead.floor, x, y)) tiles.push({ x, y, d: Math.max(Math.abs(x - lead.x), Math.abs(y - lead.y)) });
        }
        return tiles.sort((a, b) => a.d - b.d)[0] ?? null;
    };
    for (const n of names.slice(1)) {
        const p = st.positions[n];
        if (at || !p || p.floor !== lead.floor) {
            const near = inLeadRoom();
            const spot = near ? { x: near.x, y: near.y } : freeNear(place, lead.floor, lead.x, lead.y, taken);
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
    const prevKey = c.docs.world.place?.key;
    if (prevKey && prevKey !== key) pruneAware(c, places.get(`${c.meta.id}:${prevKey}`));
    c.docs.world.place = { key, floor: lead.floor };
    syncSky(c, { key, place });
    // Inside a place the location is the place itself; rooms are tracked by the map, not by a name the DM picks each turn.
    c.docs.world.location = place.name;
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
    // What this place's people had seen of the party stays here, not in the next place's prompt.
    pruneAware(c, currentPlace(c)?.place);
    c.docs.world.place = null;
    saveDoc('world');
    import('../ui/map.js').then(m => m.refreshMap());
}

/** Who looks around for the party: the player and the companions with them (not one held somewhere else: her eyes don't reveal her cell to you). */
export function viewersOf(c, place) {
    return partyOnMap(c).filter(n => !place.state.held?.[n]);
}

/** Update the fog of war from where the party stands. */
export function look(c, key, place) {
    const names = viewersOf(c, place);
    place.state.lights = partyLights(c, names);
    const floorId = place.state.positions[names[0]]?.floor ?? place.state.floor;
    const viewers = names.map(n => place.state.positions[n]).filter(p => p && p.floor === floorId);
    const vis = computeVisible(place, floorId, viewers);
    reveal(place, floorId, vis);
    return vis;
}

const LIGHT_RE = /\b(torch|torches|lantern|lamp|candle|candles|glowstone|sunrod|everburning|light stone)\b/i;

/** Who in the party carries a light (a torch, a lantern): the squares around them are lit in the dark. */
function partyLights(c, names) {
    const w = c.docs.world;
    const out = {};
    for (const n of names) {
        const own = w.inventory?.[n] ?? [];
        const shared = n === names[0] ? (w.items ?? []) : [];
        if ([...own, ...shared].some(i => LIGHT_RE.test(String(i)))) out[n] = true;
    }
    return out;
}

/** Forget what a place's people had seen of the party (the aware list is about where the party is now). */
function pruneAware(c, place) {
    const w = c.docs.world;
    if (!place || !w.aware) return;
    for (const k of Object.keys(w.aware)) if (personByName(place, k)) delete w.aware[k];
}

/** Out of it by the DM's conditions on them (unconscious, asleep, tied up): they notice nothing and go nowhere. */
function outByWorld(c, g) {
    return Boolean(outBy(conditionsOf(c.docs.world, g.name)));
}

/** The people who belong here, awake and able, who can see `name` right now (for what they'd witness). */
export function watchersSeeing(c, place, floorId, name) {
    return Object.values(place.guards)
        .filter(g => !isOut(g) && g.floor === floorId && g.hostile !== true && !outByWorld(c, g) && !(g.unaware ?? []).some(u => nameKey(u) === nameKey(name)) && guardSees(place, floorId, g, [name]).length)
        .map(g => `${g.name} (${g.description || 'someone who belongs here'})`);
}

function doorRooms(place, door) {
    return door.rooms.map(id => place.rooms[id]?.name).filter(Boolean).join(' / ') || 'a door';
}

async function callDm(placeEvent) {
    const { runTurn } = await import('./orchestrator.js');
    await runTurn({ force: 'explore', placeEvent });
}

/** Places that keep late hours: their people are up at night and their doors open. */
const NIGHTLIFE = /tavern|\binn\b|\bpub\b|alehouse|brothel|gambling|\bden\b|club|dock|harbou?r|guardhouse|barracks|watch|garrison|prison|jail|gaol|temple|shrine|hospital|infirmary|hideout|lair|camp/i;

/**
 * The sky over the map, from the world's clock and weather: dark outside from evening on; at night
 * residents go to sleep (on a bed if their room has one), shops and homes in town lock their doors,
 * and night guards carry lanterns; morning undoes it all. The weather shows outdoors (rain, snow,
 * mist on the map) and shortens sight in fog. Returns true if anything changed.
 */
export function syncSky(c = campaign(), cur = currentPlace(c)) {
    if (!c || !cur) return false;
    const { key, place } = cur;
    const w = c.docs.world;
    ensureClock(w);
    const night = isNight(w.time), late = isLate(w.time);
    let changed = false;
    if (place.state.weather !== w.weather) {
        place.state.weather = w.weather;
        for (const f of place.floors) {
            if (!OUTDOOR.has(f.map.theme)) continue;
            const amb = weatherAmbience(w.weather, f.map.theme);
            if (amb) f.map.ambience = amb; else delete f.map.ambience;
            f.map.version = (f.map.version || 0) + 1;
        }
        changed = true;
    }
    if (place.state.night === night && place.state.late === late) { if (changed) savePlace(key, c); return changed; }
    place.state.night = night;
    place.state.late = late;
    const upLate = NIGHTLIFE.test(`${place.kind || ''} ${place.hostKind || ''} ${place.name || ''}`);
    for (const g of Object.values(place.guards)) {
        if (g.state === 'dead' || g.state === 'gone' || g.hostile === true) continue;
        const resident = g.role && g.role !== 'guard';
        if (late && resident && !upLate && !g.down) { g.down = 'asleep'; g.sleeper = true; toBed(place, g); }
        else if (!late && g.sleeper) { delete g.down; delete g.sleeper; }
        if (g.role === 'guard') {
            if (night && !g.lantern) { g.lantern = true; g.nightLantern = true; }
            else if (!night && g.nightLantern) { delete g.lantern; delete g.nightLantern; }
        }
    }
    // A town at night: shops and homes shut (their doors locked); taverns and the like stay open.
    for (const d of Object.values(place.doors)) {
        if (!d.enter) continue;
        const b = place.buildings?.[d.enter];
        const open = NIGHTLIFE.test(`${b?.kind || ''} ${b?.name || ''}`);
        if (late && !open && d.state === 'closed') { setDoorState(place, d, 'locked'); d.nightLocked = true; }
        else if (!late && d.nightLocked) { delete d.nightLocked; if (d.state === 'locked') setDoorState(place, d, 'closed'); }
    }
    for (const f of place.floors) f.map.version = (f.map.version || 0) + 1;
    savePlace(key, c);
    return true;
}

/** Someone going to sleep lies down on a free bed in their room, if there is one. */
function toBed(place, g) {
    const rm = roomAt(place, g.floor, g.x, g.y);
    if (!rm) return;
    const map = floorById(place, g.floor).map;
    const taken = new Set([...Object.values(place.state.positions).filter(p => p.floor === g.floor), ...Object.values(place.guards).filter(o => o !== g && o.state !== 'gone' && o.floor === g.floor)].map(p => `${p.x},${p.y}`));
    for (const p of map.props || []) {
        if (p.type !== 'bed' || roomAt(place, g.floor, p.x, p.y)?.id !== rm.id) continue;
        for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) {
            if (!taken.has(`${x},${y}`)) { Object.assign(g, { x, y }); return; }
        }
    }
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
    if (quiet) return;
    // Written the first time anyone walks in (and kept): by the local model from the room's facts, or from pieces.
    if (!room.description) room.description = await writeDescription(place, room);
    if (room.description) {
        await postNarration(`**${room.name}.** ${room.description}`);
        voiceLine({ kind: 'dm', text: `${room.name}. ${room.description}` });
    }
}

/** A room's description from its facts: the local model if there is one, else put together in code. */
async function writeDescription(place, room) {
    const facts = { things: thingsIn(place, room).map(t => t.name), condition: place.condition || 'kept', placeName: place.name, kind: place.kind };
    const s = settings();
    if (s.useHelper) {
        try {
            const { system, user } = describePrompt(room, facts);
            const text = cleanDescription(await callLocal({ system, messages: [{ role: 'user', content: user }], maxTokens: 120, profileId: s.helperProfileId }));
            if (text) return text;
        } catch (error) { console.warn('[Dungeon Master] room description failed', error); }
    }
    return describeRoom(room, facts);
}

// ---------- building ----------

let building = false;

/**
 * Build a place the DM asked for (or go back to it if it already exists).
 * @param {{name:string, size:'big'|'small', kind:string, why?:string}} req
 * @param {{plan?: object}} [o] plan = a ready plan (skips asking Claude; used for testing)
 */
export async function requestBuild(req, { status = null, signal = null, plan = null, confirm = true, ask = false, quiet = false } = {}) {
    const c = campaign();
    if (!c || !req?.name) return null;
    const existing = atlasEntry(req.name, c);
    if (existing) {
        // Already there (the DM named it again): nothing to do.
        if (currentPlace(c)?.key === existing.key || currentPlace(c)?.place.parent?.key === existing.key) return currentPlace(c).place;
        status?.note(`Back to ${existing.name}`);
        return enterPlace(existing.key);
    }
    if (building) return null;
    const big = req.size === 'big';
    const town = /town|village|hamlet|city|outpost|settlement/.test(String(req.kind || '').toLowerCase());
    const byClaude = settings().mapBuilder === 'claude';
    if ((big || ask) && confirm) {
        const ok = await ST.callGenericPopup(
            `<h3>Build ${escape(req.name)}?</h3><p>Claude wants to build <b>${escape(req.name)}</b> as a full map${req.why ? `: ${escape(req.why)}` : ''}.</p><p>Every room on every floor is made once and kept for the rest of the campaign (${byClaude ? 'Claude plans it: about $0.15–0.30, a minute or so' : 'built by the map algorithm from a short brief: a few seconds, nearly free'}).</p>`,
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
        const { askPlacePlan, askPlaceBrief } = await import('./dm.js');
        anim.cycle(big ? ['Drawing floor plans', 'Deciding what lives where', 'Hiding traps and secret doors', 'Placing keys and locks'] : town ? ['Laying out the streets', 'Raising buildings', 'Painting shop signs'] : ['Sketching the place', 'Furnishing it']);
        const seed = Math.floor(Math.random() * 1e9);
        // A short brief (the local helper or Haiku), then the architect builds every room from it by algorithm.
        // Claude plans every room itself only when the settings say so.
        let raw = plan;
        if (!raw && byClaude) raw = await askPlacePlan({ ...req, town }, { signal });
        if (!raw) {
            const brief = normalizeBrief(await askPlaceBrief({ ...req, town }, { signal }).catch(error => { console.warn('[Dungeon Master] brief failed, building from the request', error); return {}; }), req);
            if (town) brief.kind = brief.kind && /town|village|city|hamlet/.test(brief.kind) ? brief.kind : 'town';
            raw = town ? townFromBrief(brief, seed) : WILD_KINDS.test(`${brief.kind} ${brief.name}`.toLowerCase()) && !blueprintFor(brief.kind).building ? wildsFromBrief(brief, seed) : planFromBrief(brief, seed);
        }
        anim.step(town ? 'Building the town' : 'Building the floors');
        await sleep(300);
        // (Not 'plan': that's the ready plan this was called with, read above.)
        const placePlan = town ? null : normalizePlan({ ...raw, name: raw.name || req.name, kind: raw.kind || req.kind });
        // A wild place (a jungle, a forest, a swamp, a camp) is land: clearings joined by trails, not rooms.
        const wild = !town && !placePlan.building && WILD_KINDS.test(`${placePlan.kind} ${placePlan.name}`.toLowerCase());
        const place = town ? generateTown(normalizeTownPlan(raw), seed) : wild ? generateWilds(placePlan, seed) : generatePlace(placePlan, seed);
        anim.step(town ? `Raising ${Object.keys(place.buildings).length} buildings` : `Furnishing ${Object.keys(place.rooms).length} rooms`);
        await sleep(400);
        const key = placeKey(place.name || req.name);
        // A building is two maps: its grounds outside (with the front door) and its inside. The front
        // door goes between them; the party starts outside when they're arriving (or out in the yard).
        let enterKey = key, outside = null;
        // Who may be where, from how the party arrives (locked in a cell: prisoners; sneaking in:
        // intruders; a tavern: guests). The DM can change it any turn.
        const partyNames = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
        const standing = inferStanding(place, { start: req.start, why: req.why, objective: req.objective, startRoom: place.start?.room ?? null });
        for (const n of partyNames) setStanding(place, n, standing);
        if (placePlan?.building) {
            anim.step('Laying out the grounds');
            outside = generateGrounds(placePlan, place, seed + 1);
            outside.hostKind = placePlan.kind;
            for (const n of partyNames) setStanding(outside, n, inferStanding(outside, { start: req.start, why: req.why, objective: req.objective }));
            const insideKey = `${key}--b1`;
            place.parent = { key, door: outside.buildings.B1.door };
            outside.buildings.B1.interior = insideKey;
            storePlace(c, key, outside, { size: big ? 'big' : 'small' });
            storePlace(c, insideKey, place, { size: big ? 'big' : 'small', parent: key });
            const startRoom = place.rooms[place.start?.room];
            if (!placePlan.startOutside && !(startRoom?.exit && /arriv|approach|outside|walk up|reach|come to|knock/i.test(`${req.why} ${req.start}`))) enterKey = insideKey;
        } else storePlace(c, key, place, { size: big ? 'big' : 'small' });
        await flushWrites();
        const summary = town
            ? `🗺️ **${place.name}** is ready: ${Object.keys(place.buildings).length} buildings. Their insides are built when you walk in.`
            : `🗺️ **${place.name}** is ready: ${place.floors.length > 1 ? `${place.floors.length} floors, ` : ''}${Object.keys(place.rooms).length} rooms${outside ? ', and its grounds outside (walk through the front door to go in or out)' : ''}.${place.fog ? ' Rooms reveal themselves as you explore.' : ''}`;
        await anim.finish(summary);
        await enterPlace(enterKey, { quiet });
        return place;
    } catch (error) {
        await anim.fail(String(error?.message || error));
        throw error;
    } finally {
        building = false;
    }
}

/**
 * Throw a saved map away and build it again from a fresh plan (with the newest rules): the map
 * the party is on, or the one named. Its whole family goes: a building's grounds and inside, a
 * town's buildings. Asks first (what happened on the map is lost). The party lands in the new one
 * if they were on the old one.
 */
export async function rebuildPlace(name = '', { status = null } = {}) {
    const c = campaign();
    if (!c) return null;
    const list = atlas(c).places;
    const entry = name ? atlasEntry(name, c) : list[c.docs.world.place?.key];
    if (!entry) throw new Error(name ? `There's no saved map called "${name}".` : 'You\'re not on a map right now. Name the one to rebuild, e.g. /dmrebuild Blackmoor Manor');
    const top = (entry.parent && list[entry.parent]) || entry;
    const family = Object.values(list).filter(e => e.key === top.key || e.parent === top.key || e.key.startsWith(`${top.key}--`));
    const ok = await ST.callGenericPopup(`<h3>Rebuild ${escape(top.name)}?</h3><p>This map is thrown away, with everything that happened on it (opened doors, sprung traps, moved furniture), and Claude plans it again with the newest rules (about $0.05–0.30).</p>`, ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Rebuild', cancelButton: 'Keep it' });
    if (ok !== ST.POPUP_RESULT.AFFIRMATIVE && ok !== true && ok !== 1) return null;
    // The kind of place it is: the inside's kind for a building (its grounds are kind "grounds").
    const kind = top.kind === 'grounds' ? (family.find(e => e.parent === top.key)?.kind ?? '') : top.kind;
    const wasHere = family.some(e => e.key === c.docs.world.place?.key);
    const where = c.docs.world.sceneCard?.place || '';
    if (wasHere) leavePlace(c);
    for (const e of family) {
        delete list[e.key];
        places.delete(`${c.meta.id}:${e.key}`);
        await deleteFile(e.file).catch(() => false);
    }
    saveDoc('atlas');
    status?.note(`Rebuilding ${top.name}`);
    return requestBuild({ name: top.name, size: top.size === 'big' ? 'big' : 'small', kind: kind === 'interior' ? '' : kind, why: 'the player asked to rebuild this map', start: wasHere ? where : '' }, { status, confirm: false });
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
    const key = b.interior ?? `${townKey}--${slug(b.id, 12)}`;
    if (!atlas(c).places[key]) {
        const inside = generateInterior(b, Math.floor(Math.random() * 1e9));
        inside.parent = { key: townKey, door: door.id };
        inside.hostKind = b.kind || '';
        // Walking in off the street: a guest of a shop or tavern, an intruder in someone's home,
        // unless the home is the party's own (named for one of them): then they live here.
        const ours = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
        const label = ` ${nameKey(`${b.name} ${b.keeper || ''} ${b.owner || ''} ${b.description || ''}`)} `;
        const home = ours.some(n => nameKey(n).split(' ').some(wd => wd.length >= 3 && label.includes(` ${wd} `)));
        for (const n of ours) setStanding(inside, n, home ? standingFor('resident') : inferStanding(inside, { why: 'walked in through the front door' }));
        storePlace(c, key, inside, { parent: townKey });
        b.interior = key;
        savePlace(townKey, c);
    }
    // Arrive just inside the front door (its first way out).
    const inside = await loadPlace(key, c);
    const front = inside?.exits?.[0];
    const at = front ? { floor: front.floor, ...freeNear(inside, front.floor, front.x, front.y) } : null;
    await enterPlace(key, { at });
}

// ---------- walking ----------

let walking = false;

/** Squares walked since the last turn; enough walking is a turn of its own. */
let walked = 0;
const MOVE_TURN_SQUARES = 12;
export function resetWalked() { walked = 0; }

/** What a hunter reaching someone tells the DM. */
function hunterEvent(caught) {
    return `${caught.map(h => `${h.name} catches up with ${h.target} and attacks`).join('; ')}. That starts a fight: send start_combat now (with them in it) and ask for initiative; their attack comes in initiative order.`;
}

/** Squares a companion steers around: traps they know about, and fire. */
function dangersFor(place, floorId, name) {
    return [...trapsKnownTo(place, floorId, name), ...Object.keys(floorById(place, floorId).map.fire || {})];
}

/** Traps someone set off while the DM was busy (a companion walking somewhere); the next turn rules on them. */
let trapEvents = [];
export function takeTrapEvents() { const t = trapEvents; trapEvents = []; return t; }


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
export async function walkTo(target, redraw = () => { }, { inTurn = false } = {}) {
    const c = campaign();
    const cur = currentPlace(c);
    if (!c || !cur || walking) return;
    const { key, place } = cur;
    const names = partyOnMap(c);
    const lead = place.state.positions[names[0]];
    if (!lead) return;
    if (stuck(c)) return;
    if (place.state.hidden?.[names[0]]) delete place.state.hidden[names[0]];
    standUp(place, names[0]);
    const { isRunning } = await import('./orchestrator.js');
    if (!inTurn && isRunning()) { toastr.info('The DM is busy. Move when the turn is done.', 'Map', { timeOut: 2500 }); return; }
    const floorId = lead.floor;
    // Running into the dark: no warnings about what's there. Walk the real way toward it, as far as it goes.
    const dark = place.fog !== false && !isExplored(place, floorId, target.x, target.y);
    const door = dark ? null : doorAt(place, floorId, target.x, target.y);
    if (door && door.state === 'locked') { toastr.info(`That door is locked (${door.id}). Tell the DM how you deal with it.`, 'Map', { timeOut: 3500 }); return; }
    const others = new Set([
        ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.state !== 'dead' && g.floor === floorId).map(g => `${g.x},${g.y}`),
        ...Object.entries(place.state.waiting || {}).filter(([n, w]) => w && place.state.positions[n]?.floor === floorId).map(([n]) => `${place.state.positions[n].x},${place.state.positions[n].y}`),
    ]);
    const path = findPath(place, floorId, lead, target, { blocked: others, toward: dark });
    if (dark && !path?.length) { toastr.info('Something in the dark blocks the way.', 'Map', { timeOut: 2500 }); return; }
    if (dark) target = { x: path[path.length - 1][0], y: path[path.length - 1][1] };
    if (!path?.length) {
        // Shut in (a locked cell, a locked room): say so, rather than a vague "can't get there".
        const here = roomAt(place, floorId, lead.x, lead.y);
        const doorsHere = here ? Object.values(place.doors).filter(d => d.rooms.includes(here.id)) : [];
        const locked = doorsHere.filter(d => d.state === 'locked');
        const shutIn = locked.length && !doorsHere.some(d => !['locked', 'hidden', 'walled'].includes(d.state));
        const why = !walkable(place, floorId, target.x, target.y) ? 'You can\'t stand there.'
            : shutIn ? `The ${locked[0].kind === 'cell' ? 'cell door' : 'door'} is locked (${locked[0].id}). Tell the DM how you deal with it.`
                : 'You can\'t get there from here (yet).';
        toastr.info(why, 'Map', { timeOut: 3500 });
        return;
    }
    walking = true;
    // Leaving the room: each companion in it decides (local model) whether to come along. They
    // stand still until they've decided; on a yes they follow (a little faster, to catch up), on a
    // no they stay where they are. Followers find their own way to the player each step.
    const fromRoom = roomAt(place, floorId, lead.x, lead.y), toRoom = roomAt(place, floorId, target.x, target.y);
    const onFloor = followers(c, place).filter(n => place.state.positions[n]?.floor === floorId);
    const leaving = fromRoom?.id !== toRoom?.id || !fromRoom;
    const deciding = leaving ? onFloor.filter(n => { const p = place.state.positions[n]; return roomAt(place, floorId, p.x, p.y)?.id === fromRoom?.id && !['close', 'follow'].includes(c.meta.stance?.[n]); }) : [];
    const active = new Set(onFloor.filter(n => !deciding.includes(n)));
    const refused = new Set();
    const pending = deciding.map(n => decideFollow(c, n, fromRoom?.name, toRoom?.name).then(d => {
        if (d.follows) { active.add(n); return; }
        refused.add(n);
        redraw();
        return setWaiting(n, true, { why: d.why });
    }));
    const trapped = [];
    const gap = p => Math.max(Math.abs(p.x - lead.x), Math.abs(p.y - lead.y));
    /** Each follower takes a step (two when far behind) on their own way to the player; nearest first. */
    const advance = () => {
        let moved = false;
        const list = [...active].filter(n => place.state.positions[n]?.floor === floorId).sort((a, b) => gap(place.state.positions[a]) - gap(place.state.positions[b]));
        for (const n of list) {
            const p = place.state.positions[n];
            const taken = new Set([...others, ...Object.entries(place.state.positions).filter(([m, q]) => m !== n && m !== names[0] && q.floor === floorId).map(([, q]) => `${q.x},${q.y}`)]);
            const steps = followSteps(place, floorId, p, lead, { taken, steps: gap(p) > 3 ? 2 : 1, avoid: dangersFor(place, floorId, n) });
            // No way to get any closer (shut in, cut off): they stop trying for this walk.
            if (!steps.length && gap(p) > 3) active.delete(n);
            for (const [x, y] of steps) {
                const d = doorAt(place, floorId, x, y);
                if (d && d.state === 'closed') setDoorState(place, d, 'open');
                Object.assign(p, { x, y });
                if (place.state.hidden?.[n]) delete place.state.hidden[n];
                standUp(place, n);
                moved = true;
                // Their own way, their own traps.
                const sprung = stepOn(place, n, floorId, x, y);
                if (sprung) { active.delete(n); trapped.push(sprung); break; }
            }
        }
        return moved;
    };
    const seenGuards = new Set(visibleGuards(place, floorId, look(c, key, place)).map(g => g.name));
    let event = null, handoff = null, newRoom = null;
    const greet = []; // companions you came back to or walked away from: they may speak
    try {
        for (const [x, y] of path) {
            const d = doorAt(place, floorId, x, y);
            if (d && d.state === 'closed') setDoorState(place, d, 'open');
            lead.x = x; lead.y = y;
            walked++;
            advance();
            // Anyone after the party keeps after them, a step for each of the player's.
            const caught = moveHunters(place, floorId, names, 1, { skip: g => outByWorld(c, g) });
            const vis = look(c, key, place);
            redraw();
            await sleep(95);
            // A trap here. Hidden ones stay hidden until someone searches the room (a Perception or
            // Investigation roll) or steps on one: then it springs.
            const sprung = stepOn(place, names[0], floorId, x, y, { player: true });
            if (sprung || trapped.length) { event = [sprung, ...trapped].filter(Boolean).join(' '); break; }
            if (caught.length) { redraw(); event = hunterEvent(caught); break; }
            // Guards and residents who see the party: a trespasser stops the walk (the DM rules on it).
            const watched = watchParty(c, cur, names);
            if (watched.events.length) { event = watched.events.join(' '); break; }
            const newGuard = visibleGuards(place, floorId, vis).find(g => !seenGuards.has(g.name) && g.hostile !== false);
            if (newGuard) { event = `${newGuard.name} (${newGuard.description || 'a guard'}${newGuard.down ? `, ${DOWN_WORDS[newGuard.down]}` : ''}) comes into view in ${place.rooms[newGuard.room]?.name ?? 'a passage'}, ${Math.max(Math.abs(newGuard.x - x), Math.abs(newGuard.y - y))} squares away${newGuard.state === 'alert' ? ', already alert' : ''}. Decide if they notice the party (their passive Perception against the party's Stealth if sneaking), and what they do.`; break; }
            const up = stairsAt(place, floorId, x, y);
            if (up) { handoff = { stairs: up }; break; }
            const exit = exitAt(place, floorId, x, y);
            if (exit) { handoff = { exit }; break; }
            if (d?.enter) { handoff = { building: d }; break; }
            if (d?.exit) { handoff = { exit: d }; break; }
        }
        // Wait for anyone still deciding, then everyone following catches up (unless something happened).
        if (pending.length) await Promise.all(pending);
        for (let i = 0; i < 40 && !event && advance(); i++) {
            look(c, key, place);
            redraw();
            await sleep(95);
        }
        if (!event && trapped.length) event = trapped.join(' ');
        // Rooms entered on the way; a companion who stayed behind rejoins when you reach them.
        const seenBefore = new Set(place.state.visited);
        await noteRoom(c, place);
        const nowIn = roomAt(place, lead.floor, lead.x, lead.y);
        if (nowIn && !seenBefore.has(nowIn.id)) newRoom = nowIn.id;
        const here = roomAt(place, lead.floor, lead.x, lead.y);
        // Coming back into their room (or right up to them in a corridor) brings them along again;
        // never on the same walk they decided to stay. Someone locked up (caged, in a cell) can't come,
        // but they're with you now: they can hear and talk to you until you leave again.
        for (const [n, w] of Object.entries(place.state.waiting || {})) {
            const p = place.state.positions[n];
            if (!w || !p || p.floor !== lead.floor || refused.has(n)) continue;
            const theirs = roomAt(place, p.floor, p.x, p.y);
            const near = !theirs && !here && Math.max(Math.abs(p.x - lead.x), Math.abs(p.y - lead.y)) <= 2;
            if (!near && !(here && theirs?.id === here.id)) continue;
            if (fromRoom && theirs?.id === fromRoom.id) continue; // they were with you already
            const since = place.state.visited.slice(place.state.leftAt?.[n]?.seen ?? place.state.visited.length).map(id => place.rooms[id]?.name).filter(Boolean);
            if (lockedReason(c, n)) {
                if (isAway(c.docs.world, n)) { applyPresence(c.docs.world, c.meta.party.map(m => m.name), {}, [n]); saveDoc('world'); }
                greet.push({ name: n, kind: 'held', room: theirs?.name ?? '', why: place.state.held?.[n] ?? '' });
                continue;
            }
            if (place.state.held?.[n]) delete place.state.held[n];
            await setWaiting(n, false, { quiet: true });
            greet.push({ name: n, kind: 'back', room: theirs?.name ?? '', since, turns: c.meta.turn - (place.state.leftAt?.[n]?.turn ?? c.meta.turn) });
        }
        // Walking out on someone who's staying (or can't come): they're away again, and may say something as you go.
        if (fromRoom && fromRoom.id !== here?.id) {
            for (const [n, w] of Object.entries(place.state.waiting || {})) {
                const p = place.state.positions[n];
                if (!w || !p || p.floor !== floorId || roomAt(place, p.floor, p.x, p.y)?.id !== fromRoom.id) continue;
                const locked = Boolean(lockedReason(c, n));
                if (!isAway(c.docs.world, n)) {
                    const heldText = place.state.held?.[n];
                    await setWaiting(n, true, { quiet: true });
                    if (heldText) place.state.held[n] = c.docs.world.away[n];
                }
                greet.push({ name: n, kind: locked ? 'left-held' : 'left', room: fromRoom.name, refused: refused.has(n) });
            }
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
                // Leaving the map for good: ask first (a stray tap shouldn't end it).
                const ok = await ST.callGenericPopup(`<h3>Leave ${escape(place.name)}?</h3><p>You'll walk out and this map closes. The DM takes the story from there (it can bring you back here later).</p>`, ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Leave', cancelButton: 'Stay' });
                if (ok === ST.POPUP_RESULT.AFFIRMATIVE || ok === true || ok === 1) {
                    event = `The party walked out of ${place.name} through its way out.`;
                    leavePlace(c);
                } else {
                    // Step back off the way out.
                    const back = freeNear(place, lead.floor, lead.x, lead.y);
                    Object.assign(lead, back);
                }
            }
        }
        savePlace(key, c);
        saveDoc('world');
        redraw();
    } finally {
        walking = false;
    }
    // Inside a turn (walking up to what the player acts on): what happened goes to that turn.
    if (inTurn) {
        if (event) trapEvents.push(event);
        return;
    }
    if (event) {
        walked = 0;
        const { runTurn } = await import('./orchestrator.js');
        await runTurn({ force: 'explore', placeEvent: event });
    } else if (walked >= MOVE_TURN_SQUARES && !handoff && !c.docs.world.combat) {
        // Walked far enough for the world to take a turn too (fire spreads, people move, the DM's clock ticks).
        walked = 0;
        const { runTurn } = await import('./orchestrator.js');
        await runTurn({ moved: true });
    } else if (greet.length && !handoff) {
        // Finding a companion held somewhere for the first time: the DM writes her first words (from
        // her mind and what she knows), not a cheap local guess. Later comings and goings stay local.
        const first = greet.find(g => g.kind === 'held' && !place.state.greeted?.[g.name]);
        if (first) {
            place.state.greeted ??= {};
            place.state.greeted[first.name] = true;
            savePlace(key, c);
            walked = 0;
            const { runTurn } = await import('./orchestrator.js');
            await runTurn({ force: 'explore', placeEvent: `${c.meta.persona.name} has just found ${first.name}, held in ${first.room || 'this room'}${first.why ? ` (${first.why.replace(/\s*\(on the map:.*\)$/, '')})` : ''}. This is their first meeting here. Narrate only what ${c.meta.persona.name} sees, and brief ${first.name} for her first words from her mind and what she knows: she can't get out by herself, and she knows nothing of this place beyond what she has seen.` });
        } else {
            const { companionsSeeYou } = await import('./orchestrator.js');
            await companionsSeeYou(c, greet);
        }
    } else if (newRoom && !handoff) {
        const { companionCuriosity } = await import('./orchestrator.js');
        await companionCuriosity(c, newRoom);
    }
}

/**
 * The people on the map look around: guards and residents who can see a party member react (a
 * trespasser: the DM is told; someone allowed: a vague line in their bubble, no model). Returns
 * what the DM must rule on, or ''.
 */
export function watchTurn(c = campaign()) {
    const cur = currentPlace(c);
    if (!cur || c.docs.world.combat) return '';
    const { events } = watchParty(c, cur, partyOnMap(c));
    if (events.length) savePlace(cur.key, c);
    return events.join(' ');
}

/** Patrols move on each player turn. Returns guards that just came into view. */
export function tickPlace(c = campaign()) {
    const cur = currentPlace(c);
    if (!cur || !Object.keys(cur.place.guards).length) return [];
    const { key, place } = cur;
    const floorId = place.state.positions[c.meta.persona.name]?.floor ?? place.state.floor;
    const before = new Set(visibleGuards(place, floorId, look(c, key, place)).map(g => g.name));
    tickGuards(place, Math.random, 0.5, PATROL_STEPS, { skip: g => outByWorld(c, g) });
    const vis = look(c, key, place);
    clearBodies(place, c.meta.turn, 3, { floorId, visible: vis });
    const now = visibleGuards(place, floorId, vis);
    savePlace(key, c);
    return now.filter(g => !before.has(g.name) && g.hostile !== false);
}

/**
 * A turn passes for the people with somewhere to be: hunters close in (up to 6 squares, a turn of
 * movement), followers keep up, the frightened get away. Returns what the DM should hear (someone
 * reached the party), or ''.
 */
export function huntersTurn(c = campaign()) {
    const cur = currentPlace(c);
    if (!cur || c.docs.world.combat || !Object.values(cur.place.guards).some(g => g.intent)) return '';
    const { key, place } = cur;
    clearEngaged(place);
    const floorId = place.state.positions[c.meta.persona.name]?.floor ?? place.state.floor;
    const caught = moveHunters(place, floorId, partyOnMap(c), 6, { skip: g => outByWorld(c, g) });
    look(c, key, place);
    savePlace(key, c);
    return caught.length ? hunterEvent(caught) : '';
}

/** Which thing someone means by their words, among what they can see on their floor (see core/targets.js). */
export function targetFor(c, actor, words) {
    const cur = currentPlace(c);
    const pos = cur && whereIs(cur.place, actor);
    if (!pos) return {};
    const r = resolveTarget(cur.place, pos, words, { last: cur.place.state.lastTarget?.[actor] ?? '', exclude: partyOnMap(c) });
    const tell = t => ({ ...t, floor: pos.floor, where: whereWords(cur.place, pos.floor, t, pos) });
    return r.pick ? { pick: tell(r.pick) } : r.choices ? { choices: r.choices.map(tell) } : {};
}

/** Remember what someone acted on, so "the bookshelf" next time means the same one. */
export function rememberTarget(c, actor, id) {
    const cur = currentPlace(c);
    if (!cur) return;
    cur.place.state.lastTarget ??= {};
    cur.place.state.lastTarget[actor] = id;
}

/**
 * Put what the story did on the map (checked changes from core/mapsync.js): people appear, walk
 * over to things, hide, sit, go; doors and things change. Party members walk there (never jump).
 * Returns plain lines of what changed.
 */
export async function applyMapSync(c, ops) {
    const cur = currentPlace(c);
    if (!cur || !ops.length) return [];
    const { key, place } = cur;
    const log = [];
    const player = c.meta.persona.name;
    const lead = place.state.positions[player];
    const floorId = lead?.floor ?? place.state.floor;
    const where = id => {
        if (!id) return null;
        const p = propById(place, id);
        if (p) return { floor: p.floor, x: p.prop.x, y: p.prop.y };
        const d = place.doors[id];
        if (d) return { floor: d.floor, x: d.x, y: d.y };
        if (place.rooms[id]) return id;
        const someone = place.state.positions[id] ?? personByName(place, id);
        return someone && Number.isFinite(someone.x) ? { floor: someone.floor, x: someone.x, y: someone.y } : null;
    };
    const { refreshMap } = await import('../ui/map.js');
    for (const ch of ops) {
        if (ch.op === 'spawn') {
            const at = where(ch.near) ?? (lead ? { floor: floorId, x: lead.x, y: lead.y } : null);
            const g = at && placePerson(place, ch.name, at, { floor: floorId, info: { description: ch.what, hostile: ch.hostile }, arrive: !ch.near });
            if (!g) continue;
            if (ch.intent) setIntent(g, ch.intent, ch.target);
            log.push(`${g.name} appears${ch.near ? ` by the ${thingLabel(place, ch.near)}` : ''}${g.intent === 'attack' ? `, going for ${g.target || 'the party'}` : ''}`);
        } else if (ch.op === 'move' || ch.op === 'hide' || ch.op === 'pose') {
            const isParty = Boolean(place.state.positions[ch.who]);
            if (!isParty) {
                const g = personByName(place, ch.who), to = where(ch.to);
                if (g && to && placePerson(place, g.name, to, { floor: floorId })) log.push(`${g.name} goes to the ${thingLabel(place, ch.to)}`);
                continue;
            }
            if (lockedReason(c, ch.who)) continue;
            if (ch.op === 'pose' && ch.how === 'stand') { if (place.state.pose?.[ch.who]) { standUp(place, ch.who); log.push(`${ch.who} gets up`); } continue; }
            // Hiding with no thing named: the nearest place to hide in their room.
            let to = ch.op === 'move' ? ch.to : ch.op === 'hide' ? ch.in : ch.on;
            if (ch.op === 'hide' && !to) to = nearestHide(place, ch.who)?.id ?? '';
            if (!to) continue;
            if (ch.who === player) {
                const spot = where(to);
                if (!spot || typeof spot === 'string') continue;
                const pr = propById(place, to)?.prop;
                await approachSpot(pr ? { x: pr.x, y: pr.y, w: pr.w, h: pr.h } : spot, refreshMap, { inTurn: true });
                if (ch.op === 'hide') hideAt(c, player, to);
                else if (ch.op === 'pose') restAt(c, player, to, ch.how);
                log.push(`${player} ${ch.op === 'hide' ? 'hides' : ch.op === 'pose' ? ch.how + 's' : 'goes'} by the ${thingLabel(place, to)}`);
                continue;
            }
            // Walking over to something keeps them following; only hiding or lying down means they stay put.
            const went = await companionGoTo(c, ch.who, to, { hide: ch.op === 'hide', pose: ch.op === 'pose' ? ch.how : '', stay: ch.op !== 'move' });
            if (went) log.push(`${ch.who} → ${went}`);
        } else if (ch.op === 'gone') {
            const g = personByName(place, ch.who);
            // Someone down or dead stays where they fell (the body is cleared later); "gone" is for leaving.
            if (g && g.state !== 'gone' && g.state !== 'dead' && !(c.docs.world.combat?.enemies?.[g.name]?.hp <= 0)) { g.state = 'gone'; log.push(`${g.name} is gone`); }
        } else if (ch.op === 'intent') {
            const g = personByName(place, ch.who);
            if (g && g.intent !== ch.intent) { setIntent(g, ch.intent, ch.target); log.push(`${g.name}: ${ch.intent}${ch.target ? ` ${ch.target}` : ''}`); }
        } else if (ch.op === 'door') {
            const d = place.doors[ch.id];
            if (d && d.state !== ch.state) { setDoorState(place, d, ch.state); log.push(`${d.id} ${ch.state}`); }
        } else if (ch.op === 'thing') {
            log.push(...applyPlaceChanges(place, { props: { [ch.id]: ch.state } }, { floor: floorId }));
        } else if (ch.op === 'take' || ch.op === 'found') {
            const it = place.items[ch.id];
            if (!it) continue;
            if (ch.op === 'found') { if (!it.found) { it.found = true; it.hidden = false; log.push(`${it.name} found`); } continue; }
            if (it.state !== 'taken') { it.state = 'taken'; it.hidden = false; log.push(`${ch.who} took the ${it.name}`); }
        } else if (ch.op === 'drop') {
            const p = place.state.positions[ch.who];
            if (!p) continue;
            let n = Object.keys(place.items).length + 1;
            while (place.items[`I${n}d`]) n++;
            place.items[`I${n}d`] = { id: `I${n}d`, name: ch.item, room: roomAt(place, p.floor, p.x, p.y)?.id ?? null, floor: p.floor, x: p.x, y: p.y, hidden: false, found: true, note: `left here by ${ch.who}`, state: 'here' };
            log.push(`${ch.who} left the ${ch.item} here`);
        }
    }
    look(c, key, place);
    savePlace(key, c);
    refreshMap();
    return log;
}

/** A thing's, door's, room's or person's name for a log line. */
function thingLabel(place, id) {
    const p = propById(place, id)?.prop;
    if (p) return thingName(p);
    if (place.doors[id]) return 'door';
    return place.rooms[id]?.name ?? id;
}

/** The nearest thing to hide in, under or behind, in someone's room (or close by). */
function nearestHide(place, name) {
    const pos = place.state.positions[name];
    if (!pos) return null;
    const rm = roomAt(place, pos.floor, pos.x, pos.y);
    return (floorById(place, pos.floor).map.props || [])
        .filter(p => HIDE[p.type] && !p.hidden && (rm ? roomAt(place, pos.floor, p.x, p.y)?.id === rm.id : Math.hypot(p.x - pos.x, p.y - pos.y) <= 6))
        .sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y))[0] ?? null;
}

/**
 * What the map sync model is shown: the party, the others, the things around the party (their
 * rooms and what they can see) and the floor's rooms, plus the ids and names it may use.
 */
export function syncContext(c) {
    const cur = currentPlace(c);
    if (!cur) return null;
    const { place } = cur;
    const names = partyOnMap(c).filter(n => place.state.positions[n]);
    const lead = place.state.positions[names[0]];
    if (!lead) return null;
    const floorId = lead.floor;
    const map = floorById(place, floorId).map;
    const at = (x, y) => `${colName(x)}${y + 1}`;
    const roomName = (x, y) => roomAt(place, floorId, x, y)?.name ?? '';
    const party = names.map(n => {
        const p = place.state.positions[n], h = hiddenNow(place, n), r = poseNow(place, n);
        return { name: n, at: at(p.x, p.y), room: roomName(p.x, p.y), note: h ? `hiding ${h.mode} ${h.prop}` : r ? `${r.pose} on ${r.prop}` : '' };
    });
    const guards = Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === floorId);
    const people = guards.map(g => ({ name: g.name, at: at(g.x, g.y), room: roomName(g.x, g.y), note: [g.state === 'dead' ? 'DEAD' : '', g.description, g.intent, g.unaware?.length ? `hasn't noticed ${g.unaware.join(', ')}` : ''].filter(Boolean).join('; ').slice(0, 110) }));
    // The rooms the party is in, and anything in view.
    const rooms = new Set(names.map(n => roomAt(place, floorId, place.state.positions[n].x, place.state.positions[n].y)?.id).filter(Boolean));
    const seen = look(c, cur.key, place) || [];
    const things = (map.props || []).filter(p => !p.hidden && p.type !== 'trap' && !PROPS[p.type]?.decal && (rooms.has(roomAt(place, floorId, p.x, p.y)?.id) || seen[p.y * map.w + p.x]))
        .sort((a, b) => Math.hypot(a.x - lead.x, a.y - lead.y) - Math.hypot(b.x - lead.x, b.y - lead.y)).slice(0, 40)
        .map(p => ({ id: p.id, name: thingName(p), at: at(p.x, p.y), room: roomName(p.x, p.y) }));
    const doors = Object.values(place.doors).filter(d => d.floor === floorId && d.state !== 'hidden' && d.state !== 'walled' && (d.rooms.some(r => rooms.has(r)) || seen[d.y * map.w + d.x]))
        .map(d => ({ id: d.id, name: `${d.state} ${d.kind === 'cell' ? 'cell door' : 'door'}`, at: at(d.x, d.y), room: d.rooms.map(r => place.rooms[r]?.name).filter(Boolean).join(' / ') }));
    // Every room on this floor (the ones the party knows first): the story can send a guard back to his post even if the party hasn't been there.
    const floorRooms = Object.values(place.rooms).filter(r => r.floor === floorId).sort((a, b) => Number(place.state.visited.includes(b.id) || rooms.has(b.id)) - Number(place.state.visited.includes(a.id) || rooms.has(a.id))).slice(0, 40).map(r => ({ id: r.id, name: r.name }));
    const items = Object.values(place.items || {}).filter(i => i.state !== 'taken' && i.floor === floorId && (rooms.has(i.room) || seen[i.y * map.w + i.x])).slice(0, 20)
        .map(i => ({ id: i.id, name: i.name, room: place.rooms[i.room]?.name ?? 'here', hidden: i.hidden && !i.found }));
    const w = c.docs.world;
    const carried = Object.fromEntries(names.map(n => [n, [...(w.inventory?.[n] ?? []), ...(n === names[0] ? (w.items ?? []) : [])]]).filter(([, l]) => l.length));
    return {
        party, people, things: [...things, ...doors], rooms: floorRooms, items, carried,
        known: { party: names, people: guards.map(g => g.name), peopleInfo: Object.fromEntries(guards.map(g => [g.name, g.description || ''])), things: things.map(t => t.id), doors: doors.map(d => d.id), rooms: floorRooms.map(r => r.id), items: items.map(i => i.id), carried },
    };
}
