// v0.52: a prisoner kept close by their keeper, hostiles who see the party on any land, the DM's own
// triggers, and companions that keep a distance instead of a square.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlaceChanges, checkTriggers, hostileNotice, followSteps, resolveNear } from '../src/core/explore.js';
import { placeView } from '../src/core/explore.js';

const open = (w, h) => Array(h).fill('.'.repeat(w));
const at = (x, y) => ({ floor: 'F0', x, y });
const make = (w = 20, h = 12) => ({
    name: 'x', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w, h, rows: open(w, h), theme: 'forest', props: [{ id: 'P1', x: 15, y: 9, type: 'tent' }] } }],
    rooms: { W1: { id: 'W1', name: 'The Campsite', floor: 'F0', rect: { x: 12, y: 7, w: 6, h: 4 } } }, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {},
    state: { positions: { Amber: at(2, 3), 'Judy Hopps': at(3, 3) }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0' },
});

test('custody: the DM names the keeper (a companion or someone of the place), the view says so, "" ends it', () => {
    const place = make();
    let log = applyPlaceChanges(place, { custody: { Amber: { by: 'Judy', radius: 2 } } });
    assert.deepEqual(place.state.custody.Amber, { by: 'Judy Hopps', radius: 2, attempts: 0 }, log.join('\n'));
    assert.ok(/CUSTODY: Amber is Judy Hopps's prisoner/.test(String(placeView(place, ['Amber', 'Judy Hopps']))));
    log = applyPlaceChanges(place, { custody: { Amber: 'Nobody Here' } });
    assert.ok(log.some(l => /⚠️ custody\.Amber/.test(l)) && place.state.custody.Amber.by === 'Judy Hopps', 'an unknown keeper changes nothing');
    applyPlaceChanges(place, { guards: { Hobb: { at: 'e3', description: 'the jailer' } } });
    applyPlaceChanges(place, { custody: { Amber: 'Hobb' } });
    assert.equal(place.state.custody.Amber.by, 'Hobb');
    assert.equal(place.state.custody.Amber.radius, 2, 'a plain name keeps the default reach');
    applyPlaceChanges(place, { custody: { Amber: '' } });
    assert.ok(!place.state.custody.Amber);
});

test('triggers: set near a person, a prop, a room or a square; fired once when the party comes within reach; capped at six', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { 'Wolf 1': { at: 'k9', description: 'a grey wolf', hostile: true } } });
    const log = applyPlaceChanges(place, { triggers: [{ near: 'Wolf 1', radius: 3, note: 'the pack springs' }, { near: 'P1', radius: 2, note: 'someone is in the tent' }, { near: 'The Campsite', note: 'the fire is cold' }, { near: 'r2', radius: 1, note: 'a snare here' }, { near: 'Nobody', note: 'x' }, { note: 'no target' }] });
    assert.equal(place.state.triggers.length, 4, log.join('\n'));
    assert.ok(log.filter(l => l.startsWith('⚠️')).length === 2);
    assert.ok(resolveNear(place, 'F0', 'Wolf 1') && resolveNear(place, 'F0', 'the campsite') && resolveNear(place, 'F0', 'r2'));
    assert.equal(checkTriggers(place, 'F0', ['Amber', 'Judy Hopps']).length, 0, 'nobody near anything yet');
    place.state.positions.Amber = at(10, 7);
    const fired = checkTriggers(place, 'F0', ['Amber', 'Judy Hopps']);
    assert.equal(fired.length, 1);
    assert.ok(/TR1 fired: Amber is within 3 squares of Wolf 1\. Your note: "the pack springs"/.test(fired[0]), fired[0]);
    assert.equal(place.state.triggers.length, 3, 'a fired trigger is spent');
    assert.equal(checkTriggers(place, 'F0', ['Amber']).length, 0, 'it does not fire twice');
    // the wolf moves: the trigger follows the wolf
    applyPlaceChanges(place, { triggers: [{ near: 'Wolf 1', radius: 1, note: 'teeth' }] });
    applyPlaceChanges(place, { guards: { 'Wolf 1': 'k8' } });
    assert.equal(checkTriggers(place, 'F0', ['Amber']).length, 1);
    for (let i = 0; i < 8; i++) applyPlaceChanges(place, { triggers: [{ near: 'P1', radius: 1, note: `t${i}` }] });
    assert.ok(place.state.triggers.length <= 6);
    applyPlaceChanges(place, { triggers_clear: true });
    assert.equal(place.state.triggers.length, 0);
});

test('hostiles who can see the party are an event as they come into sight, closer, and right up to them: three at most', () => {
    const place = make(24, 12);
    applyPlaceChanges(place, { guards: { 'Wolf 1': { at: 'l3', description: 'a grey wolf', hostile: true }, Hob: { at: 'm3', description: 'a woodcutter', hostile: false } } });
    // 8 squares off: in sight
    place.state.positions.Amber = at(3, 3); place.state.positions['Judy Hopps'] = at(2, 3);
    let ev = hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']);
    assert.equal(ev.length, 1, ev.join('\n'));
    assert.ok(/Wolf 1 .*HOSTILE\) can see Amber.*8 squares away, in sight/.test(ev[0]), ev[0]);
    assert.equal(hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']).length, 0, 'not again at the same distance');
    place.state.positions.Amber = at(7, 3);
    ev = hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']);
    assert.ok(ev.length === 1 && /4 squares away, close/.test(ev[0]), ev.join('\n'));
    place.state.positions.Amber = at(10, 3);
    ev = hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']);
    assert.ok(ev.length === 1 && /1 square away, right on top of them/.test(ev[0]), ev.join('\n'));
    assert.equal(hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']).length, 0);
    // a hunter already after someone, or one asleep, is no event
    applyPlaceChanges(place, { guards: { 'Wolf 2': { at: 'l5', description: 'a wolf', hostile: true, intent: 'attack', target: 'Amber' }, 'Wolf 3': { at: 'l6', description: 'a wolf', hostile: true, state: 'asleep' } } });
    assert.equal(hostileNotice(place, 'F0', ['Amber', 'Judy Hopps']).length, 0);
});

test('followers keep a distance: by the side when asked, else within a few squares', () => {
    const place = make();
    const lead = { floor: 'F0', x: 10, y: 5 };
    const from = { floor: 'F0', x: 13, y: 5 };
    assert.ok(followSteps(place, 'F0', from, lead, { keep: 1 }).length, 'close: a step toward the player');
    assert.equal(followSteps(place, 'F0', from, lead, { keep: 3 }).length, 0, 'within three: no step needed');
    assert.ok(followSteps(place, 'F0', { floor: 'F0', x: 16, y: 5 }, lead, { keep: 3 }).length, 'six off: closes in');
});
