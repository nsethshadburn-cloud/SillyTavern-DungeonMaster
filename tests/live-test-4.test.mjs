// v0.59: what the fourth live test found. A place takes more newcomers and says why when it won't;
// a sleeper wakes to a loud noise close by; a knife is never someone; an order for someone not yet
// placed brings them in; nobody arrives through a locked door; "I end my turn" ends it; the camp's
// tent is in the camp; items are things; the usual numbers for a wolf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlaceChanges, makeNoise, EARSHOT, NEWCOMER_MAX, atCapacity, looksLikeThing, arrivalSpot, creatureStats, placeView } from '../src/core/explore.js';
import { isEndTurn } from '../src/core/triage.js';
import { parseTime } from '../src/core/clock.js';
import { TERRAIN } from '../src/core/grid.js';
import { normalizeBrief, wildsFromBrief } from '../src/core/architect.js';
import { DM_RULES } from '../src/core/protocol.js';

const open = (w, h) => Array(h).fill('.'.repeat(w));
const at = (x, y) => ({ floor: 'F0', x, y });
const make = (w = 30, h = 14) => ({
    name: 'Gorund', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w, h, rows: open(w, h), theme: 'forest', props: [] } }],
    rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {},
    state: { positions: { Amber: at(3, 3), 'Judy Hopps': at(2, 3) }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0', built: true },
});
const far = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

test('F1: a built place takes more newcomers, and the refusal says why (never "no square given")', () => {
    const place = make();
    for (let i = 1; i <= NEWCOMER_MAX; i++) {
        const log = applyPlaceChanges(place, { guards: { [`Karg Hunter ${i}`]: { at: `z${2 + i}`, description: 'a hunter of the tribe', hostile: true } } });
        assert.ok(!log.some(l => l.startsWith('⚠️')), log.join(' | '));
    }
    assert.ok(atCapacity(place));
    const log = applyPlaceChanges(place, { guards: { Parrot: { at: 'y4', description: 'a parrot' } } });
    assert.ok(log.some(l => /no more newcomers/.test(l)), log.join(' | '));
    assert.ok(!log.some(l => /no square or room given/.test(l)));
    assert.ok(/Newcomers this place can still take: 0/.test(placeView(place, ['Amber', 'Judy Hopps'])));
});

test('F1: a square that is not on the map says so', () => {
    const place = make();
    const log = applyPlaceChanges(place, { guards: { 'Karg Hunter 1': { at: 'zz99', description: 'a hunter', hostile: true } } });
    assert.ok(log.some(l => /is no square or room of this map/.test(l)), log.join(' | '));
});

test('F11: a sleeper wakes to a loud noise close by, and sleeps through one far off', () => {
    const place = make(40, 14);
    applyPlaceChanges(place, { guards: { 'Grukkin Sentry': { at: 'j4', description: 'a sentry asleep at his post', hostile: true }, 'Far Sentry': { at: 'z4', description: 'another, fast asleep', hostile: true } } });
    assert.equal(place.guards['Grukkin Sentry'].down, 'asleep');
    assert.equal(place.guards['Far Sentry'].down, 'asleep');
    const heard = makeNoise(place, 'F0', 8, 3, { what: 'a crate smashed', loud: 1 });
    assert.ok(heard.some(h => /Grukkin Sentry .*woken/.test(h)), heard.join(' | '));
    assert.ok(!place.guards['Grukkin Sentry'].down);
    assert.equal(place.guards['Grukkin Sentry'].state, 'alert');
    assert.equal(place.guards['Far Sentry'].down, 'asleep', `${EARSHOT} squares is too far for a sleeper`);
});

test('F8: a knife, a spear or a crate is never someone on the map', () => {
    assert.ok(looksLikeThing('knife'));
    assert.ok(looksLikeThing('small knife'));
    assert.ok(looksLikeThing('Spear'));
    assert.ok(!looksLikeThing('Karg Hunter 1'));
    assert.ok(!looksLikeThing('Brakh Vorr'));
    assert.ok(!looksLikeThing('Spearman'));
});

test('F9: an order for someone the DM named but never placed brings them in, with the usual numbers', () => {
    const place = make();
    const log = applyPlaceChanges(place, { guards: { 'Wolf 1': 'stalking' } });
    const wolf = place.guards['Wolf 1'];
    assert.ok(wolf, log.join(' | '));
    assert.equal(wolf.intent, 'stalk');
    assert.equal(wolf.hp_max, 11);
    assert.equal(wolf.ac, 13);
    assert.ok(!log.some(l => /nobody by that name/.test(l)), log.join(' | '));
    assert.ok(far(wolf, place.state.positions.Amber) > 4, 'came in from the edge');
});

test('H8 again: an item the DM puts down keeps a plain name', () => {
    const place = make();
    applyPlaceChanges(place, { add_items: [{ name: 'a small knife', at: 'f3' }] });
    assert.ok(Object.values(place.items).some(i => i.name === 'small knife'));
});

test('F12: nobody arrives through a locked door', () => {
    const place = make();
    place.doors.D1 = { id: 'D1', floor: 'F0', x: 20, y: 3, state: 'locked', kind: 'locked', rooms: [] };
    const spot = arrivalSpot(place, 'F0', { x: 4, y: 3 });
    assert.ok(spot && far(spot, { x: 20, y: 3 }) > 2, JSON.stringify(spot));
});

test('the usual numbers for a creature or a fighter the DM gave none', () => {
    assert.deepEqual(creatureStats('Wolf 1'), { hp: 11, ac: 13 });
    assert.deepEqual(creatureStats('Karg Hunter 2 a hunter of the tribe'), { hp: 11, ac: 12 });
    assert.equal(creatureStats('Nib'), null);
});

test('"I end my turn." in words ends the turn', () => {
    for (const s of ['I end my turn.', 'end turn', 'I pass my turn', '((end my turn))', 'Done.', "That's my turn."]) assert.ok(isEndTurn(s), s);
    for (const s of ['I end the fight with a kick', 'turn around', 'I turn to Judy', 'done with you, Judy']) assert.ok(!isEndTurn(s), s);
});

test('the clock knows the middle of the night; the floor is called a floor', () => {
    assert.equal(parseTime('middle of the night'), 90);
    assert.equal(parseTime('late at night'), 1380);
    assert.equal(TERRAIN['.'].name, 'open floor');
});

test("F13: a campsite's tent is in the camp, not a clearing of its own; traps and walls are never items", () => {
    const brief = normalizeBrief({ name: "Amber's camp", kind: 'forest camp', size: 'small', summary: "Amber's small camp in the woods: one tent and a fire.", rooms: [{ room: "Judy's tent", has: ['bedroll', 'deadfall traps along all four cardinal points'] }, { room: 'the fire', has: ['a cookpot'] }] }, {});
    assert.ok(!brief.rooms.some(r => r.has.some(it => /trap/.test(it))), JSON.stringify(brief.rooms));
    const plan = wildsFromBrief(brief, 7);
    assert.equal(plan.rooms.length, 2, plan.rooms.map(r => r.name).join(', '));
    assert.ok(plan.rooms[1].items.some(it => /bedroll/.test(it.name)));
});

test('the protocol says it: reach, the gate, nothing holds anyone the state does not show', () => {
    assert.ok(/REACH: nobody hits from more than one square away/.test(DM_RULES));
    assert.ok(/CAPTURED AND BROUGHT SOMEWHERE/.test(DM_RULES));
    assert.ok(/NOTHING HOLDS ANYONE THAT THE STATE DOESN'T SHOW/.test(DM_RULES));
    assert.ok(/DISTANCES ARE THE MAP'S/.test(DM_RULES));
});
