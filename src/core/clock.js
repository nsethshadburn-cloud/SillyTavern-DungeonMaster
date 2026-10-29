// The world's clock and weather: kept by the code, not decided turn by turn by the DM. Time passes
// by itself (a few minutes a player turn, a minute a round in a fight, a trickle while walking, an
// hour or eight for a rest); the DM only skips ahead on purpose ("clock": {"advance": "3 hours"} or
// {"set": "dawn"}). The weather drifts now and then as the hours pass, by the climate of the place,
// and the DM may turn it when the story does. Pure module.

const DAY = 24 * 60;

/** Minutes a player turn takes when the settings don't say. */
export const MINUTES_PER_TURN = 10;

/** The time of day in a word (what the rest of the code reads: night for sleep and dark, etc.). */
export function wordFor(minutes) {
    const m = ((Math.floor(minutes) % DAY) + DAY) % DAY;
    if (m < 5 * 60 || m >= 20 * 60) return 'night';
    if (m < 7 * 60) return 'dawn';
    if (m < 12 * 60) return 'morning';
    if (m < 17 * 60) return 'afternoon';
    return 'evening';
}

const NAMED = {
    midnight: 0, 'small hours': 180, 'late night': 60, 'dead of night': 120, 'first light': 330, daybreak: 360, dawn: 360, sunrise: 360, 'early morning': 420,
    morning: 480, 'mid-morning': 600, midmorning: 600, noon: 720, midday: 720, afternoon: 840, 'late afternoon': 960, 'early evening': 1050,
    dusk: 1140, sunset: 1140, evening: 1140, nightfall: 1200, night: 1320, 'late evening': 1260,
};

/** "06:30", "6pm", "18:00", "dawn", "late afternoon" → minutes since midnight, or null. */
export function parseTime(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return null;
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?$/.exec(s) ?? /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/.exec(s) ?? /\b(\d{1,2})()\s*(am|pm)\b/.exec(s);
    if (m) {
        let h = Number(m[1]);
        const mins = Number(m[2] || 0);
        const ap = m[3];
        if (h > 24 || mins > 59) return null;
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h === 24) h = 0;
        return h * 60 + mins;
    }
    if (NAMED[s] !== undefined) return NAMED[s];
    const key = Object.keys(NAMED).sort((a, b) => b.length - a.length).find(k => new RegExp(`\\b${k}\\b`).test(s));
    return key ? NAMED[key] : null;
}

const SMALL = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5, 'a few': 3, several: 4, couple: 2, 'a couple of': 2 };

/** "3 hours", "an hour", "half an hour", "20 minutes", "a day", "two days", "all night" → minutes, or null. */
export function parseDuration(text) {
    const s = String(text || '').trim().toLowerCase().replace(/^(for|about|some|another)\s+/, '');
    if (!s) return null;
    if (/^(all|the whole|the rest of the) night$/.test(s) || s === 'overnight' || s === 'the night') return 8 * 60;
    if (/^(all|the whole|the rest of the) day$/.test(s)) return 10 * 60;
    const m = /^([\d.]+|[a-z]+(?: [a-z]+)?)\s*(?:of\s+)?(minutes?|mins?|hours?|hrs?|h|days?|weeks?)$/.exec(s) ?? /^(half an?|an?)\s+(hour|day)$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]) || SMALL[m[1]] || (m[1] === 'half an' || m[1] === 'half a' ? 0.5 : null);
    if (n === null || !Number.isFinite(n)) return null;
    const unit = m[2];
    const per = /^min/.test(unit) ? 1 : /^(h|hour|hr)/.test(unit) ? 60 : /^day/.test(unit) ? DAY : 7 * DAY;
    return Math.round(n * per);
}

export function createClock(word = 'morning', day = 1) {
    return { day: Math.max(1, Math.round(Number(day)) || 1), minutes: parseTime(word) ?? 480 };
}

/** The clock, made from the old time word and day if a campaign has none yet. Keeps world.time / world.day in step. */
export function ensureClock(world) {
    if (!world.clock || !Number.isFinite(world.clock.minutes)) world.clock = createClock(world.time, world.day);
    if (!WEATHERS.includes(world.weather)) world.weather = 'clear';
    syncWords(world);
    return world.clock;
}

function syncWords(world) {
    world.time = wordFor(world.clock.minutes);
    world.day = world.clock.day;
}

export function hhmm(minutes) {
    const m = ((Math.floor(minutes) % DAY) + DAY) % DAY;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function clockText(world) {
    const c = ensureClock(world);
    return `Day ${c.day}, ${hhmm(c.minutes)} (${wordFor(c.minutes)})`;
}

export function timeIcon(minutes) {
    const w = wordFor(minutes);
    return w === 'night' ? '🌙' : w === 'dawn' ? '🌅' : w === 'evening' ? '🌇' : '☀️';
}

/** Minutes pass. Returns the hours boundaries crossed (for the weather). */
export function advanceClock(world, minutes) {
    const c = ensureClock(world);
    const add = Math.max(0, Number(minutes) || 0);
    const before = Math.floor(c.minutes / 60);
    c.minutes += add;
    let days = 0;
    while (c.minutes >= DAY) { c.minutes -= DAY; c.day++; days++; }
    syncWords(world);
    return days * 24 + Math.floor(c.minutes / 60) - before;
}

/**
 * Skip to a time: "dawn", "06:30", "tomorrow morning", "day 3 noon", "until dusk". Forward only
 * (a time already past today is tomorrow's), unless "day N" says which day. Returns the minutes
 * skipped, or null when the words name no time.
 */
export function setClock(world, text) {
    const c = ensureClock(world);
    const s = String(text || '').toLowerCase().trim().replace(/^(until|till|to|at)\s+/, '');
    const dayM = /\bday\s+(\d+)\b/.exec(s);
    const tomorrow = /\b(tomorrow|next (day|morning)|the next (day|morning))\b/.test(s);
    const t = parseTime(s.replace(/\bday\s+\d+\b/, '').replace(/\b(tomorrow|next day|next morning|the next day|the next morning)\b/, '').trim());
    if (t === null && !dayM) return null;
    let day = dayM ? Math.max(1, Number(dayM[1])) : c.day;
    const minutes = t ?? c.minutes;
    if (!dayM && (tomorrow || minutes <= c.minutes)) day = c.day + 1;
    const skipped = (day - c.day) * DAY + (minutes - c.minutes);
    c.day = day;
    c.minutes = minutes;
    syncWords(world);
    return skipped;
}

// ---------- weather ----------

export const WEATHERS = ['clear', 'overcast', 'rain', 'storm', 'fog', 'snow', 'wind'];
export const WEATHER_ICON = Object.freeze({ clear: '☀️', overcast: '☁️', rain: '🌧️', storm: '⛈️', fog: '🌫️', snow: '🌨️', wind: '🌬️' });
export const WEATHER_WORDS = Object.freeze({ clear: 'clear skies', overcast: 'overcast, grey', rain: 'steady rain', storm: 'a storm: thunder, driving rain, hard wind', fog: 'thick fog', snow: 'falling snow', wind: 'a hard, cold wind' });

/** "raining", "thunderstorm", "misty", "snowing", "sunny", "cloudy", "gale" → a weather kind, or null. */
export function parseWeather(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return null;
    if (/thunder|storm|gale|tempest|downpour|torrent/.test(s)) return 'storm';
    if (/snow|blizzard|sleet|hail/.test(s)) return 'snow';
    if (/fog|mist|haze|murk/.test(s)) return 'fog';
    if (/rain|drizzle|shower|wet/.test(s)) return 'rain';
    if (/wind|gust|breez|blustery/.test(s)) return 'wind';
    if (/overcast|cloud|grey|gray|dull/.test(s)) return 'overcast';
    if (/clear|sunny|sun\b|fair|fine|bright|starry|still/.test(s)) return 'clear';
    return null;
}

/** The climate, from the world's setting and the map's theme: 'cold' | 'dry' | 'wet' | 'temperate'. */
export function climateOf(setting = '', theme = '') {
    const s = `${setting} ${theme}`.toLowerCase();
    if (/snow|ice|frozen|tundra|winter|arctic|glacier/.test(s)) return 'cold';
    if (/desert|dune|sand|waste|badland/.test(s)) return 'dry';
    if (/swamp|jungle|marsh|bog|rainforest|sea|coast|island|ship/.test(s)) return 'wet';
    return 'temperate';
}

const DRIFT = {
    temperate: {
        clear: [['clear', 0.55], ['overcast', 0.3], ['wind', 0.15]], overcast: [['clear', 0.3], ['overcast', 0.25], ['rain', 0.3], ['fog', 0.15]],
        rain: [['overcast', 0.4], ['rain', 0.3], ['storm', 0.2], ['clear', 0.1]], storm: [['rain', 0.5], ['overcast', 0.3], ['storm', 0.2]],
        fog: [['overcast', 0.4], ['clear', 0.4], ['fog', 0.2]], snow: [['overcast', 0.5], ['snow', 0.3], ['clear', 0.2]], wind: [['clear', 0.4], ['overcast', 0.4], ['storm', 0.2]],
    },
    cold: {
        clear: [['clear', 0.4], ['overcast', 0.35], ['wind', 0.25]], overcast: [['snow', 0.45], ['overcast', 0.3], ['clear', 0.25]],
        rain: [['snow', 0.6], ['overcast', 0.4]], storm: [['snow', 0.6], ['wind', 0.4]], fog: [['overcast', 0.5], ['clear', 0.5]],
        snow: [['snow', 0.45], ['overcast', 0.35], ['clear', 0.2]], wind: [['snow', 0.4], ['clear', 0.4], ['overcast', 0.2]],
    },
    dry: {
        clear: [['clear', 0.8], ['wind', 0.2]], overcast: [['clear', 0.7], ['storm', 0.3]], rain: [['clear', 0.7], ['storm', 0.3]], storm: [['wind', 0.5], ['clear', 0.5]],
        fog: [['clear', 1]], snow: [['clear', 1]], wind: [['clear', 0.6], ['wind', 0.3], ['storm', 0.1]],
    },
    wet: {
        clear: [['overcast', 0.5], ['clear', 0.35], ['fog', 0.15]], overcast: [['rain', 0.5], ['overcast', 0.25], ['fog', 0.25]],
        rain: [['rain', 0.45], ['storm', 0.25], ['overcast', 0.3]], storm: [['rain', 0.6], ['storm', 0.4]], fog: [['fog', 0.4], ['overcast', 0.4], ['rain', 0.2]],
        snow: [['rain', 1]], wind: [['rain', 0.5], ['storm', 0.5]],
    },
};

/** The next weather after a drift, by climate (rng in [0, 1)). */
export function driftWeather(kind, climate = 'temperate', rng = Math.random) {
    const table = (DRIFT[climate] ?? DRIFT.temperate)[WEATHERS.includes(kind) ? kind : 'clear'];
    let roll = rng();
    for (const [next, p] of table) { roll -= p; if (roll < 0) return next; }
    return table[table.length - 1][0];
}

/** How likely the weather is to drift in any given hour. */
export const DRIFT_CHANCE = 0.15;

/**
 * Minutes pass and the weather may drift (once per hour crossed, DRIFT_CHANCE each).
 * Returns {weather: the new kind, or null if unchanged}.
 */
export function passTime(world, minutes, { climate = 'temperate', rng = Math.random, chance = DRIFT_CHANCE } = {}) {
    const hours = advanceClock(world, minutes);
    return { weather: drift(world, hours, climate, rng, chance) };
}

/** Skip to a named time (see setClock); the weather drifts over the hours skipped. Returns {skipped, weather} or null. */
export function skipTo(world, text, { climate = 'temperate', rng = Math.random, chance = DRIFT_CHANCE } = {}) {
    const skipped = setClock(world, text);
    if (skipped === null) return null;
    return { skipped, weather: drift(world, Math.floor(skipped / 60), climate, rng, chance) };
}

function drift(world, hours, climate, rng, chance) {
    const was = world.weather;
    for (let i = 0; i < Math.min(hours, 48); i++) if (rng() < chance) world.weather = driftWeather(world.weather, climate, rng);
    return world.weather !== was ? world.weather : null;
}

/** The look of the air outdoors for this weather (the map's ambience particles), or null for the theme's own. */
export function weatherAmbience(kind, theme = '') {
    if (kind === 'rain' || kind === 'storm') return 'rain';
    if (kind === 'snow') return 'snow';
    if (kind === 'fog') return 'mist';
    if (kind === 'wind') return /desert/.test(theme) ? 'sand' : 'leaves';
    return null;
}

/** Flags for the event deck and the DM: the weather kind, plus wet / bad_weather. */
export function weatherFlags(kind) {
    const out = new Set();
    if (!WEATHERS.includes(kind)) return out;
    out.add(kind);
    if (kind === 'rain' || kind === 'storm') out.add('wet');
    if (kind === 'storm' || kind === 'snow' || kind === 'fog') out.add('bad_weather');
    return out;
}
