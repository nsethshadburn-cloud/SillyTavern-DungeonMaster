// v0.44: which ambient bed fits where the party is (the sound itself is browser-only). Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { ambientFor, footingFor, AMBIENTS } from '../src/core/ambience.js';

test('the bed follows the floor, the weather, the hour and a fire', () => {
    assert.equal(ambientFor({ theme: 'prison' }), 'dungeon');
    assert.equal(ambientFor({ theme: 'house' }), 'indoor');
    assert.equal(ambientFor({ theme: 'forest' }), 'outdoors');
    assert.equal(ambientFor({ theme: 'forest', night: true }), 'night');
    assert.equal(ambientFor({ theme: 'town', weather: 'rain' }), 'rain');
    assert.equal(ambientFor({ theme: 'camp', weather: 'storm', night: true }), 'storm');
    assert.equal(ambientFor({ theme: 'snow', weather: 'snow' }), 'wind');
    assert.equal(ambientFor({ theme: 'prison', weather: 'storm' }), 'dungeon', 'indoors the storm is not heard');
    assert.equal(ambientFor({ theme: 'house', fire: true }), 'fire');
    assert.equal(ambientFor({ theme: 'dungeon', outdoor: true }), 'outdoors', 'told it is outside: outside');
    for (const k of ['prison', 'house', 'forest', 'town', 'camp', 'snow', 'ship', 'crypt', 'tavern']) assert.ok(AMBIENTS.includes(ambientFor({ theme: k })), k);
});

test('footsteps know the ground', () => {
    assert.equal(footingFor('prison'), 'stone');
    assert.equal(footingFor('forest'), 'soft');
    assert.equal(footingFor('snow'), 'snow');
    assert.equal(footingFor('ship'), 'wood');
    assert.equal(footingFor(''), 'stone');
});
