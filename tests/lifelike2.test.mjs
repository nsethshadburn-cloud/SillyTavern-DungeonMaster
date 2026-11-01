// v0.53: hostiles that respect hiding and Stealth and forget in time, noise that respects Stealth,
// a companion's eyes for traps, stalking and holding by code, a companion's own turn in a fight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlaceChanges, checkTriggers, hostileNotice, makeNoise, ageNotice, noticeTraps, moveHunters, dismountsInText, hideIn, addTrap } from '../src/core/explore.js';
import { companionCombatPrompt, parseCompanionCombat } from '../src/core/triage.js';

const open = (w, h) => Array(h).fill('.'.repeat(w));
const at = (x, y) => ({ floor: 'F0', x, y });
const make = (w = 24, h = 12) => ({
    name: 'x', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w, h, rows: open(w, h), theme: 'forest', props: [{ id: 'P1', x: 4, y: 3, type: 'boulder' }] } }],
    rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {},
    state: { positions: { Amber: at(3, 3), 'Judy Hopps': at(2, 3) }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0' },
});

test('a hostile does not see someone hidden, someone sneaking past its passive Perception, or someone a spot roll said it missed; it forgets after three turns unseen', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { 'Wolf 1': { at: 'k3', description: 'a grey wolf', hostile: true } } });
    assert.equal(hostileNotice(place, 'F0', ['Amber', 'Judy Hopps'], { stealth: { total: 14, natural: 11, who: 'Amber' }, player: 'Amber' }).length, 1, 'Judy is not sneaking: seen');
    delete place.guards['Wolf 1'].noticeBand;
    assert.equal(hostileNotice(place, 'F0', ['Amber'], { stealth: { total: 14, natural: 11, who: 'Amber' } }).length, 0, 'Amber sneaks past passive 10');
    assert.equal(hostileNotice(place, 'F0', ['Amber'], { stealth: { total: 7, natural: 4, who: 'Amber' } }).length, 1, 'a bad Stealth roll is seen');
    delete place.guards['Wolf 1'].noticeBand;
    place.guards['Wolf 1'].unaware = ['Amber'];
    assert.equal(hostileNotice(place, 'F0', ['Amber']).length, 0, 'a missed spot roll holds');
    delete place.guards['Wolf 1'].unaware;
    hideIn(place, 'Amber', 'P1');
    assert.equal(hostileNotice(place, 'F0', ['Amber']).length, 0, 'hidden behind the boulder');
    delete place.state.hidden.Amber;
    assert.equal(hostileNotice(place, 'F0', ['Amber']).length, 1);
    // out of sight for three turns: the next approach is news again
    place.state.positions.Amber = at(3, 11); place.state.positions['Judy Hopps'] = at(2, 11);
    place.floors[0].map.rows = place.floors[0].map.rows.map((r, i) => (i === 6 ? '#'.repeat(24) : r));
    for (let i = 0; i < 3; i++) ageNotice(place, 'F0', ['Amber', 'Judy Hopps']);
    assert.ok(!Number.isInteger(place.guards['Wolf 1'].noticeBand), 'forgotten');
});

test('the companion\'s eyes: a hidden trap beside her step is found when her passive Perception beats it, once', () => {
    const place = make();
    const t = addTrap(place, 'F0', 6, 3, { kind: 'bear trap', dc: 13, save: 'DEX', effect: '1d6', hidden: true });
    assert.equal(noticeTraps(place, 'F0', 'Judy Hopps', 5, 3, 12, 'Amber'), '', 'passive 12 misses DC 13');
    const found = noticeTraps(place, 'F0', 'Judy Hopps', 5, 3, 14, 'Amber');
    assert.ok(/Judy Hopps spots a hidden bear trap/.test(found), found);
    assert.equal(place.traps[t.id].state, 'found');
    assert.equal(noticeTraps(place, 'F0', 'Judy Hopps', 5, 3, 20, 'Amber'), '', 'found once');
});

test('noise: a broken door is heard within earshot and remembered, unless the Stealth roll beats their ears; a natural 20 is silent', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { Hob: { at: 'k3', description: 'a woodcutter' }, 'Far Guard': { at: 'x11', description: 'far off' } } });
    const heard = makeNoise(place, 'F0', 3, 3, { what: 'a door breaking', loud: 1, turn: 4 });
    assert.deepEqual(heard, ['Hob (7 squares off)']);
    assert.equal(place.guards.Hob.state, 'alert');
    assert.equal(place.guards.Hob.heard.what, 'a door breaking');
    place.guards.Hob.state = 'patrol'; delete place.guards.Hob.heard;
    assert.deepEqual(makeNoise(place, 'F0', 3, 3, { what: 'x', stealth: { total: 15, natural: 12 } }), [], 'a good Stealth roll keeps it quiet');
    assert.deepEqual(makeNoise(place, 'F0', 3, 3, { what: 'x', stealth: { total: 30, natural: 20 } }), [], 'a natural 20 is silent');
    assert.equal(makeNoise(place, 'F0', 3, 3, { what: 'x', stealth: { total: 9, natural: 3 } }).length, 1, 'a bad one is heard');
    assert.equal(makeNoise(place, 'F0', 3, 3, { what: 'x', loud: 3 }).length, 2, 'a loud one carries further');
});

test('stalking keeps four to six squares off, out of sight where it can; holding stands its ground', () => {
    const place = make(30, 12);
    applyPlaceChanges(place, { guards: { 'Wolf 1': { at: 'n3', description: 'a wolf', hostile: true, intent: 'stalking' }, 'Wolf 2': { at: 'n5', description: 'a wolf', hostile: true, intent: 'hold' } } });
    assert.equal(place.guards['Wolf 1'].intent, 'stalk');
    assert.equal(place.guards['Wolf 2'].intent, 'hold');
    const d = g => Math.max(Math.abs(g.x - 3), Math.abs(g.y - 3));
    for (let i = 0; i < 8; i++) moveHunters(place, 'F0', ['Amber', 'Judy Hopps'], 1);
    assert.ok(d(place.guards['Wolf 1']) >= 4 && d(place.guards['Wolf 1']) <= 6, `stalker at ${d(place.guards['Wolf 1'])}`);
    assert.deepEqual([place.guards['Wolf 2'].x, place.guards['Wolf 2'].y], [13, 4], 'the holder stays (n5 is x 13, y 4: rows are numbered from 1)');
    // the party walks away: the stalker keeps pace
    place.state.positions.Amber = at(20, 3); place.state.positions['Judy Hopps'] = at(19, 3);
    for (let i = 0; i < 12; i++) moveHunters(place, 'F0', ['Amber', 'Judy Hopps'], 1);
    // it shadows the nearer of the two (Judy, at x 19)
    const dd = Math.max(Math.abs(place.guards['Wolf 1'].x - 19), Math.abs(place.guards['Wolf 1'].y - 3));
    assert.ok(dd >= 4 && dd <= 6, `keeps pace: ${dd}`);
});

test('a rider gets down only when named: "he gets down on one knee" about someone else is not a dismount', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { 'Brown Mare': { at: 'c3', description: 'a brown mare' }, Hob: { at: 'd3', description: 'a carter' } }, ride: { Hob: 'Brown Mare' } });
    assert.deepEqual(dismountsInText(place, 'The jailer gets down on one knee and he climbs off the wagon.'), []);
    assert.deepEqual(dismountsInText(place, 'Hob swings down from the mare.'), ['Hob']);
});

test('a trigger whose target has left the map is dropped', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { 'Wolf 1': { at: 'l3', description: 'a wolf', hostile: true } }, triggers: [{ near: 'Wolf 1', radius: 2, note: 'x' }] });
    applyPlaceChanges(place, { guards: { 'Wolf 1': 'gone' } });
    checkTriggers(place, 'F0', ['Amber']);
    assert.equal(place.state.triggers.length, 0);
});

test("a companion's turn: the local model is fed real options and its answer is checked against them", () => {
    const foes = [{ name: 'Wolf 1', hp: 4, hpMax: 11, ac: 13, dist: 1 }, { name: 'Wolf 2', hp: 11, hpMax: 11, ac: 13, dist: 5 }];
    const allies = [{ name: 'Amber', hp: 2, hpMax: 20, dist: 2, down: false }];
    const weapons = [{ name: 'baton', damage: '1d6+2', range: '' }, { name: 'sling', damage: '1d4+2', range: '30/120' }];
    const { user } = companionCombatPrompt({ name: 'Judy Hopps', hp: 15, hpMax: 18, foes, allies, weapons, items: ['healing potion'], player: 'Amber' });
    assert.ok(/Wolf 1 \(HP 4\/11, AC 13, 1 square away, in reach\)/.test(user) && /baton \(1d6\+2\)/.test(user) && /healing potion/.test(user), user);
    assert.deepEqual(parseCompanionCombat('{"action":"attack","target":"wolf 1","weapon":"Baton","why":"finish it"}', { foes, allies, weapons, items: [] }), { action: 'attack', target: 'Wolf 1', weapon: 'baton', item: '', where: '', why: 'finish it' });
    // a dagger at range becomes the sling; an unknown target becomes the nearest; junk becomes a sensible attack
    assert.equal(parseCompanionCombat('{"action":"attack","target":"Wolf 2","weapon":"baton"}', { foes, allies, weapons, items: [] }).weapon, 'sling');
    assert.equal(parseCompanionCombat('{"action":"attack","target":"the dragon"}', { foes, allies, weapons, items: [] }).target, 'Wolf 1');
    assert.equal(parseCompanionCombat('nonsense', { foes, allies, weapons, items: [] }).action, 'attack');
    assert.equal(parseCompanionCombat('{"action":"help"}', { foes, allies, weapons, items: [] }).target, 'Amber');
    assert.equal(parseCompanionCombat('{"action":"use","item":"potion"}', { foes, allies, weapons, items: ['healing potion'] }).item, 'healing potion');
    assert.equal(parseCompanionCombat('{"action":"use"}', { foes, allies, weapons, items: [] }).action, 'hold');
    assert.equal(parseCompanionCombat('{"action":"attack"}', { foes: [], allies, weapons, items: [] }).action, 'hold');
});

test('a Stealth roll quiets only what the player did where they stand, not a door breaking across the map', () => {
    const place = make();
    applyPlaceChanges(place, { guards: { Hob: { at: 'k3', description: 'a woodcutter' } } });
    const stealth = { total: 18, natural: 15, who: 'Amber', at: { x: 3, y: 3 } };
    assert.deepEqual(makeNoise(place, 'F0', 3, 3, { what: 'a lock forced', stealth }), [], 'quiet at their own square');
    assert.equal(makeNoise(place, 'F0', 9, 3, { what: 'a door breaking', stealth }).length, 1, 'heard six squares away from them');
});
