// Run with: node --test tests/
// v0.11: what the local model is told is true right now (from the "Lantern and the Glass" session).
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSceneCard, applySceneCard, renderSceneCard, pushTimeline, renderTimeline, renderPeople, applyTableRules } from '../src/core/state.js';
import { DEFAULT_TEMPLATES, renderTemplate } from '../src/core/notes.js';
import { parseDmTurn, DM_RULES } from '../src/core/protocol.js';
import { addNpcs, lookupModifier } from '../src/core/world.js';
import { repeatedPhrases } from '../src/core/text.js';

const party = ['Amber', 'Judy Hopps'];

test('scene card: cuffs, positions and objects stay true', () => {
    let card = applySceneCard(null, normalizeSceneCard({
        place: 'cell under Crown Hall, one smoking lamp, a slit window high in the wall',
        people: { 'Judy Hopps': 'wrists cuffed behind her back, sitting against the wall', 'Captain Marek Dray': 'outside the bars' },
        objects: { 'cell door': 'shut and locked' },
    }), { partyNames: party });
    let text = renderSceneCard(card, { 'Judy Hopps': [] });
    assert.match(text, /cuffed behind her back/);
    assert.match(text, /Captain Marek Dray: outside the bars/);

    // The turnkey takes the cuffs off: only that entry changes; "" removes one.
    card = applySceneCard(card, normalizeSceneCard({ people: { 'judy hopps': 'wrists free and sore', 'Captain Marek Dray': '' } }), { partyNames: party });
    text = renderSceneCard(card);
    assert.doesNotMatch(text, /cuffed/);
    assert.doesNotMatch(text, /Dray/);
    assert.match(text, /slit window/, 'unchanged entries stay');

    // Marched to the Great Hall: the cell is gone, the party's own state carries over.
    card = applySceneCard(card, normalizeSceneCard({ place: 'the Great Hall, grey dawn light from high windows' }), { newPlace: true, partyNames: party });
    text = renderSceneCard(card, { 'Judy Hopps': ['exhausted'] });
    assert.doesNotMatch(text, /cell door|slit window/);
    assert.match(text, /wrists free and sore \[exhausted\]/);

    assert.equal(normalizeSceneCard({}), null);
    assert.equal(normalizeSceneCard('cell'), null);
});

test('timeline: the meat pie was last night, not last week', () => {
    let tl = [];
    tl = pushTimeline(tl, { day: 1, time: 'night', place: 'vault corridor', text: 'Judy shared a meat pie with Amber.' });
    tl = pushTimeline(tl, { day: 1, time: 'night', place: 'vault', text: 'Amber was caught with the Dawnlamp; both were arrested.' });
    tl = pushTimeline(tl, { day: 2, time: 'morning', place: 'Great Hall', text: 'Both were sentenced to hang in thirty days.' });
    assert.match(renderTimeline(tl, { day: 2, time: 'morning' }), /- Last night, vault corridor: Judy shared a meat pie/);
    assert.match(renderTimeline(tl, { day: 2, time: 'morning' }), /- Earlier today, Great Hall: Both were sentenced/);
    assert.match(renderTimeline(tl, { day: 5, time: 'morning' }), /- 4 days ago, vault corridor/);
    assert.doesNotMatch(renderTimeline(tl, { day: 2 }, { skipLatest: true }), /sentenced/, 'the newest line is shown as "just happened" instead');
    for (let i = 0; i < 20; i++) tl = pushTimeline(tl, { day: 3, text: `event ${i}` });
    assert.equal(tl.length, 8);
    assert.equal(pushTimeline([], { text: '  ' }).length, 0);
});

test('people with roles: the captain is the commander', () => {
    const people = renderPeople([
        { name: 'Captain Marek Dray', role: "watch captain, Judy's commander" },
        { name: 'Magistrate Halvard Senn', description: 'A heavy, bored magistrate in black robes. Wants breakfast.' },
        { name: 'Old Turnkey', description: 'Stooped jailer', dead: true },
        { name: 'Judy Hopps', role: 'never lists the speaker' },
    ], { exclude: 'Judy Hopps' });
    assert.match(people, /Captain Marek Dray: watch captain, Judy's commander/);
    assert.match(people, /Magistrate Halvard Senn: A heavy, bored magistrate in black robes$/m);
    assert.match(people, /Old Turnkey: Stooped jailer \(dead\)/);
    assert.doesNotMatch(people, /never lists/);
    const roster = [];
    addNpcs(roster, [{ name: 'Dray', role: 'captain' }]);
    assert.equal(roster[0].role, 'captain');
});

test('table rules: set out of character, never duplicated, removable', () => {
    let rules = applyTableRules([], ['Amber and Judy always stay together: same cell, same chains, same road.']);
    rules = applyTableRules(rules, ['amber and judy always stay together: same cell, same chains, same road']);
    assert.equal(rules.length, 1);
    assert.equal(applyTableRules(rules, [], ['Amber and Judy always stay together']).length, 0);
});

test('note templates drop empty parts cleanly', () => {
    const full = renderTemplate(DEFAULT_TEMPLATES.state, { scenecard: 'Place: cell', people: '- Dray: captain', timeline: '- Last night: arrested', rules: 'They stay together.' });
    assert.match(full, /Place: cell\nPeople \{\{char\}\} knows of:\n- Dray: captain\nEarlier .*\n- Last night: arrested\nAlways true in this story: They stay together\.\]$/);
    const bare = renderTemplate(DEFAULT_TEMPLATES.state, { scenecard: 'Place: cell' });
    assert.ok(bare.endsWith('Place: cell]'), bare);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.avoid, { avoid: '"the same"' }), /repeating.*"the same"\]/);
});

test('DM turn: scene card, table rules, roles and roll bonus are read', () => {
    const t = parseDmTurn(JSON.stringify({
        scene_card: { place: 'cell', people: { 'Judy Hopps': 'cuffed' } },
        table_rules_add: ['They stay together'],
        new_npcs: [{ name: 'Captain Marek Dray', role: "watch captain, Judy's commander" }],
        player_roll: { kind: 'check', skill: "Thieves' Tools", ability: 'DEX', dc: 17, bonus: '11' },
    }));
    assert.equal(t.scene_card.people['Judy Hopps'], 'cuffed');
    assert.deepEqual(t.table_rules_add, ['They stay together']);
    assert.equal(t.new_npcs[0].role, "watch captain, Judy's commander");
    assert.equal(t.player_roll.bonus, 11);
    assert.equal(parseDmTurn('{"player_roll":{"skill":"Stealth"}}').player_roll.bonus, null);
    assert.equal(parseDmTurn('{}').scene_card, null);
    for (const s of ['"scene_card"', 'TABLE RULES', 'table_rules_add', 'Never between a setup and its payoff', 'player_roll.bonus', '"role"', 'Never quote anyone in your narration who speaks this turn']) {
        assert.ok(DM_RULES.includes(s), s);
    }
});

test("Thieves' Tools: the sheet's tools, then the DM's bonus, then plain DEX", () => {
    const stats = { abilities: { DEX: 20, WIS: 14 }, skills: { Perception: 11 }, tools: { "Thieves' Tools": 11 } };
    assert.deepEqual(lookupModifier(stats, { kind: 'check', skill: 'Thieves Tools', ability: 'DEX' }), { mod: 11, source: "Thieves' Tools" });
    const oldSheet = { abilities: { DEX: 20 }, skills: { Perception: 11 } };
    assert.equal(lookupModifier(oldSheet, { kind: 'check', skill: "Thieves' Tools", ability: 'DEX', bonus: 11 }).mod, 11);
    assert.equal(lookupModifier(oldSheet, { kind: 'check', skill: "Thieves' Tools", ability: 'DEX', bonus: null }).mod, 5);
    assert.equal(lookupModifier(oldSheet, { kind: 'check', skill: 'Perception', ability: 'WIS', bonus: 3 }).mod, 11, 'the sheet beats the DM');
});

test("repeated phrases: Judy's tics are caught, names never", () => {
    const replies = [
        '*She presses her back against the cold stone wall.* "The same sun, Amber."',
        '*She presses her back against the wall and looks at the same stone ceiling.*',
        '"Under the same building, the same hallway." *Her ears flatten.*',
        '"I know you did, Amber." *Her ears drop low.*',
    ];
    const found = repeatedPhrases(replies, { exclude: ['Amber', 'Judy Hopps'] });
    assert.ok(found.some(p => p.includes('presses her back against the')), found.join(' | '));
    assert.ok(found.includes('the same'), found.join(' | '));
    assert.ok(!found.some(p => p.includes('amber')), 'names are never flagged');
    assert.deepEqual(repeatedPhrases(['Hello there.', 'Something else entirely.']), []);
});
