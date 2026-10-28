// Run with: node --test tests/
// v0.25: the map algorithm (a short brief, the code builds the place) and the common-sense rules
// every plan goes through.
import test from 'node:test';
import assert from 'node:assert/strict';

import { planFromBrief, normalizeBrief, blueprintFor, townFromBrief, wildsFromBrief } from '../src/core/architect.js';
import { normalizePlan, generatePlace, generateTown, normalizeTownPlan, generateWilds, generateInterior, reachable } from '../src/core/layout.js';
import { applyRules, checkPlace, RULES } from '../src/core/rules.js';
import { describeRoom, cleanDescription } from '../src/core/describe.js';
import { looksLikeThing, placePerson, moveHunters } from '../src/core/explore.js';
import { applyStateChanges } from '../src/core/world.js';

const build = (brief, seed) => generatePlace(normalizePlan(planFromBrief(normalizeBrief(brief), seed)), seed);

test('a jail you start locked in: one barred, locked cell door and nothing else; the keys are outside', () => {
    for (const seed of [1, 7, 77, 123]) {
        const place = build({ name: 'Ironhold Gaol', kind: 'jail', size: 'medium', start: 'locked in a cell', people: [{ name: 'Warden Grath', what: 'the warden', where: "warden's office", hostile: true }] }, seed);
        assert.deepEqual(checkPlace(place), [], `seed ${seed}: walls solid, cells right`);
        const cell = place.rooms[place.start.room];
        assert.equal(cell.type, 'cell', 'they start in a cell');
        const doors = Object.values(place.doors).filter(d => d.rooms.includes(cell.id) && d.kind !== 'secret');
        assert.equal(doors.length, 1, 'one door');
        assert.equal(doors[0].kind, 'cell');
        assert.equal(doors[0].state, 'locked');
        // With the cell doors really shut, nothing past the bars can be reached.
        const shut = { ...place, doors: Object.fromEntries(Object.entries(place.doors).map(([k, d]) => [k, d.kind === 'cell' ? { ...d, kind: 'locked', key: 'none' } : d])) };
        assert.deepEqual(reachable(shut).roomsReached, [cell.id]);
        assert.ok(Object.values(place.items).some(i => /cell keys/.test(i.name) && i.room !== cell.id), 'the cell keys are kept outside the cell');
        assert.ok(place.guards['Warden Grath'], 'the warden is on the map from the start');
    }
});

test('the rules fix a careless plan: a cell with a plain door, a vault left open, a bedroom used as a corridor, stairs in a bathroom', () => {
    const plan = normalizePlan({
        name: 'Careless Keep', kind: 'castle',
        floors: [{ id: 'G', level: 0 }, { id: 'U', level: 1 }],
        rooms: [
            { id: 'A', name: 'Hall', type: 'foyer', floor: 'G', exit: true },
            { id: 'C', name: 'The Cell', type: 'cell', floor: 'G' },
            { id: 'V', name: 'Treasury', type: 'vault', floor: 'G' },
            { id: 'B', name: 'Bedroom', type: 'bedroom', floor: 'G' },
            { id: 'S', name: 'Study', type: 'study', floor: 'G' },
            { id: 'K', name: 'Library', type: 'library', floor: 'G' },
            { id: 'W', name: 'Bath', type: 'bathroom', floor: 'U' },
            { id: 'L', name: 'Landing', type: 'hallway', floor: 'U' },
        ],
        links: [{ a: 'A', b: 'C', via: 'door' }, { a: 'C', b: 'K', via: 'door' }, { a: 'A', b: 'V', via: 'door' }, { a: 'A', b: 'B', via: 'door' }, { a: 'B', b: 'S', via: 'door' }, { a: 'B', b: 'K', via: 'door' }, { a: 'A', b: 'W', via: 'stairs' }, { a: 'W', b: 'L', via: 'door' }],
        start: 'A',
    });
    const linksOf = id => plan.links.filter(l => l.a === id || l.b === id);
    assert.deepEqual(linksOf('C').map(l => l.via), ['cell'], 'the cell has one cell door');
    assert.ok(plan.rooms.find(r => r.cellBlock), 'onto a cell block');
    assert.equal(linksOf('V').filter(l => l.via !== 'secret').length, 1);
    assert.equal(linksOf('V')[0].via, 'locked', 'the treasury is locked');
    assert.ok(plan.rooms.some(r => r.items.some(i => i.name === linksOf('V')[0].key)), 'its key is somewhere');
    assert.ok(linksOf('B').length <= 2, 'the bedroom is no corridor');
    assert.ok(!plan.links.some(l => l.via === 'stairs' && (l.a === 'W' || l.b === 'W')), 'no stairs in the bath');
    assert.ok(plan.fixes.length >= 4, 'it says what it fixed');
    const place = generatePlace(plan, 3);
    assert.deepEqual(checkPlace(place), []);
    assert.equal(RULES.length, 12);
});

test('places of every kind build cleanly, every room reachable, solid walls', () => {
    const kinds = ['prison', 'mansion', 'castle', 'temple', 'tavern', 'house', 'wizard tower', 'library', 'bank', 'barracks', 'shop', 'smithy', 'dungeon', 'crypt', 'cave', 'ship'];
    for (const kind of kinds) for (const size of ['small', 'medium', 'big']) for (const seed of [1, 2]) {
        const place = build({ name: `${kind} ${seed}`, kind, size, start: seed === 2 ? 'outside' : '' }, seed);
        assert.ok(place, `${kind}/${size}/${seed} built`);
        assert.deepEqual(checkPlace(place), [], `${kind}/${size}/${seed}`);
        assert.equal(reachable(place).roomsReached.length, Object.keys(place.rooms).length, `${kind}/${size}/${seed}: every room reachable`);
    }
});

test('no two places feel the same: different seeds, different rooms, names, twists', () => {
    const sets = new Set(), twists = new Set();
    for (let seed = 1; seed <= 20; seed++) {
        const raw = planFromBrief(normalizeBrief({ name: 'Manor', kind: 'mansion', size: 'medium' }), seed);
        sets.add(raw.rooms.map(r => r.name).sort().join('|'));
        for (const t of raw.architect.twists) twists.add(t.replace(/[A-Z][a-z']+( [A-Z][a-z']+)*/g, 'X').slice(0, 30));
    }
    assert.equal(sets.size, 20, 'twenty different mansions');
    assert.ok(twists.size >= 5, `several kinds of twist (${twists.size})`);
    // The same brief and seed is the same place.
    assert.deepEqual(planFromBrief(normalizeBrief({ name: 'Manor', kind: 'mansion' }), 9), planFromBrief(normalizeBrief({ name: 'Manor', kind: 'mansion' }), 9));
});

test('the brief: the story\'s rooms, people, locks and secrets are where it says', () => {
    const raw = planFromBrief(normalizeBrief({
        name: 'Hollowmere Manor', kind: 'mansion', size: 'medium', start: 'outside',
        rooms: [{ room: 'study', has: ['the forged will'], hidden: true }],
        people: [{ name: 'Lady Vess', what: 'the widow, hiding something', where: 'parlor' }, { name: 'Brute', what: 'a hired thug', where: 'kitchen', hostile: true }],
        locked: [{ room: 'study', key: 'brass study key', key_in: 'master bedroom' }],
        secrets: [{ from: 'library', to: 'hidden chapel', how: 'behind a bookshelf' }],
    }), 4);
    const study = raw.rooms.find(r => r.type === 'study' && r.items.some(i => i.name === 'the forged will'));
    assert.ok(study, 'the will is in the study');
    const lock = raw.links.find(l => (l.a === study.id || l.b === study.id) && l.via === 'locked');
    assert.equal(lock?.key, 'brass study key');
    assert.ok(raw.rooms.find(r => r.type === 'master_bedroom').items.some(i => i.name === 'brass study key'));
    assert.equal(raw.people.find(p => p.name === 'Lady Vess').room, raw.rooms.find(r => r.type === 'parlor').id);
    assert.ok(raw.guards.some(g => g.name === 'Brute'));
    assert.ok(raw.links.some(l => l.via === 'secret' && [l.a, l.b].some(id => raw.rooms.find(r => r.id === id)?.name === 'Hidden chapel')), 'the hidden chapel behind the library');
    assert.equal(raw.rooms.find(r => r.id === raw.start).type, 'courtyard', 'arriving: they start outside');
    assert.match(raw.summary, /Hollowmere Manor/);
});

test('briefs from a small model: junk and missing fields still build the place asked for', () => {
    const b = normalizeBrief({ size: 'huge', floors: null, guards: null, people: 'nope', rooms: [{ nothing: 1 }] }, { name: 'The Rat Hole', kind: 'tavern', size: 'big' });
    assert.equal(b.name, 'The Rat Hole');
    assert.equal(b.kind, 'tavern');
    assert.equal(b.size, 'big');
    assert.equal(b.floors, null, 'no floor count is not "1 floor"');
    assert.equal(b.guards, null, 'no guard count is not "no guards"');
    assert.deepEqual(normalizeBrief(b), b, 'normalizing twice changes nothing');
    assert.equal(blueprintFor('guard post', 'Watch House').id, 'barracks', 'the kind wins over a house-like name');
    assert.equal(blueprintFor('', 'Castle Dunmere').id, 'castle');
});

test('towns, wild places and town buildings come from the algorithm too', () => {
    const town = generateTown(normalizeTownPlan(townFromBrief(normalizeBrief({ name: 'Brindle', kind: 'town', size: 'medium', people: [{ name: 'Old Hask', what: 'a retired smith' }] }), 3)), 3);
    const kinds = Object.values(town.buildings).map(b => b.kind);
    assert.ok(kinds.includes('tavern') && kinds.includes('general store'), 'somewhere to drink and to buy');
    assert.ok(Object.values(town.buildings).some(b => b.keeper === 'Old Hask'), 'the story\'s people live there');
    const wild = generateWilds(normalizePlan(wildsFromBrief(normalizeBrief({ name: 'Greenmaw', kind: 'jungle', size: 'medium' }), 5)), 5);
    assert.ok(Object.keys(wild.rooms).length >= 5);
    const forge = generateInterior({ name: 'The Red Anvil', kind: 'smithy', keeper: 'Bryn' }, 2);
    assert.ok(forge.floors[0].map.props.some(p => p.type === 'forge'), 'a smithy has its forge');
    assert.ok(forge.guards.Bryn, 'the keeper is inside');
});

test('rooms are described when first entered: from their facts, varied, cleaned up', () => {
    const a = describeRoom({ id: 'R1', name: 'Cell 2', type: 'cell', lit: false, hint: 'one stone sits loose' }, { things: ['wall shackles', 'food bowl'], placeName: 'Gaol' });
    assert.match(a, /There are wall shackles and a food bowl here\./);
    assert.match(a, /One stone sits loose\./);
    assert.notEqual(describeRoom({ id: 'R1', name: 'Library', type: 'library', lit: true }, { placeName: 'A' }), describeRoom({ id: 'R9', name: 'Library', type: 'library', lit: true }, { placeName: 'B' }));
    assert.equal(cleanDescription('Description: "Dust hangs in the air. Old books sag on the shelves. A third sentence."'), 'Dust hangs in the air. Old books sag on the shelves.');
    assert.equal(cleanDescription('ok'), '');
});

test('items are never people on the map; newcomers come in out of sight; lingering conditions don\'t flicker', () => {
    for (const n of ['Tin of lamp oil', 'a brass key', 'Ledger', 'Torch']) assert.ok(looksLikeThing(n), n);
    for (const n of ['Graves the Butler', 'Guard Dog', 'Kennel Master', 'Bandit 1', 'Old Martha', 'Brother Aldous']) assert.ok(!looksLikeThing(n), n);
    const place = build({ name: 'Inn', kind: 'tavern', size: 'medium' }, 5);
    place.fog = false;
    const lead = place.start;
    place.state.positions = { Amber: { floor: lead.floor, x: lead.x, y: lead.y } };
    assert.equal(placePerson(place, 'Tin of lamp oil', { floor: lead.floor, x: lead.x + 1, y: lead.y }), null);
    const g = placePerson(place, 'Thug', { floor: lead.floor, x: lead.x + 1, y: lead.y }, { arrive: true, info: { hostile: true } });
    assert.ok(g && (Math.abs(g.x - lead.x) > 1 || Math.abs(g.y - lead.y) > 1), 'not right beside the party');
    assert.ok(g.goal, 'on their way to where they were meant to be');
    for (let i = 0; i < 40 && g.goal; i++) moveHunters(place, lead.floor, ['Amber'], 1);
    assert.ok(Math.max(Math.abs(g.x - lead.x), Math.abs(g.y - lead.y)) <= 2, 'they walk in');
    const w = { party: { Amber: { hp: 10, hp_max: 10, conditions: ['groggy'] } } };
    applyStateChanges(w, { conditions_remove: { Amber: ['groggy'] } }, ['Amber'], { turn: 10 });
    const log = applyStateChanges(w, { conditions_add: { Amber: ['groggy', 'prone'] } }, ['Amber'], { turn: 12 });
    assert.deepEqual(w.party.Amber.conditions, ['prone'], 'groggy stays gone; prone can happen any time');
    assert.match(log.join(' '), /not groggy again/);
    applyStateChanges(w, { conditions_add: { Amber: ['groggy'] } }, ['Amber'], { turn: 17 });
    assert.ok(w.party.Amber.conditions.includes('groggy'), 'later it can come back');
});

test('a companion taken away inside the place is put in a real room to find: named, or a captive\'s room nobody has seen', async () => {
    const { heldRoom } = await import('../src/core/explore.js');
    const place = build({ name: 'Gloomhold', kind: 'dungeon', size: 'medium' }, 3);
    const from = place.start;
    const anyCell = Object.values(place.rooms).find(r => r.type === 'cell');
    const caged = heldRoom(place, 'caged somewhere deep in the dungeon', from);
    assert.ok(caged && caged.caged, 'held here, in a cage');
    assert.ok(!place.state.visited.includes(caged.roomId), 'somewhere the party hasn\'t been');
    if (anyCell) assert.equal(place.rooms[heldRoom(place, 'locked up in a cell', from).roomId].type, 'cell');
    const room = Object.values(place.rooms).find(r => r.name.length > 6);
    assert.equal(heldRoom(place, `tied up in the ${room.name}`, from).roomId, room.id, 'a room the words name');
    assert.equal(heldRoom(place, 'waiting back at the camp by the road', from), null, 'somewhere else: off this map');
    assert.equal(heldRoom(place, 'went to think', from), null, 'nowhere in particular: off the map');
});
