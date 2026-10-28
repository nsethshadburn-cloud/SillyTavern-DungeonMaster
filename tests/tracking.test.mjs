// Run with: node --test tests/
// v0.24: the map and the story in step. Which thing you mean, the map sync, hunters, who has
// noticed whom, initiative first, bodies, and traps where someone would set them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget, thingsOnFloor } from '../src/core/targets.js';
import { mapSyncPrompt, parseMapSync } from '../src/core/mapsync.js';
import { moveHunters, clearEngaged, applyPlaceChanges, placeView, killPerson, clearBodies, placePerson, visibleGuards } from '../src/core/explore.js';
import { noteSeen, applyNoticed, awareSummary, combatSummary } from '../src/core/world.js';
import { normalizeDmTurn } from '../src/core/protocol.js';
import { generatePlace } from '../src/core/layout.js';
import { MANOR_PLAN } from './fixtures/manor-plan.mjs';

/** A plain 20x10 place: a Library (x 0-9) and a Kennel yard (x 11-19), a door between them at (10, 5). */
function testPlace() {
    const rows = [];
    for (let y = 9; y >= 0; y--) {
        let row = '';
        for (let x = 0; x < 20; x++) row += x === 10 ? (y === 5 ? '+' : '#') : '.';
        rows.push(row);
    }
    const props = [
        { id: 'p1', type: 'bookshelf', x: 1, y: 8 },
        { id: 'p2', type: 'bookshelf', x: 7, y: 8 },
        { id: 'p3', type: 'chest', x: 4, y: 1 },
        { id: 'p4', type: 'kennel', x: 15, y: 5 },
        { id: 'p5', type: 'crate', x: 18, y: 1 },
    ];
    return {
        name: 'Test Manor', fog: false,
        floors: [{ id: 'F0', name: 'Ground', level: 0, map: { w: 20, h: 10, rows, props, theme: 'mansion' } }],
        rooms: { R1: { id: 'R1', name: 'Library', floor: 'F0', rect: { x: 0, y: 0, w: 10, h: 10 } }, R2: { id: 'R2', name: 'Kennel Yard', floor: 'F0', rect: { x: 11, y: 0, w: 9, h: 10 } } },
        doors: { D1: { id: 'D1', floor: 'F0', x: 10, y: 5, rooms: ['R1', 'R2'], state: 'closed', kind: 'door' } },
        stairs: [], traps: {}, items: {}, guards: {}, exits: [], windows: {},
        state: { floor: 'F0', positions: { Amber: { floor: 'F0', x: 4, y: 4 }, 'Judy Hopps': { floor: 'F0', x: 5, y: 4 } }, explored: {}, visited: ['R1'], waiting: {} },
    };
}

test('which thing: two bookshelves in the room means asking; one chest is just that chest', () => {
    const place = testPlace();
    const amber = place.state.positions.Amber;
    const two = resolveTarget(place, amber, 'the bookshelf');
    assert.equal(two.pick, undefined);
    assert.deepEqual(two.choices.map(t => t.id).sort(), ['p1', 'p2']);
    assert.equal(resolveTarget(place, amber, 'smash that bookcase').choices.length, 2, 'other words for it work');
    assert.equal(resolveTarget(place, amber, 'the chest').pick.id, 'p3');
    assert.equal(resolveTarget(place, amber, 'the kennel').pick.id, 'p4', 'not in this room, but the only one seen');
    assert.equal(resolveTarget(place, amber, 'the crate').pick.id, 'p5', 'a crate is a crate, not a kennel');
    assert.equal(resolveTarget(place, amber, 'the bookshelf', { last: 'p2' }).pick.id, 'p2', 'the same one as last time');
    assert.equal(resolveTarget(place, amber, 'the other bookshelf', { last: 'p2' }).choices.length, 2, '"the other one" asks again');
    assert.equal(resolveTarget(place, amber, 'the nearest bookshelf').pick.id, 'p1');
    assert.equal(resolveTarget(place, amber, 'the door').pick.id, 'D1');
    assert.deepEqual(resolveTarget(place, amber, 'the piano'), {}, 'nothing like it: nothing picked');
    assert.deepEqual(resolveTarget(place, amber, 'it'), {});
});

test('which thing: right beside one and far from the other means that one', () => {
    const place = testPlace();
    const r = resolveTarget(place, { floor: 'F0', x: 2, y: 7 }, 'bookshelf');
    assert.equal(r.pick.id, 'p1');
    const people = thingsOnFloor(place, 'F0').filter(t => t.kind === 'person');
    assert.equal(people.length, 0);
    placePerson(place, 'Guard Dog', { floor: 'F0', x: 16, y: 5 }, { info: { description: 'a snarling mastiff', hostile: true } });
    assert.equal(resolveTarget(place, place.state.positions.Amber, 'the dog').pick.id, 'Guard Dog');
});

test('map sync: only real names and ids get through, and a known face is not spawned twice', () => {
    const known = { party: ['Amber', 'Judy Hopps'], people: ['Butler'], things: ['p4', 'p5'], doors: ['D1'], rooms: ['R1', 'R2'] };
    const reply = JSON.stringify({ changes: [
        { op: 'spawn', name: 'Guard Dog', what: 'a snarling mastiff', near: 'P4', hostile: true, intent: 'attack', target: 'judy' },
        { op: 'move', who: 'Judy', to: 'p4' },
        { op: 'move', who: 'Nobody', to: 'p4' },
        { op: 'door', id: 'D1', state: 'opened' },
        { op: 'door', id: 'D9', state: 'open' },
        { op: 'thing', id: 'p5', state: 'smashed' },
        { op: 'spawn', name: 'Butler', intent: 'flee' },
        { op: 'spawn', name: 'Amber' },
        { op: 'hide', who: 'Judy Hopps', in: 'nonsense' },
        { op: 'pose', who: 'Amber', on: 'p9', how: 'sit' },
        { op: 'fly', who: 'Amber' },
    ] });
    const ops = parseMapSync(`Sure! ${reply}`, known);
    assert.deepEqual(ops.find(o => o.op === 'spawn'), { op: 'spawn', name: 'Guard Dog', what: 'a snarling mastiff', near: 'p4', hostile: true, intent: 'attack', target: 'Judy Hopps' });
    assert.deepEqual(ops.find(o => o.op === 'move'), { op: 'move', who: 'Judy Hopps', to: 'p4' });
    assert.deepEqual(ops.find(o => o.op === 'door'), { op: 'door', id: 'D1', state: 'open' });
    assert.deepEqual(ops.find(o => o.op === 'thing'), { op: 'thing', id: 'p5', state: 'broken' });
    assert.deepEqual(ops.find(o => o.op === 'intent'), { op: 'intent', who: 'Butler', intent: 'flee', target: '' }, 'the butler is already there: he runs, he isn\'t added again');
    assert.deepEqual(ops.find(o => o.op === 'hide'), { op: 'hide', who: 'Judy Hopps', in: '' }, 'hiding with no real thing: the nearest place to hide');
    assert.equal(ops.filter(o => o.op === 'spawn').length, 1, 'never the party');
    assert.equal(ops.some(o => o.op === 'pose'), false, 'no such thing to sit on');
    assert.deepEqual(parseMapSync('no idea', known), []);
    const { user } = mapSyncPrompt({ party: [{ name: 'Judy Hopps', at: 'f5', room: 'Library' }], people: [], things: [{ id: 'p4', name: 'kennel', at: 'p6', room: 'Kennel Yard' }], rooms: [{ id: 'R1', name: 'Library' }], story: 'Judy opens the kennel. A dog bursts out.' });
    assert.match(user, /p4 = kennel/);
    assert.match(user, /A dog bursts out/);
});

test('hunters: a dog set on Judy chases her step by step and strikes once when it reaches her', () => {
    const place = testPlace();
    const dog = placePerson(place, 'Guard Dog', { floor: 'F0', x: 16, y: 5 }, { info: { hostile: true } });
    applyPlaceChanges(place, { guards: { 'Guard Dog': { at: 'q6', intent: 'attack', target: 'Judy Hopps' } } });
    assert.equal(dog.intent, 'attack');
    assert.equal(dog.state, 'alert');
    const party = ['Amber', 'Judy Hopps'];
    let struck = [];
    for (let i = 0; i < 30 && !struck.length; i++) struck = moveHunters(place, 'F0', party, 1);
    assert.deepEqual(struck, [{ name: 'Guard Dog', target: 'Judy Hopps' }]);
    const judy = place.state.positions['Judy Hopps'];
    assert.ok(Math.max(Math.abs(dog.x - judy.x), Math.abs(dog.y - judy.y)) <= 1, 'right beside her');
    assert.equal(place.doors.D1.state, 'open', 'it came through the door');
    assert.deepEqual(moveHunters(place, 'F0', party, 1), [], 'once per turn');
    // She runs: it keeps after her.
    judy.x = 0; judy.y = 0;
    moveHunters(place, 'F0', party, 2);
    assert.ok(Math.max(Math.abs(dog.x - judy.x), Math.abs(dog.y - judy.y)) < 6, 'it follows');
    clearEngaged(place);
    let again = [];
    for (let i = 0; i < 10 && !again.length; i++) again = moveHunters(place, 'F0', party, 1);
    assert.equal(again.length, 1, 'a new turn: it can strike again');
    // Scared off: it runs away from the party.
    applyPlaceChanges(place, { guards: { 'Guard Dog': 'fleeing' } });
    const before = Math.max(Math.abs(dog.x - judy.x), Math.abs(dog.y - judy.y));
    moveHunters(place, 'F0', party, 3);
    assert.ok(Math.max(Math.abs(dog.x - judy.x), Math.abs(dog.y - judy.y)) > before);
    assert.match(placeView(place, party), /Guard Dog.*running from the party/);
});

test('bodies: the dead stay where they fell for three turns, then they are cleared', () => {
    const place = testPlace();
    const g = placePerson(place, 'Bandit', { floor: 'F0', x: 3, y: 3 }, { info: { hostile: true } });
    g.intent = 'attack';
    killPerson(place, 'Bandit', 10);
    assert.equal(g.state, 'dead');
    assert.equal(g.intent, undefined, 'the dead don\'t hunt');
    assert.deepEqual(moveHunters(place, 'F0', ['Amber'], 3), []);
    assert.equal(visibleGuards(place, 'F0', new Uint8Array(200).fill(1)).length, 0, 'a body never "comes into view" as a guard');
    assert.match(placeView(place, ['Amber']), /Bodies on the floor.*Bandit/);
    assert.equal(clearBodies(place, 12), 0);
    assert.equal(clearBodies(place, 13), 1);
    assert.equal(g.state, 'gone');
});

test('who has noticed whom: from rolls, kept until changed, and told to everyone', () => {
    const w = {};
    noteSeen(w, 'Guard', 'Judy Hopps', true);
    noteSeen(w, 'Guard', 'Amber', false);
    assert.equal(awareSummary(w), 'Guard has seen Judy Hopps. Everyone else is unaware of the party.');
    noteSeen(w, 'guard', 'Judy Hopps', false);
    assert.equal(awareSummary(w), '', 'she slipped away from him');
    applyNoticed(w, { Butler: ['Amber'], Cook: 'none' });
    assert.deepEqual(w.aware, { Butler: ['Amber'] });
    applyNoticed(w, { Butler: [] });
    assert.deepEqual(w.aware, {});
    const t = normalizeDmTurn({
        npc_rolls: [{ who: 'Guard', what: 'Perception', notation: '1d20+2', dc: 14, spot: { seer: 'Guard', seen: 'Judy Hopps' } }],
        player_roll: { kind: 'check', skill: 'Stealth', dc: 12, spot: { seer: 'Guard', seen: 'Amber' } },
        noticed: { Butler: ['Amber'] },
        start_combat: { enemies: [{ name: 'Dog', hp: 9, ac: 12, damage: '1d6+2' }, { name: 'Rat', hp: 2, damage: 'lots' }] },
    });
    assert.deepEqual(t.npc_rolls[0].spot, { seer: 'Guard', seen: 'Judy Hopps' });
    assert.deepEqual(t.player_roll.spot, { seer: 'Guard', seen: 'Amber' });
    assert.deepEqual(t.noticed, { Butler: ['Amber'] });
    assert.equal(t.start_combat.enemies[0].damage, '1d6+2');
    assert.equal(t.start_combat.enemies[1].damage, '', 'no dice, no damage string');
});

test('initiative first: until the player rolls, nobody acts; then the order around the player is spelled out', () => {
    const w = { combat: { round: 1, order: [{ name: 'Dog', init: 18 }, { name: 'Judy Hopps', init: 9 }], enemies: { Dog: { hp: 9, hp_max: 9, ac: 12 } } } };
    assert.match(combatSummary(w, 'Amber'), /WAITING for Amber's initiative roll: nobody acts yet/);
    w.combat.order.splice(1, 0, { name: 'Amber', init: 12 });
    assert.match(combatSummary(w, 'Amber'), /Dog act before Amber; Judy Hopps after/);
});

test('traps go where someone would set them: by doorways and in front of what is worth guarding', () => {
    let placed = 0, sensible = 0;
    for (let seed = 1; seed <= 12; seed++) {
        const place = generatePlace({ ...MANOR_PLAN, rooms: MANOR_PLAN.rooms.map(r => ({ ...r, traps: [{ kind: 'pressure plate (darts)', dc: 13 }, { kind: 'needle in the lock', dc: 12 }] })) }, seed);
        if (!place) continue;
        for (const t of Object.values(place.traps)) {
            placed++;
            const map = place.floors.find(f => f.id === t.floor).map;
            const nearDoor = Object.values(place.doors).some(d => d.floor === t.floor && Math.abs(d.x - t.x) + Math.abs(d.y - t.y) === 1);
            const nearThing = map.props.some(p => p.type !== 'trap' && t.x >= p.x - 1 && t.x <= p.x + (p.w || 1) && t.y >= p.y - 1 && t.y <= p.y + (p.h || 1) && ['chest', 'coffin', 'altar', 'throne', 'cabinet', 'desk', 'statue', 'weaponrack', 'armor', 'dresser', 'wardrobe', 'cage', 'lever', 'slab', 'iron_maiden'].includes(p.type));
            const room = place.rooms[t.room];
            if (nearDoor || nearThing || room?.type === 'hallway') sensible++;
        }
    }
    assert.ok(placed > 20, `traps were placed (${placed})`);
    console.log(`traps placed sensibly: ${sensible}/${placed}`);
    assert.ok(sensible / placed >= 0.75, `most traps sit by a door or a guarded thing (${sensible}/${placed})`);
});

test('the DM knows how far people are and what the party can sense; a guard who missed you doesn\'t come for you', async () => {
    const { markNoticed } = await import('../src/core/explore.js');
    const place = testPlace();
    const party = ['Amber', 'Judy Hopps'];
    const near = placePerson(place, 'Cook', { floor: 'F0', x: 6, y: 4 }, { info: {} });
    const far = placePerson(place, 'Guard Captain', { floor: 'F0', x: 19, y: 9 }, { info: { hostile: true } });
    place.doors.D1.state = 'closed';
    const view = placeView(place, party);
    assert.match(view, /Cook in R1 at g5 \(1 squares away, IN SIGHT\)/);
    assert.match(view, /Guard Captain in R2 at t10 \(14 squares away, FAR: the party can't see, hear or smell them\)/);
    // He rolled and missed Amber: set on attacking, he still doesn't come for her.
    far.intent = 'attack';
    far.target = 'Amber';
    markNoticed(place, 'Guard Captain', 'Amber', false);
    assert.match(placeView(place, party), /hasn't noticed Amber/);
    const before = { x: far.x, y: far.y };
    moveHunters(place, 'F0', party, 3);
    assert.deepEqual({ x: far.x, y: far.y }, before, 'he stays put');
    markNoticed(place, 'Guard Captain', 'Amber', true);
    moveHunters(place, 'F0', party, 3);
    assert.notDeepEqual({ x: far.x, y: far.y }, before, 'once he notices her, he comes');
    assert.ok(near);
});
