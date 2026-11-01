// v0.58: what the third live test found. A map is rebuilt only when asked for; an order to the
// people of a place is the DM's; "kept" stops the player at the way out; one potion heals once;
// the one doing the holding is never grappled; arrivals come in from the edge; room notes stay the DM's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRequest, ruleTriage, isOrder, attacksSomeone } from '../src/core/triage.js';
import { applyPlaceChanges, placeView } from '../src/core/explore.js';
import { outBy } from '../src/core/notice.js';
import { TERRAIN } from '../src/core/grid.js';
import { escapeOptions } from '../src/core/restraints.js';
import { normalizeBrief } from '../src/core/architect.js';
import { campFromBrief, generateCamp } from '../src/core/camp.js';

const open = (w, h) => Array(h).fill('.'.repeat(w));
const at = (x, y) => ({ floor: 'F0', x, y });
const make = (w = 24, h = 12) => ({
    name: 'Thrum-Kaal', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w, h, rows: open(w, h), theme: 'forest', props: [{ id: 'P1', x: 4, y: 3, type: 'boulder' }] } }],
    rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {},
    state: { positions: { Amber: at(3, 3), 'Judy Hopps': at(2, 3) }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0' },
});
const far = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

test('C1: a word about the map, or a question about it, never rebuilds it; asking for one still does', () => {
    assert.equal(mapRequest("the knife is drawn as bones and I can't pick it up from the map. please make it a real item lying on the ground, one that shows as a pouch"), null);
    assert.equal(mapRequest('do the guards on the map see me right now?'), null);
    assert.equal(mapRequest('what does the map show north of the camp?'), null);
    assert.equal(mapRequest('I need to get off this map before they do something'), null);
    assert.ok(mapRequest('regenerate the map')?.redo, 'regenerate the map');
    assert.equal(mapRequest('make the map: a small bandit camp by a river')?.kind, 'camp');
    assert.ok(mapRequest('Claude, can you redo the map?')?.redo, 'a request as a question');
    assert.ok(mapRequest('I want a map of the forest'), 'want a map');
    assert.ok(mapRequest('give me a new map, a big one'), 'a new map');
    assert.equal(mapRequest('can i see the map?'), null);
});

test('C4: an order to the people of the place goes to the DM; a word to a companion by name does not; narration is not an order', () => {
    const party = ['Judy Hopps'];
    const r = ruleTriage('"Bring Judy to me, unharmed."', { companions: party });
    assert.equal(r.category, 'risky_action');
    assert.ok(r.order);
    assert.ok(isOrder('"Now. Go and fetch her from the cages, and bring her here."', party));
    assert.ok(isOrder('"You. Unlock this door and strike these irons off my wrists."', party));
    assert.ok(!isOrder('"Judy, bring me the rope."', party), 'a task for the companion');
    assert.ok(!isOrder('*Amber gets up and puts his hands out.*', party), 'narration');
    assert.ok(!isOrder('*Amber takes the knife and tucks it away.*', party));
    assert.ok(!ruleTriage('"Bring Judy to me."', { companions: party, inCombat: true }).order, 'in a fight it is a combat action');
});

test('M6: "strike these irons off my wrists" is not an attack; striking a guard is', () => {
    assert.ok(!attacksSomeone('"You. Unlock this door and strike these irons off my wrists."'));
    assert.ok(!attacksSomeone('I hit the road before dawn.'));
    assert.ok(!attacksSomeone('*Amber kicks the door down.*'));
    assert.ok(attacksSomeone('*Amber strikes the guard across the face.*'));
    assert.ok(attacksSomeone('I kick the guard in the knee.'));
    assert.ok(attacksSomeone('I attack the wolf with my knife.'));
});

test('H1: grappled is not "out of it" (a keeper holding someone still sees and shouts)', () => {
    assert.equal(outBy(['grappled (held by Judy Hopps)']), null);
    assert.equal(outBy(['tied up']), 'bound');
    assert.equal(outBy(['asleep']), 'asleep');
});

test('C3/C4: kept, everyone, and the place view', () => {
    const place = make();
    let log = applyPlaceChanges(place, { guards: { 'Cannibal 1': { at: 'k3', description: 'a cannibal of the camp', hostile: true, intent: 'attack' }, 'Cannibal 2': { at: 'l4', description: 'a cannibal of the camp', hostile: true } } });
    assert.ok(!log.some(l => l.startsWith('⚠️')), log.join(' | '));
    log = applyPlaceChanges(place, { everyone: { hostile: false } });
    assert.ok(log.some(l => /everyone here \(2\): not hostile/.test(l)), log.join(' | '));
    assert.equal(place.guards['Cannibal 1'].hostile, false);
    assert.notEqual(place.guards['Cannibal 1'].intent, 'attack');
    log = applyPlaceChanges(place, { kept: { Amber: { by: 'the Brakh', why: 'their god' } } });
    assert.deepEqual(place.state.kept.Amber, { by: 'the Brakh', why: 'their god' });
    assert.ok(log.some(l => /Amber is kept in Thrum-Kaal by the Brakh \(their god\)/.test(l)), log.join(' | '));
    const view = placeView(place, ['Amber', 'Judy Hopps']);
    assert.ok(/KEPT: Amber can't leave Thrum-Kaal: the Brakh \(their god\)/.test(view), view);
    applyPlaceChanges(place, { kept: { Amber: '' } });
    assert.ok(!place.state.kept.Amber);
    assert.ok(applyPlaceChanges(place, { kept: { Amber: {} } }).some(l => l.startsWith('⚠️')), 'who keeps them is needed');
});

test('H8: the DM puts a real item on the ground, by a square or near someone', () => {
    const place = make();
    let log = applyPlaceChanges(place, { add_items: [{ name: 'a small knife', at: 'f3' }] });
    const knife = Object.values(place.items).find(i => i.name === 'a small knife');
    assert.ok(knife && knife.x === 5 && knife.y === 2 && knife.state === 'here' && !knife.hidden, JSON.stringify(knife));
    assert.ok(log.some(l => /a small knife \(I1a\) on the ground at f3/.test(l)), log.join(' | '));
    log = applyPlaceChanges(place, { add_items: [{ name: 'a coil of rope', near: 'Amber', note: 'frayed' }] });
    const rope = Object.values(place.items).find(i => i.name === 'a coil of rope');
    assert.ok(rope && far(rope, place.state.positions.Amber) <= 3 && far(rope, place.state.positions.Amber) >= 1, JSON.stringify(rope));
    assert.ok(applyPlaceChanges(place, { add_items: [{ name: 'a thing', at: 'nowhere' }] }).some(l => l.startsWith('⚠️')));
    assert.ok(applyPlaceChanges(place, { add_items: [{}] }).some(l => l.startsWith('⚠️')));
});

test('H9: someone new comes in from the edge, not beside the party; with no square given they still come', () => {
    const place = make();
    let log = applyPlaceChanges(place, { guards: { 'Brakh Spearman One': { at: 'd3', description: 'a huge spearman', hostile: true, intent: 'attack' } } });
    const one = place.guards['Brakh Spearman One'];
    assert.ok(one && far(one, place.state.positions.Amber) > 4, `placed ${one?.x},${one?.y}: ${log.join(' | ')}`);
    assert.ok(one.goal, 'on their way to where they were meant to be');
    log = applyPlaceChanges(place, { guards: { 'Brakh Netter': { description: 'a netter', hostile: true } } });
    const net = place.guards['Brakh Netter'];
    assert.ok(net && !log.some(l => l.startsWith('⚠️')), log.join(' | '));
    assert.ok(far(net, place.state.positions.Amber) > 4, `netter at ${net.x},${net.y}`);
});

test('M4: a sentry described as asleep is asleep on the map', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { 'Grukkin Sentry': { at: 'r5', description: 'a sentry asleep at his post, spear across his knees', hostile: true } } });
    assert.equal(place.guards['Grukkin Sentry'].down, 'asleep');
    applyPlaceChanges(place, { guards: { 'Grukkin Sentry': 'awake' } });
    assert.ok(!place.guards['Grukkin Sentry'].down);
});

test("H7: a camp brief's room notes are the DM's hints, never the room's description", () => {
    const brief = normalizeBrief({ name: 'Thrum-Kaal', kind: 'war camp', size: 'big', summary: 'A cannibal fortress of wooden walls.', creatures: 'Brakh', rooms: [{ room: 'pens', note: 'A dry tunnel under the pens connects to a hole in the outer tree line.' }] }, {});
    const plan = campFromBrief(brief, 7);
    const noted = plan.rooms.filter(r => /tunnel/.test(r.hint || ''));
    assert.ok(noted.length, 'the note went to a hint');
    assert.ok(!plan.rooms.some(r => /tunnel/.test(r.description || '')), 'and not into a description');
    const place = generateCamp(plan, 7);
    assert.ok(Object.values(place.rooms).some(r => /tunnel/.test(r.hint || '')), 'kept on the built place');
    assert.ok(!Object.values(place.rooms).some(r => /tunnel/.test(r.description || '')));
});

test('small things: the legend names a tree, the get-up line uses the right pronoun', () => {
    assert.equal(TERRAIN.T.name, 'tree (a pillar indoors)');
    const opts = escapeOptions('Amber', { locked: true, prone: true, reason: 'on the ground', look: '' }, 'his');
    assert.ok(opts[0][2].includes('his feet'), opts[0][2]);
});
