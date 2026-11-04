// v0.80: the referee split. The referee's reply is read into the mechanics half of a turn, the
// storyteller's into the story half, and the storyteller's hands are kept off the dice and the books.
import test from 'node:test';
import assert from 'node:assert/strict';

import { REFEREE_RULES, STORY_RULES, refereeRules, storyRules, normalizeRuling, parseRuling, rulingToTurn, normalizeStory, parseStory, NOT_THE_STORYTELLERS, normalizeDmTurn } from '../src/core/protocol.js';

const ctx = {
    player: 'Amber',
    party: ['Judy Hopps'],
    bonusFor: (name, req) => (name === 'Judy Hopps' ? (req.kind === 'attack' ? 5 : /perception/i.test(req.skill) ? 4 : 3) : null),
    foeStats: name => (name === 'Hob' ? { toHit: 4, damage: '1d6+2' } : null),
};

test('the referee asks the player one roll, with the why on the card and the DC hidden; a contest carries the other side', () => {
    const r = normalizeRuling({ rolls: [{ who: 'Amber', kind: 'contest', skill: 'Acrobatics', dc: null, vs: { who: 'Hob', skill: 'Athletics', bonus: 3 }, why: 'slipping the grab' }, { who: 'Amber', kind: 'check', skill: 'Stealth', dc: 12 }] });
    const t = rulingToTurn(r, ctx);
    assert.equal(t.player_roll.kind, 'check');
    assert.equal(t.player_roll.skill, 'Acrobatics');
    assert.equal(t.player_roll.reason, 'slipping the grab');
    assert.deepEqual(t.player_roll.vs, { who: 'Hob', skill: 'Athletics', bonus: 3 });
    assert.equal(t.npc_rolls.length, 0);
    assert.match(t.dropped[0], /second roll for Amber/);
});

test('rolls for everyone else become code-rolled dice with the notation from their sheet or stat block', () => {
    const r = normalizeRuling({ rolls: [{ who: 'Judy Hopps', kind: 'check', skill: 'Perception', dc: 12, on_success: 'she hears them', on_fail: 'rain' }, { who: 'Hob', kind: 'attack', target: 'Amber' }, { who: 'Hob', kind: 'initiative' }] });
    const t = rulingToTurn(r, ctx);
    assert.equal(t.npc_rolls.length, 2);
    assert.equal(t.npc_rolls[0].notation, '1d20+4', "Judy's Perception from her sheet");
    assert.equal(t.npc_rolls[0].on_success, 'she hears them');
    assert.equal(t.npc_rolls[1].notation, '1d20+4', "Hob's to-hit from his stat block");
    assert.equal(t.npc_rolls[1].damage, '1d6+2');
    assert.equal(t.npc_rolls[1].kind, 'attack');
    assert.match(t.dropped[0], /initiative roll for Hob/);
});

test('acts: an attack with a move, a check, a hold, a leave; the player\'s own swing is their roll', () => {
    const r = normalizeRuling({ acts: { Scald: { do: 'attack', target: 'Amber', weapon: 'knife', to_hit: 3, damage: '1d4+1', move: 'h3' }, 'Judy Hopps': { do: 'check', skill: 'Perception', dc: 12, why: 'listening' }, Hob: { do: 'hold', why: 'winded' }, Rook: { do: 'leave' }, Amber: { do: 'attack', target: 'Hob', weapon: 'Short sword' } } });
    const t = rulingToTurn(r, ctx);
    const scald = t.npc_rolls.find(x => x.who === 'Scald');
    assert.equal(scald.notation, '1d20+3');
    assert.equal(scald.what, 'knife at Amber');
    assert.equal(scald.damage, '1d4+1');
    assert.equal(t.positions.Scald, 'h3');
    assert.equal(t.positions.Rook, 'gone');
    assert.equal(t.npc_rolls.find(x => x.who === 'Judy Hopps').notation, '1d20+4');
    assert.deepEqual(t.held, { Hob: 'winded' });
    assert.equal(t.player_roll.kind, 'attack');
    assert.equal(t.player_roll.target, 'Hob');
    assert.equal(t.player_roll.skill, 'Short sword');
});

test('scene, fight, changes, clock, rest and the rest come through in the shape the code applies', () => {
    const r = parseRuling('Ruling:\n{"fact": "The lock holds.", "scene": {"moved": true, "location": "Tusk\'s shop", "setting": "town", "place": "the front room, one lamp", "people": {"Olwen Tusk": "behind the counter"}, "spots": {"Olwen Tusk": "across", "Hob": "outside"}, "objects": {"the counter": "scarred oak"}}, "fight": {"start": {"enemies": [{"name": "Hob", "ac": 12, "hp": 11, "damage": "1d6+2"}]}}, "changes": {"gold": -0.5, "items_add": {"Amber": ["hooded lantern"]}}, "clock": {"set": "dawn"}, "rest": "long", "moves": {"Hob": "f7"}, "npcs_dead": ["Rook"], "ooc": "A grab is a contest."}');
    const t = rulingToTurn(r, ctx);
    assert.equal(t.fact, 'The lock holds.');
    assert.equal(t.ooc, 'A grab is a contest.');
    assert.equal(t.scene.location, "Tusk's shop");
    assert.equal(t.scene.changed, true);
    assert.equal(t.scene_card.people['Olwen Tusk'], 'behind the counter');
    assert.equal(t.scene_card.spots.Hob, 'outside');
    assert.equal(t.start_combat.enemies[0].name, 'Hob');
    assert.equal(t.start_combat.map, null);
    assert.equal(t.state_changes.gold, -0.5);
    assert.deepEqual(t.clock, { advance: '', set: 'dawn' });
    assert.equal(t.rest, 'long');
    assert.equal(t.positions.Hob, 'f7');
    assert.deepEqual(t.npcs_dead, ['Rook']);
    assert.equal(rulingToTurn(parseRuling('{"fight": {"end": true}}'), ctx).end_combat, true);
    assert.equal(rulingToTurn(parseRuling('{"fight": "end"}'), ctx).end_combat, true);
    assert.equal(parseRuling('no json'), null);
    assert.equal(normalizeRuling({ scene: {} }).scene, null, 'an empty scene is no scene');
});

test('the storyteller keeps its hands off the dice and the books: those keys are dropped and named', () => {
    const s = normalizeStory({ narration: 'The knife catches your arm.', happened: 'Scald cut Amber.', directions: [{ speaker: 'Judy Hopps', direction: 'Shout.', length: 'short' }], state_changes: { hp: { Amber: -3 } }, player_roll: { kind: 'check', skill: 'Stealth' }, npc_rolls: [{ who: 'Hob', notation: '1d20' }], positions: { Amber: 'd4' }, start_combat: { enemies: [] }, end_combat: false, clock: null, scene: { type: 'tension', location: 'Elsewhere', changed: true }, scene_card: { place: 'a new place', people: { 'A patrol': 'rounding the bend' }, spots: { 'A patrol': 'door' } }, tension: 6, world_next: 2 });
    assert.deepEqual(s.dropped, ['player_roll', 'npc_rolls', 'state_changes', 'positions', 'start_combat']);
    assert.equal(s.turn.narration, 'The knife catches your arm.');
    assert.equal(s.turn.player_roll, null);
    assert.equal(s.turn.npc_rolls.length, 0);
    assert.deepEqual(s.turn.state_changes, {});
    assert.deepEqual(s.turn.positions, {});
    assert.equal(s.turn.start_combat, null);
    assert.equal(s.turn.scene.type, 'tension');
    assert.equal(s.turn.scene.location, '', 'where the party is stays the referee\'s');
    assert.equal(s.turn.scene.changed, false);
    assert.equal(s.turn.scene_card.place, '', 'the place stays the referee\'s');
    assert.equal(s.turn.scene_card.people['A patrol'], 'rounding the bend', 'who arrives is the storyteller\'s');
    assert.equal(s.turn.tension, 6);
    assert.equal(parseStory('{"narration": "x"}').turn.narration, 'x');
    assert.ok(NOT_THE_STORYTELLERS.includes('rest') && NOT_THE_STORYTELLERS.includes('fight'));
});

test('the rules: the referee writes no prose and rules on dice, books, scene and fights; the storyteller changes none of it', () => {
    assert.match(REFEREE_RULES, /You write no narration, no dialogue, no briefs/);
    assert.match(REFEREE_RULES, /CONTESTS between people are rolls, never say-so/);
    assert.match(REFEREE_RULES, /There are no secret rolls|there are no secret rolls/);
    assert.match(REFEREE_RULES, /PASSIVE Perception/);
    assert.match(REFEREE_RULES, /WHO MUST ACT NOW lists every name/);
    assert.match(REFEREE_RULES, /NOTHING HOLDS ANYONE THAT THE BOOKS DON'T SHOW/);
    assert.match(REFEREE_RULES, /"fact"/);
    assert.match(REFEREE_RULES, /"acts"/);
    assert.doesNotMatch(REFEREE_RULES, /"directions"|"narration"|"happened"|mind_update/);
    assert.ok(REFEREE_RULES.length < 24000, `the referee's rules are half the old DM's 42k (${REFEREE_RULES.length} chars)`);
    assert.match(STORY_RULES, /THE TABLE'S RULING/);
    assert.match(STORY_RULES, /no re-rolls, no extra wound, no coin/);
    assert.match(STORY_RULES, /"narration" is EMPTY by default/);
    assert.match(STORY_RULES, /Never between a setup and its payoff/);
    assert.match(STORY_RULES, /"mind_update"/);
    assert.match(STORY_RULES, /unprompted/i);
    assert.match(STORY_RULES, /Arrivals:/);
    assert.match(STORY_RULES, /stage 4 force/);
    assert.match(STORY_RULES, /Never quote anyone in your narration who speaks this turn/);
    assert.doesNotMatch(STORY_RULES, /"player_roll"|"npc_rolls"|"state_changes"|"start_combat"|"positions"/);
    assert.equal(refereeRules('some'), REFEREE_RULES);
    const off = refereeRules('off');
    assert.doesNotMatch(off, /^- Maps: a grid/m);
    assert.doesNotMatch(off, /^ {2}"moves":/m);
    assert.match(off, /NO MAPS/);
    assert.match(off, /## Fights/, 'fights themselves stay');
    assert.match(storyRules('off'), /NO MAPS/);
    assert.doesNotMatch(storyRules('off'), /^- Map figures/m);
});

test('the whole shape still reads a wizard opening (both halves in one object)', () => {
    const t = normalizeDmTurn({ narration: 'Dusk.', scene_card: { place: 'the lane', people: { Hob: 'at the door' }, spots: { Hob: 'door' } }, state_changes: { gold: 40 }, directions: [{ speaker: 'Judy Hopps', direction: 'x' }], player_roll: { kind: 'check', skill: 'Stealth', vs: { who: 'Hob', skill: 'Perception', bonus: 2 } } });
    assert.equal(t.narration, 'Dusk.');
    assert.equal(t.scene_card.spots.Hob, 'door');
    assert.equal(t.state_changes.gold, 40);
    assert.deepEqual(t.player_roll.vs, { who: 'Hob', skill: 'Perception', bonus: 2 });
    assert.deepEqual(t.held, {});
});
