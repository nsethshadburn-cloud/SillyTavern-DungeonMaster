// v0.60: the cuffed chase that never came. A run in words is a run; going along is an escort; the
// open woods have no snares by chance; the protocol says who rolls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saysRun, givesIn } from '../src/core/access.js';
import { normalizeBrief, wildsFromBrief } from '../src/core/architect.js';
import { DM_RULES } from '../src/core/protocol.js';
import { repeatedTopics } from '../src/core/text.js';

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
