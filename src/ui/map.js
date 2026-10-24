// Battle map: pops up when combat starts. A chess-style grid (a1 bottom-left) with portraits,
// terrain and HP. Tap a square to move there, or tap an enemy to target it; the plugin writes
// "(move to d4)" / "(target Bandit 1)" into your message box so you can add what you do.
// Claude never sees an image: it reads and writes the map as plain text.

import { campaign } from '../st/campaign.js';
import { parseCoord, toCoord, colName, terrainAt, distance, isWalkable, TERRAIN, PROPS, activeMap } from '../core/grid.js';
import { paintMapBase, squareName } from './tiles.js';
import { escapeHtml } from '../core/text.js';

const MOVE_SQUARES = 6; // 30 ft; shown as a hint, Claude makes the call

let panel = null;
let selection = { move: '', target: '' };

function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'dm-map';
    panel.className = 'dm-map dm-hidden';
    document.body.appendChild(panel);
    return panel;
}

export function openMap() {
    const c = campaign();
    if (!activeMap(c?.docs.world)) {
        toastr.info('No map right now. It appears in fights and in places where exact squares matter.', 'Dungeon Master');
        return;
    }
    ensurePanel().classList.remove('dm-hidden', 'dm-map-min');
    selection = { move: '', target: '' };
    renderMap();
}

export function closeMap() {
    panel?.classList.add('dm-hidden');
}

export function refreshMap() {
    if (panel && !panel.classList.contains('dm-hidden')) renderMap();
}

export function toggleMap() {
    if (panel && !panel.classList.contains('dm-hidden')) closeMap();
    else openMap();
}

function portraitFor(c, name) {
    if (name === c.meta.persona.name) return `/thumbnail?type=persona&file=${encodeURIComponent(c.meta.persona.avatar)}`;
    const member = c.meta.party.find(p => p.name === name);
    if (member) return `/thumbnail?type=avatar&file=${encodeURIComponent(member.avatar)}`;
    return '';
}

function initials(name) {
    const parts = String(name).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
    const num = String(name).match(/\d+$/)?.[0] ?? '';
    return ((parts[0]?.[0] ?? '?') + (num || parts[1]?.[0] || '')).toUpperCase();
}

function hpOf(c, name) {
    const w = c.docs.world;
    return w.party?.[name] ?? w.combat?.enemies?.[name] ?? null;
}

const TILE = 64;      // internal pixels per square (the canvas scales to the panel)
const MARGIN = 22;    // room for row numbers (left) and column letters (bottom)
const images = new Map();

/** A loaded portrait, or null while it loads (the map redraws when it arrives). */
function portraitImage(src) {
    if (!src) return null;
    let img = images.get(src);
    if (!img) {
        img = new Image();
        img.onload = () => refreshMap();
        img.src = src;
        images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
}

function renderMap() {
    const c = campaign();
    const active = activeMap(c?.docs.world);
    if (!active?.map) {
        closeMap();
        return;
    }
    const inCombat = active === c.docs.world.combat;
    const map = active.map;
    const positions = active.positions || {};
    const enemies = new Set(Object.keys(active.enemies || {}));
    const roster = Object.entries(positions).map(([name, coord]) => {
        const hp = hpOf(c, name);
        return `<span class="dm-map-chip ${enemies.has(name) ? 'foe' : 'friend'}">${escapeHtml(name)} <b>${coord}</b>${hp ? ` · ${hp.hp}/${hp.hp_max}` : ''}</span>`;
    }).join('');
    const props = (map.props || []).map(pr => `<span>${escapeHtml(pr.label || PROPS[pr.type]?.name || pr.type)} <b>${toCoord(pr.x, pr.y)}</b></span>`).join('');
    const pending = [selection.move ? `move to ${selection.move}` : '', selection.target ? `target ${selection.target}` : ''].filter(Boolean).join(', ');

    panel.innerHTML = `
<div class="dm-map-head">
  <b>${inCombat ? '⚔️ Battle map' : `🗺️ ${escapeHtml(active.title || 'Map')}`}</b><span class="dm-muted">${inCombat ? `Round ${active.round ?? 1}` : ''}</span>
  <span class="dm-map-btn fa-solid fa-window-minimize" data-act="min" title="Minimize"></span>
  <span class="dm-map-btn fa-solid fa-xmark" data-act="close" title="Close (reopen from the wand menu)"></span>
</div>
<div class="dm-map-body">
  <canvas class="dm-map-canvas"></canvas>
  <div class="dm-map-hover dm-muted">&nbsp;</div>
  <div class="dm-map-roster">${roster}</div>
  <div class="dm-map-actions">
    <span class="dm-map-pending">${pending ? escapeHtml(pending) : 'Tap a square to move, or an enemy to target.'}</span>
    <div class="menu_button" data-act="add" ${pending ? '' : 'disabled'}>Add to message</div>
    <div class="menu_button" data-act="clear">Clear</div>
  </div>
  ${props ? `<div class="dm-map-legend">${props}</div>` : ''}
</div>`;

    const canvas = panel.querySelector('.dm-map-canvas');
    drawBoard(canvas, c, active);
    canvas.addEventListener('click', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        if (sq) onSquare(sq, positions);
    });
    canvas.addEventListener('mousemove', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        panel.querySelector('.dm-map-hover').textContent = sq ? describeSquare(map, sq, positions) : ' ';
    });
    panel.querySelector('[data-act="close"]').addEventListener('click', closeMap);
    panel.querySelector('[data-act="min"]').addEventListener('click', () => panel.classList.toggle('dm-map-min'));
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => { selection = { move: '', target: '' }; renderMap(); });
    panel.querySelector('[data-act="add"]').addEventListener('click', addToMessage);
}

function drawBoard(canvas, c, active) {
    const map = active.map;
    const positions = active.positions || {};
    const player = c.meta.persona.name;
    const friends = new Set([player, ...c.meta.party.map(pt => pt.name)]);
    const enemies = new Set(Object.keys(active.enemies || {}));
    canvas.width = map.w * TILE + MARGIN;
    canvas.height = map.h * TILE + MARGIN;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(paintMapBase(map, TILE), MARGIN, 0);
    // Labels: row numbers on the left (1 at the bottom), column letters along the bottom.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < map.h; y++) ctx.fillText(String(y + 1), MARGIN / 2, (map.h - 1 - y) * TILE + TILE / 2);
    for (let x = 0; x < map.w; x++) ctx.fillText(colName(x), MARGIN + x * TILE + TILE / 2, map.h * TILE + MARGIN / 2);
    const cell = (x, y) => [MARGIN + x * TILE, (map.h - 1 - y) * TILE];
    // Reach: squares within a move of the player.
    const me = parseCoord(positions[player], map);
    if (me) {
        ctx.fillStyle = 'rgba(120,200,255,0.13)';
        for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
            if (distance(me, { x, y }) <= MOVE_SQUARES && isWalkable(map, x, y)) { const [px, py] = cell(x, y); ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4); }
        }
    }
    const sel = parseCoord(selection.move, map);
    if (sel) { const [px, py] = cell(sel.x, sel.y); ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 4; ctx.strokeRect(px + 3, py + 3, TILE - 6, TILE - 6); }
    // Tokens: portrait discs with a colored ring and an HP bar.
    for (const [name, coord] of Object.entries(positions)) {
        const pt = parseCoord(coord, map);
        if (!pt) continue;
        const [px, py] = cell(pt.x, pt.y);
        const cx = px + TILE / 2, cy = py + TILE / 2, rad = TILE * 0.38;
        const side = name === player ? '#ffd54a' : friends.has(name) ? '#4caf50' : enemies.has(name) ? '#e53935' : '#9e9e9e';
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.ellipse(cx + 3, cy + 5, rad, rad * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.clip();
        const img = portraitImage(portraitFor(c, name));
        if (img) {
            const scale = Math.max((rad * 2) / img.naturalWidth, (rad * 2) / img.naturalHeight);
            const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
            ctx.drawImage(img, cx - w / 2, cy - h / 2 + h * 0.08, w, h);
        } else {
            ctx.fillStyle = enemies.has(name) ? '#7a1f1f' : '#2f3b4a';
            ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(TILE * 0.28)}px sans-serif`;
            ctx.fillText(initials(name), cx, cy + 1);
        }
        ctx.restore();
        ctx.strokeStyle = selection.target === name ? '#ffd54a' : side;
        ctx.lineWidth = selection.target === name ? 5 : 3;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
        const hp = hpOf(c, name);
        if (hp?.hp_max) {
            const pct = Math.max(0, Math.min(1, hp.hp / hp.hp_max));
            ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(px + 8, py + TILE - 9, TILE - 16, 6);
            ctx.fillStyle = enemies.has(name) ? '#ff5252' : pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ffb300' : '#e53935';
            ctx.fillRect(px + 8, py + TILE - 9, (TILE - 16) * pct, 6);
        }
    }
}

function squareFromEvent(ev, canvas, map) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const px = (ev.clientX - rect.left) * scale - MARGIN;
    const py = (ev.clientY - rect.top) * scale;
    const x = Math.floor(px / TILE), row = Math.floor(py / TILE);
    if (x < 0 || row < 0 || x >= map.w || row >= map.h) return null;
    return { x, y: map.h - 1 - row };
}

function whoAt(positions, map, sq) {
    return Object.entries(positions).find(([, coord]) => { const pt = parseCoord(coord, map); return pt && pt.x === sq.x && pt.y === sq.y; })?.[0] ?? null;
}

function describeSquare(map, sq, positions) {
    const who = whoAt(positions, map, sq);
    const prop = squareName(map, sq.x, sq.y);
    const ground = TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'floor';
    return [toCoord(sq.x, sq.y), who, prop, ground].filter(Boolean).join(' · ');
}

function onSquare(sq, positions) {
    const c = campaign();
    const map = activeMap(c.docs.world).map;
    const who = whoAt(positions, map, sq);
    const coord = toCoord(sq.x, sq.y);
    if (who) {
        if (who === c.meta.persona.name) return;
        selection.target = selection.target === who ? '' : who;
    } else {
        if (!isWalkable(map, sq.x, sq.y)) {
            toastr.info(`${coord} is ${squareName(map, sq.x, sq.y) || TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'blocked'}: you can't stand there.`, 'Map', { timeOut: 2500 });
            return;
        }
        selection.move = selection.move === coord ? '' : coord;
    }
    renderMap();
}

function addToMessage() {
    const bits = [selection.move ? `move to ${selection.move}` : '', selection.target ? `target ${selection.target}` : ''].filter(Boolean);
    if (!bits.length) return;
    const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    if (!ta) return;
    const add = `(${bits.join(', ')})`;
    ta.value = ta.value.trim() ? `${ta.value.trim()} ${add}` : `${add} `;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    selection = { move: '', target: '' };
    renderMap();
    if (window.matchMedia('(max-width: 700px)').matches) panel.classList.add('dm-map-min');
}
