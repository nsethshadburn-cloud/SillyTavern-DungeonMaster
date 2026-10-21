// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNotation, roll, rollDie, judge, parsePlayerRoll, abilityModifier } from '../src/core/dice.js';
import { normalizeEvent, eventChance, eligibleEvents, pickEvent, guessSetting } from '../src/core/deck.js';
import { createPacingState, tickPlayerTurn, dmReasons, applyDmPacing, updateFun, isFillerMessage, nextBeat, pacingReport, PRESSURE_STAGES } from '../src/core/pacing.js';
import { parseRollMessage, damageDice, collectRoll } from '../src/core/rollmsg.js';
import { DM_RULES } from '../src/core/protocol.js';
import { ruleTriage, parseHelperTriage } from '../src/core/triage.js';
import { extractJson, stripThinking, stripSpeakerPrefix, matchName, slug } from '../src/core/text.js';
import { parseDmTurn } from '../src/core/protocol.js';
import { createWorldState, ensureParty, applyStateChanges, lookupModifier, startCombat, worldFlags, addNpcs } from '../src/core/world.js';
import { estimateCallCost, budgetStatus, nightKey, cacheWriteMultiplier } from '../src/core/budget.js';
import { pickModel, modelLabel, migrateModelSettings, defaultTaskModels, TASKS } from '../src/core/models.js';

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
    assert.equal(p.driftStage, 2, '21 turns without a beat: pursuit');
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
    const prices = { input: 2, output: 10, cacheRead: 0.1 };
    const blocks = cache => [{ text: 'x'.repeat(36000), cache }, { text: 'y'.repeat(3600), cache: 'none' }];
    const plain = estimateCallCost({ blocks: blocks('none'), outputText: 'z'.repeat(1800), thinkingAllowance: 300, prices });
    assert.equal(plain.inputTokens, 11000);
    assert.ok(Math.abs(plain.usd - (11000 * 2 + 800 * 10) / 1e6) < 1e-6);
    const hit = estimateCallCost({ blocks: blocks('hit'), outputText: 'z'.repeat(1800), thinkingAllowance: 300, prices });
    assert.ok(Math.abs(hit.usd - (10000 * 0.1 + 1000 * 2 + 800 * 10) / 1e6) < 1e-6);
    const write = estimateCallCost({ blocks: blocks('write'), outputText: '', prices, writeMultiplier: cacheWriteMultiplier(5) });
    assert.ok(Math.abs(write.usd - (10000 * 2 * 1.25 + 1000 * 2) / 1e6) < 1e-6);
    assert.equal(cacheWriteMultiplier(60), 2);
    // Too short to cache: billed as plain input even when marked as a hit.
    const tiny = estimateCallCost({ blocks: [{ text: 'x'.repeat(360), cache: 'hit' }], outputText: '', prices });
    assert.ok(Math.abs(tiny.usd - (100 * 2) / 1e6) < 1e-6);
    assert.equal(budgetStatus({ monthUsd: 21, monthlyCap: 20 }).level, 'blocked');
    assert.equal(budgetStatus({ monthUsd: 17, monthlyCap: 20 }).level, 'tight');
    assert.equal(budgetStatus({ monthUsd: 2, monthlyCap: 20 }).level, 'ok');
    assert.equal(nightKey(new Date(2026, 9, 19, 2, 0)), '2026-10-18');
});

test('per-job models: Sonnet for setup, direction and combat, Haiku for the rest', () => {
    const S = 'claude-sonnet-5-5', H = 'claude-haiku-5-5';
    const taskModels = defaultTaskModels();
    const price = { [S]: 2, [H]: 0.1, 'claude-opus-5-5': 5 };
    const o = { hybrid: true, mainModel: S, taskModels, rank: m => price[m] ?? 0 };
    for (const k of ['campaign_design', 'pitches', 'opening', 'persona_sheet', 'character_sheet', 'drift', 'stalled', 'checkin', 'combat_action', 'combat_round']) {
        assert.equal(pickModel([k], o), S, k);
    }
    for (const k of ['risky_action', 'roll_result', 'scene_move', 'event', 'npc_addressed', 'ooc', 'manual', 'recap', 'condense_notes']) {
        assert.equal(pickModel([k], o), H, k);
    }
    assert.equal(pickModel(['risky_action', 'drift'], o), S, 'the more capable model wins when jobs disagree');
    assert.equal(pickModel(['roll_result'], { ...o, criticalRoll: true }), H, 'criticals unchanged by default');
    assert.equal(pickModel(['roll_result'], { ...o, criticalRoll: true, criticalModel: S }), S);
    assert.equal(pickModel(['roll_result'], { ...o, hybrid: false }), S, 'hybrid off = main model for everything');
    assert.equal(pickModel(['some_future_job'], o), S, 'unknown jobs use the main model');
    assert.equal(pickModel(['event'], { ...o, taskModels: { ...taskModels, event: 'claude-opus-5-5' } }), 'claude-opus-5-5', 'any model per job');
    assert.equal(new Set(TASKS.map(t => t.key)).size, TASKS.length, 'job keys are unique');
    for (const r of ['ooc', 'roll_result', 'risky_action', 'scene_move', 'combat_action', 'combat_round', 'event', 'stalled', 'npc_addressed', 'drift', 'checkin', 'opening', 'manual']) {
        assert.ok(TASKS.some(t => t.key === r), `DM reason ${r} has a job`);
    }
    assert.equal(modelLabel(H), 'Haiku');
    assert.equal(modelLabel(S), 'Sonnet');
});

test('older model settings move to per-job models', () => {
    const S = 'claude-sonnet-5-5', H = 'claude-haiku-5-5';
    const v040 = { opening: true, scene_move: true, event: true, drift: true, stalled: true, combat_round: true, combat_action: false, risky_action: false, roll_result: false, npc_addressed: false, ooc: false, checkin: false, manual: true };

    const untouched = { dmModel: S, dmModelRoutine: H, autoModel: true, bigReasons: { ...v040 }, bigOnCritical: true };
    assert.equal(migrateModelSettings(untouched), true);
    assert.deepEqual(untouched.taskModels, defaultTaskModels(), 'untouched v0.4.0 → recommended');
    assert.equal(untouched.criticalModel, undefined);
    assert.equal(untouched.bigReasons, undefined, 'old keys removed');
    assert.equal(migrateModelSettings(untouched), false, 'runs once');

    const custom = { dmModel: S, dmModelRoutine: H, autoModel: false, bigReasons: { ...v040, roll_result: true }, bigOnCritical: true, modelDefaultsVersion: 2 };
    migrateModelSettings(custom);
    assert.equal(custom.taskModels.roll_result, S, 'customized choices kept');
    assert.equal(custom.taskModels.ooc, H);
    assert.equal(custom.taskModels.persona_sheet, S, 'new jobs get the recommended model');
    assert.equal(custom.criticalModel, S);
    assert.equal(custom.hybridModels, false, 'auto off → hybrid off');

    const neverHadModels = { dmModel: 'claude-opus-5-5' };
    migrateModelSettings(neverHadModels);
    assert.equal(neverHadModels.taskModels.opening, 'claude-opus-5-5', 'main jobs follow the saved main model');
    assert.equal(neverHadModels.taskModels.roll_result, H);
});

test('DM can hand a turn up', () => {
    assert.equal(parseDmTurn('{"escalate": true}').escalate, true);
    assert.equal(parseDmTurn('{"narration": "x"}').escalate, false);
});

test('plot pressure climbs one stage at a time, holds during real conversation, and keeps pushing at the top', () => {
    const p = createPacingState();
    for (let i = 0; i < 11; i++) tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 0);
    tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 1, 'hints at 12 turns');
    // Engaged chat holds the stage even though turns keep counting.
    p.fun = 2.6;
    for (let i = 0; i < 20; i++) tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 1, 'held while the player is engaged');
    p.fun = 1;
    tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 2, 'one stage per turn once the chat ends');
    for (let i = 0; i < 6; i++) tickPlayerTurn(p, 'breathe');
    assert.equal(p.driftStage, 4, 'force');
    // A new stage calls the DM; at the top it calls again every few turns until a beat lands.
    const call = lastDriftStageCalled => dmReasons({ pacing: p, triage: { category: 'banter' }, eventDue: false, checkinEvery: 99, lastDriftStageCalled });
    assert.ok(call(3).includes('drift'));
    p.pressureCallAge = 0;
    assert.ok(!call(4).includes('drift'));
    p.pressureCallAge = 4;
    assert.ok(call(4).includes('drift'));
    p.fun = 2.5;
    assert.ok(!call(4).includes('drift'), 'not mid-conversation');
    applyDmPacing(p, { beats_completed: ['A2.1'] });
    assert.equal(p.driftStage, 0);
    assert.equal(p.turnsSinceBeat, 0);
    assert.equal(PRESSURE_STAGES.length, 5);
});

test('stalls are detected from filler replies, not from questions or real moves', () => {
    for (const t of ['Go', 'Fine. Lets go', 'Lets go then.', '*amber complies with his demands*', '*they sit in silence for awhile*', 'ok', '*nods*']) {
        assert.ok(isFillerMessage(t), t);
    }
    for (const t of ['What do you want, and why shouldnt i kill you', '*amber jumps onto the horse with judy*', 'Wow, your really optimistic arnt you?', 'Look, we just need to find a tool that can pick this lock, then we steal what supplies we need and we get out of there.']) {
        assert.ok(!isFillerMessage(t), t);
    }
    const p = createPacingState();
    for (const filler of [true, true]) tickPlayerTurn(p, 'breathe', { filler });
    assert.ok(!dmReasons({ pacing: p, triage: { category: 'banter' }, eventDue: false, checkinEvery: 99 }).includes('stalled'));
    tickPlayerTurn(p, 'breathe', { filler: true });
    assert.ok(dmReasons({ pacing: p, triage: { category: 'banter' }, eventDue: false, checkinEvery: 99 }).includes('stalled'));
    assert.match(pacingReport(p), /STALL/);
    tickPlayerTurn(p, 'breathe', { filler: false });
    assert.equal(p.fillerStreak, 0, 'a real message resets it');
});

test('next beat comes from the plot checklist', () => {
    const plot = '## Act 1: The Market\n- [x] A1.1 Amber works the market\n- [ ] A1.2 Hunters take Amber and Judy\n- [ ] A1.3 The road to Grimhollow';
    assert.deepEqual(nextBeat(plot), { id: 'A1.2', text: 'Hunters take Amber and Judy' });
    assert.equal(nextBeat('- [x] A1.1 done'), null);
    assert.match(pacingReport(createPacingState(), { plot }), /NEXT BEAT: A1\.2 Hunters take Amber and Judy/);
});

test('SillyTavern dice messages are read for pending rolls', () => {
    assert.deepEqual(parseRollMessage('Amber rolls a d20. The result is: 17 (17)'), { who: 'Amber', count: 1, sides: 20, total: 17, rolls: [17] });
    assert.deepEqual(parseRollMessage('Amber rolls a 4d6. The result is: 19 (6,2,6,5)').rolls, [6, 2, 6, 5]);
    assert.deepEqual(parseRollMessage('Amber rolls a 1d20+11. The result is: 28 (17)').rolls, [17], 'natural die, not the total');
    assert.equal(parseRollMessage('Amber says hi'), null);
    assert.deepEqual(damageDice('1d6+5 +3d6 Sneak Attack +6 Assassinate'), { dice: { 6: 4 }, bonus: 11 });
    const d = (sides, value) => ({ sides, value });
    // From the chat: 6+6+5+3 +11 = 31.
    const dmg = { kind: 'damage', damage: '1d6+5 +3d6 Sneak Attack +6 Assassinate' };
    assert.deepEqual(collectRoll(dmg, [d(6, 6), d(6, 6), d(6, 5)]), { done: false });
    assert.deepEqual(collectRoll(dmg, [d(6, 6), d(6, 6), d(6, 5), d(6, 3)]), { done: true, natural: null, total: 31 });
    const adv = { kind: 'attack', die: 20, advantage: 'advantage' };
    assert.deepEqual(collectRoll(adv, [d(20, 4)]), { done: false }, 'advantage waits for the second d20');
    assert.deepEqual(collectRoll(adv, [d(20, 4), d(20, 8)]), { done: true, natural: 8, total: null });
    assert.deepEqual(collectRoll({ kind: 'save', die: 20, advantage: 'disadvantage' }, [d(20, 15), d(20, 9)]).natural, 9);
    assert.deepEqual(collectRoll({ kind: 'check', die: 20 }, [d(4, 3), d(20, 6)]), { done: true, natural: 6, total: null }, 'other dice are ignored');
});

test('DM rules: forward motion, arrivals, sensible rolls, pressure ladder', () => {
    assert.doesNotMatch(DM_RULES, /Never rush/);
    assert.doesNotMatch(DM_RULES, /Usually 1-3 sentences/);
    assert.match(DM_RULES, /Usually 2-5 sentences/);
    assert.match(DM_RULES, /Arrivals:/);
    assert.match(DM_RULES, /Conversation is never filler/);
    assert.match(DM_RULES, /stage 4 force/);
    assert.match(DM_RULES, /just narrate the success/);
});
