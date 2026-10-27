// Run with: node --test tests/
// v0.16: tied up, cuffed, caged: what locks movement and what the figure shows.
import test from 'node:test';
import assert from 'node:assert/strict';

import { restraintOf, escapeOptions, lockedLine } from '../src/core/restraints.js';
import { applyStateChanges, conditionsOf, createWorldState } from '../src/core/world.js';
import { buildSprite, normalizeLook } from '../src/core/sprites.js';

test('rope, grabs and cages lock movement; cuffs bind the hands only; shackles stop walking', () => {
    for (const c of ['restrained', 'Restrained (rope)', 'tied up', 'grappled', 'caged', 'shackled', 'unconscious', 'paralyzed']) {
        assert.equal(restraintOf([c]).locked, true, c);
    }
    for (const c of ['cuffed', 'manacled', 'poisoned', 'frightened', 'prone']) {
        assert.equal(restraintOf([c]).locked, false, c);
    }
    assert.equal(restraintOf(['tied up']).bound, 'rope');
    assert.equal(restraintOf(['cuffed']).bound, 'cuffs');
    assert.equal(restraintOf(['shackled']).bound, 'cuffs');
    const both = restraintOf(['caged', 'restrained (rope)']);
    assert.ok(both.caged && both.bound === 'rope', 'tied up inside a cage shows both');
    assert.equal(restraintOf([]).look, null);
    assert.match(lockedLine('Amber', restraintOf(['tied up'])), /Amber is tied up/);
    assert.ok(escapeOptions('Amber', restraintOf(['tied up'])).some(([l]) => /Struggle/.test(l)));
    assert.ok(escapeOptions('Amber', restraintOf(['caged'])).some(([l]) => /lock/i.test(l)));
    assert.ok(escapeOptions('Amber', restraintOf(['cuffed'])).length, 'cuffs can be slipped even though you can walk');
    assert.equal(escapeOptions('Amber', restraintOf(['poisoned'])).length, 0);
});

test('anyone can be tied up: party, enemies, and NPCs outside a fight', () => {
    const w = createWorldState();
    w.party.Amber = { hp: 10, hp_max: 10, conditions: [] };
    applyStateChanges(w, { conditions_add: { Amber: ['restrained (rope)'], 'Bandit Captain': ['cuffed'] } });
    assert.deepEqual(conditionsOf(w, 'Amber'), ['restrained (rope)']);
    assert.deepEqual(conditionsOf(w, 'Bandit Captain'), ['cuffed'], 'an NPC outside a fight keeps conditions too');
    applyStateChanges(w, { conditions_remove: { Amber: ['restrained (rope)'] } });
    assert.equal(restraintOf(conditionsOf(w, 'Amber')).locked, false, 'free again');
    assert.deepEqual(conditionsOf(w, 'Nobody'), []);
});

test('tied-up and cuffed figures look different, squirm, and carry no weapon', () => {
    const base = { species: 'human', outfit: 'tunic', weapon: 'sword' };
    const free = buildSprite(normalizeLook(base)).anims;
    const tied = buildSprite(normalizeLook({ ...base, bound: 'rope' })).anims;
    const cuffed = buildSprite(normalizeLook({ ...base, bound: 'cuffs' })).anims;
    const differ = (a, b) => a.some((c, i) => c !== b[i]);
    assert.ok(differ(free.idle[0], tied.idle[0]), 'rope shows');
    assert.ok(differ(free.idle[0], cuffed.idle[0]), 'cuffs show');
    assert.ok(differ(tied.idle[0], tied.idle[1]), 'tied up, they squirm');
    assert.equal(normalizeLook({ bound: 'chains' }).bound, undefined, 'unknown restraints are dropped');
    assert.equal(normalizeLook({ bound: 'rope' }).bound, 'rope');
});
