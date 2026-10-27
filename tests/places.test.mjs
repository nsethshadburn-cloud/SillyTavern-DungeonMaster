// Run with: node --test tests/
// v0.12: places (big sites, towns, building insides), fog of war, walking, the DM's view.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlan, generatePlace, generateTown, generateInterior, reachable, normalizeTownPlan } from '../src/core/layout.js';
import { roomAt, doorAt, computeVisible, reveal, isExplored, findPath, applyPlaceChanges, placeSummary, placeView, tickGuards, stairsAt, floorById } from '../src/core/explore.js';
import { colName, parseCoord, terrainAt, PROPS, MAX_PLACE_SIZE, signIcon, propAt, isWalkable, normalizeMap } from '../src/core/grid.js';
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
