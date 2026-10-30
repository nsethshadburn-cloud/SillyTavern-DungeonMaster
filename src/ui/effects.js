// Moving things on the map, drawn every frame over the painted map:
// - fire (always): a glow that lights up what's around it, flickering flames, embers and smoke;
// - one-off bursts (a fireball going off, a lightning bolt, a thunderclap, steam from a doused fire);
// - spell effects (fog, darkness, ice, web, poison, acid, holy light, water);
// - the ambience, if the player keeps it on: rain, snow, dust motes, ash, mist, leaves, fireflies,
//   blowing sand, glints on water, flicker around torches and fires, bubbles on lava.
// Kept light: a capped number of faint particles, only on squares that are on screen and seen.

import { terrainAt, PROPS } from '../core/grid.js';

const MAX = 150;
/** Most particles of one kind at once (weather stays a sprinkle, not a storm). */
const CAP = { z: 6, drop: 8, rain: 55, snow: 40, dust: 14, ash: 24, mist: 6, leaves: 6, fireflies: 10, sand: 18, ember: 50, smoke: 26, glint: 16, spark: 18, bubble: 16, embers: 36 };
/** What the air is like by default, by kind of map. Rain only when the DM says it's raining. */
const DEFAULT_AMBIENCE = {
    snow: 'snow', desert: 'sand', swamp: 'mist', jungle: 'fireflies', forest: 'leaves', camp: 'embers',
    dungeon: 'dust', crypt: 'dust', cave: 'dust', mine: 'dust', sewer: 'dust', prison: 'dust', castle: 'dust', library: 'dust', temple: 'dust', mansion: 'dust',
};
const FLICKER = new Set(['torch', 'brazier', 'campfire', 'bonfire', 'fireplace', 'candles', 'forge', 'lamppost', 'chandelier', 'watchtower']);
const SPITS = new Set(['brazier', 'campfire', 'bonfire', 'fireplace', 'forge']);

let parts = [];
let lastT = 0;
let forMap = null;
const sprites = new Map();
const sources = new WeakMap();

const hash2 = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ---------- pre-drawn sprites (made once per size) ----------

function sprite(name, size, draw) {
    const k = `${name}:${size}`;
    if (!sprites.has(k)) {
        const c = document.createElement('canvas');
        draw(c, size);
        sprites.set(k, c);
    }
    return sprites.get(k);
}

/** A soft round glow or puff of a color. */
function softDot(color, size) {
    return sprite(`dot${color}`, size, (c, s) => {
        c.width = c.height = s;
        const g = c.getContext('2d'), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        gr.addColorStop(0, `rgba(${color},1)`); gr.addColorStop(0.45, `rgba(${color},0.45)`); gr.addColorStop(1, `rgba(${color},0)`);
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
    });
}

/** Flames: 8 frames for each heat (1-3), each cell one square wide and 1.6 squares tall. */
function flameSheet(tile) {
    return sprite('flames', tile, (c, s) => {
        const cw = s, ch = Math.round(s * 1.6);
        c.width = cw * 8; c.height = ch * 3;
        const g = c.getContext('2d');
        for (let heat = 1; heat <= 3; heat++) for (let f = 0; f < 8; f++) {
            const ox = f * cw, by = heat * ch - s * 0.12;
            const n = 2 + heat, baseW = s * (0.42 + 0.14 * heat), H = s * (0.4 + 0.3 * heat);
            for (const core of [false, true]) {
                for (let i = 0; i < n; i++) {
                    const ph = f / 8 * Math.PI * 2;
                    const cx = ox + cw / 2 + (n > 1 ? (i / (n - 1) - 0.5) : 0) * baseW * 0.75 + Math.sin(ph + i * 2.1) * s * 0.035;
                    const h = H * (0.55 + 0.45 * Math.abs(Math.sin(ph * (i % 2 ? 1 : 2) / 2 + i * 1.3))) * (core ? 0.55 : 1);
                    const w = (baseW / n) * (core ? 1 : 1.75);
                    const sway = Math.sin(ph + i) * s * 0.06;
                    const gr = g.createLinearGradient(0, by, 0, by - h);
                    if (core) { gr.addColorStop(0, 'rgba(255,250,210,0.95)'); gr.addColorStop(1, 'rgba(255,220,120,0)'); }
                    else { gr.addColorStop(0, 'rgba(230,70,20,0.9)'); gr.addColorStop(0.45, 'rgba(255,150,40,0.85)'); gr.addColorStop(1, 'rgba(255,210,90,0)'); }
                    g.fillStyle = gr;
                    g.beginPath();
                    g.moveTo(cx - w / 2, by);
                    g.quadraticCurveTo(cx - w * 0.55, by - h * 0.55, cx + sway, by - h);
                    g.quadraticCurveTo(cx + w * 0.55, by - h * 0.55, cx + w / 2, by);
                    g.closePath(); g.fill();
                }
            }
        }
    });
}

// ---------- what's on the map ----------

/** Water, lava and lights on the map (worked out once per map change). */
function sourcesOf(map) {
    const had = sources.get(map);
    if (had && had.version === (map.version || 0)) return had;
    const water = [], lava = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        const ch = terrainAt(map, x, y);
        if (ch === '~' || ch === 'w') water.push([x, y]);
        else if (ch === 'L') lava.push([x, y]);
    }
    const lights = (map.props || []).filter(p => !p.hidden && FLICKER.has(p.type)).map(p => ({ x: p.x + ((p.w || 1) - 1) / 2, y: p.y + ((p.h || 1) - 1) / 2, type: p.type, rad: PROPS[p.type]?.light || 2 }));
    const out = { version: map.version || 0, water, lava, lights };
    sources.set(map, out);
    return out;
}

export function ambienceOf(map) {
    const a = map.ambience || DEFAULT_AMBIENCE[map.theme] || 'none';
    return a === 'none' ? '' : a;
}

/** Is there anything to animate on this map? (ambient = the player keeps the ambience on) */
export function effectsActive(map, ambient) {
    if (!map) return false;
    if (Object.keys(map.fire || {}).length || map.effects?.length) return true;
    if ((map.flashes || []).some(f => Date.now() - f.at < 1500)) return true;
    if (!ambient) return false;
    const s = sourcesOf(map);
    return Boolean(ambienceOf(map) || s.water.length || s.lava.length || s.lights.length);
}

// ---------- particles ----------

function count(kind) { let n = 0; for (const p of parts) if (p.kind === kind) n++; return n; }
function spawn(p) { if (parts.length < MAX && count(p.kind) < (CAP[p.kind] ?? 20)) parts.push(p); }
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * Draw one layer of effects. "under" goes below the figures (glows, tints, glints), "over" above
 * them (flames, smoke, clouds, bursts, weather). Call "under" first each frame: it moves things on.
 * o = {map, tile, margin, now, seen(x, y), view: {x, y, w, h} in canvas pixels, ambient}
 */
export function drawEffects(ctx, o, layer) {
    const { map, tile, margin, now } = o;
    if (forMap !== map) { parts = []; forMap = map; lastT = 0; }
    const at = (x, y) => [margin + x * tile + tile / 2, (map.h - 1 - y) * tile + tile / 2];
    const sx0 = Math.floor((o.view.x - margin) / tile) - 1, sx1 = Math.ceil((o.view.x + o.view.w - margin) / tile) + 1;
    const sy1 = map.h - 1 - Math.floor(o.view.y / tile) + 1, sy0 = map.h - 1 - Math.ceil((o.view.y + o.view.h) / tile) - 1;
    const onScreen = (x, y) => x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1;
    const shown = (x, y) => onScreen(x, y) && o.seen(x, y);
    const fire = Object.entries(map.fire || {}).map(([k, f]) => { const [x, y] = k.split(',').map(Number); return { x, y, heat: f.heat }; }).filter(f => shown(f.x, f.y));
    const effects = (map.effects || []).filter(e => e.x + e.radius >= sx0 && e.x - e.radius <= sx1 && e.y + e.radius >= sy0 && e.y - e.radius <= sy1);
    const src = o.ambient ? sourcesOf(map) : null;
    const air = o.ambient ? ambienceOf(map) : '';
    if (layer === 'under') {
        const dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0.1;
        lastT = now;
        step(dt, o, { fire, effects, src, air, at, shown });
        // Fire light: a warm glow that breathes. Built up in its own small layer first, so a big fire
        // lights the room without washing everything out to white.
        if (fire.length) drawFireLight(ctx, fire, o, at, now);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = softDot('255,140,50', 64);
        // Torches and fires breathe a little (ambience).
        if (src) {
            for (const l of src.lights) {
                if (!shown(Math.round(l.x), Math.round(l.y))) continue;
                const [cx, cy] = at(l.x, l.y), rad = tile * l.rad * 0.7;
                ctx.globalAlpha = 0.07 + 0.05 * Math.sin(now / 130 + l.x * 7 + l.y * 3) + 0.03 * Math.sin(now / 47 + l.x);
                ctx.drawImage(glow, cx - rad, cy - rad, rad * 2, rad * 2);
            }
            const lavaGlow = softDot('255,90,30', 48);
            for (const [x, y] of src.lava) {
                if (!shown(x, y)) continue;
                const [cx, cy] = at(x, y), rad = tile * 0.9;
                ctx.globalAlpha = 0.1 + 0.06 * Math.sin(now / 400 + x * 2 + y);
                ctx.drawImage(lavaGlow, cx - rad, cy - rad, rad * 2, rad * 2);
            }
        }
        ctx.restore();
        // Spell areas that tint the ground.
        for (const e of effects) {
            const tint = { ice: 'rgba(170,215,255,0.22)', acid: 'rgba(150,200,40,0.2)', water: 'rgba(60,120,200,0.22)', holy: 'rgba(255,220,120,0.14)', web: 'rgba(230,230,230,0.12)' }[e.type];
            if (!tint) continue;
            const [cx, cy] = at(e.x, e.y), rad = (e.radius + 0.5) * tile;
            const g = ctx.createRadialGradient(cx, cy, rad * 0.6, cx, cy, rad);
            g.addColorStop(0, tint); g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
            if (e.type === 'web') drawWeb(ctx, cx, cy, rad);
        }
        for (const p of parts) if (p.under) drawPart(ctx, p, tile, now);
        return;
    }
    // ---- over the figures ----
    const sheet = flameSheet(tile), ch = Math.round(tile * 1.6);
    // Each square's flames sit a little off-center, at their own size and facing, so a burning room
    // is a ragged blaze, not rows of the same flame.
    for (const f of fire) {
        const h1 = hash2(f.x, f.y), h2 = hash2(f.y + 17, f.x + 5), h3 = hash2(f.x + 31, f.y + 11);
        const frame = Math.floor(now / 110 + h1 * 8) % 8;
        const [cx, cy] = at(f.x, f.y);
        const k = 0.75 + h2 * 0.5, w = tile * k, hgt = ch * k;
        const x = cx + (h1 - 0.5) * tile * 0.35, y = cy + tile / 2 + (h3 - 0.5) * tile * 0.3;
        if (h3 > 0.5) { ctx.save(); ctx.translate(x, 0); ctx.scale(-1, 1); ctx.drawImage(sheet, frame * tile, (f.heat - 1) * ch, tile, ch, -w / 2, y - hgt, w, hgt); ctx.restore(); }
        else ctx.drawImage(sheet, frame * tile, (f.heat - 1) * ch, tile, ch, x - w / 2, y - hgt, w, hgt);
    }
    for (const e of effects) drawCloud(ctx, e, at, tile, now);
    for (const p of parts) if (!p.under) drawPart(ctx, p, tile, now);
    for (const fl of map.flashes || []) drawFlash(ctx, fl, at, tile);
}

let lightBuf = null;
/** The light from the fire: added up at low resolution (where it saturates), then laid over the map. */
function drawFireLight(ctx, fire, o, at, now) {
    const { tile, view } = o, scale = 1 / 8;
    const w = Math.max(1, Math.ceil(view.w * scale)), h = Math.max(1, Math.ceil(view.h * scale));
    lightBuf ??= document.createElement('canvas');
    if (lightBuf.width !== w || lightBuf.height !== h) { lightBuf.width = w; lightBuf.height = h; }
    const g = lightBuf.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    const dot = softDot('255,100,30', 32);
    for (const f of fire) {
        const [cx, cy] = at(f.x, f.y), flick = 0.85 + 0.15 * Math.sin(now / 95 + f.x * 3.1 + f.y * 1.7);
        const rad = tile * (1.2 + f.heat * 0.8) * scale;
        g.globalAlpha = 0.28 * f.heat / 3 * flick;
        g.drawImage(dot, (cx - view.x) * scale - rad, (cy - view.y) * scale - rad, rad * 2, rad * 2);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lightBuf, 0, 0, w, h, view.x, view.y, w / scale, h / scale);
    ctx.restore();
}

/** Move particles on and make new ones. */
function step(dt, o, { fire, effects, src, air, at, shown }) {
    const { tile, view } = o;
    for (const p of parts) {
        p.life -= dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 'snow' || p.kind === 'leaves') p.x += Math.sin((p.life + p.seed) * 2) * tile * 0.25 * dt;
        if (p.kind === 'embers') { p.x += Math.sin((p.life + p.seed) * 1.7) * tile * 0.35 * dt; p.y += Math.cos((p.life * 0.8 + p.seed) * 1.3) * tile * 0.2 * dt; }
        if (p.kind === 'fireflies' || p.kind === 'dust') { p.vx += rnd(-1, 1) * tile * 0.3 * dt; p.vy += rnd(-1, 1) * tile * 0.3 * dt; }
        if (p.grow) p.size += p.grow * dt;
    }
    parts = parts.filter(p => p.life > 0 && p.y < view.y + view.h + tile && p.y > view.y - tile * 3 && p.x > view.x - tile * 2 && p.x < view.x + view.w + tile * 2);
    const chance = rate => Math.random() < rate * dt;
    // From figures: Z's float up from sleepers, a drop of blood falls from the badly hurt.
    for (const f of o.figures || []) {
        if (!shown(f.x, f.y)) continue;
        const [cx, cy] = at(f.x, f.y);
        if (f.kind === 'z' && chance(0.7)) spawn({ kind: 'z', x: cx + tile * 0.12, y: cy - tile * 0.3, vx: tile * 0.18, vy: -tile * 0.32, life: 2, max: 2, size: Math.max(9, tile * 0.28) });
        if (f.kind === 'alert' && chance(2.5)) spawn({ kind: 'alert', x: cx + tile * 0.3, y: cy - tile * 0.62, vx: 0, vy: 0, life: 0.5, max: 0.5, size: Math.max(11, tile * 0.42) });
        if (f.kind === 'drop' && chance(0.3)) spawn({ kind: 'drop', x: cx + rnd(-0.15, 0.15) * tile, y: cy - tile * 0.05, vx: 0, vy: tile * 0.7, life: 0.5, max: 0.5, size: Math.max(1.5, tile / 22) });
    }
    // How many to make this frame for a rate per second (weather can need several a frame).
    const many = rate => { const n = rate * dt; return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0); };
    // Fire: embers fly up, smoke rises and spreads.
    for (const f of fire) {
        const [cx, cy] = at(f.x, f.y);
        if (chance(0.9 * f.heat)) spawn({ kind: 'ember', x: cx + rnd(-0.35, 0.35) * tile, y: cy, vx: rnd(-0.3, 0.3) * tile, vy: -rnd(0.6, 1.3) * tile, life: rnd(0.6, 1.4), max: 1.4, size: Math.max(1.5, tile / 30) });
        if (chance(0.35 * f.heat)) spawn({ kind: 'smoke', x: cx + rnd(-0.3, 0.3) * tile, y: cy - tile * 0.4, vx: rnd(-0.1, 0.25) * tile, vy: -rnd(0.3, 0.55) * tile, life: rnd(1.8, 3), max: 3, size: tile * 0.5, grow: tile * 0.45 });
    }
    // Spell areas: frost sparkles, poison and acid bubbles, holy motes.
    for (const e of effects) {
        const kind = { ice: 'spark', holy: 'spark', poison: 'bubble', acid: 'bubble' }[e.type];
        if (!kind || !chance(0.6 + e.radius * 0.4)) continue;
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (e.radius + 0.4) * tile;
        const [cx, cy] = at(e.x, e.y);
        spawn({ kind, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, vx: 0, vy: e.type === 'holy' ? -tile * 0.4 : kind === 'bubble' ? -tile * 0.15 : 0, life: rnd(0.5, 1.2), max: 1.2, size: tile / 18, color: { ice: '210,240,255', holy: '255,225,140', poison: '120,200,60', acid: '190,230,60' }[e.type] });
    }
    if (!src) return;
    // Natural: glints on water, sparks from fires in hearths and braziers, lava bubbling.
    for (const [x, y] of src.water) if (shown(x, y) && chance(0.12)) { const [cx, cy] = at(x, y); spawn({ kind: 'glint', under: true, x: cx + rnd(-0.4, 0.4) * tile, y: cy + rnd(-0.4, 0.4) * tile, vx: tile * 0.1, vy: 0, life: rnd(0.5, 1), max: 1, size: tile * rnd(0.08, 0.16) }); }
    for (const l of src.lights) if (SPITS.has(l.type) && shown(Math.round(l.x), Math.round(l.y)) && chance(0.5)) { const [cx, cy] = at(l.x, l.y); spawn({ kind: 'ember', x: cx + rnd(-0.2, 0.2) * tile, y: cy - tile * 0.1, vx: rnd(-0.2, 0.2) * tile, vy: -rnd(0.5, 1) * tile, life: rnd(0.5, 1), max: 1, size: Math.max(1.2, tile / 34) }); }
    for (const [x, y] of src.lava) if (shown(x, y) && chance(0.25)) { const [cx, cy] = at(x, y); spawn({ kind: 'bubble', x: cx + rnd(-0.35, 0.35) * tile, y: cy + rnd(-0.3, 0.3) * tile, vx: 0, vy: -tile * 0.1, life: rnd(0.4, 0.8), max: 0.8, size: tile / 14, color: '255,140,40' }); }
    // The air: across what's on screen.
    const top = () => ({ x: view.x + Math.random() * view.w, y: view.y - tile * 0.5 });
    const anywhere = () => ({ x: view.x + Math.random() * view.w, y: view.y + Math.random() * view.h });
    const area = Math.max(1, (view.w * view.h) / (tile * tile * 100));
    if (air === 'rain') for (let i = many(28 * area); i > 0; i--) { const p = top(); spawn({ kind: 'rain', ...p, vx: -tile * 1.2, vy: tile * 9, life: 2, max: 2, size: tile * 0.32 }); }
    if (air === 'snow') for (let i = many(9 * area); i > 0; i--) { const p = top(); spawn({ kind: 'snow', ...p, vx: -tile * 0.15, vy: tile * rnd(0.5, 0.9), life: 12, max: 12, size: rnd(1.5, 3), seed: Math.random() * 9 }); }
    if (air === 'ash' && chance(5 * area)) { const p = top(); spawn({ kind: 'ash', ...p, vx: tile * rnd(-0.1, 0.2), vy: tile * rnd(0.25, 0.45), life: 14, max: 14, size: rnd(1.5, 2.5), seed: Math.random() * 9 }); }
    if (air === 'leaves' && chance(0.7 * area)) { const p = top(); spawn({ kind: 'leaves', ...p, vx: tile * rnd(0.1, 0.4), vy: tile * rnd(0.35, 0.6), life: 14, max: 14, size: tile * 0.09, seed: Math.random() * 9, color: Math.random() < 0.5 ? '200,120,40' : '150,160,50' }); }
    if (air === 'sand') for (let i = many(10 * area); i > 0; i--) { const p = anywhere(); spawn({ kind: 'sand', x: view.x - tile, y: p.y, vx: tile * rnd(3, 5), vy: tile * rnd(-0.1, 0.1), life: 4, max: 4, size: tile * 0.25 }); }
    if (air === 'dust' && chance(2.2 * area)) { const p = anywhere(); spawn({ kind: 'dust', ...p, vx: tile * rnd(-0.06, 0.06), vy: tile * rnd(-0.06, 0.04), life: rnd(4, 7), max: 7, size: rnd(1, 1.8) }); }
    if (air === 'fireflies' && chance(1.5 * area)) { const p = anywhere(); spawn({ kind: 'fireflies', ...p, vx: 0, vy: 0, life: rnd(3, 6), max: 6, size: tile * 0.1, seed: Math.random() * 9 }); }
    if (air === 'mist' && chance(0.6 * area)) { const p = anywhere(); spawn({ kind: 'mist', x: view.x - tile * 3, y: p.y, vx: tile * rnd(0.3, 0.6), vy: 0, life: 30, max: 30, size: tile * rnd(3, 5) }); }
    // Embers from the fires of a hostile camp: slow glowing specks drifting up and across the whole screen.
    if (air === 'embers' && chance(2.4 * area)) { const fromRight = Math.random() < 0.5, p = anywhere(); spawn({ kind: 'embers', x: fromRight ? view.x + view.w + tile * 0.5 : p.x, y: fromRight ? p.y : view.y + view.h + tile * 0.5, vx: -tile * rnd(0.15, 0.45), vy: -tile * rnd(0.12, 0.35), life: rnd(9, 15), max: 15, size: rnd(1.6, 3), seed: Math.random() * 9 }); }
}

function drawPart(ctx, p, tile, now) {
    const fade = Math.max(0, Math.min(1, p.life / p.max));
    switch (p.kind) {
        case 'alert': { const a = Math.min(1, fade * 3); ctx.font = `bold ${Math.round(p.size)}px sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = Math.max(2, p.size / 5); ctx.strokeStyle = `rgba(20,10,0,${0.9 * a})`; ctx.strokeText('!', p.x, p.y); ctx.fillStyle = `rgba(255,210,40,${a})`; ctx.fillText('!', p.x, p.y); ctx.textAlign = 'start'; break; }
        case 'z': { const a = Math.sin(fade * Math.PI); ctx.fillStyle = `rgba(225,232,255,${0.85 * a})`; ctx.font = `bold ${Math.round(p.size * (1.3 - fade * 0.5))}px sans-serif`; ctx.fillText('z', p.x, p.y); break; }
        case 'drop': ctx.fillStyle = `rgba(170,10,10,${0.85 * fade})`; ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size, p.size * 1.4, 0, 0, Math.PI * 2); ctx.fill(); break;
        case 'ember': ctx.fillStyle = `rgba(255,${Math.round(120 + 100 * fade)},40,${0.9 * fade})`; ctx.fillRect(p.x, p.y, p.size, p.size); break;
        case 'embers': { const pulse = 0.55 + 0.45 * Math.sin(now / 160 + p.seed * 7); const a = Math.min(1, fade * 2.5, (p.max - p.life) * 1.5) * pulse; ctx.globalAlpha = 0.8 * a; ctx.drawImage(softDot('255,150,60', 32), p.x - p.size * 2.2, p.y - p.size * 2.2, p.size * 4.4, p.size * 4.4); ctx.globalAlpha = 1; ctx.fillStyle = `rgba(255,${Math.round(200 - 90 * pulse)},70,${a})`; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); break; }
        case 'smoke': { ctx.globalAlpha = 0.15 * fade * Math.min(1, (p.max - p.life) * 2); const s = softDot('120,114,108', 48); ctx.drawImage(s, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); ctx.globalAlpha = 1; break; }
        case 'glint': { ctx.strokeStyle = `rgba(230,245,255,${0.55 * Math.sin(fade * Math.PI)})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.x - p.size, p.y); ctx.lineTo(p.x + p.size, p.y); ctx.stroke(); break; }
        case 'spark': { const a = Math.sin(fade * Math.PI); ctx.fillStyle = `rgba(${p.color},${0.85 * a})`; ctx.fillRect(p.x - p.size / 2, p.y - p.size * 1.5, p.size, p.size * 3); ctx.fillRect(p.x - p.size * 1.5, p.y - p.size / 2, p.size * 3, p.size); break; }
        case 'bubble': ctx.strokeStyle = `rgba(${p.color},${0.7 * fade})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.4 - fade * 0.6), 0, Math.PI * 2); ctx.stroke(); break;
        case 'rain': ctx.strokeStyle = 'rgba(190,210,240,0.5)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 0.035, p.y + p.size); ctx.stroke(); break;
        case 'snow': ctx.fillStyle = 'rgba(245,250,255,0.75)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); break;
        case 'ash': ctx.fillStyle = 'rgba(150,145,140,0.55)'; ctx.fillRect(p.x, p.y, p.size, p.size * 0.7); break;
        case 'leaves': { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate((p.life + p.seed) * 2); ctx.fillStyle = `rgba(${p.color},0.75)`; ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); break; }
        case 'sand': ctx.strokeStyle = 'rgba(220,190,130,0.3)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.size, p.y); ctx.stroke(); break;
        case 'dust': ctx.fillStyle = `rgba(235,225,200,${0.35 * Math.sin(fade * Math.PI)})`; ctx.fillRect(p.x, p.y, p.size, p.size); break;
        case 'fireflies': { const blink = 0.5 + 0.5 * Math.sin(now / 300 + p.seed * 5); ctx.globalAlpha = 0.8 * blink * Math.sin(fade * Math.PI); ctx.drawImage(softDot('210,255,120', 32), p.x - p.size * 2, p.y - p.size * 2, p.size * 4, p.size * 4); ctx.globalAlpha = 1; break; }
        case 'mist': { ctx.globalAlpha = 0.07 * Math.sin(fade * Math.PI); ctx.drawImage(softDot('220,225,230', 64), p.x - p.size / 2, p.y - p.size / 3, p.size, p.size * 0.66); ctx.globalAlpha = 1; break; }
    }
}

/** Fog, smoke, darkness and poison: soft clouds drifting slowly over the area. */
function drawCloud(ctx, e, at, tile, now) {
    const color = { fog: '200,205,210', smoke: '140,136,130', poison: '120,170,60', darkness: '0,0,0' }[e.type];
    if (!color) return;
    const [cx, cy] = at(e.x, e.y), rad = (e.radius + 0.5) * tile;
    if (e.type === 'darkness') {
        const g = ctx.createRadialGradient(cx, cy, rad * 0.55, cx, cy, rad);
        g.addColorStop(0, 'rgba(0,0,0,0.88)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    }
    const puff = softDot(color, 64), n = Math.min(26, 4 + e.radius * 4);
    ctx.globalAlpha = e.type === 'darkness' ? 0.5 : e.type === 'poison' ? 0.26 : e.type === 'smoke' ? 0.42 : 0.32;
    for (let i = 0; i < n; i++) {
        const a = i * 2.39996 + now / 9000 * (i % 2 ? 1 : -1), d = rad * 0.85 * Math.sqrt((i + 0.5) / n);
        const size = tile * (1.4 + (i % 3) * 0.5);
        ctx.drawImage(puff, cx + Math.cos(a) * d - size / 2, cy + Math.sin(a) * d - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
}

function drawWeb(ctx, cx, cy, rad) {
    ctx.strokeStyle = 'rgba(235,235,235,0.28)'; ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); ctx.stroke(); }
    for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, rad * k / 4.4, 0, Math.PI * 2); ctx.stroke(); }
}

/** A one-off burst, played once over about a second. */
function drawFlash(ctx, fl, at, tile) {
    const age = (Date.now() - fl.at) / 1000;
    if (age < 0 || age > 1.2) return;
    const [cx, cy] = at(fl.x, fl.y), rad = Math.max(0.6, fl.radius + 0.5) * tile, t = age / 1.2, fade = 1 - t;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (fl.kind === 'fire') {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad * (0.4 + t));
        g.addColorStop(0, `rgba(255,240,180,${0.8 * fade})`); g.addColorStop(0.5, `rgba(255,140,40,${0.6 * fade})`); g.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rad * (0.4 + t), 0, Math.PI * 2); ctx.fill();
    } else if (fl.kind === 'lightning') {
        ctx.fillStyle = `rgba(200,220,255,${0.45 * fade * (Math.floor(age * 20) % 2 ? 1 : 0.4)})`; ctx.beginPath(); ctx.arc(cx, cy, rad * 1.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(240,245,255,${fade})`; ctx.lineWidth = Math.max(2, tile / 16);
        ctx.beginPath(); let x = cx, y = cy - rad * 1.6; ctx.moveTo(x, y);
        for (let i = 0; i < 7; i++) { x = cx + (hash2(i, fl.at % 997) - 0.5) * tile; y += rad * 1.6 / 7; ctx.lineTo(x, y); }
        ctx.stroke();
    } else {
        // Thunder (a shock ring) or steam (a white puff).
        ctx.strokeStyle = fl.kind === 'steam' ? `rgba(240,240,240,${0.5 * fade})` : `rgba(200,210,255,${0.6 * fade})`;
        ctx.lineWidth = Math.max(2, tile / 10) * fade;
        ctx.beginPath(); ctx.arc(cx, cy, rad * (0.3 + t), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
}
