// The map panel. Three kinds of boards:
// - a fight: a chess-style grid with portraits and HP. Tap a square to move there, or tap an enemy
//   to target it; the plugin writes "(move to d4)" / "(target Bandit 1)" into your message box.
// - a place from the atlas (a mansion, a town...): the current floor with fog of war. Tap a square
//   and the party walks there (doors open, rooms reveal themselves, traps and guards stop you).
// - a scene map the DM drew for one spot.
// Claude never sees an image: it reads and writes maps as plain text.

import { campaign } from '../st/campaign.js';
import { parseCoord, toCoord, colName, terrainAt, distance, isWalkable, TERRAIN, PROPS } from '../core/grid.js';
import { paintMapBase, squareName } from './tiles.js';
import { escapeHtml } from '../core/text.js';
import { currentPlace, partyOnMap, look, walkTo } from '../st/atlas.js';
import { floorById, roomAt, doorAt, isExplored } from '../core/explore.js';

const MOVE_SQUARES = 6; // 30 ft; shown as a hint, Claude makes the call

let panel = null;
let selection = { move: '', target: '' };
let viewFloor = null;   // a floor of the current place picked from the list (null = where the party is)
let zoom = 1;
let lastPlaceKey = '';

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
    if (!c || !board(c)) {
        toastr.info('No map right now. It appears in fights, in places where exact squares matter, and in places the DM has built.', 'Dungeon Master');
        return;
    }
    ensurePanel().classList.remove('dm-hidden', 'dm-map-min');
    selection = { move: '', target: '' };
    viewFloor = null;
    renderMap(true);
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
    const npc = (c.docs.npcs || []).find(n => n.name === name && n.avatar);
    if (npc) return `/thumbnail?type=avatar&file=${encodeURIComponent(npc.avatar)}`;
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

/** What the panel shows right now. */
function board(c) {
    const w = c.docs.world;
    if (w.combat?.map) return { kind: 'combat', title: '⚔️ Battle map', sub: `Round ${w.combat.round ?? 1}`, map: w.combat.map, positions: w.combat.positions || {}, enemies: new Set(Object.keys(w.combat.enemies || {})) };
    const cur = currentPlace(c);
    if (cur) {
        const { key, place } = cur;
        if (key !== lastPlaceKey) { lastPlaceKey = key; viewFloor = null; zoom = floorById(place, place.state.floor).map.w > 24 ? 0.75 : 1; }
        const names = partyOnMap(c);
        const lead = place.state.positions[names[0]];
        const floorId = viewFloor ?? lead?.floor ?? place.state.floor;
        const floor = floorById(place, floorId);
        const visible = floorId === lead?.floor ? look(c, key, place) : new Uint8Array(floor.map.w * floor.map.h);
        const positions = {};
        for (const n of names) { const p = place.state.positions[n]; if (p?.floor === floorId) positions[n] = toCoord(p.x, p.y); }
        const enemies = new Set();
        for (const g of Object.values(place.guards)) {
            if (g.state === 'gone' || g.floor !== floorId || !visible[g.y * floor.map.w + g.x]) continue;
            positions[g.name] = toCoord(g.x, g.y);
            enemies.add(g.name);
        }
        const room = lead && lead.floor === floorId ? roomAt(place, floorId, lead.x, lead.y) : null;
        return { kind: 'place', key, place, floor, title: `🗺️ ${place.name}`, sub: [place.floors.length > 1 ? floor.name : '', room?.name ?? ''].filter(Boolean).join(' · '), map: floor.map, positions, enemies, visible, fog: place.fog !== false };
    }
    if (w.sceneMap?.map) return { kind: 'scene', title: `🗺️ ${w.sceneMap.title || 'Map'}`, sub: '', map: w.sceneMap.map, positions: w.sceneMap.positions || {}, enemies: new Set() };
    return null;
}

function tileFor(map) {
    return map.w > 20 || map.h > 20 ? 48 : 64;
}

function renderMap(center = false) {
    const c = campaign();
    const b = c ? board(c) : null;
    if (!b) {
        closeMap();
        return;
    }
    const map = b.map;
    const roster = Object.entries(b.positions).map(([name, coord]) => {
        const hp = hpOf(c, name);
        return `<span class="dm-map-chip ${b.enemies.has(name) ? 'foe' : 'friend'}">${escapeHtml(name)} <b>${coord}</b>${hp ? ` · ${hp.hp}/${hp.hp_max}` : ''}</span>`;
    }).join('');
    const exploring = b.kind === 'place';
    const props = exploring ? '' : (map.props || []).filter(pr => !pr.hidden && !PROPS[pr.type]?.decal).map(pr => `<span>${escapeHtml(pr.label || PROPS[pr.type]?.name || pr.type)} <b>${toCoord(pr.x, pr.y)}</b></span>`).join('');
    const pending = [selection.move ? `move to ${selection.move}` : '', selection.target ? `target ${selection.target}` : ''].filter(Boolean).join(', ');
    const floors = exploring ? b.place.floors.filter(f => (b.place.state.explored[f.id] || '').includes('1')).sort((x, y) => y.level - x.level) : [];

    panel.classList.toggle('dm-map-wide', exploring || map.w > 16);
    panel.innerHTML = `
<div class="dm-map-head">
  <b>${escapeHtml(b.title)}</b><span class="dm-muted">${escapeHtml(b.sub || '')}</span>
  ${floors.length > 1 ? `<select class="dm-map-floor text_pole" title="Look at another floor you've explored">${floors.map(f => `<option value="${escapeHtml(f.id)}" ${f.id === b.floor.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}</select>` : ''}
  ${map.w > 16 || map.h > 16 ? '<span class="dm-map-btn fa-solid fa-magnifying-glass-minus" data-act="out" title="Zoom out"></span><span class="dm-map-btn fa-solid fa-magnifying-glass-plus" data-act="in" title="Zoom in"></span>' : ''}
  <span class="dm-map-btn fa-solid fa-window-minimize" data-act="min" title="Minimize"></span>
  <span class="dm-map-btn fa-solid fa-xmark" data-act="close" title="Close (reopen from the wand menu)"></span>
</div>
<div class="dm-map-body">
  <div class="dm-map-view"><canvas class="dm-map-canvas"></canvas></div>
  <div class="dm-map-hover dm-muted">&nbsp;</div>
  <div class="dm-map-roster">${roster}</div>
  ${exploring
        ? '<div class="dm-map-actions"><span class="dm-map-pending">Tap a square to walk there. Doors open as you go; locked ones need a key or a plan.</span></div>'
        : `<div class="dm-map-actions">
    <span class="dm-map-pending">${pending ? escapeHtml(pending) : 'Tap a square to move, or an enemy to target.'}</span>
    <div class="menu_button" data-act="add" ${pending ? '' : 'disabled'}>Add to message</div>
    <div class="menu_button" data-act="clear">Clear</div>
  </div>`}
  ${props ? `<div class="dm-map-legend">${props}</div>` : ''}
</div>`;

    const canvas = panel.querySelector('.dm-map-canvas');
    const view = panel.querySelector('.dm-map-view');
    drawBoard(canvas, c, b);
    sizeCanvas(canvas, b);
    if (center || exploring) centerOnParty(view, canvas, b);
    canvas.addEventListener('click', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        if (!sq) return;
        if (exploring && (!viewFloor || viewFloor === b.place.state.positions[c.meta.persona.name]?.floor)) {
            // Redraw the board each step; when the walk ends, refresh the whole panel (room name, who's in view).
            walkTo(sq, () => { const nb = board(c); if (nb?.kind === 'place') { drawBoard(canvas, c, nb); centerOnParty(view, canvas, nb); } })
                .finally(() => { if (panel && !panel.classList.contains('dm-hidden')) renderMap(); });
        } else if (!exploring) onSquare(sq, b.positions);
    });
    canvas.addEventListener('mousemove', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        panel.querySelector('.dm-map-hover').textContent = sq ? describeSquare(b, sq) : ' ';
    });
    panel.querySelector('.dm-map-floor')?.addEventListener('change', ev => { viewFloor = ev.target.value; renderMap(true); });
    panel.querySelector('[data-act="in"]')?.addEventListener('click', () => { zoom = Math.min(1.5, zoom + 0.25); sizeCanvas(canvas, b); centerOnParty(view, canvas, b); });
    panel.querySelector('[data-act="out"]')?.addEventListener('click', () => { zoom = Math.max(0.25, zoom - 0.25); sizeCanvas(canvas, b); centerOnParty(view, canvas, b); });
    panel.querySelector('[data-act="close"]').addEventListener('click', closeMap);
    panel.querySelector('[data-act="min"]').addEventListener('click', () => panel.classList.toggle('dm-map-min'));
    panel.querySelector('[data-act="clear"]')?.addEventListener('click', () => { selection = { move: '', target: '' }; renderMap(); });
    panel.querySelector('[data-act="add"]')?.addEventListener('click', addToMessage);
}

/** Big maps keep their real size (scrollable, zoomable); small ones fit the panel. */
function sizeCanvas(canvas, b) {
    const big = b.map.w > 16 || b.map.h > 16;
    canvas.classList.toggle('dm-map-canvas-free', big);
    canvas.style.width = big ? `${Math.round(canvas.width * zoom)}px` : '';
}

function centerOnParty(view, canvas, b) {
    if (!(b.map.w > 16 || b.map.h > 16)) return;
    const lead = Object.entries(b.positions).find(([n]) => !b.enemies.has(n))?.[1];
    const pt = parseCoord(lead, b.map);
    if (!pt) return;
    const scale = canvas.clientWidth / canvas.width || zoom, tile = tileFor(b.map);
    view.scrollLeft = (MARGIN + (pt.x + 0.5) * tile) * scale - view.clientWidth / 2;
    view.scrollTop = ((b.map.h - pt.y - 0.5) * tile) * scale - view.clientHeight / 2;
}

/** Fog of war: unexplored is black, explored-but-not-seen is dimmed, what the party sees is clear. */
function drawFog(ctx, b, tile) {
    if (b.kind !== 'place' || !b.fog) return;
    const map = b.map, explored = b.place.state.explored[b.floor.id] || '';
    const fog = document.createElement('canvas');
    fog.width = map.w; fog.height = map.h;
    const f = fog.getContext('2d');
    const img = f.createImageData(map.w, map.h);
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        const i = y * map.w + x, o = ((map.h - 1 - y) * map.w + x) * 4;
        const a = explored[i] !== '1' ? 255 : b.visible[i] ? 0 : 150;
        img.data[o] = 6; img.data[o + 1] = 7; img.data[o + 2] = 12; img.data[o + 3] = a;
    }
    f.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fog, MARGIN, 0, map.w * tile, map.h * tile);
    ctx.restore();
}

function drawBoard(canvas, c, b) {
    const map = b.map;
    const tile = tileFor(map);
    const positions = b.positions;
    const player = c.meta.persona.name;
    const friends = new Set([player, ...c.meta.party.map(pt => pt.name)]);
    canvas.width = map.w * tile + MARGIN;
    canvas.height = map.h * tile + MARGIN;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(paintMapBase(map, tile), MARGIN, 0);
    drawFog(ctx, b, tile);
    // Labels: row numbers on the left (1 at the bottom), column letters along the bottom.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${tile > 50 ? 13 : 11}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < map.h; y++) ctx.fillText(String(y + 1), MARGIN / 2, (map.h - 1 - y) * tile + tile / 2);
    for (let x = 0; x < map.w; x++) ctx.fillText(colName(x), MARGIN + x * tile + tile / 2, map.h * tile + MARGIN / 2);
    const cell = (x, y) => [MARGIN + x * tile, (map.h - 1 - y) * tile];
    // Reach: squares within a move of the player (fights and scene maps).
    const me = parseCoord(positions[player], map);
    if (me && b.kind !== 'place') {
        ctx.fillStyle = 'rgba(120,200,255,0.13)';
        for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
            if (distance(me, { x, y }) <= MOVE_SQUARES && isWalkable(map, x, y)) { const [px, py] = cell(x, y); ctx.fillRect(px + 2, py + 2, tile - 4, tile - 4); }
        }
    }
    const sel = parseCoord(selection.move, map);
    if (sel) { const [px, py] = cell(sel.x, sel.y); ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 4; ctx.strokeRect(px + 3, py + 3, tile - 6, tile - 6); }
    // Tokens: portrait discs with a colored ring and an HP bar.
    for (const [name, coord] of Object.entries(positions)) {
        const pt = parseCoord(coord, map);
        if (!pt) continue;
        const [px, py] = cell(pt.x, pt.y);
        const cx = px + tile / 2, cy = py + tile / 2, rad = tile * 0.38;
        const side = name === player ? '#ffd54a' : friends.has(name) ? '#4caf50' : b.enemies.has(name) ? '#e53935' : '#9e9e9e';
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
            ctx.fillStyle = b.enemies.has(name) ? '#7a1f1f' : '#2f3b4a';
            ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(tile * 0.28)}px sans-serif`;
            ctx.fillText(initials(name), cx, cy + 1);
        }
        ctx.restore();
        ctx.strokeStyle = selection.target === name ? '#ffd54a' : side;
        ctx.lineWidth = selection.target === name ? 5 : 3;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
        const hp = hpOf(c, name);
        if (hp?.hp_max) {
            const pct = Math.max(0, Math.min(1, hp.hp / hp.hp_max));
            ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(px + 8, py + tile - 9, tile - 16, 6);
            ctx.fillStyle = b.enemies.has(name) ? '#ff5252' : pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ffb300' : '#e53935';
            ctx.fillRect(px + 8, py + tile - 9, (tile - 16) * pct, 6);
        }
    }
}

function squareFromEvent(ev, canvas, map) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const tile = tileFor(map);
    const px = (ev.clientX - rect.left) * scale - MARGIN;
    const py = (ev.clientY - rect.top) * scale;
    const x = Math.floor(px / tile), row = Math.floor(py / tile);
    if (x < 0 || row < 0 || x >= map.w || row >= map.h) return null;
    return { x, y: map.h - 1 - row };
}

function whoAt(positions, map, sq) {
    return Object.entries(positions).find(([, coord]) => { const pt = parseCoord(coord, map); return pt && pt.x === sq.x && pt.y === sq.y; })?.[0] ?? null;
}

function describeSquare(b, sq) {
    const map = b.map;
    if (b.kind === 'place' && b.fog && !isExplored(b.place, b.floor.id, sq.x, sq.y)) return `${toCoord(sq.x, sq.y)} · unexplored`;
    const who = whoAt(b.positions, map, sq);
    const prop = squareName(map, sq.x, sq.y);
    const ground = TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'floor';
    const room = b.kind === 'place' ? roomAt(b.place, b.floor.id, sq.x, sq.y)?.name : '';
    const door = b.kind === 'place' ? doorAt(b.place, b.floor.id, sq.x, sq.y) : null;
    const doorText = door ? (door.enter ? `door to ${b.place.buildings[door.enter]?.name ?? 'a building'}` : door.exit ? 'the way out' : `door (${door.state === 'closed' ? 'closed' : door.state})`) : '';
    return [toCoord(sq.x, sq.y), room, who, doorText || prop, doorText ? '' : ground].filter(Boolean).join(' · ');
}

function onSquare(sq, positions) {
    const c = campaign();
    const map = board(c).map;
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
