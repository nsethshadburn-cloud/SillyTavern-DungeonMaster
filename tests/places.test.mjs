// Run with: node --test tests/
// v0.12: places (big sites, towns, building insides), fog of war, walking, the DM's view.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlan, generatePlace, generateTown, generateInterior, reachable, normalizeTownPlan } from '../src/core/layout.js';
import { roomAt, doorAt, computeVisible, reveal, isExplored, findPath, applyPlaceChanges, placeSummary, placeView, tickGuards, stairsAt, floorById, placePerson, adoptStrays, walkable } from '../src/core/explore.js';
import { colName, parseCoord, terrainAt, PROPS, MAX_PLACE_SIZE, signIcon, propAt, isWalkable, normalizeMap, placeNear, toCoord } from '../src/core/grid.js';
import { roomType } from '../src/core/rooms.js';
import { parseDmTurn, DM_RULES, PLACE_PLAN_INSTRUCTIONS, TOWN_PLAN_INSTRUCTIONS } from '../src/core/protocol.js';
import { MANOR_PLAN, TOWN_PLAN } from './fixtures/manor-plan.mjs';

const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

test('big columns: a..z, then aa, ab... both ways', () => {
    assert.equal(colName(0), 'a');
    assert.equal(colName(25), 'z');
    assert.equal(colName(26), 'aa');
    assert.equal(colName(55), 'bd');
    for (const x of [0, 7, 25, 26, 40, 63]) assert.equal(parseCoord(`${colName(x)}12`).x, x);
    assert.equal(parseCoord('ab70', { w: 30, h: 60 }), null, 'off the map');
    assert.equal(normalizeMap({ rows: Array(40).fill('.'.repeat(40)) }).w, 16, 'Claude-drawn maps stay small');
    assert.equal(normalizeMap({ rows: Array(40).fill('.'.repeat(40)) }, { max: MAX_PLACE_SIZE }).w, 40);
});

test('plans are cleaned up: stairs between floors, room types, a way out', () => {
    const plan = normalizePlan({
        floors: [{ id: 'G', level: 0 }, { id: 'U', level: 1 }],
        rooms: [{ id: 'A', type: 'Grand Entrance Hall', floor: 'G' }, { id: 'B', type: 'weird thing', floor: 'U' }, { id: 'C', type: 'torture room', floor: 'G', props: ['rack', 'nonsense'] }],
        links: [{ a: 'A', b: 'B', via: 'door' }, { a: 'A', b: 'C', via: 'barred door', key: 'Iron Key' }, { a: 'A', b: 'Z' }],
    });
    assert.equal(plan.links.find(l => l.b === 'B').via, 'stairs', 'a door between floors becomes stairs');
    assert.equal(plan.links.find(l => l.b === 'C').via, 'locked');
    assert.equal(plan.links.length, 2, 'links to unknown rooms are dropped');
    assert.equal(plan.rooms.find(r => r.id === 'B').type, 'room');
    assert.equal(plan.rooms.find(r => r.id === 'C').type, 'torture_chamber');
    assert.deepEqual(plan.rooms.find(r => r.id === 'C').props.map(p => p.type), ['rack']);
    assert.ok(plan.rooms.some(r => r.exit), 'a way out is added');
    assert.equal(roomType('Servants\' quarters'), 'servants_quarters');
    assert.equal(roomType('Dining Hall'), 'dining_room');
});

test('a 40-room, 4-floor manor: every room placed, reachable and solvable, on many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
        const place = generatePlace(MANOR_PLAN, seed);
        assert.equal(Object.keys(place.rooms).length, 40);
        assert.equal(place.floors.length, 4);
        for (const f of place.floors) {
            assert.ok(f.map.w <= MAX_PLACE_SIZE && f.map.h <= MAX_PLACE_SIZE, `${f.id} fits`);
            assert.equal(f.map.rows.length, f.map.h);
            assert.ok(f.map.rows.every(r => r.length === f.map.w));
        }
        // No two rooms on a floor overlap.
        const rooms = Object.values(place.rooms);
        for (const a of rooms) for (const b of rooms) {
            if (a === b || a.floor !== b.floor) continue;
            const overlap = a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w && a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h;
            assert.ok(!overlap, `${a.id} and ${b.id} overlap (seed ${seed})`);
        }
        const r = reachable(place);
        assert.equal(r.roomsReached.length, 40, `seed ${seed}: every room can be reached`);
        for (const d of Object.values(place.doors)) if (d.kind === 'locked' && d.key) assert.ok(r.keys.has(d.key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()), `key for ${d.id}`);
        assert.equal(place.stairs.length, 4);
        assert.ok(place.exits.length >= 1, 'a way out');
        assert.equal(roomAt(place, place.start.floor, place.start.x, place.start.y)?.id, 'B1', 'the party starts in the kennels');
    }
});

test('the built manor: doors in walls, stairs that connect, furniture that never blocks a doorway', () => {
    const place = generatePlace(MANOR_PLAN, 7);
    for (const d of Object.values(place.doors)) {
        const map = floorById(place, d.floor).map;
        assert.ok(['+', '/', 'D', '#', '.'].includes(terrainAt(map, d.x, d.y)), `${d.id} is a door square`);
        if (d.kind === 'secret') assert.equal(terrainAt(map, d.x, d.y), '#', 'secret doors look like wall until found');
        if (d.kind === 'locked') assert.equal(terrainAt(map, d.x, d.y), 'D');
        // The squares just inside a door are kept clear.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const x = d.x + dx, y = d.y + dy;
            if (roomAt(place, d.floor, x, y)) assert.ok(!map.props.some(p => PROPS[p.type]?.blocks && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1)), `${d.id} doorway is clear`);
        }
    }
    for (const s of place.stairs) {
        assert.deepEqual(stairsAt(place, s.a.floor, s.a.x, s.a.y), s.b);
        assert.ok(['<', '>'].includes(terrainAt(floorById(place, s.a.floor).map, s.a.x, s.a.y)));
    }
    const kennel = floorById(place, 'B').map.props.filter(p => inRect(place.rooms.B1.rect, p.x, p.y)).map(p => p.type);
    assert.ok(kennel.includes('kennel') && kennel.includes('bowl'), `the kennel hall is furnished as one: ${kennel.join(', ')}`);
    assert.ok(floorById(place, 'G').map.areas.some(a => a.room === 'G4' && a.floor === 'parquet'), 'rooms have their own floors');
    assert.ok(floorById(place, 'B').map.areas.every(a => !['wallpaper', 'panel'].includes(a.wall)), 'no wallpaper in the cellars');
    assert.ok(Object.values(place.traps).every(t => t.state === 'hidden'), 'traps start hidden');
    assert.ok(Object.values(place.guards).length === 3);
});

test('a key placed behind its own locked door is moved where the party can reach it', () => {
    const place = generatePlace({
        name: 'Trap house', floors: [{ id: 'G', level: 0 }],
        rooms: [{ id: 'A', name: 'Hall', type: 'foyer', floor: 'G', exit: true }, { id: 'B', name: 'Vault', type: 'vault', floor: 'G', items: [{ name: 'Vault Key' }] }],
        links: [{ a: 'A', b: 'B', via: 'locked', key: 'Vault Key' }], start: 'A',
    }, 3);
    const key = Object.values(place.items).find(i => i.name === 'Vault Key');
    assert.equal(key.room, 'A', 'the key moved out of the vault');
    assert.equal(reachable(place).roomsReached.length, 2);
});

test('towns: roofed buildings with doors on the road, shop signs, exits at the road ends', () => {
    const town = generateTown(TOWN_PLAN, 3);
    const map = town.floors[0].map;
    assert.equal(Object.keys(town.buildings).length, 10);
    assert.ok(map.w <= MAX_PLACE_SIZE);
    for (const b of Object.values(town.buildings)) {
        const d = town.doors[b.door];
        assert.equal(terrainAt(map, d.x, d.y), '+');
        assert.equal(d.enter, b.id);
        assert.ok(map.areas.some(a => a.building === b.id && a.wall), `${b.name} has its own walls`);
    }
    const signs = map.props.filter(p => p.type === 'sign');
    assert.ok(signs.some(s => s.label === 'The Rusty Anvil' && s.icon === 'anvil'));
    assert.ok(signs.some(s => s.label === 'The Drowsy Goose' && s.icon === 'mug'));
    assert.equal(map.roofs.length, 10);
    assert.ok(new Set(map.areas.map(a => JSON.stringify(a.wallColor))).size > 3, 'houses come in different colors');
    assert.ok(town.exits.length >= 4);
    assert.equal(town.state.explored.F0.includes('0'), false, 'a town needs no fog');
    // Every building door can be walked to from the start.
    for (const b of Object.values(town.buildings)) {
        const d = town.doors[b.door];
        assert.ok(findPath(town, 'F0', town.start, { x: d.x, y: d.y }), `walk to ${b.name}`);
    }
    assert.equal(signIcon('Hollowbrook Bakery'), 'bread');
    assert.equal(normalizeTownPlan({ buildings: [{ name: 'x', size: 'giant' }] }).buildings[0].size, 'medium');
});

test('building insides are generated from the trade, with stairs and a way back out', () => {
    const inn = generateInterior({ id: 'B2', name: 'The Drowsy Goose', kind: 'tavern', description: 'A low, smoky common room.' }, 5);
    assert.equal(inn.kind, 'interior');
    assert.equal(inn.floors.length, 3, 'cellar, ground floor and guest rooms upstairs');
    assert.equal(reachable(inn).roomsReached.length, Object.keys(inn.rooms).length);
    assert.equal(inn.exits.length, 1);
    const common = Object.values(inn.rooms).find(r => r.type === 'tavern');
    assert.ok(floorById(inn, common.floor).map.props.some(p => p.type === 'counter'));
    const smithy = generateInterior({ id: 'B1', name: 'The Rusty Anvil', kind: 'smithy' }, 2);
    assert.ok(smithy.floors[0].map.props.some(p => p.type === 'forge'));
});

/** A tiny place for the fog and walking tests: two dark rooms and a lit one in a row. */
function tinyPlace() {
    return generatePlace({
        name: 'Row', floors: [{ id: 'G', level: 0 }],
        rooms: [
            { id: 'A', name: 'West room', type: 'storage', floor: 'G', size: 'small', lit: false, exit: true },
            { id: 'B', name: 'Middle room', type: 'storage', floor: 'G', size: 'small', lit: false },
            { id: 'C', name: 'East room', type: 'parlor', floor: 'G', size: 'small', lit: true },
        ],
        links: [{ a: 'A', b: 'B', via: 'door' }, { a: 'B', b: 'C', via: 'locked' }], start: 'A',
    }, 11);
}

test('fog of war: walls and closed doors block sight; lit rooms show whole; dark rooms only up close', () => {
    const place = tinyPlace();
    const start = place.start;
    const vis = computeVisible(place, 'G', [start]);
    reveal(place, 'G', vis);
    const A = place.rooms.A.rect, B = place.rooms.B.rect, C = place.rooms.C.rect;
    assert.ok(isExplored(place, 'G', start.x, start.y));
    assert.ok(!roomTiles(B).some(([x, y]) => isExplored(place, 'G', x, y)), 'the next room is hidden behind its closed door');
    assert.ok(!roomTiles(C).some(([x, y]) => isExplored(place, 'G', x, y)));
    // Standing in the lit room shows all of it.
    const cx = C.x + 1, cy = C.y + 1;
    const lit = computeVisible(place, 'G', [{ x: cx, y: cy }]);
    assert.ok(roomTiles(C).every(([x, y]) => lit[y * floorById(place, 'G').map.w + x]));
    // In the dark, a far corner of a big dark room stays unseen.
    const far = computeVisible(place, 'G', [start], { near: 0 });
    assert.ok(roomTiles(A).some(([x, y]) => !far[y * floorById(place, 'G').map.w + x]) || A.w * A.h < 10);
});

function roomTiles(r) {
    const out = [];
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) out.push([x, y]);
    return out;
}

test('walking: around walls, through closed doors, never through a locked one; DM changes open it', () => {
    const place = tinyPlace();
    const map = floorById(place, 'G').map;
    place.state.explored.G = '1'.repeat(map.w * map.h);
    const B = place.rooms.B.rect, C = place.rooms.C.rect;
    const toB = findPath(place, 'G', place.start, { x: B.x + 1, y: B.y + 1 });
    assert.ok(toB?.length, 'through the closed door');
    assert.ok(toB.every(([x, y]) => terrainAt(map, x, y) !== '#'));
    const locked = Object.values(place.doors).find(d => d.kind === 'locked');
    assert.equal(findPath(place, 'G', place.start, { x: C.x + 1, y: C.y + 1 }), null, 'the locked door stops you');
    const log = applyPlaceChanges(place, { doors: { [locked.id]: 'unlocked' } });
    assert.deepEqual(log, [`${locked.id} unlocked`]);
    assert.equal(terrainAt(map, locked.x, locked.y), '+');
    assert.ok(findPath(place, 'G', place.start, { x: C.x + 1, y: C.y + 1 }), 'unlocked: now you can go');
    // Unexplored squares can't be walked to.
    place.state.explored.G = '0'.repeat(map.w * map.h);
    assert.equal(findPath(place, 'G', place.start, { x: B.x + 1, y: B.y + 1 }), null);
});

test('DM changes: secret doors found, traps spotted, guards moved; patrols walk on their own', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    const secret = Object.values(place.doors).find(d => d.kind === 'secret' && d.state === 'hidden');
    const map = floorById(place, secret.floor).map;
    applyPlaceChanges(place, { doors: { [secret.id]: 'found' } });
    assert.equal(terrainAt(map, secret.x, secret.y), '+', 'a found secret door becomes a door');
    const trap = Object.values(place.traps)[0];
    const prop = floorById(place, trap.floor).map.props.find(p => p.trap === trap.id);
    assert.equal(prop.hidden, true);
    applyPlaceChanges(place, { traps: { [trap.id]: 'found' } });
    assert.equal(prop.hidden, false, 'a found trap is drawn');
    applyPlaceChanges(place, { guards: { 'graves the butler': 'G4' } });
    assert.equal(place.guards['Graves the Butler'].room, 'G4');
    assert.ok(inRect(place.rooms.G4.rect, place.guards['Graves the Butler'].x, place.guards['Graves the Butler'].y));
    const before = place.guards['The Hound'].room;
    tickGuards(place, () => 0, 1);
    assert.notEqual(place.guards['The Hound'].room, before, 'the hound moved on along its patrol');
});

test("the DM's view: the whole place with secrets (cached), and where the party is now", () => {
    const place = generatePlace(MANOR_PLAN, 4);
    place.state.positions = { Amber: { floor: place.start.floor, x: place.start.x, y: place.start.y } };
    const summary = placeSummary(place);
    assert.match(summary, /# PLACE: Blackmoor Manor/);
    assert.match(summary, /B1 Kennel Hall \[kennel, dark\]/);
    assert.match(summary, /key: Kennel Key/);
    assert.match(summary, /secret, find DC/);
    assert.match(summary, /Patrols B1→B2→B3/);
    const view = placeView(place, ['Amber']);
    assert.match(view, /Current: Cellars \(floor B\), in B1 Kennel Hall/);
    assert.match(view, /Map here/);
    assert.match(view, /Amber [a-z]+\d+/);
});

test('DM protocol: building, entering and changing places', () => {
    const t = parseDmTurn(JSON.stringify({ build_place: { name: 'Blackmoor Manor', size: 'big', kind: 'Mansion', why: 'they are taken there' }, enter_place: 'Hollowbrook', leave_place: true, place_changes: { doors: { D4: 'open' } } }));
    assert.deepEqual(t.build_place, { name: 'Blackmoor Manor', size: 'big', kind: 'mansion', why: 'they are taken there' });
    assert.equal(t.enter_place, 'Hollowbrook');
    assert.equal(t.leave_place, true);
    assert.deepEqual(t.place_changes, { doors: { D4: 'open' } });
    assert.equal(parseDmTurn('{"build_place": {"size": "big"}}').build_place, null, 'a place needs a name');
    for (const s of ['## Places and maps', 'build_place', 'enter_place', 'place_changes', 'ATLAS']) assert.ok(DM_RULES.includes(s), s);
    for (const s of ['Story first', 'Every room earns its place', 'stairs', 'Gating', 'exit']) assert.ok(PLACE_PLAN_INSTRUCTIONS.includes(s), s);
    assert.match(TOWN_PLAN_INSTRUCTIONS, /sign/);
});

test('multi-square props cover all their squares', () => {
    const map = normalizeMap({ rows: ['......', '......', '......'], props: [{ at: 'b1', type: 'table', w: 3 }, { at: 'a1', type: 'rug', w: 6, h: 3 }] });
    assert.equal(propAt(map, 3, 0).type, 'table');
    assert.equal(propAt(map, 5, 2).type, 'rug');
    assert.equal(isWalkable(map, 2, 0), false);
    assert.equal(isWalkable(map, 5, 0), true, 'rugs are walkable');
});

test('fights: moves are limited to speed, around walls, with rubble costing double', async () => {
    const { reachable: reach, clampMove, speedSquares } = await import('../src/core/grid.js');
    const map = normalizeMap({ rows: ['..........', '..........', '....#.....', '....#.....', '..........'] });
    assert.equal(speedSquares({ speed: 30 }), 6);
    assert.equal(speedSquares({ speed: 25 }), 5);
    assert.equal(speedSquares(null), 6, 'no sheet: 30 ft');
    const r = reach(map, { x: 0, y: 2 }, 6);
    assert.ok(r.has('5,2') === false || r.get('5,2') <= 6);
    assert.ok(!r.has('9,2'), 'too far');
    const ok = clampMove(map, { x: 0, y: 2 }, { x: 9, y: 2 }, 6);
    assert.ok(Math.max(Math.abs(ok.x), Math.abs(ok.y - 2)) <= 6 && terrainAt(map, ok.x, ok.y) !== '#', 'stopped short, not in a wall');
    assert.deepEqual(clampMove(map, { x: 0, y: 0 }, { x: 3, y: 0 }, 6), { x: 3, y: 0 }, 'in reach: goes there');
    const rough = normalizeMap({ rows: ['##########', '.^^^^^....', '##########', '##########'] });
    assert.ok(!reach(rough, { x: 0, y: 2 }, 6).has('5,2'), 'five rubble squares cost 10');
    assert.ok(reach(rough, { x: 0, y: 2 }, 6).has('3,2'), 'three cost 6');
    assert.ok(!reach(map, { x: 0, y: 0 }, 6, new Set(['1,0'])).has('1,0'), 'can pass people but not stop on them');
});

test("vision: you can't see into a room until you step inside it, even a lit one", () => {
    const place = tinyPlace();
    const map = floorById(place, 'G').map;
    const door = Object.values(place.doors).find(d => d.rooms.includes('A') && d.rooms.includes('B'));
    applyPlaceChanges(place, { doors: { [door.id]: 'open' }, rooms: { B: { lit: true } } });
    const A = place.rooms.A.rect, B = place.rooms.B.rect;
    // Standing just inside room A, next to the open door into the lit room B.
    const inA = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: door.x + dx, y: door.y + dy })).find(p => inRect(A, p.x, p.y));
    const vis = computeVisible(place, 'G', [inA]);
    const far = roomTiles(B).filter(([x, y]) => Math.max(Math.abs(x - inA.x), Math.abs(y - inA.y)) > 1);
    assert.ok(far.every(([x, y]) => !vis[y * map.w + x]), 'the lit room next door stays dark');
    // One step inside and the lit room shows whole.
    const inB = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: door.x + dx, y: door.y + dy })).find(p => inRect(B, p.x, p.y));
    const vis2 = computeVisible(place, 'G', [inB]);
    assert.ok(roomTiles(B).every(([x, y]) => vis2[y * map.w + x]));
    assert.ok(roomTiles(A).filter(([x, y]) => Math.max(Math.abs(x - inB.x), Math.abs(y - inB.y)) > 1).every(([x, y]) => !vis2[y * map.w + x]), 'and the room behind you is out of view');
});

test('people on the map: guards are hostile, residents and shopkeepers are not; the DM can add someone', () => {
    const plan = normalizePlan({ rooms: [{ id: 'A', type: 'kitchen' }, { id: 'B', type: 'hallway' }], links: [{ a: 'A', b: 'B' }], guards: [{ name: 'Graves', room: 'B' }], people: [{ name: 'Old Martha', description: 'the cook', room: 'A' }] });
    assert.equal(plan.guards.find(g => g.name === 'Graves').hostile, true);
    assert.equal(plan.guards.find(g => g.name === 'Old Martha').hostile, false);
    const place = generatePlace(plan, 2);
    assert.equal(place.guards['Old Martha'].hostile, false);
    assert.ok(inRect(place.rooms.A.rect, place.guards['Old Martha'].x, place.guards['Old Martha'].y));
    const log = applyPlaceChanges(place, { guards: { 'Ghost Girl': { room: 'B', description: 'a pale child who wants help', hostile: false } } });
    assert.match(log[0], /Ghost Girl at [a-z]+\d+/);
    assert.ok(inRect(place.rooms.B.rect, place.guards['Ghost Girl'].x, place.guards['Ghost Girl'].y));
    assert.match(placeSummary(place), /Graves \(hostile\)/);
    assert.match(placeSummary(place), /Old Martha: the cook/);
    const smithy = generateInterior({ id: 'B1', name: 'The Rusty Anvil', kind: 'smithy', keeper: 'Bram Ironhand', description: 'A burly smith.' }, 2);
    const bram = smithy.guards['Bram Ironhand'];
    assert.ok(bram && bram.hostile === false, 'the smith is inside');
    assert.equal(normalizeTownPlan({ buildings: [{ name: 'x', keeper: 'Bram' }] }).buildings[0].keeper, 'Bram');
});

test('nothing generated ever blocks a doorway, the way out, stairs or a window (many seeds, houses too)', async () => {
    const { clearDoorways } = await import('../src/core/layout.js');
    const blocked = (place, floor, x, y) => floorById(place, floor).map.props.some(p => !p.obstacle && PROPS[p.type]?.blocks && x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1));
    const check = (place, label) => {
        const spots = [...Object.values(place.doors).map(d => [d.floor, d.x, d.y]), ...place.stairs.flatMap(s => [[s.a.floor, s.a.x, s.a.y], [s.b.floor, s.b.x, s.b.y]]), ...Object.values(place.windows || {}).map(w => [w.floor, w.x, w.y])];
        for (const [f, x, y] of spots) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            assert.ok(!blocked(place, f, x + dx, y + dy), `${label}: something blocks ${colName(x + dx)}${y + dy + 1}`);
        }
    };
    for (let seed = 1; seed <= 25; seed++) check(generatePlace(MANOR_PLAN, seed), `manor ${seed}`);
    for (const kind of ['house', 'tavern', 'smithy', 'manor', 'guard post', 'library', 'shop', 'temple']) for (let seed = 1; seed <= 15; seed++) check(generateInterior({ id: 'B', name: 'x', kind }, seed), `${kind} ${seed}`);
    // A map from before the fix: a bookshelf in front of the way out is moved when it loads.
    const old = generateInterior({ id: 'B', name: 'Old house', kind: 'house' }, 4);
    const exit = old.doors[old.exits[0].door];
    const map = floorById(old, exit.floor).map;
    const inside = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [exit.x + dx, exit.y + dy]).find(([x, y]) => roomAt(old, exit.floor, x, y));
    map.props.push({ x: inside[0], y: inside[1], type: 'bookshelf' });
    assert.ok(blocked(old, exit.floor, ...inside));
    assert.ok(clearDoorways(old) >= 1);
    assert.ok(!blocked(old, exit.floor, ...inside), 'the way out is clear again');
    // Something put there on purpose stays.
    map.props.push({ x: inside[0], y: inside[1], type: 'crate', obstacle: true });
    clearDoorways(old);
    assert.ok(map.props.some(p => p.obstacle && p.x === inside[0] && p.y === inside[1]));
});

test('furniture faces the right way: backs to the wall, chairs facing their table', () => {
    for (let seed = 1; seed <= 10; seed++) {
        const place = generatePlace(MANOR_PLAN, seed);
        for (const rm of Object.values(place.rooms)) {
            const r = rm.rect;
            for (const p of floorById(place, rm.floor).map.props) {
                if (!inRect(r, p.x, p.y) || !['bed', 'wardrobe', 'sofa'].includes(p.type) || !p.side) continue;
                const gaps = { n: r.y + r.h - (p.y + (p.h || 1)), s: p.y - r.y, w: p.x - r.x, e: r.x + r.w - (p.x + (p.w || 1)) };
                assert.equal(gaps[p.side], Math.min(...Object.values(gaps)), `${p.type} in ${rm.name} has its back to its nearest wall (seed ${seed})`);
            }
        }
    }
    const dining = generateInterior({ id: 'B', name: 'Manor', kind: 'manor' }, 6);
    const map = floorById(dining, Object.values(dining.rooms).find(r => r.type === 'dining_room').floor).map;
    const table = map.props.find(p => p.type === 'table' && (p.w || 1) > 2);
    if (table) for (const ch of map.props.filter(p => p.type === 'chair' && p.y === table.y - 1 && p.x >= table.x && p.x < table.x + table.w)) assert.equal(ch.side, 's', 'chairs south of the table have their backs to the south');
});

test('things on the map: smash into pieces, shove light things, heavy things need the DM, barricade a door', async () => {
    const { smashProp, moveProp, propById, walkable } = await import('../src/core/explore.js');
    const place = tinyPlace();
    const map = floorById(place, 'G').map;
    const A = place.rooms.A.rect;
    const door = Object.values(place.doors).find(d => d.rooms.includes('A') && d.rooms.includes('B'));
    // A crate two squares in from the door, inside room A, with nothing around it.
    const by = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [door.x + dx * 2, door.y + dy * 2, -dx, -dy]).find(([x, y]) => inRect(A, x, y));
    map.props = map.props.filter(p => !(Math.abs(p.x - by[0]) <= 1 && Math.abs(p.y - by[1]) <= 1) && !(p.x === door.x + by[2] * -1 && p.y === door.y + by[3] * -1));
    map.props.push({ id: 'p900', x: by[0], y: by[1], type: 'crate' }, { id: 'p901', x: A.x, y: A.y, type: 'bookshelf' });
    const dir = by[2] === 1 ? 'e' : by[2] === -1 ? 'w' : by[3] === 1 ? 'n' : 's';
    assert.equal(walkable(place, 'G', door.x, door.y), true);
    let r = moveProp(place, 'p900', dir);
    assert.ok(r.ok, r.why);
    r = moveProp(place, 'p900', dir);
    assert.ok(r.ok, r.why);
    assert.equal(r.door, door.id, 'shoved into the doorway');
    assert.equal(walkable(place, 'G', door.x, door.y), false, 'the door is barricaded');
    assert.equal(propById(place, 'p900').prop.obstacle, true);
    assert.equal(moveProp(place, 'p901', 'n').ok, false, 'a bookshelf is too heavy to shove without a roll');
    assert.match(moveProp(place, 'p901', 'n').why, /too heavy/);
    // Smashed: broken pieces anyone can walk over.
    assert.ok(smashProp(place, 'p900'));
    assert.equal(propById(place, 'p900').prop.type, 'debris');
    assert.equal(walkable(place, 'G', door.x, door.y), true, 'smashing the barricade opens the door again');
    // The DM can do the same through place_changes.
    const log = applyPlaceChanges(place, { props: { p901: 'broken' } });
    assert.match(log[0], /smashed/);
    assert.equal(propById(place, 'p901').prop.type, 'debris');
});

test('windows: break and climb out, barred windows, the DM bars every window', () => {
    const plain = generateInterior({ id: 'B', name: 'Cottage', kind: 'house' }, 3);
    const wins = Object.values(plain.windows);
    assert.ok(wins.length > 0, 'houses have windows');
    assert.ok(wins.every(w => w.state === 'intact'));
    const w = wins[0];
    applyPlaceChanges(plain, { windows: { [w.id]: 'broken' } });
    assert.equal(terrainAt(floorById(plain, w.floor).map, w.x, w.y), 'U');
    applyPlaceChanges(plain, { windows: { all: 'barred' } });
    assert.ok(Object.values(plain.windows).every(x => x.state === 'barred'));
    assert.equal(terrainAt(floorById(plain, w.floor).map, w.x, w.y), 'H');
    // A house the story keeps them in: barred from the start.
    const jail = generatePlace({ ...MANOR_PLAN, barred_windows: true }, 2);
    const jw = Object.values(jail.windows);
    assert.ok(jw.length && jw.every(x => x.state === 'barred'));
    // Walling up a door, and a barricade put there on purpose.
    const d = Object.values(jail.doors).find(x => x.kind === 'door' && !x.exit);
    applyPlaceChanges(jail, { doors: { [d.id]: 'walled' } });
    assert.equal(terrainAt(floorById(jail, d.floor).map, d.x, d.y), '#');
    const e = jail.doors[jail.exits[0].door];
    applyPlaceChanges(jail, { add_props: [{ type: 'barrel', at: `${colName(e.x)}${e.y + 1}`, floor: e.floor, label: 'barricade' }] });
    const barrel = floorById(jail, e.floor).map.props.find(p => p.label === 'barricade');
    assert.ok(barrel?.obstacle && barrel.id, 'added on purpose, with an id');
});

test('the DM can put anyone on the map by square or room, and they are drawn (not kept where the map never looks)', () => {
    const place = generatePlace(MANOR_PLAN, 4);
    const floor = place.floors[0], map = floor.map;
    const room = Object.values(place.rooms).find(r => r.floor === floor.id);
    // A square inside a wall: they stand on the nearest open square instead of vanishing.
    let wall = null;
    for (let y = 0; y < map.h && !wall; y++) for (let x = 0; x < map.w && !wall; x++) if (terrainAt(map, x, y) === '#' && walkable(place, floor.id, x + 1, y)) wall = { x, y };
    const g = placePerson(place, 'Bandit Captain', toCoord(wall.x, wall.y), { floor: floor.id, info: { hostile: true } });
    assert.ok(g && walkable(place, floor.id, g.x, g.y), 'on an open square');
    assert.ok(Math.max(Math.abs(g.x - wall.x), Math.abs(g.y - wall.y)) <= 2, 'right next to where the DM said');
    assert.equal(place.guards['Bandit Captain'].hostile, true);
    // By room name, and through place_changes with a plain square.
    assert.ok(placePerson(place, 'Old Tom', room.name, { floor: floor.id }), 'a room name works');
    applyPlaceChanges(place, { guards: { 'Sister Wren': toCoord(g.x, g.y) } }, { floor: floor.id });
    assert.ok(place.guards['Sister Wren'], 'someone new from a plain square');
    assert.ok(Object.values(place.guards).filter(p => p.floor === floor.id && p.x === g.x && p.y === g.y).length === 1, 'nobody shares a square');
    assert.equal(placePerson(place, 'Nobody', 'the moon'), null, 'nonsense is refused, not stored');
    // Older chats: NPCs stuck in the party's own position list become people on the map.
    place.state.positions = { Amber: { floor: floor.id, x: g.x, y: g.y }, 'Mister Pell': { floor: floor.id, x: g.x, y: g.y } };
    assert.equal(adoptStrays(place, ['Amber', 'Judy']), 1);
    assert.deepEqual(Object.keys(place.state.positions), ['Amber']);
    assert.ok(place.guards['Mister Pell'], 'Mister Pell is one of the place\'s people now');
});

test('a fight on a big floor: newcomers arrive near the party, not across the building', () => {
    const map = normalizeMap({ width: 16, height: 16, rows: Array(16).fill('.'.repeat(16)) });
    const lead = { x: 2, y: 2 };
    const pos = placeNear(map, { Amber: toCoord(2, 2) }, ['Wolf 1', 'Wolf 2'], lead, 3);
    for (const n of ['Wolf 1', 'Wolf 2']) {
        const p = parseCoord(pos[n], map);
        const d = Math.abs(p.x - lead.x) + Math.abs(p.y - lead.y);
        assert.ok(d >= 3 && d <= 5, `${n} is a few steps away (${d})`);
    }
    assert.notEqual(pos['Wolf 1'], pos['Wolf 2']);
});

test('crowded, half-linked plans still build: big floors split, cut-off rooms get joined', async () => {
    const { splitBusiestFloor } = await import('../src/core/layout.js');
    const rooms = Array.from({ length: 60 }, (_, i) => ({ id: `R${i + 1}`, name: `Hall ${i + 1}`, type: i % 3 ? 'hall' : 'bedroom', size: 'large', floor: 'F0', exit: i === 0 }));
    const links = rooms.slice(1).map((r, i) => ({ a: rooms[Math.floor(i / 2)].id, b: r.id, via: 'door' }));
    const plan = normalizePlan({ name: 'Crowded Keep', kind: 'castle', floors: [{ id: 'F0', name: 'Ground floor', level: 0 }], rooms, links });
    const split = splitBusiestFloor(plan);
    assert.equal(split.floors.length, 2, 'the busy floor splits in two');
    assert.ok(split.links.some(l => l.via === 'stairs'), 'stairs join the halves');
    const place = generatePlace(plan, 3);
    assert.equal(Object.keys(place.rooms).length, 60, 'every room is still there');
    for (const f of place.floors) assert.ok(f.map.w <= MAX_PLACE_SIZE && f.map.h <= MAX_PLACE_SIZE);
    // Links by room name, and a tower floor with no stairs at all: it still builds, every room reachable.
    const messy = generatePlace({ name: 'Gallowmere Keep', kind: 'castle', floors: [{ id: 'G', name: 'Ground', level: 0 }, { id: 'T', name: 'Tower top', level: 2 }],
        rooms: [{ id: 'G1', name: 'Gatehouse', floor: 'G', exit: true }, { id: 'G2', name: 'Courtyard', floor: 'G' }, { id: 'G3', name: 'Great Hall', floor: 'G' }, { id: 'T1', name: 'Lookout', floor: 'T' }, { id: 'T2', name: 'Bell room', floor: 'T' }],
        links: [{ a: 'Gatehouse', b: 'Courtyard' }, { a: 'the courtyard', b: 'G3' }, { a: 'T1', b: 'T2' }] }, 5);
    assert.equal(reachable(messy).roomsReached.length, 5, 'every room can be reached');
    assert.ok(messy.stairs.length >= 1, 'the tower got stairs');
});
