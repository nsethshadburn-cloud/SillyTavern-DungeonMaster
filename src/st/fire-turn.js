// Fire and effects on whatever map is in play (a place's floor, a battle map, a scene map). The DM's
// "map_effects" put fire, spell effects and ambience on it; each player turn the fire spreads and
// burns, effects run down, and anyone standing in fire takes fire damage.

import { campaign, saveDoc } from './campaign.js';
import { currentPlace, savePlace } from './atlas.js';
import { floorById, roomAt, setDoorState } from '../core/explore.js';
import { parseCoord, toCoord } from '../core/grid.js';
import { ignite, extinguish, addEffect, clearEffects, tickFire, tickEffects, fireAt, FIRE_DAMAGE, AMBIENCES, EFFECT_TYPES } from '../core/fire.js';
import { roll } from '../core/dice.js';
import { changeHp } from '../core/world.js';
import { postNote } from './messages.js';
import { refreshMap, playAnim } from '../ui/map.js';

/**
 * The map in play now, or null: {map, people: [[name, {x, y}]], nameAt(x, y), save(), place?, floorId?}.
 * A fight inside a place is on its own copy of the floor (merged back when it ends).
 */
export function activeBoard(c = campaign()) {
    const w = c?.docs.world;
    if (!w) return null;
    const cur = currentPlace(c);
    const roomName = (place, floorId) => (x, y) => roomAt(place, floorId, x, y)?.name ?? '';
    if (w.combat?.map) {
        const people = Object.entries(w.combat.positions || {}).map(([n, cd]) => [n, parseCoord(cd, w.combat.map)]).filter(([, p]) => p);
        const inPlace = w.combat.inPlace && cur?.key === w.combat.inPlace.key;
        return { map: w.combat.map, people, nameAt: inPlace ? roomName(cur.place, w.combat.inPlace.floor) : () => '', save: () => saveDoc('world') };
    }
    if (cur) {
        const { key, place } = cur;
        const floorId = place.state.positions[c.meta.persona.name]?.floor ?? place.state.floor;
        const people = [
            ...Object.entries(place.state.positions).filter(([, p]) => p.floor === floorId),
            ...Object.values(place.guards).filter(g => g.state !== 'gone' && g.floor === floorId).map(g => [g.name, g]),
        ];
        return { map: floorById(place, floorId).map, people, nameAt: roomName(place, floorId), place, floorId, save: () => savePlace(key, c) };
    }
    if (w.sceneMap?.map) {
        const people = Object.entries(w.sceneMap.positions || {}).map(([n, cd]) => [n, parseCoord(cd, w.sceneMap.map)]).filter(([, p]) => p);
        return { map: w.sceneMap.map, people, nameAt: () => '', save: () => saveDoc('world') };
    }
    return null;
}

const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const num = (v, lo, hi, dflt = lo) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

/**
 * The DM's "map_effects": {fire: [{at, radius, fuel}], extinguish: [{at, radius}],
 * effects: [{type, at, radius, turns}], clear_effects: [{at, radius, type}], ambience}.
 * Returns true if anything changed.
 */
export function applyMapEffects(c, fx, status = null) {
    const board = fx && typeof fx === 'object' ? activeBoard(c) : null;
    if (!board) return false;
    const { map } = board;
    const at = v => parseCoord(typeof v === 'string' ? v : v?.at, map);
    const log = [];
    for (const f of list(fx.fire)) {
        const p = at(f);
        if (!p) continue;
        const radius = num(f.radius, 0, 8);
        const n = ignite(map, p.x, p.y, { radius, heat: radius >= 2 ? 3 : 2, fuel: num(f.fuel, 0, 10) });
        log.push(n ? `fire at ${toCoord(p.x, p.y)} (${n} square${n > 1 ? 's' : ''} caught)` : `fire at ${toCoord(p.x, p.y)}: nothing there burns`);
    }
    for (const e of list(fx.extinguish)) {
        const p = at(e);
        if (!p) continue;
        const n = extinguish(map, p.x, p.y, { radius: num(e.radius, 0, 8) });
        if (n) log.push(`fire out around ${toCoord(p.x, p.y)}`);
    }
    for (const e of list(fx.effects)) {
        const p = at(e), type = String(e?.type || '').toLowerCase();
        if (!p || !EFFECT_TYPES.includes(type)) continue;
        if (addEffect(map, type, p.x, p.y, { radius: num(e.radius, 0, 12, 2), turns: num(e.turns, 1, 100, 3) })) log.push(`${type} at ${toCoord(p.x, p.y)}`);
    }
    for (const e of list(fx.clear_effects)) {
        const p = at(e);
        if (p && clearEffects(map, p.x, p.y, { radius: num(e.radius, 0, 20), type: String(e.type || '').toLowerCase() })) log.push(`effect ended at ${toCoord(p.x, p.y)}`);
    }
    const amb = String(fx.ambience ?? '').toLowerCase().trim();
    if (AMBIENCES.includes(amb) && map.ambience !== amb) { map.ambience = amb; log.push(`ambience: ${amb}`); }
    if (!log.length) return false;
    status?.note(`Map: ${log.join(', ')}`);
    board.save();
    refreshMap();
    return true;
}

/**
 * One player turn passes for the map: fire spreads and burns, effects run down, anyone standing in
 * fire takes damage (party and enemies with HP: applied; others: the DM rolls). Returns an event
 * for the DM when someone was burned, else ''.
 */
export async function fireTurn(c, status = null) {
    const board = activeBoard(c);
    const map = board?.map;
    if (!map || (!Object.keys(map.fire || {}).length && !map.effects?.length)) return '';
    const wasBurning = Object.keys(map.fire || {}).length;
    const r = tickFire(map);
    const ended = tickEffects(map);
    // Doors that burned away: open doorways now.
    if (board.place) {
        for (const d of Object.values(board.place.doors)) {
            if (d.floor === board.floorId && map.burnt?.[`${d.x},${d.y}`] && !['open', 'broken', 'hidden', 'walled'].includes(d.state)) setDoorState(board.place, d, 'broken');
        }
    }
    const world = c.docs.world;
    const party = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
    const hurt = [], others = [];
    for (const [name, p] of board.people) {
        const heat = fireAt(map, p.x, p.y);
        if (!heat) continue;
        const dice = FIRE_DAMAGE[heat];
        const dmg = roll(dice)?.total ?? 1;
        const line = changeHp(world, name, -dmg, party);
        if (line) { hurt.push(`${name} takes ${dmg} fire damage (${dice}): ${line}`); playAnim(name, 'hurt'); }
        else others.push(`${name} is standing in the fire (${dice} fire damage: roll it for them)`);
    }
    if (hurt.length) saveDoc('world');
    board.save();
    refreshMap();
    if (hurt.length) await postNote(hurt.map(h => `🔥 ${h}`).join('\n'));
    if (wasBurning) status?.note(r.burning ? `Fire: ${r.burning} square${r.burning > 1 ? 's' : ''} burning${r.caught.length ? `, ${r.caught.length} caught` : ''}` : 'The fire burnt out');
    if (ended.length) status?.note(`Ended: ${ended.map(e => e.type).join(', ')}`);
    if (!hurt.length && !others.length) return '';
    const bits = [`Burning this turn: ${[...hurt, ...others].join('; ')}.`];
    if (r.destroyed.length) bits.push(`Burnt to ash: ${[...new Set(r.destroyed)].join(', ')}.`);
    return `FIRE: ${bits.join(' ')} Narrate it (the HP is already applied for anyone with a number).`;
}
