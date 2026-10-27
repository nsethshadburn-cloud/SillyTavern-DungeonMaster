// Run with: node --test tests/
// v0.15: little animated map figures.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSprite, normalizeLook, libraryLook, lookForNpc, presetFor, LIBRARY, SPECIES, SIZE, ANIM_TIMING, SPRITE_INSTRUCTIONS } from '../src/core/sprites.js';

const pixels = frame => frame.reduce((n, c) => n + (c ? 1 : 0), 0);

test('every library figure builds every animation, in bounds and not empty', () => {
    for (const key of Object.keys(LIBRARY)) {
        for (const v of [0, 1, 4]) {
            const s = buildSprite(libraryLook(key, v));
            assert.deepEqual(Object.keys(s.anims).sort(), ['attack', 'down', 'hurt', 'idle', 'walk'].sort(), key);
            assert.equal(s.anims.idle.length, 4);
            assert.equal(s.anims.walk.length, 4);
            assert.equal(s.anims.attack.length, 3);
            for (const [name, frames] of Object.entries(s.anims)) {
                for (const f of frames) {
                    assert.equal(f.length, SIZE * SIZE);
                    assert.ok(pixels(f) > 40, `${key} ${name} has a body`);
                    assert.ok(Math.max(...f) < s.palette.length && f.every(c => !c || s.palette[c]), `${key} ${name}: every pixel has a color`);
                }
            }
            assert.ok(ANIM_TIMING.idle.loop && !ANIM_TIMING.attack.loop);
        }
    }
});

test('walking and attacking really move; a blink changes the face', () => {
    const s = buildSprite(normalizeLook({ species: 'rabbit', weapon: 'sword', outfit: 'leather' }));
    const differ = (a, b) => a.some((c, i) => c !== b[i]);
    assert.ok(differ(s.anims.walk[0], s.anims.walk[2]), 'legs swap');
    assert.ok(differ(s.anims.attack[0], s.anims.attack[1]), 'the sword swings');
    assert.ok(differ(s.anims.idle[0], s.anims.idle[3]), 'blink');
    assert.ok(differ(s.anims.idle[0], s.anims.down[0]), 'lying down');
});

test("Claude's description is cleaned up; anything unknown falls back sensibly", () => {
    const look = normalizeLook({ species: 'Rabbit', build: 'tiny', skin: '#9AA0A8', hair: 'dreadlocks', outfit: 'leather', weapon: 'lightsaber', head: 'helmet', eyes: 'purple' });
    assert.equal(look.species, 'rabbit');
    assert.equal(look.build, 'medium');
    assert.equal(look.skin, '#9aa0a8');
    assert.equal(look.hair, 'none', 'furry folk have no hair by default');
    assert.equal(look.weapon, 'none');
    assert.equal(look.head, 'helmet');
    assert.match(look.eyes, /^#[0-9a-f]{6}$/);
    assert.equal(normalizeLook({ species: 'dragon' }).species, 'human');
    assert.equal(normalizeLook(null).species, 'human');
    for (const sp of Object.keys(SPECIES)) assert.ok(SPRITE_INSTRUCTIONS.includes(sp));
    assert.match(SPRITE_INSTRUCTIONS, /not try to reproduce a specific copyrighted design/i);
});

test('NPCs get a fitting library figure, the same look every time, and look different from each other', () => {
    assert.equal(presetFor('The Hound, a huge mastiff'), 'hound');
    assert.equal(presetFor('Graves the Butler'), 'human_butler');
    assert.equal(presetFor('Captain Marek Dray'), 'human_knight');
    assert.equal(presetFor('Old Martha, the cook'), 'human_servant');
    assert.equal(presetFor('a harengon smuggler'), 'rabbitfolk');
    assert.equal(presetFor('Giant spider'), 'giant_spider');
    assert.equal(presetFor('Bandit 2'), 'human_bandit');
    assert.equal(presetFor('wolf'), 'wolf');
    assert.equal(presetFor('somebody'), 'human_peasant');
    assert.deepEqual(lookForNpc('Guard Hal', 'a watch guard'), lookForNpc('Guard Hal', 'a watch guard'), 'stable');
    const guards = ['Guard 1', 'Guard 2', 'Guard 3', 'Guard 4'].map(n => JSON.stringify(lookForNpc(n, 'guard')));
    assert.ok(new Set(guards).size >= 2, 'several guards on one map are not all identical');
    assert.equal(lookForNpc('Anyone', '', 'giant_spider').beast, 'spider', 'the DM\'s pick wins');
});
