// Small drawing helpers shared by the map painter (tiles.js) and the prop art (prop-art.js).
// Everything is drawn in code with a seeded random generator, so the same map always looks the same.

// ---------- seeded randomness ----------
export function hash(...n) {
    let h = 2166136261;
    for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
    return h >>> 0;
}
export function rngFor(...n) {
    let a = hash(...n) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const between = (r, a, b) => a + r() * (b - a);
export const pick = (r, list) => list[Math.floor(r() * list.length)];

// ---------- colors ----------
export function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }
/** A palette color as [h, s, l]; jitter it per tile. */
export function tone([h, s, l], r, dl = 6, dh = 4) { return hsl(h + between(r, -dh, dh), s, Math.max(2, l + between(r, -dl, dl))); }

// ---------- shapes ----------
export function speckle(ctx, r, x, y, s, n, dark = 0.12, light = 0.07) {
    for (let i = 0; i < n; i++) {
        const lightDot = r() < 0.45;
        ctx.fillStyle = lightDot ? `rgba(255,255,255,${between(r, 0.02, light)})` : `rgba(0,0,0,${between(r, 0.03, dark)})`;
        const d = between(r, 0.6, 2.4) * s / 64;
        ctx.fillRect(x + r() * s, y + r() * s, d, d);
    }
}
export function blob(ctx, cx, cy, rad, color) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
}
export function crack(ctx, r, x, y, s) {
    ctx.strokeStyle = `rgba(0,0,0,${between(r, 0.25, 0.45)})`;
    ctx.lineWidth = s / 64;
    ctx.beginPath();
    let px = x + between(r, 0.15, 0.85) * s, py = y + between(r, 0.1, 0.4) * s;
    ctx.moveTo(px, py);
    for (let i = 0; i < 4; i++) { px += between(r, -0.18, 0.18) * s; py += between(r, 0.08, 0.2) * s; ctx.lineTo(px, py); }
    ctx.stroke();
}
export function ellipse(ctx, cx, cy, rx, ry, fill, stroke = null, lw = 1) {
    ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
export function rrect(ctx, x, y, w, h, rad, fill, stroke = null, lw = 1) {
    ctx.beginPath(); ctx.roundRect(x, y, Math.max(0.1, w), Math.max(0.1, h), rad);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
export function poly(ctx, points, fill, stroke = null, lw = 1) {
    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
export function line(ctx, x0, y0, x1, y1, color, lw = 1) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
export function shadow(ctx, cx, cy, rx, ry) { ellipse(ctx, cx, cy, rx, ry, 'rgba(0,0,0,0.35)'); }
export function flame(ctx, cx, cy, size) {
    blob(ctx, cx, cy, size * 1.6, 'rgba(255,170,60,0.35)');
    ellipse(ctx, cx, cy, size * 0.45, size * 0.7, '#ff8a1f');
    ellipse(ctx, cx, cy + size * 0.12, size * 0.25, size * 0.4, '#ffe066');
}
/** Wood-grain lines across a rectangle (horizontal unless vertical = true). */
export function grain(ctx, r, x, y, w, h, vertical = false, alpha = 0.18) {
    ctx.strokeStyle = `rgba(0,0,0,${alpha})`; ctx.lineWidth = 1;
    const n = Math.max(2, Math.round((vertical ? w : h) / 5));
    for (let i = 1; i < n; i++) {
        ctx.beginPath();
        if (vertical) { const gx = x + (i / n) * w + between(r, -1, 1); ctx.moveTo(gx, y); ctx.lineTo(gx + between(r, -2, 2), y + h); }
        else { const gy = y + (i / n) * h + between(r, -1, 1); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy + between(r, -2, 2)); }
        ctx.stroke();
    }
}
