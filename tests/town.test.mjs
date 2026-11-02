// v0.69: a town has the story's places; a place or a thing named as a person is refused; dice
// formulas are merged for the card and a notation is never a typed result; coin changes hands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, townFromBrief } from '../src/core/architect.js';
import { looksLikePlace, looksLikeThing } from '../src/core/explore.js';
import { normalizeNotation, parsePlayerRoll } from '../src/core/dice.js';
import { parseBookkeeping, bookkeeperPrompt } from '../src/core/bookkeeper.js';
import { BIBLE_INSTRUCTIONS } from '../src/core/protocol.js';

test('a town has the story\'s named places, by name, with the story\'s person inside', () => {
    const brief = normalizeBrief({
        name: 'Marrow Ford', kind: 'town', size: 'small', summary: 'A river town. Olwen Tusk fences stolen goods from her locksmith shop; her bruisers drink at the Drowned Eel.',
        rooms: [{ room: 'The Drowned Eel inn', note: 'sailors and smugglers' }, { room: "Olwen Tusk's locksmith shop", has: ['the ledger'], note: 'a locked back room' }],
        people: [{ name: 'Olwen Tusk', what: 'a fence who runs a locksmith shop', where: "Olwen Tusk's locksmith shop" }, { name: 'Hob', what: 'a bruiser', where: 'outside the Drowned Eel', hostile: true }],
    }, {});
    for (let seed = 1; seed <= 4; seed++) {
        const plan = townFromBrief(brief, seed);
        const names = plan.buildings.map(b => b.name);
        const eel = plan.buildings.find(b => /drowned eel/i.test(b.name));
        const shop = plan.buildings.find(b => /tusk/i.test(b.name));
        assert.ok(eel, `seed ${seed}: the inn: ${names.join(', ')}`);
        assert.equal(eel.kind, 'inn');
        assert.ok(shop, `seed ${seed}: the shop: ${names.join(', ')}`);
        assert.equal(shop.kind, 'smithy');
        assert.equal(shop.keeper, 'Olwen Tusk');
        assert.equal(plan.buildings.filter(b => b.kind === 'inn').length, 1, 'no second inn by chance');
        assert.ok(!names.some(n => /^Hob's House$/.test(n)), 'a bruiser outside the inn has no house');
        assert.ok(!names.some(n => /^Olwen Tusk's House$/.test(n)), 'the keeper of the shop has no second house');
    }
});

test('a place or a thing named as a person is refused', () => {
    for (const n of ["Olwen Tusk's Locksmith Shop", 'Eel Street', 'The Gilded Lantern inn']) assert.ok(looksLikePlace(n), n);
    const town = { name: 'Marrow Ford', buildings: { B1: { name: 'The Drowned Eel' } }, rooms: {} };
    assert.ok(looksLikePlace('The Drowned Eel', town), 'a building of the place by that name');
    assert.ok(!looksLikePlace('The Drowned Eel'), 'with no place to check, a plain name is a name');
    for (const n of ['Hob', 'Olwen Tusk', 'Innkeeper Bram', 'Gate Watch Soldier', 'a grey parrot']) assert.ok(!looksLikePlace(n), n);
    assert.ok(looksLikeThing('Silver Candlesticks'));
});

test('a damage formula is merged for the card; a dice notation typed is never a result', () => {
    assert.equal(normalizeNotation('1d6+5+3d6+6'), '4d6+11');
    assert.equal(normalizeNotation('1d8 +3 slashing'), '1d8+3');
    assert.equal(normalizeNotation('2d6 + 1d4 - 1'), '2d6+1d4-1');
    assert.equal(normalizeNotation('no dice here'), '');
    assert.equal(parsePlayerRoll('a/roll 4d6+11', 100), null);
    assert.equal(parsePlayerRoll('/roll 1d20', 20), null);
    assert.deepEqual(parsePlayerRoll('17', 20), { natural: 17, total: null });
    assert.equal(parsePlayerRoll('rolled 4d6+11 for a total of 23', 100)?.total, 23, 'said as a result, with the total named, it counts');
});

test('coin changes hands: the bookkeeper\'s gold, only when the story has coin in it', () => {
    const known = { names: ['Amber', 'Olwen Tusk'], itemNames: ['Amber'], conditionsOf: () => [], itemsOf: () => [], allItems: [] };
    assert.deepEqual(parseBookkeeping('{"items_add": {"Amber": ["hooded lantern"]}, "gold": -0.5}', { ...known, story: 'Amber pays five silver and takes the hooded lantern.' }), { items_add: { Amber: ['hooded lantern'] }, gold: -0.5 });
    assert.equal(parseBookkeeping('{"gold": -3}', { ...known, story: 'Amber looks at the lantern and leaves.' }), null, 'no coin in the story, no change');
    assert.equal(parseBookkeeping('{"gold": 9000}', { ...known, story: 'Amber pays for the room.' }), null, 'a fortune from a mention is no change');
    assert.match(bookkeeperPrompt({ status: [], story: 'x' }).user, /"gold": 0/);
    assert.match(BIBLE_INSTRUCTIONS, /"start": \{"gold"/);
});
