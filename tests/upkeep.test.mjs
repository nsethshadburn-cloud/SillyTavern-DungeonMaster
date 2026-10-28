// Run with: node --test tests/
// v0.26: conditions that wear off, rests, spell slots and abilities, death saves, and a stricter
// map sync that also tracks items.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCondition, untilFrom, expireConditions, maxSlots, classInfo, spend, resourcesLine, takeRest, deathSave, hurtWhileDown, dying, untilWords } from '../src/core/upkeep.js';
import { applyStateChanges, changeHp } from '../src/core/world.js';
import { parseMapSync, mapSyncPrompt } from '../src/core/mapsync.js';
import { normalizeDmTurn } from '../src/core/protocol.js';

const party = () => ({ party: { Amber: { hp: 20, hp_max: 30, conditions: [] }, 'Judy Hopps': { hp: 12, hp_max: 24, conditions: [] } } });

test('conditions wear off: the DM\'s duration, or a sensible default', () => {
    assert.deepEqual(parseCondition('poisoned (1 hour)'), { name: 'poisoned', until: { turns: 6 } });
    assert.deepEqual(parseCondition('frightened (until the end of the fight)'), { name: 'frightened', until: { combat: true } });
    assert.deepEqual(parseCondition('restrained (rope)'), { name: 'restrained (rope)', until: null }, 'a kind of restraint, not a duration');
    assert.deepEqual(untilFrom('until a long rest'), { rest: 'long' });
    assert.deepEqual(untilFrom('2 rounds'), { rounds: 2 });
    const w = party();
    applyStateChanges(w, { conditions_add: { Amber: ['poisoned (1 hour)', 'groggy'], 'Judy Hopps': ['tied up'] } }, ['Amber', 'Judy Hopps'], { turn: 10 });
    assert.deepEqual(w.party.Amber.conditions, ['poisoned', 'groggy'], 'stored without the brackets');
    assert.match(untilWords(w, 'Amber', 'poisoned', { turn: 12 }), /4 more turns/);
    assert.match(untilWords(w, 'Amber', 'groggy', { turn: 12 }), /long rest/, 'lingering ones default to a long rest');
    assert.equal(untilWords(w, 'Judy Hopps', 'tied up', { turn: 12 }), '', 'tied up lasts until the story ends it');
    assert.deepEqual(expireConditions(w, { turn: 15 }), []);
    assert.deepEqual(expireConditions(w, { turn: 16 }), ['Amber is no longer poisoned']);
    assert.deepEqual(w.party.Amber.conditions, ['groggy']);
    w.combat = { round: 3, enemies: {} };
    applyStateChanges(w, { conditions_add: { 'Judy Hopps': ['frightened'], Amber: ['stunned (1 round)'] } }, ['Amber', 'Judy Hopps'], { turn: 16 });
    assert.deepEqual(expireConditions(w, { round: 4 }), ['Amber is no longer stunned']);
    assert.deepEqual(expireConditions(w, { combatOver: true }), ['Judy Hopps is no longer frightened'], 'frightened ends with the fight');
    applyStateChanges(w, { conditions_remove: { Amber: ['groggy'] } }, ['Amber'], { turn: 17 });
    assert.deepEqual(expireConditions(w, { rest: 'long' }), [], 'removed by hand: nothing left to expire');
});

test('spell slots, hit dice and limited abilities: counted, refused when gone, back after rests', () => {
    assert.deepEqual(maxSlots({ class: 'Wizard', level: 5 }), { 1: 4, 2: 3, 3: 2 });
    assert.deepEqual(maxSlots({ class: 'Paladin', level: 5 }), { 1: 4, 2: 2 });
    assert.deepEqual(maxSlots({ class: 'Warlock', level: 5 }), { 3: 2 }, 'pact slots');
    assert.deepEqual(maxSlots({ class: 'Fighter', level: 9 }), {});
    assert.equal(classInfo({ class: 'Barbarian', level: 3 }).hitDie, 12);
    const w = party();
    const wiz = { class: 'Wizard', level: 5, abilities: { CON: 14 } };
    const r = spend(w, 'Amber', ['slot 3', '3rd-level slot', 'level 3 spell', 'Arcane Recovery'], wiz);
    assert.equal(r.log.length, 3);
    assert.deepEqual(r.refused, ['Amber has no level 3 slots left']);
    assert.equal(spend(w, 'Amber', ['Arcane Recovery'], wiz).refused.length, 1, 'used once until a rest');
    assert.match(resourcesLine(w, 'Amber', wiz), /3rd 0\/2/);
    const lock = { class: 'Warlock', level: 5 };
    assert.match(spend(w, 'Judy Hopps', ['slot 1'], lock).log[0], /level 3 slot/, 'a warlock casts with pact slots');
    // A short rest: short-rest abilities and pact slots back, hit dice spent on the hurt.
    w.party.Amber.hp = 8;
    const short = takeRest(w, 'short', ['Amber', 'Judy Hopps'], n => (n === 'Amber' ? wiz : lock), () => ({ total: 6 }));
    assert.ok(w.party.Amber.hp > 8, 'healed with hit dice');
    assert.ok(short.some(l => /hit dice/.test(l)));
    assert.equal(w.resources['Judy Hopps'].slots[3] ?? 0, 0, 'pact slots back');
    assert.ok(!w.resources.Amber.used['Arcane Recovery'], 'Arcane Recovery comes back on a short rest');
    assert.match(resourcesLine(w, 'Amber', wiz), /3rd 0\/2/, 'wizard slots wait for a long rest');
    takeRest(w, 'long', ['Amber', 'Judy Hopps'], n => (n === 'Amber' ? wiz : lock), () => ({ total: 6 }));
    assert.equal(w.party.Amber.hp, 30);
    assert.match(resourcesLine(w, 'Amber', wiz), /3rd 2\/2/);
});

test('dying: death saves, hits while down, a natural 20, stable, dead', () => {
    const w = party();
    changeHp(w, 'Judy Hopps', -12, ['Judy Hopps']);
    assert.deepEqual(dying(w), ['Judy Hopps']);
    assert.match(deathSave(w, 'Judy Hopps', 12).line, /1 success, 0 failures/);
    assert.match(changeHp(w, 'Judy Hopps', -3, ['Judy Hopps']), /1 failed death save/);
    assert.match(changeHp(w, 'Judy Hopps', -3, ['Judy Hopps'], { critical: true }), /has died/, 'a critical while down is two failures');
    assert.ok(w.party['Judy Hopps'].conditions.includes('dead'));
    assert.deepEqual(dying(w), [], 'the dead don\'t roll');
    const v = party();
    changeHp(v, 'Amber', -20, ['Amber']);
    assert.equal(deathSave(v, 'Amber', 20).result, 'revived');
    assert.equal(v.party.Amber.hp, 1);
    changeHp(v, 'Amber', -1, ['Amber']);
    for (const n of [10, 15]) deathSave(v, 'Amber', n);
    assert.equal(deathSave(v, 'Amber', 11).result, 'stable');
    assert.ok(v.party.Amber.conditions.includes('stable'));
    changeHp(v, 'Amber', 5, ['Amber']);
    assert.ok(!v.party.Amber.conditions.includes('stable') && !v.party.Amber.death, 'healed: it\'s over');
    const m = party();
    assert.match(changeHp(m, 'Judy Hopps', -40, ['Judy Hopps']), /has died/, 'massive damage kills outright');
    assert.equal(hurtWhileDown(party(), 'Amber', 3), '', 'not down: nothing');
});

test('the DM\'s rest and spending come through', () => {
    const t = normalizeDmTurn({ rest: 'Long', state_changes: { spend: { 'Judy Hopps': ['slot 1'] } } });
    assert.equal(t.rest, 'long');
    assert.deepEqual(t.state_changes.spend, { 'Judy Hopps': ['slot 1'] });
    assert.equal(normalizeDmTurn({ rest: 'nap' }).rest, null);
});

test('map sync: only what the story says, the same creature isn\'t added twice, items picked up and put down', () => {
    const known = { party: ['Amber', 'Judy Hopps'], people: ['Guard Dog', 'Guard 1'], peopleInfo: { 'Guard Dog': 'a snarling mastiff', 'Guard 1': 'a guard' }, things: ['p4'], doors: [], rooms: [], items: ['I3'], carried: { Amber: ['coil of rope'] } };
    const story = 'The hound lunges at Judy. Somewhere above, footsteps. A second guard storms in. Amber picks up the ledger and drops her coil of rope.';
    const ops = parseMapSync(JSON.stringify({ changes: [
        { op: 'spawn', name: 'The Hound', what: 'a big dog', intent: 'attack', target: 'Judy' },
        { op: 'spawn', name: 'Guard 2', what: 'a guard' },
        { op: 'spawn', name: 'Ogre', what: 'an ogre upstairs' },
        { op: 'take', who: 'Amber', item: 'I3' },
        { op: 'drop', who: 'Amber', item: 'rope' },
        { op: 'drop', who: 'Amber', item: 'sword she never had' },
        { op: 'found', item: 'I9' },
    ] }), known, { story });
    assert.deepEqual(ops.find(o => o.who === 'Guard Dog'), { op: 'intent', who: 'Guard Dog', intent: 'attack', target: 'Judy Hopps' }, '"the hound" is the Guard Dog');
    assert.ok(ops.some(o => o.op === 'spawn' && o.name === 'Guard 2'), 'a second guard is a second guard');
    assert.ok(!ops.some(o => o.name === 'Ogre'), 'the story never mentions an ogre');
    assert.deepEqual(ops.find(o => o.op === 'take'), { op: 'take', who: 'Amber', id: 'I3' });
    assert.deepEqual(ops.filter(o => o.op === 'drop'), [{ op: 'drop', who: 'Amber', item: 'coil of rope' }], 'only what she carries');
    assert.ok(!ops.some(o => o.op === 'found'), 'only items that are here');
    const { user } = mapSyncPrompt({ party: [], people: [], things: [], rooms: [], items: [{ id: 'I3', name: 'ledger', room: 'Study', hidden: true }], carried: { Amber: ['rope'] }, story: 'x' });
    assert.match(user, /I3 = ledger \(hidden, not found yet\), Study/);
    assert.match(user, /only heard or sensed/);
});
