// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMind, mergeMind, renderMind, renderMinds, mindIsEmpty } from '../src/core/minds.js';
import { normalizeDmTurn, DM_RULES, BIBLE_INSTRUCTIONS } from '../src/core/protocol.js';

test('a companion mind: checked, merged a field at a time, cleared with "", rendered for the DM', () => {
    assert.equal(normalizeMind(null), null);
    assert.equal(normalizeMind({ extra: 'x' }), null);
    const first = normalizeMind({ mood: 'tense but game', goal: 'find out who framed her', feelings: { 'Captain Dray': 'distrusts him', Amber: 'grateful, a little protective' }, worry: 'that Amber will take the fall for her' });
    let mind = mergeMind(null, first);
    assert.equal(mind.goal, 'find out who framed her');
    assert.equal(Object.keys(mind.feelings).length, 2);
    assert.match(renderMind(mind), /Mood: tense but game\. Own goal: find out who framed her\. Feelings: Captain Dray: distrusts him; Amber: grateful, a little protective\. Private worry: that Amber will take the fall for her\./);
    // Only what's sent changes; a feeling is matched loosely by name; "" clears.
    mind = mergeMind(mind, normalizeMind({ mood: 'furious', feelings: { dray: 'hates him now', Amber: '' }, worry: '' }));
    assert.equal(mind.goal, 'find out who framed her', 'untouched fields stay');
    assert.equal(mind.mood, 'furious');
    assert.deepEqual(mind.feelings, { 'Captain Dray': 'hates him now' });
    assert.equal(mind.worry, '');
    assert.ok(!mindIsEmpty(mind));
    assert.ok(mindIsEmpty(mergeMind(null, null)));
    const block = renderMinds(['Judy Hopps', 'Tulin'], { 'Judy Hopps': mind });
    assert.match(block, /## Judy Hopps\nMood: furious/);
    assert.match(block, /## Tulin\n\(MISSING: write "mind_update"/);
    // Long text is clipped, never thrown.
    assert.ok(normalizeMind({ mood: 'x'.repeat(500) }).mood.length <= 160);
});

test('the DM protocol carries mind_update and the rules ask for briefs written from the mind', () => {
    const t = normalizeDmTurn({ scene: { type: 'social' }, mind_update: { 'Judy Hopps': { mood: 'wary', feelings: { Brask: 'afraid of him' } }, '': { mood: 'x' }, Amber: 'not an object' } });
    assert.deepEqual(Object.keys(t.mind_update), ['Judy Hopps']);
    assert.equal(t.mind_update['Judy Hopps'].mood, 'wary');
    assert.match(DM_RULES, /"mind_update"/);
    assert.match(DM_RULES, /unprompted/i);
    assert.match(BIBLE_INSTRUCTIONS, /"minds"/);
});
