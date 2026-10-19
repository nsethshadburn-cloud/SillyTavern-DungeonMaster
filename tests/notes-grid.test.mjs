// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TEMPLATES, renderTemplate, lengthText, pronounsFor } from '../src/core/notes.js';
import { normalizeMap, parseCoord, toCoord, applyPositions, placeMissing, renderMapText, distance, isWalkable } from '../src/core/grid.js';

test('templates drop lines whose fields are empty and keep the closing bracket', () => {
    const full = renderTemplate(DEFAULT_TEMPLATES.scene, { player: 'Amber', location: 'the crossroads', present: 'Odel Finch', situation: 'Riders watch from the ridge.', goal: 'Get away' });
    assert.match(full, /Where: the crossroads/);
    assert.match(full, /Also here: Odel Finch/);
    assert.ok(full.endsWith('Goal: Get away]'));
    const sparse = renderTemplate(DEFAULT_TEMPLATES.scene, { player: 'Amber' });
    assert.doesNotMatch(sparse, /Where:|Also here:|Right now:|Goal:/);
    assert.ok(sparse.startsWith('[') && sparse.endsWith(']'), 'brackets stay balanced');
    assert.match(sparse, /\{\{char\}\}/, 'SillyTavern macros are left for SillyTavern');
    const brief = renderTemplate(DEFAULT_TEMPLATES.brief, { brief: 'The riders are closing in. She wants Amber to surrender.', length: lengthText('short') });
    assert.match(brief, /one short sentence/);
    assert.equal(lengthText('weird'), lengthText('normal'));
    assert.equal(pronounsFor('male'), 'he/him');
    const npc = renderTemplate(DEFAULT_TEMPLATES.npc, { npc: 'Brannoc', description: 'A gruff innkeeper.', pronouns: '', attitude: 'wary', player: 'Amber', party: 'Judy Hopps' });
    assert.doesNotMatch(npc, /uses\s+pronouns/, 'empty pronoun line removed');
});

test('grid coordinates, terrain and positions', () => {
    const map = normalizeMap({ width: 6, height: 4, rows: ['..##..', '......', '~~T...', '......'] });
    assert.equal(map.w, 6);
    assert.equal(map.rows.length, 4);
    assert.deepEqual(parseCoord('a1', map), { x: 0, y: 0 });
    assert.deepEqual(parseCoord('D4', map), { x: 3, y: 3 });
    assert.equal(parseCoord('g1', map), null, 'off the map');
    assert.equal(toCoord(2, 1), 'c2');
    assert.equal(isWalkable(map, 2, 3), false, 'c4 is a wall (top row)');
    assert.equal(isWalkable(map, 2, 1), false, 'c2 is cover');
    const { positions, rejected } = applyPositions(map, {}, { Judy: 'b1', Bandit: 'c4', Wolf: 'z9', Amber: 'a2' });
    assert.deepEqual(positions, { Judy: 'b1', Amber: 'a2' });
    assert.equal(rejected.length, 2);
    const placed = placeMissing(map, positions, ['Rowan'], 'party');
    assert.ok(placed.Rowan && placed.Rowan.endsWith('1'));
    const enemies = placeMissing(map, placed, ['Bandit'], 'enemy');
    assert.match(enemies.Bandit, /4$/);
    assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 2 }), 3);
    const text = renderMapText(map, enemies);
    assert.match(text, /Positions: .*Judy b1/);
    assert.ok(text.split('\n')[1].startsWith(' 4'), 'top row is the highest number');
    const big = normalizeMap({ width: 99, height: 1, rows: [] });
    assert.equal(big.w, 16);
    assert.equal(big.h, 4);
});
