// The "building your map" animation: a chat message (hidden from the bot) where a little map
// assembles itself block by block (floors drop in, walls rise, doors flash, torches light) while
// Claude plans the place. When it's done, the message becomes a one-line summary.

import { ST } from '../st/st.js';
import { postNote } from '../st/messages.js';

const COLS = 30, ROWS = 15;

function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A random little floor plan: rooms joined by corridors, as a build order of blocks. */
function makeLayout(seed) {
    const r = rng(seed);
    const grid = [...Array(ROWS)].map(() => Array(COLS).fill(null));
    const rooms = [];
    for (let tries = 0; tries < 60 && rooms.length < 7; tries++) {
        const w = 4 + Math.floor(r() * 5), h = 3 + Math.floor(r() * 4);
        const x = 1 + Math.floor(r() * (COLS - w - 2)), y = 1 + Math.floor(r() * (ROWS - h - 2));
        if (rooms.some(o => x < o.x + o.w + 2 && x + w + 2 > o.x && y < o.y + o.h + 2 && y + h + 2 > o.y)) continue;
        rooms.push({ x, y, w, h });
    }
    const order = [];
    const set = (x, y, t) => { if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return; if (grid[y][x] && grid[y][x] !== 'wall') return; if (grid[y][x] === 'wall' && t === 'wall') return; grid[y][x] = t; order.push({ x, y, t }); };
    rooms.forEach((rm, i) => {
        for (let y = rm.y; y < rm.y + rm.h; y++) for (let x = rm.x; x < rm.x + rm.w; x++) set(x, y, 'floor');
        if (i > 0) {
            // A corridor to the previous room.
            const a = rooms[i - 1], ax = a.x + Math.floor(a.w / 2), ay = a.y + Math.floor(a.h / 2), bx = rm.x + Math.floor(rm.w / 2), by = rm.y + Math.floor(rm.h / 2);
            for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) set(x, ay, 'floor');
            for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) set(bx, y, 'floor');
        }
    });
    // Walls around everything, then doors where corridors meet rooms, then torches.
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        if (grid[y][x]) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => grid[y + dy]?.[x + dx] === 'floor')) set(x, y, 'wall');
    }
    for (const rm of rooms) {
        for (let x = rm.x; x < rm.x + rm.w; x++) for (const y of [rm.y - 1, rm.y + rm.h]) if (grid[y]?.[x] === 'floor') order.push({ x, y, t: 'door' });
        if (r() < 0.8) order.push({ x: rm.x + Math.floor(r() * rm.w), y: rm.y, t: 'torch' });
    }
    return order;
}

/**
 * Post the animation message and start it.
 * @returns {Promise<{cycle:(captions:string[])=>void, step:(text:string)=>void, finish:(md:string)=>Promise<void>, fail:(msg:string)=>Promise<void>}>}
 */
export async function startBuildAnimation(name, { big = false } = {}) {
    const id = await postNote(`🗺️ *Building ${name}…*`);
    const host = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
    let alive = true, caption = big ? 'Planning every room' : 'Sketching the map', timer = null;
    const box = document.createElement('div');
    box.className = 'dm-build';
    box.innerHTML = `<div class="dm-build-title"></div><canvas width="600" height="300"></canvas><div class="dm-build-caption"></div>`;
    box.querySelector('.dm-build-title').textContent = `Building ${name}`;
    host?.appendChild(box);
    const canvas = box.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const cap = box.querySelector('.dm-build-caption');
    const s = canvas.width / COLS;
    const palette = big
        ? { bg: '#120d0b', floor: ['#6b4a2e', '#7a5636', '#5f4128'], wall: ['#4b1f26', '#5a2630'], top: '#8a3b47', door: '#e8c34a' }
        : { bg: '#0e1113', floor: ['#57606a', '#626b75', '#4d555e'], wall: ['#2b2f35', '#33383f'], top: '#5b6470', door: '#e8c34a' };
    let order = makeLayout(Date.now()), start = performance.now(), seed = Date.now();
    const STAGGER = big ? 9 : 14, FALL = 420;

    let lostSince = 0;
    const draw = now => {
        if (!alive) return;
        // SillyTavern re-renders chat messages now and then (that used to stop the drawing after a
        // couple of seconds): put the box back into the message. Stop only if the message is gone for good.
        if (!document.body.contains(canvas)) {
            const home = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (home) { home.appendChild(box); lostSince = 0; }
            else {
                lostSince ||= now;
                if (now - lostSince > 8000) return;
                requestAnimationFrame(draw);
                return;
            }
        }
        const t = now - start;
        ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Faint blueprint grid underneath.
        ctx.strokeStyle = 'rgba(120,170,255,0.08)'; ctx.lineWidth = 1;
        for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(x * s + 0.5, 0); ctx.lineTo(x * s + 0.5, canvas.height); ctx.stroke(); }
        for (let y = 0; y <= ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * s + 0.5); ctx.lineTo(canvas.width, y * s + 0.5); ctx.stroke(); }
        let done = true;
        order.forEach((b, i) => {
            const bt = t - i * STAGGER;
            if (bt < 0) { done = false; return; }
            const p = Math.min(1, bt / FALL);
            if (p < 1) done = false;
            // Ease out with a small bounce as each block lands.
            const ease = p < 1 ? 1 - Math.pow(1 - p, 3) + Math.sin(p * Math.PI) * 0.08 : 1;
            const px = b.x * s, py = b.y * s - (1 - ease) * (b.y * s + s * 3);
            ctx.globalAlpha = Math.min(1, p * 2);
            if (b.t === 'floor') {
                ctx.fillStyle = palette.floor[(b.x * 7 + b.y * 3) % palette.floor.length]; ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
                ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(px + 1, py + 1, s - 2, 3);
            } else if (b.t === 'wall') {
                ctx.fillStyle = palette.wall[(b.x + b.y) % 2]; ctx.fillRect(px, py, s, s);
                ctx.fillStyle = palette.top; ctx.fillRect(px, py, s, 4);
                ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px, py + s - 4, s, 4);
            } else if (b.t === 'door') {
                // The flash plays once the door has landed (before that the ring had a negative size,
                // which threw and stopped the whole animation a couple of seconds in).
                const flash = bt < FALL ? 0 : Math.max(0, Math.min(1, 1 - (bt - FALL) / 500));
                ctx.fillStyle = palette.door; ctx.fillRect(px + s * 0.2, py + s * 0.35, s * 0.6, s * 0.3);
                if (flash > 0) { ctx.fillStyle = `rgba(255,230,140,${flash * 0.6})`; ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, s * (0.6 + (1 - flash)), 0, Math.PI * 2); ctx.fill(); }
            } else if (b.t === 'torch') {
                const flick = 0.7 + Math.sin(now / 90 + b.x) * 0.15 + Math.sin(now / 37 + b.y) * 0.1;
                const g = ctx.createRadialGradient(px + s / 2, py + s / 2, 0, px + s / 2, py + s / 2, s * 2.4);
                g.addColorStop(0, `rgba(255,170,60,${0.45 * flick})`); g.addColorStop(1, 'rgba(255,170,60,0)');
                ctx.fillStyle = g; ctx.fillRect(px - s * 2, py - s * 2, s * 5, s * 5);
                ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, s * 0.18 * flick + 2, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;
        });
        // When a sketch is finished, hold it a moment and start a fresh one.
        if (done && t > order.length * STAGGER + FALL + 1400) { seed += 7919; order = makeLayout(seed); start = now; }
        requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);

    const dots = () => { cap.textContent = `${caption}${'.'.repeat(1 + Math.floor(Date.now() / 450) % 3)}`; };
    const dotTimer = setInterval(dots, 450);
    dots();

    const end = async (markdown) => {
        alive = false;
        clearInterval(dotTimer);
        if (timer) clearInterval(timer);
        const msg = ST.chat[id];
        if (!msg) return;
        msg.mes = markdown;
        if (Array.isArray(msg.swipes)) msg.swipes[0] = markdown;
        ST.updateMessageBlock(id, msg);
        await ST.saveChat();
    };
    return {
        cycle(captions) {
            if (timer) clearInterval(timer);
            let i = 0;
            caption = captions[0] ?? caption;
            timer = setInterval(() => { i = (i + 1) % captions.length; caption = captions[i]; }, 3200);
        },
        step(text) {
            if (timer) { clearInterval(timer); timer = null; }
            caption = text;
        },
        finish: end,
        fail: msg => end(`🗺️ *Couldn't build ${name}: ${msg}*`),
    };
}
