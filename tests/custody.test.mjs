// v0.65: custody as a small state machine, every transition a table; the referee's prompts and
// its one-word parser. No model, no map: these are the rules the live code enforces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, newRecord, onPlayerVerdict, onKeeperVerdict, stepBefore, stepAfter, afterStep, onSlip, onGrab, onTrip, freed, fromOp, PLAYER_VERDICTS, KEEPER_VERDICTS } from '../src/core/custody.js';
import { REFEREE_SYSTEM, playerLinePrompt, keeperLinePrompt, grabPrompt, parseWord } from '../src/core/referee.js';
import { applyPlaceChanges } from '../src/core/explore.js';
import { DM_RULES } from '../src/core/protocol.js';

const guard = (extra = {}) => ({ by: 'Judy Hopps', radius: 2, mode: 'guard', attempts: 0, ...extra });
const companion = (extra = {}) => ({ by: 'Judy Hopps', radius: 2, mode: 'companion', attempts: 0, ...extra });
const chasing = (extra = {}) => guard({ chase: true, attempts: 1, ...extra });

test('a record is three facts and a counter; older fields are dropped; no mode reads as guard', () => {
    assert.deepEqual(normalizeRecord({ by: 'Judy Hopps', radius: 2, attempts: 0, mode: 'guard', escortUntil: 4, slipped: true, grace: 3, search: {}, hid: 12, lastSeen: { x: 1, y: 1 } }), guard());
    assert.deepEqual(normalizeRecord({ by: 'Judy Hopps', radius: 9, chase: true, lastGrabTurn: 3 }), guard({ radius: 6, chase: true, lastGrabTurn: 3 }));
    assert.equal(normalizeRecord({ radius: 2 }), null);
    assert.equal(normalizeRecord(null), null);
    assert.deepEqual(newRecord('Judy Hopps'), guard());
});

test('the player\'s line: every verdict against every state', () => {
    const table = [
        // [state, verdict, next mode, next chase, event]
        [guard(), 'run', 'guard', true, 'bolt'],
        [companion(), 'run', 'companion', true, 'bolt'],
        [chasing(), 'run', 'guard', true, 'bolt'],
        [guard(), 'along', 'companion', false, 'along'],
        [companion(), 'along', 'companion', false, ''],
        [chasing(), 'along', 'companion', false, 'along'],
        [guard(), 'give', 'guard', false, ''],
        [companion(), 'give', 'guard', false, ''],
        [chasing(), 'give', 'guard', false, 'give'],
        [guard(), 'trip', 'guard', false, 'trip'],
        [chasing(), 'trip', 'guard', true, 'trip'],
        [guard(), 'none', 'guard', false, ''],
        [chasing(), 'none', 'guard', true, ''],
    ];
    for (const [state, verdict, mode, chase, event] of table) {
        const out = onPlayerVerdict(state, verdict);
        assert.equal(out.event, event, `${state.mode}${state.chase ? '+chase' : ''} / ${verdict}: event`);
        assert.equal(out.rec.mode, mode, `${state.mode}${state.chase ? '+chase' : ''} / ${verdict}: mode`);
        assert.equal(Boolean(out.rec.chase), chase, `${state.mode}${state.chase ? '+chase' : ''} / ${verdict}: chase`);
        assert.notEqual(out.rec, state, 'never mutates the record it was given');
    }
    assert.deepEqual(PLAYER_VERDICTS, ['run', 'along', 'give', 'trip', 'none']);
});

test('the keeper\'s line: "stay" guards, "along" lets go (a chase too), talk changes nothing', () => {
    const table = [
        [guard(), 'stay', 'guard', false, ''],
        [companion(), 'stay', 'guard', false, 'guard'],
        [chasing(), 'stay', 'guard', true, ''],
        [guard(), 'along', 'companion', false, 'companion'],
        [companion(), 'along', 'companion', false, ''],
        [chasing(), 'along', 'companion', false, 'companion'],
        [guard(), 'none', 'guard', false, ''],
        [chasing(), 'none', 'guard', true, ''],
    ];
    for (const [state, verdict, mode, chase, event] of table) {
        const out = onKeeperVerdict(state, verdict);
        assert.equal(out.event, event, `${state.mode}${state.chase ? '+chase' : ''} / ${verdict}: event`);
        assert.equal(out.rec.mode, mode);
        assert.equal(Boolean(out.rec.chase), chase);
    }
    assert.deepEqual(KEEPER_VERDICTS, ['stay', 'along', 'none']);
});

test('a step on the map, before she moves: walking back into her reach mid-chase is being caught', () => {
    assert.equal(stepBefore(chasing(), { gap: 1, prevGap: 3, keeperProne: false }), 'caught');
    assert.equal(stepBefore(chasing(), { gap: 1, prevGap: 1, keeperProne: false }), '', 'she was already beside him: not his doing');
    assert.equal(stepBefore(chasing(), { gap: 1, prevGap: 2, keeperProne: true }), '', 'she is on the ground: nobody to walk into');
    assert.equal(stepBefore(guard(), { gap: 1, prevGap: 3, keeperProne: false }), '', 'no chase: walking up to her is just walking');
    assert.equal(stepBefore(chasing(), { gap: 2, prevGap: 3, keeperProne: false }), '');
    assert.deepEqual(afterStep(chasing(), 'caught'), guard());
});

test('a step on the map, after she moves: the chase starts, grabs, stands her up, or loses him', () => {
    const t = 7;
    // Guard mode: inside the radius, nothing; beyond it in her sight, the chase; beyond it unseen, nothing (she didn't see him go).
    assert.equal(stepAfter(guard(), { gap: 2, fromStart: 2, sees: true, keeperProne: false, turn: t }), '');
    assert.equal(stepAfter(guard(), { gap: 3, fromStart: 3, sees: true, keeperProne: false, turn: t }), 'start');
    assert.equal(stepAfter(guard(), { gap: 1, fromStart: 3, sees: true, keeperProne: false, turn: t }), 'start', 'from where she stood counts too');
    assert.equal(stepAfter(guard(), { gap: 3, fromStart: 3, sees: false, keeperProne: false, turn: t }), '');
    assert.equal(stepAfter(guard({ radius: 4 }), { gap: 3, fromStart: 3, sees: true, keeperProne: false, turn: t }), '');
    // Companion mode: a walk is never an escape.
    assert.equal(stepAfter(companion(), { gap: 9, fromStart: 9, sees: true, keeperProne: false, turn: t }), '');
    // A chase: within reach, the grab (once a turn); on the ground, she gets up; out of sight, lost; otherwise she keeps coming.
    assert.equal(stepAfter(chasing(), { gap: 1, fromStart: 5, sees: true, keeperProne: false, turn: t }), 'grab');
    assert.equal(stepAfter(chasing({ lastGrabTurn: t }), { gap: 1, fromStart: 5, sees: true, keeperProne: false, turn: t }), '', 'one grab a turn');
    assert.equal(stepAfter(chasing(), { gap: 1, fromStart: 5, sees: true, keeperProne: true, turn: t }), 'standup');
    assert.equal(stepAfter(chasing(), { gap: 4, fromStart: 5, sees: false, keeperProne: false, turn: t }), 'lost');
    assert.equal(stepAfter(chasing(), { gap: 4, fromStart: 5, sees: true, keeperProne: false, turn: t }), '');
    assert.equal(afterStep(guard(), 'start').chase, true);
    assert.equal(afterStep(chasing(), 'lost').chase, undefined);
    assert.equal(afterStep(chasing(), 'lost').mode, 'guard', 'lost, she still means him to stay: the next step she sees is an escape again');
});

test('the grab and its roll: a miss is held in guard mode, a slip keeps the chase, three slips and she can\'t hold him', () => {
    const g1 = onGrab(chasing({ attempts: 0 }), 7);
    assert.equal(g1.attempts, 1);
    assert.equal(g1.lastGrabTurn, 7);
    const miss = onSlip(onGrab(companion({ chase: true }), 7), false);
    assert.equal(miss.held, true);
    assert.deepEqual(miss.rec, guard({ lastGrabTurn: 7 }));
    const slip = onSlip(onGrab(chasing({ attempts: 1 }), 8), true);
    assert.equal(slip.held, false);
    assert.equal(slip.tries, 2);
    assert.equal(slip.rec.chase, true, 'she stays after him');
    assert.equal(onSlip(chasing({ attempts: 3 }), true).exhausted, true);
});

test('the trip: landed, her hold is broken and the chase is hers to run once she\'s up; missed, she has him', () => {
    assert.deepEqual(onTrip(chasing(), true), chasing());
    assert.deepEqual(onTrip(chasing(), false), guard());
    assert.deepEqual(onTrip(companion(), false), guard());
});

test('free hands end custody; the DM\'s op keeps a chase and the mode unless it says', () => {
    assert.equal(freed({ bound: false, grappled: false }), true);
    assert.equal(freed({ bound: true, grappled: false }), false);
    assert.equal(freed({ bound: false, grappled: true }), false);
    assert.deepEqual(fromOp(null, { by: 'Judy Hopps' }), guard());
    assert.deepEqual(fromOp(chasing({ radius: 3 }), { by: 'Judy Hopps' }), guard({ radius: 3, chase: true }));
    assert.deepEqual(fromOp(chasing(), { by: 'Judy Hopps', mode: 'companion', chase: false }), companion());
    assert.deepEqual(fromOp(guard(), { by: 'Judy Hopps', chase: true }), guard({ chase: true }));
    assert.deepEqual(fromOp(chasing(), { by: 'Hobb' }), { by: 'Hobb', radius: 2, attempts: 0, mode: 'guard' }, 'a new keeper starts fresh');
});

test('the custody op on a place: a name, a mode, a chase, an end', () => {
    const place = { name: 'Camp', kind: 'forest', floors: [{ id: 'F0', name: 'x', level: 0, map: { w: 20, h: 10, rows: Array(10).fill('.'.repeat(20)), theme: 'forest', props: [] } }], rooms: {}, doors: {}, traps: {}, items: {}, guards: {}, stairs: [], exits: [], buildings: {}, state: { positions: { Amber: { floor: 'F0', x: 3, y: 3 }, 'Judy Hopps': { floor: 'F0', x: 2, y: 3 } }, party: ['Amber', 'Judy Hopps'], explored: {}, visited: [], floor: 'F0', built: true } };
    let log = applyPlaceChanges(place, { custody: { Amber: { by: 'Judy', radius: 2 } } });
    assert.deepEqual(place.state.custody.Amber, guard(), log.join(' | '));
    assert.ok(log.some(l => /GUARD mode/.test(l)));
    applyPlaceChanges(place, { custody: { Amber: { by: 'Judy', mode: 'companion' } } });
    assert.equal(place.state.custody.Amber.mode, 'companion');
    applyPlaceChanges(place, { custody: { Amber: { by: 'Judy Hopps', chase: true } } });
    assert.deepEqual(place.state.custody.Amber, companion({ chase: true }));
    applyPlaceChanges(place, { custody: { Amber: { by: 'Judy Hopps', radius: 3 } } });
    assert.deepEqual(place.state.custody.Amber, companion({ radius: 3, chase: true }), 'a re-send without a mode keeps it, and keeps a chase');
    applyPlaceChanges(place, { custody: { Amber: '' } });
    assert.ok(!place.state.custody.Amber);
});

test('the referee: one word, from a short list; anything else is the "nothing" answer', () => {
    assert.equal(parseWord('run', PLAYER_VERDICTS), 'run');
    assert.equal(parseWord('  Along.', PLAYER_VERDICTS), 'along');
    assert.equal(parseWord('TRIP\n', PLAYER_VERDICTS), 'trip');
    assert.equal(parseWord('The player runs', PLAYER_VERDICTS), 'none', 'a sentence is no answer');
    assert.equal(parseWord('', PLAYER_VERDICTS), 'none');
    assert.equal(parseWord('maybe', KEEPER_VERDICTS), 'none');
    assert.equal(parseWord('Yes', ['yes', 'no']), 'yes');
    assert.equal(parseWord('nope', ['yes', 'no']), 'no');
    assert.match(REFEREE_SYSTEM, /ONE word/);
    const p = playerLinePrompt({ keeper: 'Judy Hopps', player: 'Amber', text: '*Amber bolts for the trees*', mode: 'guard', chase: false });
    for (const w of ['run -', 'along -', 'give -', 'trip -', 'none -', 'Amber bolts for the trees', 'told Amber to stay close']) assert.ok(p.includes(w), w);
    assert.ok(playerLinePrompt({ keeper: 'Judy Hopps', player: 'Amber', text: 'x', mode: 'companion', chase: true }).includes('is chasing Amber'));
    const k = keeperLinePrompt({ keeper: 'Judy Hopps', player: 'Amber', text: '"Stay put."', chase: false });
    for (const w of ['stay -', 'along -', 'none -', 'Stay put']) assert.ok(k.includes(w), w);
    const g = grabPrompt({ keeper: 'Judy Hopps', player: 'Amber', text: 'Judy grabs for his wrists' });
    for (const w of ['yes -', 'no -', 'grabs for his wrists']) assert.ok(g.includes(w), w);
    assert.ok(playerLinePrompt({ keeper: 'J', player: 'A', text: 'x'.repeat(2000), mode: 'guard' }).length < 1500, 'a long line is cut');
});

test('the protocol tells the DM the three facts and what is the code\'s', () => {
    assert.ok(/The code keeps three facts and runs everything from them/.test(DM_RULES));
    assert.ok(/a referee reads each line/.test(DM_RULES));
    assert.ok(/"chase": true when she notices them gone/.test(DM_RULES));
    assert.ok(/never ask the player to roll to get away, outrun, dodge, trip, shove or twist free/.test(DM_RULES));
    assert.ok(/Walking back up to her mid-chase is being caught, no roll/.test(DM_RULES));
    assert.ok(/lost to her: the chase is off/.test(DM_RULES));
});
