// A wagon's inside: a tiny place of its own, entered from the map by climbing into the wagon prop.
// An open wagon is boards round a bed of planks with a way off on either side; a jailer's wagon is
// iron bars with one steel door, locked, that has to be picked or broken from inside. The party in a
// wagon comes out beside it wherever the wagon stands (the DM moves it with props.move, horses and
// all). Pure module.

import { ensureIds, clearDoorways } from './layout.js';

/**
 * @param {'open'|'jail'} kind
 * @param {{name?: string, seed?: number}} [o]
 */
export function generateWagon(kind = 'open', { name = '', seed = 1 } = {}) {
    const jail = kind === 'jail';
    const W = 7, H = 5;
    const c = [...Array(H)].map(() => Array(W).fill('.'));
    for (let x = 0; x < W; x++) { c[0][x] = jail ? 'I' : '#'; c[H - 1][x] = jail ? 'I' : '#'; }
    for (let y = 0; y < H; y++) { c[y][0] = jail ? 'I' : '#'; c[y][W - 1] = jail ? 'I' : '#'; }
    if (jail) for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) c[y][x] = '#';
    const title = name || (jail ? 'the jailer\'s wagon' : 'the wagon');
    const map = { w: W, h: H, rows: [], theme: 'ship', props: [], areas: [{ x: 0, y: 0, w: W, h: H, floor: 'planks', wall: 'timber' }], roofs: [], seed, ambience: 'none' };
    const place = {
        version: 1, kind: 'interior', name: title, theme: 'ship', fog: false, seed, vehicle: kind,
        summary: jail ? 'Inside a jailer\'s wagon: iron bars on every side, a bed of planks, one steel door, locked.' : 'Inside an open wagon: boards, planks and straw, open to climb off on either side.',
        floors: [{ id: 'F0', name: title, level: 0, map }], rooms: {}, doors: {}, stairs: [], traps: {}, items: {}, guards: {}, exits: [], buildings: {},
        start: { floor: 'F0', x: 3, y: 2, room: 'WAGON' }, state: { positions: {}, explored: { F0: '1'.repeat(W * H) }, visited: [], floor: 'F0' },
    };
    place.rooms.WAGON = { id: 'WAGON', name: jail ? 'Inside the jailer\'s wagon' : 'Inside the wagon', type: 'room', floor: 'F0', rect: { x: 1, y: 1, w: 5, h: 3 }, lit: !jail, description: place.summary, exit: true };
    if (jail) {
        // One steel door at the back, locked: pick it (DC 15), find the key, or break it.
        c[2][W - 1] = 'D';
        place.doors.D1 = { id: 'D1', floor: 'F0', x: W - 1, y: 2, kind: 'locked', state: 'locked', rooms: ['WAGON', null], exit: true, dc: 15, key: 'the wagon key', name: 'steel door' };
        place.exits.push({ floor: 'F0', x: W - 1, y: 2, door: 'D1' });
        map.props.push({ x: 2, y: H - 1, type: 'chains', facing: 's' }, { x: 4, y: 0, type: 'chains', facing: 'n' }, { x: 1, y: 1, type: 'hay' }, { x: 5, y: 1, type: 'pot', label: 'a slop bucket' }, { x: 3, y: 3, type: 'bones' }, { x: 2, y: 2, type: 'scratches' }, { x: 4, y: 3, type: 'blood' });
    } else {
        // Open on both long sides: step off the boards and you're on the ground beside it.
        for (const [x, y, id] of [[3, 0, 'D1'], [3, H - 1, 'D2']]) {
            c[y][x] = '.';
            place.doors[id] = { id, floor: 'F0', x, y, kind: 'arch', state: 'open', rooms: ['WAGON', null], exit: true, name: y === 0 ? 'the near side' : 'the far side' };
            place.exits.push({ floor: 'F0', x, y, door: id });
        }
        map.props.push({ x: 1, y: 1, type: 'hay' }, { x: 5, y: 3, type: 'crate' }, { x: 5, y: 1, type: 'sack' }, { x: 1, y: 3, type: 'barrel' });
    }
    map.rows = c.slice().reverse().map(row => row.join(''));
    ensureIds(place);
    clearDoorways(place);
    return place;
}
