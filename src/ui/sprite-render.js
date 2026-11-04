// Drawing map figures: each figure's frames are painted once into a small sprite sheet (cached),
// then the map copies the right frame each tick, flipped for facing left, crisp at any zoom.

import { buildSprite, ANIM_TIMING, SIZE } from '../core/sprites.js';

const sheets = new Map(); // key -> {canvas, red, ctx, rctx, img, rimg, probe, index: {anim: [start, count]}, alpha, checked}
const MAX_SHEETS = 80;

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeSheet(look) {
    const sprite = buildSprite(look);
    const order = Object.keys(sprite.anims);
    const total = order.reduce((n, k) => n + sprite.anims[k].length, 0);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE * total; canvas.height = SIZE;
    const red = document.createElement('canvas');
    red.width = canvas.width; red.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }), rctx = red.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(canvas.width, SIZE), rimg = rctx.createImageData(canvas.width, SIZE);
    const rgb = sprite.palette.map(c => (c ? hexToRgb(c) : null));
    const index = {};
    let col = 0, probe = null;
    for (const name of order) {
        index[name] = [col, sprite.anims[name].length];
        for (const frame of sprite.anims[name]) {
            for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
                const c = rgb[frame[y * SIZE + x]];
                if (!c) continue;
                probe ??= { x: col * SIZE + x, y };
                const o = (y * canvas.width + col * SIZE + x) * 4;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
                // The "hurt" flash: the same figure washed in red.
                rimg.data[o] = Math.min(255, c[0] * 0.5 + 200); rimg.data[o + 1] = c[1] * 0.35; rimg.data[o + 2] = c[2] * 0.35; rimg.data[o + 3] = 255;
            }
            col++;
        }
    }
    ctx.putImageData(img, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    return { canvas, red, ctx, rctx, img, rimg, probe, index, alpha: sprite.alpha, checked: 0 };
}

/**
 * Chrome drops a canvas's pixels under memory pressure (a background tab, a window resize) and
 * hands it back blank, with no error and no lost-context event for a 2D canvas: the figures
 * vanished from the map part-way through a run, leaving their rings. A sheet whose first painted
 * pixel has gone clear is painted again from the pixels kept in memory (checked at most twice a second).
 */
function keepPainted(s, now) {
    if (!s.probe || now - s.checked < 500) return;
    s.checked = now;
    if (s.ctx.getImageData(s.probe.x, s.probe.y, 1, 1).data[3] !== 0) return;
    s.ctx.putImageData(s.img, 0, 0);
    s.rctx.putImageData(s.rimg, 0, 0);
}

export function sheetFor(look) {
    const key = JSON.stringify(look);
    let s = sheets.get(key);
    if (!s) {
        s = makeSheet(look);
        if (sheets.size >= MAX_SHEETS) sheets.delete(sheets.keys().next().value);
        sheets.set(key, s);
    } else keepPainted(s, typeof performance !== 'undefined' ? performance.now() : Date.now());
    return s;
}

/** Which frame of an animation to show at a time (ms since it started; loops or holds the last frame). */
export function frameOf(anim, count, elapsed, offset = 0) {
    const t = ANIM_TIMING[anim] ?? ANIM_TIMING.idle;
    const n = Math.floor((elapsed + offset) / (1000 / t.fps));
    return t.loop ? n % count : Math.min(count - 1, n);
}

/**
 * Draw a figure's current frame into a square (x, y, size), at whole-pixel scale so it stays crisp.
 * @param {{anim?: string, elapsed?: number, offset?: number, flip?: boolean, red?: boolean}} o
 */
export function drawFigure(ctx, look, x, y, size, { anim = 'idle', elapsed = 0, offset = 0, flip = false, red = false } = {}) {
    const s = sheetFor(look);
    const [start, count] = s.index[anim] ?? s.index.idle;
    const f = start + frameOf(anim, count, elapsed, offset);
    const scale = Math.max(1, Math.floor(size / SIZE));
    const d = SIZE * scale;
    const dx = Math.round(x + (size - d) / 2), dy = Math.round(y + size - d - Math.max(0, Math.floor(size * 0.04)));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (s.alpha < 1) ctx.globalAlpha = s.alpha;
    if (flip) { ctx.translate(dx + d, dy); ctx.scale(-1, 1); ctx.drawImage(red ? s.red : s.canvas, f * SIZE, 0, SIZE, SIZE, 0, 0, d, d); }
    else ctx.drawImage(red ? s.red : s.canvas, f * SIZE, 0, SIZE, SIZE, dx, dy, d, d);
    ctx.restore();
}
