// The second live test's findings (v0.51): the party's own camp by its words, wagons that drive and are moved
// from inside, horses that stay hitched and get down, typed dice read right, loud failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCamp } from '../src/core/camp.js';
import { OWN_CAMP, wildsFromBrief, normalizeBrief } from '../src/core/architect.js';
import { generateWilds, normalizePlan } from '../src/core/layout.js';
import { bandWord, article } from '../src/core/text.js';
import { parsePlayerRoll, diceMax } from '../src/core/dice.js';
import { pickModel } from '../src/core/models.js';
import { lockDc } from '../src/core/locks.js';
import { generateWagon } from '../src/core/wagon.js';
import { moveProp, tickGuards, applyPlaceChanges, dismountsInText, syncMounts } from '../src/core/explore.js';
import { furFromWords, lookForNpc, isBeast } from '../src/core/sprites.js';
import { toCoord } from '../src/core/grid.js';

test("finding 1: a camp the party set up is theirs whatever it's called", () => {
    assert.ok(!isCamp('camp', 'Hollow Oak Camp Amber and Judy have set up a temporary camp for the night'));
    assert.ok(!isCamp('camp', 'Hollow Oak Camp one small fire and one tent in the woods'));
    assert.ok(isCamp('camp', 'Greywether Hollow Camp a gang of raiders keeps captives in cages'));
    // the player's own camp with the player under arrest at it is still their camp; a band's camp with a prisoner is a fort
    assert.ok(!isCamp('camp', "Amber's Forest Camp the player asked for this map: Judy has arrested Amber, her prisoner, cuffed at his own camp; they sleep here and walk to the prison at dawn"));
    assert.ok(isCamp('camp', "Amber's Forest Camp now held by a band of raiders with Amber their prisoner"));
    for (const s of ['set up a temporary camp', 'they made camp under the oaks', 'one small fire', 'a two-person camp']) assert.ok(OWN_CAMP.test(s), s);
});

test('finding 13: a campsite is a small map with its fire and tent, starting at the fire', () => {
    for (const seed of [1, 2, 3, 7, 11]) {
        const plan = wildsFromBrief(normalizeBrief({ name: "Amber's forest camp", kind: 'camp', size: 'big', summary: 'Amber and Judy set up a temporary camp: one small fire and one tent. A stream nearby.', start: 'by the fire', guards: 4 }), seed);
        assert.notEqual(plan.start, 'W1', 'starts at the campsite, not the trail in');
        assert.equal(plan.guards.length, 0, 'a campsite has no guards, whatever the brief counted');
        const place = generateWilds(normalizePlan(plan), seed);
        const props = place.floors[0].map.props.map(p => p.type);
        assert.ok(props.includes('campfire') && props.includes('tent'), `seed ${seed}: campfire and tent: ${props.join(',')}`);
        assert.ok(place.floors[0].map.w <= 26 && place.floors[0].map.h <= 22, `seed ${seed}: small: ${place.floors[0].map.w}x${place.floors[0].map.h}`);
    }
});

test('finding 20: a band is named from the first words of the brief, not a fragment of a sentence', () => {
    assert.equal(bandWord('armed camp guards and one raven that watches the road'), 'Camp Guard');
    assert.equal(bandWord('two aarakocra raiders, cruel and hungry'), 'Aarakocra Raider');
    assert.equal(bandWord('wolves'), 'Wolf');
    assert.equal(bandWord(''), '');
    assert.equal(article('Aarakocra Raider'), 'an'); assert.equal(article('camp guard'), 'a');
});

test('finding 11: two typed dice with advantage or disadvantage keep the right one', () => {
    assert.equal(parsePlayerRoll('14, 5', 20, { advantage: 'disadvantage' }).natural, 5);
    assert.equal(parsePlayerRoll('18, 12', 20, { advantage: 'disadvantage' }).natural, 12);
    assert.equal(parsePlayerRoll('6 and 15', 20, { advantage: 'advantage' }).natural, 15);
    assert.equal(parsePlayerRoll('14, 5', 20).natural, 14, 'a plain roll keeps the first');
    assert.equal(parsePlayerRoll('17', 20, { advantage: 'advantage' }).natural, 17);
});

test("finding 17: typed damage can't beat the dice", () => {
    assert.equal(diceMax('1d4+5'), 9); assert.equal(diceMax('2d6'), 12); assert.equal(diceMax('1d8+1d6+3'), 17); assert.equal(diceMax('lots'), 0);
});

test("finding 14: the player's turn and the end of the round use the combat round's model", () => {
    const o = { hybrid: true, mainModel: 'claude-sonnet', taskModels: { combat_round: 'claude-haiku', combat_action: 'claude-haiku' }, rank: m => (m.includes('sonnet') ? 2 : 1) };
    assert.equal(pickModel(['player_turn', 'combat_action'], o), 'claude-haiku');
    assert.equal(pickModel(['end_turn'], o), 'claude-haiku');
    assert.equal(pickModel(['opening'], o), 'claude-sonnet');
});

test('finding 15: a door with its own DC keeps it', () => {
    const jail = generateWagon('jail', { seed: 2 });
    assert.equal(lockDc(jail, jail.doors.D1), 15);
});

test('finding 8: a wagon drives a forest road, between the trees, to the nearest square it fits', () => {
    const rows = [];
    for (let y = 0; y < 10; y++) rows.push([...Array(14)].map((_, x) => (y === 5 ? '.' : x < 2 ? '.' : 'T')).join(''));
    const map = { w: 14, h: 10, rows: rows.slice().reverse(), theme: 'forest', props: [{ id: 'P1', x: 0, y: 4, w: 3, h: 2, type: 'wagon' }] };
    const place = { name: 'x', floors: [{ id: 'F0', name: 'x', level: 0, map }], rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {}, state: { positions: {}, explored: {}, floor: 'F0' } };
    const r = moveProp(place, 'P1', toCoord(9, 5), { force: true });
    assert.ok(r.ok, r.why);
    const wagon = map.props[0];
    assert.ok(wagon.x >= 7 && wagon.y >= 3 && wagon.y <= 5, `${wagon.x},${wagon.y}`);
    // never onto water: asked for a square in the river, it stops on the nearest dry ground instead
    map.rows[9 - 5] = 'w'.repeat(14);
    const bad = moveProp(place, 'P1', toCoord(0, 5), { force: true });
    assert.ok(!bad.ok || wagon.y + 1 < 5 || wagon.y > 5, `${wagon.x},${wagon.y}`);
});

test('finding 16 and 7: a hitched or ridden horse stays put; a rider the story gets down is down', () => {
    const map = { w: 12, h: 8, rows: Array(8).fill('............'), theme: 'forest', props: [{ id: 'P1', x: 5, y: 3, w: 3, h: 2, type: 'wagon', team: ['Dun Gelding'] }] };
    const place = { name: 'x', floors: [{ id: 'F0', name: 'x', level: 0, map }], rooms: { R: { id: 'R', name: 'The Road', floor: 'F0', rect: { x: 0, y: 0, w: 12, h: 8 } } }, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {}, state: { positions: { Amber: 'a1', 'Judy Hopps': 'b1' }, explored: {}, floor: 'F0' } };
    applyPlaceChanges(place, { guards: { 'Dun Gelding': { at: 'd3', description: 'a dun gelding', hostile: false, hp: 19, ac: 10 }, 'Brown Mare': { at: 'b1', description: 'a brown mare', hostile: false }, Hobb: { at: 'c1', description: 'the jailer' } }, ride: { 'Judy Hopps': 'Brown Mare' } });
    assert.equal(place.guards['Dun Gelding'].hp, 19); assert.equal(place.guards['Dun Gelding'].ac, 10);
    const before = { g: [place.guards['Dun Gelding'].x, place.guards['Dun Gelding'].y], m: [place.guards['Brown Mare'].x, place.guards['Brown Mare'].y] };
    let seed = 1; const r = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 12; i++) tickGuards(place, r, 1);
    assert.deepEqual([place.guards['Dun Gelding'].x, place.guards['Dun Gelding'].y], before.g, 'the hitched horse stays');
    assert.deepEqual([place.guards['Brown Mare'].x, place.guards['Brown Mare'].y], before.m, 'the ridden horse stays');
    assert.deepEqual(dismountsInText(place, 'Judy slides off the saddle and lands lightly.'), ['Judy Hopps']);
    assert.ok(!place.state.mounts['Judy Hopps']);
    applyPlaceChanges(place, { ride: { 'Judy Hopps': 'Brown Mare' } });
    assert.deepEqual(dismountsInText(place, 'The mare snorts. Judy pats her neck and stays in the saddle.'), []);
    assert.ok(place.state.mounts['Judy Hopps']);
    // the horse dies: the ride is over the same sync
    place.guards['Brown Mare'].state = 'dead';
    syncMounts(place);
    assert.ok(!place.state.mounts['Judy Hopps']);
});

test('a brown mare is brown, a dun gelding dun; a horse is a beast', () => {
    assert.equal(furFromWords('Brown Mare'), '#7a4a2a');
    assert.equal(furFromWords('Dun Gelding, a dun gelding'), '#a87a4a');
    assert.equal(furFromWords('Snowfoot a white pony'), '#e8e2d6');
    assert.equal(lookForNpc('Brown Mare', 'a bay mare in the traces').fur, '#7a4a2a');
    assert.ok(isBeast({ name: 'Dun Gelding', description: 'a dun gelding' }));
});
