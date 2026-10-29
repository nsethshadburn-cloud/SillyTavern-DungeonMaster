// From the "Leash and the Lantern" session (2026-10-29). Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBookkeeping } from '../src/core/bookkeeper.js';
import { attackDamage } from '../src/core/world.js';
import { parseCompanionAction, helperTriagePrompt } from '../src/core/triage.js';
import { parseMapSync } from '../src/core/mapsync.js';
import { cleanDescription } from '../src/core/describe.js';
import { DEFAULT_TEMPLATES, OLD_DEFAULTS, renderTemplate } from '../src/core/notes.js';
import { DM_RULES } from '../src/core/protocol.js';

test('the bookkeeper only changes someone the narration names (no "Odo" when the watchman fell)', () => {
    const known = { names: ['Amber', 'Judy Hopps'], conditionsOf: () => [], itemsOf: () => [], allItems: [] };
    const story = 'Dungeon Master: The watchman folds without a sound and slides down against the bars.';
    assert.equal(parseBookkeeping('{"conditions_add":{"Odo Grist":["unconscious"]}}', { ...known, names: ['Amber', 'Odo Grist'], story }), null, 'Odo is not in the text');
    const judy = parseBookkeeping('{"conditions_add":{"Judy":["unconscious"]}}', { ...known, story: 'Dungeon Master: Judy Hopps crumples and does not get up.' });
    assert.deepEqual(judy, { conditions_add: { 'Judy Hopps': ['unconscious'] } });
    assert.equal(parseBookkeeping('{"conditions_remove":{"Judy":["caged"]}}', { ...known, conditionsOf: () => ['caged'], story: 'Dungeon Master: The candle gutters.' }), null, 'not named: nothing comes off either');
});

test('a damage request with no dice gets them from the sheet, doubled on a natural 20', () => {
    const stats = { attacks: [{ name: 'Dagger', to_hit: 8, damage: '1d4+5' }, { name: 'Shortbow', to_hit: 8, damage: '1d6+5' }] };
    assert.equal(attackDamage(stats, 'Dagger hit on Turnkey Wren'), '1d4+5');
    assert.equal(attackDamage(stats, 'arrow from the shortbow'), '1d6+5');
    assert.equal(attackDamage(stats, 'a hit', { critical: true }), '2d4+5');
    assert.equal(attackDamage(null, 'x'), '');
});

test('"stay" from the classifier counts only when the reply really says so', () => {
    const places = [{ id: 'p1', name: 'the door' }];
    const watching = parseCompanionAction('{"stance":"stay"}', places, "*She stays near the door, ears swiveled down the corridor.* \"Anything useful on there?\"");
    assert.equal(watching.stance, undefined, 'watching the door is not staying behind');
    const staying = parseCompanionAction('{"stance":"stay"}', places, '"You go ahead. I\'ll wait here and watch the stairs."');
    assert.equal(staying.stance, 'stay');
    const follow = parseCompanionAction('{"stance":"follow"}', places, '"Right behind you."');
    assert.equal(follow.stance, 'follow');
    assert.match(helperTriagePrompt({ player: 'Amber', message: 'x', recent: '', speakers: ['Judy Hopps'], scene: '' }).user, /companions usually say nothing/);
});

test('the map sync drops "gone" for someone the story never names', () => {
    const known = { party: ['Amber'], people: ['Watchman', 'Turnkey Nikolai'], things: [], doors: [], rooms: [], items: [] };
    const story = 'Dungeon Master: The watchman folds without a sound.';
    assert.deepEqual(parseMapSync('{"changes":[{"op":"gone","who":"Turnkey Nikolai"}]}', known, { story }), []);
    assert.deepEqual(parseMapSync('{"changes":[{"op":"gone","who":"Watchman"}]}', known, { story }), [{ op: 'gone', who: 'Watchman' }]);
});

test('room descriptions never put people in the room', () => {
    assert.equal(cleanDescription('A lone guard sits at a scarred wooden table. Papers are strewn across the floor.'), 'Papers are strewn across the floor.');
    assert.equal(cleanDescription('A single oil lamp casts flickering light across the empty room.'), 'A single oil lamp casts flickering light across the empty room.');
});

test('the room note lists the rooms a companion knows and forbids inventing the rest', () => {
    const note = renderTemplate(DEFAULT_TEMPLATES.room, { room: 'Warden\'s Office: a cramped office.', things: 'desk, cabinet', exits: 'door to Infirmary', known: 'Cell 14, Upper Cell Block, Infirmary' });
    assert.match(note, /Rooms \{\{char\}\} knows of in this place: Cell 14, Upper Cell Block, Infirmary/);
    assert.match(note, /Never name a room, door, passage, route or item that is not listed above/);
    const bare = renderTemplate(DEFAULT_TEMPLATES.room, { room: 'A passage.', things: '', exits: '', known: '' });
    assert.doesNotMatch(bare, /knows of in this place/, 'an empty list drops its line');
    assert.ok(bare.endsWith(']'));
    assert.notEqual(OLD_DEFAULTS.room, DEFAULT_TEMPLATES.room, 'the old default is kept for migration');
    assert.match(DM_RULES, /Exploring is quiet/);
    assert.match(DM_RULES, /paces or feet, never squares/);
});
