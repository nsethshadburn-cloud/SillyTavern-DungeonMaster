// v0.36: what the party has seen. A guard who already saw you acts when you walk up to him; lines
// only from people in sight; people play their moves out; the one you swing at holds still; bubbles
// keep the action out. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { tickGuards, moveHunters, peopleMentioned, clearTrails, placePerson, setIntent, looksLikeThing, notAPerson, searchRadius, killPerson, clearBodies, addTrap, NEWCOMER_MAX } from '../src/core/explore.js';
import { parseMapSync } from '../src/core/mapsync.js';
import { tidyBookkeeping } from '../src/core/bookkeeper.js';
import { noticeParty, noticeReach, readsAsRunning } from '../src/core/notice.js';
import { setStanding, standingFor, givesIn } from '../src/core/access.js';
import { dialogueOf, typingMs } from '../src/core/speech.js';
import { combatSummary, moveBudget, spendMove, markDash, newRound } from '../src/core/world.js';

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

test('a party member is never one of the place\'s people, and the dead never come back', () => {
    const place = cellBlock();
    place.state.party = ['Amber', 'Judy Hopps'];
    assert.equal(placePerson(place, 'Judy', { floor: 'F0', x: 1, y: 3 }), null, '"Judy" is Judy Hopps');
    assert.equal(placePerson(place, 'Amber', { floor: 'F0', x: 1, y: 3 }), null);
    assert.ok(placePerson(place, 'Bram Hask', { floor: 'F0', x: 1, y: 3 }), 'someone else is fine');
    const ops = parseMapSync('{"changes":[{"op":"spawn","name":"Judy","what":"a caged rabbit","near":"Amber"}]}', { party: ['Amber', 'Judy Hopps'], people: [], things: [], doors: [], rooms: [] }, { story: 'Judy, a caged rabbit, is here' });
    assert.deepEqual(ops, [], 'the sync never spawns a party namesake');
    killPerson(place, 'Wren', 3, 1000);
    assert.equal(place.guards.Wren.state, 'dead');
    assert.deepEqual(clearBodies(place, { now: 1000 + 9999 }), []);
    assert.deepEqual(clearBodies(place, { now: 1000 + 10000 }), ['Wren']);
    assert.equal(place.guards.Wren.state, 'gone');
    assert.equal(placePerson(place, 'Wren', { floor: 'F0', x: 2, y: 3 }), null, 'gone for good');
    assert.equal(placePerson(place, 'wren', { floor: 'F0', x: 2, y: 3 }), null);
});

test('the bookkeeper keeps to the party and to plain states: no unconscious, caged or dead from a turn of phrase', () => {
    const changes = { conditions_add: { Amber: ['poisoned', 'unconscious'], 'Turnkey 2': ['unconscious'], 'Judy Hopps': ['grappled'] }, conditions_remove: { 'Judy Hopps': ['caged'], Amber: ['prone'] }, items_add: { Amber: ['rope'] }, items_remove: {} };
    const t = tidyBookkeeping(changes, { party: ['Amber', 'Judy Hopps'] });
    assert.deepEqual(t, { conditions_add: { Amber: ['poisoned'], 'Judy Hopps': ['grappled'] }, conditions_remove: { Amber: ['prone'] }, items_add: { Amber: ['rope'] } });
    assert.equal(tidyBookkeeping({ conditions_add: { 'Turnkey 2': ['unconscious'] }, conditions_remove: {}, items_add: {}, items_remove: {} }, { party: ['Amber'] }), null);
});

test('a built place takes only a few newcomers', () => {
    const place = cellBlock();
    place.state.built = true; place.state.newcomers = 0;
    let added = 0;
    for (let i = 0; i < NEWCOMER_MAX + 3; i++) if (placePerson(place, `Guard ${i + 10}`, { floor: 'F0', x: 1 + (i % 4), y: 3 })) added++;
    assert.equal(added, NEWCOMER_MAX);
    assert.ok(placePerson(place, 'The Warden', { floor: 'F0', x: 1, y: 4 }, { info: { force: true } }), 'the story can still force one in');
});

test('a trap the DM places is nudged away from a door', () => {
    const place = cellBlock();
    place.doors = { D1: { id: 'D1', floor: 'F0', x: 5, y: 2, state: 'closed', kind: 'door', rooms: ['H', 'C4'] } };
    const t = addTrap(place, 'F0', 4, 2, { kind: 'tripwire', dc: 12 });
    assert.ok(t, 'placed');
    assert.ok(Math.max(Math.abs(t.x - 5), Math.abs(t.y - 2)) > 1, `not beside the door (${t.x},${t.y})`);
});

test('a watcher pays attention over a range rolled each look: no x-ray down the corridor', () => {
    assert.equal(noticeReach(() => 0, 'day'), 4);
    assert.equal(noticeReach(() => 0.99, 'day'), 8);
    assert.equal(noticeReach(() => 0, 'night'), 3);
    assert.equal(noticeReach(() => 0.99, 'night'), 6);
    const place = tiny({ w: 12, h: 3, rooms: { H: room('H', 'Hallway', 'hallway', 0, 0, 12, 3) } });
    place.guards = { Wren: person('Wren', 0, 1, { description: 'a turnkey', role: 'guard' }) };
    place.state.positions.Amber = { floor: 'F0', x: 7, y: 1 };
    setStanding(place, 'Amber', standingFor('prisoner', { home: 'H' }));
    place.rooms.C = room('C', 'Cell', 'cell', 10, 0, 2, 3); place.state.positions.Amber = { floor: 'F0', x: 7, y: 1 };
    setStanding(place, 'Amber', standingFor('prisoner', { home: 'C' }));
    assert.deepEqual(noticeParty(place, ['Amber'], { turn: 1, rng: () => 0, canSee: () => true }).events, [], 'seven squares off with a short look: not this turn');
    assert.equal(noticeParty(place, ['Amber'], { turn: 2, rng: () => 0.99, canSee: () => true }).events.length, 1, 'a long look: seen');
    assert.equal(noticeParty(tiny({ w: 12, h: 3 }), ['Amber'], { turn: 1 }).events.length, 0);
    for (const t of ['*amber runs for the stairs*', 'I bolt', 'Amber backs away and makes a break for it']) assert.ok(readsAsRunning(t), t);
    for (const t of ['*amber attacks the jailer*', 'fine, take me', '', 'I stand my ground']) assert.ok(!readsAsRunning(t), t);
});

test('a guard who sees the escapee is set on taking them in; a fellow prisoner is not', () => {
    const place = cellBlock();
    const r = noticeParty(place, ['Amber'], { turn: 1, canSee: () => true });
    assert.deepEqual(r.seize, [{ guard: 'Wren', target: 'Amber' }]);
    const near = cellBlock();
    near.state.positions.Amber = { floor: 'F0', x: 3, y: 2 };
    noticeParty(near, ['Amber'], { turn: 1, canSee: () => true });
    const again = noticeParty(near, ['Amber'], { turn: 2, canSee: () => true });
    assert.deepEqual(again.seize, [{ guard: 'Wren', target: 'Amber' }], 'walking right up to him: he grabs');
    const dark = cellBlock();
    assert.deepEqual(noticeParty(dark, ['Amber'], { turn: 1, canSee: () => false }).seize, [], 'not before the dice say he noticed');
    const cells = cellBlock();
    cells.guards = { Magnus: person('Magnus', 4, 2, { description: 'a prisoner', role: 'prisoner' }) };
    assert.deepEqual(noticeParty(cells, ['Amber'], { turn: 1, canSee: () => true }).seize, []);
});

test('a search for traps reaches further the better the roll: nothing on a miss, 6 squares at a bare pass, 14 at most', () => {
    assert.equal(searchRadius(11, 12), 0);
    assert.equal(searchRadius(12, 12), 6);
    assert.equal(searchRadius(14, 12), 10);
    assert.equal(searchRadius(25, 12), 14);
    assert.equal(searchRadius(15, null), 12, 'no DC from the DM: 12');
    assert.equal(searchRadius(15, undefined), 12);
    assert.equal(searchRadius(NaN, 12), 0);
});

test('a trap is never a person: by its words, or by being on the map', () => {
    for (const n of ['Covered Pit', 'spike pit', 'Pressure plate (darts)', 'alarm glyph', 'Glyph of Warding (fire)', 'loose ceiling stones', 'tripwire']) assert.ok(looksLikeThing(n), n);
    for (const n of ['Bram Hask', 'Jailer 3', 'Pit Fiend Guard', 'Old Martha']) assert.ok(!looksLikeThing(n), n);
    const place = cellBlock();
    place.traps = { T1: { id: 'T1', kind: 'swinging log', room: 'H', floor: 'F0', x: 2, y: 3, state: 'hidden' } };
    place.items = { I1: { id: 'I1', name: 'rusty ledger', room: 'H', floor: 'F0' } };
    assert.ok(notAPerson(place, 'Swinging Log'), 'the trap on this map, whatever its words');
    assert.ok(notAPerson(place, 'the swinging log'));
    assert.ok(notAPerson(place, 'Rusty Ledger'));
    assert.ok(!notAPerson(place, 'Wren'));
    assert.ok(!notAPerson(null, 'Wren'));
});

test('giving in is the player\'s own words, and refusals are not', () => {
    for (const t of ['*amber raises his hands* fine, take me back', 'ok ok, I\'ll go', '"Alright. Lead the way."', 'i surrender', 'no trouble, I\'ll walk']) assert.equal(givesIn(t), true, t);
    for (const t of ['', '*amber runs*', 'never! come and get me', 'I refuse', 'what do you want', 'fine, make me']) assert.equal(givesIn(t), false, t);
});

test('movement in a fight is counted over the whole round, doubled by a Dash, reset by the next round', () => {
    const world = { combat: { round: 1, order: [{ name: 'Amber', init: 12 }], enemies: {}, speed: { Amber: 6 } } };
    assert.deepEqual(moveBudget(world, 'Amber', 6), { max: 6, used: 0, left: 6, dashing: false });
    spendMove(world, 'Amber', 4);
    assert.equal(moveBudget(world, 'Amber', 6).left, 2, 'two messages, one budget');
    spendMove(world, 'Amber', 5);
    assert.equal(moveBudget(world, 'Amber', 6).left, 0, 'never below zero');
    assert.match(combatSummary(world, 'Amber'), /Movement this round[^\n]*Amber 9\/6/);
    markDash(world, 'Amber');
    assert.deepEqual(moveBudget(world, 'Amber', 6), { max: 12, used: 9, left: 3, dashing: true });
    newRound(world);
    assert.equal(world.combat.round, 2);
    assert.deepEqual(moveBudget(world, 'Amber', 6), { max: 6, used: 0, left: 6, dashing: false }, 'the dash was last round');
    assert.deepEqual(moveBudget({ combat: null }, 'Amber', 6), { max: 6, used: 0, left: 6, dashing: false }, 'no fight: no limit kept');
});

test('a move that is not walking (Misty Step, a shove) is a DM field the code accepts', async () => {
    const { normalizeDmTurn } = await import('../src/core/protocol.js');
    const t = normalizeDmTurn({ narration: 'x', free_move: ['Amber'], positions: { Amber: 'k9' } });
    assert.deepEqual(t.free_move, ['Amber']);
    assert.deepEqual(normalizeDmTurn({ narration: 'x' }).free_move, []);
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
