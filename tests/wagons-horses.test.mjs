// v0.50: a small camp is a fire and a tent; wagons have tiny insides; horses are beasts that carry riders and pull wagons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCamp, campSpec } from '../src/core/camp.js';
import { wildsFromBrief, normalizeBrief, OWN_CAMP } from '../src/core/architect.js';
import { generateWilds, normalizePlan } from '../src/core/layout.js';
import { generateWagon } from '../src/core/wagon.js';
import { PROPS, HEAVY } from '../src/core/grid.js';
import { isBeast } from '../src/core/sprites.js';
import { applyPlaceChanges, syncMounts } from '../src/core/explore.js';

test("the party's own camp is not a hostile camp: one fire, one tent, no walls", () => {
    for (const [kind, name] of [['camp', "Amber's forest camp"], ['campsite', 'The Campsite'], ['camp', 'our camp for the night'], ['camp', 'a small camp by the stream']]) assert.ok(!isCamp(kind, name), `${kind} / ${name}`);
    for (const [kind, name] of [['camp', 'Cannibal Camp'], ['camp', 'the raiders\' stockade'], ['camp', 'Bandit Camp by a River']]) assert.ok(isCamp(kind, name), `${kind} / ${name}`);
    assert.ok(OWN_CAMP.test("Amber's forest camp") && OWN_CAMP.test('they make camp under the oaks') && !OWN_CAMP.test('the cannibal camp'));
    // nothing said about guards or enemies: peaceful, no palisade
    const spec = campSpec(normalizeBrief({ name: 'Riverside Camp', kind: 'camp', size: 'small', summary: 'A quiet camp by the river.', guards: null }));
    assert.ok(!spec.hostile && spec.walls === 'none', JSON.stringify(spec));
    assert.ok(campSpec(normalizeBrief({ name: 'Raider Camp', kind: 'camp', size: 'small', summary: 'Raiders keep captives in cages.' })).hostile);
});

test('a small camp in the woods is a clearing with a campfire and a tent, nobody guarding it', () => {
    const brief = normalizeBrief({ name: "Amber's forest camp", kind: 'camp', size: 'small', summary: 'A small camp in the forest: a fire and a tent. Amber sits by the fire.', start: 'outside' });
    const plan = wildsFromBrief(brief, 7);
    assert.ok(plan.wild, 'wilds, not a stockade');
    const place = generateWilds(normalizePlan(plan), 7);
    const props = place.floors[0].map.props.map(p => p.type);
    assert.ok(props.includes('campfire') && props.includes('tent'), `campfire and tent: ${props.join(',')}`);
    assert.ok(!props.includes('spikes') && !props.includes('skullpole') && !props.includes('watchtower'), 'nothing hostile');
    assert.equal(Object.keys(place.guards).length, 0, 'no guards');
    assert.ok(!Object.keys(place.buildings).length, 'no buildings');
    assert.ok(Object.keys(place.rooms).length <= 3, `a clearing or two: ${Object.keys(place.rooms).length}`);
});

test('an open wagon: boards, a way off on either side; a jailer\'s wagon: bars and one locked steel door', () => {
    const open = generateWagon('open', { seed: 3 });
    assert.equal(open.vehicle, 'open');
    assert.ok(open.floors[0].map.w <= 8 && open.floors[0].map.h <= 6, 'tiny');
    assert.equal(open.exits.length, 2);
    assert.ok(Object.values(open.doors).every(d => d.exit && d.kind === 'arch'));
    assert.ok(!open.floors[0].map.rows.join('').includes('I'), 'no bars');
    const jail = generateWagon('jail', { name: 'the jailer\'s wagon', seed: 3 });
    assert.equal(jail.vehicle, 'jail');
    assert.equal(jail.exits.length, 1);
    assert.equal(jail.doors.D1.kind, 'locked'); assert.equal(jail.doors.D1.state, 'locked'); assert.ok(jail.doors.D1.dc >= 12);
    assert.ok((jail.floors[0].map.rows.join('').match(/I/g) || []).length >= 12, 'bars all round');
    assert.ok(jail.floors[0].map.props.some(p => p.type === 'chains'));
    assert.equal(jail.state.explored.F0, '1'.repeat(7 * 5), 'nothing to explore in a wagon');
    assert.equal(PROPS.wagon.vehicle, 'open'); assert.equal(PROPS.jailwagon.vehicle, 'jail');
    assert.ok(HEAVY.has('wagon') && HEAVY.has('jailwagon'), 'a wagon is not pushed by walking into it');
});

test('a horse is a beast: no lines; a rider\'s horse goes where they go; a team stands in front of its wagon', () => {
    assert.ok(isBeast({ name: 'Old Bess', description: 'a bay mare' }) && isBeast({ name: 'Horse 1' }) && isBeast({ name: 'Grimble', sprite: 'horse' }));
    assert.ok(!isBeast({ name: 'Judy Hopps', description: 'a rabbit police officer' }) && !isBeast({ name: 'Horseman', description: 'a horse-man of the plains' }));
    const map = { w: 10, h: 8, rows: Array(8).fill('..........'), theme: 'forest', props: [{ id: 'P1', x: 5, y: 3, type: 'wagon' }] };
    const place = { name: 'x', floors: [{ id: 'F0', name: 'x', level: 0, map }], rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {}, state: { positions: { Amber: 'a1' }, explored: {}, floor: 'F0' } };
    let log = applyPlaceChanges(place, { guards: { 'Old Bess': { at: 'c3', description: 'a bay mare', hostile: false }, Hob: { at: 'd4', description: 'a carter', hostile: false } } });
    assert.ok(place.guards['Old Bess'] && place.guards.Hob, log.join('\n'));
    log = applyPlaceChanges(place, { ride: { Hob: 'Old Bess' } });
    assert.equal(place.state.mounts.Hob, 'Old Bess', log.join('\n'));
    syncMounts(place);
    assert.equal(place.guards['Old Bess'].x, place.guards.Hob.x); assert.equal(place.guards['Old Bess'].y, place.guards.Hob.y);
    log = applyPlaceChanges(place, { ride: { Hob: '' } });
    assert.ok(!place.state.mounts.Hob && /dismounts/.test(log.join('\n')));
    log = applyPlaceChanges(place, { ride: { Amber: 'Pegasus' } });
    assert.ok(log.some(l => /⚠️ ride\.Amber/.test(l)), 'no such horse is reported');
    log = applyPlaceChanges(place, { props: { P1: { team: ['Old Bess'], move: 'h6' } } });
    assert.ok(/drawn by Old Bess/.test(log.join('\n')) && /P1 moved/.test(log.join('\n')), log.join('\n'));
    const w = map.props.find(p => p.id === 'P1');
    assert.ok(place.guards['Old Bess'].x < w.x && Math.abs(place.guards['Old Bess'].y - w.y) <= 1, 'the horse stands in front of the wagon');
    // a dead horse ends the ride
    applyPlaceChanges(place, { ride: { Hob: 'Old Bess' } });
    place.guards['Old Bess'].state = 'dead';
    assert.ok(syncMounts(place).some(l => /no longer rides/.test(l)) && !place.state.mounts.Hob);
});
