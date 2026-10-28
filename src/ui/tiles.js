// Map art: every tile and prop is painted in code on a canvas, with a seeded random generator per
// square, so floors never visibly repeat (each slab, plank, tuft and crack is different) and the
// same map always looks the same. Themes set the palette; "areas" (rooms of a generated place)
// give each room its own floor and walls (carpet, parquet, wallpaper, logs...); "roofs" cover town
// buildings. Light sources (torches, braziers, fireplaces, chandeliers, lava) glow through the darkness.

import { terrainAt, propsAt, propAt, PROPS, ORIENTED } from '../core/grid.js';
import { rngFor, between, pick, hsl, tone, speckle, blob, crack, ellipse, rrect, line, shadow } from './paint-kit.js';
import { PROP_ART } from './prop-art.js';
import { fireLights } from '../core/fire.js';

const THEME_STYLE = {
    dungeon: { floor: 'stone', floorC: [30, 6, 38], wall: 'brick', wallC: [25, 7, 28], dark: 0.35, moss: 0.12 },
    crypt: { floor: 'stone', floorC: [235, 8, 34], wall: 'brick', wallC: [240, 8, 24], dark: 0.5, moss: 0.08 },
    cave: { floor: 'rock', floorC: [28, 14, 32], wall: 'rock', wallC: [24, 14, 20], dark: 0.45, moss: 0.06 },
    mine: { floor: 'dirt', floorC: [28, 24, 28], wall: 'rock', wallC: [24, 14, 18], dark: 0.5, moss: 0 },
    sewer: { floor: 'stone', floorC: [90, 10, 28], wall: 'brick', wallC: [80, 10, 22], dark: 0.45, moss: 0.25 },
    castle: { floor: 'flag', floorC: [35, 8, 45], wall: 'stoneblock', wallC: [30, 8, 36], dark: 0.15, moss: 0.03 },
    temple: { floor: 'marble', floorC: [40, 12, 70], wall: 'stoneblock', wallC: [38, 14, 56], dark: 0.1, moss: 0 },
    prison: { floor: 'stone', floorC: [30, 5, 30], wall: 'brick', wallC: [25, 5, 22], dark: 0.45, moss: 0.14, grime: 0.35 },
    tavern: { floor: 'planks', floorC: [28, 40, 30], wall: 'timber', wallC: [35, 22, 50], dark: 0.12, moss: 0 },
    library: { floor: 'parquet', floorC: [22, 40, 26], wall: 'panel', wallC: [24, 35, 18], dark: 0.2, moss: 0 },
    house: { floor: 'planks', floorC: [30, 35, 36], wall: 'timber', wallC: [38, 22, 54], dark: 0.08, moss: 0 },
    mansion: { floor: 'parquet', floorC: [26, 42, 30], wall: 'wallpaper', wallC: [350, 30, 26], dark: 0.3, moss: 0 },
    cabin: { floor: 'planks', floorC: [28, 40, 32], wall: 'log', wallC: [26, 42, 28], dark: 0.15, moss: 0 },
    town: { floor: 'grass', floorC: [100, 32, 32], wall: 'plaster', wallC: [40, 25, 66], dark: 0, moss: 0.02 },
    forest: { floor: 'grass', floorC: [100, 35, 30], wall: 'hedge', wallC: [120, 35, 16], dark: 0.05, moss: 0 },
    jungle: { floor: 'grass', floorC: [112, 44, 24], wall: 'hedge', wallC: [125, 45, 13], dark: 0.12, moss: 0.15 },
    camp: { floor: 'dirt', floorC: [32, 30, 30], wall: 'hedge', wallC: [120, 30, 16], dark: 0.3, moss: 0 },
    swamp: { floor: 'mud', floorC: [70, 25, 20], wall: 'hedge', wallC: [95, 30, 13], dark: 0.2, moss: 0.2 },
    snow: { floor: 'snow', floorC: [210, 30, 88], wall: 'rock', wallC: [215, 10, 45], dark: 0, moss: 0 },
    desert: { floor: 'sand', floorC: [40, 55, 62], wall: 'sandstone', wallC: [32, 45, 48], dark: 0, moss: 0 },
    ship: { floor: 'deck', floorC: [30, 40, 32], wall: 'timber', wallC: [28, 35, 26], dark: 0.05, moss: 0 },
};
/** Colors for floors and walls named in the map or by a room ("area"), so they look right in any theme. */
const MATERIAL = {
    planks: [28, 40, 30], deck: [30, 40, 32], flag: [35, 8, 45], cobble: [30, 8, 46], grass: [100, 35, 30], dirt: [30, 30, 30], mud: [60, 22, 20],
    stone: [30, 6, 38], marble: [40, 12, 70], parquet: [26, 42, 30], carpet: [350, 45, 26], tiles: [40, 10, 72], rock: [28, 14, 32],
};
const WALL_MATERIAL = {
    brick: [25, 7, 28], stoneblock: [30, 8, 36], wallpaper: [350, 30, 26], panel: [24, 35, 18], log: [26, 42, 28], timber: [38, 22, 54],
    plaster: [40, 25, 66], rock: [24, 14, 20], hedge: [120, 35, 16], sandstone: [32, 45, 48],
};
const OUTDOOR = new Set(['forest', 'jungle', 'camp', 'swamp', 'snow', 'desert', 'town']);
/** Terrain that is drawn on top of a floor: its ground comes from the squares around it. */
const OVERLAY = new Set(['T', '+', '/', 'D', '<', '>', 'o', '^', 'I', 'J', 'j']);
const PLAIN = { '.': true, ',': true, ':': true, '_': true, '=': true };

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
        if (st.grime && r() < st.grime) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.25, 0.5), pick(r, ['rgba(40,25,10,0.35)', 'rgba(70,10,10,0.25)', 'rgba(20,30,15,0.3)']));
    },
    flag(ctx, r, x, y, s, st) {
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] - 14); ctx.fillRect(x, y, s, s);
        const cut = between(r, 0.35, 0.65);
        rrect(ctx, x + s * 0.03, y + s * 0.03, s * cut - s * 0.05, s * 0.94, s * 0.05, tone(st.floorC, r, 8));
        rrect(ctx, x + s * cut + s * 0.02, y + s * 0.03, s * (1 - cut) - s * 0.05, s * between(r, 0.4, 0.6), s * 0.05, tone(st.floorC, r, 8));
        rrect(ctx, x + s * cut + s * 0.02, y + s * 0.66, s * (1 - cut) - s * 0.05, s * 0.31, s * 0.05, tone(st.floorC, r, 8));
        speckle(ctx, r, x, y, s, 40);
        if (r() < 0.15) crack(ctx, r, x, y, s);
        if (st.grime && r() < st.grime) blob(ctx, x + r() * s, y + r() * s, s * 0.35, 'rgba(40,25,10,0.3)');
    },
    marble(ctx, r, x, y, s, st, gx, gy) {
        // Big polished slabs in a checker of two tones, with veins.
        const light = (gx + gy) % 2 === 0;
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] + (light ? 4 : -8) + between(r, -2, 2)); ctx.fillRect(x, y, s, s);
        ctx.strokeStyle = 'rgba(90,80,70,0.22)'; ctx.lineWidth = s / 80;
        for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.moveTo(x + r() * s, y); ctx.bezierCurveTo(x + r() * s, y + s * 0.3, x + r() * s, y + s * 0.7, x + r() * s, y + s); ctx.stroke(); }
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x, y, s, s * 0.04);
        ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
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
    parquet(ctx, r, x, y, s, st, gx, gy) {
        // Herringbone: blocks alternate direction square by square.
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] - 12); ctx.fillRect(x, y, s, s);
        const across = (gx + gy) % 2 === 0, n = 4, w = s / n;
        for (let i = 0; i < n; i++) {
            ctx.fillStyle = hsl(st.floorC[0] + between(r, -3, 3), st.floorC[1], st.floorC[2] + between(r, -5, 6));
            if (across) ctx.fillRect(x + 1, y + i * w + 1, s - 2, w - 2); else ctx.fillRect(x + i * w + 1, y + 1, w - 2, s - 2);
        }
        ctx.fillStyle = 'rgba(255,240,210,0.06)'; ctx.fillRect(x, y, s, s * 0.5);
    },
    carpet(ctx, r, x, y, s, st) {
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2]); ctx.fillRect(x, y, s, s);
        // A small repeating motif and a soft pile texture.
        ctx.fillStyle = hsl(st.floorC[0], st.floorC[1], st.floorC[2] + 7);
        for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.75]]) { const cx = x + dx * s, cy = y + dy * s, k = s * 0.09; ctx.beginPath(); ctx.moveTo(cx, cy - k); ctx.lineTo(cx + k, cy); ctx.lineTo(cx, cy + k); ctx.lineTo(cx - k, cy); ctx.fill(); }
        speckle(ctx, r, x, y, s, 50, 0.08, 0.04);
    },
    tiles(ctx, r, x, y, s, st, gx, gy) {
        const n = 2, w = s / n;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const dark = (gx * n + i + gy * n + j) % 2 === 0;
            ctx.fillStyle = dark ? hsl(st.floorC[0], st.floorC[1] + 10, st.floorC[2] - 38) : hsl(st.floorC[0], st.floorC[1], st.floorC[2] + between(r, -3, 3));
            ctx.fillRect(x + i * w, y + j * w, w, w);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; for (let i = 0; i <= n; i++) { line(ctx, x + i * w, y, x + i * w, y + s, 'rgba(0,0,0,0.2)', 1); line(ctx, x, y + i * w, x + s, y + i * w, 'rgba(0,0,0,0.2)', 1); }
        if (r() < 0.15) crack(ctx, r, x, y, s);
    },
    deck(ctx, r, x, y, s, st) {
        FLOOR.planks(ctx, r, x, y, s, st);
        ctx.fillStyle = 'rgba(30,20,10,0.6)';
        for (let i = 0; i < 4; i++) ctx.fillRect(x + s * 0.06, y + (i + 0.5) * s / 4 - 1, 2, 2);
    },
    grass(ctx, r, x, y, s, st, gx = 0, gy = 0) {
        const [h, sat, l] = st.floorC, n = fieldNoise(gx, gy);
        ctx.fillStyle = hsl(h + n * 8 + between(r, -3, 3), sat + n * 6, Math.max(8, l + n * 7 + between(r, -2, 2))); ctx.fillRect(x, y, s, s);
        if (r() < 0.35) for (let i = 0; i < 3; i++) { const lx = x + r() * s, ly = y + r() * s; for (let k = 0; k < 3; k++) ellipse(ctx, lx + Math.cos(k * 2.1) * s * 0.025, ly + Math.sin(k * 2.1) * s * 0.025, s * 0.025, s * 0.025, hsl(h + 10, sat + 10, l + 8, 0.7)); }
        for (let i = 0; i < 4; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.5), r() < 0.5 ? 'rgba(20,40,10,0.2)' : 'rgba(200,220,120,0.10)');
        ctx.lineWidth = s / 90;
        for (let i = 0; i < 46; i++) {
            const bx = x + r() * s, by = y + r() * s, len = between(r, 0.05, 0.11) * s;
            ctx.strokeStyle = hsl(between(r, 85, 120), 45, between(r, 22, 44), 0.8);
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + between(r, -0.03, 0.03) * s, by - len); ctx.stroke();
        }
        if (r() < 0.12) for (let i = 0; i < 4; i++) ellipse(ctx, x + r() * s, y + r() * s, s * 0.018, s * 0.018, pick(r, ['#f4f1e0', '#f5d64a', '#c79be6']));
        if (r() < 0.05) ellipse(ctx, x + r() * s, y + r() * s, s * 0.05, s * 0.035, hsl(30, 6, 50));
    },
    dirt(ctx, r, x, y, s, st) {
        ctx.fillStyle = tone(st.floorC, r, 4); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 4; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.15, 0.4), r() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,230,190,0.07)');
        speckle(ctx, r, x, y, s, 60, 0.18);
        for (let i = 0; i < 4; i++) ellipse(ctx, x + r() * s, y + r() * s, s * between(r, 0.015, 0.035), s * 0.015, 'rgba(140,130,115,0.8)');
        if (r() < 0.25) { ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = s / 40; const ty = y + between(r, 0.2, 0.8) * s; ctx.beginPath(); ctx.moveTo(x, ty); ctx.bezierCurveTo(x + s * 0.3, ty + between(r, -3, 3), x + s * 0.6, ty + between(r, -3, 3), x + s, ty); ctx.stroke(); }
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
        if (r() < 0.12) blob(ctx, x + r() * s, y + r() * s, s * 0.3, 'rgba(30,25,15,0.25)');
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
// Walls are drawn as raised blocks seen from above and a little from the front: a flat top (the
// "cap"), and where open floor lies below, the wall's front face with its texture (bricks,
// wallpaper, logs), shaded darker toward the floor. Sides next to open floor get a dark edge, and
// floors next to walls get a soft cast shadow (see paintMapBase).

/** How much of a square the wall's top takes when its front face shows. */
const CAP = 0.4;

function capColor(st) {
    const c = st.wallC;
    if (['wallpaper', 'panel', 'timber', 'plaster'].includes(st.wall)) return [25, 22, 15];
    if (st.wall === 'log') return [28, 34, 30];
    if (st.wall === 'rock') return [c[0], c[1], c[2] + 6];
    return [c[0], Math.round(c[1] * 0.7), Math.min(c[2] + 6, 46)];
}

/** The flat top of a wall, with lit and shadowed edges where it drops to open floor. */
function wallCap(ctx, r, x, y, s, h, st, open, gx, gy) {
    const [ch, cs, cl] = capColor(st);
    ctx.fillStyle = hsl(ch, cs, cl + between(r, -2, 2)); ctx.fillRect(x, y, s, h);
    if (['wallpaper', 'panel', 'timber', 'plaster', 'log'].includes(st.wall)) {
        // A wooden top: grain along the wall.
        grain(ctx, r, x, y, s, h, Boolean(open.left || open.right) && !open.above, 0.18);
    } else {
        // Coping stones with joints, and a little grit.
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1;
        const vertical = (open.left || open.right) && !open.above && !open.below;
        const step = s / 2, off = ((vertical ? gy : gx) % 2) * step / 2;
        for (let t = off; t < s; t += step) { ctx.beginPath(); if (vertical) { ctx.moveTo(x, y + t); ctx.lineTo(x + s, y + t); } else { ctx.moveTo(x + t, y); ctx.lineTo(x + t, y + h); } ctx.stroke(); }
        speckle(ctx, r, x, y, s, 18, 0.14, 0.06);
    }
    // A slight bevel: the top reads as a raised slab, not a flat panel.
    const b = Math.max(2, s * 0.06);
    if (open.above || open.left) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x, y, s, b); }
    ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fillRect(x, y + h - b, s, b);
    // Light comes from the top left: lit upper edge, dark right and lower edges where the wall drops away.
    if (open.above) { ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(x, y, s, Math.max(2, s * 0.04)); }
    if (open.left) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, y, Math.max(2, s * 0.04), h); }
    if (open.right) {
        const g = ctx.createLinearGradient(x + s * 0.86, 0, x + s, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
        ctx.fillStyle = g; ctx.fillRect(x + s * 0.86, y, s * 0.14, h);
    }
}

/** Outdoors (town house fronts): the flat textured wall with a soft shadow at its foot. */
function flatWall(ctx, r, x, y, s, st, open, gx, gy) {
    wallFace(ctx, r, x, y, s, st, gx, gy);
    if (open.below) {
        const g = ctx.createLinearGradient(0, y + s * 0.62, 0, y + s);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
        ctx.fillStyle = g; ctx.fillRect(x, y + s * 0.62, s, s * 0.38);
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, y, s, s * 0.04);
    }
}

function wall(ctx, r, x, y, s, st, open, gx, gy) {
    const style = st.wall, c = st.wallC;
    if (st.flatWalls && style !== 'hedge') { flatWall(ctx, r, x, y, s, st, open, gx, gy); return; }
    if (style === 'hedge') {
        ctx.fillStyle = hsl(c[0], c[1], c[2] - 4); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 7; i++) { const cx = x + r() * s, cy = y + r() * s, rad = s * between(r, 0.2, 0.36); ellipse(ctx, cx, cy, rad, rad, tone(c, r, 6, 10)); ellipse(ctx, cx - rad * 0.3, cy - rad * 0.3, rad * 0.45, rad * 0.4, 'rgba(255,255,255,0.07)'); }
        if (open.below) { const g = ctx.createLinearGradient(0, y + s * 0.6, 0, y + s); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.4)'); ctx.fillStyle = g; ctx.fillRect(x, y + s * 0.6, s, s * 0.4); }
        return;
    }
    if (!open.below) {
        wallCap(ctx, r, x, y, s, s, st, open, gx, gy);
        return;
    }
    // The front face: the wall's texture on the lower part of the square, darker toward the floor.
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y + s * CAP, s, s * (1 - CAP)); ctx.clip();
    wallFace(ctx, r, x, y, s, st, gx, gy);
    const g = ctx.createLinearGradient(0, y + s * CAP, 0, y + s);
    g.addColorStop(0, 'rgba(0,0,0,0.08)'); g.addColorStop(0.7, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = g; ctx.fillRect(x, y + s * CAP, s, s * (1 - CAP));
    // Corner shading where the face turns away at an open side.
    if (open.right) { const gr = ctx.createLinearGradient(x + s * 0.8, 0, x + s, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.4)'); ctx.fillStyle = gr; ctx.fillRect(x + s * 0.8, y + s * CAP, s * 0.2, s * (1 - CAP)); }
    if (open.left) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x, y + s * CAP, s * 0.05, s * (1 - CAP)); }
    ctx.restore();
    wallCap(ctx, r, x, y, s, s * CAP, st, open, gx, gy);
    // The cap's lip throws a thin shadow on the face; the face meets the floor in a dark line.
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x, y + s * CAP, s, Math.max(2, s * 0.04));
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y + s - Math.max(1.5, s * 0.025), s, Math.max(1.5, s * 0.025));
}

/** The wall's surface texture (bricks, wallpaper, logs...), drawn over the whole square. */
function wallFace(ctx, r, x, y, s, st, gx, gy) {
    const style = st.wall, c = st.wallC;
    if (style === 'rock') {
        ctx.fillStyle = tone(c, r, 3); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 6; i++) {
            ctx.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.22)';
            ctx.beginPath(); const cx = x + r() * s, cy = y + r() * s;
            ctx.moveTo(cx, cy); for (let k = 0; k < 4; k++) ctx.lineTo(cx + between(r, -0.25, 0.25) * s, cy + between(r, -0.25, 0.25) * s); ctx.fill();
        }
        speckle(ctx, r, x, y, s, 50, 0.25);
    } else if (style === 'timber' || style === 'plaster') {
        ctx.fillStyle = tone(c, r, 3); ctx.fillRect(x, y, s, s);
        speckle(ctx, r, x, y, s, 30, 0.08);
        ctx.fillStyle = hsl(25, 40, 18); ctx.fillRect(x, y, s, s * 0.12); ctx.fillRect(x, y + s * 0.88, s, s * 0.12);
        if (style === 'timber' && r() < 0.5) { ctx.save(); ctx.translate(x + s / 2, y + s / 2); ctx.rotate(r() < 0.5 ? 0.78 : -0.78); ctx.fillRect(-s * 0.7, -s * 0.05, s * 1.4, s * 0.1); ctx.restore(); }
    } else if (style === 'log') {
        // Stacked round logs with dark gaps and chinking.
        ctx.fillStyle = hsl(c[0], c[1] - 10, c[2] - 16); ctx.fillRect(x, y, s, s);
        const n = 3, h = s / n;
        for (let i = 0; i < n; i++) {
            const py = y + i * h;
            const g = ctx.createLinearGradient(0, py, 0, py + h);
            const l = c[2] + between(r, -4, 4);
            g.addColorStop(0, hsl(c[0], c[1], l + 10)); g.addColorStop(0.5, hsl(c[0], c[1], l)); g.addColorStop(1, hsl(c[0], c[1], l - 12));
            ctx.fillStyle = g; ctx.fillRect(x, py + 1, s, h - 2);
            grain(ctx, r, x, py + 2, s, h - 4);
            if ((gx + i) % 5 === 0) { ellipse(ctx, x + s * 0.5, py + h / 2, h * 0.35, h * 0.42, hsl(32, 40, 52)); ellipse(ctx, x + s * 0.5, py + h / 2, h * 0.16, h * 0.2, null, 'rgba(90,50,20,0.6)', 1); }
        }
    } else if (style === 'wallpaper') {
        // Patterned paper above a dark wainscot and a picture rail.
        ctx.fillStyle = hsl(c[0], c[1], c[2]); ctx.fillRect(x, y, s, s);
        const stripes = 4, w = s / stripes;
        for (let i = 0; i < stripes; i++) if ((gx * stripes + i) % 2 === 0) { ctx.fillStyle = hsl(c[0], c[1], c[2] + 6); ctx.fillRect(x + i * w, y, w, s); }
        for (let i = 0; i < stripes; i++) { const cx = x + (i + 0.5) * w, cy = y + s * 0.3; ctx.fillStyle = hsl(42, 45, c[2] + 18, 0.45); ctx.beginPath(); ctx.moveTo(cx, cy - w * 0.3); ctx.lineTo(cx + w * 0.22, cy); ctx.lineTo(cx, cy + w * 0.3); ctx.lineTo(cx - w * 0.22, cy); ctx.fill(); }
        ctx.fillStyle = hsl(25, 40, 14); ctx.fillRect(x, y + s * 0.55, s, s * 0.45);
        ctx.fillStyle = hsl(42, 50, 40); ctx.fillRect(x, y + s * 0.53, s, s * 0.04);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.strokeRect(x + s * 0.12, y + s * 0.64, s * 0.76, s * 0.26);
    } else if (style === 'panel') {
        ctx.fillStyle = hsl(c[0], c[1], c[2]); ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 2; i++) { const px = x + s * 0.08 + i * s * 0.46; rrect(ctx, px, y + s * 0.1, s * 0.38, s * 0.8, 2, hsl(c[0], c[1], c[2] + between(r, 2, 7)), 'rgba(0,0,0,0.45)', 1.5); grain(ctx, r, px + 2, y + s * 0.12, s * 0.34, s * 0.76, true, 0.1); }
        ctx.fillStyle = hsl(42, 45, 34); ctx.fillRect(x, y, s, s * 0.05);
    } else {
        // brick / sandstone / castle stone blocks
        const big = style === 'stoneblock';
        ctx.fillStyle = hsl(c[0], c[1], c[2] - 10); ctx.fillRect(x, y, s, s);
        const rows = style === 'sandstone' ? 3 : big ? 2 : 4, bh = s / rows;
        for (let j = 0; j < rows; j++) {
            const off = ((j + gy) % 2) * s / 4 - s / 4;
            for (let i = -1; i < 3; i++) {
                const bx = x + off + i * s / 2 + s * 0.015, bw = s / 2 - s * 0.03;
                const cx0 = Math.max(x, bx), cx1 = Math.min(x + s, bx + bw);
                if (cx1 > cx0) { ctx.fillStyle = tone(c, r, big ? 5 : 6, 5); ctx.fillRect(cx0, y + j * bh + s * 0.015, cx1 - cx0, bh - s * 0.03); if (big) { ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(cx0, y + j * bh + s * 0.015, cx1 - cx0, s * 0.03); } }
            }
        }
        speckle(ctx, r, x, y, s, 35, 0.15);
        if (st.moss && r() < st.moss) blob(ctx, x + r() * s, y + s, s * 0.35, 'rgba(60,100,40,0.35)');
        if (st.grime && r() < st.grime * 0.5) blob(ctx, x + r() * s, y + s * 0.8, s * 0.3, 'rgba(60,10,5,0.3)');
    }
}
function grain(ctx, r, x, y, w, h, vertical = false, alpha = 0.16) {
    ctx.strokeStyle = `rgba(0,0,0,${alpha})`; ctx.lineWidth = 1;
    const n = Math.max(2, Math.round((vertical ? w : h) / 5));
    for (let i = 1; i < n; i++) { ctx.beginPath(); if (vertical) { const gx = x + (i / n) * w; ctx.moveTo(gx, y); ctx.lineTo(gx + between(r, -1.5, 1.5), y + h); } else { const gy = y + (i / n) * h; ctx.moveTo(x, gy); ctx.lineTo(x + w, gy + between(r, -1.5, 1.5)); } ctx.stroke(); }
}

// ---------- special terrain ----------
function water(ctx, r, x, y, s, deep) {
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, deep ? hsl(212, 55, 22) : hsl(195, 45, 38)); g.addColorStop(1, deep ? hsl(220, 60, 16) : hsl(200, 50, 30));
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = `rgba(255,255,255,${deep ? 0.08 : 0.16})`; ctx.lineWidth = s / 70;
    for (let i = 0; i < 4; i++) { const cx = x + r() * s, cy = y + r() * s; ctx.beginPath(); ctx.arc(cx, cy, s * between(r, 0.06, 0.14), Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    if (!deep && r() < 0.3) ellipse(ctx, x + r() * s, y + r() * s, s * 0.04, s * 0.03, 'rgba(120,110,100,0.5)');
    if (!deep && r() < 0.15) { ellipse(ctx, x + r() * s, y + r() * s, s * 0.1, s * 0.08, 'rgba(70,120,50,0.8)'); }
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
/** Low-frequency noise over the map (0-1 smooth, -1..1), so grass has soft patches across squares. */
function fieldNoise(x, y) {
    const v = (a, b) => { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; };
    const sx = x / 5, sy = y / 5, ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const a = v(ix, iy) * (1 - u) + v(ix + 1, iy) * u, b = v(ix, iy + 1) * (1 - u) + v(ix + 1, iy + 1) * u;
    return a * (1 - w) + b * w;
}

/** A tree on its square, by the land: round leafy trees and pines in a forest, palms and broadleaf canopy in a jungle, drooping willows in a swamp, snowy pines in snow, palms in a desert. */
function tree(ctx, r, x, y, s, theme = 'forest') {
    const cx = x + s / 2, cy = y + s / 2;
    const kind = theme === 'jungle' ? pick(r, ['broad', 'broad', 'broad', 'broad', 'broad', 'palm']) : theme === 'snow' ? 'pine' : theme === 'desert' ? 'palm' : theme === 'swamp' ? pick(r, ['willow', 'willow', 'round']) : pick(r, ['round', 'round', 'pine']);
    if (kind === 'palm') return PROP_ART.palm(ctx, r, cx, cy, s);
    if (kind === 'pine') {
        shadow(ctx, cx + s * 0.12, cy + s * 0.16, s * 0.44, s * 0.3);
        for (let i = 0; i < 3; i++) {
            const rad = s * (0.46 - i * 0.12), pts = [];
            for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, rr = k % 2 ? rad * 0.62 : rad; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
            ctx.beginPath(); pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
            ctx.fillStyle = hsl(140 + between(r, -8, 8), 35, 16 + i * 6); ctx.fill();
        }
        if (theme === 'snow') for (let i = 0; i < 6; i++) ellipse(ctx, cx + between(r, -0.25, 0.25) * s, cy + between(r, -0.25, 0.25) * s, s * 0.07, s * 0.05, 'rgba(240,245,255,0.85)');
        return;
    }
    if (kind === 'willow') {
        shadow(ctx, cx + s * 0.12, cy + s * 0.16, s * 0.52, s * 0.36);
        for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; ctx.strokeStyle = hsl(85, 30, between(r, 22, 34)); ctx.lineWidth = s / 14; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.2, cx + Math.cos(a) * s * 0.48, cy + Math.sin(a) * s * 0.48); ctx.stroke(); }
        ellipse(ctx, cx, cy, s * 0.22, s * 0.22, hsl(88, 30, 26));
        return;
    }
    shadow(ctx, cx + s * 0.12, cy + s * 0.16, s * 0.5, s * 0.34);
    ellipse(ctx, cx, cy + s * 0.05, s * 0.08, s * 0.08, '#4a3020');
    if (kind === 'broad') {
        // Jungle canopy: big, dark, glossy leaves layered over each other.
        for (let i = 0; i < 11; i++) { const a = r() * Math.PI * 2, d = s * between(r, 0.1, 0.36), rad = s * between(r, 0.26, 0.42); ellipse(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rad, rad * 0.85, hsl(between(r, 110, 140), 50, between(r, 13, 25))); }
        for (let i = 0; i < 6; i++) ellipse(ctx, cx + between(r, -0.3, 0.2) * s, cy + between(r, -0.3, 0.2) * s, s * 0.1, s * 0.06, 'rgba(180,255,150,0.14)');
        if (r() < 0.25) for (let i = 0; i < 3; i++) ellipse(ctx, cx + between(r, -0.3, 0.3) * s, cy + between(r, -0.3, 0.3) * s, s * 0.035, s * 0.035, pick(r, ['#ff5d8f', '#ffb347', '#f5f05a']));
        return;
    }
    const hue = between(r, 95, 130);
    for (let i = 0; i < 9; i++) { const a = r() * Math.PI * 2, d = s * between(r, 0.06, 0.3), rad = s * between(r, 0.22, 0.38); ellipse(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rad, rad, hsl(hue + between(r, -10, 10), 40, between(r, 18, 30))); }
    for (let i = 0; i < 4; i++) ellipse(ctx, cx - s * between(r, 0.02, 0.2), cy - s * between(r, 0.02, 0.2), s * 0.1, s * 0.08, 'rgba(200,255,150,0.10)');
}
function pillarTile(ctx, r, x, y, s) { PROP_ART.pillar(ctx, r, x + s / 2, y + s / 2, s); }
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
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x + s * 0.08, y, s * 0.06, s); ctx.fillRect(x + s * 0.86, y, s * 0.06, s);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = `${s * 0.32}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(up ? '▲' : '▼', x + s / 2, y + s / 2);
}
/** Water colours by setting: [shallow, mid, deep] as [r, g, b]. */
const WATER_TINTS = {
    jungle: [[70, 190, 175], [30, 135, 140], [16, 70, 95]],
    desert: [[90, 205, 200], [35, 150, 170], [20, 80, 120]],
    swamp: [[70, 112, 88], [42, 80, 64], [22, 48, 40]],
    snow: [[175, 215, 235], [110, 165, 205], [55, 95, 150]],
    sewer: [[80, 95, 70], [55, 68, 50], [32, 40, 30]],
    cave: [[60, 120, 140], [30, 75, 105], [14, 38, 68]],
    default: [[80, 170, 190], [40, 115, 160], [18, 52, 108]],
};

/**
 * All the water on the map in one go, so it looks like water and not tiles: shallows near the shore
 * shading to deep in the middle (a smooth colour field from each square's distance to land), soft
 * rounded edges, a damp darker bank on the land around it, foam along the shore, and ripples, glints
 * and the light-web of caustics in the shallows. Bridges count as water (it flows under them).
 */
function paintWater(ctx, map, tile, at) {
    const W = map.w, H = map.h;
    const wet = ch => ch === '~' || ch === 'w' || ch === 'b';
    const tiles = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (wet(at(x, y)) && (at(x, y) !== 'b' || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) === '~' || at(x + dx, y + dy) === 'w'))) tiles.push([x, y]);
    if (!tiles.length) return;
    const isWater = new Set(tiles.map(([x, y]) => y * W + x));
    // How far each square is from land (0 = on the shore).
    const depth = new Map();
    const queue = [];
    for (const [x, y] of tiles) if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !isWater.has((y + dy) * W + x + dx) && at(x + dx, y + dy) !== '%')) { depth.set(y * W + x, 0); queue.push([x, y]); }
    for (let qi = 0; qi < queue.length; qi++) {
        const [x, y] = queue[qi], d = depth.get(y * W + x);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = (y + dy) * W + x + dx; if (isWater.has(k) && !depth.has(k)) { depth.set(k, d + 1); queue.push([x + dx, y + dy]); } }
    }
    const tint = WATER_TINTS[map.theme] ?? WATER_TINTS.default;
    const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const colorAt = (x, y) => {
        let d = depth.get(y * W + x) ?? 3;
        if (at(x, y) === 'w') d = Math.max(d, 2);
        return d <= 0 ? tint[0] : d === 1 ? mixc(tint[0], tint[1], 0.7) : d === 2 ? mixc(tint[1], tint[2], 0.5) : tint[2];
    };
    // A colour field, one pixel a square, smoothed up to full size.
    const field = document.createElement('canvas'); field.width = W; field.height = H;
    const fctx = field.getContext('2d'), img = fctx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = ((H - 1 - y) * W + x) * 4, c = isWater.has(y * W + x) ? colorAt(x, y) : tint[0]; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255; }
    fctx.putImageData(img, 0, 0);
    // The shape of the water, a few pixels a square, softened into rounded edges.
    const k = 4, maskSmall = document.createElement('canvas'); maskSmall.width = W * k; maskSmall.height = H * k;
    const ms = maskSmall.getContext('2d'); ms.fillStyle = '#fff';
    for (const [x, y] of tiles) ms.fillRect(x * k, (H - 1 - y) * k, k, k);
    const full = (blur, src) => { const cv = document.createElement('canvas'); cv.width = W * tile; cv.height = H * tile; const c = cv.getContext('2d'); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.filter = `blur(${blur}px)`; c.drawImage(src, 0, 0, W * tile, H * tile); c.filter = 'none'; return cv; };
    // A damp, darker bank on the land around the water.
    const bank = full(tile * 0.45, maskSmall), bctx = bank.getContext('2d');
    bctx.globalCompositeOperation = 'source-in'; bctx.fillStyle = map.theme === 'snow' ? 'rgba(120,140,160,0.45)' : 'rgba(38,30,16,0.5)'; bctx.fillRect(0, 0, bank.width, bank.height);
    ctx.drawImage(bank, 0, 0);
    // The water itself: the smooth colour field, cut to the soft shape.
    const water = full(tile * 0.7, field), wctx = water.getContext('2d');
    const shape = full(tile * 0.45, maskSmall);
    wctx.globalCompositeOperation = 'destination-in'; wctx.drawImage(shape, 0, 0);
    ctx.drawImage(water, 0, 0);
    // On the surface: caustics in the shallows, ripples, glints, foam along the shore.
    ctx.save();
    ctx.beginPath(); for (const [x, y] of tiles) ctx.rect(x * tile, (H - 1 - y) * tile, tile, tile); ctx.clip();
    for (const [x, y] of tiles) {
        const r = rngFor(map.seed, x, y, 77), px = x * tile, py = (H - 1 - y) * tile, d = depth.get(y * W + x) ?? 3;
        if (d <= 1 && map.theme !== 'swamp') {
            ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = Math.max(1, tile / 40);
            for (let i = 0; i < 3; i++) { ctx.beginPath(); const sx = px + r() * tile, sy = py + r() * tile; ctx.moveTo(sx, sy); ctx.bezierCurveTo(sx + between(r, -0.3, 0.3) * tile, sy + between(r, -0.3, 0.3) * tile, sx + between(r, -0.3, 0.3) * tile, sy + between(r, -0.3, 0.3) * tile, sx + between(r, -0.4, 0.4) * tile, sy + between(r, -0.4, 0.4) * tile); ctx.stroke(); }
        }
        ctx.strokeStyle = `rgba(255,255,255,${d >= 2 ? 0.07 : 0.13})`; ctx.lineWidth = Math.max(1, tile / 50);
        for (let i = 0; i < 2; i++) { const cx = px + r() * tile, cy = py + r() * tile; ctx.beginPath(); ctx.arc(cx, cy, tile * between(r, 0.08, 0.16), Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
        if (r() < 0.18) ellipse(ctx, px + r() * tile, py + r() * tile, tile * 0.05, tile * 0.012, 'rgba(255,255,255,0.35)');
        // Foam where the water meets the shore.
        if (d === 0 && map.theme !== 'swamp') {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (isWater.has((y + dy) * W + x + dx)) continue;
                ctx.strokeStyle = 'rgba(240,250,255,0.32)'; ctx.lineWidth = Math.max(1.2, tile / 28);
                ctx.beginPath();
                for (let i = 0; i <= 4; i++) {
                    const t = i / 4, wob = Math.sin(t * 6 + x + y) * tile * 0.04;
                    const fx = dx ? px + (dx > 0 ? tile * 0.86 : tile * 0.14) + wob : px + t * tile;
                    const fy = dy ? py + (dy > 0 ? tile * 0.14 : tile * 0.86) + wob : py + t * tile;
                    if (i) ctx.lineTo(fx, fy); else ctx.moveTo(fx, fy);
                }
                ctx.stroke();
            }
        }
    }
    ctx.restore();
}

/** Dirt trails as soft, winding paths (not one-square steps): a blurred shape filled with earth, worn lighter down the middle. */
function paintTrails(ctx, map, tile, trails) {
    if (!trails.length) return;
    const W = map.w, H = map.h, k = 4;
    const small = document.createElement('canvas'); small.width = W * k; small.height = H * k;
    const sc = small.getContext('2d'); sc.fillStyle = '#fff';
    for (const [x, y] of trails) sc.fillRect(x * k, (H - 1 - y) * k, k, k);
    const soft = (blur, color) => { const cv = document.createElement('canvas'); cv.width = W * tile; cv.height = H * tile; const c = cv.getContext('2d'); c.imageSmoothingEnabled = true; c.filter = `blur(${blur}px)`; c.drawImage(small, 0, 0, W * tile, H * tile); c.filter = 'none'; c.globalCompositeOperation = 'source-in'; c.fillStyle = color; c.fillRect(0, 0, cv.width, cv.height); return cv; };
    const earth = map.theme === 'snow' ? 'rgba(150,140,130,0.85)' : map.theme === 'desert' ? 'rgba(170,135,90,0.85)' : map.theme === 'swamp' ? 'rgba(70,55,35,0.85)' : 'rgba(110,80,50,0.88)';
    ctx.drawImage(soft(tile * 0.28, earth), 0, 0);
    ctx.drawImage(soft(tile * 0.6, 'rgba(255,230,190,0.08)'), 0, 0);
    for (const [x, y] of trails) { const r = rngFor(map.seed, x, y, 13); for (let i = 0; i < 5; i++) ellipse(ctx, x * tile + r() * tile, (H - 1 - y) * tile + r() * tile, tile * 0.025, tile * 0.02, `rgba(${r() < 0.5 ? '40,30,20' : '200,180,150'},0.35)`); }
}

/** Planks over water (or a drop): the deck only. */
function bridgeDeck(ctx, r, x, y, s, horizontal) {
    ctx.save(); ctx.translate(x + s / 2, y + s / 2); if (!horizontal) ctx.rotate(Math.PI / 2);
    shadow(ctx, s * 0.06, s * 0.08, s * 0.5, s * 0.34);
    for (let i = 0; i < 5; i++) { ctx.fillStyle = hsl(28, 35, between(r, 26, 36)); ctx.fillRect(-s / 2 + i * s / 5 + 1, -s * 0.3, s / 5 - 2, s * 0.6); }
    ctx.fillStyle = hsl(28, 30, 20); ctx.fillRect(-s / 2, -s * 0.33, s, s * 0.04); ctx.fillRect(-s / 2, s * 0.29, s, s * 0.04);
    ctx.restore();
}

function bridge(ctx, r, x, y, s, horizontal, overWater = true) {
    if (overWater) water(ctx, r, x, y, s, true);
    else { ctx.fillStyle = '#060606'; ctx.fillRect(x, y, s, s); blob(ctx, x + s / 2, y + s / 2, s * 0.7, 'rgba(255,120,40,0.12)'); }
    ctx.save(); ctx.translate(x + s / 2, y + s / 2); if (!horizontal) ctx.rotate(Math.PI / 2);
    for (let i = 0; i < 5; i++) { ctx.fillStyle = hsl(28, 35, between(r, 26, 36)); ctx.fillRect(-s / 2 + i * s / 5 + 1, -s * 0.3, s / 5 - 2, s * 0.6); }
    ctx.fillStyle = hsl(28, 30, 20); ctx.fillRect(-s / 2, -s * 0.33, s, s * 0.04); ctx.fillRect(-s / 2, s * 0.29, s, s * 0.04);
    ctx.restore();
}
/** A window: glass, barred (iron bars over the glass), or broken (an empty frame with shards). */
function windowTile(ctx, r, x, y, s, st, horizontal, gx, gy, open, kind = 'glass') {
    wall(ctx, r, x, y, s, st, open, gx, gy);
    ctx.save();
    // On a raised wall the glass sits in the front face, below the wall's top.
    const faceY = !st.flatWalls && open.below ? s * (CAP + (1 - CAP) / 2) - s / 2 : 0;
    ctx.translate(x + s / 2, y + s / 2 + (horizontal ? faceY : 0)); if (!horizontal) ctx.rotate(Math.PI / 2);
    const frame = hsl(25, 30, 16);
    if (kind === 'broken') {
        rrect(ctx, -s * 0.36, -s * 0.12, s * 0.72, s * 0.24, 1, 'rgba(10,12,18,0.85)', frame, s / 20);
        ctx.fillStyle = 'rgba(190,220,240,0.7)';
        for (const [sx, dir] of [[-0.34, 1], [0.34, -1]]) { ctx.beginPath(); ctx.moveTo(sx * s, -s * 0.1); ctx.lineTo((sx + dir * 0.12) * s, -s * 0.1); ctx.lineTo(sx * s, s * 0.06); ctx.fill(); }
        for (let i = 0; i < 5; i++) ellipse(ctx, between(r, -0.4, 0.4) * s, s * between(r, 0.18, 0.4), s * 0.025, s * 0.015, 'rgba(200,230,250,0.75)');
    } else {
        rrect(ctx, -s * 0.36, -s * 0.12, s * 0.72, s * 0.24, 1, 'rgba(160,200,230,0.75)', frame, s / 20);
        line(ctx, 0, -s * 0.12, 0, s * 0.12, frame, s / 28);
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-s * 0.3, -s * 0.09, s * 0.12, s * 0.05);
        if (kind === 'barred') {
            for (let i = -3; i <= 3; i++) { line(ctx, i * s * 0.1, -s * 0.16, i * s * 0.1, s * 0.16, '#2a2c30', s / 16); line(ctx, i * s * 0.1 - 1, -s * 0.16, i * s * 0.1 - 1, s * 0.16, 'rgba(255,255,255,0.2)', 1); }
            line(ctx, -s * 0.38, 0, s * 0.38, 0, '#2a2c30', s / 18);
        }
    }
    ctx.restore();
}
/**
 * Iron bars along a wall line (a cell front), or a barred cell door. Drawn like the walls (standing
 * up off the floor): a row of tall bars between a top and a bottom rail, the floor showing through.
 * A cell door has a heavier frame and a lock box (gold when locked).
 */
function ironBars(ctx, x, y, s, horizontal, kind) {
    const iron = '#26282e', mid = '#3d4049', shine = 'rgba(220,225,240,0.6)';
    const door = kind !== 'bars';
    ctx.save();
    if (horizontal) {
        // A fence seen from the front: rails top and bottom, bars between.
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x, y + s * 0.82, s, s * 0.14);
        const bars = door ? 5 : 6, bw = Math.max(2, s * 0.075);
        for (let i = 0; i < bars; i++) {
            const bx = x + s * (0.5 + i) / bars - bw / 2;
            ctx.fillStyle = iron; ctx.fillRect(bx, y + s * 0.06, bw, s * 0.82);
            ctx.fillStyle = shine; ctx.fillRect(bx, y + s * 0.06, Math.max(1, bw * 0.3), s * 0.82);
        }
        ctx.fillStyle = mid; ctx.fillRect(x, y + s * 0.02, s, s * 0.09); ctx.fillRect(x, y + s * 0.8, s, s * 0.09);
        ctx.fillStyle = shine; ctx.fillRect(x, y + s * 0.02, s, 1);
        if (door) {
            ctx.fillStyle = '#17181c'; ctx.fillRect(x, y, s * 0.1, s * 0.92); ctx.fillRect(x + s * 0.9, y, s * 0.1, s * 0.92);
            ctx.fillStyle = kind === 'locked' ? '#c9a227' : '#8a8d95';
            ctx.fillRect(x + s * 0.38, y + s * 0.38, s * 0.24, s * 0.2);
            ctx.fillStyle = '#17181c'; ctx.fillRect(x + s * 0.48, y + s * 0.43, s * 0.04, s * 0.1);
        }
    } else {
        // Running up and down the map: a thick rail with the bars' tops seen from above.
        const cx = x + s / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(cx - s * 0.04, y, s * 0.2, s);
        ctx.fillStyle = mid; ctx.fillRect(cx - s * 0.1, y, s * 0.2, s);
        const bars = door ? 4 : 5;
        for (let i = 0; i < bars; i++) {
            const by = y + s * (0.5 + i) / bars;
            ctx.fillStyle = iron; ctx.beginPath(); ctx.arc(cx, by, s * 0.085, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = shine; ctx.beginPath(); ctx.arc(cx - s * 0.025, by - s * 0.025, s * 0.025, 0, Math.PI * 2); ctx.fill();
        }
        if (door) {
            ctx.fillStyle = '#17181c'; ctx.fillRect(cx - s * 0.13, y, s * 0.26, s * 0.1); ctx.fillRect(cx - s * 0.13, y + s * 0.9, s * 0.26, s * 0.1);
            ctx.fillStyle = kind === 'locked' ? '#c9a227' : '#8a8d95';
            ctx.fillRect(cx + s * 0.08, y + s * 0.4, s * 0.2, s * 0.2);
        }
    }
    ctx.restore();
}
/** A burnt-out square: blackened wall, or a floor of charcoal, soot and ash. */
function charred(ctx, r, x, y, s, isWallTile) {
    if (isWallTile) {
        ctx.fillStyle = 'rgba(14,9,6,0.62)'; ctx.fillRect(x, y, s, s);
        for (let i = 0; i < 3; i++) crack(ctx, r, x, y, s);
        return;
    }
    ctx.fillStyle = 'rgba(20,15,12,0.8)'; ctx.fillRect(x, y, s, s);
    // Charred boards or slabs: dark ridges with breaks.
    for (let i = 1; i < 4; i++) {
        const ly = y + (i / 4) * s + between(r, -1.5, 1.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = Math.max(1, s / 40);
        ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + s * between(r, 0.3, 0.7), ly + between(r, -1, 1)); ctx.moveTo(x + s * between(r, 0.75, 0.85), ly); ctx.lineTo(x + s, ly + between(r, -1, 1)); ctx.stroke();
    }
    for (let i = 0; i < 3; i++) blob(ctx, x + r() * s, y + r() * s, s * between(r, 0.2, 0.4), 'rgba(0,0,0,0.35)');
    for (let i = 0; i < 22; i++) { ctx.fillStyle = `rgba(${Math.round(between(r, 120, 175))},${Math.round(between(r, 115, 165))},${Math.round(between(r, 110, 155))},${between(r, 0.18, 0.45)})`; ctx.fillRect(x + r() * s, y + r() * s, s * 0.025, s * 0.025); }
    if (r() < 0.25) { ctx.fillStyle = 'rgba(170,60,20,0.45)'; ctx.fillRect(x + r() * s, y + r() * s, s * 0.03, s * 0.03); }
}

function voidTile(ctx, r, x, y, s) {
    ctx.fillStyle = hsl(220, 14, 7); ctx.fillRect(x, y, s, s);
    speckle(ctx, r, x, y, s, 14, 0.2, 0.03);
}

// ---------- roofs (town buildings) ----------
// ---------- roofs with shape: hipped wings, cone towers, half-domes, battlements, porticos ----------

/** Shingle (or slate) rows across a polygon, darker or lighter for the way the face slopes. */
function roofFace(ctx, r, points, base, dl, tile, vertical, style) {
    ctx.save();
    ctx.beginPath(); points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = hsl(base[0], base[1], base[2] + dl); ctx.fill();
    ctx.clip();
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const row = tile * (style === 'thatch' ? 0.18 : 0.22);
    if (!vertical) {
        for (let y = y0; y < y1; y += row) {
            const off = Math.round((y - y0) / row) % 2 ? row * 0.6 : 0;
            for (let x = x0 - off; x < x1; x += row * 1.2) { ctx.fillStyle = hsl(base[0] + between(r, -3, 3), base[1], base[2] + dl + between(r, -5, 5)); ctx.fillRect(x + 1, y + 1, row * 1.2 - 2, row - 2); }
            line(ctx, x0, y, x1, y, 'rgba(0,0,0,0.22)', 1);
        }
    } else {
        for (let x = x0; x < x1; x += row) {
            const off = Math.round((x - x0) / row) % 2 ? row * 0.6 : 0;
            for (let y = y0 - off; y < y1; y += row * 1.2) { ctx.fillStyle = hsl(base[0] + between(r, -3, 3), base[1], base[2] + dl + between(r, -5, 5)); ctx.fillRect(x + 1, y + 1, row - 2, row * 1.2 - 2); }
            line(ctx, x, y0, x, y1, 'rgba(0,0,0,0.22)', 1);
        }
    }
    ctx.restore();
}

/** A hipped roof: slopes on all four sides, a short ridge along the long way (a pyramid when square). */
function hipRoof(ctx, r, rf, px, py, w, h, base, tile) {
    const along = w >= h;
    const inset = (along ? h : w) / 2;
    const cx = px + w / 2, cy = py + h / 2;
    const ra = along ? [px + inset, cy] : [cx, py + inset], rb = along ? [px + w - inset, cy] : [cx, py + h - inset];
    const tl = [px, py], tr = [px + w, py], bl = [px, py + h], br = [px + w, py + h];
    const faces = along
        ? [[[tl, tr, rb, ra], 8, false], [[bl, br, rb, ra], -10, false], [[tl, bl, ra], 0, true], [[tr, br, rb], -4, true]]
        : [[[tl, bl, rb, ra], 8, true], [[tr, br, rb, ra], -10, true], [[tl, tr, ra], 2, false], [[bl, br, rb], -8, false]];
    for (const [pts, dl, vertical] of faces) roofFace(ctx, r, pts, base, dl, tile, vertical, rf.style);
    // Hips and ridge.
    ctx.strokeStyle = hsl(base[0], base[1], base[2] - 18); ctx.lineWidth = Math.max(2, tile / 14);
    ctx.beginPath(); ctx.moveTo(...tl); ctx.lineTo(...ra); ctx.lineTo(...rb); ctx.lineTo(...br); ctx.moveTo(...tr); ctx.lineTo(...(along ? rb : ra)); ctx.moveTo(...bl); ctx.lineTo(...(along ? ra : rb)); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
}

/** A round tower's cone (or, with half: true, the half-dome over a round front): segments meeting at a finial. */
function coneRoof(ctx, r, rf, px, py, w, h, base, tile, half = false) {
    const up = half && rf.up;
    const cx = px + w / 2, cy = half ? (up ? py + h : py) : py + h / 2, rad = half ? Math.min(w / 2, h) : Math.min(w, h) / 2;
    const n = half ? 8 : 12;
    const a0 = half ? (up ? Math.PI : 0) : -Math.PI / 2, span = half ? Math.PI : Math.PI * 2;
    for (let i = 0; i < n; i++) {
        const a = a0 + span * i / n, b = a0 + span * (i + 1) / n;
        const light = Math.cos((a + b) / 2 + Math.PI * 0.75);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rad, a, b); ctx.closePath();
        ctx.fillStyle = hsl(base[0], base[1], base[2] + light * 10 + between(r, -2, 2)); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
    }
    // Rings of shingles.
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, rad * k / 4, a0, a0 + span); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, rad - 1, a0, a0 + span); if (half) ctx.closePath(); ctx.stroke();
    ellipse(ctx, cx, cy, tile * 0.1, tile * 0.1, hsl(45, 60, 55), hsl(45, 60, 25), 1);
}

/** The top of a castle wall or tower: a stone walkway behind a row of merlons. */
function battlementRoof(ctx, r, rf, px, py, w, h, tile) {
    ctx.fillStyle = hsl(30, 6, 46); ctx.fillRect(px, py, w, h);
    // Flagstones on the walk.
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1;
    for (let x = px; x < px + w; x += tile * 0.5) { ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x, py + h); ctx.stroke(); }
    for (let y = py; y < py + h; y += tile * 0.5) { ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px + w, y); ctx.stroke(); }
    // Merlons all round the edge.
    const m = tile * 0.26;
    ctx.fillStyle = hsl(30, 6, 62); ctx.strokeStyle = hsl(30, 6, 26); ctx.lineWidth = 1;
    for (let x = px; x < px + w - m / 2; x += m * 2) for (const y of [py, py + h - m]) { ctx.fillRect(x, y, m, m); ctx.strokeRect(x + 0.5, y + 0.5, m - 1, m - 1); }
    for (let y = py + m * 2; y < py + h - m * 2; y += m * 2) for (const x of [px, px + w - m]) { ctx.fillRect(x, y, m, m); ctx.strokeRect(x + 0.5, y + 0.5, m - 1, m - 1); }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
}

/** A wooden porch roof: planks with a darker edge. */
function porchRoof(ctx, r, rf, px, py, w, h, tile) {
    rrect(ctx, px, py, w, h, 2, hsl(28, 38, 36), hsl(28, 40, 16), 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
    for (let x = px + tile * 0.25; x < px + w; x += tile * 0.25) { ctx.beginPath(); ctx.moveTo(x, py + 2); ctx.lineTo(x, py + h - 2); ctx.stroke(); }
}

/** A portico: a pale stone roof on columns over the front door, with a pediment line. */
function porticoRoof(ctx, r, rf, px, py, w, h, tile) {
    rrect(ctx, px, py, w, h, 2, hsl(40, 14, 78), hsl(40, 10, 40), 2);
    ctx.strokeStyle = hsl(40, 10, 55); ctx.lineWidth = Math.max(1.5, tile / 20);
    ctx.beginPath(); ctx.moveTo(px + tile * 0.2, py + h - tile * 0.2); ctx.lineTo(px + w / 2, py + tile * 0.2); ctx.lineTo(px + w - tile * 0.2, py + h - tile * 0.2); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(px, py + h - tile * 0.12, w, tile * 0.12);
}

function roof(ctx, rf, tile, mapH, seed) {
    const r = rngFor(seed, rf.x, rf.y, 91);
    const px = rf.x * tile, py = (mapH - rf.y - rf.h) * tile, w = rf.w * tile, h = rf.h * tile;
    const ridgeAlong = rf.ridge ?? (rf.w >= rf.h ? 'h' : 'v');
    const hue = rf.hue ?? pick(r, [8, 18, 25, 200, 30, 350]);
    const base = rf.style === 'thatch' ? [40, 45, 42] : rf.style === 'slate' ? [215, 12, 30] : [hue, rf.sat ?? 38, rf.light ?? 34];
    // Shadow on the ground (the sun is up-left).
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    if (rf.shape === 'cone') { ctx.beginPath(); ctx.arc(px + w / 2 + tile * 0.18, py + h / 2 + tile * 0.22, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (rf.shape !== 'apse') ctx.fillRect(px + tile * 0.18, py + tile * 0.22, w, h);
    // Shaped roofs: hipped wings, round towers, half-domes over round fronts, castle walls, porticos.
    if (rf.shape === 'hip') return hipRoof(ctx, r, rf, px, py, w, h, base, tile);
    if (rf.shape === 'cone') return coneRoof(ctx, r, rf, px, py, w, h, base, tile);
    if (rf.shape === 'apse') return coneRoof(ctx, r, rf, px, py, w, h, base, tile, true);
    if (rf.shape === 'battlement') return battlementRoof(ctx, r, rf, px, py, w, h, tile);
    if (rf.shape === 'portico') return porticoRoof(ctx, r, rf, px, py, w, h, tile);
    if (rf.shape === 'porch') return porchRoof(ctx, r, rf, px, py, w, h, tile);
    const halves = ridgeAlong === 'h'
        ? [[px, py, w, h / 2, 8], [px, py + h / 2, w, h / 2, -10]]
        : [[px, py, w / 2, h, 8], [px + w / 2, py, w / 2, h, -10]];
    for (const [hx, hy, hw, hh, dl] of halves) {
        ctx.fillStyle = hsl(base[0], base[1], base[2] + dl); ctx.fillRect(hx, hy, hw, hh);
        // Shingle rows, parallel to the ridge.
        const rowSize = tile * (rf.style === 'thatch' ? 0.18 : 0.22);
        if (ridgeAlong === 'h') {
            for (let yy = hy; yy < hy + hh; yy += rowSize) {
                const off = Math.round((yy - hy) / rowSize) % 2 ? rowSize * 0.6 : 0;
                for (let xx = hx - off; xx < hx + hw; xx += rowSize * 1.2) { ctx.fillStyle = hsl(base[0] + between(r, -3, 3), base[1], base[2] + dl + between(r, -5, 5)); ctx.fillRect(Math.max(hx, xx) + 1, yy + 1, Math.min(rowSize * 1.2, hx + hw - Math.max(hx, xx)) - 2, rowSize - 2); }
                line(ctx, hx, yy, hx + hw, yy, 'rgba(0,0,0,0.25)', 1);
            }
        } else {
            for (let xx = hx; xx < hx + hw; xx += rowSize) {
                const off = Math.round((xx - hx) / rowSize) % 2 ? rowSize * 0.6 : 0;
                for (let yy = hy - off; yy < hy + hh; yy += rowSize * 1.2) { ctx.fillStyle = hsl(base[0] + between(r, -3, 3), base[1], base[2] + dl + between(r, -5, 5)); ctx.fillRect(xx + 1, Math.max(hy, yy) + 1, rowSize - 2, Math.min(rowSize * 1.2, hy + hh - Math.max(hy, yy)) - 2); }
                line(ctx, xx, hy, xx, hy + hh, 'rgba(0,0,0,0.25)', 1);
            }
        }
    }
    // Ridge beam and eaves.
    if (ridgeAlong === 'h') { ctx.fillStyle = hsl(base[0], base[1], base[2] - 16); ctx.fillRect(px, py + h / 2 - tile * 0.05, w, tile * 0.1); }
    else { ctx.fillStyle = hsl(base[0], base[1], base[2] - 16); ctx.fillRect(px + w / 2 - tile * 0.05, py, tile * 0.1, h); }
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
    // Chimney with a wisp of smoke.
    if (rf.chimney !== false && rf.w * rf.h >= 12) {
        const cx = px + (ridgeAlong === 'h' ? w * pick(r, [0.2, 0.75]) : w * 0.25), cy = py + (ridgeAlong === 'h' ? h * 0.25 : h * pick(r, [0.2, 0.75]));
        shadow(ctx, cx + tile * 0.14, cy + tile * 0.16, tile * 0.24, tile * 0.18);
        rrect(ctx, cx - tile * 0.18, cy - tile * 0.18, tile * 0.36, tile * 0.36, 1, hsl(12, 35, 32), hsl(12, 35, 16), 1.5);
        ctx.fillStyle = '#140b08'; ctx.fillRect(cx - tile * 0.1, cy - tile * 0.1, tile * 0.2, tile * 0.2);
        for (let i = 0; i < 3; i++) blob(ctx, cx + tile * (0.12 + i * 0.18), cy - tile * (0.1 + i * 0.16), tile * (0.18 + i * 0.06), 'rgba(220,220,220,0.18)');
    }
}

// ---------- the base layer: terrain + roofs + props + lighting, painted once per map ----------
const baseCache = new WeakMap();

/** The room (area) a square belongs to; walls belong to the room they border. */
function areaFinder(map) {
    const areas = map.areas || [];
    if (!areas.length) return () => null;
    return (x, y, isWallTile) => {
        for (const a of areas) if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
        if (isWallTile) for (const a of areas) if (x >= a.x - 1 && x <= a.x + a.w && y >= a.y - 1 && y <= a.y + a.h) return a;
        return null;
    };
}

function styleFor(st, area) {
    if (!area) return st;
    const out = { ...st };
    if (area.floor && FLOOR[area.floor]) { out.floor = area.floor; out.floorC = area.hue !== undefined && ['carpet', 'tiles'].includes(area.floor) ? [area.hue, area.floor === 'carpet' ? 45 : 12, area.floor === 'carpet' ? 26 : 72] : (MATERIAL[area.floor] ?? st.floorC); }
    if (area.wall) { out.wall = area.wall; out.wallC = area.wallColor ?? (area.wallHue !== undefined && area.wall === 'wallpaper' ? [area.wallHue, 30, 26] : (WALL_MATERIAL[area.wall] ?? st.wallC)); }
    if (area.grime !== undefined) out.grime = area.grime;
    // A patch of ground in its own colour (a dark forest floor, a sunny glade).
    if (area.floorC) out.floorC = area.floorC;
    return out;
}

/**
 * Paint the map (without tokens) into an offscreen canvas, cached per map object.
 * @returns {HTMLCanvasElement}
 */
export function paintMapBase(map, tile) {
    const cached = baseCache.get(map);
    if (cached && cached.tile === tile && cached.version === (map.version || 0)) return cached.canvas;
    const theme = THEME_STYLE[map.theme] ?? THEME_STYLE.dungeon;
    const outdoor = OUTDOOR.has(map.theme);
    const canvas = document.createElement('canvas');
    canvas.width = map.w * tile; canvas.height = map.h * tile;
    const ctx = canvas.getContext('2d');
    const at = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? '%' : terrainAt(map, x, y));
    const isWall = ch => ch === '#' || ch === '|' || ch === 'H' || ch === 'U';
    const isWater = ch => ch === '~' || ch === 'w' || ch === 'b';
    const areaAt = areaFinder(map);
    const floorKind = (ch, st) => ({ '_': 'planks', '=': 'cobble', ',': 'grass', ':': st.floor === 'mud' ? 'mud' : 'dirt' })[ch] ?? st.floor;
    // Ground under doors, trees and stairs: whatever plain floor is around them.
    const groundChar = (x, y) => {
        const counts = {};
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const c = at(x + dx, y + dy); if (PLAIN[c]) counts[c] = (counts[c] || 0) + 1; }
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.';
    };
    const kinds = new Array(map.w * map.h).fill(null);
    // Trees outdoors are drawn after all the ground, top to bottom, so their canopies overlap.
    const trees = [];
    // Bridges over water go on after the water is painted.
    const decks = [];
    // Dirt trails outdoors are painted as one soft path after the ground.
    const trails = [];

    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const ch = at(x, y);
            const px = x * tile, py = (map.h - 1 - y) * tile; // row 1 is the bottom row
            const r = rngFor(map.seed, x, y);
            const st = styleFor(outdoor ? { ...theme, flatWalls: true } : theme, areaAt(x, y, isWall(ch)));
            const open = { below: !isWall(at(x, y - 1)), above: !isWall(at(x, y + 1)), left: !isWall(at(x - 1, y)), right: !isWall(at(x + 1, y)) };
            if (ch === '%') { voidTile(ctx, r, px, py, tile); continue; }
            if (ch === '#') { wall(ctx, r, px, py, tile, st, open, x, y); continue; }
            if (ch === '|' || ch === 'H' || ch === 'U') { windowTile(ctx, r, px, py, tile, st, isWall(at(x - 1, y)) || isWall(at(x + 1, y)), x, y, open, ch === 'H' ? 'barred' : ch === 'U' ? 'broken' : 'glass'); continue; }
            if (ch === ':' && outdoor) {
                (FLOOR[st.floor] ?? FLOOR.grass)(ctx, r, px, py, tile, st, x, y);
                trails.push([x, y]);
                continue;
            }
            if (ch === '~' || ch === 'w') {
                const under = FLOOR[floorKind(groundChar(x, y), st)] ?? FLOOR[st.floor] ?? FLOOR.stone;
                under(ctx, r, px, py, tile, st, x, y);
                continue;
            }
            if (ch === 'L') { lava(ctx, r, px, py, tile); continue; }
            if (ch === 'b') {
                const overWater = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => at(x + dx, y + dy) === '~' || at(x + dx, y + dy) === 'w');
                if (overWater) { decks.push([r, px, py, isWater(at(x, y + 1)) || isWater(at(x, y - 1))]); continue; }
                bridge(ctx, r, px, py, tile, isWater(at(x, y + 1)) || isWater(at(x, y - 1)) || at(x, y + 1) === 'o' || at(x, y - 1) === 'o' || at(x, y + 1) === 'L' || at(x, y - 1) === 'L', overWater);
                continue;
            }
            const groundCh = OVERLAY.has(ch) ? groundChar(x, y) : ch;
            const kind = floorKind(groundCh, st);
            kinds[y * map.w + x] = kind;
            const ground = FLOOR[kind] ?? FLOOR.stone;
            // "." uses the theme's (or room's) own floor colors; named floors (_ = , :) keep their material's colors.
            const floorStyle = groundCh !== '.' && MATERIAL[kind] && kind !== st.floor ? { ...st, floorC: MATERIAL[kind] } : st;
            ground(ctx, r, px, py, tile, floorStyle, x, y);
            // Indoors, walls cast soft shadows onto the floor beside them (light from the top left).
            if (!outdoor) {
                if (isWall(at(x, y + 1))) { const g = ctx.createLinearGradient(0, py, 0, py + tile * 0.34); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(px, py, tile, tile * 0.34); }
                if (isWall(at(x - 1, y))) { const g = ctx.createLinearGradient(px, 0, px + tile * 0.26, 0); g.addColorStop(0, 'rgba(0,0,0,0.4)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(px, py, tile * 0.26, tile); }
                if (isWall(at(x + 1, y))) { const g = ctx.createLinearGradient(px + tile, 0, px + tile * 0.88, 0); g.addColorStop(0, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(px + tile * 0.88, py, tile * 0.12, tile); }
            }
            if (ch === 'o') pit(ctx, r, px, py, tile);
            else if (ch === '^') rubble(ctx, r, px, py, tile);
            else if (ch === 'T') { if (outdoor) trees.push([r, px, py]); else pillarTile(ctx, r, px, py, tile); }
            else if (ch === '+' || ch === '/' || ch === 'D') door(ctx, r, px, py, tile, ch === '/' ? 'open' : ch === 'D' ? 'locked' : 'closed', isWall(at(x - 1, y)) || isWall(at(x + 1, y)));
            else if (ch === '<' || ch === '>') stairs(ctx, r, px, py, tile, ch === '<');
            else if (ch === 'I' || ch === 'J' || ch === 'j') {
                const barLike = c => c === 'I' || c === 'J' || c === 'j' || isWall(c);
                ironBars(ctx, px, py, tile, barLike(at(x - 1, y)) || barLike(at(x + 1, y)), ch === 'I' ? 'bars' : ch === 'J' ? 'locked' : 'shut');
            }
        }
    }
    // Grass spills over the edges of roads and paths, and roads get a worn edge.
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        if (kinds[y * map.w + x] !== 'grass') continue;
        const r = rngFor(map.seed, x, y, 5);
        const px = x * tile, py = (map.h - 1 - y) * tile;
        for (const [dx, dy, ex, ey, horiz] of [[0, 1, px, py, true], [0, -1, px, py + tile, true], [-1, 0, px, py, false], [1, 0, px + tile, py, false]]) {
            const nk = kinds[(y + dy) * map.w + (x + dx)];
            if (!nk || nk === 'grass' || x + dx < 0 || y + dy < 0 || x + dx >= map.w || y + dy >= map.h) continue;
            const g = horiz ? ctx.createLinearGradient(0, ey - tile * 0.12, 0, ey + tile * 0.12) : ctx.createLinearGradient(ex - tile * 0.12, 0, ex + tile * 0.12, 0);
            g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(20,15,5,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g; if (horiz) ctx.fillRect(ex, ey - tile * 0.12, tile, tile * 0.24); else ctx.fillRect(ex - tile * 0.12, ey, tile * 0.24, tile);
            ctx.lineWidth = tile / 80;
            for (let i = 0; i < 14; i++) {
                const t = r() * tile, bx = horiz ? ex + t : ex, by = horiz ? ey : ey + t, out = between(r, 0.02, 0.12) * tile;
                ctx.strokeStyle = hsl(between(r, 85, 120), 45, between(r, 24, 40), 0.85);
                ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + (horiz ? between(r, -2, 2) : -dx * out), by + (horiz ? dy * out : between(r, -2, 2))); ctx.stroke();
            }
        }
    }
    paintTrails(ctx, map, tile, trails);
    paintWater(ctx, map, tile, at);
    for (const [dr, px, py, horiz] of decks) bridgeDeck(ctx, dr, px, py, tile, horiz);
    for (const [tr, px, py] of trees) tree(ctx, tr, px, py, tile, map.theme);
    // Carpeted rooms get a border along their edges.
    for (const a of map.areas || []) {
        if (a.floor !== 'carpet') continue;
        const px = a.x * tile, py = (map.h - a.y - a.h) * tile;
        ctx.strokeStyle = hsl(42, 55, 45, 0.85); ctx.lineWidth = Math.max(2, tile / 18);
        ctx.strokeRect(px + tile * 0.14, py + tile * 0.14, a.w * tile - tile * 0.28, a.h * tile - tile * 0.28);
        ctx.strokeStyle = hsl(42, 55, 45, 0.5); ctx.lineWidth = 1;
        ctx.strokeRect(px + tile * 0.24, py + tile * 0.24, a.w * tile - tile * 0.48, a.h * tile - tile * 0.48);
    }
    // Fire: charred floors and walls where it burnt out, scorch marks under it while it burns.
    for (const k of new Set([...Object.keys(map.burnt || {}), ...Object.keys(map.fire || {})])) {
        const [x, y] = k.split(',').map(Number);
        const r = rngFor(map.seed, x, y, 31), px = x * tile, py = (map.h - 1 - y) * tile;
        if (map.burnt?.[k]) charred(ctx, r, px, py, tile, isWall(at(x, y)));
        else blob(ctx, px + tile / 2, py + tile / 2, tile * 0.7, 'rgba(25,14,8,0.45)');
    }
    // Roofs over town buildings.
    for (const rf of map.roofs || []) roof(ctx, rf, tile, map.h, map.seed);
    // Props: floor marks, then rugs, then furniture, then things hanging from the ceiling.
    const layer = p => (PROPS[p.type]?.decal ? 0 : p.type === 'rug' ? 1 : PROPS[p.type]?.ceiling || p.type === 'bigtree' ? 3 : 2);
    const props = (map.props || []).filter(p => !p.hidden).sort((a, b) => layer(a) - layer(b));
    for (const p of props) {
        const art = PROP_ART[p.type];
        if (!art) continue;
        const w = p.w || 1, h = p.h || 1;
        const cx = (p.x + w / 2) * tile, cy = (map.h - p.y - h / 2) * tile;
        // Seeded by the thing itself (its id), so it keeps its look when it's shoved somewhere else.
        const idNum = Number(/^p(\d+)$/.exec(p.id || '')?.[1]);
        const rr = Number.isFinite(idNum) ? rngFor(map.seed, idNum, 7919) : rngFor(map.seed, p.x, p.y, 7);
        if (ORIENTED.has(p.type) && p.side && p.side !== 'n') {
            // Drawn with its back to the top, then turned so the back is against its own wall.
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate({ s: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }[p.side] ?? 0);
            const sideways = p.side === 'e' || p.side === 'w';
            art(ctx, rr, 0, 0, tile, sideways ? h : w, sideways ? w : h, p);
            ctx.restore();
        } else art(ctx, rr, cx, cy, tile, w, h, p);
    }
    // Lighting: the theme's darkness, with warm pools around light sources (and lit rooms).
    const lights = (map.props || []).filter(p => !p.hidden && PROPS[p.type]?.light).map(p => ({ x: p.x + ((p.w || 1) - 1) / 2, y: p.y + ((p.h || 1) - 1) / 2, rad: PROPS[p.type].light }));
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (at(x, y) === 'L') lights.push({ x, y, rad: 2 });
    const dark = map.dark ?? theme.dark;
    if (dark > 0) {
        const shade = document.createElement('canvas');
        shade.width = canvas.width; shade.height = canvas.height;
        const sctx = shade.getContext('2d');
        sctx.fillStyle = `rgba(5,5,15,${dark})`; sctx.fillRect(0, 0, shade.width, shade.height);
        sctx.globalCompositeOperation = 'destination-out';
        for (const a of map.areas || []) if (a.lit) { sctx.fillStyle = 'rgba(0,0,0,0.7)'; sctx.fillRect(a.x * tile, (map.h - a.y - a.h) * tile, a.w * tile, a.h * tile); }
        // Fire lights up the dark too (its glow is drawn by the moving effects on top).
        for (const l of [...lights, ...fireLights(map)]) {
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
    // Faint grid so squares stay countable (not over roofs or the void outside).
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1;
    for (let i = 1; i < map.w; i++) { ctx.beginPath(); ctx.moveTo(i * tile + 0.5, 0); ctx.lineTo(i * tile + 0.5, canvas.height); ctx.stroke(); }
    for (let j = 1; j < map.h; j++) { ctx.beginPath(); ctx.moveTo(0, j * tile + 0.5); ctx.lineTo(canvas.width, j * tile + 0.5); ctx.stroke(); }
    baseCache.set(map, { tile, canvas, version: map.version || 0 });
    return canvas;
}

/** Forget a map's painted canvas (after a door opens, a secret is found...). */
export function repaint(map) {
    baseCache.delete(map);
}

/** Human name of what's on a square, for tooltips and messages. */
export function squareName(map, x, y) {
    const prop = propAt(map, x, y);
    if (!prop) return null;
    const name = PROPS[prop.type]?.name || prop.type;
    return prop.label ? (prop.type === 'sign' ? `${prop.label} (sign)` : prop.label) : name;
}

export { propsAt };
