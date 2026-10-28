// Someone caught in a trap, drawn on the map until their save frees them (or the DM does): a snare
// yanks them up by the foot and they dangle upside down; a net drops over them; a pit swallows them
// to the chest; darts stick in them; spikes, gas, flames, falling stone or steel jaws hold them where
// they stand; an alarm rings a bell over their head. Every trap starts with a flash and a "!".

import { drawFigure } from './sprite-render.js';

const ease = t => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/**
 * Draw a caught figure on its square.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} look the figure
 * @param {{look:string, at:number}} caught what kind of trap and when it went off (Date.now())
 * @param {number} px left of the square, py top of the square, tile its size
 * @param {{flip?:boolean, offset?:number}} o
 */
export function drawCaught(ctx, look, caught, px, py, tile, { flip = false, offset = 0 } = {}) {
    const age = Date.now() - (caught.at || 0);
    const now = performance.now() + offset;
    const t = ease(age / 450);
    const cx = px + tile / 2, feet = py + tile * 0.84;
    const fig = (x, y, anim, extra = {}) => drawFigure(ctx, look, x, y, tile, { anim, elapsed: now, flip, ...extra });
    const struggle = age < 600 ? 'hurt' : 'injured';
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    switch (caught.look) {
        case 'snare': {
            // Yanked up by one foot, dangling and swinging from a rope.
            const lift = tile * 0.42 * t, swing = age > 450 ? Math.sin(age / 420) * 0.2 : 0;
            ctx.translate(cx, py + tile * 0.12 - lift);
            ctx.rotate(swing);
            ctx.strokeStyle = '#c9a26a'; ctx.lineWidth = Math.max(2, tile / 18);
            ctx.beginPath(); ctx.moveTo(0, tile * 0.02); ctx.lineTo(0, -tile * 1.4); ctx.stroke();
            ctx.strokeStyle = '#8a6a3c'; ctx.lineWidth = Math.max(1, tile / 30);
            for (let y = -tile * 1.35; y < 0; y += tile * 0.12) { ctx.beginPath(); ctx.moveTo(-tile * 0.03, y); ctx.lineTo(tile * 0.03, y + tile * 0.05); ctx.stroke(); }
            ctx.scale(1, -1);
            drawFigure(ctx, look, -tile / 2, -tile * 0.95, tile, { anim: 'idle', elapsed: now, flip });
            ctx.scale(1, -1);
            // The noose round the ankle.
            ctx.strokeStyle = '#c9a26a'; ctx.lineWidth = Math.max(2, tile / 18);
            ctx.beginPath(); ctx.ellipse(0, tile * 0.04, tile * 0.09, tile * 0.05, 0, 0, Math.PI * 2); ctx.stroke();
            break;
        }
        case 'net': {
            fig(px, py - tile * 0.06, struggle);
            const drop = (1 - t) * tile * 0.8;
            ctx.translate(0, -drop);
            ctx.strokeStyle = 'rgba(225,212,180,0.95)'; ctx.lineWidth = Math.max(1, tile / 36);
            const l = px + tile * 0.12, r = px + tile * 0.88, top = py + tile * 0.05, bot = feet + tile * 0.04;
            for (let i = 0; i <= 5; i++) {
                const x = l + (r - l) * i / 5;
                ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + (i - 2.5) * tile * 0.03, bot); ctx.stroke();
                const y = top + (bot - top) * i / 5;
                ctx.beginPath(); ctx.moveTo(l, y); ctx.quadraticCurveTo(cx, y + tile * 0.05, r, y); ctx.stroke();
            }
            ctx.fillStyle = '#6b6f73';
            for (const x of [l, r, cx]) { ctx.beginPath(); ctx.arc(x, bot, tile * 0.04, 0, Math.PI * 2); ctx.fill(); }
            break;
        }
        case 'pit': {
            // The floor gives way: they drop in to the chest, arms up.
            const hole = feet - tile * 0.02;
            ctx.fillStyle = '#0b0806';
            ctx.beginPath(); ctx.ellipse(cx, hole, tile * 0.44 * Math.max(0.3, t), tile * 0.2 * Math.max(0.3, t), 0, 0, Math.PI * 2); ctx.fill();
            ctx.save();
            ctx.beginPath(); ctx.rect(px - tile, py - tile, tile * 3, hole - (py - tile)); ctx.clip();
            fig(px, py - tile * 0.06 + tile * 0.3 * t, 'hurt');
            ctx.restore();
            ctx.strokeStyle = 'rgba(90,70,50,0.9)'; ctx.lineWidth = Math.max(2, tile / 20);
            ctx.beginPath(); ctx.ellipse(cx, hole, tile * 0.44 * Math.max(0.3, t), tile * 0.2 * Math.max(0.3, t), 0, 0, Math.PI); ctx.stroke();
            break;
        }
        case 'darts': {
            fig(px, py - tile * 0.06, struggle, { red: age < 600 && Math.floor(age / 110) % 2 === 0 });
            const hits = [[-0.12, 0.42, 0.3], [0.1, 0.55, -0.2], [-0.02, 0.68, 0.1]];
            hits.forEach(([dx, dy, a], i) => {
                const fly = ease((age - i * 80) / 220);
                if (fly <= 0) return;
                const x = cx + dx * tile - (1 - fly) * tile * 1.2, y = py + dy * tile;
                ctx.save(); ctx.translate(x, y); ctx.rotate(a);
                ctx.fillStyle = '#5b5148'; ctx.fillRect(-tile * 0.14, -tile * 0.015, tile * 0.16, tile * 0.03);
                ctx.fillStyle = '#d14b3c'; ctx.fillRect(-tile * 0.17, -tile * 0.04, tile * 0.05, tile * 0.08);
                ctx.restore();
            });
            break;
        }
        case 'blades': {
            fig(px, py - tile * 0.06, struggle, { red: age < 600 && Math.floor(age / 110) % 2 === 0 });
            ctx.fillStyle = '#b9c0c7'; ctx.strokeStyle = '#4e555c'; ctx.lineWidth = 1;
            for (const dx of [-0.36, -0.18, 0.18, 0.36]) {
                const h = tile * 0.32 * t, x = cx + dx * tile;
                ctx.beginPath(); ctx.moveTo(x - tile * 0.06, feet + tile * 0.06); ctx.lineTo(x, feet + tile * 0.06 - h); ctx.lineTo(x + tile * 0.06, feet + tile * 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
            }
            break;
        }
        case 'gas': {
            fig(px, py - tile * 0.06, 'injured');
            for (let i = 0; i < 5; i++) {
                const a = i * 1.3 + age / 900, r = tile * (0.22 + 0.06 * Math.sin(age / 500 + i));
                const g = ctx.createRadialGradient(cx + Math.cos(a) * r, py + tile * 0.45 + Math.sin(a) * r * 0.6, 0, cx + Math.cos(a) * r, py + tile * 0.45 + Math.sin(a) * r * 0.6, tile * 0.32);
                g.addColorStop(0, `rgba(120,190,60,${0.45 * t})`); g.addColorStop(1, 'rgba(120,190,60,0)');
                ctx.fillStyle = g; ctx.fillRect(px - tile * 0.3, py - tile * 0.2, tile * 1.6, tile * 1.4);
            }
            break;
        }
        case 'fire': {
            fig(px, py - tile * 0.06, struggle, { red: age < 600 && Math.floor(age / 110) % 2 === 0 });
            for (let i = 0; i < 4; i++) {
                const x = cx + (i - 1.5) * tile * 0.18, h = tile * (0.25 + 0.12 * Math.abs(Math.sin(age / 120 + i * 1.7))) * t;
                ctx.fillStyle = 'rgba(255,120,30,0.9)';
                ctx.beginPath(); ctx.moveTo(x - tile * 0.08, feet); ctx.quadraticCurveTo(x, feet - h * 1.4, x + tile * 0.08, feet); ctx.fill();
                ctx.fillStyle = 'rgba(255,225,120,0.9)';
                ctx.beginPath(); ctx.moveTo(x - tile * 0.04, feet); ctx.quadraticCurveTo(x, feet - h * 0.8, x + tile * 0.04, feet); ctx.fill();
            }
            break;
        }
        case 'crush': {
            fig(px, py - tile * 0.06, struggle);
            const fall = (1 - t) * tile * 1.2;
            const rocks = [[-0.25, 0.05, 0.16], [0.02, 0.0, 0.2], [0.27, 0.06, 0.15], [-0.1, -0.12, 0.14], [0.15, -0.1, 0.13]];
            for (const [dx, dy, r] of rocks) {
                ctx.fillStyle = '#7d7468'; ctx.strokeStyle = '#3f3a33'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.ellipse(cx + dx * tile, feet + dy * tile - fall, r * tile, r * tile * 0.75, dx, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
            if (age < 1200) { ctx.fillStyle = `rgba(180,170,150,${0.4 * (1 - age / 1200)})`; ctx.beginPath(); ctx.ellipse(cx, feet, tile * 0.6, tile * 0.25, 0, 0, Math.PI * 2); ctx.fill(); }
            break;
        }
        case 'jaws': {
            fig(px, py - tile * 0.06, struggle);
            ctx.strokeStyle = '#8d949b'; ctx.lineWidth = Math.max(2, tile / 16);
            const gap = tile * 0.12 * (1 - t);
            ctx.beginPath(); ctx.arc(cx, feet - gap, tile * 0.16, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
            ctx.beginPath(); ctx.arc(cx, feet + gap, tile * 0.16, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke();
            ctx.fillStyle = '#c4cad0';
            for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * tile * 0.06 - 1, feet - tile * 0.05, 2, tile * 0.1);
            break;
        }
        case 'alarm': {
            fig(px, py - tile * 0.06, 'idle');
            const shake = Math.sin(age / 50) * 0.35;
            ctx.save(); ctx.translate(cx + tile * 0.32, py - tile * 0.05); ctx.rotate(shake);
            ctx.fillStyle = '#e0b84a'; ctx.strokeStyle = '#7a5b14'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-tile * 0.1, tile * 0.08); ctx.quadraticCurveTo(-tile * 0.1, -tile * 0.12, 0, -tile * 0.12); ctx.quadraticCurveTo(tile * 0.1, -tile * 0.12, tile * 0.1, tile * 0.08); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.restore();
            ctx.strokeStyle = 'rgba(255,230,140,0.7)'; ctx.lineWidth = 1.5;
            for (let i = 1; i <= 2; i++) { ctx.beginPath(); ctx.arc(cx + tile * 0.32, py - tile * 0.05, tile * (0.12 + i * 0.08 + (age % 600) / 6000), -0.6, 0.6); ctx.stroke(); }
            break;
        }
        default:
            fig(px, py - tile * 0.06, struggle);
    }
    ctx.restore();
    // It just went off: a flash at their feet and a "!" over their head.
    if (age < 500) {
        const k = age / 500;
        ctx.strokeStyle = `rgba(255,70,40,${1 - k})`; ctx.lineWidth = Math.max(2, tile / 12);
        ctx.beginPath(); ctx.ellipse(cx, feet, tile * (0.3 + k * 0.6), tile * (0.12 + k * 0.25), 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (age < 1800) {
        const hop = Math.abs(Math.sin(age / 140)) * tile * 0.06, y = py - tile * (caught.look === 'snare' ? 0.75 : 0.32) - hop;
        ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx - tile * 0.13, y - tile * 0.2, tile * 0.26, tile * 0.3, tile * 0.06);
        else ctx.rect(cx - tile * 0.13, y - tile * 0.2, tile * 0.26, tile * 0.3);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#d32f2f'; ctx.font = `bold ${Math.round(tile * 0.26)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, y - tile * 0.05);
    }
}
