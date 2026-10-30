// The fort builder: camps and forts as one outdoor map, from a brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCamp, campSpec, campFromBrief, generateCamp } from '../src/core/camp.js';
import { normalizeBrief } from '../src/core/architect.js';
import { findPath, walkable, computeVisible } from '../src/core/explore.js';
import { PROPS, terrainAt } from '../src/core/grid.js';
import { AMBIENCES } from '../src/core/fire.js';

const build = (brief, seed) => generateCamp(campFromBrief(normalizeBrief(brief), seed), seed);
const inRect = (rm, x, y) => x >= rm.rect.x && x < rm.rect.x + rm.rect.w && y >= rm.rect.y && y < rm.rect.y + rm.rect.h;
/** A square of the room the party can stand on and walk to from the start (gates locked or not: they have the keys here). */
function reachableRoom(p, rm, keys = true) {
    const cx = rm.rect.x + Math.floor(rm.rect.w / 2), cy = rm.rect.y + Math.floor(rm.rect.h / 2);
    for (let d = 0; d < 5; d++) for (let i = -d; i <= d; i++) for (let j = -d; j <= d; j++) {
        const x = cx + i, y = cy + j;
        if (!inRect(rm, x, y) || !walkable(p, 'F0', x, y, { keys })) continue;
        if (findPath(p, 'F0', p.start, { x, y }, { knownOnly: false, keys })) return true;
    }
    return false;
}

test('camps and forts are told from buildings and towns', () => {
    assert.ok(isCamp('bandit camp') && isCamp('camp') && isCamp('war camp') && isCamp('hideout') && isCamp('outpost'));
    assert.ok(isCamp('fort', 'Bandit Fort Grey') && isCamp('stockade', 'the raiders\' stockade') && isCamp('', 'the Reavers\' Hideout'));
    assert.ok(!isCamp('fort', 'Fort Grey') && !isCamp('castle', 'Bandit castle') && !isCamp('prison') && !isCamp('mansion') && !isCamp('town'));
    const hostile = campSpec(normalizeBrief({ name: 'Redstake', kind: 'bandit camp', size: 'small' }));
    assert.equal(hostile.walls, 'palisade'); assert.equal(hostile.gates, 'closed'); assert.ok(hostile.hostile); assert.equal(hostile.shape, 'round');
    const stone = campSpec(normalizeBrief({ name: 'Fort Grey', kind: 'bandit fort', size: 'medium', summary: 'a stone fort held by outlaws' }));
    assert.equal(stone.walls, 'stone'); assert.equal(stone.shape, 'square');
    const huge = campSpec(normalizeBrief({ name: 'The Horde', kind: 'war camp', size: 'big', summary: 'a sprawling war camp' }));
    assert.equal(huge.size, 'massive');
    const quiet = campSpec(normalizeBrief({ name: 'Rest', kind: 'camp', size: 'small', summary: 'a peaceful pilgrim caravan camp' }));
    assert.equal(quiet.walls, 'none'); assert.ok(!quiet.hostile);
    const asked = campSpec(normalizeBrief({ name: 'X', kind: 'camp', walls: 'stone', gates: 'open' }));
    assert.equal(asked.walls, 'stone'); assert.equal(asked.gates, 'open');
    assert.equal(campSpec(normalizeBrief({ name: 'X', kind: 'bandit camp', shape: 'square' })).shape, 'square');
    assert.equal(campSpec(normalizeBrief({ name: 'X', kind: 'bandit fort', summary: 'a round stone ring fort' })).shape, 'round');
});

test('a small bandit camp: a palisade with a gate, towers, stakes outside, a fire, tents, the chief in his lodge', () => {
    const p = build({ name: 'Redstake', kind: 'bandit camp', size: 'small', summary: 'A small bandit camp in the hills.', start: 'outside, in the trees' }, 3);
    const map = p.floors[0].map;
    assert.equal(map.theme, 'camp');
    assert.equal(map.ambience, 'embers');
    assert.ok(AMBIENCES.includes('embers'));
    assert.ok(map.w <= 34 && map.h <= 30);
    assert.equal(p.fog, true);
    const gate = p.doors.D1;
    assert.ok(gate?.gate && gate.name === 'main gate' && gate.state === 'closed', 'the main gate is D1, closed');
    assert.ok(map.gates.includes(`${gate.x},${gate.y}`));
    assert.equal(terrainAt(map, gate.x, gate.y), '+');
    // The wall is closed: without the gate there is no way in.
    const open = { ...p, doors: { ...p.doors } };
    const rows = map.rows.map(s => s.split(''));
    rows[map.h - 1 - gate.y][gate.x] = '#';
    const sealed = { ...p, floors: [{ ...p.floors[0], map: { ...map, rows: rows.map(s => s.join('')) } }] };
    const lodge = Object.values(p.rooms).find(rm => rm.hut && rm.type === 'master_bedroom');
    assert.ok(lodge, 'the chief has a lodge');
    assert.ok(!reachableRoom(sealed, lodge), 'with the gate walled up the lodge cannot be reached');
    assert.ok(reachableRoom(p, lodge), 'through the gate it can');
    for (const t of ['watchtower', 'spikes', 'bonfire', 'tent', 'chest', 'torch', 'bed']) assert.ok(map.props.some(pr => pr.type === t), t);
    assert.ok(map.props.some(pr => pr.type === 'bonfire' && pr.w === 3 && pr.h === 3), 'a 3x3 bonfire');
    assert.ok(map.rows.join('').includes(':'), 'worn paths');
    assert.ok(map.props.filter(pr => pr.type === 'spikes').every(pr => terrainAt(map, pr.x, pr.y) !== '#'));
    assert.ok(map.rows.join('').includes('T'), 'woods outside');
    const chief = Object.values(p.guards).find(g => /the|One-Eye|Ironjaw|Half-hand|Blackteeth|Nine-fingers|Wolfmother|Bonecrown/.test(g.name));
    assert.ok(chief && inRect(lodge, chief.x, chief.y), 'the chief is in the lodge');
    assert.ok(Object.values(p.guards).some(g => g.lookout && map.props.some(t => t.type === 'watchtower' && g.x >= t.x && g.x < t.x + 2 && g.y >= t.y && g.y < t.y + 2)), 'a lookout stands on a tower');
    assert.ok(PROPS.watchtower.platform && !PROPS.watchtower.blocks);
    assert.equal(p.start.room, 'APPROACH');
    assert.ok(walkable(p, 'F0', p.start.x, p.start.y));
    assert.ok(p.exits.length >= 1, 'the path leads out');
    // Outside is known, the inside is not.
    const seen = (x, y) => p.state.explored.F0[y * map.w + x] === '1';
    assert.ok(seen(p.start.x, p.start.y) && !seen(lodge.rect.x, lodge.rect.y));
});

test('every zone of every camp can be walked to from the gate; traps sit beside the path and by valuables, never at a door', () => {
    const briefs = [
        { name: 'The Skull Fence', kind: 'cannibal camp', size: 'medium', summary: 'Cannibals keep captives in cages.', start: 'locked in a cage', traps: 'many' },
        { name: 'Squarestake', kind: 'bandit camp', size: 'big', summary: 'A square palisade camp.', shape: 'square', start: 'outside' },
        { name: 'Ring of Teeth', kind: 'war camp', size: 'big', summary: 'A massive round war camp.', shape: 'round', start: 'outside' },
        { name: 'Gallows Hollow', kind: 'raider camp', size: 'big', summary: 'A big raider camp.', mood: 'grim', start: 'outside' },
        { name: 'The Horde', kind: 'war camp', size: 'big', summary: 'A massive sprawling war camp of the horde.', start: 'outside', guards: 6 },
        { name: 'Fort Grey', kind: 'bandit fort', size: 'medium', summary: 'A stone fort held by outlaws.', start: 'outside' },
    ];
    for (const b of briefs) for (let seed = 1; seed <= 6; seed++) {
        const p = build(b, seed), map = p.floors[0].map;
        assert.ok(map.w <= 64 && map.h <= 64, `${b.name} ${seed}: fits`);
        assert.ok(walkable(p, 'F0', p.start.x, p.start.y), `${b.name} ${seed}: dry start`);
        for (const rm of Object.values(p.rooms)) assert.ok(reachableRoom(p, rm), `${b.name} ${seed}: ${rm.name} can be reached`);
        const doors = Object.values(p.doors);
        for (const t of Object.values(p.traps)) {
            assert.ok(t.state === 'hidden' && doors.every(d => Math.abs(d.x - t.x) > 1 || Math.abs(d.y - t.y) > 1), `${b.name} ${seed}: trap ${t.id} away from doors`);
            assert.ok('.:'.includes(terrainAt(map, t.x, t.y)), 'on open ground');
        }
        for (const g of Object.values(p.guards)) assert.ok(!'#%To'.includes(terrainAt(map, g.x, g.y)), `${b.name} ${seed}: ${g.name} stands on ground`);
        assert.ok(doors.some(d => d.name === 'back gate' && d.state === 'locked'), 'a locked back gate');
    }
});

test('a massive war camp has an inner stockade with its own locked gate, holding the chief and the pen', () => {
    const p = build({ name: 'The Horde', kind: 'war camp', size: 'big', summary: 'A massive sprawling war camp of the horde, prisoners in cages.', start: 'outside' }, 5);
    assert.equal(p.camp.size, 'massive');
    assert.ok(p.camp.inner, 'an inner gate');
    const inner = p.doors[p.camp.inner];
    assert.equal(inner.state, 'locked');
    const keep = p.rooms[inner.rooms[0]];
    assert.ok(keep && keep.role === 'keep');
    const lodge = Object.values(p.rooms).find(rm => rm.hut && rm.type === 'master_bedroom');
    const pen = Object.values(p.rooms).find(rm => rm.hut && rm.type === 'cell');
    assert.ok(lodge && pen, 'a lodge and a pen');
    assert.ok(inRect(keep, lodge.rect.x, lodge.rect.y) && inRect(keep, pen.rect.x, pen.rect.y), 'both inside the stockade');
    // Without the keys the inner gate (and the pen's barred gate) stop you; with them you get in.
    assert.ok(!reachableRoom(p, lodge, false) && reachableRoom(p, lodge, true));
    assert.ok(Object.values(p.guards).some(g => g.role === 'prisoner' && inRect(pen, g.x, g.y)), 'a captive in the pen');
    assert.ok(Object.values(p.guards).filter(g => g.hostile).length >= 8, 'a band to hold it');
});

test('a captive starts in the pen, behind a locked barred gate the pen keeps as a cell', () => {
    const p = build({ name: 'The Skull Fence', kind: 'cannibal camp', size: 'medium', summary: 'Cannibals keep captives in cages.', start: 'locked in a cage', objective: 'escape', people: [{ name: 'Old Hask', what: 'a captive smith', where: 'the cages' }] }, 2);
    const pen = p.rooms[p.start.room];
    assert.ok(pen?.hut && pen.type === 'cell', 'starts in the pen');
    assert.ok(inRect(pen, p.start.x, p.start.y));
    const door = Object.values(p.doors).find(d => d.rooms[0] === pen.id);
    assert.ok(door && door.kind === 'cell' && door.state === 'locked' && door.dc === 13);
    assert.ok(p.guards['Old Hask'] && inRect(pen, p.guards['Old Hask'].x, p.guards['Old Hask'].y) && p.guards['Old Hask'].role === 'prisoner');
    assert.ok(p.floors[0].map.props.some(pr => pr.type === 'skullpole'), 'skull poles for a cannibal camp');
    assert.ok(p.floors[0].map.props.some(pr => pr.type === 'spikes' && pr.gory), 'heads on stakes');
    assert.ok(p.floors[0].map.props.filter(pr => pr.type === 'blood').length >= 6, 'blood on the ground');
    // From inside the pen you see the pen, not the camp beyond its walls.
    const vis = computeVisible(p, 'F0', [p.start]);
    const lodge = Object.values(p.rooms).find(rm => rm.hut && rm.type === 'master_bedroom');
    assert.ok(!vis[lodge.rect.y * p.floors[0].map.w + lodge.rect.x], 'the lodge is out of sight');
});

test('the story\'s things land where they belong; the same brief and seed give the same camp', () => {
    const brief = { name: 'Crowcamp', kind: 'bandit camp', size: 'medium', summary: 'Bandits hold the heir for ransom.', rooms: [{ room: 'the chief\'s tent', has: ['the ransom letter'] }], people: [{ name: 'Vask Ironjaw', what: 'the bandit chief', hostile: true }, { name: 'Lady Mira', what: 'the kidnapped heir, held in a cage', where: 'the cages' }], objective: 'the heir\'s signet ring' };
    const a = build(brief, 9), b = build(brief, 9);
    assert.deepEqual(a, b);
    assert.ok(a.guards['Vask Ironjaw']?.hostile, 'the brief\'s chief leads the camp');
    const lodge = Object.values(a.rooms).find(rm => rm.hut && rm.type === 'master_bedroom');
    assert.ok(inRect(lodge, a.guards['Vask Ironjaw'].x, a.guards['Vask Ironjaw'].y), 'in the lodge');
    const letter = Object.values(a.items).find(i => i.name === 'the ransom letter');
    assert.ok(letter && inRect(lodge, letter.x, letter.y), 'the letter is in the lodge');
    assert.ok(Object.values(a.items).some(i => /signet/.test(i.name)), 'the objective is somewhere in the camp');
    const pen = Object.values(a.rooms).find(rm => rm.hut && rm.type === 'cell');
    assert.ok(inRect(pen, a.guards['Lady Mira'].x, a.guards['Lady Mira'].y) && a.guards['Lady Mira'].hostile === false);
    assert.notDeepEqual(build(brief, 10).floors[0].map.rows, a.floors[0].map.rows, 'another seed, another camp');
});

test('a peaceful camp has no wall, no gates and no band', () => {
    const p = build({ name: 'Pilgrims\' Rest', kind: 'camp', size: 'small', summary: 'A peaceful pilgrim caravan camp.', start: 'by the fire' }, 4);
    assert.equal(p.camp.walls, 'none');
    assert.equal(Object.keys(p.doors).length, 0);
    assert.ok(!Object.values(p.guards).some(g => g.hostile));
    assert.ok(!p.floors[0].map.rows.join('').includes('#'));
    assert.ok(p.floors[0].map.props.some(pr => pr.type === 'bonfire') && p.floors[0].map.props.some(pr => pr.type === 'tent'));
    assert.notEqual(p.start.room, 'APPROACH');
});
