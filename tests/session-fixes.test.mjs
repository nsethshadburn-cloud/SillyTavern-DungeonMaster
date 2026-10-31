// What one bad session taught (v0.47): open country is land, a map can be asked for and redone,
// drawn maps take the land's theme, late fighters are tracked, advantage dice show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWildKind, wildsFromBrief, normalizeBrief, WILD_KINDS } from '../src/core/architect.js';
import { generateWilds, normalizePlan } from '../src/core/layout.js';
import { mapRequest, kindFromWords, ruleTriage } from '../src/core/triage.js';
import { themeFor, normalizeMap } from '../src/core/grid.js';
import { diceText } from '../src/core/dice.js';
import { createWorldState, startCombat, ensureEnemy, applyStateChanges } from '../src/core/world.js';
import { parseDmTurn, DM_RULES } from '../src/core/protocol.js';
import { applyPlaceChanges } from '../src/core/explore.js';
import { placeNear, toCoord } from '../src/core/grid.js';

test('open country and standing stones are land, not the generic house; buildings stay buildings', () => {
    for (const [kind, name] of [['downs', 'Ashen Downs'], ['standing stones', 'Ashen Downs Standing Stones'], ['', 'Ashen Downs Standing Stones'], ['the moor', 'Wolf Moor'], ['hills', 'The Grey Hills'], ['forest', 'Dark Wood'], ['wilderness', 'Nowhere'], ['open country', 'the plain'], ['woods', 'the trees']]) assert.ok(isWildKind(kind, name), `${kind || '(no kind)'} / ${name}`);
    for (const [kind, name] of [['mansion', 'Ashen Downs Manor'], ['', 'Blackmoor Manor'], ['site', 'The Old Mill'], ['cave', 'Hill Cave'], ['prison', 'Moor Gaol'], ['town', 'Hillcrest'], ['ruin', 'the ruin on the downs'], ['castle', 'Ridge Keep']]) assert.ok(!isWildKind(kind, name), `${kind || '(no kind)'} / ${name}`);
    assert.ok(!WILD_KINDS.test('blackmoor manor') && !WILD_KINDS.test('a bridge') && !WILD_KINDS.test('the campaign'));
});

test('a downs map is grass with few trees and a ring of standing stones; woods are thick', () => {
    const land = (kind, name, summary, size, seed) => generateWilds(normalizePlan(wildsFromBrief(normalizeBrief({ name, kind, size, summary, start: 'outside' }), seed)), seed);
    const downs = land('downs', 'Ashen Downs Standing Stones', 'Open downs at dusk, three standing stones on a rise, a stream.', 'small', 5);
    const woods = land('forest', 'Dark Wood', 'Deep woods with a stream.', 'small', 5);
    const trees = p => (p.floors[0].map.rows.join('').match(/T/g) || []).length / (p.floors[0].map.w * p.floors[0].map.h);
    assert.ok(trees(downs) < 0.18, `downs: ${trees(downs)}`);
    assert.ok(trees(woods) > trees(downs) * 2, `woods thicker: ${trees(woods)} vs ${trees(downs)}`);
    assert.ok(downs.floors[0].map.props.filter(p => p.label === 'standing stone').length >= 4, 'standing stones');
    assert.ok(/[~w]/.test(downs.floors[0].map.rows.join('')), 'a stream');
    assert.ok(downs.floors[0].map.w >= 32 && downs.floors[0].map.h >= 28, 'not a tiny map');
    const big = land('forest', 'Dark Wood', 'A large forest.', 'big', 2);
    assert.ok(big.floors[0].map.w >= 48, 'a big one is big');
});

test('asking for a map is understood, in or out of character, with its kind and size', () => {
    const a = mapRequest('Dudez seriously regenerate the map, make it a large map of woods. Thats all im asking. And mabey a stream or something.');
    assert.ok(a && a.kind === 'forest' && a.size === 'big' && a.redo);
    const b = mapRequest('Generate the new map!');
    assert.ok(b && b.redo && b.kind === '');
    const c = mapRequest('Make the map');
    assert.ok(c && !c.redo);
    assert.equal(mapRequest('can I see the map?'), null);
    assert.equal(mapRequest('we don\'t need a map here'), null);
    assert.equal(mapRequest('I walk north'), null);
    const t = ruleTriage('*(OOC)* I want you to rebuild the map now');
    assert.ok(t.ooc && t.mapRequest?.redo);
    const inChar = ruleTriage('Shut up judy, im busy talking to the god of this world... claude regenerate the map');
    assert.ok(inChar.mapRequest?.redo && !inChar.ooc);
    assert.ok(!ruleTriage('Judy, where is the map of the city?').mapRequest);
    assert.equal(kindFromWords('a small bandit camp in the hills'), 'camp');
    assert.equal(kindFromWords('open downs with standing stones'), 'downs');
    assert.equal(mapRequest('((regenerate the map with us in the wilderness))').kind, 'downs');
});

test('a drawn map without a theme takes the land it is on, never dungeon stone outdoors', () => {
    assert.equal(themeFor('wild', 'Ashen Downs Rise'), 'forest');
    assert.equal(themeFor('', 'the standing stones'), 'forest');
    assert.equal(themeFor('town', 'Brindlegate market'), 'town');
    assert.equal(themeFor('dungeon', 'the lower cells'), 'prison');
    assert.equal(themeFor('', 'Blackmoor Manor cellar'), 'mansion');
    assert.equal(themeFor('', ''), 'dungeon');
    assert.equal(normalizeMap({ rows: ['........'], theme: themeFor('wild', 'the downs') }).theme, 'forest');
});

test('an advantage roll shows both dice; the attack carries its target; a map can be replaced', () => {
    assert.equal(diceText({ die: 20, advantage: 'advantage', dice: [{ sides: 20, value: 18 }, { sides: 20, value: 7 }] }, 18), '(18, 7 → 18, advantage)');
    assert.equal(diceText({ die: 20, advantage: 'none', dice: [{ sides: 20, value: 11 }] }, 11), '(11)');
    assert.equal(diceText({ die: 20, advantage: 'advantage', dice: [{ sides: 20, value: 18 }] }, 18), '(18)');
    const t = parseDmTurn(JSON.stringify({ narration: 'x', player_roll: { kind: 'attack', skill: 'Shortsword', ability: 'DEX', dc: 12, damage: '1d6+5', target: 'Gaunt Raider' }, build_place: { name: 'Ashen Downs', kind: 'downs', size: 'big', why: 'redo', replace: true } }));
    assert.equal(t.player_roll.target, 'Gaunt Raider');
    assert.equal(t.build_place.replace, true);
    assert.equal(t.build_place.kind, 'downs');
    assert.ok(/"replace": true/.test(DM_RULES) && /cannot change, clear, shrink or replace it by narration/.test(DM_RULES) && /ALWAYS the turn the player asks for a map/.test(DM_RULES));
});

test('someone who joins a fight late is on the roster with HP, and damage to them counts', () => {
    const world = createWorldState();
    world.party = { Amber: { hp: 60, hp_max: 60, conditions: [] } };
    startCombat(world, { enemies: [] }, [], () => 0.5);
    assert.equal(Object.keys(world.combat.enemies).length, 0);
    const name = ensureEnemy(world, 'Gaunt Raider', { hp: 13, ac: 12, rng: () => 0.5 });
    assert.equal(name, 'Gaunt Raider');
    assert.equal(world.combat.enemies['Gaunt Raider'].hp, 13);
    assert.ok(world.combat.order.some(o => o.name === 'Gaunt Raider'), 'in the initiative order');
    assert.equal(ensureEnemy(world, 'the gaunt raider', { hp: 99 }), 'Gaunt Raider', 'the same one, not a second');
    assert.equal(world.combat.enemies['Gaunt Raider'].hp, 13);
    const log = applyStateChanges(world, { hp: { 'Gaunt Raider': -9 } }, ['Amber']);
    assert.equal(world.combat.enemies['Gaunt Raider'].hp, 4);
    assert.ok(log[0].includes('Gaunt Raider HP 13 → 4'));
    assert.equal(ensureEnemy({}, 'Nobody'), null, 'no fight, no roster');
});

test('a place change that names nothing says so instead of vanishing; a fighter with no square stands near the party', () => {
    const map = { w: 6, h: 6, rows: Array(6).fill('......'), theme: 'forest', props: [] };
    const place = { name: 'x', floors: [{ id: 'F0', name: 'x', level: 0, map }], rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {}, state: { positions: {}, explored: {}, floor: 'F0' } };
    const log = applyPlaceChanges(place, { doors: { D9: 'open' }, traps: { T4: 'found' }, items: { I2: 'taken' }, rooms: { G7: { lit: true } }, guards: { 'Gaunt Raider': 'alert' } });
    const warned = log.filter(l => l.startsWith('⚠️'));
    assert.equal(warned.length, 5, log.join(' | '));
    assert.ok(warned.some(l => /doors\.D9/.test(l)) && warned.some(l => /traps\.T4/.test(l)) && warned.some(l => /items\.I2/.test(l)) && warned.some(l => /rooms\.G7/.test(l)) && warned.some(l => /guards\.Gaunt Raider/.test(l)));
    const positions = placeNear(map, { Amber: toCoord(2, 2) }, ['Gaunt Raider'], { x: 2, y: 2 }, 3);
    assert.ok(positions['Gaunt Raider'], 'placed');
    assert.ok(/replace": true/.test(DM_RULES) && /WHAT DIDN'T TAKE/.test(DM_RULES) && /from the player's own hits/.test(DM_RULES));
});
