// v0.60-v0.64: a run in words is a run; the open woods have no snares by chance; repeated subjects
// are named; a sword drawn "not to attack" is no attack; a mountain pass is built as one.
// (The keeper's words and the player's are read by the referee since v0.65: tests/custody.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { saysRun, givesIn } from '../src/core/access.js';
import { normalizeBrief, wildsFromBrief } from '../src/core/architect.js';
import { DM_RULES } from '../src/core/protocol.js';
import { repeatedTopics } from '../src/core/text.js';
import { attacksSomeone } from '../src/core/triage.js';

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

test('the protocol says what is the code\'s: hidden traps, saying it once, the roll before its outcome', () => {
    assert.ok(/A keeper on the ground gets up before she grabs again/.test(DM_RULES));
    assert.ok(/HIDDEN TRAPS are yours alone/.test(DM_RULES));
    assert.ok(/SAY IT ONCE/.test(DM_RULES));
    assert.ok(/Custody ends by itself when the restraints are off/.test(DM_RULES));
    assert.ok(/The dice say, and the next turn tells what came of it/.test(DM_RULES));
    assert.ok(/A companion grabbing for the player .* is the code's contest/.test(DM_RULES));
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

test('drawing a sword "not to attack" is no attack; a stab is', () => {
    assert.ok(!attacksSomeone('*amber draws his short sword, not to attack, but just to show he will defend himself*'));
    assert.ok(!attacksSomeone('I raise the blade, only to warn her off'));
    assert.ok(attacksSomeone('amber uses his short sword to stab the raider right beside him'));
});

test('v0.64: a mountain pass is built as one (its spots, its rock), and the brief\'s hidden pit is a trap in that spot', () => {
    const brief = normalizeBrief({ name: 'Saltback Pass', kind: 'mountain pass', summary: 'A narrow trail over the pass, a sheer drop on one side; a bandit toll-post up the trail.', rooms: [{ room: 'The path below the toll-post', has: ['hidden pit', 'a three-pebble cairn'] }] });
    assert.ok(brief.rooms[0].trapped, 'the pit in "has" marks the spot trapped');
    const plan = wildsFromBrief(brief, 5);
    assert.ok(plan.rooms.some(x => /Switchback|Scree|Boulder Field|The Drop|Ledge|Rockfall|Cairn|Wind Gap|Goat Track|Cold Spring|Waystone|Shelter|Eagle/.test(x.name)), plan.rooms.map(x => x.name).join(', '));
    assert.ok(!plan.rooms.some(x => /Ford|Graves|Den|Stream Pool|Shrine|Old Ruin|Edge of the Trees/.test(x.name)), plan.rooms.map(x => x.name).join(', '));
    const spot = plan.rooms.find(x => /path below/i.test(x.name));
    assert.ok(spot && spot.traps.length >= 1 && spot.traps[0].hidden, 'the pit is a hidden trap in that spot');
});
