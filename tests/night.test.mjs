// v0.33: night, sleep, keys, bodies, and what the place's people notice. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { litMask, computeVisible, findPath, tickGuards, moveHunters, applyPlaceChanges, clearBodies, dangerSquares, isOut, hasKeys, roomAt, placeView } from '../src/core/explore.js';
import { noticeParty, outBy } from '../src/core/notice.js';
import { cannedLine } from '../src/core/lines.js';
import { setStanding, standingFor } from '../src/core/access.js';
import { isNight, isLate } from '../src/core/world.js';
import { terrainAt } from '../src/core/grid.js';

/** A small place: one floor of open floor (rows are top to bottom; y counts from the bottom). */
function tiny({ w = 9, h = 5, kind = 'dungeon', theme = 'dungeon', fog = true, rooms = {}, doors = {}, wallAt = null } = {}) {
    const rows = [];
    for (let i = 0; i < h; i++) {
        const y = h - 1 - i;
        let row = '';
        for (let x = 0; x < w; x++) row += wallAt ? wallAt(x, y) : '.';
        rows.push(row);
    }
    return {
        name: 'Tiny', kind, fog, floors: [{ id: 'F0', name: 'Ground', level: 0, map: { w, h, rows, theme, props: [], version: 0 } }],
        rooms, doors, traps: {}, items: {}, exits: [], stairs: [], buildings: {}, windows: {}, guards: {},
        state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
}
const room = (id, name, type, x, y, w, h, lit = true) => ({ id, name, type, floor: 'F0', rect: { x, y, w, h }, lit });
const person = (name, x, y, extra = {}) => ({ name, description: extra.description || '', hostile: false, room: null, patrol: [], step: 0, floor: 'F0', x, y, state: 'patrol', ...extra });
const seq = list => { const s = [...list]; return () => s.shift() ?? 0.2; };

test('time of day: evening is dark out, night is when people sleep', () => {
    assert.equal(isNight('morning'), false);
    assert.equal(isNight('evening'), true);
    assert.equal(isLate('evening'), false);
    assert.equal(isLate('night'), true);
    assert.equal(isLate('afternoon'), false);
});

test('canned lines fit the hour and the situation: no "Evening" at noon, a turnkey talks to a prisoner in her cell as one', () => {
    const guard = { name: 'Wren', description: 'a turnkey', role: 'guard' };
    for (let i = 0; i < 30; i++) {
        assert.doesNotMatch(cannedLine(guard, { rng: seq([0.1, i / 30]), time: 'day' }), /evening|night|late to be/i, 'by day');
        assert.doesNotMatch(cannedLine(guard, { rng: seq([0.1, i / 30]), time: 'night' }), /morning|afternoon|good day/i, 'by night');
        assert.match(cannedLine(guard, { rng: seq([0.1, i / 30]), prisoner: true }), /Quiet in there|Back from the bars|Food comes|come in there|Still here|Settle down|No talking/, 'to a prisoner in her cell');
    }
    const folk = { name: 'Old Martha', description: 'the cook' };
    assert.doesNotMatch(cannedLine(folk, { rng: seq([0.1, 0.99]), time: 'day' }), /night/i);
});

test('night: a lived-in house goes dark except where someone is awake or a light burns', () => {
    const place = tiny({ w: 9, h: 5, kind: 'house', theme: 'house', fog: false, rooms: { K: room('K', 'Kitchen', 'kitchen', 0, 0, 4, 5), B: room('B', 'Bedroom', 'bedroom', 5, 0, 4, 5) } });
    const map = place.floors[0].map;
    const at = (x, y) => litMask(place, 'F0')[y * map.w + x];
    assert.equal(at(1, 2), 1, 'by day a lived-in house is lit');
    assert.equal(at(6, 2), 1);
    place.state.night = true;
    map.version++;
    assert.equal(at(1, 2), 0, 'at night the kitchen is dark');
    assert.equal(at(6, 2), 0, 'and the bedroom');
    place.guards = { Cook: person('Cook', 1, 1, { role: 'resident' }) };
    assert.equal(at(2, 2), 1, 'the cook is up: her kitchen has a candle');
    assert.equal(at(6, 2), 0, 'the bedroom stays dark');
    place.guards.Cook.down = 'asleep';
    assert.equal(at(2, 2), 0, 'she went to sleep: dark again');
    place.rooms.B.litNight = true;
    assert.equal(at(6, 2), 1, 'a room lit on purpose at night stays lit');
    map.props.push({ x: 1, y: 3, type: 'candles' });
    assert.equal(at(1, 2), 1, 'a light burning lights around it');
    delete place.state.night;
    map.version++;
    assert.equal(at(6, 2), 1, 'morning: lit again');
});

test('a torch in the party\'s pack lights the squares around whoever carries it', () => {
    const place = tiny({ w: 12, h: 5, fog: true });
    place.state.positions = { Amber: { floor: 'F0', x: 2, y: 2 } };
    const map = place.floors[0].map;
    let vis = computeVisible(place, 'F0', [place.state.positions.Amber]);
    assert.equal(vis[2 * map.w + 5], 0, 'in the dark she sees two squares');
    place.state.lights = { Amber: true };
    vis = computeVisible(place, 'F0', [place.state.positions.Amber]);
    assert.equal(vis[2 * map.w + 5], 1, 'with a torch, three');
    assert.equal(vis[2 * map.w + 9], 0, 'not seven');
});

test('asleep, knocked out or tied up: notices nothing and goes nowhere until woken; the dead stay dead', () => {
    const place = tiny({ w: 9, h: 5, rooms: { R: room('R', 'Hall', 'hallway', 0, 0, 9, 5) } });
    place.guards = { Wren: person('Wren', 4, 2, { role: 'guard', room: 'R', patrol: ['R'] }) };
    const g = place.guards.Wren;
    applyPlaceChanges(place, { guards: { Wren: 'asleep' } });
    assert.equal(g.down, 'asleep');
    assert.ok(isOut(g));
    for (let i = 0; i < 20; i++) tickGuards(place, () => 0.3, 1);
    assert.deepEqual([g.x, g.y], [4, 2], 'a sleeper does not pace');
    assert.match(placeView(place, []), /Wren[^;]*ASLEEP/, 'the DM is told');
    applyPlaceChanges(place, { guards: { Wren: 'awake' } });
    assert.equal(g.down, undefined);
    applyPlaceChanges(place, { guards: { Wren: 'tied up' } });
    assert.equal(g.down, 'bound');
    applyPlaceChanges(place, { guards: { Wren: 'free' } });
    assert.equal(g.down, undefined);
    assert.equal(outBy(['unconscious (until healed)']), 'unconscious');
    assert.equal(outBy(['restrained']), 'bound');
    assert.equal(outBy(['poisoned']), null);
    // Dead: a body, and no state the DM sends wakes it.
    const log = applyPlaceChanges(place, { guards: { Wren: 'dead' } }, { turn: 7 });
    assert.equal(g.state, 'dead');
    assert.equal(g.deadTurn, 7);
    applyPlaceChanges(place, { guards: { Wren: 'alert' } });
    assert.equal(g.state, 'dead', '"alert" does not resurrect');
    applyPlaceChanges(place, { guards: { Wren: { at: 'b2', state: 'alert' } } });
    assert.equal(g.state, 'dead', 'nor does placing the body');
    applyPlaceChanges(place, { guards: { Wren: 'hunting' } });
    assert.equal(g.state, 'dead');
    assert.notEqual(g.intent, 'attack');
    applyPlaceChanges(place, { guards: { Wren: 'alive' } });
    assert.equal(g.state, 'patrol', 'only "alive" brings someone back');
    assert.ok(log.length >= 1);
});

test('a body stays while the party can see it, or while nobody is left to clear it', () => {
    const place = tiny({ w: 30, h: 5, fog: false });
    place.guards = { Dead: person('Dead', 1, 2, { state: 'dead', deadTurn: 0, hostile: true }) };
    place.state.positions = { Amber: { floor: 'F0', x: 3, y: 2 } };
    const map = place.floors[0].map;
    const sight = () => ({ floorId: 'F0', visible: computeVisible(place, 'F0', [place.state.positions.Amber]) });
    assert.equal(clearBodies(place, 10, 3, sight()), 0, 'in sight: stays');
    assert.equal(place.guards.Dead.state, 'dead');
    place.state.positions.Amber = { floor: 'F0', x: 28, y: 2 };
    assert.equal(computeVisible(place, 'F0', [place.state.positions.Amber])[2 * map.w + 1], 0, 'now out of sight');
    assert.equal(clearBodies(place, 20, 3, sight()), 0, 'nobody left to clear it: stays');
    place.guards.Other = person('Other', 20, 2, { role: 'guard' });
    assert.equal(clearBodies(place, 12, 3, sight()), 0, 'seen at turn 10: not yet');
    assert.equal(clearBodies(place, 13, 3, sight()), 1, 'out of sight three turns, someone to do it: cleared');
    assert.equal(place.guards.Dead.state, 'gone');
});

test('guards carry keys: a turnkey walks through a locked door and locks it behind him; a monster cannot', () => {
    const make = () => {
        const place = tiny({ w: 9, h: 5, wallAt: (x, y) => (x === 4 && y !== 2 ? '#' : x === 4 ? 'D' : '.'), rooms: { A: room('A', 'Guard room', 'guard_room', 0, 0, 4, 5), B: room('B', 'Cell block', 'hallway', 5, 0, 4, 5) } });
        place.doors = { D1: { id: 'D1', floor: 'F0', x: 4, y: 2, state: 'locked', kind: 'locked', rooms: ['A', 'B'] } };
        return place;
    };
    let place = make();
    assert.equal(findPath(place, 'F0', { x: 1, y: 2 }, { x: 7, y: 2 }, { knownOnly: false }), null, 'locked: no way through');
    assert.ok(findPath(place, 'F0', { x: 1, y: 2 }, { x: 7, y: 2 }, { knownOnly: false, keys: true })?.length, 'with keys: through');
    place.guards = { Wren: person('Wren', 1, 2, { role: 'guard', room: 'A', patrol: ['A', 'B'] }) };
    assert.ok(hasKeys(place.guards.Wren));
    let ticks = 0;
    while (place.guards.Wren.room !== 'B' && ticks++ < 12) tickGuards(place, () => 0.3, 1);
    assert.equal(place.guards.Wren.room, 'B', 'he walked his round into the cell block');
    assert.equal(place.doors.D1.state, 'locked', 'and locked the door behind him');
    assert.equal(terrainAt(place.floors[0].map, 4, 2), 'D');
    place = make();
    place.guards = { Thing: person('Thing', 1, 2, { hostile: true, room: 'A', patrol: ['A', 'B'] }) };
    for (let i = 0; i < 12; i++) tickGuards(place, () => 0.3, 1);
    assert.equal(roomAt(place, 'F0', place.guards.Thing.x, place.guards.Thing.y)?.id, 'A', 'a monster has no keys');
    assert.equal(place.doors.D1.state, 'locked');
});

test('hunters and patrols walk around open pits and fire', () => {
    const place = tiny({ w: 9, h: 1 });
    place.traps = { T1: { id: 'T1', room: null, floor: 'F0', x: 4, y: 0, kind: 'pit', state: 'sprung', dc: 12, effect: 'fall' } };
    assert.ok(dangerSquares(place, 'F0').has('4,0'));
    place.guards = { Hound: person('Hound', 0, 0, { hostile: true, intent: 'attack', description: 'a hound' }) };
    place.state.positions = { Amber: { floor: 'F0', x: 8, y: 0 } };
    const struck = moveHunters(place, 'F0', ['Amber'], 8);
    assert.equal(struck.length, 0, 'the corridor is blocked by the pit: it never reaches her');
    assert.ok(place.guards.Hound.x < 4, 'and never steps into it');
    const open = tiny({ w: 9, h: 5 });
    open.traps = place.traps;
    open.floors[0].map.fire = { '4,1': { heat: 2 } };
    open.guards = { Hound: person('Hound', 0, 2, { hostile: true, intent: 'attack', description: 'a hound' }) };
    open.state.positions = { Amber: { floor: 'F0', x: 8, y: 2 } };
    // Around, over several turns, never onto the pit or the fire.
    for (let i = 0; i < 4; i++) {
        moveHunters(open, 'F0', ['Amber'], 3);
        assert.ok(!(open.guards.Hound.x === 4 && (open.guards.Hound.y === 0 || open.guards.Hound.y === 1)), 'not on the pit or the fire');
    }
    assert.ok(Math.max(Math.abs(open.guards.Hound.x - 8), Math.abs(open.guards.Hound.y - 2)) <= 1, 'it got to her the long way round');
});

test('noticing: the sleeping see nothing, a Stealth roll holds until you bump into him, the unconscious are found, lines fit', () => {
    const place = tiny({ w: 9, h: 5, kind: 'tavern', theme: 'tavern', fog: false });
    place.guards = { Mab: person('Mab', 2, 2, { role: 'keeper', description: 'the innkeeper' }) };
    place.state.positions = { Amber: { floor: 'F0', x: 5, y: 2 } };
    setStanding(place, 'Amber', standingFor('free'));
    const ctx = (over = {}) => ({ turn: 1, rng: () => 0.1, ...over });
    let r = noticeParty(place, ['Amber'], ctx());
    assert.deepEqual(r.seen, [{ seer: 'Mab', seen: 'Amber' }]);
    assert.equal(r.lines.length, 1, 'allowed here: a word');
    assert.equal(r.events.length, 0);
    r = noticeParty(place, ['Amber'], ctx({ turn: 2, spokeLately: () => true }));
    assert.equal(r.lines.length, 0, 'not while she is already talking to her');
    place.guards.Mab.down = 'asleep';
    r = noticeParty(place, ['Amber'], ctx({ turn: 20 }));
    assert.equal(r.seen.length + r.lines.length + r.events.length, 0, 'asleep: nothing');
    delete place.guards.Mab.down;
    r = noticeParty(place, ['Amber'], ctx({ turn: 30, condsOf: n => (n === 'Mab' ? ['unconscious'] : []) }));
    assert.equal(r.seen.length + r.lines.length + r.events.length, 0, 'knocked out by the DM: nothing');
    place.guards.Mab.unaware = ['Amber'];
    r = noticeParty(place, ['Amber'], ctx({ turn: 40 }));
    assert.equal(r.seen.length + r.lines.length + r.events.length, 0, 'a roll said she did not notice Amber: she still has not');
    place.state.positions.Amber = { floor: 'F0', x: 3, y: 2 };
    r = noticeParty(place, ['Amber'], ctx({ turn: 41 }));
    assert.equal(r.events.length, 1, 'right beside her: roll again');
    assert.match(r.events[0], /hasn't noticed/);
    delete place.guards.Mab.unaware;
    r = noticeParty(place, ['Amber'], ctx({ turn: 50, hpOf: () => ({ hp: 0, hp_max: 10 }) }));
    assert.equal(r.events.length, 1, 'found lying there');
    assert.match(r.events[0], /unconscious/);
    assert.equal(r.lines.length, 0, 'and not asked how she is doing');
    // A prisoner in her own cell: the turnkey's words are a turnkey's.
    const jail = tiny({ w: 9, h: 5, kind: 'jail', theme: 'prison', fog: true, rooms: { C1: room('C1', 'Cell 1', 'cell', 0, 0, 3, 3) } });
    jail.guards = { Wren: person('Wren', 0, 0, { role: 'guard', description: 'a turnkey' }) };
    jail.state.positions = { Amber: { floor: 'F0', x: 2, y: 2 } };
    setStanding(jail, 'Amber', standingFor('prisoner', { home: 'C1' }));
    r = noticeParty(jail, ['Amber'], ctx());
    assert.equal(r.events.length, 0, 'in her cell: no trespass');
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0].text, /Quiet in there|Back from the bars|Food comes|come in there|Still here|Settle down|No talking/);
    // Out of it: a trespass event once, and not again from someone escorting her.
    jail.state.positions.Amber = { floor: 'F0', x: 6, y: 2 };
    jail.guards.Wren = person('Wren', 5, 2, { role: 'guard', description: 'a turnkey' });
    r = noticeParty(jail, ['Amber'], ctx({ turn: 1 }));
    assert.equal(r.events.length, 1);
    assert.match(r.events[0], /escaped prisoner/);
    r = noticeParty(jail, ['Amber'], ctx({ turn: 3 }));
    assert.equal(r.events.length, 0, 'reported already');
    jail.guards.Wren.intent = 'follow';
    r = noticeParty(jail, ['Amber'], ctx({ turn: 30 }));
    assert.equal(r.events.length, 0, 'escorting her: he knows');
});
