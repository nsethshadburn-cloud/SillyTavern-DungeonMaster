// Run with: node --test tests/
// v0.19: fire on the map: burn ratings, spreading turn by turn, burning out; spell effects.
import test from 'node:test';
import assert from 'node:assert/strict';

import { burnRating, ignite, tickFire, extinguish, addEffect, tickEffects, fireSummary, fireAt, fireLights, mergeBurn, materialAt } from '../src/core/fire.js';
import { terrainAt, propsAt } from '../src/core/grid.js';

/** A tavern room (planks, timber walls) with hay and a table, next to a stone room. */
function tavern() {
    return {
        w: 12, h: 6, theme: 'tavern', seed: 3,
        rows: [
            '############',
            '#....#.....#',
            '#....+.....#',
            '#....#.....#',
            '#....#.....#',
            '############',
        ],
        areas: [{ x: 6, y: 1, w: 5, h: 4, floor: 'stone', wall: 'brick' }],
        props: [{ id: 'p1', type: 'hay', x: 1, y: 1 }, { id: 'p2', type: 'table', x: 3, y: 3 }, { id: 'p3', type: 'barrel', x: 8, y: 2 }],
    };
}
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('every square has a burn rating: wood and hay burn, stone doesn\'t', () => {
    const map = tavern();
    assert.deepEqual(materialAt(map, 2, 2), { floor: 'planks' });
    assert.ok(burnRating(map, 2, 2).fuel > 0, 'planks burn');
    assert.ok(burnRating(map, 1, 1).catch > 0.9, 'hay catches at once');
    assert.ok(burnRating(map, 1, 1).fuel > burnRating(map, 2, 2).fuel, 'hay on planks: more to burn');
    assert.equal(burnRating(map, 7, 3).fuel, 0, 'a stone floor doesn\'t burn');
    assert.ok(burnRating(map, 8, 2).fuel > 0, '...but a barrel on it does');
    assert.ok(burnRating(map, 0, 2).fuel > 0, 'timber walls burn');
    assert.equal(burnRating(map, 11, 2).fuel, 0, 'brick walls don\'t');
    assert.ok(burnRating(map, 5, 3).fuel > 0, 'a wooden door burns');
});

test('fire spreads turn by turn, burns down, and leaves charred floors and ash', () => {
    const map = tavern();
    assert.equal(ignite(map, 1, 1), 1, 'the hay catches');
    assert.ok(fireAt(map, 1, 1));
    assert.equal(ignite(map, 10, 4), 0, 'a torch on bare stone: nothing to burn');
    assert.equal(ignite(map, 10, 4, { fuel: 2 }), 1, '...unless oil was spilled');
    // Always catches (rng 0): it spreads every turn.
    const r1 = tickFire(map, { rng: () => 0 });
    assert.ok(r1.caught.length >= 3, `spreads to the planks around the hay: ${r1.caught}`);
    for (let i = 0; i < 40; i++) tickFire(map, { rng: () => 0 });
    assert.equal(Object.keys(map.fire).length, 0, 'eventually everything burnt out');
    assert.ok(map.burnt['2,2'] && map.burnt['3,3'], 'the floor is charred');
    assert.ok(!map.burnt['7,3'], 'the stone room never burned (apart from the oil)');
    assert.equal(terrainAt(map, 5, 3), '/', 'the door burned away');
    assert.ok(!map.props.some(p => p.type === 'hay' || p.type === 'table'), 'hay and table are gone');
    assert.ok(map.props.some(p => p.type === 'ash' && p.x === 3 && p.y === 3), 'ash where the table stood');
    assert.equal(burnRating(map, 2, 2).fuel, 0, 'nothing left to burn');
    assert.ok(propsAt(map, 8, 2).some(p => p.type === 'barrel'), 'the barrel across the stone room never caught');
});

test('fire never jumps where it can\'t catch, and a low roll can keep it from spreading', () => {
    const map = tavern();
    ignite(map, 2, 2);
    const r = tickFire(map, { rng: () => 0.99 });
    assert.deepEqual(r.caught, [], 'unlucky for the fire: nothing caught');
    assert.ok(fireAt(map, 2, 2) >= 2, 'it flares up');
    assert.equal(extinguish(map, 2, 2, { radius: 1 }), 1);
    assert.equal(fireAt(map, 2, 2), 0);
    void seq;
});

test('fireball: a burst of fire over an area, only where something burns; summary and light', () => {
    const map = tavern();
    const lit = ignite(map, 3, 2, { radius: 2, heat: 3 });
    assert.ok(lit >= 9, `many squares: ${lit}`);
    assert.equal(map.flashes.at(-1).kind, 'fire');
    const s = fireSummary(map, (x) => (x < 5 ? 'Common room' : 'Cellar'));
    assert.match(s, /FIRE burning on \d+ squares/);
    assert.match(s, /Common room: \d+ \(raging/);
    assert.ok(fireLights(map).every(l => l.rad === 4));
});

test('spell effects last their turns; water puts fire out', () => {
    const map = tavern();
    assert.ok(addEffect(map, 'fog', 3, 2, { radius: 3, turns: 2 }));
    assert.equal(addEffect(map, 'glitter', 3, 2), false, 'unknown types are ignored');
    tickEffects(map);
    assert.equal(map.effects.length, 1);
    tickEffects(map);
    assert.equal(map.effects.length, 0, 'gone after its turns');
    ignite(map, 2, 2, { radius: 1 });
    addEffect(map, 'water', 2, 2, { radius: 2, turns: 1 });
    assert.equal(Object.keys(map.fire).length, 0, 'doused');
    assert.ok(addEffect(map, 'lightning', 4, 4) && map.flashes.at(-1).kind === 'lightning', 'a one-off flash');
});

test('a battle on a copy of the floor: what burned goes back to the floor', () => {
    const floor = tavern();
    const fight = JSON.parse(JSON.stringify(floor));
    ignite(fight, 3, 3);
    for (let i = 0; i < 30; i++) tickFire(fight, { rng: () => 0 });
    mergeBurn(fight, floor);
    assert.ok(floor.burnt['3,3']);
    assert.ok(!floor.props.some(p => p.id === 'p2'), 'the table burned');
    assert.ok(floor.props.some(p => p.type === 'ash'));
    assert.equal(terrainAt(floor, 5, 3), terrainAt(fight, 5, 3));
});

test('the DM\'s map_effects come through the turn parser', async () => {
    const { parseDmTurn } = await import('../src/core/protocol.js');
    const t = parseDmTurn('{"narration": "Boom.", "map_effects": {"fire": [{"at": "c3", "radius": 4}], "ambience": "rain"}}');
    assert.deepEqual(t.map_effects.fire, [{ at: 'c3', radius: 4 }]);
    assert.equal(parseDmTurn('{"narration": "x"}').map_effects, null);
    const { DM_RULES } = await import('../src/core/protocol.js');
    assert.match(DM_RULES, /map_effects/);
    assert.match(DM_RULES, /Fireball is radius 4/);
});
