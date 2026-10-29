// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TEMPLATES, renderTemplate, lengthText, pronounsFor, fitNote, noteBudget, DEFAULT_NOTE_TOKENS, MIN_NOTE_TOKENS } from '../src/core/notes.js';
import { estimateTokens } from '../src/core/text.js';
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
    assert.equal(positions.Judy, 'b1');
    assert.equal(positions.Amber, 'a2');
    assert.ok(positions.Bandit && positions.Bandit !== 'c4' && isWalkable(map, parseCoord(positions.Bandit, map).x, parseCoord(positions.Bandit, map).y), 'a square in a wall becomes the nearest open one');
    assert.deepEqual(rejected, ['Wolf→z9'], 'only squares off the map are dropped');
    delete positions.Bandit;
    const placed = placeMissing(map, positions, ['Rowan'], 'party');
    assert.ok(placed.Rowan && placed.Rowan.endsWith('1'));
    const enemies = placeMissing(map, placed, ['Bandit'], 'enemy');
    assert.match(enemies.Bandit, /4$/);
    assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 2 }), 3);
    const text = renderMapText(map, enemies);
    assert.match(text, /Positions: .*Judy b1/);
    assert.ok(text.split('\n')[2].startsWith(' 4'), 'top row is the highest number (after the theme and column lines)');
    const big = normalizeMap({ width: 99, height: 1, rows: [] });
    assert.equal(big.w, 16);
    assert.equal(big.h, 4);
});

test('textured maps: themes, props that block, map text for Claude', async () => {
    const { normalizeMap, isWalkable, renderMapText, propAt, THEMES, PROPS } = await import('../src/core/grid.js');
    const map = normalizeMap({ theme: 'crypt', width: 5, height: 4, rows: ['#####', '#._,#', '#.L.#', '#####'], props: [{ at: 'b2', type: 'altar', label: 'black altar' }, { at: 'c3', type: 'rug' }, { at: 'z9', type: 'chest' }, { at: 'd2', type: 'spaceship' }] });
    assert.equal(map.theme, 'crypt');
    assert.equal(map.props.length, 2, 'off-map and unknown props are dropped');
    assert.equal(propAt(map, 1, 1).label, 'black altar');
    assert.equal(isWalkable(map, 1, 1), false, 'an altar blocks the square');
    assert.equal(isWalkable(map, 2, 2), true, 'a rug does not block');
    assert.equal(isWalkable(map, 2, 1), false, 'c2 is lava');
    assert.equal(normalizeMap({ theme: 'moonbase', rows: ['....'] }).theme, 'dungeon', 'unknown theme falls back');
    const text = renderMapText(map, {});
    assert.match(text, /^Theme: crypt/);
    assert.match(text, /Props: altar \(black altar\) b2, rug c3/);
    assert.ok(THEMES.includes('tavern') && PROPS.brazier.light > 0);
    assert.ok(Number.isFinite(map.seed));
});

test('the note is sized to the setting and the live context; the brief always arrives whole', () => {
    // The setting wins when the context is roomy; a small context caps it; nothing goes below the floor.
    assert.equal(noteBudget({ injectionMaxTokens: 600 }, { maxContext: 16384, responseLength: 2048 }), 600);
    assert.equal(noteBudget({}, { maxContext: 16384, responseLength: 2048 }), DEFAULT_NOTE_TOKENS);
    assert.equal(noteBudget({ injectionMaxTokens: 600 }, { maxContext: 2048, responseLength: 512 }), 256);
    assert.equal(noteBudget({ injectionMaxTokens: 600 }, { maxContext: 600, responseLength: 512 }), MIN_NOTE_TOKENS);
    assert.equal(noteBudget({ injectionMaxTokens: 400 }, {}), 400, 'no context known: the setting alone');

    const long = n => '[' + 'word '.repeat(n).trim() + ']';
    const parts = [
        { key: 'scene', text: long(60) },
        { key: 'state', text: long(120) },
        { key: 'happened', text: '[Just happened: the bolt is out.]' },
        { key: 'knowledge', text: long(300) },
        { key: 'room', text: long(80) },
        { key: 'avoid', text: long(30) },
        { key: 'brief', text: '[Game master\'s note: she wants Amber to give up.]' },
    ];
    const whole = fitNote(parts, 100000);
    assert.equal(whole.length, parts.length, 'plenty of room: nothing changes');
    const budget = 350;
    const fitted = fitNote(parts, budget);
    assert.ok(estimateTokens(fitted.join('\n')) <= budget + 5, 'within the budget');
    assert.ok(fitted.includes(parts[6].text), 'the brief is untouched');
    assert.ok(fitted.includes(parts[2].text), '"happened" is untouched');
    assert.ok(!fitted.some(t => t === parts[5].text), 'the repeated-phrases line goes first');
    const knowledge = fitted.find(t => t.startsWith('[word') && t.endsWith('…]'));
    assert.ok(knowledge, 'a shortened part still closes its bracket');
    assert.ok(fitted.some(t => t === parts[0].text), 'the scene note is cut last');
});
