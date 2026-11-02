// v0.60: the cuffed chase that never came. A run in words is a run; going along is an escort; the
// open woods have no snares by chance; the protocol says who rolls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saysRun, givesIn } from '../src/core/access.js';
import { normalizeBrief, wildsFromBrief } from '../src/core/architect.js';
import { DM_RULES } from '../src/core/protocol.js';
import { repeatedTopics } from '../src/core/text.js';
import { keeperWords, asksAlong, parseKeeperStance } from '../src/core/triage.js';
import { applyPlaceChanges } from '../src/core/explore.js';

test('"I run" is running; a hand run along a wall is not', () => {
    for (const s of ['I run', 'Amber runs for the trees', '*I bolt*', 'I sprint off', 'I keep running', 'I make a break for it', 'I dash into the woods', 'I take off']) assert.ok(saysRun(s), s);
    for (const s of ['I run my hand along the wall', 'she runs her fingers over the lock', 'I walk beside Judy', 'I stop and wait', 'amber attempts to trip judy so he can get away']) assert.ok(!saysRun(s), s);
});

test('going along in words is giving in, not running', () => {
    assert.ok(givesIn("fine, I'll come"));
    assert.ok(givesIn('okay, you win'));
    assert.ok(!givesIn('I run'));
    assert.ok(!saysRun("fine, I'll come"));
});

test('the open woods have no snares by chance; "few" sets at least one', () => {
    const none = normalizeBrief({ name: 'Gorund Wood', kind: 'forest', size: 'medium', summary: 'deep woods' }, {});
    assert.equal(none.traps, '');
    for (let seed = 1; seed <= 8; seed++) assert.equal(wildsFromBrief(none, seed).rooms.reduce((n, r) => n + r.traps.length, 0), 0, `seed ${seed}`);
    const few = normalizeBrief({ name: 'Gorund Wood', kind: 'forest', size: 'medium', summary: 'hunters set snares here', traps: 'few' }, {});
    for (let seed = 1; seed <= 4; seed++) assert.ok(wildsFromBrief(few, seed).rooms.reduce((n, r) => n + r.traps.length, 0) >= 1, `seed ${seed}`);
    const camp = normalizeBrief({ name: "Amber's camp", kind: 'forest camp', size: 'small', summary: "Amber's small camp in the woods: one tent and a fire.", traps: 'many' }, {});
    assert.equal(wildsFromBrief(camp, 2).rooms.reduce((n, r) => n + r.traps.length, 0), 0, 'the party\'s own camp has no snares');
});

test('the protocol says the code rolls the chase, and a companion who grabs has custody', () => {
    assert.ok(/never ask the player to roll to get away, outrun or dodge their keeper/.test(DM_RULES));
    assert.ok(/when no CUSTODY is set has them: send custody that turn/.test(DM_RULES));
    assert.ok(/tripping, shoving or striking their keeper is their own contested roll/.test(DM_RULES));
    assert.ok(/A keeper on the ground gets up before she grabs again/.test(DM_RULES));
    assert.ok(/HIDDEN TRAPS are yours alone/.test(DM_RULES));
    assert.ok(/SAY IT ONCE/.test(DM_RULES));
    assert.ok(/searches for them by code/.test(DM_RULES));
});
test('a subject brought up in nearly every reply is named; names and one-offs never', () => {
    const replies = [
        '"Stop! There\'s a pit ahead!" *Judy lunges.*',
        '"Amber, listen: a covered pit, ten feet on. You\'ll fall!"',
        '*She hauls on his arm.* "The pit. Right there. Don\'t."',
        '"AMBER, the pit trap! It\'s covered!"',
    ];
    const topics = repeatedTopics(replies, { exclude: ['Amber', 'Judy Hopps'] });
    assert.ok(topics.includes('pit'), topics.join(', '));
    assert.ok(!topics.includes('amber'));
    assert.deepEqual(repeatedTopics(['Hello there.', 'Something else entirely.', 'A third thing.']), []);
    assert.deepEqual(repeatedTopics(replies.slice(0, 2)), [], 'too few replies to call it a habit');
});
const openPlace = () => ({
    name: 'Camp', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w: 20, h: 10, rows: Array(10).fill('.'.repeat(20)), theme: 'forest', props: [] } }],
    rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {},
    state: { positions: { Amber: { floor: 'F0', x: 3, y: 3 }, 'Judy Hopps': { floor: 'F0', x: 2, y: 3 } }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0', built: true },
});

test('a keeper\'s words: "stay put" is guard mode, "I\'ll follow you" is companion mode, talk is neither', () => {
    for (const s of ['"Sit down and don\'t move."', '*She plants a hand on his shoulder.* "Stay put."', '"You\'re not going anywhere, Amber."', '"Stay right there while I check the fire."']) assert.equal(keeperWords(s), 'guard', s);
    for (const s of ['"Fine. I\'ll follow you to the fire."', '"Lead the way, then."', '"Have it your way. I\'m right behind you."', '"Let\'s go."']) assert.equal(keeperWords(s), 'companion', s);
    for (const s of ['"Was anyone else at the counting house?"', '*Her ears droop.* "I didn\'t write the warrant."', '"There\'s a pit ahead."']) assert.equal(keeperWords(s), '', s);
    assert.equal(parseKeeperStance('{"mode": "guard"}'), 'guard');
    assert.equal(parseKeeperStance('{"mode": "maybe"}'), '');
});

test('the player asking their keeper along is walking together, not away', () => {
    for (const s of ['Judy, come with me to the fire', "let's go back to camp", 'follow me']) assert.ok(asksAlong(s), s);
    for (const s of ['I run for the trees', 'I sit by the fire', 'where is the fire?']) assert.ok(!asksAlong(s), s);
});

test('custody starts in guard mode; the DM can set companion; a re-send keeps the mode', () => {
    const place = openPlace();
    let log = applyPlaceChanges(place, { custody: { Amber: { by: 'Judy', radius: 2 } } });
    assert.equal(place.state.custody.Amber.mode, 'guard', log.join(' | '));
    assert.ok(log.some(l => /GUARD mode/.test(l)), log.join(' | '));
    applyPlaceChanges(place, { custody: { Amber: { by: 'Judy', mode: 'companion' } } });
    assert.equal(place.state.custody.Amber.mode, 'companion');
    place.state.custody.Amber.chase = true;
    applyPlaceChanges(place, { custody: { Amber: { by: 'Judy Hopps', radius: 3 } } });
    assert.equal(place.state.custody.Amber.mode, 'companion', 'a re-send without a mode keeps it');
    assert.equal(place.state.custody.Amber.chase, true, 'and keeps a chase');
    assert.equal(place.state.custody.Amber.radius, 3);
    assert.ok(/GUARD \(the keeper has told them to stay/.test(DM_RULES));
    assert.ok(/COMPANION \(the keeper lets them walk/.test(DM_RULES));
});
