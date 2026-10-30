// v0.35.2: a companion locked up where the player hasn't been is not "the party". Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { placeView, placePerson, setIntent } from '../src/core/explore.js';
import { DEFAULT_TEMPLATES, OLD_DEFAULTS } from '../src/core/notes.js';

function prison() {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push('.........');
    return {
        name: 'The Hole', kind: 'prison', fog: true, floors: [{ id: 'F0', name: 'Ground', level: 0, map: { w: 9, h: 5, rows, theme: 'dungeon', props: [], version: 0 } }],
        rooms: { H: { id: 'H', name: 'Hallway', type: 'hallway', floor: 'F0', rect: { x: 0, y: 0, w: 5, h: 5 }, lit: true }, C4: { id: 'C4', name: 'Cell 4', type: 'cell', floor: 'F0', rect: { x: 6, y: 0, w: 3, h: 5 }, lit: true } },
        doors: {}, traps: {}, items: {}, exits: [], stairs: [], buildings: {}, windows: {}, guards: {},
        state: { positions: { Amber: { floor: 'F0', x: 1, y: 1 }, 'Judy Hopps': { floor: 'F0', x: 7, y: 2 } }, explored: {}, visited: ['H'], floor: 'F0', waiting: { 'Judy Hopps': true }, held: { 'Judy Hopps': 'locked in a cell (on the map: Cell 4, C4)' } },
    };
}

test('the DM is told a locked-up companion the player has not reached is NOT with the party', () => {
    const text = placeView(prison(), ['Amber', 'Judy Hopps'], { away: ['Judy Hopps'] });
    assert.match(text, /Party now[^\n]*Amber at b2/);
    assert.doesNotMatch(text, /Party now[^\n]*Judy/, 'not listed as the party');
    assert.match(text, /NOT with the player[^\n]*Judy Hopps at h3[^\n]*Cell 4/);
    assert.doesNotMatch(text, /chose not to follow[^\n]*Judy/, 'she did not choose anything');
});

test('once the player is with her at the cell she is party again, marked as locked up', () => {
    const text = placeView(prison(), ['Amber', 'Judy Hopps'], { away: [] });
    assert.match(text, /Party now[^\n]*Judy Hopps at h3[^\n]*LOCKED UP here/);
    assert.doesNotMatch(text, /NOT with the player/);
});

test('a guard set on the party remembers he was no enemy before; a monster was', () => {
    const place = prison();
    const jailer = placePerson(place, 'Jailer 3', { floor: 'F0', x: 3, y: 3 }, { info: { hostile: false, role: 'guard' } });
    const beast = placePerson(place, 'Rat Swarm', { floor: 'F0', x: 4, y: 4 }, { info: { hostile: true } });
    setIntent(jailer, 'attack', 'Amber');
    setIntent(beast, 'attack');
    assert.equal(jailer.hostile, true, 'he is coming for the party now');
    assert.equal(jailer.wasHostile, false, 'but the fight ending puts him back to a guard doing his job');
    assert.equal(beast.wasHostile, true);
    setIntent(jailer, 'stay');
    setIntent(jailer, 'attack');
    assert.equal(jailer.wasHostile, false, 'a second order does not rewrite the first memory');
});

test('the notes ask for English and keep results with the game master; old defaults move on', () => {
    assert.match(DEFAULT_TEMPLATES.scene, /plain English/);
    assert.match(DEFAULT_TEMPLATES.npc, /plain English/);
    assert.match(DEFAULT_TEMPLATES.npc, /result of any action/);
    assert.notEqual(OLD_DEFAULTS.sceneV31, DEFAULT_TEMPLATES.scene);
    assert.notEqual(OLD_DEFAULTS.npcV31, DEFAULT_TEMPLATES.npc);
    assert.doesNotMatch(OLD_DEFAULTS.sceneV31, /plain English/);
});
