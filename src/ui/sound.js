// Experimental sound. Everything here is synthesized in the browser with the Web Audio API: no
// files, no licences, nothing downloaded. Short effects for what happens on the map (a lock pick,
// a footstep, a door, a swing, a hit, a trap, cuffs, dice, a guard's shout) and slow ambient beds
// for where the party is (a dripping dungeon, a quiet room, wind, rain, a storm, crickets, a fire).
// Every effect is jittered a little so it never plays the same way twice, and nothing here is loud.
// Off by default (settings.sounds); ambient ducks while a voice line plays. Display only: nothing
// here is saved or sent to any model.

import { settings } from '../st/settings.js';
import { ambientFor, footingFor } from '../core/ambience.js';

let ctx = null, master = null, sfxBus = null, ambBus = null, noise = null;
let bed = null;              // {kind, gain, stop: () => void}
let duck = 1;                // ambient volume factor while someone speaks
let lastSfx = new Map();     // name -> time, to keep rapid repeats from stacking

const clamp = v => Math.max(0, Math.min(1, Number(v) || 0));
const jit = (v, pct = 0.15) => v * (1 + (Math.random() * 2 - 1) * pct);
const rnd = (a, b) => a + Math.random() * (b - a);

function on() { return settings().sounds === true; }

/** The audio context, made on first use (browsers only allow sound after a tap or a key). */
function ensure() {
    if (!on()) return null;
    if (!ctx) {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
        } catch { return null; }
        master = ctx.createGain(); master.connect(ctx.destination);
        sfxBus = ctx.createGain(); sfxBus.connect(master);
        ambBus = ctx.createGain(); ambBus.connect(master);
        noise = makeNoise(ctx);
        // The voice events come from st/voices.js, loaded lazily: messages → sound → voices → messages would be a cycle.
        import('../st/voices.js').then(m => m.onSpeech(speechDuck)).catch(() => { });
    }
    applyVolumes();
    if (ctx.state === 'suspended') ctx.resume().catch(() => { });
    return ctx;
}

function applyVolumes(ramp = 0.3) {
    if (!ctx) return;
    const s = settings();
    const t = ctx.currentTime;
    sfxBus.gain.cancelScheduledValues(t);
    sfxBus.gain.setTargetAtTime(clamp(s.sfxVolume ?? 0.6), t, 0.05);
    ambBus.gain.cancelScheduledValues(t);
    ambBus.gain.setTargetAtTime(clamp(s.ambientVolume ?? 0.3) * duck, t, ramp);
}

/** The settings changed: volumes, or sound switched off (everything stops). */
export function refreshSoundSettings() {
    if (!on()) { stopBed(0.2); return; }
    ensure();
}

function makeNoise(c) {
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
}

// ---------- building blocks ----------

/** A filtered noise burst with a fast attack and an exponential fade. */
function burst({ t, dur, type = 'bandpass', freq = 800, to = null, q = 1, gain = 0.3, dest = sfxBus }) {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    src.playbackRate.value = jit(1, 0.05);
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
}

/** A tone with a pitch slide and an exponential fade. */
function tone({ t, dur, type = 'sine', freq = 440, to = null, gain = 0.2, dest = sfxBus, attack = 0.004 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
}

function click(t, gain = 0.2, freq = 3000) {
    burst({ t, dur: 0.018, type: 'highpass', freq, gain });
    tone({ t, dur: 0.012, freq: jit(freq * 0.8, 0.2), gain: gain * 0.4 });
}

// ---------- the effects ----------

const SFX = {
    /** Picking a lock: a few pick clicks, then the bolt gives (ok) or the pick scrapes and maybe snaps. */
    lockpick(t, { ok = true, snap = false } = {}) {
        const n = 2 + Math.floor(Math.random() * 3);
        let at = t;
        for (let i = 0; i < n; i++) { click(at, 0.18, jit(2600, 0.2)); at += rnd(0.06, 0.15); }
        if (ok) {
            burst({ t: at, dur: 0.07, type: 'lowpass', freq: 420, gain: 0.3 });
            tone({ t: at, dur: 0.1, freq: 120, to: 70, gain: 0.25 });
        } else {
            burst({ t: at, dur: 0.26, type: 'bandpass', freq: 1000, to: 450, q: 4, gain: 0.18 });
            if (snap) { tone({ t: at + 0.22, dur: 0.03, freq: 3200, gain: 0.2 }); click(at + 0.23, 0.25, 4000); }
        }
    },
    /** A swing through the air. */
    whoosh(t) {
        burst({ t, dur: jit(0.19), type: 'bandpass', freq: jit(450), to: jit(1700), q: 0.8, gain: 0.32 });
    },
    /** A blow landing: a thud with a snap on top. */
    hit(t) {
        burst({ t, dur: 0.09, type: 'lowpass', freq: jit(380), gain: 0.5 });
        tone({ t, dur: 0.13, freq: jit(100), to: 45, gain: 0.35 });
        burst({ t: t + 0.004, dur: 0.03, type: 'bandpass', freq: jit(2600), q: 2, gain: 0.14 });
    },
    /** One footstep, by the ground underfoot. */
    step(t, { theme = '' } = {}) {
        const f = footingFor(theme);
        if (f === 'soft') burst({ t, dur: 0.06, type: 'bandpass', freq: jit(650), q: 0.9, gain: 0.07 });
        else if (f === 'snow') burst({ t, dur: 0.09, type: 'bandpass', freq: jit(1800), q: 0.7, gain: 0.06 });
        else if (f === 'wood') { burst({ t, dur: 0.05, type: 'lowpass', freq: jit(320), gain: 0.1 }); tone({ t, dur: 0.05, freq: jit(140), to: 90, gain: 0.05 }); }
        else { burst({ t, dur: 0.045, type: 'lowpass', freq: jit(260), gain: 0.11 }); click(t + 0.003, 0.05, jit(2200, 0.3)); }
    },
    /** A door swinging on old hinges, then meeting the frame. */
    door(t) {
        const dur = jit(0.34);
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(jit(200), t); o.frequency.exponentialRampToValueAtTime(jit(130), t + dur);
        const lfo = ctx.createOscillator(); lfo.frequency.value = jit(9); const lg = ctx.createGain(); lg.gain.value = 18; lfo.connect(lg); lg.connect(o.frequency);
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f); f.connect(g); g.connect(sfxBus); lfo.start(t); o.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
        tone({ t: t + dur, dur: 0.07, freq: 95, to: 60, gain: 0.18 });
    },
    /** A lock turning, a bolt home: iron on iron. */
    lock(t) {
        tone({ t, dur: 0.05, type: 'square', freq: jit(240), gain: 0.12 });
        burst({ t, dur: 0.04, type: 'highpass', freq: 1800, gain: 0.18 });
        tone({ t: t + 0.05, dur: 0.11, freq: 140, to: 80, gain: 0.2 });
    },
    /** A trap going off: a sharp metallic snap and a blow. */
    trap(t) {
        tone({ t, dur: 0.28, type: 'triangle', freq: jit(1100), to: 650, gain: 0.22 });
        burst({ t, dur: 0.05, type: 'highpass', freq: 2500, gain: 0.3 });
        SFX.hit(t + 0.05);
    },
    /** Cuffs or chains: a handful of metallic ticks. */
    chains(t) {
        let at = t;
        for (let i = 0, n = 5 + Math.floor(Math.random() * 4); i < n; i++) {
            tone({ t: at, dur: 0.022, type: 'square', freq: jit(2600, 0.25), gain: 0.07 });
            burst({ t: at, dur: 0.015, type: 'highpass', freq: 4000, gain: 0.1 });
            at += rnd(0.04, 0.12);
        }
    },
    /** A guard's shout, as a short two-note sting (not a siren). */
    alert(t) {
        tone({ t, dur: 0.07, freq: 880, gain: 0.14 });
        tone({ t: t + 0.08, dur: 0.1, freq: 1320, gain: 0.12 });
    },
    /** A fight breaks out: one low drum. */
    drum(t) {
        tone({ t, dur: 0.36, freq: 150, to: 42, gain: 0.5 });
        burst({ t, dur: 0.12, type: 'lowpass', freq: 220, gain: 0.4 });
    },
    /** Dice tumbling and settling. */
    dice(t) {
        let at = t, gap = 0.09;
        for (let i = 0, n = 4 + Math.floor(Math.random() * 4); i < n; i++) {
            burst({ t: at, dur: 0.012, type: 'bandpass', freq: jit(1400, 0.3), q: 3, gain: 0.12 });
            at += gap; gap = Math.max(0.03, gap * 0.78);
        }
        burst({ t: at, dur: 0.03, type: 'lowpass', freq: 600, gain: 0.08 });
    },
};

/**
 * Play an effect by name. Quiet no-op when sound is off or the browser hasn't allowed audio yet.
 * @param {keyof typeof SFX} name
 */
export function sfx(name, opts = {}) {
    try {
        const fn = SFX[name];
        if (!fn || !ensure()) return;
        // The same effect twice within 40 ms (a double redraw) plays once.
        const now = performance.now();
        if (now - (lastSfx.get(name) ?? -1000) < 40) return;
        lastSfx.set(name, now);
        fn(ctx.currentTime + 0.01, opts);
    } catch (error) {
        console.warn('[Dungeon Master] sound failed', error);
    }
}

// ---------- ambient beds ----------

/** A looping noise through a filter, as a bed layer. Returns {gain, stop}. */
function layer({ type = 'lowpass', freq = 200, q = 0.7, gain = 0.3, lfo = null }) {
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g);
    let l = null, lg = null;
    if (lfo) { l = ctx.createOscillator(); l.frequency.value = lfo.rate; lg = ctx.createGain(); lg.gain.value = lfo.depth; l.connect(lg); lg.connect(f.frequency); l.start(); }
    src.start();
    return { out: g, stop: () => { try { src.stop(); l?.stop(); } catch { } } };
}

/** Something that happens now and then in a bed (a drip, a cricket, thunder). Returns a stopper. */
function sometimes(min, max, fn) {
    let timer = null, live = true;
    const next = () => { timer = setTimeout(() => { if (!live) return; try { fn(ctx.currentTime + 0.01); } catch { } next(); }, rnd(min, max) * 1000); };
    next();
    return () => { live = false; clearTimeout(timer); };
}

const BEDS = {
    dungeon(out) {
        const a = layer({ type: 'lowpass', freq: 95, gain: 0.5 }); a.out.connect(out);
        const b = layer({ type: 'bandpass', freq: 240, q: 2, gain: 0.05, lfo: { rate: 0.05, depth: 60 } }); b.out.connect(out);
        const drips = sometimes(2.5, 8, t => { const f = jit(1900, 0.2); tone({ t, dur: 0.05, freq: f, to: f * 0.75, gain: 0.06, dest: out }); tone({ t: t + 0.11, dur: 0.05, freq: f * 0.9, to: f * 0.65, gain: 0.025, dest: out }); });
        return () => { a.stop(); b.stop(); drips(); };
    },
    indoor(out) {
        const a = layer({ type: 'lowpass', freq: 110, gain: 0.22 }); a.out.connect(out);
        const creaks = sometimes(9, 25, t => { tone({ t, dur: 0.25, type: 'sawtooth', freq: jit(170), to: 120, gain: 0.015, dest: out }); });
        return () => { a.stop(); creaks(); };
    },
    outdoors(out) {
        const a = layer({ type: 'bandpass', freq: 420, q: 0.5, gain: 0.16, lfo: { rate: 0.09, depth: 180 } }); a.out.connect(out);
        const birds = sometimes(3, 9, t => { for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) { const f = jit(2800, 0.25); tone({ t: t + i * 0.13, dur: 0.09, freq: f, to: f * 1.25, gain: 0.035, dest: out }); } });
        return () => { a.stop(); birds(); };
    },
    night(out) {
        const a = layer({ type: 'bandpass', freq: 360, q: 0.5, gain: 0.1, lfo: { rate: 0.07, depth: 120 } }); a.out.connect(out);
        const crickets = sometimes(0.6, 2.2, t => { const f = jit(4300, 0.08); for (let i = 0; i < 6; i++) tone({ t: t + i * 0.045, dur: 0.028, freq: f, gain: 0.03, dest: out }); });
        return () => { a.stop(); crickets(); };
    },
    wind(out) {
        const a = layer({ type: 'bandpass', freq: 500, q: 0.6, gain: 0.3, lfo: { rate: 0.11, depth: 320 } }); a.out.connect(out);
        const b = layer({ type: 'bandpass', freq: 180, q: 1, gain: 0.12, lfo: { rate: 0.05, depth: 70 } }); b.out.connect(out);
        return () => { a.stop(); b.stop(); };
    },
    rain(out) {
        const a = layer({ type: 'highpass', freq: 1300, gain: 0.22 }); a.out.connect(out);
        const b = layer({ type: 'bandpass', freq: 3600, q: 0.8, gain: 0.08, lfo: { rate: 0.3, depth: 600 } }); b.out.connect(out);
        const c = layer({ type: 'lowpass', freq: 200, gain: 0.1 }); c.out.connect(out);
        return () => { a.stop(); b.stop(); c.stop(); };
    },
    storm(out) {
        const stopRain = BEDS.rain(out);
        const w = layer({ type: 'bandpass', freq: 520, q: 0.6, gain: 0.3, lfo: { rate: 0.13, depth: 380 } }); w.out.connect(out);
        const thunder = sometimes(14, 40, t => { burst({ t, dur: jit(1.8), type: 'lowpass', freq: 140, to: 60, gain: 0.7, dest: out }); burst({ t: t + 0.35, dur: 2.6, type: 'lowpass', freq: 90, gain: 0.3, dest: out }); });
        return () => { stopRain(); w.stop(); thunder(); };
    },
    fire(out) {
        const a = layer({ type: 'lowpass', freq: 150, gain: 0.18, lfo: { rate: 0.4, depth: 40 } }); a.out.connect(out);
        const crackle = sometimes(0.05, 0.25, t => { burst({ t, dur: jit(0.02), type: 'bandpass', freq: jit(3200, 0.4), q: 2, gain: jit(0.09, 0.4), dest: out }); });
        return () => { a.stop(); crackle(); };
    },
};

function stopBed(fade = 1.5) {
    if (!bed || !ctx) { bed = null; return; }
    const old = bed; bed = null;
    const t = ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setTargetAtTime(0.0001, t, fade / 3);
    setTimeout(() => { try { old.stop(); old.gain.disconnect(); } catch { } }, fade * 1000 + 100);
}

/**
 * Put on the bed for where the party is (null = silence), crossfading from the current one.
 * @param {string|null} kind one of core/ambience AMBIENTS
 */
export function setAmbient(kind) {
    try {
        if (!kind || !on()) { stopBed(); return; }
        if (bed?.kind === kind) return;
        if (!ensure() || !BEDS[kind]) return;
        stopBed();
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.6);
        g.connect(ambBus);
        const stop = BEDS[kind](g);
        bed = { kind, gain: g, stop };
    } catch (error) {
        console.warn('[Dungeon Master] ambient failed', error);
    }
}

/** The map says where the party is: pick and play the bed that fits. */
export function syncAmbient(c, b) {
    if (!on()) { if (bed) stopBed(); return; }
    if (!b?.map) { setAmbient(null); return; }
    const theme = b.map.theme || '';
    const st = b.place?.state || {};
    // A fire the party can see on this floor crackles over everything else.
    const fire = Boolean(b.map.fire) && Object.keys(b.map.fire).some(k => { const [x, y] = k.split(',').map(Number); return b.visible ? Boolean(b.visible[y * b.map.w + x]) : true; });
    setAmbient(ambientFor({ theme, weather: st.weather || c.docs.world.weather || 'clear', night: Boolean(st.night), fire }));
}

/** Ambient steps back while someone speaks, and comes back after. */
function speechDuck(ev) {
    if (ev.type === 'start') duck = 0.35;
    else if (ev.type === 'end' || ev.type === 'stop' || ev.type === 'skip') duck = 1;
    else return;
    if (ctx) applyVolumes(0.4);
}

// Browsers allow sound only after the person has touched the page: wake the context on the first tap.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, () => { if (on()) ensure(); }, { passive: true });
}
