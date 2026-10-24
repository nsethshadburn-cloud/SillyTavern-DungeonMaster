// Map art: every tile and prop is painted in code on a canvas, with a seeded random generator per
// square, so floors never visibly repeat (each slab, plank, tuft and crack is different) and the
// same map always looks the same. Themes set the palette. Light sources (torches, braziers,
// campfires, lava) glow through the theme's darkness.

import { terrainAt, propAt, PROPS } from '../core/grid.js';

// ---------- seeded randomness ----------
function hash(...n) {
    let h = 2166136261;
    for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
    return h >>> 0;
}
function rngFor(...n) {
    let a = hash(...n) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r, a, b) => a + r() * (b - a);
const pick = (r, list) => list[Math.floor(r() * list.length)];

// ---------- colors ----------
function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }
/** A palette color as [h, s, l]; jitter it per tile. */
function tone([h, s, l], r, dl = 6, dh = 4) { return hsl(h + between(r, -dh, dh), s, Math.max(2, l + between(r, -dl, dl))); }

const THEME_STYLE = {
    dungeon: { floor: 'stone', floorC: [30, 6, 38], wall: 'brick', wallC: [25, 7, 28], dark: 0.35, moss: 0.12 },
    crypt: { floor: 'stone', floorC: [235, 8, 34], wall: 'brick', wallC: [240, 8, 24], dark: 0.5, moss: 0.08 },
    cave: { floor: 'rock', floorC: [28, 14, 32], wall: 'rock', wallC: [24, 14, 20], dark: 0.45, moss: 0.06 },
    mine: { floor: 'dirt', floorC: [28, 24, 28], wall: 'rock', wallC: [24, 14, 18], dark: 0.5, moss: 0 },
    sewer: { floor: 'stone', floorC: [90, 10, 28], wall: 'brick', wallC: [80, 10, 22], dark: 0.45, moss: 0.25 },
    castle: { floor: 'flag', floorC: [35, 8, 45], wall: 'brick', wallC: [30, 8, 34], dark: 0.15, moss: 0.03 },
    temple: { floor: 'marble', floorC: [40, 12, 70], wall: 'brick', wallC: [38, 14, 52], dark: 0.1, moss: 0 },
    prison: { floor: 'stone', floorC: [30, 5, 33], wall: 'brick', wallC: [25, 5, 24], dark: 0.4, moss: 0.1 },
    tavern: { floor: 'planks', floorC: [28, 40, 30], wall: 'timber', wallC: [35, 22, 50], dark: 0.12, moss: 0 },
    library: { floor: 'planks', floorC: [20, 35, 26], wall: 'timber', wallC: [30, 18, 46], dark: 0.2, moss: 0 },
    house: { floor: 'planks', floorC: [30, 35, 36], wall: 'timber', wallC: [38, 22, 54], dark: 0.08, moss: 0 },
    town: { floor: 'cobble', floorC: [30, 8, 46], wall: 'brick', wallC: [12, 30, 38], dark: 0, moss: 0.02 },
    forest: { floor: 'grass', floorC: [100, 35, 30], wall: 'hedge', wallC: [120, 35, 16], dark: 0.05, moss: 0 },
    camp: { floor: 'dirt', floorC: [32, 30, 30], wall: 'hedge', wallC: [120, 30, 16], dark: 0.3, moss: 0 },
    swamp: { floor: 'mud', floorC: [70, 25, 20], wall: 'hedge', wallC: [95, 30, 13], dark: 0.2, moss: 0.2 },
    snow: { floor: 'snow', floorC: [210, 30, 88], wall: 'rock', wallC: [215, 10, 45], dark: 0, moss: 0 },
    desert: { floor: 'sand', floorC: [40, 55, 62], wall: 'sandstone', wallC: [32, 45, 48], dark: 0, moss: 0 },
    ship: { floor: 'deck', floorC: [30, 40, 32], wall: 'timber', wallC: [28, 35, 26], dark: 0.05, moss: 0 },
};
/** Colors for floors named in the map (not the theme's "."), so dirt is brown in any theme. */
const MATERIAL = { planks: [28, 40, 30], deck: [30, 40, 32], flag: [35, 8, 45], cobble: [30, 8, 46], grass: [100, 35, 30], dirt: [30, 30, 30], mud: [60, 22, 20] };
const OUTDOOR = new Set(['forest', 'camp', 'swamp', 'snow', 'desert', 'town']);

// ---------- small drawing helpers ----------
function speckle(ctx, r, x, y, s, n, dark = 0.12, light = 0.07) {
    for (let i = 0; i < n; i++) {
        const lightDot = r() < 0.45;
        ctx.fillStyle = lightDot ? `rgba(255,255,255,${between(r, 0.02, light)})` : `rgba(0,0,0,${between(r, 0.03, dark)})`;
        const d = between(r, 0.6, 2.4) * s / 64;
        ctx.fillRect(x + r() * s, y + r() * s, d, d);
    }
}
function blob(ctx, cx, cy, rad, color) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
}
function crack(ctx, r, x, y, s) {
    ctx.strokeStyle = `rgba(0,0,0,${between(r, 0.25, 0.45)})`;
    ctx.lineWidth = s / 64;
    ctx.beginPath();
    let px = x + between(r, 0.15, 0.85) * s, py = y + between(r, 0.1, 0.4) * s;
    ctx.moveTo(px, py);
    for (let i = 0; i < 4; i++) { px += between(r, -0.18, 0.18) * s; py += between(r, 0.08, 0.2) * s; ctx.lineTo(px, py); }
    ctx.stroke();
}
function ellipse(ctx, cx, cy, rx, ry, fill, stroke = null, lw = 1) {
    ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function rrect(ctx, x, y, w, h, rad, fill, stroke = null, lw = 1) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, rad);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function shadow(ctx, cx, cy, rx, ry) { ellipse(ctx, cx, cy, rx, ry, 'rgba(0,0,0,0.35)'); }

// ---------- floors ----------
const FLOOR = {
    stone(ctx, r, x, y, s, st) {
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] - 10); ctx.fillRect(x, y, s, s); // mortar
        const split = r() < 0.55 ? 2 : 1, g = s * 0.03, cell = s / split;
        for (let i = 0; i < split; i++) for (let j = 0; j < split; j++) {
            const ox = x + i * cell + g, oy = y + j * cell + g, w = cell - g * 2;
            rrect(ctx, ox, oy, w, w, s * 0.04, tone(st.floorC, r, 7));
            ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(ox, oy, w, s * 0.02);
        }
        speckle(ctx, r, x, y, s, 45);
        if (r() < 0.22) crack(ctx, r, x, y, s);
        if (r() < st.moss) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.45), 'rgba(70,110,40,0.35)');
    },
    flag(ctx, r, x, y, s, st) {
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] - 14); ctx.fillRect(x, y, s, s);
        const cuts = [between(r, 0.35, 0.65)];
        rrect(ctx, x + s * 0.03, y + s * 0.03, s * cuts[0] - s * 0.05, s * 0.94, s * 0.05, tone(st.floorC, r, 8));
        rrect(ctx, x + s * cuts[0] + s * 0.02, y + s * 0.03, s * (1 - cuts[0]) - s * 0.05, s * between(r, 0.4, 0.6), s * 0.05, tone(st.floorC, r, 8));
        rrect(ctx, x + s * cuts[0] + s * 0.02, y + s * 0.66, s * (1 - cuts[0]) - s * 0.05, s * 0.31, s * 0.05, tone(st.floorC, r, 8));
        speckle(ctx, r, x, y, s, 40);
        if (r() < 0.15) crack(ctx, r, x, y, s);
    },
    marble(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 4); ctx.fillRect(x, y, s, s);
        ctx.strokeStyle = 'rgba(90,80,70,0.25)'; ctx.lineWidth = s / 80;
        for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.moveTo(x + r() * s, y); ctx.bezierCurveTo(x + r() * s, y + s * 0.3, x + r() * s, y + s * 0.7, x + r() * s, y + s); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    },
    rock(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 5); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 4; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.5), r() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.06)');
        speckle(ctx, r, x, y, s, 70, 0.2, 0.08);
        if (r() < 0.3) for (let i = 0; i < 3; i++) ellipse(ctx, x + r() * s, y + r() * s, s * 0.03, s * 0.02, 'rgba(120,110,100,0.7)');
    },
    planks(ctx, r, x, y, s, st) {
        const n = 4, h = s / n;
        for (let i = 0; i < n; i++) {
            const py = y + i * h;
            ctx.fillStyle = tone(st.floorC, r, 7, 3); ctx.fillRect(x, py, s, h);
            ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = s / 128;
            for (let k = 0; k < 3; k++) { const gy = py + between(r, 0.2, 0.8) * h; ctx.beginPath(); ctx.moveTo(x, gy); ctx.bezierCurveTo(x + s * 0.3, gy + between(r, -2, 2), x + s * 0.7, gy + between(r, -2, 2), x + s, gy); ctx.stroke(); }
            if (r() < 0.45) { const jx = x + between(r, 0.15, 0.85) * s; ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(jx, py, s / 64, h); }
            if (r() < 0.12) ellipse(ctx, x + r() * s, py + h / 2, s * 0.035, h * 0.18, 'rgba(60,30,10,0.45)');
            ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, py + h - s / 96, s, s / 96);
        }
    },
    deck(ctx, r, x, y, s, st) {
        FLOOR.planks(ctx, r, x, y, s, st);
        ctx.fillStyle = 'rgba(30,20,10,0.6)';
        for (let i = 0; i < 4; i++) ctx.fillRect(x + s * 0.06, y + (i + 0.5) * s / 4 - 1, 2, 2);
    },
    grass(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 4, 6); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 3; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.45), r() < 0.5 ? 'rgba(20,40,10,0.18)' : 'rgba(200,220,120,0.10)');
        ctx.lineWidth = s / 90;
        for (let i = 0; i < 46; i++) {
            const bx = x + r() * s, by = y + r() * s, len = between(r, 0.05, 0.11) * s;
            ctx.strokeStyle = hsl(between(r, 85, 120), 45, between(r, 22, 42), 0.8);
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + between(r, -0.03, 0.03) * s, by - len); ctx.stroke();
        }
        if (r() < 0.1) for (let i = 0; i < 4; i++) ellipse(ctx, x + r() * s, y + r() * s, s * 0.018, s * 0.018, pick(r, ['#f4f1e0', '#f5d64a', '#c79be6']));
    },
    dirt(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 4); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 4; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.15, 0.4), r() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,230,190,0.07)');
        speckle(ctx, r, x, y, s, 60, 0.18);
        for (let i = 0; i < 4; i++) ellipse(ctx, x + r() * s, y + r() * s, s * between(r, 0.015, 0.035), s * 0.015, 'rgba(140,130,115,0.8)');
    },
    mud(ctx, r, x, y, s, st) {
        FLOOR.dirt(ctx, r, x, y, s, st);
        if (r() < 0.35) { const cx = x + r() * s, cy = y + r() * s; ellipse(ctx, cx, cy, s * 0.2, s * 0.1, 'rgba(40,50,30,0.55)'); ellipse(ctx, cx - s * 0.05, cy - s * 0.03, s * 0.06, s * 0.02, 'rgba(255,255,255,0.12)'); }
    },
    cobble(ctx, r, x, y, s, st) {
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] - 18); ctx.fillRect(x, y, s, s);
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
            const cx = x + (i + 0.5 + between(r, -0.12, 0.12)) * s / 3 + (j % 2 ? s / 12 : 0), cy = y + (j + 0.5 + between(r, -0.1, 0.1)) * s / 3;
            ellipse(ctx, cx, cy, s * between(r, 0.12, 0.16), s * between(r, 0.1, 0.14), tone(st.floorC, r, 9));
            ellipse(ctx, cx - s * 0.03, cy - s * 0.03, s * 0.05, s * 0.03, 'rgba(255,255,255,0.08)');
        }
    },
    snow(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 3); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 3; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.5), 'rgba(120,150,200,0.12)');
        for (let i = 0; i < 6; i++) ctx.fillStyle = 'rgba(255,255,255,0.9)', ctx.fillRect(x + r() * s, y + r() * s, 1.5, 1.5);
    },
    sand(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 3); ctx.fillRect(x, y, s, s);
        ctx.strokeStyle = 'rgba(120,80,30,0.18)'; ctx.lineWidth = s / 90;
        const ph = r() * 6;
        for (let k = 0; k < 4; k++) { ctx.beginPath(); for (let i = 0; i <= 8; i++) { const px = x + i * s / 8, py = y + (k + 0.5) * s / 4 + Math.sin(ph + i * 0.9) * s * 0.03; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke(); }
        speckle(ctx, r, x, y, s, 30, 0.08);
    },
};
FLOOR.sandstone = FLOOR.sand;

// ---------- walls ----------
function wall(ctx, r, x, y, s, st, below) {
    const style = st.wall, c = st.wallC;
    if (style === 'hedge') {
        ctx.fillStyle = hsl(c[0], c[1], c[2] - 4); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 7; i++) { const cx = x + r() * s, cy = y + r() * s, rad = s * between(r, 0.2, 0.36); ellipse(ctx, cx, cy, rad, rad, tone(c, r, 6, 10)); ellipse(ctx, cx - rad * 0.3, cy - rad * 0.3, rad * 0.45, rad * 0.4, 'rgba(255,255,255,0.07)'); }
        return;
    }
    if (style === 'rock') {
        ctx.fillStyle = tone(c, r, 3); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 6; i++) {
            ctx.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.22)';
            ctx.beginPath(); const cx = x + r() * s, cy = y + r() * s;
            ctx.moveTo(cx, cy); for (let k = 0; k < 4; k++) ctx.lineTo(cx + between(r, -0.25, 0.25) * s, cy + between(r, -0.25, 0.25) * s); ctx.fill();
        }
        speckle(ctx, r, x, y, s, 50, 0.25);
    } else if (style === 'timber') {
        ctx.fillStyle = tone(c, r, 3); ctx.fillRect(x, y, s, s); // plaster
        speckle(ctx, r, x, y, s, 30, 0.08);
        ctx.fillStyle = hsl(25, 40, 18); ctx.fillRect(x, y, s, s * 0.12); ctx.fillRect(x, y + s * 0.88, s, s * 0.12);
        if (r() < 0.5) { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(r() < 0.5 ? 0.78 : -0.78); ctx.fillRect(-s * 0.7, -s * 0.05, s * 1.4, s * 0.1); ctx.restore(); }
    } else {
        // brick / sandstone blocks
        ctx.fillStyle = hsl(c[0], c[1], c[2] - 10); ctx.fillRect(x, y, s, s);
        const rows = style === 'sandstone' ? 3 : 4, bh = s / rows;
        for (let j = 0; j < rows; j++) {
            const off = (j % 2) * s / 4 - s / 4;
            for (let i = -1; i < 3; i++) {
                const bx = x + off + i * s / 2 + s * 0.015, bw = s / 2 - s * 0.03;
                const cx0 = Math.max(x, bx), cx1 = Math.min(x + s, bx + bw);
                if (cx1 > cx0) { ctx.fillStyle = tone(c, r, 6, 5); ctx.fillRect(cx0, y + j * bh + s * 0.015, cx1 - cx0, bh - s * 0.03); }
            }
        }
        speckle(ctx, r, x, y, s, 35, 0.15);
        if (st.moss && r() < st.moss) blob(ctx, x + r() * s, y + s, s * 0.35, 'rgba(60,100,40,0.35)');
    }
    // Front face where the wall meets open floor below: reads as height.
    if (below) {
        const g = ctx.createLinearGradient(0, y + s * 0.62, 0, y + s);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
        ctx.fillStyle = g; ctx.fillRect(x, y + s * 0.62, s, s * 0.38);
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, y, s, s * 0.04);
    }
}

// ---------- special terrain ----------
function water(ctx, r, x, y, s, deep, t) {
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, deep ? hsl(212, 55, 22) : hsl(195, 45, 38)); g.addColorStop(1, deep ? hsl(220, 60, 16) : hsl(200, 50, 30));
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = `rgba(255,255,255,${deep ? 0.08 : 0.16})`; ctx.lineWidth = s / 70;
    for (let i = 0; i < 4; i++) { const cx = x + r() * s, cy = y + r() * s; ctx.beginPath(); ctx.arc(cx, cy, s * between(r, 0.06, 0.14), Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    if (!deep && r() < 0.3) ellipse(ctx, x + r() * s, y + r() * s, s * 0.04, s * 0.03, 'rgba(120,110,100,0.5)');
}
function lava(ctx, r, x, y, s) {
    const g = ctx.createRadialGradient(x + s / 2, y + s / 2, 0, x + s / 2, y + s / 2, s * 0.75);
    g.addColorStop(0, '#ffd34d'); g.addColorStop(0.5, '#ff7a1a'); g.addColorStop(1, '#a3240b');
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    for (let i = 0; i < 5; i++) {
        ctx.fillStyle = 'rgba(40,10,5,0.75)'; ctx.beginPath(); const cx = x + r() * s, cy = y + r() * s;
        ctx.moveTo(cx, cy); for (let k = 0; k < 5; k++) ctx.lineTo(cx + between(r, -0.13, 0.13) * s, cy + between(r, -0.13, 0.13) * s); ctx.fill();
    }
}
function pit(ctx, r, x, y, s) {
    const g = ctx.createRadialGradient(x + s / 2, y + s / 2, s * 0.05, x + s / 2, y + s / 2, s * 0.55);
    g.addColorStop(0, '#000'); g.addColorStop(0.7, 'rgba(0,0,0,0.92)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = 'rgba(160,140,120,0.35)'; ctx.lineWidth = s / 40; ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.44, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
}
function rubble(ctx, r, x, y, s) {
    for (let i = 0; i < 8; i++) {
        const cx = x + r() * s, cy = y + r() * s, rad = s * between(r, 0.04, 0.1);
        shadow(ctx, cx + rad * 0.3, cy + rad * 0.4, rad, rad * 0.6);
        ctx.fillStyle = hsl(30, 6, between(r, 30, 52)); ctx.beginPath();
        for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; const rr = rad * between(r, 0.7, 1.15); k ? ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        ctx.fill();
    }
}
function tree(ctx, r, x, y, s) {
    const cx = x + s / 2, cy = y + s / 2;
    shadow(ctx, cx + s * 0.08, cy + s * 0.12, s * 0.45, s * 0.3);
    ellipse(ctx, cx, cy + s * 0.05, s * 0.08, s * 0.08, '#4a3020');
    for (let i = 0; i < 6; i++) { const a = r() * Math.PI * 2, d = s * between(r, 0.05, 0.2), rad = s * between(r, 0.18, 0.28); ellipse(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rad, rad, hsl(between(r, 95, 130), 40, between(r, 18, 30))); }
    ellipse(ctx, cx - s * 0.1, cy - s * 0.12, s * 0.16, s * 0.12, 'rgba(200,255,150,0.12)');
}
function pillar(ctx, r, x, y, s) {
    const cx = x + s / 2, cy = y + s / 2;
    shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.36, s * 0.26);
    ellipse(ctx, cx, cy, s * 0.36, s * 0.36, hsl(30, 6, 36));
    const g = ctx.createRadialGradient(cx - s * 0.1, cy - s * 0.1, s * 0.02, cx, cy, s * 0.32);
    g.addColorStop(0, hsl(30, 6, 66)); g.addColorStop(1, hsl(30, 6, 34));
    ellipse(ctx, cx, cy, s * 0.29, s * 0.29, g);
}
function door(ctx, r, x, y, s, kind, horizontal) {
    ctx.save(); ctx.translate(x + s / 2, y + s / 2); if (!horizontal) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = hsl(25, 20, 18); ctx.fillRect(-s / 2, -s * 0.16, s * 0.12, s * 0.32); ctx.fillRect(s * 0.38, -s * 0.16, s * 0.12, s * 0.32); // frame
    if (kind === 'open') {
        ctx.fillStyle = hsl(28, 40, 32); ctx.fillRect(-s * 0.38, -s * 0.12, s * 0.08, s * 0.62);
    } else {
        ctx.fillStyle = hsl(28, 45, 33); ctx.fillRect(-s * 0.38, -s * 0.1, s * 0.76, s * 0.2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; for (let i = -2; i <= 2; i++) ctx.fillRect(i * s * 0.15, -s * 0.1, 1, s * 0.2);
        if (kind === 'locked') { ctx.fillStyle = '#5c5c5c'; ctx.fillRect(-s * 0.38, -s * 0.03, s * 0.76, s * 0.06); ellipse(ctx, s * 0.12, 0, s * 0.06, s * 0.07, '#c9a227'); }
        else ellipse(ctx, s * 0.25, 0, s * 0.03, s * 0.03, '#c9a227');
    }
    ctx.restore();
}
function stairs(ctx, r, x, y, s, up) {
    for (let i = 0; i < 5; i++) { const l = up ? 30 + i * 8 : 62 - i * 8; ctx.fillStyle = hsl(30, 6, l); ctx.fillRect(x + s * 0.08, y + i * s / 5, s * 0.84, s / 5 - 1); }
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = `${s * 0.32}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(up ? '▲' : '▼', x + s / 2, y + s / 2);
}
function bridge(ctx, r, x, y, s, horizontal, overWater = true) {
    if (overWater) water(ctx, r, x, y, s, true);
    else { ctx.fillStyle = '#060606'; ctx.fillRect(x, y, s, s); blob(ctx, x + s / 2, y + s / 2, s * 0.7, 'rgba(255,120,40,0.12)'); }
    ctx.save(); ctx.translate(x + s / 2, y + s / 2); if (!horizontal) ctx.rotate(Math.PI / 2);
    for (let i = 0; i < 5; i++) { ctx.fillStyle = hsl(28, 35, between(r, 26, 36)); ctx.fillRect(-s / 2 + i * s / 5 + 1, -s * 0.3, s / 5 - 2, s * 0.6); }
    ctx.fillStyle = hsl(28, 30, 20); ctx.fillRect(-s / 2, -s * 0.33, s, s * 0.04); ctx.fillRect(-s / 2, s * 0.29, s, s * 0.04);
    ctx.restore();
}

// ---------- props ----------
function flame(ctx, cx, cy, size) {
    blob(ctx, cx, cy, size * 1.6, 'rgba(255,170,60,0.35)');
    ellipse(ctx, cx, cy, size * 0.45, size * 0.7, '#ff8a1f');
    ellipse(ctx, cx, cy + size * 0.12, size * 0.25, size * 0.4, '#ffe066');
}
const PROP_ART = {
    chest(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.2, s * 0.32, s * 0.12); rrect(ctx, cx - s * 0.3, cy - s * 0.18, s * 0.6, s * 0.38, s * 0.04, hsl(28, 50, 30), hsl(28, 50, 15), 2); rrect(ctx, cx - s * 0.3, cy - s * 0.22, s * 0.6, s * 0.14, s * 0.05, hsl(28, 50, 38)); ctx.fillStyle = '#b8902a'; ctx.fillRect(cx - s * 0.22, cy - s * 0.22, s * 0.05, s * 0.42); ctx.fillRect(cx + s * 0.17, cy - s * 0.22, s * 0.05, s * 0.42); ellipse(ctx, cx, cy - s * 0.02, s * 0.05, s * 0.05, '#e8c34a'); },
    barrel(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.28, s * 0.2); ellipse(ctx, cx, cy, s * 0.26, s * 0.26, hsl(28, 45, 32), hsl(28, 30, 15), 2); ellipse(ctx, cx, cy, s * 0.2, s * 0.2, null, '#777', 2); ellipse(ctx, cx, cy, s * 0.12, s * 0.12, hsl(28, 40, 26)); },
    crate(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.3, s * 0.2); rrect(ctx, cx - s * 0.27, cy - s * 0.27, s * 0.54, s * 0.54, 2, hsl(35, 40, 42), hsl(30, 40, 20), 2); ctx.strokeStyle = hsl(30, 40, 22); ctx.lineWidth = s / 24; ctx.beginPath(); ctx.moveTo(cx - s * 0.25, cy - s * 0.25); ctx.lineTo(cx + s * 0.25, cy + s * 0.25); ctx.stroke(); },
    table(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.42, s * 0.3); rrect(ctx, cx - s * 0.42, cy - s * 0.3, s * 0.84, s * 0.6, s * 0.06, hsl(28, 40, 34), hsl(28, 40, 18), 2); ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(cx - s * 0.42, cy - s * 0.3 + i * s * 0.15); ctx.lineTo(cx + s * 0.42, cy - s * 0.3 + i * s * 0.15); ctx.stroke(); } if (r() < 0.6) ellipse(ctx, cx + between(r, -0.2, 0.2) * s, cy, s * 0.06, s * 0.06, '#ddd', '#999'); },
    chair(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.18, s * 0.12); rrect(ctx, cx - s * 0.16, cy - s * 0.14, s * 0.32, s * 0.3, 2, hsl(28, 40, 32)); ctx.fillStyle = hsl(28, 40, 22); ctx.fillRect(cx - s * 0.16, cy - s * 0.2, s * 0.32, s * 0.07); },
    bed(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.32, s * 0.42); rrect(ctx, cx - s * 0.3, cy - s * 0.42, s * 0.6, s * 0.84, 3, hsl(28, 40, 25)); rrect(ctx, cx - s * 0.26, cy - s * 0.38, s * 0.52, s * 0.76, 3, pick(r, ['#8b2e2e', '#2e4f8b', '#5b6b2e'])); rrect(ctx, cx - s * 0.2, cy - s * 0.36, s * 0.4, s * 0.15, 4, '#eee'); },
    bookshelf(ctx, r, cx, cy, s) { rrect(ctx, cx - s * 0.45, cy - s * 0.2, s * 0.9, s * 0.4, 2, hsl(25, 40, 20)); for (let i = 0; i < 10; i++) { ctx.fillStyle = hsl(between(r, 0, 360), 45, between(r, 25, 45)); ctx.fillRect(cx - s * 0.42 + i * s * 0.084, cy - s * 0.16, s * 0.07, s * 0.32); } },
    torch(ctx, r, cx, cy, s) { ctx.fillStyle = '#5a3b22'; ctx.fillRect(cx - s * 0.03, cy - s * 0.02, s * 0.06, s * 0.22); flame(ctx, cx, cy - s * 0.08, s * 0.16); },
    brazier(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.26, s * 0.18); ellipse(ctx, cx, cy, s * 0.24, s * 0.24, '#3a3a3a', '#222', 2); ellipse(ctx, cx, cy, s * 0.17, s * 0.17, '#5c1d0a'); flame(ctx, cx, cy - s * 0.04, s * 0.2); },
    campfire(ctx, r, cx, cy, s) { for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; ellipse(ctx, cx + Math.cos(a) * s * 0.25, cy + Math.sin(a) * s * 0.25, s * 0.07, s * 0.06, hsl(30, 5, 45)); } ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = '#4a2e1a'; ctx.rotate(0.6); ctx.fillRect(-s * 0.2, -s * 0.04, s * 0.4, s * 0.08); ctx.rotate(-1.2); ctx.fillRect(-s * 0.2, -s * 0.04, s * 0.4, s * 0.08); ctx.restore(); flame(ctx, cx, cy - s * 0.04, s * 0.2); },
    candles(ctx, r, cx, cy, s) { for (let i = 0; i < 3; i++) { const x = cx + (i - 1) * s * 0.12, y = cy + between(r, -0.05, 0.05) * s; ctx.fillStyle = '#eee3c8'; ctx.fillRect(x - s * 0.025, y - s * 0.02, s * 0.05, s * 0.1); flame(ctx, x, y - s * 0.05, s * 0.05); } },
    altar(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.1, s * 0.4, s * 0.24); rrect(ctx, cx - s * 0.4, cy - s * 0.22, s * 0.8, s * 0.44, 3, hsl(40, 10, 60), hsl(40, 10, 30), 2); ctx.fillStyle = '#7a1c1c'; ctx.fillRect(cx - s * 0.12, cy - s * 0.22, s * 0.24, s * 0.44); },
    statue(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.12, s * 0.3, s * 0.18); rrect(ctx, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 3, hsl(40, 5, 45)); ellipse(ctx, cx, cy, s * 0.17, s * 0.17, hsl(40, 5, 70), hsl(40, 5, 40), 2); ellipse(ctx, cx, cy - s * 0.02, s * 0.08, s * 0.08, hsl(40, 5, 80)); },
    pillar(ctx, r, cx, cy, s) { pillar(ctx, r, cx - s / 2, cy - s / 2, s); },
    throne(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.1, s * 0.3, s * 0.2); rrect(ctx, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 4, '#b8902a', '#6b5216', 2); rrect(ctx, cx - s * 0.2, cy - s * 0.12, s * 0.4, s * 0.36, 3, '#7a1c1c'); },
    coffin(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.24, s * 0.42); ctx.fillStyle = hsl(25, 35, 22); ctx.beginPath(); ctx.moveTo(cx - s * 0.14, cy - s * 0.42); ctx.lineTo(cx + s * 0.14, cy - s * 0.42); ctx.lineTo(cx + s * 0.24, cy - s * 0.18); ctx.lineTo(cx + s * 0.16, cy + s * 0.42); ctx.lineTo(cx - s * 0.16, cy + s * 0.42); ctx.lineTo(cx - s * 0.24, cy - s * 0.18); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#a89060'; ctx.fillRect(cx - s * 0.02, cy - s * 0.2, s * 0.04, s * 0.26); ctx.fillRect(cx - s * 0.09, cy - s * 0.12, s * 0.18, s * 0.04); },
    well(ctx, r, cx, cy, s) { ellipse(ctx, cx, cy, s * 0.4, s * 0.4, hsl(30, 6, 45), hsl(30, 6, 25), 3); ellipse(ctx, cx, cy, s * 0.26, s * 0.26, hsl(210, 50, 12)); ellipse(ctx, cx - s * 0.06, cy - s * 0.06, s * 0.08, s * 0.04, 'rgba(255,255,255,0.15)'); },
    fountain(ctx, r, cx, cy, s) { ellipse(ctx, cx, cy, s * 0.44, s * 0.44, hsl(40, 8, 62), hsl(40, 8, 35), 3); ellipse(ctx, cx, cy, s * 0.34, s * 0.34, hsl(195, 50, 40)); ellipse(ctx, cx, cy, s * 0.08, s * 0.08, hsl(40, 8, 70)); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(cx, cy, s * 0.2, 0, Math.PI * 2); ctx.stroke(); },
    cage(ctx, r, cx, cy, s) { rrect(ctx, cx - s * 0.36, cy - s * 0.36, s * 0.72, s * 0.72, 2, 'rgba(0,0,0,0.25)', '#555', 3); ctx.strokeStyle = '#666'; ctx.lineWidth = 2; for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(cx - s * 0.36 + i * s * 0.144, cy - s * 0.36); ctx.lineTo(cx - s * 0.36 + i * s * 0.144, cy + s * 0.36); ctx.stroke(); } },
    anvil(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.08, s * 0.26, s * 0.14); ctx.fillStyle = '#3c3c40'; ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy - s * 0.1); ctx.lineTo(cx + s * 0.22, cy - s * 0.1); ctx.lineTo(cx + s * 0.34, cy - s * 0.02); ctx.lineTo(cx + s * 0.22, cy + s * 0.06); ctx.lineTo(cx - s * 0.3, cy + s * 0.06); ctx.fill(); ctx.fillRect(cx - s * 0.1, cy + s * 0.06, s * 0.16, s * 0.14); },
    cauldron(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.28, s * 0.2); ellipse(ctx, cx, cy, s * 0.28, s * 0.28, '#2b2b2b', '#111', 2); ellipse(ctx, cx, cy, s * 0.2, s * 0.2, '#4caf50'); for (let i = 0; i < 3; i++) ellipse(ctx, cx + between(r, -0.1, 0.1) * s, cy + between(r, -0.1, 0.1) * s, s * 0.03, s * 0.03, 'rgba(220,255,200,0.6)'); },
    lever(ctx, r, cx, cy, s) { rrect(ctx, cx - s * 0.1, cy - s * 0.06, s * 0.2, s * 0.14, 2, '#555'); ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = s / 18; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 0.16, cy - s * 0.22); ctx.stroke(); ellipse(ctx, cx + s * 0.16, cy - s * 0.22, s * 0.04, s * 0.04, '#b33'); },
    rug(ctx, r, cx, cy, s) { const c = pick(r, [[0, 55, 30], [220, 45, 30], [140, 35, 25]]); rrect(ctx, cx - s * 0.48, cy - s * 0.4, s * 0.96, s * 0.8, 2, hsl(...c, 0.9), hsl(40, 60, 50, 0.8), 2); rrect(ctx, cx - s * 0.36, cy - s * 0.28, s * 0.72, s * 0.56, 2, null, hsl(40, 60, 50, 0.6), 1); },
    banner(ctx, r, cx, cy, s) { ctx.fillStyle = '#8a1c1c'; ctx.beginPath(); ctx.moveTo(cx - s * 0.16, cy - s * 0.3); ctx.lineTo(cx + s * 0.16, cy - s * 0.3); ctx.lineTo(cx + s * 0.16, cy + s * 0.2); ctx.lineTo(cx, cy + s * 0.32); ctx.lineTo(cx - s * 0.16, cy + s * 0.2); ctx.fill(); ellipse(ctx, cx, cy - s * 0.05, s * 0.06, s * 0.06, '#d9b44a'); },
    bones(ctx, r, cx, cy, s) { ctx.strokeStyle = '#e7e0cf'; ctx.lineWidth = s / 20; ctx.lineCap = 'round'; for (let i = 0; i < 3; i++) { const a = r() * Math.PI; ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * s * 0.18, cy - Math.sin(a) * s * 0.18); ctx.lineTo(cx + Math.cos(a) * s * 0.18, cy + Math.sin(a) * s * 0.18); ctx.stroke(); } ctx.lineCap = 'butt'; },
    skull(ctx, r, cx, cy, s) { ellipse(ctx, cx, cy, s * 0.12, s * 0.11, '#e9e2d0'); ellipse(ctx, cx - s * 0.045, cy, s * 0.03, s * 0.03, '#222'); ellipse(ctx, cx + s * 0.045, cy, s * 0.03, s * 0.03, '#222'); ctx.fillStyle = '#e9e2d0'; ctx.fillRect(cx - s * 0.06, cy + s * 0.07, s * 0.12, s * 0.06); },
    web(ctx, r, cx, cy, s) { ctx.strokeStyle = 'rgba(235,235,235,0.55)'; ctx.lineWidth = 1; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * s * 0.45, cy + Math.sin(a) * s * 0.45); ctx.stroke(); } for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, k * s * 0.12, 0, Math.PI * 2); ctx.stroke(); } },
    pot(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.03, cy + s * 0.05, s * 0.16, s * 0.12); ellipse(ctx, cx, cy, s * 0.16, s * 0.16, hsl(18, 50, 40), hsl(18, 40, 22), 2); ellipse(ctx, cx, cy, s * 0.07, s * 0.07, hsl(18, 40, 18)); },
    sack(ctx, r, cx, cy, s) { for (let i = 0; i < 2; i++) { const x = cx + (i ? 0.12 : -0.1) * s, y = cy + (i ? 0.06 : -0.04) * s; shadow(ctx, x + s * 0.03, y + s * 0.06, s * 0.15, s * 0.1); ellipse(ctx, x, y, s * 0.15, s * 0.17, hsl(38, 30, 55), hsl(38, 30, 35), 1.5); } },
    trap(ctx, r, cx, cy, s) { rrect(ctx, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 2, 'rgba(60,60,60,0.6)', 'rgba(220,60,60,0.8)', 2); ctx.fillStyle = 'rgba(220,60,60,0.85)'; ctx.font = `${s * 0.34}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', cx, cy); },
    boulder(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.38, s * 0.26); ellipse(ctx, cx, cy, s * 0.38, s * 0.33, hsl(30, 6, 40)); ellipse(ctx, cx - s * 0.1, cy - s * 0.1, s * 0.16, s * 0.1, 'rgba(255,255,255,0.12)'); crack(ctx, r, cx - s * 0.3, cy - s * 0.3, s * 0.6); },
    bush(ctx, r, cx, cy, s) { for (let i = 0; i < 5; i++) { const a = r() * Math.PI * 2; ellipse(ctx, cx + Math.cos(a) * s * 0.12, cy + Math.sin(a) * s * 0.12, s * 0.2, s * 0.2, hsl(between(r, 95, 125), 40, between(r, 22, 32))); } },
    log(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.1, s * 0.45, s * 0.12); rrect(ctx, cx - s * 0.46, cy - s * 0.12, s * 0.92, s * 0.24, s * 0.12, hsl(25, 35, 26)); ellipse(ctx, cx + s * 0.4, cy, s * 0.07, s * 0.12, hsl(35, 40, 50)); },
    stalagmite(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.3, s * 0.2); ellipse(ctx, cx, cy, s * 0.3, s * 0.3, hsl(28, 12, 30)); ellipse(ctx, cx - s * 0.03, cy - s * 0.03, s * 0.17, s * 0.17, hsl(28, 12, 42)); ellipse(ctx, cx - s * 0.05, cy - s * 0.05, s * 0.06, s * 0.06, hsl(28, 12, 58)); },
    crystal(ctx, r, cx, cy, s) { blob(ctx, cx, cy, s * 0.6, 'rgba(120,200,255,0.25)'); for (let i = 0; i < 4; i++) { const x = cx + between(r, -0.18, 0.18) * s; ctx.fillStyle = hsl(between(r, 190, 280), 70, between(r, 55, 75), 0.9); ctx.beginPath(); ctx.moveTo(x, cy - s * between(r, 0.2, 0.36)); ctx.lineTo(x + s * 0.07, cy + s * 0.15); ctx.lineTo(x - s * 0.07, cy + s * 0.15); ctx.fill(); } },
    mushroom(ctx, r, cx, cy, s) { for (let i = 0; i < 4; i++) { const x = cx + between(r, -0.25, 0.25) * s, y = cy + between(r, -0.25, 0.25) * s, rad = s * between(r, 0.05, 0.1); ellipse(ctx, x, y, rad, rad, pick(r, ['#c0392b', '#b98a54', '#7e57c2'])); ellipse(ctx, x - rad * 0.3, y - rad * 0.3, rad * 0.25, rad * 0.25, 'rgba(255,255,255,0.7)'); } },
    tent(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.45, s * 0.35); ctx.fillStyle = hsl(40, 25, 48); ctx.beginPath(); ctx.moveTo(cx - s * 0.45, cy + s * 0.35); ctx.lineTo(cx, cy - s * 0.4); ctx.lineTo(cx + s * 0.45, cy + s * 0.35); ctx.closePath(); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.4); ctx.lineTo(cx + s * 0.45, cy + s * 0.35); ctx.lineTo(cx, cy + s * 0.35); ctx.fill(); },
    cart(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.42, s * 0.3); rrect(ctx, cx - s * 0.38, cy - s * 0.26, s * 0.76, s * 0.52, 2, hsl(28, 40, 36), hsl(28, 40, 18), 2); for (const dx of [-0.42, 0.42]) ellipse(ctx, cx + dx * s, cy, s * 0.06, s * 0.2, '#3a2a1a'); },
};

// ---------- the base layer: terrain + props + lighting, painted once per map ----------
const baseCache = new WeakMap();

/**
 * Paint the map (without tokens) into an offscreen canvas, cached per map object.
 * @returns {HTMLCanvasElement}
 */
export function paintMapBase(map, tile) {
    const cached = baseCache.get(map);
    if (cached && cached.tile === tile) return cached.canvas;
    const st = THEME_STYLE[map.theme] ?? THEME_STYLE.dungeon;
    const outdoor = OUTDOOR.has(map.theme);
    const canvas = document.createElement('canvas');
    canvas.width = map.w * tile; canvas.height = map.h * tile;
    const ctx = canvas.getContext('2d');
    const at = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? '#' : terrainAt(map, x, y));
    const isWall = ch => ch === '#';
    const isWater = ch => ch === '~' || ch === 'w' || ch === 'b';
    const floorFor = ch => ({ '_': 'planks', '=': st.floor === 'cobble' || OUTDOOR.has(map.theme) ? 'cobble' : 'flag', ',': 'grass', ':': st.floor === 'mud' ? 'mud' : 'dirt' })[ch] ?? st.floor;

    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const ch = at(x, y);
            const px = x * tile, py = (map.h - 1 - y) * tile; // row 1 is the bottom row
            const r = rngFor(map.seed, x, y);
            const kind = floorFor(ch);
            const ground = FLOOR[kind] ?? FLOOR.stone;
            // "." uses the theme's own floor colors; named floors (_ = , :) keep their material's colors.
            const floorStyle = ch !== '.' && MATERIAL[kind] && kind !== st.floor ? { ...st, floorC: MATERIAL[kind] } : st;
            if (ch === '#') wall(ctx, r, px, py, tile, st, !isWall(at(x, y - 1)));
            else if (ch === '~' || ch === 'w') water(ctx, r, px, py, tile, ch === 'w');
            else if (ch === 'L') lava(ctx, r, px, py, tile);
            else if (ch === 'b') {
                const overWater = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => at(x + dx, y + dy) === '~' || at(x + dx, y + dy) === 'w');
                bridge(ctx, r, px, py, tile, isWater(at(x, y + 1)) || isWater(at(x, y - 1)) || at(x, y + 1) === 'o' || at(x, y - 1) === 'o' || at(x, y + 1) === 'L' || at(x, y - 1) === 'L', overWater);
            }
            else {
                ground(ctx, r, px, py, tile, floorStyle);
                if (ch === 'o') pit(ctx, r, px, py, tile);
                else if (ch === '^') rubble(ctx, r, px, py, tile);
                else if (ch === 'T') (outdoor ? tree : pillar)(ctx, r, px, py, tile);
                else if (ch === '+' || ch === '/' || ch === 'D') door(ctx, r, px, py, tile, ch === '/' ? 'open' : ch === 'D' ? 'locked' : 'closed', isWall(at(x - 1, y)) || isWall(at(x + 1, y)));
                else if (ch === '<' || ch === '>') stairs(ctx, r, px, py, tile, ch === '<');
            }
            // Soft shadows on floor next to walls (above and left), foam where water meets land.
            if (!isWall(ch) && !isWater(ch)) {
                if (isWall(at(x, y + 1))) { const g = ctx.createLinearGradient(0, py, 0, py + tile * 0.3); g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(px, py, tile, tile * 0.3); }
                if (isWall(at(x - 1, y))) { const g = ctx.createLinearGradient(px, 0, px + tile * 0.22, 0); g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(px, py, tile * 0.22, tile); }
            }
            if (isWater(ch) && ch !== 'b') {
                ctx.strokeStyle = 'rgba(230,245,255,0.45)'; ctx.lineWidth = tile / 32;
                const edges = [[0, 1, px, py, px + tile, py], [0, -1, px, py + tile, px + tile, py + tile], [-1, 0, px, py, px, py + tile], [1, 0, px + tile, py, px + tile, py + tile]];
                for (const [dx, dy, x0, y0, x1, y1] of edges) if (!isWater(at(x + dx, y + dy)) && !isWall(at(x + dx, y + dy))) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
            }
        }
    }
    // Props (rugs first so furniture sits on them).
    const props = [...(map.props || [])].sort((a, b) => (a.type === 'rug' ? -1 : 0) - (b.type === 'rug' ? -1 : 0));
    for (const p of props) {
        const art = PROP_ART[p.type];
        if (!art) continue;
        art(ctx, rngFor(map.seed, p.x, p.y, 7), p.x * tile + tile / 2, (map.h - 1 - p.y) * tile + tile / 2, tile);
    }
    // Lighting: the theme's darkness, with warm pools around light sources.
    const lights = (map.props || []).filter(p => PROPS[p.type]?.light).map(p => ({ x: p.x, y: p.y, rad: PROPS[p.type].light }));
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (at(x, y) === 'L') lights.push({ x, y, rad: 2 });
    if (st.dark > 0) {
        const shade = document.createElement('canvas');
        shade.width = canvas.width; shade.height = canvas.height;
        const sctx = shade.getContext('2d');
        sctx.fillStyle = `rgba(5,5,15,${st.dark})`; sctx.fillRect(0, 0, shade.width, shade.height);
        sctx.globalCompositeOperation = 'destination-out';
        for (const l of lights) {
            const cx = l.x * tile + tile / 2, cy = (map.h - 1 - l.y) * tile + tile / 2, rad = l.rad * tile;
            const g = sctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
            sctx.fillStyle = g; sctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
        }
        ctx.drawImage(shade, 0, 0);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
        const cx = l.x * tile + tile / 2, cy = (map.h - 1 - l.y) * tile + tile / 2, rad = l.rad * tile * 0.8;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, 'rgba(255,150,60,0.22)'); g.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = g; ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    // Faint grid so squares stay countable.
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1;
    for (let i = 1; i < map.w; i++) { ctx.beginPath(); ctx.moveTo(i * tile + 0.5, 0); ctx.lineTo(i * tile + 0.5, canvas.height); ctx.stroke(); }
    for (let j = 1; j < map.h; j++) { ctx.beginPath(); ctx.moveTo(0, j * tile + 0.5); ctx.lineTo(canvas.width, j * tile + 0.5); ctx.stroke(); }
    baseCache.set(map, { tile, canvas });
    return canvas;
}

/** Human name of what's on a square, for tooltips and messages. */
export function squareName(map, x, y) {
    const prop = propAt(map, x, y);
    return prop ? (prop.label || PROPS[prop.type]?.name || prop.type) : null;
}
