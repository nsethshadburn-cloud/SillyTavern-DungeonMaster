// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePlace } from '../src/core/layout.js';
import { tickGuards, placeView, roomAt, floorById, PATROL_STEPS } from '../src/core/explore.js';
import { sameLocation, isHere } from '../src/core/world.js';
import { DM_RULES } from '../src/core/protocol.js';
import { MANOR_PLAN } from './fixtures/manor-plan.mjs';

const center = rm => ({ floor: rm.floor, x: rm.rect.x + Math.floor(rm.rect.w / 2), y: rm.rect.y + Math.floor(rm.rect.h / 2) });

test('a companion held somewhere else does not see for the party: her room stays unknown to the DM view', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    const start = place.start;
    const startRoom = roomAt(place, start.floor, start.x, start.y);
    // A room on the same floor, as far from the start as possible.
    const far = Object.values(place.rooms).filter(r => r.floor === start.floor && r.id !== startRoom?.id)
        .sort((a, b) => Math.abs(b.rect.x - start.x) + Math.abs(b.rect.y - start.y) - Math.abs(a.rect.x - start.x) - Math.abs(a.rect.y - start.y))[0];
    place.state.positions = { Amber: { floor: start.floor, x: start.x, y: start.y }, 'Judy Hopps': center(far) };
    place.state.waiting = { 'Judy Hopps': true };
    place.state.held = { 'Judy Hopps': 'caged somewhere in the manor' };
    // A guard standing right beside Judy.
    place.guards = { Jailer: { name: 'Jailer', description: 'a jailer', hostile: true, room: far.id, patrol: [far.id], floor: far.floor, x: center(far).x + 1, y: center(far).y, state: 'patrol' } };
    const view = placeView(place, ['Amber', 'Judy Hopps']);
    assert.match(view, /Jailer in .*\((?!.*IN SIGHT)/, 'the jailer beside the held companion is not in sight of the party');
    assert.match(view, /Judy Hopps at/, 'the DM still knows where she is');
});

test('patrols walk their rounds a few squares a turn instead of jumping between rooms', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    place.state.positions = { Amber: { floor: place.start.floor, x: place.start.x, y: place.start.y } };
    const hound = Object.values(place.guards).find(g => g.patrol.length > 1);
    assert.ok(hound, 'the manor has a patrol');
    const startRoom = hound.room;
    let changedRoom = false;
    for (let i = 0; i < 40 && !changedRoom; i++) {
        const before = { x: hound.x, y: hound.y, floor: hound.floor };
        tickGuards(place, () => 0, 1);
        const d = Math.max(Math.abs(hound.x - before.x), Math.abs(hound.y - before.y));
        assert.ok(hound.floor !== before.floor || d <= PATROL_STEPS, `one tick moves at most ${PATROL_STEPS} squares (moved ${d})`);
        const rm = roomAt(place, hound.floor, hound.x, hound.y);
        if (rm && rm.id !== startRoom) changedRoom = true;
    }
    assert.ok(changedRoom, 'walking eventually reaches the next room of the patrol');
    assert.ok(hound.patrol.includes(hound.room), 'the room they stand in is on their patrol');
    // Nothing teleports: every tick's square is inside the floor and walkable.
    const map = floorById(place, hound.floor).map;
    assert.ok(hound.x >= 0 && hound.x < map.w && hound.y >= 0 && hound.y < map.h);
});

test('location names match loosely, so a room name inside a place does not make NPCs vanish', () => {
    assert.ok(sameLocation('Blackmoor Prison', 'Blackmoor Prison, cell block'));
    assert.ok(sameLocation('the Cell Block', 'cell block'));
    assert.ok(!sameLocation('Blackmoor Prison', 'Hollowbrook'));
    assert.ok(!sameLocation('', 'Hollowbrook'));
    assert.ok(isHere({ name: 'Brask', lastSeen: 'Blackmoor Prison' }, 'Blackmoor Prison, cell block'));
    assert.ok(!isHere({ name: 'Brask', lastSeen: 'Blackmoor Prison', dead: true }, 'Blackmoor Prison'));
    assert.ok(isHere({ name: 'Brask', lastSeen: 'anywhere' }, ''), 'no location known: everyone counts');
    assert.match(DM_RULES, /"scene\.location" is the place itself/);
    assert.match(DM_RULES, /"positions" never moves the player/);
});
