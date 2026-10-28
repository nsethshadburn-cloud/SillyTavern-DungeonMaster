// Run with: node --test tests/
// v0.20.1: the bookkeeper: what the story says happened, checked before it touches the books.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bookkeeperPrompt, parseBookkeeping, conditionWord } from '../src/core/bookkeeper.js';
import { applyStateChanges, conditionsOf, createWorldState } from '../src/core/world.js';

function books() {
    const w = createWorldState();
    w.party.Amber = { hp: 10, hp_max: 20, conditions: [] };
    w.party['Judy Hopps'] = { hp: 2, hp_max: 18, conditions: ['poisoned'] };
    w.inventory = { 'Judy Hopps': ['silver key'], Amber: [] };
    w.items = ['rope'];
    const known = {
        names: ['Amber', 'Judy Hopps', 'Warden Pike'],
        itemNames: ['Amber', 'Judy Hopps'],
        conditionsOf: n => conditionsOf(w, n),
        itemsOf: n => [...(w.inventory[n] ?? []), ...w.items],
        allItems: [...w.items, ...Object.values(w.inventory).flat()],
    };
    return { w, known };
}

test('condition words: the story\'s phrasing becomes a known condition, anything else is dropped', () => {
    assert.equal(conditionWord('passed out'), 'unconscious');
    assert.equal(conditionWord("too injured to walk"), "can't walk");
    assert.equal(conditionWord('tied up'), 'restrained (rope)');
    assert.equal(conditionWord('sad'), null);
    const { user } = bookkeeperPrompt({ status: [{ name: 'Judy Hopps', hp: '2/18', conditions: ['poisoned'], items: ['silver key'] }], shared: ['rope'], others: ['Warden Pike'], story: 'Judy collapses.' });
    assert.match(user, /Judy Hopps: HP 2\/18; conditions: poisoned; carries: silver key/);
    assert.match(user, /Judy collapses/);
});

test('what the bookkeeper finds is checked: known people and conditions, nothing twice, handovers move the item', () => {
    const { w, known } = books();
    const reply = 'Sure! {"conditions_add": {"Judy": ["passed out", "poisoned", "sad"], "Nobody": ["prone"], "Warden Pike": ["tied up"]}, "conditions_remove": {"Amber": ["prone"], "Judy Hopps": ["poisoned"]}, "items_add": {"Amber": ["silver key", "torch"], "Warden Pike": ["ring of keys"]}, "items_remove": {"Judy Hopps": ["key"], "Amber": ["sword"]}}';
    const ch = parseBookkeeping(reply, known);
    assert.deepEqual(ch.conditions_add, { 'Judy Hopps': ['unconscious'], 'Warden Pike': ['restrained (rope)'] }, 'poisoned she already has; "sad" is no condition; nobody unknown');
    assert.deepEqual(ch.conditions_remove, { 'Judy Hopps': ['poisoned'] }, 'Amber wasn\'t prone');
    assert.deepEqual(ch.items_remove, { 'Judy Hopps': ['silver key'] }, 'only what she has (Amber had no sword)');
    assert.deepEqual(ch.items_add, { Amber: ['silver key', 'torch'] }, 'the key changes hands; NPCs don\'t get party items');
    applyStateChanges(w, ch, ['Judy Hopps']);
    assert.deepEqual(w.inventory, { 'Judy Hopps': [], Amber: ['silver key', 'torch'] });
    assert.deepEqual(conditionsOf(w, 'Judy Hopps'), ['unconscious']);
    assert.deepEqual(conditionsOf(w, 'Warden Pike'), ['restrained (rope)']);
});

test('nothing new, or junk: no changes', () => {
    const { known } = books();
    assert.equal(parseBookkeeping('{"conditions_add": {}, "conditions_remove": {}, "items_add": {}, "items_remove": {}}', known), null);
    assert.equal(parseBookkeeping('I think nothing changed.', known), null);
    assert.equal(parseBookkeeping('{"items_add": {"Amber": ["rope"]}}', known), null, 'already in the shared pack');
});
