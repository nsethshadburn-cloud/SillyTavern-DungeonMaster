// v0.36: what the party has seen. A guard who already saw you acts when you walk up to him; lines
// only from people in sight; people play their moves out; the one you swing at holds still; bubbles
// keep the action out. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { tickGuards, moveHunters, peopleMentioned, clearTrails, placePerson, setIntent } from '../src/core/explore.js';
import { noticeParty } from '../src/core/notice.js';
import { setStanding, standingFor, givesIn } from '../src/core/access.js';
import { dialogueOf, typingMs } from '../src/core/speech.js';
import { combatSummary } from '../src/core/world.js';

function tiny({ w = 9, h = 5, kind = 'prison', theme = 'dungeon', fog = true, rooms = {}, doors = {} } = {}) {
    const rows = [];
    for (let i = 0; i < h; i++) rows.push('.'.repeat(w));
    return {
        name: 'Tiny', kind, fog, floors: [{ id: 'F0', name: 'Ground', level: 0, map: { w, h, rows, theme, props: [], version: 0 } }],
        rooms, doors, traps: {}, items: {}, exits: [], stairs: [], buildings: {}, windows: {}, guards: {},
        state: { positions: {}, explored: {}, visited: [], floor: 'F0' },
    };
}
const room = (id, name, type, x, y, w, h) => ({ id, name, type, floor: 'F0', rect: { x, y, w, h }, lit: true });
const person = (name, x, y, extra = {}) => ({ name, description: extra.description || '', hostile: false, room: null, patrol: [], step: 0, floor: 'F0', x, y, state: 'patrol', ...extra });

function cellBlock() {
    const place = tiny({ rooms: { H: room('H', 'Hallway', 'hallway', 0, 0, 6, 5), C4: room('C4', 'Cell 4', 'cell', 6, 0, 3, 5) } });
    place.state.positions.Amber = { floor: 'F0', x: 2, y: 2 };
    place.guards = { Wren: person('Wren', 4, 2, { description: 'a turnkey', role: 'guard' }) };
    setStanding(place, 'Amber', standingFor('prisoner', { home: 'C4' }));
    return place;
}

test('a guard who already saw the escaped prisoner acts when they walk right up to him', () => {
    const place = cellBlock();
    const first = noticeParty(place, ['Amber'], { turn: 1 });
    assert.equal(first.events.length, 1, 'the sighting');
    assert.match(first.events[0], /out of their cell|not allowed/);
    assert.deepEqual(noticeParty(place, ['Amber'], { turn: 2 }).events, [], 'seen already: nothing new while they keep their distance');
    place.state.positions.Amber = { floor: 'F0', x: 3, y: 2 };
    const near = noticeParty(place, ['Amber'], { turn: 2 });
    assert.equal(near.events.length, 1);
    assert.match(near.events[0], /right beside Wren.*acts now/);
    assert.deepEqual(noticeParty(place, ['Amber'], { turn: 2 }).events, [], 'once a turn');
    assert.equal(noticeParty(place, ['Amber'], { turn: 3 }).events.length, 1, 'still there next turn: again');
});

test('a watcher the party cannot see (in the dark) rolls to notice a trespasser; one right beside them just sees them', () => {
    const place = cellBlock();
    const dark = noticeParty(place, ['Amber'], { turn: 1, canSee: () => false });
    assert.equal(dark.events.length, 1);
    assert.match(dark.events[0], /can't see him.*Roll whether he notices/);
    assert.deepEqual(dark.seen, [], 'not a sighting until the dice say so');
    assert.match(dark.events[0], /STOP there: the player decides/);
    const near = cellBlock();
    near.state.positions.Amber = { floor: 'F0', x: 3, y: 2 };
    const r = noticeParty(near, ['Amber'], { turn: 1, canSee: () => false });
    assert.doesNotMatch(r.events[0], /Roll whether he notices/, 'right beside him: no missing that');
    assert.deepEqual(r.seen, [{ seer: 'Wren', seen: 'Amber' }]);
});

test('"!": a guard who has seen the escapee is marked alert; a fellow prisoner does not care', () => {
    const place = cellBlock();
    noticeParty(place, ['Amber'], { turn: 4, canSee: () => true });
    assert.equal(place.guards.Wren.alertAt, 4, 'the mark');
    assert.equal(place.guards.Wren.state, 'alert');
    const cells = cellBlock();
    cells.guards = { Magnus: person('Magnus', 4, 2, { description: 'a prisoner', role: 'prisoner' }) };
    const r = noticeParty(cells, ['Amber'], { turn: 4, canSee: () => true, rng: () => 0.01 });
    assert.deepEqual(r.events, [], 'no alarm from a fellow prisoner');
    assert.equal(cells.guards.Magnus.alertAt, undefined);
    assert.deepEqual(r.seen, [{ seer: 'Magnus', seen: 'Amber' }], 'she did see him');
});

test('giving in is the player\'s own words, and refusals are not', () => {
    for (const t of ['*amber raises his hands* fine, take me back', 'ok ok, I\'ll go', '"Alright. Lead the way."', 'i surrender', 'no trouble, I\'ll walk']) assert.equal(givesIn(t), true, t);
    for (const t of ['', '*amber runs*', 'never! come and get me', 'I refuse', 'what do you want', 'fine, make me']) assert.equal(givesIn(t), false, t);
});

test('the COMBAT line says whose part of the round it is', () => {
    const world = { combat: { round: 2, order: [{ name: 'Jailer', init: 15 }, { name: 'Amber', init: 12 }, { name: 'Judy Hopps', init: 9 }], enemies: {}, phase: 'player' } };
    assert.match(combatSummary(world, 'Amber'), /AMBER'S TURN IS IN PROGRESS|Amber'S TURN IS IN PROGRESS/);
    world.combat.phase = 'others';
    assert.match(combatSummary(world, 'Amber'), /Amber has ended their turn: those after Amber act/);
    delete world.combat.phase;
    assert.doesNotMatch(combatSummary(world, 'Amber'), /TURN IS IN PROGRESS|ended their turn/);
    assert.ok(typingMs(100) <= 2200, 'bubbles type at a quick pace');
});

test('no canned line from someone the party cannot see; the sighting is still recorded', () => {
    // The turnkey is in the cell with him (a prisoner in his own cell is allowed there).
    const place = cellBlock();
    place.state.positions.Amber = { floor: 'F0', x: 7, y: 2 };
    place.guards.Wren.x = 6;
    const blind = noticeParty(place, ['Amber'], { turn: 1, canSee: () => false, rng: () => 0.01 });
    assert.deepEqual(blind.lines, []);
    assert.deepEqual(blind.seen, [{ seer: 'Wren', seen: 'Amber' }]);
    const place2 = cellBlock();
    place2.state.positions.Amber = { floor: 'F0', x: 7, y: 2 };
    place2.guards.Wren.x = 6;
    const seen = noticeParty(place2, ['Amber'], { turn: 1, canSee: () => true, rng: () => 0.01 });
    assert.equal(seen.lines.length, 1, 'in sight: he may say a word');
});

test('patrols leave a trail of the squares they stepped, for the map to play out', () => {
    const place = tiny({ rooms: { A: room('A', 'West', 'hallway', 0, 0, 4, 5), B: room('B', 'East', 'hallway', 5, 0, 4, 5) } });
    place.guards = { Wren: person('Wren', 1, 2, { patrol: ['A', 'B'], room: 'A', role: 'guard' }) };
    tickGuards(place, () => 0.1, 0.75, 3);
    const g = place.guards.Wren;
    assert.ok(Array.isArray(g.trail) && g.trail.length >= 2, 'a trail');
    assert.deepEqual(g.trail[0], [1, 2], 'from where he stood');
    assert.deepEqual(g.trail[g.trail.length - 1], [g.x, g.y], 'to where he is');
    assert.ok(g.trail.length <= 4, 'three steps at most');
    clearTrails(place);
    assert.equal(g.trail, undefined);
    // Hunters too.
    place.state.positions.Amber = { floor: 'F0', x: 8, y: 4 };
    setIntent(g, 'attack', 'Amber');
    moveHunters(place, 'F0', ['Amber'], 3);
    assert.ok(g.trail.length >= 2 && g.trail.length <= 4);
});

test('the one the player swings at or speaks to is held still for the turn', () => {
    const place = cellBlock();
    place.guards.Hask = person('Bram Hask', 1, 4, { description: 'a night turnkey', role: 'guard' });
    assert.deepEqual(peopleMentioned(place, 'F0', '*Amber attacks the jailer*'), [], 'nobody here is a jailer');
    assert.deepEqual(peopleMentioned(place, 'F0', '*Amber swings at the turnkey*').sort(), ['Bram Hask', 'Wren'], 'both are turnkeys');
    assert.deepEqual(peopleMentioned(place, 'F0', 'Hask, wait up'), ['Bram Hask']);
    assert.deepEqual(peopleMentioned(place, 'F0', 'I look around the hallway'), []);
    const g = place.guards.Wren;
    g.patrol = ['H', 'C4']; g.room = 'H';
    tickGuards(place, () => 0.1, 0.75, 3, { skip: x => peopleMentioned(place, 'F0', 'I stab Wren').includes(x.name) });
    assert.deepEqual([g.x, g.y], [4, 2], 'Wren did not move');
});

test('bubbles: mixed curly and straight quotes do not pull the action in between into the bubble', () => {
    assert.equal(dialogueOf('“Still here,” *he grunts, shifting the lantern* "I see."'), 'Still here, I see.');
    assert.equal(dialogueOf('“Still here," *he grunts* "I see.”'), 'Still here, I see.');
    assert.equal(dialogueOf('"Oi, get back in your cell! *He hefts the club.* Now!"'), 'Oi, get back in your cell! Now!');
    assert.equal(dialogueOf('*She presses against the bars.* "Don’t get us killed, you fool.'), 'Don’t get us killed, you fool.');
    assert.equal(dialogueOf('*He just stares.*'), '', 'nothing said: no bubble');
});
