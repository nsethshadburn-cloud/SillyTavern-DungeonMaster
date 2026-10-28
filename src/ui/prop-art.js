// Prop art: furniture, dungeon dressing, town pieces and floor marks, all drawn in code.
// Each piece is drawn centered on its squares: (cx, cy) is the center, s the size of one square,
// w and h how many squares it covers. Wall pieces (paintings, signs, shackles) are drawn on a wall
// square, against the side the room is on ("facing": s = room below, n, e, w).

import { between, pick, hsl, ellipse, rrect, poly, line, shadow, blob, crack, flame, grain } from './paint-kit.js';

const WOOD = (l = 30) => hsl(28, 40, l);

/** Turn the drawing so a wall piece faces its room (art is drawn facing down, "s"). */
function faced(ctx, cx, cy, facing, draw) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate({ n: Math.PI, e: -Math.PI / 2, w: Math.PI / 2 }[facing] ?? 0);
    draw();
    ctx.restore();
}

// ---------- sign icons (drawn on a sign board, centered at 0,0, size k) ----------
const ICONS = {
    anvil(ctx, k) { poly(ctx, [[-k * 0.5, -k * 0.2], [k * 0.35, -k * 0.2], [k * 0.55, -k * 0.05], [k * 0.3, k * 0.05], [-k * 0.5, k * 0.05]], '#2b2b2f'); ctx.fillStyle = '#2b2b2f'; ctx.fillRect(-k * 0.15, k * 0.05, k * 0.28, k * 0.2); ctx.fillRect(-k * 0.3, k * 0.25, k * 0.58, k * 0.08); },
    mug(ctx, k) { rrect(ctx, -k * 0.3, -k * 0.25, k * 0.45, k * 0.55, 2, '#c99a3a', '#5a3b1a', 1.5); ctx.strokeStyle = '#5a3b1a'; ctx.lineWidth = k * 0.08; ctx.beginPath(); ctx.arc(k * 0.2, k * 0.03, k * 0.14, -1.3, 1.3); ctx.stroke(); ellipse(ctx, -k * 0.08, -k * 0.28, k * 0.26, k * 0.09, '#f3eee0'); },
    bed(ctx, k) { ctx.fillStyle = '#5a3b1a'; ctx.fillRect(-k * 0.5, -k * 0.05, k, k * 0.25); ctx.fillRect(-k * 0.5, -k * 0.3, k * 0.08, k * 0.5); rrect(ctx, -k * 0.4, -k * 0.2, k * 0.25, k * 0.15, 3, '#f3eee0'); rrect(ctx, -k * 0.15, -k * 0.15, k * 0.62, k * 0.12, 3, '#9b2c2c'); },
    bread(ctx, k) { ellipse(ctx, 0, 0, k * 0.48, k * 0.26, '#c98a3a', '#6b3f12', 1.5); for (let i = -1; i <= 1; i++) line(ctx, i * k * 0.18 - k * 0.06, -k * 0.16, i * k * 0.18 + k * 0.06, k * 0.08, '#6b3f12', 1.5); },
    potion(ctx, k) { ellipse(ctx, 0, k * 0.12, k * 0.3, k * 0.3, '#7b3fb8', '#2a1440', 1.5); ctx.fillStyle = '#cfd8dc'; ctx.fillRect(-k * 0.08, -k * 0.38, k * 0.16, k * 0.25); ctx.fillStyle = '#6b4a2a'; ctx.fillRect(-k * 0.1, -k * 0.46, k * 0.2, k * 0.1); ellipse(ctx, -k * 0.1, k * 0.04, k * 0.07, k * 0.05, 'rgba(255,255,255,0.5)'); },
    swords(ctx, k) { for (const d of [-1, 1]) { ctx.save(); ctx.rotate(d * 0.7); ctx.fillStyle = '#d7dde2'; ctx.fillRect(-k * 0.05, -k * 0.5, k * 0.1, k * 0.7); ctx.fillStyle = '#8a6a2a'; ctx.fillRect(-k * 0.18, k * 0.2, k * 0.36, k * 0.07); ctx.fillRect(-k * 0.04, k * 0.27, k * 0.08, k * 0.18); ctx.restore(); } },
    shield(ctx, k) { poly(ctx, [[-k * 0.38, -k * 0.4], [k * 0.38, -k * 0.4], [k * 0.38, 0], [0, k * 0.48], [-k * 0.38, 0]], '#2e4f8b', '#c9a227', 2); line(ctx, 0, -k * 0.38, 0, k * 0.4, '#c9a227', 2); line(ctx, -k * 0.36, -k * 0.08, k * 0.36, -k * 0.08, '#c9a227', 2); },
    scroll(ctx, k) { rrect(ctx, -k * 0.38, -k * 0.3, k * 0.76, k * 0.6, 3, '#efe3c2', '#7a5a2a', 1.5); for (let i = 0; i < 3; i++) line(ctx, -k * 0.25, -k * 0.12 + i * k * 0.14, k * 0.25, -k * 0.12 + i * k * 0.14, '#7a5a2a', 1); ellipse(ctx, -k * 0.38, 0, k * 0.07, k * 0.3, '#d8c79c', '#7a5a2a', 1); ellipse(ctx, k * 0.38, 0, k * 0.07, k * 0.3, '#d8c79c', '#7a5a2a', 1); },
    horseshoe(ctx, k) { ctx.strokeStyle = '#9aa1a8'; ctx.lineWidth = k * 0.16; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(0, -k * 0.02, k * 0.3, Math.PI * 0.85, Math.PI * 2.15, true); ctx.stroke(); ctx.lineCap = 'butt'; },
    sun(ctx, k) { for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; line(ctx, Math.cos(a) * k * 0.25, Math.sin(a) * k * 0.25, Math.cos(a) * k * 0.46, Math.sin(a) * k * 0.46, '#e6b422', k * 0.07); } ellipse(ctx, 0, 0, k * 0.24, k * 0.24, '#f5cd3a', '#a8780e', 1.5); },
    coins(ctx, k) { for (const [dx, dy] of [[-0.18, 0.12], [0.18, 0.12], [0, -0.12]]) { ellipse(ctx, dx * k, dy * k, k * 0.22, k * 0.22, '#e8c34a', '#8a6a10', 1.5); ellipse(ctx, dx * k, dy * k, k * 0.12, k * 0.12, null, '#a8820e', 1); } },
    needle(ctx, k) { line(ctx, -k * 0.4, k * 0.4, k * 0.35, -k * 0.35, '#cfd8dc', k * 0.07); ellipse(ctx, k * 0.33, -k * 0.33, k * 0.06, k * 0.04, null, '#555', 1.5); ctx.strokeStyle = '#b33'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(k * 0.33, -k * 0.33); ctx.bezierCurveTo(k * 0.5, 0, -k * 0.2, k * 0.1, -k * 0.1, k * 0.45); ctx.stroke(); },
    fish(ctx, k) { ellipse(ctx, -k * 0.05, 0, k * 0.34, k * 0.17, '#5b8db8', '#244', 1.5); poly(ctx, [[k * 0.25, 0], [k * 0.48, -k * 0.18], [k * 0.48, k * 0.18]], '#5b8db8', '#244', 1.5); ellipse(ctx, -k * 0.24, -k * 0.04, k * 0.03, k * 0.03, '#111'); },
    book(ctx, k) { rrect(ctx, -k * 0.38, -k * 0.3, k * 0.76, k * 0.6, 2, '#7a1c1c', '#3a0a0a', 1.5); line(ctx, 0, -k * 0.3, 0, k * 0.3, '#3a0a0a', 2); ctx.fillStyle = '#e8c34a'; ctx.fillRect(-k * 0.28, -k * 0.08, k * 0.2, k * 0.06); ctx.fillRect(k * 0.08, -k * 0.08, k * 0.2, k * 0.06); },
    gem(ctx, k) { poly(ctx, [[-k * 0.3, -k * 0.12], [-k * 0.15, -k * 0.32], [k * 0.15, -k * 0.32], [k * 0.3, -k * 0.12], [0, k * 0.38]], '#3fb8d8', '#14485a', 1.5); line(ctx, -k * 0.3, -k * 0.12, k * 0.3, -k * 0.12, '#14485a', 1); },
    skull(ctx, k) { ellipse(ctx, 0, -k * 0.06, k * 0.3, k * 0.28, '#ece5d3', '#555', 1); ellipse(ctx, -k * 0.11, -k * 0.06, k * 0.08, k * 0.08, '#222'); ellipse(ctx, k * 0.11, -k * 0.06, k * 0.08, k * 0.08, '#222'); ctx.fillStyle = '#ece5d3'; ctx.fillRect(-k * 0.15, k * 0.16, k * 0.3, k * 0.14); },
    key(ctx, k) { ellipse(ctx, -k * 0.24, 0, k * 0.16, k * 0.16, null, '#c9a227', k * 0.08); line(ctx, -k * 0.08, 0, k * 0.42, 0, '#c9a227', k * 0.09); line(ctx, k * 0.3, 0, k * 0.3, k * 0.16, '#c9a227', k * 0.08); line(ctx, k * 0.4, 0, k * 0.4, k * 0.12, '#c9a227', k * 0.08); },
    hammer(ctx, k) { ctx.save(); ctx.rotate(-0.6); ctx.fillStyle = '#7a5a2a'; ctx.fillRect(-k * 0.05, -k * 0.1, k * 0.1, k * 0.55); ctx.fillStyle = '#555'; ctx.fillRect(-k * 0.28, -k * 0.3, k * 0.56, k * 0.2); ctx.restore(); },
    wheat(ctx, k) { line(ctx, 0, k * 0.45, 0, -k * 0.2, '#b8902a', 2); for (let i = 0; i < 4; i++) { ellipse(ctx, -k * 0.08, -k * 0.15 + i * k * 0.12, k * 0.07, k * 0.04, '#e0b84a'); ellipse(ctx, k * 0.08, -k * 0.15 + i * k * 0.12, k * 0.07, k * 0.04, '#e0b84a'); } ellipse(ctx, 0, -k * 0.27, k * 0.05, k * 0.08, '#e0b84a'); },
    meat(ctx, k) { ellipse(ctx, -k * 0.05, 0, k * 0.34, k * 0.24, '#b2413a', '#5a1a14', 1.5); ellipse(ctx, -k * 0.05, 0, k * 0.16, k * 0.1, '#f0d7c8'); line(ctx, k * 0.25, k * 0.1, k * 0.46, k * 0.28, '#f3eee0', k * 0.08); },
    boot(ctx, k) { poly(ctx, [[-k * 0.2, -k * 0.42], [k * 0.08, -k * 0.42], [k * 0.08, k * 0.1], [k * 0.42, k * 0.18], [k * 0.42, k * 0.36], [-k * 0.2, k * 0.36]], '#6b4423', '#2a1a0a', 1.5); },
    crown(ctx, k) { poly(ctx, [[-k * 0.4, k * 0.25], [-k * 0.4, -k * 0.25], [-k * 0.2, 0], [0, -k * 0.35], [k * 0.2, 0], [k * 0.4, -k * 0.25], [k * 0.4, k * 0.25]], '#e8c34a', '#8a6a10', 1.5); ellipse(ctx, 0, k * 0.1, k * 0.06, k * 0.06, '#c0392b'); },
    music(ctx, k) { ellipse(ctx, -k * 0.2, k * 0.25, k * 0.13, k * 0.1, '#222'); ellipse(ctx, k * 0.22, k * 0.15, k * 0.13, k * 0.1, '#222'); line(ctx, -k * 0.08, k * 0.25, -k * 0.08, -k * 0.35, '#222', 2); line(ctx, k * 0.34, k * 0.15, k * 0.34, -k * 0.42, '#222', 2); line(ctx, -k * 0.08, -k * 0.35, k * 0.34, -k * 0.42, '#222', k * 0.08); },
    candle(ctx, k) { ctx.fillStyle = '#f3eee0'; ctx.fillRect(-k * 0.1, -k * 0.1, k * 0.2, k * 0.45); flame(ctx, 0, -k * 0.22, k * 0.12); },
    flower(ctx, k) { for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; ellipse(ctx, Math.cos(a) * k * 0.18, Math.sin(a) * k * 0.18, k * 0.13, k * 0.13, '#e05a8a'); } ellipse(ctx, 0, 0, k * 0.1, k * 0.1, '#f5cd3a'); },
};

/** A hanging sign board with its icon (on the wall square, hanging out over the street). */
function signBoard(ctx, r, cx, cy, s, prop) {
    faced(ctx, cx, cy, prop.facing, () => {
        // Iron bracket out of the wall, the board hanging below it (toward the street).
        line(ctx, 0, s * 0.05, 0, s * 0.42, '#2a2a2a', s / 22);
        line(ctx, -s * 0.34, s * 0.42, s * 0.34, s * 0.42, '#2a2a2a', s / 26);
        shadow(ctx, s * 0.06, s * 0.78, s * 0.36, s * 0.1);
        rrect(ctx, -s * 0.36, s * 0.46, s * 0.72, s * 0.52, s * 0.06, hsl(28, 45, 30), hsl(28, 45, 14), s / 28);
        rrect(ctx, -s * 0.31, s * 0.5, s * 0.62, s * 0.44, s * 0.05, hsl(38, 35, 62));
        ctx.save();
        ctx.translate(0, s * 0.72);
        if (prop.facing === 'n') ctx.rotate(Math.PI);
        (ICONS[prop.icon] ?? ICONS.scroll)(ctx, s * 0.36);
        ctx.restore();
    });
}

/** Grain-lined wooden slab, the base of most furniture. */
function woodBox(ctx, r, x, y, w, h, l = 32, rad = 2) {
    rrect(ctx, x, y, w, h, rad, WOOD(l), WOOD(l - 16), 1.5);
    grain(ctx, r, x + 2, y + 2, w - 4, h - 4, h > w, 0.12);
}

export const PROP_ART = {
    // ---------- original pieces (some now stretch over several squares) ----------
    chest(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.2, s * 0.32, s * 0.12); rrect(ctx, cx - s * 0.3, cy - s * 0.18, s * 0.6, s * 0.38, s * 0.04, hsl(28, 50, 30), hsl(28, 50, 15), 2); rrect(ctx, cx - s * 0.3, cy - s * 0.22, s * 0.6, s * 0.14, s * 0.05, hsl(28, 50, 38)); ctx.fillStyle = '#b8902a'; ctx.fillRect(cx - s * 0.22, cy - s * 0.22, s * 0.05, s * 0.42); ctx.fillRect(cx + s * 0.17, cy - s * 0.22, s * 0.05, s * 0.42); ellipse(ctx, cx, cy - s * 0.02, s * 0.05, s * 0.05, '#e8c34a'); },
    barrel(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.28, s * 0.2); ellipse(ctx, cx, cy, s * 0.26, s * 0.26, hsl(28, 45, 32), hsl(28, 30, 15), 2); ellipse(ctx, cx, cy, s * 0.2, s * 0.2, null, '#777', 2); ellipse(ctx, cx, cy, s * 0.12, s * 0.12, hsl(28, 40, 26)); },
    crate(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.3, s * 0.2); rrect(ctx, cx - s * 0.27, cy - s * 0.27, s * 0.54, s * 0.54, 2, hsl(35, 40, 42), hsl(30, 40, 20), 2); ctx.strokeStyle = hsl(30, 40, 22); ctx.lineWidth = s / 24; ctx.beginPath(); ctx.moveTo(cx - s * 0.25, cy - s * 0.25); ctx.lineTo(cx + s * 0.25, cy + s * 0.25); ctx.stroke(); },
    table(ctx, r, cx, cy, s, w = 1, h = 1) {
        const tw = w * s - s * 0.16, th = h * s - s * 0.4 * Math.min(1, 1 / h) - (h > 1 ? s * 0.1 : 0);
        const x = cx - tw / 2, y = cy - th / 2;
        shadow(ctx, cx + s * 0.06, cy + s * 0.1, tw / 2, th / 2);
        woodBox(ctx, r, x, y, tw, th, 34, s * 0.06);
        // Plates and candlesticks down a long table; a mug or two on a small one.
        const long = w >= h ? w : h, n = Math.max(1, long * 2 - 1);
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, px = w >= h ? x + t * tw : cx, py = w >= h ? cy : y + t * th;
            if (long > 1 && i % 2 === 0) { ellipse(ctx, px, py + (w >= h ? -th * 0.22 : 0), s * 0.07, s * 0.07, '#e9e4d8', '#9a9384'); ellipse(ctx, px, py + (w >= h ? th * 0.22 : 0), s * 0.07, s * 0.07, '#e9e4d8', '#9a9384'); }
            else if (long > 1) { ellipse(ctx, px, py, s * 0.04, s * 0.04, '#c9a227'); flame(ctx, px, py - s * 0.04, s * 0.05); }
            else if (r() < 0.7) ellipse(ctx, px + between(r, -0.2, 0.2) * s, py, s * 0.06, s * 0.06, '#ddd', '#999');
        }
    },
    chair(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.18, s * 0.12); rrect(ctx, cx - s * 0.16, cy - s * 0.14, s * 0.32, s * 0.3, 2, hsl(28, 40, 32)); ctx.fillStyle = hsl(28, 40, 22); ctx.fillRect(cx - s * 0.16, cy - s * 0.2, s * 0.32, s * 0.07); },
    bed(ctx, r, cx, cy, s, w = 1, h = 1) {
        const bw = w * s - s * 0.2, bh = h * s - s * 0.12, x = cx - bw / 2, y = cy - bh / 2;
        shadow(ctx, cx + s * 0.05, cy + s * 0.08, bw / 2 + 2, bh / 2);
        rrect(ctx, x, y, bw, bh, 3, WOOD(24), WOOD(12), 1.5);
        const sheet = pick(r, ['#8b2e2e', '#2e4f8b', '#5b6b2e', '#6b2e6b', '#8a6a3a']);
        rrect(ctx, x + s * 0.05, y + s * 0.14, bw - s * 0.1, bh - s * 0.2, 3, sheet);
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x + s * 0.05, y + bh * 0.42, bw - s * 0.1, s * 0.05);
        const pillows = Math.max(1, Math.round(w));
        for (let i = 0; i < pillows; i++) rrect(ctx, x + s * 0.08 + i * (bw - s * 0.16) / pillows, y + s * 0.04, (bw - s * 0.16) / pillows - s * 0.04, s * 0.16, 4, '#f1ede4');
    },
    bookshelf(ctx, r, cx, cy, s, w = 1, h = 1) {
        const vertical = h > w, bw = vertical ? s * 0.42 : w * s - s * 0.1, bh = vertical ? h * s - s * 0.1 : s * 0.42;
        const x = cx - bw / 2, y = cy - bh / 2;
        rrect(ctx, x, y, bw, bh, 2, hsl(25, 40, 18), hsl(25, 40, 9), 1.5);
        const n = Math.floor((vertical ? bh : bw) / (s * 0.085));
        for (let i = 0; i < n; i++) {
            if (r() < 0.08) continue;
            ctx.fillStyle = hsl(pick(r, [0, 15, 30, 120, 210, 260, 45]), between(r, 25, 55), between(r, 22, 42));
            if (vertical) ctx.fillRect(x + s * 0.04, y + s * 0.03 + i * s * 0.085, bw - s * 0.08, s * 0.07);
            else ctx.fillRect(x + s * 0.03 + i * s * 0.085, y + s * 0.04, s * 0.07, bh - s * 0.08);
        }
    },
    torch(ctx, r, cx, cy, s) { ctx.fillStyle = '#5a3b22'; ctx.fillRect(cx - s * 0.03, cy - s * 0.02, s * 0.06, s * 0.22); flame(ctx, cx, cy - s * 0.08, s * 0.16); },
    brazier(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.26, s * 0.18); ellipse(ctx, cx, cy, s * 0.24, s * 0.24, '#3a3a3a', '#222', 2); ellipse(ctx, cx, cy, s * 0.17, s * 0.17, '#5c1d0a'); flame(ctx, cx, cy - s * 0.04, s * 0.2); },
    campfire(ctx, r, cx, cy, s) { for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; ellipse(ctx, cx + Math.cos(a) * s * 0.25, cy + Math.sin(a) * s * 0.25, s * 0.07, s * 0.06, hsl(30, 5, 45)); } ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = '#4a2e1a'; ctx.rotate(0.6); ctx.fillRect(-s * 0.2, -s * 0.04, s * 0.4, s * 0.08); ctx.rotate(-1.2); ctx.fillRect(-s * 0.2, -s * 0.04, s * 0.4, s * 0.08); ctx.restore(); flame(ctx, cx, cy - s * 0.04, s * 0.2); },
    candles(ctx, r, cx, cy, s) { for (let i = 0; i < 3; i++) { const x = cx + (i - 1) * s * 0.12, y = cy + between(r, -0.05, 0.05) * s; ctx.fillStyle = '#eee3c8'; ctx.fillRect(x - s * 0.025, y - s * 0.02, s * 0.05, s * 0.1); flame(ctx, x, y - s * 0.05, s * 0.05); } },
    altar(ctx, r, cx, cy, s, w = 1) { const aw = w * s - s * 0.2; shadow(ctx, cx + s * 0.05, cy + s * 0.1, aw / 2, s * 0.24); rrect(ctx, cx - aw / 2, cy - s * 0.22, aw, s * 0.44, 3, hsl(40, 10, 60), hsl(40, 10, 30), 2); ctx.fillStyle = '#7a1c1c'; ctx.fillRect(cx - s * 0.12, cy - s * 0.22, s * 0.24, s * 0.44); },
    statue(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.12, s * 0.3, s * 0.18); rrect(ctx, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 3, hsl(40, 5, 45)); ellipse(ctx, cx, cy, s * 0.17, s * 0.17, hsl(40, 5, 70), hsl(40, 5, 40), 2); ellipse(ctx, cx, cy - s * 0.02, s * 0.08, s * 0.08, hsl(40, 5, 80)); },
    pillar(ctx, r, cx, cy, s) {
        shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.36, s * 0.26);
        rrect(ctx, cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.76, s * 0.06, hsl(30, 6, 34));
        const g = ctx.createRadialGradient(cx - s * 0.1, cy - s * 0.1, s * 0.02, cx, cy, s * 0.32);
        g.addColorStop(0, hsl(30, 6, 70)); g.addColorStop(1, hsl(30, 6, 38));
        ellipse(ctx, cx, cy, s * 0.29, s * 0.29, g);
        for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; line(ctx, cx + Math.cos(a) * s * 0.12, cy + Math.sin(a) * s * 0.12, cx + Math.cos(a) * s * 0.28, cy + Math.sin(a) * s * 0.28, 'rgba(0,0,0,0.12)', 1); }
    },
    throne(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.1, s * 0.3, s * 0.2); rrect(ctx, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 4, '#b8902a', '#6b5216', 2); rrect(ctx, cx - s * 0.2, cy - s * 0.12, s * 0.4, s * 0.36, 3, '#7a1c1c'); },
    coffin(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.24, s * 0.42); ctx.fillStyle = hsl(25, 35, 22); ctx.beginPath(); ctx.moveTo(cx - s * 0.14, cy - s * 0.42); ctx.lineTo(cx + s * 0.14, cy - s * 0.42); ctx.lineTo(cx + s * 0.24, cy - s * 0.18); ctx.lineTo(cx + s * 0.16, cy + s * 0.42); ctx.lineTo(cx - s * 0.16, cy + s * 0.42); ctx.lineTo(cx - s * 0.24, cy - s * 0.18); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#a89060'; ctx.fillRect(cx - s * 0.02, cy - s * 0.2, s * 0.04, s * 0.26); ctx.fillRect(cx - s * 0.09, cy - s * 0.12, s * 0.18, s * 0.04); },
    well(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.08, s * 0.42, s * 0.36); ellipse(ctx, cx, cy, s * 0.4, s * 0.4, hsl(30, 6, 45), hsl(30, 6, 25), 3); for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; line(ctx, cx + Math.cos(a) * s * 0.27, cy + Math.sin(a) * s * 0.27, cx + Math.cos(a) * s * 0.4, cy + Math.sin(a) * s * 0.4, 'rgba(0,0,0,0.3)', 1); } ellipse(ctx, cx, cy, s * 0.26, s * 0.26, hsl(210, 50, 12)); ctx.fillStyle = WOOD(28); ctx.fillRect(cx - s * 0.44, cy - s * 0.04, s * 0.88, s * 0.08); ellipse(ctx, cx, cy, s * 0.06, s * 0.06, '#7a5a2a'); },
    fountain(ctx, r, cx, cy, s, w = 1, h = 1) { const R = Math.min(w, h) * s * 0.46; ellipse(ctx, cx, cy, R, R, hsl(40, 8, 62), hsl(40, 8, 35), 3); ellipse(ctx, cx, cy, R * 0.78, R * 0.78, hsl(195, 50, 40)); for (let i = 1; i < 4; i++) ellipse(ctx, cx, cy, R * 0.18 * i, R * 0.18 * i, null, 'rgba(255,255,255,0.22)', 1); ellipse(ctx, cx, cy, R * 0.18, R * 0.18, hsl(40, 8, 70), hsl(40, 8, 40)); blob(ctx, cx, cy, R * 0.5, 'rgba(220,240,255,0.25)'); },
    cage(ctx, r, cx, cy, s, w = 1, h = 1) { const cw = w * s - s * 0.28, ch = h * s - s * 0.28; rrect(ctx, cx - cw / 2, cy - ch / 2, cw, ch, 2, 'rgba(0,0,0,0.25)', '#555', 3); ctx.strokeStyle = '#666'; ctx.lineWidth = 2; const n = Math.round(cw / (s * 0.14)); for (let i = 1; i < n; i++) { ctx.beginPath(); ctx.moveTo(cx - cw / 2 + i * cw / n, cy - ch / 2); ctx.lineTo(cx - cw / 2 + i * cw / n, cy + ch / 2); ctx.stroke(); } ellipse(ctx, cx + cw / 2 - s * 0.06, cy, s * 0.05, s * 0.07, '#8a7a3a'); },
    anvil(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.08, s * 0.26, s * 0.14); ctx.fillStyle = '#3c3c40'; ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy - s * 0.1); ctx.lineTo(cx + s * 0.22, cy - s * 0.1); ctx.lineTo(cx + s * 0.34, cy - s * 0.02); ctx.lineTo(cx + s * 0.22, cy + s * 0.06); ctx.lineTo(cx - s * 0.3, cy + s * 0.06); ctx.fill(); ctx.fillRect(cx - s * 0.1, cy + s * 0.06, s * 0.16, s * 0.14); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(cx - s * 0.28, cy - s * 0.09, s * 0.48, s * 0.03); },
    cauldron(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.28, s * 0.2); ellipse(ctx, cx, cy, s * 0.28, s * 0.28, '#2b2b2b', '#111', 2); ellipse(ctx, cx, cy, s * 0.2, s * 0.2, '#4caf50'); for (let i = 0; i < 3; i++) ellipse(ctx, cx + between(r, -0.1, 0.1) * s, cy + between(r, -0.1, 0.1) * s, s * 0.03, s * 0.03, 'rgba(220,255,200,0.6)'); blob(ctx, cx, cy, s * 0.4, 'rgba(120,255,120,0.12)'); },
    lever(ctx, r, cx, cy, s) { rrect(ctx, cx - s * 0.1, cy - s * 0.06, s * 0.2, s * 0.14, 2, '#555'); ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = s / 18; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 0.16, cy - s * 0.22); ctx.stroke(); ellipse(ctx, cx + s * 0.16, cy - s * 0.22, s * 0.04, s * 0.04, '#b33'); },
    rug(ctx, r, cx, cy, s, w = 1, h = 1, prop = {}) {
        // One rug, one color, however many squares it covers; a border, an inner pattern and fringe.
        const hue = prop.hue ?? pick(r, [0, 352, 220, 140, 28, 280]);
        const rw = w * s - s * 0.1, rh = h * s - s * 0.1, x = cx - rw / 2, y = cy - rh / 2;
        rrect(ctx, x, y, rw, rh, 3, hsl(hue, 50, 26, 0.95), hsl(42, 60, 45), Math.max(2, s / 22));
        rrect(ctx, x + s * 0.12, y + s * 0.12, rw - s * 0.24, rh - s * 0.24, 2, null, hsl(42, 55, 50, 0.7), Math.max(1, s / 40));
        rrect(ctx, x + s * 0.2, y + s * 0.2, rw - s * 0.4, rh - s * 0.4, 2, hsl(hue, 45, 32, 0.9));
        // Diamonds down the middle.
        const along = rw >= rh, n = Math.max(1, Math.round((along ? rw : rh) / s));
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, dx = along ? x + t * rw : cx, dy = along ? cy : y + t * rh, k = Math.min(s * 0.24, Math.min(rw, rh) * 0.22);
            poly(ctx, [[dx, dy - k], [dx + k, dy], [dx, dy + k], [dx - k, dy]], hsl(42, 55, 48, 0.75));
        }
        ctx.strokeStyle = hsl(42, 40, 70, 0.7); ctx.lineWidth = 1;
        const ends = along ? [[x, y, x, y + rh], [x + rw, y, x + rw, y + rh]] : [[x, y, x + rw, y], [x, y + rh, x + rw, y + rh]];
        for (const [x0, y0, x1, y1] of ends) for (let i = 0; i <= 10; i++) { const t = i / 10, fx = x0 + (x1 - x0) * t, fy = y0 + (y1 - y0) * t; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + (along ? (x0 === x ? -s * 0.06 : s * 0.06) : 0), fy + (along ? 0 : (y0 === y ? -s * 0.06 : s * 0.06))); ctx.stroke(); }
    },
    banner(ctx, r, cx, cy, s, w, h, prop = {}) { faced(ctx, cx, cy, prop.facing, () => { const c = pick(r, ['#8a1c1c', '#1c3a8a', '#1c6b3a', '#5a1c6b']); poly(ctx, [[-s * 0.16, s * 0.12], [s * 0.16, s * 0.12], [s * 0.16, s * 0.58], [0, s * 0.7], [-s * 0.16, s * 0.58]], c); line(ctx, -s * 0.22, s * 0.12, s * 0.22, s * 0.12, '#c9a227', s / 22); ellipse(ctx, 0, s * 0.36, s * 0.06, s * 0.06, '#d9b44a'); }); },
    bones(ctx, r, cx, cy, s) { ctx.strokeStyle = '#e7e0cf'; ctx.lineWidth = s / 20; ctx.lineCap = 'round'; for (let i = 0; i < 3; i++) { const a = r() * Math.PI; ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * s * 0.18, cy - Math.sin(a) * s * 0.18); ctx.lineTo(cx + Math.cos(a) * s * 0.18, cy + Math.sin(a) * s * 0.18); ctx.stroke(); } ctx.lineCap = 'butt'; },
    skull(ctx, r, cx, cy, s) { ellipse(ctx, cx, cy, s * 0.12, s * 0.11, '#e9e2d0'); ellipse(ctx, cx - s * 0.045, cy, s * 0.03, s * 0.03, '#222'); ellipse(ctx, cx + s * 0.045, cy, s * 0.03, s * 0.03, '#222'); ctx.fillStyle = '#e9e2d0'; ctx.fillRect(cx - s * 0.06, cy + s * 0.07, s * 0.12, s * 0.06); },
    web(ctx, r, cx, cy, s) { ctx.strokeStyle = 'rgba(235,235,235,0.55)'; ctx.lineWidth = 1; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * s * 0.45, cy + Math.sin(a) * s * 0.45); ctx.stroke(); } for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, k * s * 0.12, 0, Math.PI * 2); ctx.stroke(); } },
    pot(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.03, cy + s * 0.05, s * 0.16, s * 0.12); ellipse(ctx, cx, cy, s * 0.16, s * 0.16, hsl(18, 50, 40), hsl(18, 40, 22), 2); ellipse(ctx, cx, cy, s * 0.07, s * 0.07, hsl(18, 40, 18)); },
    sack(ctx, r, cx, cy, s) { for (let i = 0; i < 2; i++) { const x = cx + (i ? 0.12 : -0.1) * s, y = cy + (i ? 0.06 : -0.04) * s; shadow(ctx, x + s * 0.03, y + s * 0.06, s * 0.15, s * 0.1); ellipse(ctx, x, y, s * 0.15, s * 0.17, hsl(38, 30, 55), hsl(38, 30, 35), 1.5); } },
    trap(ctx, r, cx, cy, s, w, h, p) {
        const kind = String(p?.label || '').toLowerCase();
        const warn = 'rgba(220,60,60,0.85)';
        if (/pit|hole|drop|chute/.test(kind)) {
            ellipse(ctx, cx, cy, s * 0.34, s * 0.3, 'rgba(8,6,6,0.92)');
            ellipse(ctx, cx, cy - s * 0.04, s * 0.28, s * 0.2, 'rgba(0,0,0,0.95)');
        } else if (/rot|weak|crack|loose|crumbl|collaps|unstable|board|floor/.test(kind)) {
            // Broken floor: cracks spreading from the middle and a sagging dark patch.
            ellipse(ctx, cx, cy, s * 0.3, s * 0.24, 'rgba(0,0,0,0.35)');
            ctx.strokeStyle = 'rgba(15,10,8,0.85)'; ctx.lineWidth = s / 24; ctx.lineJoin = 'round';
            for (let i = 0; i < 6; i++) {
                let a = (i / 6) * Math.PI * 2 + between(r, -0.3, 0.3), x = cx, y = cy;
                ctx.beginPath(); ctx.moveTo(x, y);
                for (let k = 0; k < 3; k++) { a += between(r, -0.5, 0.5); const len = s * between(r, 0.08, 0.14); x += Math.cos(a) * len; y += Math.sin(a) * len; ctx.lineTo(x, y); }
                ctx.stroke();
            }
        } else if (/spike|blade|scythe/.test(kind)) {
            ctx.fillStyle = 'rgba(30,30,34,0.6)'; ctx.fillRect(cx - s * 0.32, cy - s * 0.32, s * 0.64, s * 0.64);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) poly(ctx, [[cx - s * 0.22 + i * s * 0.22 - s * 0.06, cy - s * 0.18 + j * s * 0.2 + s * 0.06], [cx - s * 0.22 + i * s * 0.22, cy - s * 0.18 + j * s * 0.2 - s * 0.08], [cx - s * 0.22 + i * s * 0.22 + s * 0.06, cy - s * 0.18 + j * s * 0.2 + s * 0.06]], '#a9aeb8');
        } else if (/glyph|rune|sigil|ward/.test(kind)) {
            ctx.strokeStyle = 'rgba(150,120,255,0.85)'; ctx.lineWidth = s / 28;
            ctx.beginPath(); ctx.arc(cx, cy, s * 0.28, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * Math.PI * 4 / 5; ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * s * 0.24, cy + Math.sin(a) * s * 0.24); } ctx.closePath(); ctx.stroke();
        } else if (/tripwire|trip wire|wire/.test(kind)) {
            line(ctx, cx - s * 0.48, cy + s * 0.05, cx + s * 0.48, cy - s * 0.05, 'rgba(220,220,230,0.9)', Math.max(1, s / 40));
            ellipse(ctx, cx - s * 0.46, cy + s * 0.05, s * 0.04, s * 0.04, '#3a3a40'); ellipse(ctx, cx + s * 0.46, cy - s * 0.05, s * 0.04, s * 0.04, '#3a3a40');
        } else if (/net|snare|rope/.test(kind)) {
            for (let i = -2; i <= 2; i++) { line(ctx, cx + i * s * 0.12, cy - s * 0.3, cx + i * s * 0.12, cy + s * 0.3, 'rgba(190,160,110,0.9)', s / 30); line(ctx, cx - s * 0.3, cy + i * s * 0.12, cx + s * 0.3, cy + i * s * 0.12, 'rgba(190,160,110,0.9)', s / 30); }
        } else {
            // A pressure plate (darts, gas, a falling block...): a slightly sunken square.
            rrect(ctx, cx - s * 0.26, cy - s * 0.26, s * 0.52, s * 0.52, 2, 'rgba(70,66,62,0.85)', 'rgba(20,18,16,0.9)', s / 22);
        }
        // A small red warning corner: you know it's there.
        poly(ctx, [[cx + s * 0.22, cy - s * 0.42], [cx + s * 0.42, cy - s * 0.42], [cx + s * 0.42, cy - s * 0.22]], warn);
    },
    boulder(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.38, s * 0.26); ellipse(ctx, cx, cy, s * 0.38, s * 0.33, hsl(30, 6, 40)); ellipse(ctx, cx - s * 0.1, cy - s * 0.1, s * 0.16, s * 0.1, 'rgba(255,255,255,0.12)'); crack(ctx, r, cx - s * 0.3, cy - s * 0.3, s * 0.6); },
    bush(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.08, s * 0.32, s * 0.24); for (let i = 0; i < 6; i++) { const a = r() * Math.PI * 2; ellipse(ctx, cx + Math.cos(a) * s * 0.12, cy + Math.sin(a) * s * 0.12, s * 0.2, s * 0.2, hsl(between(r, 95, 125), 40, between(r, 22, 32))); } if (r() < 0.4) for (let i = 0; i < 5; i++) ellipse(ctx, cx + between(r, -0.25, 0.25) * s, cy + between(r, -0.25, 0.25) * s, s * 0.03, s * 0.03, pick(r, ['#e05a8a', '#f5f1e0', '#f5cd3a'])); },
    log(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.1, s * 0.45, s * 0.12); rrect(ctx, cx - s * 0.46, cy - s * 0.12, s * 0.92, s * 0.24, s * 0.12, hsl(25, 35, 26)); ellipse(ctx, cx + s * 0.4, cy, s * 0.07, s * 0.12, hsl(35, 40, 50)); },
    stalagmite(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.3, s * 0.2); ellipse(ctx, cx, cy, s * 0.3, s * 0.3, hsl(28, 12, 30)); ellipse(ctx, cx - s * 0.03, cy - s * 0.03, s * 0.17, s * 0.17, hsl(28, 12, 42)); ellipse(ctx, cx - s * 0.05, cy - s * 0.05, s * 0.06, s * 0.06, hsl(28, 12, 58)); },
    crystal(ctx, r, cx, cy, s) { blob(ctx, cx, cy, s * 0.6, 'rgba(120,200,255,0.25)'); for (let i = 0; i < 4; i++) { const x = cx + between(r, -0.18, 0.18) * s; ctx.fillStyle = hsl(between(r, 190, 280), 70, between(r, 55, 75), 0.9); ctx.beginPath(); ctx.moveTo(x, cy - s * between(r, 0.2, 0.36)); ctx.lineTo(x + s * 0.07, cy + s * 0.15); ctx.lineTo(x - s * 0.07, cy + s * 0.15); ctx.fill(); } },
    mushroom(ctx, r, cx, cy, s) { for (let i = 0; i < 4; i++) { const x = cx + between(r, -0.25, 0.25) * s, y = cy + between(r, -0.25, 0.25) * s, rad = s * between(r, 0.05, 0.1); ellipse(ctx, x, y, rad, rad, pick(r, ['#c0392b', '#b98a54', '#7e57c2'])); ellipse(ctx, x - rad * 0.3, y - rad * 0.3, rad * 0.25, rad * 0.25, 'rgba(255,255,255,0.7)'); } },
    tent(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.45, s * 0.35); ctx.fillStyle = hsl(40, 25, 48); ctx.beginPath(); ctx.moveTo(cx - s * 0.45, cy + s * 0.35); ctx.lineTo(cx, cy - s * 0.4); ctx.lineTo(cx + s * 0.45, cy + s * 0.35); ctx.closePath(); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.4); ctx.lineTo(cx + s * 0.45, cy + s * 0.35); ctx.lineTo(cx, cy + s * 0.35); ctx.fill(); },
    cart(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.42, s * 0.3); rrect(ctx, cx - s * 0.38, cy - s * 0.26, s * 0.76, s * 0.52, 2, hsl(28, 40, 36), hsl(28, 40, 18), 2); for (const dx of [-0.42, 0.42]) ellipse(ctx, cx + dx * s, cy, s * 0.06, s * 0.2, '#3a2a1a'); },

    // ---------- furniture ----------
    wardrobe(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.42, s * 0.26); woodBox(ctx, r, cx - s * 0.42, cy - s * 0.28, s * 0.84, s * 0.56, 22); line(ctx, cx, cy - s * 0.26, cx, cy + s * 0.26, 'rgba(0,0,0,0.5)', 1.5); ellipse(ctx, cx - s * 0.05, cy, s * 0.025, s * 0.025, '#c9a227'); ellipse(ctx, cx + s * 0.05, cy, s * 0.025, s * 0.025, '#c9a227'); rrect(ctx, cx - s * 0.42, cy - s * 0.32, s * 0.84, s * 0.08, 2, WOOD(16)); },
    dresser(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.4, s * 0.22); woodBox(ctx, r, cx - s * 0.4, cy - s * 0.24, s * 0.8, s * 0.48, 36); for (let i = 1; i < 3; i++) line(ctx, cx - s * 0.38, cy - s * 0.24 + i * s * 0.16, cx + s * 0.38, cy - s * 0.24 + i * s * 0.16, 'rgba(0,0,0,0.4)', 1); for (let i = 0; i < 3; i++) for (const d of [-1, 1]) ellipse(ctx, cx + d * s * 0.18, cy - s * 0.16 + i * s * 0.16, s * 0.02, s * 0.02, '#c9a227'); if (r() < 0.6) { ellipse(ctx, cx + s * 0.25, cy - s * 0.12, s * 0.06, s * 0.06, pick(r, ['#5b8db8', '#b85b8d', '#e8e0c8'])); } },
    nightstand(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.2, s * 0.16); woodBox(ctx, r, cx - s * 0.2, cy - s * 0.2, s * 0.4, s * 0.4, 30); ctx.fillStyle = '#eee3c8'; ctx.fillRect(cx - s * 0.03, cy - s * 0.06, s * 0.06, s * 0.1); flame(ctx, cx, cy - s * 0.09, s * 0.05); },
    desk(ctx, r, cx, cy, s, w = 1) { const dw = w * s - s * 0.12; shadow(ctx, cx + s * 0.06, cy + s * 0.1, dw / 2, s * 0.26); woodBox(ctx, r, cx - dw / 2, cy - s * 0.27, dw, s * 0.5, 30); for (let i = 0; i < 3; i++) { ctx.save(); ctx.translate(cx + between(r, -0.25, 0.15) * s, cy + between(r, -0.12, 0.06) * s); ctx.rotate(between(r, -0.4, 0.4)); ctx.fillStyle = '#efe7d2'; ctx.fillRect(-s * 0.09, -s * 0.11, s * 0.18, s * 0.22); ctx.restore(); } ellipse(ctx, cx + dw / 2 - s * 0.14, cy - s * 0.12, s * 0.04, s * 0.04, '#111', '#555'); line(ctx, cx + dw / 2 - s * 0.14, cy - s * 0.12, cx + dw / 2 - s * 0.02, cy - s * 0.3, '#f2f2f2', 1.5); },
    sofa(ctx, r, cx, cy, s, w = 2, h = 1, prop = {}) { const sw = w * s - s * 0.14, sh = h * s - s * 0.3, x = cx - sw / 2, y = cy - sh / 2, c = prop.hue ?? pick(r, [350, 220, 140, 30]); shadow(ctx, cx + s * 0.06, cy + s * 0.1, sw / 2, sh / 2); rrect(ctx, x, y, sw, sh, s * 0.1, hsl(c, 45, 24), hsl(c, 45, 12), 1.5); rrect(ctx, x + s * 0.1, y + s * 0.14, sw - s * 0.2, sh - s * 0.2, s * 0.06, hsl(c, 45, 32)); const n = Math.max(2, Math.round(w)); for (let i = 1; i < n; i++) line(ctx, x + s * 0.1 + i * (sw - s * 0.2) / n, y + s * 0.16, x + s * 0.1 + i * (sw - s * 0.2) / n, y + sh - s * 0.08, 'rgba(0,0,0,0.3)', 1); },
    armchair(ctx, r, cx, cy, s, w, h, prop = {}) { const c = prop.hue ?? pick(r, [350, 220, 140, 30]); shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.28, s * 0.24); rrect(ctx, cx - s * 0.3, cy - s * 0.28, s * 0.6, s * 0.56, s * 0.1, hsl(c, 45, 24), hsl(c, 45, 12), 1.5); rrect(ctx, cx - s * 0.2, cy - s * 0.12, s * 0.4, s * 0.34, s * 0.06, hsl(c, 45, 32)); },
    fireplace(ctx, r, cx, cy, s, w, h, prop = {}) {
        faced(ctx, cx, cy, prop.facing, () => {
            rrect(ctx, -s * 0.5, -s * 0.1, s, s * 0.6, 2, hsl(20, 8, 42), hsl(20, 8, 22), 2);
            for (let i = 0; i < 4; i++) line(ctx, -s * 0.5 + i * s * 0.25, -s * 0.1, -s * 0.5 + i * s * 0.25, s * 0.5, 'rgba(0,0,0,0.2)', 1);
            rrect(ctx, -s * 0.3, s * 0.08, s * 0.6, s * 0.42, s * 0.12, '#140b06');
            for (let i = 0; i < 3; i++) ellipse(ctx, between(r, -0.15, 0.15) * s, s * 0.38, s * 0.12, s * 0.04, '#4a2e1a');
            flame(ctx, -s * 0.08, s * 0.3, s * 0.14); flame(ctx, s * 0.1, s * 0.32, s * 0.11);
            blob(ctx, 0, s * 0.6, s * 0.7, 'rgba(255,140,40,0.22)');
        });
    },
    chandelier(ctx, r, cx, cy, s) { blob(ctx, cx, cy, s * 0.9, 'rgba(255,200,110,0.18)'); ellipse(ctx, cx, cy, s * 0.32, s * 0.32, null, '#c9a227', s / 22); ellipse(ctx, cx, cy, s * 0.08, s * 0.08, '#c9a227'); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, x = cx + Math.cos(a) * s * 0.32, y = cy + Math.sin(a) * s * 0.32; line(ctx, cx, cy, x, y, 'rgba(201,162,39,0.7)', 1); flame(ctx, x, y, s * 0.06); } },
    piano(ctx, r, cx, cy, s, w = 2) { const pw = w * s - s * 0.2; shadow(ctx, cx + s * 0.06, cy + s * 0.1, pw / 2, s * 0.32); rrect(ctx, cx - pw / 2, cy - s * 0.34, pw, s * 0.68, s * 0.16, '#151515', '#000', 1.5); ellipse(ctx, cx + pw * 0.2, cy - s * 0.05, pw * 0.22, s * 0.2, 'rgba(255,255,255,0.06)'); ctx.fillStyle = '#f2efe6'; ctx.fillRect(cx - pw / 2 + s * 0.06, cy + s * 0.14, pw - s * 0.12, s * 0.14); ctx.fillStyle = '#111'; for (let x = cx - pw / 2 + s * 0.1; x < cx + pw / 2 - s * 0.1; x += s * 0.07) ctx.fillRect(x, cy + s * 0.14, s * 0.03, s * 0.08); rrect(ctx, cx - s * 0.2, cy + s * 0.32, s * 0.4, s * 0.12, 2, WOOD(20)); },
    clock(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.2, s * 0.16); woodBox(ctx, r, cx - s * 0.2, cy - s * 0.3, s * 0.4, s * 0.6, 22); ellipse(ctx, cx, cy - s * 0.1, s * 0.13, s * 0.13, '#efe6cf', '#8a6a2a', 1.5); line(ctx, cx, cy - s * 0.1, cx, cy - s * 0.19, '#222', 1.5); line(ctx, cx, cy - s * 0.1, cx + s * 0.07, cy - s * 0.08, '#222', 1.5); ellipse(ctx, cx, cy + s * 0.16, s * 0.05, s * 0.05, '#c9a227'); },
    painting(ctx, r, cx, cy, s, w, h, prop = {}) { faced(ctx, cx, cy, prop.facing, () => { const pw = s * 0.7; rrect(ctx, -pw / 2, s * 0.22, pw, s * 0.24, 1, '#b8902a', '#6b5216', 1.5); const g = ctx.createLinearGradient(0, s * 0.25, 0, s * 0.43); const sky = pick(r, [210, 25, 280, 160]); g.addColorStop(0, hsl(sky, 40, 45)); g.addColorStop(1, hsl(sky + 40, 30, 22)); ctx.fillStyle = g; ctx.fillRect(-pw / 2 + 3, s * 0.25, pw - 6, s * 0.18); if (r() < 0.5) ellipse(ctx, between(r, -0.15, 0.15) * s, s * 0.34, s * 0.05, s * 0.06, hsl(30, 30, 70)); }); },
    mirror(ctx, r, cx, cy, s, w, h, prop = {}) { faced(ctx, cx, cy, prop.facing, () => { ellipse(ctx, 0, s * 0.34, s * 0.22, s * 0.13, '#cfd8dc', '#8a8f94', s / 20); const g = ctx.createLinearGradient(-s * 0.2, s * 0.24, s * 0.2, s * 0.44); g.addColorStop(0, 'rgba(220,240,255,0.9)'); g.addColorStop(1, 'rgba(120,150,180,0.9)'); ellipse(ctx, 0, s * 0.34, s * 0.18, s * 0.1, g); }); },
    armor(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.26, s * 0.2); ellipse(ctx, cx, cy, s * 0.26, s * 0.26, hsl(30, 6, 30)); ellipse(ctx, cx, cy, s * 0.24, s * 0.12, '#8d969e', '#4a5258', 1.5); ellipse(ctx, cx, cy - s * 0.02, s * 0.11, s * 0.11, '#a7b0b8', '#4a5258', 1.5); line(ctx, cx - s * 0.06, cy - s * 0.03, cx + s * 0.06, cy - s * 0.03, '#222', 1.5); line(ctx, cx + s * 0.28, cy - s * 0.3, cx + s * 0.28, cy + s * 0.3, '#9aa1a8', s / 22); },
    weaponrack(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.4, s * 0.12); rrect(ctx, cx - s * 0.42, cy - s * 0.08, s * 0.84, s * 0.16, 2, WOOD(26)); for (let i = 0; i < 4; i++) { const x = cx - s * 0.3 + i * s * 0.2; line(ctx, x, cy - s * 0.36, x, cy + s * 0.3, '#c7cdd2', s / 18); ctx.fillStyle = '#6b4a2a'; ctx.fillRect(x - s * 0.05, cy + s * 0.18, s * 0.1, s * 0.04); } },
    cabinet(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.4, s * 0.22); woodBox(ctx, r, cx - s * 0.4, cy - s * 0.24, s * 0.8, s * 0.48, 26); for (const d of [-1, 1]) { rrect(ctx, cx + d * s * 0.19 - s * 0.16, cy - s * 0.18, s * 0.32, s * 0.36, 1, 'rgba(170,200,220,0.35)', 'rgba(0,0,0,0.4)', 1); line(ctx, cx + d * s * 0.19, cy - s * 0.18, cx + d * s * 0.19, cy + s * 0.18, 'rgba(0,0,0,0.3)', 1); } },
    bathtub(ctx, r, cx, cy, s, w = 2) { const bw = w * s - s * 0.2; shadow(ctx, cx + s * 0.06, cy + s * 0.1, bw / 2, s * 0.3); rrect(ctx, cx - bw / 2, cy - s * 0.3, bw, s * 0.6, s * 0.28, '#f2efe8', '#a8a49a', 2); rrect(ctx, cx - bw / 2 + s * 0.08, cy - s * 0.22, bw - s * 0.16, s * 0.44, s * 0.2, hsl(195, 40, 55)); ellipse(ctx, cx - bw / 2 + s * 0.2, cy, s * 0.04, s * 0.04, '#c9a227'); },
    pew(ctx, r, cx, cy, s, w = 3) { const pw = w * s - s * 0.12; shadow(ctx, cx + s * 0.05, cy + s * 0.1, pw / 2, s * 0.18); woodBox(ctx, r, cx - pw / 2, cy - s * 0.08, pw, s * 0.3, 30); rrect(ctx, cx - pw / 2, cy - s * 0.22, pw, s * 0.1, 2, WOOD(20)); },
    counter(ctx, r, cx, cy, s, w = 3, h = 1) { const vertical = h > w, cw = vertical ? s * 0.6 : w * s - s * 0.06, ch = vertical ? h * s - s * 0.06 : s * 0.6; shadow(ctx, cx + s * 0.06, cy + s * 0.1, cw / 2, ch / 2); woodBox(ctx, r, cx - cw / 2, cy - ch / 2, cw, ch, 26); rrect(ctx, cx - cw / 2, cy - ch / 2, cw, ch, 2, null, WOOD(42), 2); const n = Math.max(1, Math.round((vertical ? h : w) * 1.2)); for (let i = 0; i < n; i++) { if (r() < 0.4) continue; const t = (i + 0.5) / n, x = vertical ? cx : cx - cw / 2 + t * cw, y = vertical ? cy - ch / 2 + t * ch : cy; ellipse(ctx, x, y, s * 0.07, s * 0.07, '#c99a3a', '#5a3b1a', 1.5); } },
    workbench(ctx, r, cx, cy, s, w = 1) { const bw = w * s - s * 0.1; shadow(ctx, cx + s * 0.06, cy + s * 0.1, bw / 2, s * 0.24); woodBox(ctx, r, cx - bw / 2, cy - s * 0.26, bw, s * 0.52, 38); ctx.save(); ctx.translate(cx - s * 0.15, cy); ctx.rotate(0.5); ctx.fillStyle = '#6b4a2a'; ctx.fillRect(-s * 0.02, -s * 0.15, s * 0.04, s * 0.26); ctx.fillStyle = '#555'; ctx.fillRect(-s * 0.08, -s * 0.18, s * 0.16, s * 0.06); ctx.restore(); poly(ctx, [[cx + s * 0.02, cy - s * 0.12], [cx + s * 0.32, cy - s * 0.12], [cx + s * 0.32, cy + s * 0.02], [cx + s * 0.02, cy + s * 0.06]], '#a7b0b8', '#555', 1); },
    forge(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.44, s * 0.36); rrect(ctx, cx - s * 0.44, cy - s * 0.4, s * 0.88, s * 0.8, s * 0.06, hsl(15, 10, 32), hsl(15, 10, 16), 2); rrect(ctx, cx - s * 0.3, cy - s * 0.26, s * 0.6, s * 0.52, s * 0.1, '#1a0d08'); for (let i = 0; i < 9; i++) ellipse(ctx, cx + between(r, -0.22, 0.22) * s, cy + between(r, -0.18, 0.18) * s, s * 0.06, s * 0.05, pick(r, ['#ff6a1a', '#ffb02e', '#c43a0a'])); blob(ctx, cx, cy, s * 0.6, 'rgba(255,120,30,0.35)'); },
    plant(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.04, cy + s * 0.06, s * 0.2, s * 0.15); ellipse(ctx, cx, cy, s * 0.17, s * 0.17, hsl(18, 50, 42), hsl(18, 40, 24), 1.5); for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 + r(); ellipse(ctx, cx + Math.cos(a) * s * 0.15, cy + Math.sin(a) * s * 0.15, s * 0.11, s * 0.05, hsl(between(r, 100, 135), 45, between(r, 22, 36))); } },

    // ---------- horror and dungeon ----------
    rack(ctx, r, cx, cy, s, w = 1, h = 2) { const vertical = h >= w, rw = vertical ? s * 0.62 : w * s - s * 0.16, rh = vertical ? h * s - s * 0.16 : s * 0.62; const x = cx - rw / 2, y = cy - rh / 2; shadow(ctx, cx + s * 0.06, cy + s * 0.1, rw / 2, rh / 2); woodBox(ctx, r, x, y, rw, rh, 24); rrect(ctx, x + s * 0.1, y + s * 0.18, rw - s * 0.2, rh - s * 0.36, 2, hsl(28, 30, 38)); for (const end of [0, 1]) { const ex = vertical ? cx : (end ? x + rw - s * 0.08 : x + s * 0.08), ey = vertical ? (end ? y + rh - s * 0.08 : y + s * 0.08) : cy; ellipse(ctx, ex, ey, s * 0.12, s * 0.07, '#3a2a1a', '#111'); } for (let i = 0; i < 2; i++) line(ctx, vertical ? cx - s * 0.12 + i * s * 0.24 : x + s * 0.1, vertical ? y + s * 0.1 : cy - s * 0.12 + i * s * 0.24, vertical ? cx - s * 0.12 + i * s * 0.24 : x + rw - s * 0.1, vertical ? y + rh - s * 0.1 : cy - s * 0.12 + i * s * 0.24, hsl(40, 30, 60), 1.5); blob(ctx, cx + s * 0.1, cy + s * 0.15, s * 0.3, 'rgba(110,0,0,0.35)'); },
    chains(ctx, r, cx, cy, s, w, h, prop = {}) { faced(ctx, cx, cy, prop.facing, () => { for (const d of [-1, 1]) { for (let i = 0; i < 5; i++) ellipse(ctx, d * s * 0.2, s * 0.08 + i * s * 0.08, s * 0.03, s * 0.045, null, '#7a7f84', 1.5); ellipse(ctx, d * s * 0.2, s * 0.5, s * 0.08, s * 0.07, null, '#5a5f64', s / 18); } }); },
    iron_maiden(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.26, s * 0.4); poly(ctx, [[cx - s * 0.16, cy - s * 0.42], [cx + s * 0.16, cy - s * 0.42], [cx + s * 0.26, cy - s * 0.15], [cx + s * 0.2, cy + s * 0.42], [cx - s * 0.2, cy + s * 0.42], [cx - s * 0.26, cy - s * 0.15]], '#3b3f44', '#16181a', 2); ellipse(ctx, cx, cy - s * 0.25, s * 0.1, s * 0.09, '#5a5f64'); for (let i = 0; i < 6; i++) ellipse(ctx, cx + between(r, -0.13, 0.13) * s, cy + between(r, -0.08, 0.32) * s, s * 0.022, s * 0.022, '#c7cdd2'); line(ctx, cx, cy - s * 0.15, cx, cy + s * 0.4, '#16181a', 1.5); blob(ctx, cx + s * 0.05, cy + s * 0.42, s * 0.22, 'rgba(110,0,0,0.4)'); },
    stocks(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.1, s * 0.42, s * 0.12); woodBox(ctx, r, cx - s * 0.44, cy - s * 0.12, s * 0.88, s * 0.24, 34); line(ctx, cx - s * 0.44, cy, cx + s * 0.44, cy, 'rgba(0,0,0,0.5)', 1.5); for (const [dx, rad] of [[-0.26, 0.06], [0, 0.09], [0.26, 0.06]]) ellipse(ctx, cx + dx * s, cy, s * rad, s * rad * 0.9, '#120a05'); ctx.fillStyle = '#3a2a1a'; ctx.fillRect(cx - s * 0.04, cy + s * 0.12, s * 0.08, s * 0.3); },
    slab(ctx, r, cx, cy, s, w = 1, h = 1) { const sw = w * s - s * 0.14, sh = Math.max(h * s - s * 0.14, s * 0.56); shadow(ctx, cx + s * 0.06, cy + s * 0.1, sw / 2, sh / 2); rrect(ctx, cx - sw / 2, cy - sh / 2, sw, sh, 3, hsl(30, 4, 50), hsl(30, 4, 26), 2); crack(ctx, r, cx - sw / 2, cy - sh / 2, Math.min(sw, sh)); for (const t of [0.3, 0.7]) { const y = cy - sh / 2 + t * sh; ctx.fillStyle = '#3a2a1a'; ctx.fillRect(cx - sw / 2, y - s * 0.03, sw, s * 0.06); ellipse(ctx, cx, y, s * 0.04, s * 0.04, '#8a8f94'); } blob(ctx, cx + between(r, -0.1, 0.1) * s, cy, s * 0.3, 'rgba(120,0,0,0.45)'); },
    hooks(ctx, r, cx, cy, s) { for (let i = 0; i < 3; i++) { const x = cx - s * 0.25 + i * s * 0.25; line(ctx, x, cy - s * 0.4, x, cy + s * 0.05, 'rgba(140,145,150,0.8)', 1.5); ctx.strokeStyle = '#9aa1a8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + s * 0.04, cy + s * 0.08, s * 0.05, Math.PI, Math.PI * 0.2, true); ctx.stroke(); if (r() < 0.4) ellipse(ctx, x + s * 0.04, cy + s * 0.2, s * 0.08, s * 0.12, '#7a2e28', '#3a0e0a'); } },
    kennel(ctx, r, cx, cy, s, w = 1, h = 1) { const kw = w * s - s * 0.14, kh = h * s - s * 0.14, x = cx - kw / 2, y = cy - kh / 2; shadow(ctx, cx + s * 0.06, cy + s * 0.1, kw / 2, kh / 2); poly(ctx, [[x, y + kh * 0.2], [cx, y], [x + kw, y + kh * 0.2], [x + kw, y + kh], [x, y + kh]], WOOD(30), WOOD(14), 2); poly(ctx, [[x, y + kh * 0.2], [cx, y], [cx, y + kh], [x, y + kh]], 'rgba(0,0,0,0.2)'); line(ctx, cx, y, cx, y + kh, WOOD(14), 2); rrect(ctx, cx - kw * 0.2, y + kh * 0.62, kw * 0.4, kh * 0.38, kw * 0.18, '#0f0905'); ctx.strokeStyle = '#6b6f74'; ctx.lineWidth = 2; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(cx - kw * 0.2 + i * kw * 0.1, y + kh * 0.66); ctx.lineTo(cx - kw * 0.2 + i * kw * 0.1, y + kh); ctx.stroke(); } },
    petbed(ctx, r, cx, cy, s) { ellipse(ctx, cx, cy, s * 0.4, s * 0.3, hsl(10, 35, 32), hsl(10, 35, 18), 2); ellipse(ctx, cx, cy, s * 0.28, s * 0.19, hsl(30, 25, 62)); for (let i = 0; i < 3; i++) ellipse(ctx, cx + between(r, -0.15, 0.15) * s, cy + between(r, -0.08, 0.08) * s, s * 0.05, s * 0.02, 'rgba(0,0,0,0.12)'); },
    bowl(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.03, cy + s * 0.05, s * 0.17, s * 0.1); ellipse(ctx, cx, cy, s * 0.16, s * 0.16, '#9aa1a8', '#4a5258', 1.5); ellipse(ctx, cx, cy, s * 0.11, s * 0.11, pick(r, ['#7a4a2a', '#c9b48a', '#5b8db8'])); },

    // ---------- town and outdoors ----------
    sign(ctx, r, cx, cy, s, w, h, prop = {}) { signBoard(ctx, r, cx, cy, s, prop); },
    lamppost(ctx, r, cx, cy, s) { blob(ctx, cx, cy, s * 1.1, 'rgba(255,200,110,0.18)'); shadow(ctx, cx + s * 0.08, cy + s * 0.1, s * 0.1, s * 0.06); ellipse(ctx, cx, cy, s * 0.08, s * 0.08, '#222'); rrect(ctx, cx - s * 0.12, cy - s * 0.12, s * 0.24, s * 0.24, 2, '#ffd27a', '#222', 2); line(ctx, cx - s * 0.12, cy, cx + s * 0.12, cy, '#222', 1); line(ctx, cx, cy - s * 0.12, cx, cy + s * 0.12, '#222', 1); },
    fence(ctx, r, cx, cy, s, w = 1, h = 1) { const vertical = h > w, len = (vertical ? h : w) * s, n = Math.max(2, Math.round(len / (s * 0.5))); const x0 = vertical ? cx : cx - len / 2, y0 = vertical ? cy - len / 2 : cy; for (const off of [-0.08, 0.08]) line(ctx, x0 + (vertical ? off * s : 0), y0 + (vertical ? 0 : off * s), x0 + (vertical ? off * s : len), y0 + (vertical ? len : off * s), WOOD(40), s / 18); for (let i = 0; i <= n; i++) { const t = i / n * len; rrect(ctx, (vertical ? x0 : x0 + t) - s * 0.05, (vertical ? y0 + t : y0) - s * 0.05, s * 0.1, s * 0.1, 1, WOOD(26)); } },
    flowers(ctx, r, cx, cy, s, w = 1, h = 1) { const fw = w * s - s * 0.1, fh = h * s - s * 0.1; rrect(ctx, cx - fw / 2, cy - fh / 2, fw, fh, s * 0.2, hsl(28, 30, 22)); const n = Math.round(14 * w * h); for (let i = 0; i < n; i++) { const x = cx + between(r, -0.45, 0.45) * fw, y = cy + between(r, -0.45, 0.45) * fh; ellipse(ctx, x, y, s * 0.06, s * 0.06, hsl(between(r, 100, 130), 40, 26)); ellipse(ctx, x + s * 0.02, y - s * 0.02, s * 0.035, s * 0.035, pick(r, ['#e05a8a', '#f5f1e0', '#f5cd3a', '#9b59d0', '#e8603c'])); } },
    hay(ctx, r, cx, cy, s) { for (const [dx, dy] of [[-0.18, -0.12], [0.16, -0.08], [0, 0.18]]) { shadow(ctx, cx + dx * s + s * 0.04, cy + dy * s + s * 0.06, s * 0.2, s * 0.13); rrect(ctx, cx + dx * s - s * 0.2, cy + dy * s - s * 0.13, s * 0.4, s * 0.26, 3, hsl(45, 55, 55), hsl(40, 50, 32), 1.5); for (let i = 0; i < 4; i++) line(ctx, cx + dx * s - s * 0.18, cy + dy * s - s * 0.1 + i * s * 0.06, cx + dx * s + s * 0.18, cy + dy * s - s * 0.1 + i * s * 0.06, 'rgba(120,80,20,0.35)', 1); } },
    trough(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.05, cy + s * 0.08, s * 0.42, s * 0.18); woodBox(ctx, r, cx - s * 0.44, cy - s * 0.18, s * 0.88, s * 0.36, 30); rrect(ctx, cx - s * 0.36, cy - s * 0.1, s * 0.72, s * 0.2, 2, hsl(195, 40, 38)); },
    tombstone(ctx, r, cx, cy, s) { shadow(ctx, cx + s * 0.06, cy + s * 0.1, s * 0.24, s * 0.12); ctx.beginPath(); ctx.moveTo(cx - s * 0.22, cy + s * 0.14); ctx.lineTo(cx - s * 0.22, cy - s * 0.06); ctx.arc(cx, cy - s * 0.06, s * 0.22, Math.PI, 0); ctx.lineTo(cx + s * 0.22, cy + s * 0.14); ctx.closePath(); ctx.fillStyle = hsl(30, 4, between(r, 48, 60)); ctx.fill(); ctx.strokeStyle = hsl(30, 4, 28); ctx.lineWidth = 1.5; ctx.stroke(); line(ctx, cx, cy - s * 0.18, cx, cy + s * 0.06, 'rgba(0,0,0,0.4)', 1.5); line(ctx, cx - s * 0.07, cy - s * 0.1, cx + s * 0.07, cy - s * 0.1, 'rgba(0,0,0,0.4)', 1.5); ellipse(ctx, cx, cy + s * 0.3, s * 0.2, s * 0.08, hsl(28, 30, 22)); },
    stall(ctx, r, cx, cy, s, w = 2, h = 2) { const sw = w * s - s * 0.12, sh = h * s - s * 0.12, x = cx - sw / 2, y = cy - sh / 2; shadow(ctx, cx + s * 0.08, cy + s * 0.12, sw / 2, sh / 2); const c = pick(r, [0, 210, 130, 45, 280]); const stripes = Math.max(4, Math.round(sw / (s * 0.25))); for (let i = 0; i < stripes; i++) { ctx.fillStyle = i % 2 ? hsl(c, 55, 42) : '#efe8d8'; ctx.fillRect(x + i * sw / stripes, y, sw / stripes + 0.5, sh * 0.55); } ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x, y + sh * 0.27, sw, sh * 0.28); for (let i = 0; i < stripes; i++) ellipse(ctx, x + (i + 0.5) * sw / stripes, y + sh * 0.55, sw / stripes / 2, s * 0.05, i % 2 ? hsl(c, 55, 42) : '#efe8d8'); woodBox(ctx, r, x + s * 0.08, y + sh * 0.62, sw - s * 0.16, sh * 0.32, 34); for (let i = 0; i < 4; i++) ellipse(ctx, x + s * 0.2 + i * (sw - s * 0.4) / 3, y + sh * 0.78, s * 0.07, s * 0.07, pick(r, ['#c0392b', '#e8a33c', '#7cb342', '#8e6bbf'])); },

    // ---------- marks on the floor ----------
    debris(ctx, r, cx, cy, s, w = 1, h = 1, prop = {}) {
        // What's left of something smashed: splinters and planks, stone chunks, or glass and metal bits.
        const stone = /statue|altar|pillar|tombstone|well|fountain|boulder|stalagmite|slab|coffin_stone/.test(prop.was || ''), metal = /armor|anvil|iron|cage|weapon|forge|brazier|cauldron/.test(prop.was || '');
        const n = Math.round(9 * w * h);
        for (let i = 0; i < n; i++) {
            const x = cx + between(r, -0.45, 0.45) * w * s, y = cy + between(r, -0.42, 0.42) * h * s;
            ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI);
            if (stone) { ctx.fillStyle = hsl(30, 5, between(r, 38, 62)); ctx.beginPath(); ctx.moveTo(-s * 0.06, -s * 0.04); ctx.lineTo(s * 0.05, -s * 0.06); ctx.lineTo(s * 0.07, s * 0.04); ctx.lineTo(-s * 0.04, s * 0.05); ctx.fill(); }
            else if (metal) { ctx.fillStyle = hsl(210, 5, between(r, 30, 55)); ctx.fillRect(-s * 0.08, -s * 0.015, s * 0.16, s * 0.03); }
            else { const len = s * between(r, 0.16, 0.42), th = s * between(r, 0.06, 0.1); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-len / 2 + 2, -th / 2 + 3, len, th); ctx.fillStyle = hsl(28, 45, between(r, 26, 44)); ctx.beginPath(); ctx.moveTo(-len / 2, -th / 2); ctx.lineTo(len / 2, -th / 2); ctx.lineTo(len / 2 - th * 0.8, th / 2); ctx.lineTo(-len / 2, th / 2); ctx.fill(); ctx.strokeStyle = hsl(28, 45, 14); ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = 'rgba(255,230,190,0.25)'; ctx.fillRect(-len / 2, -th / 2, len * 0.8, th * 0.25); }
            ctx.restore();
        }
        for (let i = 0; i < 12 * w * h; i++) ellipse(ctx, cx + between(r, -0.45, 0.45) * w * s, cy + between(r, -0.42, 0.42) * h * s, s * 0.012, s * 0.012, stone ? 'rgba(200,190,170,0.6)' : 'rgba(120,80,40,0.6)');
    },
    blood(ctx, r, cx, cy, s) { const n = 3 + Math.floor(r() * 4); for (let i = 0; i < n; i++) { const x = cx + between(r, -0.3, 0.3) * s, y = cy + between(r, -0.3, 0.3) * s, rad = s * between(r, 0.04, 0.16); ellipse(ctx, x, y, rad, rad * between(r, 0.6, 1), `rgba(${Math.round(between(r, 90, 130))},0,0,${between(r, 0.55, 0.8)})`); } for (let i = 0; i < 6; i++) ellipse(ctx, cx + between(r, -0.45, 0.45) * s, cy + between(r, -0.45, 0.45) * s, s * 0.015, s * 0.015, 'rgba(110,0,0,0.7)'); if (r() < 0.4) { ctx.strokeStyle = 'rgba(100,0,0,0.5)'; ctx.lineWidth = s * 0.05; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + between(r, -0.4, 0.4) * s, cy + between(r, -0.4, 0.4) * s); ctx.stroke(); ctx.lineCap = 'butt'; } },
    scratches(ctx, r, cx, cy, s) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(between(r, -0.8, 0.8)); for (let i = 0; i < 4; i++) { const x = -s * 0.15 + i * s * 0.1; line(ctx, x, -s * 0.3, x + s * 0.05, s * 0.3, 'rgba(0,0,0,0.45)', s / 30); line(ctx, x + 1, -s * 0.3, x + s * 0.05 + 1, s * 0.3, 'rgba(255,255,255,0.12)', 1); } ctx.restore(); },
    papers(ctx, r, cx, cy, s) { for (let i = 0; i < 4; i++) { ctx.save(); ctx.translate(cx + between(r, -0.28, 0.28) * s, cy + between(r, -0.28, 0.28) * s); ctx.rotate(between(r, -1, 1)); ctx.fillStyle = pick(r, ['#efe7d2', '#e6dcc0', '#f4efe2']); ctx.fillRect(-s * 0.09, -s * 0.12, s * 0.18, s * 0.24); for (let k = 0; k < 4; k++) line(ctx, -s * 0.06, -s * 0.08 + k * s * 0.05, s * 0.06, -s * 0.08 + k * s * 0.05, 'rgba(0,0,0,0.25)', 1); ctx.restore(); } },
    ash(ctx, r, cx, cy, s) {
        // What's left after a fire: a heap of grey ash with charcoal chunks and a dying ember or two.
        blob(ctx, cx, cy, s * 0.45, 'rgba(10,8,6,0.55)');
        ellipse(ctx, cx, cy + s * 0.04, s * 0.3, s * 0.2, 'rgba(95,90,86,0.75)');
        for (let i = 0; i < 7; i++) {
            ctx.save(); ctx.translate(cx + between(r, -0.26, 0.26) * s, cy + between(r, -0.18, 0.2) * s); ctx.rotate(r() * Math.PI);
            ctx.fillStyle = hsl(20, 10, between(r, 6, 14)); ctx.fillRect(-s * between(r, 0.05, 0.13), -s * 0.025, s * between(r, 0.1, 0.26), s * 0.05);
            ctx.restore();
        }
        for (let i = 0; i < 18; i++) ellipse(ctx, cx + between(r, -0.32, 0.32) * s, cy + between(r, -0.24, 0.26) * s, s * 0.014, s * 0.014, `rgba(190,185,178,${between(r, 0.3, 0.7)})`);
        if (r() < 0.6) ellipse(ctx, cx + between(r, -0.15, 0.15) * s, cy + between(r, -0.1, 0.1) * s, s * 0.022, s * 0.016, 'rgba(230,90,30,0.7)');
    },
    stain(ctx, r, cx, cy, s) { for (let i = 0; i < 4; i++) blob(ctx, cx + between(r, -0.15, 0.15) * s, cy + between(r, -0.15, 0.15) * s, s * between(r, 0.2, 0.4), `rgba(${pick(r, ['50,35,20', '30,40,20', '60,20,20'])},0.45)`); },
};
