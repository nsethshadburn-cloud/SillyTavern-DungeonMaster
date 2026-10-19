// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNotation, roll, rollDie, judge, parsePlayerRoll, abilityModifier } from '../src/core/dice.js';
import { normalizeEvent, eventChance, eligibleEvents, pickEvent, guessSetting } from '../src/core/deck.js';
import { createPacingState, tickPlayerTurn, dmReasons, applyDmPacing, updateFun } from '../src/core/pacing.js';
import { ruleTriage, parseHelperTriage } from '../src/core/triage.js';
import { extractJson, stripThinking, stripSpeakerPrefix, matchName, slug } from '../src/core/text.js';
import { parseDmTurn } from '../src/core/protocol.js';
import { createWorldState, ensureParty, applyStateChanges, lookupModifier, startCombat, worldFlags, addNpcs } from '../src/core/world.js';
import { estimateCallCost, budgetStatus, nightKey } from '../src/core/budget.js';

test('dice notation parses and rolls in range', () => {
    assert.deepEqual(parseNotation('1d20+5').terms.length, 2);
    assert.equal(parseNotation('2d6 + 3').terms.length, 2);
    assert.equal(parseNotation('d8').terms[0].sides, 8);
    assert.equal(parseNotation('nonsense'), null);
    assert.equal(parseNotation('1d20+'), null);
    for (let i = 0; i < 500; i++) {
        const r = roll('1d20+5');
        assert.ok(r.total >= 6 && r.total <= 25, `out of range ${r.total}`);
        assert.ok(r.natural >= 1 && r.natural <= 20);
        const d = rollDie(6);
        assert.ok(d >= 1 && d <= 6);
    }
    const kh = roll('4d6kh3', { rng: (() => { const seq = [1, 6, 4, 3]; let i = 0; return () => seq[i++]; })() });
    assert.equal(kh.total, 13);
    assert.deepEqual(kh.dropped, [1]);
});

test('advantage keeps the higher d20', () => {
    const seq = [4, 17];
    let i = 0;
    const r = roll('1d20+2', { advantage: 'advantage', rng: () => seq[i++] });
    assert.equal(r.natural, 17);
    assert.equal(r.total, 19);
    i = 0;
    const r2 = roll('1d20+2', { advantage: 'disadvantage', rng: () => seq[i++] });
    assert.equal(r2.natural, 4);
});

test('judging and player roll parsing', () => {
    assert.equal(judge(15, 15).success, true);
    assert.equal(judge(14, 15).success, false);
    assert.equal(judge(5, 30, 20, 'attack').success, true);
    assert.equal(judge(25, 10, 1, 'attack').success, false);
    assert.deepEqual(parsePlayerRoll('14'), { natural: 14, total: null });
    assert.deepEqual(parsePlayerRoll('I rolled a 17!'), { natural: 17, total: null });
    assert.deepEqual(parsePlayerRoll('nat 20 baby'), { natural: 20, total: null });
    assert.deepEqual(parsePlayerRoll('rolled 12 total 17'), { natural: 12, total: 17 });
    assert.equal(parsePlayerRoll('no numbers here'), null);
    assert.equal(abilityModifier(15), 2);
    assert.equal(abilityModifier(8), -1);
});

test('event deck filters, cools down and picks', () => {
    const deck = [
        normalizeEvent({ id: 'a', title: 'Bandits', settings: ['road'], type: 'combat', danger: 3, cooldown: 30 }),
        normalizeEvent({ id: 'b', title: 'Trader', settings: ['road', 'town'], type: 'social', danger: 1 }),
        normalizeEvent({ id: 'c', title: 'Ghost', settings: ['dungeon'], type: 'weird', danger: 2, requires: ['night'] }),
        normalizeEvent({ id: 'd', title: 'Once', settings: ['any'], type: 'loot', once: true }),
    ];
    const ctx = { setting: 'road', danger: 3, flags: new Set(['day']), turn: 50, history: { a: { lastTurn: 40, count: 1 }, d: { lastTurn: 0, count: 1 } } };
    const ids = eligibleEvents(deck, ctx).map(e => e.id);
    assert.deepEqual(ids, ['b']);
    assert.equal(pickEvent(eligibleEvents(deck, ctx), [], () => 0.5).id, 'b');
    assert.equal(eventChance({ turnsSinceEvent: 2, inCombat: false, tension: 3, fun: 1, frequency: 'normal' }), 0);
    assert.equal(eventChance({ turnsSinceEvent: 40, inCombat: true, tension: 3, fun: 1, frequency: 'normal' }), 0);
    const c = eventChance({ turnsSinceEvent: 16, inCombat: false, tension: 3, fun: 1, frequency: 'normal' });
    assert.ok(c > 0.2 && c < 0.45, `chance ${c}`);
    assert.equal(guessSetting('The Rusty Flagon tavern'), 'town');
    assert.equal(guessSetting('a damp crypt'), 'dungeon');
});

test('pacing decides when the DM is needed', () => {
    const p = createPacingState();
    tickPlayerTurn(p, 'breathe');
    assert.deepEqual(dmReasons({ pacing: p, triage: { category: 'banter' }, eventDue: false, checkinEvery: 10 }), []);
    assert.ok(dmReasons({ pacing: p, triage: { category: 'risky_action' }, eventDue: false, checkinEvery: 10 }).includes('risky_action'));
    p.localTurnsSinceDM = 10;
    assert.ok(dmReasons({ pacing: p, triage: { category: 'banter' }, eventDue: false, checkinEvery: 10 }).includes('checkin'));
    assert.deepEqual(dmReasons({ pacing: p, triage: { category: 'risky_action' }, eventDue: true, checkinEvery: 10, budgetBlocked: true }), []);
    assert.ok(dmReasons({ pacing: p, triage: { category: 'question', unknownAddressee: 'Finch' }, eventDue: false, checkinEvery: 99 }).includes('npc_addressed'));
    for (let i = 0; i < 20; i++) tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 1);
    applyDmPacing(p, { beats_completed: ['A1.1'], tension: 6, scene: { type: 'tension', changed: true } });
    assert.deepEqual(p.sceneHistory, ['exploration']);
    applyDmPacing(p, { scene: { type: 'tension', changed: true } });
    assert.deepEqual(p.sceneHistory, ['exploration'], 'same scene re-announced with no turns in it is not a new scene');
    assert.equal(p.driftStage, 0);
    assert.equal(p.tension, 6);
    assert.equal(p.sceneType, 'tension');
    updateFun(p, { engaged: 3, messageLength: 600 });
    assert.ok(p.fun > 1);
});

test('rule triage', () => {
    assert.equal(ruleTriage('((can I see the map?))').ooc, true);
    assert.equal(ruleTriage('DM, how far is the city?').ooc, true);
    assert.equal(ruleTriage('OOC: brb').ooc, true);
    assert.equal(ruleTriage('17', { pendingRoll: { die: 20 } }).rollResult, true);
    assert.equal(ruleTriage('17', {}).rollResult, false);
    assert.equal(ruleTriage("Let's head to the docks.").category, 'scene_move');
    assert.equal(ruleTriage('I attack the bandit with my sword').category, 'combat_action');
    assert.equal(ruleTriage('I try to pick the lock').category, 'risky_action');
    assert.equal(ruleTriage('"Nice weather today," I say to Judy.').category, null);
    const h = parseHelperTriage('Sure! {"category":"banter","engaged":2,"stalled":false,"speakers":["judy hopps","Bob"]}', ['Judy Hopps']);
    assert.equal(h.category, 'banter');
    assert.deepEqual(h.speakers, ['judy hopps']);
    assert.equal(parseHelperTriage('{"category":"question","addressed":"Constable Finch"}', []).addressed, 'Constable Finch');
});

test('text helpers', () => {
    assert.deepEqual(extractJson('blah ```json\n{"a": 1,}\n``` tail'), { a: 1 });
    assert.deepEqual(extractJson('{"a": {"b": "x}y"}} trailing'), { a: { b: 'x}y' } });
    assert.deepEqual(extractJson('{"a": [1, 2'), { a: [1, 2] });
    assert.equal(stripThinking('thought\nhmm<channel|>Hello there'), 'Hello there');
    assert.equal(stripSpeakerPrefix('Brannoc: "Hi."', 'Brannoc'), '"Hi."');
    assert.equal(stripSpeakerPrefix('Odel Finch: Odel Finch: *waves*', 'Odel Finch'), '*waves*');
    assert.equal(matchName('judy', ['Judy Hopps', 'Nick']), 'Judy Hopps');
    assert.equal(slug('Judy Hopps (Winter AU)'), 'Judy_Hopps_Winter_AU');
});

test('DM turn parsing is forgiving', () => {
    const t = parseDmTurn('Here you go:\n{"narration":"Rain.","player_roll":{"skill":"Perception","ability":"wis","dc":"14"},"npc_rolls":[{"who":"Judy","notation":"1d20+5","dc":13}],"directions":[{"speaker":"Judy Hopps","direction":"wary"}],"scene":{"type":"tension","location":"alley"},"tension":"5"}');
    assert.equal(t.narration, 'Rain.');
    assert.equal(t.player_roll.dc, 14);
    assert.equal(t.player_roll.ability, 'WIS');
    assert.equal(t.npc_rolls[0].dc, 13);
    assert.equal(t.tension, 5);
    assert.equal(t.scene.type, 'tension');
    assert.equal(parseDmTurn('no json'), null);
});

test('world state changes, sheets and combat', () => {
    const w = createWorldState();
    ensureParty(w, [{ name: 'Judy Hopps', hp_max: 24 }, { name: 'Rowan', hp_max: 30 }]);
    ensureParty(w, [{ name: 'Rowan', hp_max: 21 }]);
    assert.deepEqual([w.party.Rowan.hp, w.party.Rowan.hp_max], [21, 21], 'sheet arriving later raises max HP');
    ensureParty(w, [{ name: 'Rowan', hp_max: 30 }]);
    const log = applyStateChanges(w, { hp: { judy: -5 }, gold: 12, items_add: ['rope'], conditions_add: { Rowan: ['poisoned'] } });
    assert.equal(w.party['Judy Hopps'].hp, 19);
    assert.equal(w.gold, 12);
    assert.ok(log.length >= 3);
    assert.ok(worldFlags(w).has('has_gold'));
    const stats = { abilities: { DEX: 16, WIS: 12 }, skills: { Stealth: 7 }, saves: { DEX: 5 }, attacks: [{ name: 'Rapier', to_hit: 6 }], initiative: 3 };
    assert.equal(lookupModifier(stats, { kind: 'check', skill: 'Stealth' }).mod, 7);
    assert.equal(lookupModifier(stats, { kind: 'check', skill: 'Perception' }).mod, 1);
    assert.equal(lookupModifier(stats, { kind: 'save', skill: 'Dexterity save', ability: 'DEX' }).mod, 5);
    assert.equal(lookupModifier(stats, { kind: 'attack', skill: 'Rapier attack' }).mod, 6);
    assert.equal(lookupModifier(null, { kind: 'check', skill: 'x' }).mod, 0);
    const combat = startCombat(w, { enemies: [{ name: 'Bandit', ac: 12, hp: 11, dex: 1 }] }, [{ name: 'Judy Hopps', stats }], () => 10);
    assert.equal(combat.order.length, 2);
    applyStateChanges(w, { hp: { Bandit: -20 } });
    assert.equal(w.combat.enemies.Bandit.hp, 0);
    const roster = [];
    addNpcs(roster, [{ name: 'Brannoc', description: 'innkeeper' }]);
    addNpcs(roster, [{ name: 'brannoc', attitude: 'friendly' }]);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].attitude, 'friendly');
});

test('budget estimates', () => {
    const c = estimateCallCost({ stableText: 'x'.repeat(36000), volatileText: 'y'.repeat(3600), outputText: 'z'.repeat(1800), thinkingAllowance: 300, prices: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, cacheHit: false, cachingEnabled: false });
    assert.equal(c.inputTokens, 11000);
    assert.ok(Math.abs(c.usd - (11000 * 2 + 800 * 10) / 1e6) < 1e-6);
    assert.equal(budgetStatus({ monthUsd: 21, monthlyCap: 20 }).level, 'blocked');
    assert.equal(budgetStatus({ monthUsd: 17, monthlyCap: 20 }).level, 'tight');
    assert.equal(budgetStatus({ monthUsd: 2, monthlyCap: 20 }).level, 'ok');
    assert.equal(nightKey(new Date(2026, 9, 19, 2, 0)), '2026-10-18');
});
