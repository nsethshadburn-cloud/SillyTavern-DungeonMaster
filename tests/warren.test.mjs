// The insides of a camp's houses and the tunnels under it, with their hidden trapdoors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campFromBrief, generateCamp, campInteriors } from '../src/core/camp.js';
import { generateTunnels } from '../src/core/warren.js';
import { normalizeBrief } from '../src/core/architect.js';
import { findPath, walkable, applyPlaceChanges } from '../src/core/explore.js';
import { doorChar } from '../src/core/layout.js';
import { PROPS, terrainAt, THEMES } from '../src/core/grid.js';
import { presetFor } from '../src/core/sprites.js';

const build = (brief, seed) => generateCamp(campFromBrief(normalizeBrief(brief), seed), seed);
const inRect = (rc, x, y) => x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h;
const props = p => p.floors[0].map.props;
function reachable(p, from, rc, keys = true) {
    for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) if (walkable(p, 'F0', x, y, { keys }) && findPath(p, 'F0', from, { x, y }, { knownOnly: false, keys })) return true;
    return false;
}

const SKULL = { name: 'The Skull Fence', kind: 'cannibal camp', size: 'medium', summary: 'Cannibals keep captives in cages.', start: 'locked in a cage', objective: 'escape', tunnels: 'yes' };

test('a cannibal camp has a flesh house and tunnels under it, their trapdoors hidden in the woods, the pen and the lodge', () => {
    const p = build(SKULL, 4);
    assert.ok(p.camp.tunnels && p.camp.horror);
    const kinds = Object.values(p.buildings).map(b => b.kind);
    assert.ok(kinds.includes('lodge') && kinds.includes('butchery') && kinds.includes('tunnels'), kinds.join());
    const hatches = Object.values(p.doors).filter(d => d.kind === 'trapdoor');
    assert.equal(hatches.length, 2, 'two trapdoors on the camp map: the woods and the pen');
    const map = p.floors[0].map;
    for (const d of hatches) {
        assert.equal(d.state, 'hidden'); assert.equal(d.enter, 'TUN'); assert.equal(d.dc, 15);
        assert.ok('.:'.includes(terrainAt(map, d.x, d.y)) && d.under === terrainAt(map, d.x, d.y), 'the ground stays ground');
        assert.ok(walkable(p, 'F0', d.x, d.y), 'you can stand on it without knowing');
        const hatch = props(p).find(pr => pr.door === d.id);
        assert.ok(hatch?.hidden && hatch.type === 'trapdoor', 'its hatch is a hidden prop');
    }
    const pen = Object.values(p.rooms).find(rm => rm.hut && rm.type === 'cell');
    assert.ok(hatches.some(d => inRect(pen.rect, d.x, d.y)), 'one in the pen');
    assert.ok(hatches.some(d => !inRect(pen.rect, d.x, d.y) && terrainAt(map, d.x, d.y) === '.'), 'one out in the woods');
    assert.ok(/woods/.test(p.buildings.TUN.description) && /pen/.test(p.buildings.TUN.description) && /lodge/.test(p.buildings.TUN.description), 'the DM is told where they are');
    // Finding one shows its hatch; the floor is still floor.
    const woods = hatches.find(d => !inRect(pen.rect, d.x, d.y));
    applyPlaceChanges(p, { doors: { [woods.id]: 'found' } });
    assert.equal(woods.state, 'closed');
    assert.ok(!props(p).find(pr => pr.door === woods.id).hidden, 'the hatch shows');
    assert.equal(terrainAt(map, woods.x, woods.y), woods.under);
    assert.equal(doorChar(woods), woods.under);
});

test('the insides: the chief in his lodge with a hatch under his rug; the flesh house with its question room and butcher', () => {
    const p = build(SKULL, 4);
    const insides = campInteriors(p, 4);
    const lodgeB = Object.values(p.buildings).find(b => b.kind === 'lodge');
    const lodge = insides.find(x => x.building === lodgeB.id).place;
    assert.equal(lodge.kind, 'interior'); assert.equal(lodge.fog, false);
    assert.ok(lodge.guards[lodgeB.keeper]?.hostile, 'the chief is inside');
    const hatch = lodge.doors.DH;
    assert.ok(hatch && hatch.kind === 'trapdoor' && hatch.state === 'hidden' && hatch.enter === 'TUN' && hatch.rooms[0] === 'CHAMBER', 'a hidden trapdoor in his chamber');
    assert.ok(lodge.floors[0].map.props.some(pr => pr.type === 'rug' && pr.x === hatch.x && pr.y === hatch.y), 'under a rug');
    assert.ok(lodge.buildings.TUN && lodge.buildings.TUN.door === 'DH' && lodge.buildings.TUN.interior === null, 'into the tunnels');
    assert.ok(walkable(lodge, lodge.rooms.CHAMBER.floor, hatch.x, hatch.y));
    const butcherB = Object.values(p.buildings).find(b => b.kind === 'butchery');
    const house = insides.find(x => x.building === butcherB.id).place;
    assert.ok(Object.values(house.rooms).some(rm => rm.type === 'torture_chamber'), 'a question room');
    const hp = house.floors[0].map.props;
    assert.ok(hp.some(pr => pr.type === 'carcass') && hp.some(pr => pr.type === 'hooks') && hp.filter(pr => pr.type === 'blood').length >= 6, 'carcasses, hooks and blood');
    assert.ok(house.guards[butcherB.keeper]?.hostile && house.guards[butcherB.keeper].sprite === 'human_cannibal', 'the butcher, a cannibal');
    assert.ok(Object.values(house.guards).some(g => g.role === 'prisoner' && g.held), 'someone on the rack');
    for (const { place } of insides) assert.ok(place.exits.length >= 1, `${place.name} has a way out`);
});

test('the tunnels: a maze of dirt and timber, every chamber reachable from every shaft, the shafts matched to the trapdoors', () => {
    const p = build(SKULL, 4);
    const insides = campInteriors(p, 4);
    const tun = insides.find(x => x.building === 'TUN').place;
    const map = tun.floors[0].map;
    assert.equal(map.theme, 'warren'); assert.ok(THEMES.includes('warren'));
    assert.equal(tun.fog, true); assert.ok(!tun.state.explored.F0.includes('1'), 'nothing known until seen');
    assert.equal(tun.exits.length, 3);
    const camHatches = Object.values(p.doors).filter(d => d.kind === 'trapdoor').map(d => d.id);
    for (const e of tun.exits) {
        assert.equal(terrainAt(map, e.x, e.y), '<', 'a ladder shaft');
        assert.ok(e.up && (e.up.host === null ? camHatches.includes(e.up.door) : e.up.host === Object.values(p.buildings).find(b => b.kind === 'lodge').id && e.up.door === 'DH'), `${e.label} comes up through its trapdoor`);
    }
    const chambers = Object.values(tun.rooms).filter(rm => !rm.id.startsWith('UP'));
    assert.ok(chambers.length >= 4, 'chambers off the maze');
    assert.ok(chambers.some(rm => rm.type === 'torture_chamber') && chambers.some(rm => rm.type === 'cell'), 'a question room and cages');
    for (const e of tun.exits) for (const rm of chambers) assert.ok(reachable(tun, { x: e.x, y: e.y }, rm.rect), `${rm.name} from ${e.label}`);
    const cages = chambers.find(rm => rm.type === 'cell');
    const cageDoor = Object.values(tun.doors).find(d => d.rooms[0] === cages.id);
    assert.ok(cageDoor.kind === 'cell' && cageDoor.state === 'locked');
    assert.ok(!reachable(tun, tun.start, cages.rect, false) && reachable(tun, tun.start, cages.rect, true), 'the cages are locked');
    assert.ok(Object.values(tun.guards).some(g => g.hostile), 'something lives down here');
    assert.ok(Object.values(tun.guards).some(g => g.role === 'prisoner' && g.held && g.room === cages.id), 'captives in the cages');
    assert.ok(map.props.filter(pr => pr.type === 'blood').length >= 10, 'blood everywhere');
    assert.ok(map.props.some(pr => pr.type === 'torch' && pr.facing), 'torches on the walls');
    assert.ok(map.props.some(pr => pr.type === 'carcass'), 'a larder');
    assert.ok(Object.keys(tun.traps).length >= 3);
    const doors = Object.values(tun.doors);
    for (const t of Object.values(tun.traps)) {
        assert.equal(t.state, 'hidden');
        assert.ok(doors.every(d => Math.abs(d.x - t.x) > 1 || Math.abs(d.y - t.y) > 1), 'traps away from doors');
        assert.ok(tun.exits.every(e => Math.abs(e.x - t.x) > 2 || Math.abs(e.y - t.y) > 2), 'and from the shafts');
    }
    assert.ok(Object.values(tun.items).some(i => /takings/.test(i.name)), 'the hoard');
    assert.deepEqual(generateTunnels(p.buildings.TUN, 77), generateTunnels(p.buildings.TUN, 77), 'the same seed digs the same maze');
    assert.notDeepEqual(generateTunnels(p.buildings.TUN, 78).floors[0].map.rows, generateTunnels(p.buildings.TUN, 77).floors[0].map.rows);
});

test('a plain band\'s tunnels are a bolt-hole and a hoard, not a horror; a camp can be told to have none', () => {
    const p = build({ name: 'Crowcamp', kind: 'bandit camp', size: 'big', summary: 'Bandits hold the heir for ransom.', start: 'outside', tunnels: 'yes', horror: 'plain' }, 6);
    assert.ok(p.camp.tunnels && !p.camp.horror);
    assert.ok(Object.values(p.buildings).some(b => b.kind === 'longhouse') && Object.values(p.buildings).some(b => b.kind === 'storehouse'), 'a long house and a store house');
    assert.equal(Object.values(p.doors).filter(d => d.kind === 'trapdoor').length, 1, 'only the woods trapdoor outside (the pen keeps no hatch)');
    const tun = campInteriors(p, 6).find(x => x.building === 'TUN').place;
    const map = tun.floors[0].map;
    assert.ok(Object.values(tun.rooms).some(rm => rm.id === 'BOLTHOLE') && Object.values(tun.rooms).some(rm => rm.id === 'HOARD'));
    assert.ok(!map.props.some(pr => pr.type === 'carcass') && !Object.values(tun.rooms).some(rm => rm.type === 'torture_chamber'));
    assert.ok(map.props.filter(pr => pr.type === 'blood').length <= 2);
    const hoardDoor = Object.values(tun.doors).find(d => d.rooms[0] === 'HOARD');
    assert.equal(hoardDoor.state, 'locked');
    const none = build({ name: 'Redstake', kind: 'bandit camp', size: 'small', summary: 'A small bandit camp.', start: 'outside', tunnels: 'no' }, 3);
    assert.ok(!none.camp.tunnels && !none.buildings.TUN && !Object.values(none.doors).some(d => d.kind === 'trapdoor'));
    assert.ok(campInteriors(none, 3).every(x => x.building !== 'TUN'));
    // Every house of every camp has an inside that can be walked out of, over seeds.
    for (let seed = 1; seed <= 5; seed++) for (const brief of [SKULL, { name: 'The Horde', kind: 'war camp', size: 'big', summary: 'A massive sprawling war camp of the horde, prisoners in cages. Tunnels under it.', start: 'outside' }]) {
        const camp = build(brief, seed);
        const ins = campInteriors(camp, seed);
        for (const b of Object.values(camp.buildings)) assert.ok(ins.some(x => x.building === b.id), `${brief.name} ${seed}: ${b.name} has an inside`);
        for (const { place } of ins) { assert.ok(place.exits.length >= 1); assert.ok(walkable(place, place.start.floor, place.start.x, place.start.y), `${place.name}: a dry start`); }
    }
});

test('the brief knows tunnels and horror; cannibals get their own figure', () => {
    const b = normalizeBrief({ name: 'x', kind: 'camp', tunnels: true, horror: 'gruesome' });
    assert.equal(b.tunnels, 'yes'); assert.equal(b.horror, 'gruesome');
    assert.equal(normalizeBrief({ name: 'x', kind: 'camp', tunnels: 'no', horror: 'none' }).horror, 'plain');
    assert.equal(presetFor('Cannibal 2'), 'human_cannibal');
    assert.equal(presetFor('Butcher 3 a butcher of the camp, scarred'), 'human_cannibal');
    assert.equal(presetFor('Bandit 2'), 'human_bandit');
    assert.equal(presetFor('Hob the butcher'), 'human_cook');
    assert.ok(PROPS.trapdoor && !PROPS.trapdoor.blocks && PROPS.carcass.blocks);
});
