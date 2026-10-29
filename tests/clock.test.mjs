// v0.34: the world's clock and weather. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { wordFor, parseTime, parseDuration, createClock, ensureClock, advanceClock, setClock, passTime, skipTo, clockText, hhmm, parseWeather, climateOf, driftWeather, weatherAmbience, weatherFlags, WEATHERS } from '../src/core/clock.js';
import { createWorldState, worldFlags, isNight, isLate } from '../src/core/world.js';
import { computeVisible, FOG_SIGHT } from '../src/core/explore.js';
import { normalizeDmTurn } from '../src/core/protocol.js';
import { applyStateChanges } from '../src/core/world.js';
import { expireConditions, untilWords } from '../src/core/upkeep.js';
import { dampen, ignite, tickFire } from '../src/core/fire.js';
import { whenLabel } from '../src/core/state.js';
import { renderTemplate, DEFAULT_TEMPLATES, OLD_DEFAULTS } from '../src/core/notes.js';
import { parseBookkeeping } from '../src/core/bookkeeper.js';

test('the time of day in words follows the hour', () => {
    assert.equal(wordFor(0), 'night');
    assert.equal(wordFor(6 * 60), 'dawn');
    assert.equal(wordFor(9 * 60), 'morning');
    assert.equal(wordFor(14 * 60), 'afternoon');
    assert.equal(wordFor(18 * 60), 'evening');
    assert.equal(wordFor(23 * 60), 'night');
    assert.equal(hhmm(22 * 60 + 5), '22:05');
});

test('times and durations are read from words and numbers', () => {
    assert.equal(parseTime('06:30'), 390);
    assert.equal(parseTime('6pm'), 18 * 60);
    assert.equal(parseTime('12 am'), 0);
    assert.equal(parseTime('dawn'), 360);
    assert.equal(parseTime('late afternoon'), 960);
    assert.equal(parseTime('just before dawn'), 360);
    assert.equal(parseTime('whenever'), null);
    assert.equal(parseDuration('3 hours'), 180);
    assert.equal(parseDuration('an hour'), 60);
    assert.equal(parseDuration('half an hour'), 30);
    assert.equal(parseDuration('20 minutes'), 20);
    assert.equal(parseDuration('a day'), 1440);
    assert.equal(parseDuration('two days'), 2880);
    assert.equal(parseDuration('all night'), 480);
    assert.equal(parseDuration('a while'), null);
});

test('the clock is made from the old time word, ticks forward, and rolls the day over', () => {
    const w = createWorldState();
    w.time = 'evening';
    w.day = 2;
    const c = ensureClock(w);
    assert.equal(c.day, 2);
    assert.equal(wordFor(c.minutes), 'evening');
    assert.equal(w.weather, 'clear');
    const hours = advanceClock(w, 7 * 60 + 30);
    assert.equal(hours, 7, 'hour boundaries crossed');
    assert.equal(w.day, 3, 'past midnight: the next day');
    assert.equal(w.time, 'night');
    assert.match(clockText(w), /^Day 3, 02:30 \(night\)$/);
    assert.deepEqual(createClock('noon', 5), { day: 5, minutes: 720 });
});

test('the DM skips ahead only forward: "dawn" at 22:00 is tomorrow, "day 3 noon" is that day', () => {
    const w = createWorldState();
    w.clock = { day: 1, minutes: 22 * 60 };
    assert.equal(setClock(w, 'dawn'), 8 * 60, 'eight hours to dawn');
    assert.equal(w.day, 2);
    assert.equal(w.time, 'dawn');
    assert.equal(setClock(w, 'until dusk'), 13 * 60);
    assert.equal(w.day, 2);
    assert.equal(setClock(w, 'day 3 noon'), 17 * 60);
    assert.equal(w.day, 3);
    assert.equal(setClock(w, 'tomorrow morning'), 20 * 60);
    assert.equal(w.day, 4);
    assert.equal(setClock(w, 'sometime'), null, 'no time named: nothing happens');
    assert.equal(w.day, 4);
});

test('weather: read from words, drifts by climate as hours pass, shows on outdoor maps, and flags the deck', () => {
    assert.equal(parseWeather('it starts raining'), 'rain');
    assert.equal(parseWeather('a thunderstorm rolls in'), 'storm');
    assert.equal(parseWeather('misty'), 'fog');
    assert.equal(parseWeather('sunny and clear'), 'clear');
    assert.equal(parseWeather('nothing much'), null);
    assert.equal(climateOf('wild', 'snow'), 'cold');
    assert.equal(climateOf('road', 'desert'), 'dry');
    assert.equal(climateOf('sea', ''), 'wet');
    assert.equal(climateOf('town', 'town'), 'temperate');
    for (const k of WEATHERS) for (const cl of ['temperate', 'cold', 'dry', 'wet']) assert.ok(WEATHERS.includes(driftWeather(k, cl, () => 0.99)), `${cl}/${k} drifts to a real kind`);
    assert.equal(driftWeather('overcast', 'cold', () => 0.1), 'snow');
    assert.equal(driftWeather('clear', 'dry', () => 0.5), 'clear');
    const w = createWorldState();
    w.clock = { day: 1, minutes: 9 * 60 };
    let r = passTime(w, 10, { rng: () => 0 });
    assert.equal(r.weather, null, 'ten minutes: no hour crossed, nothing drifts');
    r = passTime(w, 60, { climate: 'temperate', rng: () => 0.0 });
    assert.equal(r.weather, null, 'drifted, but clear to clear is no change');
    w.weather = 'overcast';
    r = passTime(w, 60, { climate: 'cold', rng: () => 0.0 });
    assert.equal(r.weather, 'snow');
    assert.equal(w.weather, 'snow');
    const s = skipTo(w, 'dawn', { climate: 'dry', rng: () => 0.0 });
    assert.ok(s.skipped > 0);
    assert.equal(w.weather, 'clear', 'a dry climate clears up over the hours skipped');
    assert.equal(weatherAmbience('rain'), 'rain');
    assert.equal(weatherAmbience('wind', 'desert'), 'sand');
    assert.equal(weatherAmbience('clear'), null);
    assert.deepEqual([...weatherFlags('storm')].sort(), ['bad_weather', 'storm', 'wet']);
    w.weather = 'rain';
    w.time = 'morning';
    const flags = worldFlags(w);
    assert.ok(flags.has('rain') && flags.has('wet') && flags.has('day') && flags.has('morning'));
    assert.equal(isNight('dawn'), false);
    assert.equal(isLate('dawn'), false);
});

test('fog outdoors: nobody sees past a few squares', () => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push('.'.repeat(20));
    const place = { name: 'Road', kind: 'wild', fog: true, floors: [{ id: 'F0', name: 'Road', level: 0, map: { w: 20, h: 3, rows, theme: 'forest', props: [], version: 0 } }], rooms: {}, doors: {}, traps: {}, items: {}, exits: [], stairs: [], buildings: {}, windows: {}, guards: {}, state: { positions: {}, explored: {}, visited: [], floor: 'F0' } };
    const map = place.floors[0].map;
    let vis = computeVisible(place, 'F0', [{ x: 2, y: 1 }]);
    assert.equal(vis[1 * map.w + 10], 1, 'a clear day: eight squares down the road');
    place.state.weather = 'fog';
    vis = computeVisible(place, 'F0', [{ x: 2, y: 1 }]);
    assert.equal(vis[1 * map.w + 2 + FOG_SIGHT], 1, 'fog: four squares');
    assert.equal(vis[1 * map.w + 2 + FOG_SIGHT + 1], 0, 'and no more');
});

test('the DM\'s turn carries clock and weather fields', () => {
    const t = normalizeDmTurn({ narration: 'x', clock: { advance: '3 hours' }, weather: 'rain' });
    assert.deepEqual(t.clock, { advance: '3 hours', set: '' });
    assert.equal(t.weather, 'rain');
    assert.deepEqual(normalizeDmTurn({ clock: 'dawn' }).clock, { advance: '', set: 'dawn' });
    assert.equal(normalizeDmTurn({}).clock, null);
});

test('a condition that lasts an hour ends by the clock: a night\'s sleep or a time skip ages it', () => {
    const w = createWorldState();
    w.party = { Amber: { hp: 10, hp_max: 10, conditions: [] } };
    w.clock = { day: 1, minutes: 20 * 60 };
    applyStateChanges(w, { conditions_add: { Amber: ['poisoned (1 hour)', 'frightened (2 turns)'] } }, ['Amber'], { turn: 5 });
    assert.deepEqual(w.party.Amber.conditions, ['poisoned', 'frightened']);
    assert.match(untilWords(w, 'Amber', 'poisoned', { turn: 5 }), /about an hour more/);
    advanceClock(w, 30);
    assert.equal(expireConditions(w, { turn: 6 }).length, 0, 'half an hour on: still poisoned');
    assert.match(untilWords(w, 'Amber', 'poisoned', { turn: 6 }), /30 more minutes/);
    setClock(w, 'dawn');
    const ended = expireConditions(w, { turn: 6 });
    assert.deepEqual(ended, ['Amber is no longer poisoned'], 'slept till dawn: the poison has run its course (the turn-counted one has not)');
    assert.deepEqual(expireConditions(w, { turn: 7 }), ['Amber is no longer frightened']);
    // Without a clock (an old campaign), hours still count in turns.
    const old = createWorldState();
    old.clock = null;
    old.party = { Amber: { hp: 10, hp_max: 10, conditions: [] } };
    applyStateChanges(old, { conditions_add: { Amber: ['poisoned (1 hour)'] } }, ['Amber'], { turn: 1 });
    assert.equal(expireConditions(old, { turn: 6 }).length, 0);
    assert.equal(expireConditions(old, { turn: 7 }).length, 1);
});

test('rain damps a fire down and nothing catches', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push('_'.repeat(9));
    const map = { w: 9, h: 5, rows, theme: 'forest', props: [], version: 0 };
    ignite(map, 4, 2, { heat: 2, fuel: 6 });
    assert.equal(Object.keys(map.fire).length, 1);
    assert.deepEqual(dampen(map, 1), [], 'damped, not out');
    assert.equal(map.fire['4,2'].heat, 1);
    const r = tickFire(map, { rng: () => 1 });
    assert.equal(r.caught.length, 0, 'in the rain nothing catches');
    assert.deepEqual(dampen(map, 2), ['4,2'], 'a storm puts it out');
    assert.equal(Object.keys(map.fire).length, 0);
});

test('timeline labels follow the clock: a night entry remembered by day is "last night"', () => {
    assert.equal(whenLabel({ day: 2, time: 'night' }, { day: 2, time: 'night' }), 'Earlier tonight');
    assert.equal(whenLabel({ day: 2, time: 'night' }, { day: 2, time: 'morning' }), 'Last night');
    assert.equal(whenLabel({ day: 2, time: 'afternoon' }, { day: 2, time: 'night' }), 'Earlier today');
    assert.equal(whenLabel({ day: 1, time: 'evening' }, { day: 2, time: 'morning' }), 'Last night');
    assert.equal(whenLabel({ day: 1, time: 'noon' }, { day: 4, time: 'morning' }), '3 days ago');
});

test('the room note names who is right there, and the old default template moves to it', () => {
    const text = renderTemplate(DEFAULT_TEMPLATES.room, { char: 'Judy', room: 'Cell block', here: 'Turnkey Wren (a turnkey, 3 squares away, asleep); Amber (1 squares away)', things: 'a bench', exits: 'door to the yard', known: 'Cell block' });
    assert.match(text, /Right here with \{\{char\}\}: Turnkey Wren .*asleep/);
    assert.notEqual(OLD_DEFAULTS.roomV33, DEFAULT_TEMPLATES.room, 'the migration has something to move from');
    assert.ok(DEFAULT_TEMPLATES.room.includes('{{here}}'));
});

test('the books cover the people on the map: the narration knocks a guard out', () => {
    const story = 'Dungeon Master: Amber\'s cudgel cracks across the turnkey\'s skull and Turnkey Wren slumps to the floor, out cold.';
    const changes = parseBookkeeping('{"conditions_add": {"Turnkey Wren": ["unconscious"]}, "conditions_remove": {}, "items_add": {}, "items_remove": {}}', {
        names: ['Amber', 'Turnkey Wren'], itemNames: ['Amber'], story, conditionsOf: () => [], itemsOf: () => [], allItems: [],
    });
    assert.deepEqual(changes, { conditions_add: { 'Turnkey Wren': ['unconscious'] } });
});
