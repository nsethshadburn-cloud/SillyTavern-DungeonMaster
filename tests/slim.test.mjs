// v0.70: the slim build. The story is the truth outside a fight: the sketch is drawn from the
// scene card and decides nothing; a place or a thing named as a person is refused; the DM's
// contract has no place keys; dice formulas merge; coin changes hands on the books.
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePlace, looksLikeThing, notAPerson } from '../src/core/people.js';
import { buildSketch, propForObject, zoneOf, moveOnSketch, sketchMap, ZONES } from '../src/core/sketch.js';
import { normalizeSceneCard, applySceneCard, emptySceneCard, samePlace } from '../src/core/state.js';
import { normalizeNotation, parsePlayerRoll } from '../src/core/dice.js';
import { parseBookkeeping, bookkeeperPrompt, tidyBookkeeping } from '../src/core/bookkeeper.js';
import { BIBLE_INSTRUCTIONS, DM_RULES, normalizeDmTurn, parseDmTurn } from '../src/core/protocol.js';
import { createWorldState } from '../src/core/world.js';
import { isWalkable, parseCoord } from '../src/core/grid.js';
import { TASKS, defaultTaskModels } from '../src/core/models.js';
import { themeFor } from '../src/core/grid.js';
import { presetFor, lookForNpc } from '../src/core/sprites.js';
import { ruleTriage, grabsSomeone } from '../src/core/triage.js';
import { dmReasons, createPacingState } from '../src/core/pacing.js';

// v0.71 (live test 10): the sketch follows a reworded place; a yard is outdoors; a shop among the objects is
// no prop; a man with animal words is a man; coin changing hands is the DM's by rule.
test('a reworded place name is the same place', () => {
    assert.ok(samePlace('Eel Street', 'Eel Street, Marrow Ford'));
    assert.ok(samePlace("Tusk's Locksmith Shop", "Olwen Tusk's Locksmith Shop, Eel Street"));
    assert.ok(!samePlace('Eel Street', 'The Drowned Eel'));
    assert.ok(!samePlace("Tusk's shop", 'the back room'));
});

test('a yard is outdoors whatever building it belongs to; a street is still a street', () => {
    assert.equal(themeFor('town', 'inn yard behind the Drowned Eel'), 'town');
    assert.equal(themeFor('town', "the manor's walled garden"), 'town');
    assert.equal(themeFor('town', 'the Drowned Eel, common room'), 'tavern');
    assert.equal(themeFor('town', "Tusk's shop on Eel Street"), 'house');
});

test('a place among the objects is never a prop, whatever hangs on it', () => {
    assert.equal(propForObject("Locksmith's shop", 'shuttered front, a lamp lit over the door'), '');
    assert.equal(propForObject('The Drowned Eel', 'the inn across the lane, windows glowing'), '');
    assert.equal(propForObject('Rain barrel', 'by the shop wall'), 'barrel');
});

test('a man described with animal words is drawn as a man; an animal by name stays one', () => {
    assert.equal(presetFor('Hob a bull-necked man with a boar\'s grin, Tusk\'s bruiser'), 'cow');
    assert.equal(presetFor('Hob a bull-necked man with a boar\'s grin, Tusk\'s bruiser', { person: true }), 'human_brute');
    assert.ok(!lookForNpc('Hob', "a bull-necked man with a boar's grin, Tusk's bruiser", 'human_thug').beast);
    assert.ok(!lookForNpc('Hob', "a bull-necked man with a boar's grin, Tusk's bruiser").beast, 'no sprite given: still a man');
    assert.ok(lookForNpc('Brown Mare', "the captain's horse, a steady bay").beast, 'an animal by name');
    assert.ok(lookForNpc('Gutter Crow', 'a crow that follows the party').beast);
});

test('v0.72: a grab in any line is a contest; a hand on a thing is not', () => {
    for (const line of ['((One of the watchmen corners Amber in the inn yard at dawn and tries to grab him))', '*Hob lunges for Amber\'s collar.*', '*Amber tackles him.*', '((the warden seizes Judy by the ears))']) {
        assert.ok(grabsSomeone(line), line);
        assert.ok(ruleTriage(line, { player: 'Amber', companions: ['Judy Hopps'] }).contest, line);
    }
    for (const line of ['*Amber grabs the ledger and runs.*', '*Amber grabs the rope.*', '"Grab a seat."']) assert.ok(!grabsSomeone(line), line);
    assert.ok(!ruleTriage('*Amber tackles him.*', { player: 'Amber', inCombat: true }).contest, 'in a fight the round runs it');
    const reasons = dmReasons({ pacing: createPacingState(), triage: { category: 'question', ooc: true, contest: true }, eventDue: false, checkinEvery: 5, budgetBlocked: false, budgetTight: false });
    assert.ok(reasons.includes('contest'));
});

test('v0.72: a card for another place replaces the old card; a town sketch is cobbles', () => {
    const street = applySceneCard(null, normalizeSceneCard({ place: 'wet cobbled lane on Eel Street, lamps lit', people: { Hob: 'at the inn door' }, spots: { Hob: 'across' }, objects: { 'Rain barrel': 'by the wall' } }), { partyNames: ['Amber'] });
    const shop = applySceneCard(street, normalizeSceneCard({ place: 'front room of a locksmith shop, one lamp', people: { 'Olwen Tusk': 'behind the counter' }, spots: { 'Olwen Tusk': 'across' }, objects: { counter: 'scarred oak' } }), { partyNames: ['Amber'] });
    assert.equal(shop.objects['Rain barrel'], undefined, 'the street\'s barrel stays on the street');
    assert.equal(shop.people.Hob, undefined);
    assert.ok(shop.objects.counter && shop.people['Olwen Tusk']);
    const relit = applySceneCard(shop, normalizeSceneCard({ place: 'front room of a locksmith shop, lamp out', objects: { 'back door': 'locked' } }), { partyNames: ['Amber'] });
    assert.ok(relit.objects.counter, 'the same room in new light keeps its things');
    assert.ok(sketchMap('town').rows.join('').includes('='), 'cobbles');
    assert.ok(!sketchMap('town').rows.join('').includes(','), 'no grass');
    assert.ok(sketchMap('forest').rows.join('').includes(','));
});

test('coin changing hands is the DM\'s by rule, outside a fight', () => {
    for (const line of ['"Two rooms for the night, and a hot meal."', '*Amber sets coins on the bar.* "Name the price and I\'ll pay it."', '"How much for the lantern?"', 'I buy the rope.']) {
        const r = ruleTriage(line, { player: 'Amber', companions: ['Judy Hopps'] });
        assert.equal(r.category, 'risky_action', line);
        assert.ok(r.trade, line);
        assert.ok(r.needsHelper, 'the helper still picks who answers');
    }
    for (const line of ['"I\'ll take a hooded lantern, if you have one. How much?"', '*Amber counts out the coin and sets it on the counter.* "Five silver it is."', '"What do we owe you?"']) assert.ok(ruleTriage(line, { player: 'Amber' }).trade, line);
    assert.ok(!ruleTriage('"Hello there."', { player: 'Amber' }).trade);
    assert.ok(!ruleTriage('I buy the rope.', { player: 'Amber', inCombat: true }).trade, 'not mid-fight');
    const reasons = dmReasons({ pacing: createPacingState(), triage: { category: 'risky_action', trade: true }, eventDue: false, checkinEvery: 5, budgetBlocked: false, budgetTight: false });
    assert.ok(reasons.includes('trade'));
});

test('a place or a thing named as a person is refused; a being by its words is not', () => {
    for (const n of ["Olwen Tusk's Locksmith Shop", 'Eel Street', 'The Gilded Lantern inn', 'The Drowned Eel Inn', 'the back room']) assert.ok(looksLikePlace(n), n);
    for (const n of ['Hob', 'Olwen Tusk', 'Innkeeper Bram', 'Gate Watch Soldier', 'a grey parrot', 'Brown Mare']) assert.ok(!notAPerson(n), n);
    assert.ok(looksLikeThing('Silver Candlesticks'));
    assert.ok(looksLikeThing('the ledger'));
    assert.ok(!looksLikeThing('Lantern Jack, the fence'), 'a being word wins');
});

test('the scene card carries spots, in the sketch\'s words only', () => {
    assert.deepEqual(emptySceneCard(), { place: '', people: {}, spots: {}, objects: {} });
    const card = normalizeSceneCard({ place: 'the taproom of the Drowned Eel, lamplight', people: { 'Judy Hopps': 'at your elbow', Hob: 'by the door, arms folded' }, spots: { 'Judy Hopps': 'beside', Hob: 'door', Scald: 'nowhere', Ghost: 'across' }, objects: { 'the ledger': 'under the counter' } });
    assert.deepEqual(card.spots, { 'Judy Hopps': 'beside', Hob: 'door', Ghost: 'across' }, 'a word not in the list is dropped');
    const applied = applySceneCard(null, card, { partyNames: ['Amber', 'Judy Hopps'] });
    assert.deepEqual(applied.spots, { 'Judy Hopps': 'beside', Hob: 'door' }, 'a spot for someone not in the card is noise');
    const moved = applySceneCard(applied, normalizeSceneCard({ people: { Hob: '' }, spots: { 'Judy Hopps': 'near' } }), { partyNames: ['Amber', 'Judy Hopps'] });
    assert.equal(moved.spots.Hob, undefined, 'gone from the card, gone from the spots');
    assert.equal(moved.spots['Judy Hopps'], 'near');
    const elsewhere = applySceneCard(moved, normalizeSceneCard({ place: 'Eel Street at dusk', people: { Scald: 'leaning on the wall' }, spots: { Scald: 'across' } }), { newPlace: true, partyNames: ['Amber', 'Judy Hopps'] });
    assert.deepEqual(Object.keys(elsewhere.spots).sort(), ['Judy Hopps', 'Scald'], 'a new place keeps the party\'s spots and the new people');
    assert.equal(zoneOf(card.spots, 'judy hopps'), 'beside');
    assert.equal(zoneOf(card.spots, 'Nobody', { companion: true }), 'beside', 'a companion with no spot stands beside the player');
    assert.equal(zoneOf(card.spots, 'Nobody'), 'near', 'anyone else, near');
    assert.deepEqual(ZONES, ['beside', 'near', 'across', 'door', 'outside']);
});

test('the sketch: a room or open ground, the player at home, everyone in their zone, objects as props, stable turn to turn', () => {
    const world = { ...createWorldState(), location: 'The Drowned Eel', setting: 'town' };
    const card = applySceneCard(null, normalizeSceneCard({
        place: 'the taproom of the Drowned Eel, lamplight and smoke',
        people: { 'Judy Hopps': 'at your elbow', Hob: 'by the door', Scald: 'across the room', Tusk: 'in the back room, unseen' },
        spots: { 'Judy Hopps': 'beside', Hob: 'door', Scald: 'across', Tusk: 'outside' },
        objects: { 'the bar': 'a long counter, sticky', 'a hooded lantern': 'on a hook by the stair', 'Silver Candlesticks': 'on the mantel' },
    }), { partyNames: ['Amber', 'Judy Hopps'] });
    const s = buildSketch(card, { world, player: 'Amber', party: ['Judy Hopps'] });
    assert.ok(s, 'a sketch');
    assert.equal(s.map.theme, 'tavern');
    // v0.74: a thing in someone's pack is not on the floor.
    assert.ok(s.objects['a hooded lantern'], 'the lantern on its hook is drawn');
    assert.equal(buildSketch(card, { world, player: 'Amber', party: ['Judy Hopps'], carried: ['A Hooded Lantern'] }).objects['a hooded lantern'], undefined, 'bought, it is in the pack, not on the floor');
    assert.equal(s.map.rows[s.map.h - 1][6], '+', 'a door at the bottom middle');
    const amber = parseCoord(s.positions.Amber, s.map), judy = parseCoord(s.positions['Judy Hopps'], s.map), hob = parseCoord(s.positions.Hob, s.map), scald = parseCoord(s.positions.Scald, s.map);
    assert.deepEqual(amber, { x: 6, y: 3 });
    assert.equal(Math.max(Math.abs(judy.x - amber.x), Math.abs(judy.y - amber.y)), 1, 'beside: one square off');
    assert.equal(hob.y, 1, 'at the door: just inside it');
    assert.ok(scald.y >= s.map.h - 4, 'across: the far side');
    assert.equal(s.positions.Tusk, undefined, 'outside: not drawn');
    assert.ok(s.map.props.some(p => p.type === 'counter' && p.label === 'the bar'), 'the bar is a counter');
    assert.ok(s.map.props.some(p => p.type === 'torch'), 'a lantern hangs as a torch');
    assert.ok(!s.map.props.some(p => p.label === 'Silver Candlesticks'), 'candlesticks have no prop: left out, not invented');
    for (const [n, cd] of Object.entries(s.positions)) assert.ok(isWalkable(s.map, parseCoord(cd, s.map).x, parseCoord(cd, s.map).y), `${n} stands on an open square`);
    // The same card again: the same picture, square for square.
    const again = buildSketch(card, { world, player: 'Amber', party: ['Judy Hopps'], previous: s });
    assert.deepEqual(again.positions, s.positions);
    assert.deepEqual(again.map.props, s.map.props);
    // Hob walks over: his zone changes, his square changes, nobody else moves.
    const closer = applySceneCard(card, normalizeSceneCard({ spots: { Hob: 'beside' } }), { partyNames: ['Amber', 'Judy Hopps'] });
    const s2 = buildSketch(closer, { world, player: 'Amber', party: ['Judy Hopps'], previous: again });
    const hob2 = parseCoord(s2.positions.Hob, s2.map);
    assert.equal(Math.max(Math.abs(hob2.x - amber.x), Math.abs(hob2.y - amber.y)), 1);
    assert.equal(s2.positions['Judy Hopps'], s.positions['Judy Hopps']);
    assert.equal(s2.positions.Scald, s.positions.Scald);
    // A new place: a new picture.
    const street = applySceneCard(closer, normalizeSceneCard({ place: 'Eel Street at dusk, rain', people: { Hob: 'following' }, spots: { Hob: 'near' } }), { newPlace: true, partyNames: ['Amber', 'Judy Hopps'] });
    const s3 = buildSketch(street, { ...{ world: { ...world, location: 'Eel Street' } }, player: 'Amber', party: ['Judy Hopps'], previous: s2 });
    assert.notEqual(s3.key, s2.key);
    assert.equal(s3.map.theme, 'town');
    assert.ok(!s3.map.rows.join('').includes('#'), 'open ground has no walls');
    assert.equal(s3.positions.Scald, undefined, 'Scald stayed in the inn');
    // A companion away isn't drawn; one on the player's square is moved aside.
    const away = buildSketch(street, { world, player: 'Amber', party: ['Judy Hopps'], away: ['Judy Hopps'] });
    assert.equal(away.positions['Judy Hopps'], undefined);
    // Taps and fights.
    assert.ok(moveOnSketch(s3, 'Amber', 3, 3));
    assert.equal(s3.positions.Amber, 'd4');
    assert.ok(!moveOnSketch(s, 'Amber', 0, 0), 'a wall is not a square to stand on');
    assert.equal(buildSketch(null, { world, player: 'Amber' }), null, 'no card, no sketch');
    assert.equal(sketchMap('forest').theme, 'forest');
});

test('objects become the props the painter knows', () => {
    assert.equal(propForObject('the hearth', 'a fire burning low'), 'fireplace');
    assert.equal(propForObject('the fire', 'a ring of stones, burning low'), 'campfire');
    assert.equal(propForObject('Dawnlamp', 'squat brass lamp on the table'), 'torch');
    assert.equal(propForObject('the ledger', 'leather, under the counter'), '');
    assert.equal(propForObject('an iron-bound chest', ''), 'chest');
});

test('the DM\'s contract has no places: the keys that moved the world by op are gone', () => {
    const t = normalizeDmTurn({ narration: 'x', build_place: { name: 'Blackmoor' }, enter_place: 'the inn', place_changes: { doors: {} }, escort: {}, map_effects: {}, scene_map: { rows: [] }, positions: { Amber: 'd4' }, scene_card: { place: 'x', spots: { Amber: 'beside' } } });
    for (const k of ['build_place', 'enter_place', 'leave_place', 'place_changes', 'escort', 'map_effects', 'scene_map']) assert.equal(k in t, false, k);
    assert.deepEqual(t.positions, { Amber: 'd4' }, 'positions stay for fights');
    assert.equal(t.scene_card.spots.Amber, 'beside');
    assert.doesNotMatch(DM_RULES, /place_changes|build_place|enter_place|CUSTODY:|KEPT:|TRIGGERS:|HOSTILES SEE/);
    assert.match(DM_RULES, /"spots"/);
    assert.match(DM_RULES, /Contests between people are rolls/);
    assert.match(DM_RULES, /Going in and out is the story's/);
    assert.match(DM_RULES, /leave out start_combat\.map to fight on the sketch/);
    assert.ok(DM_RULES.length < 45000, `the rules are far shorter than the 74k they were (${DM_RULES.length} chars)`);
    assert.match(BIBLE_INSTRUCTIONS, /"start": \{"gold"/);
    assert.match(BIBLE_INSTRUCTIONS, /"conditions": \{/);
    assert.match(BIBLE_INSTRUCTIONS, /"spots"/);
    assert.ok(!TASKS.some(t => ['referee', 'build_place', 'map_brief', 'map_sync', 'explore'].includes(t.key)));
    assert.equal(Object.keys(defaultTaskModels()).includes('referee'), false);
    const sc = parseDmTurn('{"start_combat": {"enemies": [{"name": "Hob", "ac": 12, "hp": 11}]}}');
    assert.equal(sc.start_combat.map, null, 'no rows, no map: the fight is on the sketch');
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

test('coin changes hands: the bookkeeper\'s gold, only when the story has coin in it; restraints are its to fill in now', () => {
    const known = { names: ['Amber', 'Olwen Tusk'], itemNames: ['Amber'], conditionsOf: () => [], itemsOf: () => [], allItems: [] };
    assert.deepEqual(parseBookkeeping('{"items_add": {"Amber": ["hooded lantern"]}, "gold": -0.5}', { ...known, story: 'Amber pays five silver and takes the hooded lantern.' }), { items_add: { Amber: ['hooded lantern'] }, gold: -0.5 });
    assert.equal(parseBookkeeping('{"gold": -3}', { ...known, story: 'Amber looks at the lantern and leaves.' }), null, 'no coin in the story, no change');
    assert.equal(parseBookkeeping('{"gold": 9000}', { ...known, story: 'Amber pays for the room.' }), null, 'a fortune from a mention is no change');
    assert.match(bookkeeperPrompt({ status: [], story: 'x' }).user, /"gold": 0/);
    // v0.73: the DM booked the lantern this turn; the bookkeeper's same coin is not a second charge.
    assert.equal(parseBookkeeping('{"gold": -0.5}', { ...known, story: 'Amber pays five silver for the lantern.', goldBooked: true }), null, 'coin the DM already booked is skipped');
    assert.deepEqual(parseBookkeeping('{"items_add": {"Amber": ["hooded lantern"]}, "gold": -0.5}', { ...known, story: 'Amber pays five silver and takes the hooded lantern.', goldBooked: true }), { items_add: { Amber: ['hooded lantern'] } }, 'the item still lands');
    assert.match(bookkeeperPrompt({ status: [], story: 'x', gold: 39.5 }).user, /^Party gold: 39\.5/m, 'the bookkeeper sees the gold');
    assert.doesNotMatch(bookkeeperPrompt({ status: [], story: 'x' }).user, /^Party gold:/m);
    const tidy = tidyBookkeeping({ conditions_add: { Amber: ['cuffed', 'unconscious', 'prone'] } }, { party: ['Amber'] });
    assert.deepEqual(tidy.conditions_add, { Amber: ['cuffed', 'prone'] }, 'cuffs and prone from the narration; out cold stays the dice\'s and the DM\'s');
});
