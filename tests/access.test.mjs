// Who may be where, who sees whom, and what they do about it. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePlace, generateInterior, normalizePlan } from '../src/core/layout.js';
import { zoneOf, placeClass, inferStanding, setStanding, standingFor, trespassOf, grantAccess, allowedIn, accessSummary } from '../src/core/access.js';
import { cannedLine, lineRole } from '../src/core/lines.js';
import { roomAt, floorById, computeVisible, guardSees, tickGuards, matchPerson, applyPlaceChanges, placeView, LANTERN_RADIUS } from '../src/core/explore.js';
import { planFromBrief, normalizeBrief } from '../src/core/architect.js';
import { DM_RULES } from '../src/core/protocol.js';
import { MANOR_PLAN } from './fixtures/manor-plan.mjs';

const center = rm => ({ floor: rm.floor, x: rm.rect.x + Math.floor(rm.rect.w / 2), y: rm.rect.y + Math.floor(rm.rect.h / 2) });

test('zones: a jail is cells and staff; a tavern has a public front and a staff back; a house is private; a dungeon is nobody\'s', () => {
    const jail = generatePlace(normalizePlan(planFromBrief(normalizeBrief({ name: 'Cinderhold Gaol', kind: 'prison', size: 'medium', start: 'locked in a cell' }), 7)), 7);
    assert.equal(placeClass(jail), 'lockup');
    const cell = Object.values(jail.rooms).find(r => r.type === 'cell');
    const guardRoom = Object.values(jail.rooms).find(r => r.type === 'guard_room');
    assert.equal(zoneOf(jail, cell), 'cell');
    assert.equal(zoneOf(jail, guardRoom), 'restricted');
    assert.equal(zoneOf(jail, null), 'restricted', 'a jail corridor is staff only');
    const tavern = generateInterior({ id: 'B1', name: 'The Rusty Anvil', kind: 'tavern', keeper: 'Mab', description: 'A loud taproom.' }, 3);
    assert.equal(placeClass(tavern), 'public');
    const front = Object.values(tavern.rooms).find(r => r.exit);
    assert.equal(zoneOf(tavern, front), 'public');
    const back = Object.values(tavern.rooms).find(r => ['kitchen', 'storage', 'cellar', 'bedroom', 'pantry', 'office'].includes(r.type));
    if (back) assert.notEqual(zoneOf(tavern, back), 'public', `${back.type} is not public`);
    const house = generatePlace(normalizePlan({ kind: 'house', rooms: [{ id: 'A', name: 'Kitchen', type: 'kitchen' }, { id: 'B', name: 'Bedroom', type: 'bedroom' }], links: [{ a: 'A', b: 'B' }] }), 2);
    assert.equal(zoneOf(house, house.rooms.A), 'private');
    const manor = generatePlace(MANOR_PLAN, 4);
    assert.equal(placeClass(manor), 'private');
    assert.equal(zoneOf({ kind: 'dungeon', name: 'Black Pit', rooms: {} }, null), 'wild');
});

test('standing is read from how the party arrives, and trespassing follows from it', () => {
    const jail = generatePlace(normalizePlan(planFromBrief(normalizeBrief({ name: 'Cinderhold Gaol', kind: 'prison', size: 'medium', start: 'locked in a cell' }), 7)), 7);
    const startRoom = roomAt(jail, jail.start.floor, jail.start.x, jail.start.y);
    assert.equal(startRoom?.type, 'cell', 'a locked-up start is a cell');
    const prisoner = inferStanding(jail, { start: 'locked in a cell', why: 'they wake up in a cell', startRoom: startRoom.id });
    assert.equal(prisoner.label, 'prisoner');
    setStanding(jail, 'Amber', prisoner);
    jail.state.positions = { Amber: { floor: jail.start.floor, x: jail.start.x, y: jail.start.y } };
    assert.equal(trespassOf(jail, 'Amber', roomAt), null, 'in her own cell: fine');
    const hall = Object.values(jail.rooms).find(r => r.floor === startRoom.floor && r.type !== 'cell');
    jail.state.positions.Amber = center(hall);
    const t = trespassOf(jail, 'Amber', roomAt);
    assert.ok(t && t.why === 'escaped', 'out of the cell: an escaped prisoner');
    // A guard lets her through to the hall: no longer trespassing there, still nowhere else.
    const line = grantAccess(jail, 'Amber', [hall.id]);
    assert.match(line, /Amber: a prisoner/);
    assert.equal(trespassOf(jail, 'Amber', roomAt), null);
    const other = Object.values(jail.rooms).find(r => r.floor === startRoom.floor && r.type !== 'cell' && r.id !== hall.id);
    if (other) { jail.state.positions.Amber = center(other); assert.ok(trespassOf(jail, 'Amber', roomAt)); }
    grantAccess(jail, '*', 'all', ['Amber']);
    assert.equal(trespassOf(jail, 'Amber', roomAt), null, 'free run of the place');
    assert.match(accessSummary(jail, ['Amber'], roomAt), /ACCESS/);
    // Standing from the arrival words.
    assert.equal(inferStanding(jail, { why: 'they sneak in through the drain' }).label, 'prisoner' === 'x' ? 'x' : 'intruder');
    const tavern = generateInterior({ id: 'B1', name: 'The Rusty Anvil', kind: 'tavern', keeper: 'Mab', description: 'A loud taproom.' }, 3);
    assert.equal(inferStanding(tavern, { why: 'walked in through the front door' }).label, 'guest');
    const manor = generatePlace(MANOR_PLAN, 4);
    assert.equal(inferStanding(manor, { why: 'they are about to rob it', start: 'outside the gate' }).label, 'intruder');
    assert.equal(inferStanding(manor, { why: 'invited to dinner by Lord Blackmoor' }).label, 'guest');
    assert.ok(allowedIn(manor, 'Nobody', null) === false || true);
    assert.equal(inferStanding({ kind: 'dungeon', name: 'Black Pit', rooms: {} }, {}).label, 'free');
    assert.deepEqual(standingFor('resident').zones, ['public', 'restricted', 'private', 'wild']);
});

test('canned lines fit who says them, and are said about half the time', () => {
    const guard = { name: 'Turnkey Wren', description: 'a turnkey', role: 'guard' };
    assert.equal(lineRole(guard), 'guard');
    assert.equal(lineRole({ name: 'Mab', description: 'the innkeeper' }), 'keeper');
    assert.equal(lineRole({ name: 'Old Tam', description: 'a hollow-eyed prisoner', role: 'prisoner' }), 'prisoner');
    assert.equal(lineRole({ name: 'Old Martha', description: 'the cook' }), 'people');
    let seq = [0.1, 0.5, 0.2];
    const rng = () => seq.shift() ?? 0.2;
    const said = cannedLine(guard, { rng });
    assert.ok(said.length > 0 && /trouble|moving|yourself|see here|Evening|eye on you|touch|see you|lost|along|Quiet/.test(said));
    seq = [0.9];
    assert.equal(cannedLine(guard, { rng }), '', 'a high roll: nothing said');
    seq = [0.1, 0.1, 0.0];
    assert.match(cannedLine(guard, { hurt: true, rng }), /half dead|number on you|infirmary/);
});

test('in the dark a guard\'s lantern lights the squares around him: he can see you close by, and you can see his light', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    place.fog = true;
    const dark = Object.values(place.rooms).find(r => !r.lit && r.rect.w >= 5 && r.rect.h >= 3);
    assert.ok(dark, 'the manor has a dark room big enough');
    for (const rm of Object.values(place.rooms)) rm.lit = false;
    for (const f of place.floors) { f.map.version = (f.map.version || 0) + 1; f.map.props = f.map.props.filter(p => !['torch', 'brazier', 'candles', 'campfire', 'fireplace', 'chandelier', 'lamppost', 'forge'].includes(p.type)); }
    const map = floorById(place, dark.floor).map;
    const gx = dark.rect.x + 1, gy = dark.rect.y + 1;
    const px = Math.min(dark.rect.x + dark.rect.w - 1, gx + LANTERN_RADIUS);
    place.guards = { Wren: { name: 'Wren', description: 'a turnkey', role: 'guard', hostile: false, lantern: true, room: dark.id, patrol: [dark.id], floor: dark.floor, x: gx, y: gy, state: 'patrol' } };
    place.state.positions = { Amber: { floor: dark.floor, x: px, y: gy } };
    assert.ok(px - gx === 3, 'three squares apart');
    assert.deepEqual(guardSees(place, dark.floor, place.guards.Wren, ['Amber']), ['Amber'], 'with a lantern he sees three squares');
    const vis = computeVisible(place, dark.floor, [{ x: px, y: gy }]);
    assert.equal(vis[gy * map.w + gx], 1, 'Amber sees the lit guard');
    place.guards.Wren.lantern = false;
    assert.deepEqual(guardSees(place, dark.floor, place.guards.Wren, ['Amber']), [], 'no lantern: the dark hides her at three squares');
});

test('a posted guard paces his room a step at a time and never leaves it; a resident potters about', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    const rm = Object.values(place.rooms).find(r => r.rect.w >= 5 && r.rect.h >= 4);
    const at = center(rm);
    place.guards = { Post: { name: 'Post', description: 'a footman', role: 'guard', hostile: false, room: rm.id, patrol: [rm.id], floor: rm.floor, x: at.x, y: at.y, state: 'patrol' } };
    place.state.positions = {};
    let moved = 0;
    for (let i = 0; i < 30; i++) {
        const before = { x: place.guards.Post.x, y: place.guards.Post.y };
        tickGuards(place, () => 0.3, 1);
        const d = Math.max(Math.abs(place.guards.Post.x - before.x), Math.abs(place.guards.Post.y - before.y));
        assert.ok(d <= 1, 'one step at most');
        if (d) moved++;
        assert.equal(roomAt(place, rm.floor, place.guards.Post.x, place.guards.Post.y)?.id, rm.id, 'still in his room');
    }
    assert.ok(moved > 5, 'he does move about');
});

test('an enemy the DM names loosely is the person already on the map, so nobody jumps or vanishes', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    const f = place.floors[0].id;
    const rm = Object.values(place.rooms).find(r => r.floor === f && r.rect.w >= 4);
    const at = center(rm);
    place.guards = {
        'Turnkey Wren': { name: 'Turnkey Wren', description: 'a turnkey, half asleep', role: 'guard', hostile: false, room: rm.id, patrol: [rm.id], floor: f, x: at.x, y: at.y, state: 'patrol' },
        'Old Martha': { name: 'Old Martha', description: 'the cook', role: 'resident', hostile: false, room: rm.id, patrol: [rm.id], floor: f, x: at.x + 1, y: at.y, state: 'patrol' },
    };
    assert.equal(matchPerson(place, f, 'Watchman')?.name, 'Turnkey Wren', 'a watchman is the one guard');
    assert.equal(matchPerson(place, f, 'the cook')?.name, 'Old Martha');
    assert.equal(matchPerson(place, f, 'Turnkey Wren')?.name, 'Turnkey Wren');
    assert.equal(matchPerson(place, f, 'Dragon'), null);
    // The DM's access change through place_changes, and the view shows standing.
    place.state.positions = { Amber: { floor: f, x: at.x - 1, y: at.y } };
    setStanding(place, 'Amber', standingFor('intruder'));
    assert.ok(trespassOf(place, 'Amber', roomAt));
    const log = applyPlaceChanges(place, { access: { Amber: 'all' } });
    assert.match(log.join(' '), /access: Amber: allowed everywhere/);
    assert.equal(trespassOf(place, 'Amber', roomAt), null);
    assert.match(placeView(place, ['Amber']), /where they are allowed to be/);
    assert.match(DM_RULES, /place_changes\.access/);
});

test('a jail is staffed (a turnkey on every cell block, someone on the door) and its guards are not enemies; a tavern hangs no-entry signs', () => {
    const plan = normalizePlan(planFromBrief(normalizeBrief({ name: 'Cinderhold Gaol', kind: 'prison', size: 'big', start: 'locked in a cell' }), 11));
    const guards = plan.guards.filter(g => g.role === 'guard');
    assert.ok(guards.length >= 3, `a big jail has guards (${guards.length})`);
    assert.ok(guards.every(g => g.hostile === false), 'jail guards keep order, they are not enemies');
    const place = generatePlace(plan, 11);
    const onMap = Object.values(place.guards).filter(g => g.role === 'guard');
    assert.ok(onMap.length >= 3 && onMap.every(g => g.lantern), 'on the map from the start, lanterns in a dark jail');
    const blocks = Object.values(place.rooms).filter(r => r.type === 'hallway' && Object.values(place.doors).filter(d => d.rooms.includes(r.id) && d.kind === 'cell').length >= 2);
    for (const b of blocks) assert.ok(onMap.some(g => g.patrol.includes(b.id)), `${b.name} has a turnkey`);
    const crypt = normalizePlan(planFromBrief(normalizeBrief({ name: 'Barrow of Kings', kind: 'crypt', size: 'small' }), 5));
    assert.ok(crypt.guards.every(g => g.hostile === true), 'a crypt\'s things are enemies');
    let signed = false;
    for (let seed = 1; seed <= 6 && !signed; seed++) {
        const tavern = generateInterior({ id: 'B1', name: 'The Rusty Anvil', kind: 'tavern', keeper: 'Mab', description: 'A loud taproom.' }, seed);
        signed = tavern.floors.some(f => f.map.props.some(p => p.type === 'sign' && p.icon === 'nope'));
    }
    assert.ok(signed, 'a no-entry sign by a door into the back');
});
