// The map panel. Three kinds of boards:
// - a fight: a chess-style grid with portraits and HP. Tap a square to move there, or tap an enemy
//   to target it; the plugin writes "(move to d4)" / "(target Bandit 1)" into your message box.
// - a place from the atlas (a mansion, a town...): the current floor with fog of war. Tap a square
//   and the party walks there (doors open, rooms reveal themselves, traps and guards stop you).
// - a scene map the DM drew for one spot.
// Claude never sees an image: it reads and writes maps as plain text.

import { campaign } from '../st/campaign.js';
import { parseCoord, toCoord, colName, terrainAt, isWalkable, TERRAIN, PROPS, HIDE, SEATS, reachable, speedSquares, propAt } from '../core/grid.js';
import { paintMapBase, squareName } from './tiles.js';
import { escapeHtml } from '../core/text.js';
import { currentPlace, partyOnMap, look, walkTo, approachSpot, pushProp, climbOut, setMapAction, lockedReason, hideAt, restAt } from '../st/atlas.js';
import { conditionsOf } from '../core/world.js';
import { restraintOf } from '../core/restraints.js';
import { floorById, roomAt, doorAt, isExplored, computeVisible, reveal, windowAt, isLight, hiddenNow, poseNow, caughtNow } from '../core/explore.js';
import { statsForName } from '../st/sheets.js';
import { settings, saveSettings, mapsOn } from '../st/settings.js';
import { drawEffects, effectsActive } from './effects.js';
import { drawCaught } from './trap-art.js';
import { fireAt } from '../core/fire.js';
import { drawFigure } from './sprite-render.js';
import { figureFor } from '../st/figures.js';

let panel = null;
let selection = { move: '', target: '' };
let viewFloor = null;   // a floor of the current place picked from the list (null = where the party is)
let zoom = 1;
let lastPlaceKey = '';
let follow = true;          // the camera follows the player until they scroll the map themselves
let autoAt = null;          // where our own scrolling put the view (anything else is the player scrolling)
let choosing = null;        // {title, choices, done}: the player is picking which thing they meant

/** How far the player can move this combat round, in squares. */
function playerSpeed(c) {
    return speedSquares(statsForName(c.meta.persona.name, c.meta));
}

/** Squares the player can reach this round (fights): around walls, not onto other people. */
function reachFor(c, b) {
    const me = parseCoord(b.positions[c.meta.persona.name], b.map);
    if (!me) return null;
    if (lockedReason(c, c.meta.persona.name)) return new Set();
    const blocked = new Set(Object.entries(b.positions).filter(([n]) => n !== c.meta.persona.name && !(hpOf(c, n)?.hp <= 0 && b.enemies.has(n))).map(([, cd]) => parseCoord(cd, b.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
    return reachable(b.map, me, playerSpeed(c), blocked);
}

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
    if (!mapsOn()) {
        toastr.info('Maps are off (Dungeon Master settings). The whole campaign stays in the chat.', 'Dungeon Master');
        return;
    }
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
    choosing?.done(null);
}

/**
 * Ask the player which thing they meant ("Which bookshelf?"): the map opens with each one ringed
 * and numbered; they tap one on the map or pick it from the list. Resolves with the choice, or null
 * if they back out (or the turn is stopped).
 * @param {{title:string, choices:{id:string, name:string, x:number, y:number, w:number, h:number, where:string}[], signal?:AbortSignal}} o
 */
export function chooseOnMap({ title, choices, signal = null }) {
    choosing?.done(null);
    return new Promise(resolve => {
        const pick = {
            title, choices,
            done: choice => {
                if (choosing !== pick) return;
                choosing = null;
                signal?.removeEventListener('abort', abort);
                resolve(choice);
                if (panel && !panel.classList.contains('dm-hidden')) renderMap();
            },
        };
        const abort = () => pick.done(null);
        signal?.addEventListener('abort', abort);
        choosing = pick;
        const c = campaign();
        if (!c || !board(c) || board(c).kind !== 'place') { pick.done(null); return; }
        ensurePanel().classList.remove('dm-hidden', 'dm-map-min');
        viewFloor = null;
        renderMap(true);
    });
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
    if (w.combat?.map) {
        const fight = { kind: 'combat', title: '⚔️ Battle map', sub: `Round ${w.combat.round ?? 1}`, map: w.combat.map, positions: w.combat.positions || {}, enemies: new Set(Object.keys(w.combat.enemies || {})) };
        // A fight inside a place keeps its fog: the party sees from where they stand in the fight.
        const cur = w.combat.inPlace ? currentPlace(c) : null;
        if (cur && cur.key === w.combat.inPlace.key) {
            const floor = floorById(cur.place, w.combat.inPlace.floor);
            const viewers = partyOnMap(c).map(n => parseCoord(fight.positions[n], fight.map)).filter(Boolean);
            const visible = computeVisible(cur.place, floor.id, viewers);
            reveal(cur.place, floor.id, visible);
            Object.assign(fight, { place: cur.place, floor, visible, fog: cur.place.fog !== false });
        }
        return fight;
    }
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
        const enemies = new Set(), people = new Set();
        for (const g of Object.values(place.guards)) {
            if (g.state === 'gone' || g.floor !== floorId || !visible[g.y * floor.map.w + g.x]) continue;
            positions[g.name] = toCoord(g.x, g.y);
            people.add(g.name);
            if (g.hostile !== false && g.state !== 'dead') enemies.add(g.name);
        }
        const room = lead && lead.floor === floorId ? roomAt(place, floorId, lead.x, lead.y) : null;
        return { kind: 'place', key, place, floor, title: `🗺️ ${place.name}`, sub: [place.floors.length > 1 ? floor.name : '', room?.name ?? ''].filter(Boolean).join(' · '), map: floor.map, positions, enemies, people, visible, fog: place.fog !== false };
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
    const waiting = b.kind === 'place' ? (b.place.state.waiting ?? {}) : {};
    const party = new Set([c.meta.persona.name, ...c.meta.party.map(p => p.name)]);
    const roster = Object.entries(b.positions).map(([name, coord]) => {
        const hp = hpOf(c, name);
        const cls = b.enemies.has(name) ? 'foe' : party.has(name) ? 'friend' : 'other';
        return `<span class="dm-map-chip ${cls}">${escapeHtml(name)} <b>${coord}</b>${hp ? ` · ${hp.hp}/${hp.hp_max}` : ''}${waiting[name] ? ' · waiting' : ''}</span>`;
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
  <span class="dm-map-btn fa-solid fa-cloud-rain ${settings().mapAmbience === false ? 'dm-map-off' : ''}" data-act="ambience" title="Weather and ambient particles: on/off (fire and spells always show)"></span>
  <span class="dm-map-btn fa-solid fa-location-crosshairs ${follow ? 'dm-hidden' : ''}" data-act="center" title="Follow ${escapeHtml(c.meta.persona.name)} again"></span>
  <span class="dm-map-btn fa-solid fa-window-minimize" data-act="min" title="Minimize"></span>
  <span class="dm-map-btn fa-solid fa-xmark" data-act="close" title="Close (reopen from the wand menu)"></span>
</div>
<div class="dm-map-body">
  <div class="dm-map-view"><canvas class="dm-map-canvas"></canvas></div>
  <div class="dm-map-hover dm-muted">&nbsp;</div>
  <div class="dm-map-roster">${roster}</div>
  ${exploring
        ? choosing ? `<div class="dm-map-actions dm-map-choose"><span class="dm-map-pending"><b>${escapeHtml(choosing.title)}</b> Tap one on the map, or pick:</span>${choosing.choices.map((ch, i) => `<div class="menu_button" data-pick="${i}" title="${escapeHtml(ch.where || '')}"><b>${i + 1}</b> ${escapeHtml(ch.name)}<small> · ${escapeHtml(ch.where || '')}</small></div>`).join('')}<div class="menu_button" data-pick="-1">Never mind</div></div>`
        : `<div class="dm-map-actions"><span class="dm-map-pending">${lockedReason(c, c.meta.persona.name) ? escapeHtml(lockedReason(c, c.meta.persona.name)) : 'Tap a square to walk there, or tap someone for options. Doors open as you go; locked ones need a key or a plan.'}</span></div>`
        : `<div class="dm-map-actions">
    <span class="dm-map-pending">${pending ? escapeHtml(pending) : lockedReason(c, c.meta.persona.name) ? escapeHtml(lockedReason(c, c.meta.persona.name)) : b.kind === 'combat' ? `Your move this round: tap a lit square (up to ${playerSpeed(c)} squares, ${playerSpeed(c) * 5} ft), or an enemy to target.` : 'Tap a square to move, or an enemy to target.'}</span>
    <div class="menu_button" data-act="add" ${pending ? '' : 'disabled'}>Add to message</div>
    <div class="menu_button" data-act="clear">Clear</div>
  </div>`}
  ${props ? `<div class="dm-map-legend">${props}</div>` : ''}
</div>`;

    const canvas = panel.querySelector('.dm-map-canvas');
    const view = panel.querySelector('.dm-map-view');
    drawBoard(canvas, c, b);
    sizeCanvas(canvas, b);
    if (center) follow = true;
    if (follow) centerOnParty(view, canvas, b);
    view.addEventListener('scroll', () => {
        // A view replaced by a newer render can still fire one last scroll: not the player.
        if (!follow || !view.isConnected) return;
        if (autoAt && Math.abs(view.scrollLeft - autoAt.left) < 4 && Math.abs(view.scrollTop - autoAt.top) < 4) return;
        follow = false;
        panel.querySelector('[data-act="center"]')?.classList.remove('dm-hidden');
    }, { passive: true });
    panel.querySelector('[data-act="center"]')?.addEventListener('click', () => { follow = true; panel.querySelector('[data-act="center"]').classList.add('dm-hidden'); centerOnParty(view, canvas, board(c) ?? b); });
    canvas.addEventListener('click', ev => {
        closeMenu();
        const sq = squareFromEvent(ev, canvas, map);
        if (!sq) return;
        if (choosing) {
            const hit = choosing.choices.find(ch => sq.x >= ch.x - 0 && sq.x < ch.x + (ch.w || 1) && sq.y >= ch.y && sq.y < ch.y + (ch.h || 1))
                ?? choosing.choices.find(ch => sq.x >= ch.x - 1 && sq.x <= ch.x + (ch.w || 1) && sq.y >= ch.y - 1 && sq.y <= ch.y + (ch.h || 1));
            if (hit) choosing.done(hit);
            else toastr.info(`${choosing.title} Tap one of the numbered ones.`, 'Map', { timeOut: 2000 });
            return;
        }
        // Anyone (you included): a little card with their name, health and what they're doing. What
        // people do goes through the chat, so the story and the characters decide it.
        const who = exploring ? whoAt(b.positions, map, sq) : null;
        if (who) {
            showPerson(ev, c, b, who);
            return;
        }
        // Furniture and windows: smash, shove, search, break, climb out.
        const thing = exploring && isExplored(b.place, b.floor.id, sq.x, sq.y) ? thingAt(b, sq) : null;
        if (thing) {
            openThingMenu(ev, c, b, thing, view, canvas);
            return;
        }
        if (exploring && (!viewFloor || viewFloor === b.place.state.positions[c.meta.persona.name]?.floor)) {
            follow = true;
            panel.querySelector('[data-act="center"]')?.classList.add('dm-hidden');
            // Redraw the board each step; when the walk ends, refresh the whole panel (room name, who's in view).
            walkTo(sq, () => { const nb = board(c); if (nb?.kind === 'place') { drawBoard(canvas, c, nb); if (follow) centerOnParty(view, canvas, nb); } })
                .finally(() => { if (panel && !panel.classList.contains('dm-hidden')) renderMap(); });
        } else if (!exploring) onSquare(sq, b.positions);
    });
    canvas.addEventListener('mousemove', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        panel.querySelector('.dm-map-hover').textContent = sq ? describeSquare(b, sq) : ' ';
    });
    panel.querySelector('.dm-map-floor')?.addEventListener('change', ev => { viewFloor = ev.target.value; renderMap(true); });
    panel.querySelector('[data-act="in"]')?.addEventListener('click', () => { zoom = Math.min(1.5, zoom + 0.25); sizeCanvas(canvas, b); if (follow) centerOnParty(view, canvas, b); });
    panel.querySelector('[data-act="out"]')?.addEventListener('click', () => { zoom = Math.max(0.25, zoom - 0.25); sizeCanvas(canvas, b); if (follow) centerOnParty(view, canvas, b); });
    panel.querySelector('[data-act="close"]').addEventListener('click', closeMap);
    panel.querySelector('[data-act="ambience"]')?.addEventListener('click', () => { settings().mapAmbience = settings().mapAmbience === false; saveSettings(); renderMap(); });
    panel.querySelector('[data-act="min"]').addEventListener('click', () => { panel.classList.toggle('dm-map-min'); ensureLoop(); });
    panel.querySelector('[data-act="clear"]')?.addEventListener('click', () => { selection = { move: '', target: '' }; renderMap(); });
    panel.querySelector('[data-act="add"]')?.addEventListener('click', addToMessage);
    panel.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => { const i = Number(el.dataset.pick); choosing?.done(i >= 0 ? choosing.choices[i] : null); }));
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
    const left = Math.max(0, (MARGIN + (pt.x + 0.5) * tile) * scale - view.clientWidth / 2);
    const top = Math.max(0, ((b.map.h - pt.y - 0.5) * tile) * scale - view.clientHeight / 2);
    view.scrollLeft = left;
    view.scrollTop = top;
    // Read back: the browser clamps at the edges.
    autoAt = { left: view.scrollLeft, top: view.scrollTop };
}

/** Fog of war: unexplored is black, explored-but-not-seen is dimmed, what the party sees is clear. */
function drawFog(ctx, b, tile) {
    if (!b.place || !b.fog) return;
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

// ---------- drawing: a static layer (map, fog, labels) and the figures on top ----------

let live = null; // {canvas, c, b, layer, tile} for the animation loop
const motion = new Map(); // name -> {x, y, facing, walkUntil, anim, animStart, animUntil, hp}
let loopTimer = null;
const TICK_MS = 110; // about 9 frames a second: lively, and light on a phone
const FX_TICK_MS = 70; // about 14 a second while fire, spells or weather move

function nameOffset(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h) % 2000;
}

/** Play an animation on someone's figure (attack, hurt) from the turn code. */
export function playAnim(name, anim, ms = anim === 'attack' ? 420 : 500) {
    const m = motion.get(name) ?? {};
    Object.assign(m, { anim, animStart: performance.now(), animUntil: performance.now() + ms });
    motion.set(name, m);
    ensureLoop();
}

function drawBoard(canvas, c, b) {
    const map = b.map;
    const tile = tileFor(map);
    canvas.width = map.w * tile + MARGIN;
    canvas.height = map.h * tile + MARGIN;
    // Everything that doesn't move goes in one layer; figures are drawn on top of it.
    // Reused while the size stays the same (walking redraws every step; no new canvas each time).
    const layer = live?.layer && live.layer.width === canvas.width && live.layer.height === canvas.height ? live.layer : document.createElement('canvas');
    layer.width = canvas.width; layer.height = canvas.height;
    const lctx = layer.getContext('2d');
    lctx.fillStyle = 'rgba(0,0,0,0.55)';
    lctx.fillRect(0, 0, layer.width, layer.height);
    lctx.drawImage(paintMapBase(map, tile), MARGIN, 0);
    drawFog(lctx, b, tile);
    // Labels: row numbers on the left (1 at the bottom), column letters along the bottom.
    lctx.fillStyle = 'rgba(255,255,255,0.75)';
    lctx.font = `${tile > 50 ? 13 : 11}px sans-serif`;
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    for (let y = 0; y < map.h; y++) lctx.fillText(String(y + 1), MARGIN / 2, (map.h - 1 - y) * tile + tile / 2);
    for (let x = 0; x < map.w; x++) lctx.fillText(colName(x), MARGIN + x * tile + tile / 2, map.h * tile + MARGIN / 2);
    const cell = (x, y) => [MARGIN + x * tile, (map.h - 1 - y) * tile];
    // Reach: the squares the player can get to this round (their speed, around walls and people).
    const reach = b.kind !== 'place' ? reachFor(c, b) : null;
    if (reach) {
        lctx.fillStyle = 'rgba(120,200,255,0.16)';
        for (const k of reach.keys()) { const [x, y] = k.split(',').map(Number); const [px, py] = cell(x, y); lctx.fillRect(px + 2, py + 2, tile - 4, tile - 4); }
    }
    // Picking which one: each candidate ringed and numbered.
    if (choosing && b.kind === 'place') {
        choosing.choices.forEach((ch, i) => {
            if (ch.floor && ch.floor !== b.floor.id) return;
            const [px, py] = cell(ch.x, ch.y + (ch.h || 1) - 1), w = (ch.w || 1) * tile, h = (ch.h || 1) * tile;
            lctx.strokeStyle = '#ffd54a'; lctx.lineWidth = 3; lctx.setLineDash([6, 4]);
            lctx.strokeRect(px + 2, py + 2, w - 4, h - 4);
            lctx.setLineDash([]);
            const r = Math.max(9, tile * 0.2);
            lctx.fillStyle = '#ffd54a'; lctx.beginPath(); lctx.arc(px + r + 2, py + r + 2, r, 0, Math.PI * 2); lctx.fill();
            lctx.fillStyle = '#222'; lctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`; lctx.fillText(String(i + 1), px + r + 2, py + r + 3);
        });
    }
    const sel = parseCoord(selection.move, map);
    if (sel) { const [px, py] = cell(sel.x, sel.y); lctx.strokeStyle = '#ffd54a'; lctx.lineWidth = 4; lctx.strokeRect(px + 3, py + 3, tile - 6, tile - 6); }
    live = { canvas, c, b, layer, tile };
    noteMotion(c, b);
    drawFrame(performance.now(), true);
    ensureLoop();
}

/** The part of the canvas that's on screen, in canvas pixels. */
function viewRect(canvas) {
    const view = canvas.parentElement, k = canvas.width / (canvas.clientWidth || canvas.width);
    return view?.clientWidth ? { x: view.scrollLeft * k, y: view.scrollTop * k, w: view.clientWidth * k, h: view.clientHeight * k } : { x: 0, y: 0, w: canvas.width, h: canvas.height };
}

/** Draw one frame. full = the whole board (otherwise only the figures' squares, when nothing else moves). */
function drawFrame(now, full = false) {
    const { canvas, c, b, layer, tile } = live;
    const ctx = canvas.getContext('2d');
    const ambient = settings().mapAmbience !== false;
    const fx = effectsActive(b.map, ambient) || figureFx(c, b).length > 0;
    if (fx) {
        ctx.drawImage(layer, 0, 0);
        const seen = b.place && b.fog && b.visible ? (x, y) => Boolean(b.visible[y * b.map.w + x]) : () => true;
        const o = { map: b.map, tile, margin: MARGIN, now, ambient, view: viewRect(canvas), seen, figures: figureFx(c, b) };
        drawEffects(ctx, o, 'under');
        drawTokens(ctx, c, b, tile, now, false);
        drawEffects(ctx, o, 'over');
    } else {
        // Effects just ended: one clean redraw to wipe them.
        if (full || live.fx) ctx.drawImage(layer, 0, 0);
        drawTokens(ctx, c, b, tile, now, !(full || live.fx));
    }
    live.fx = fx;
}

/** Sleepers (Z's) and the badly hurt (a drop of blood now and then), in map squares. */
function figureFx(c, b) {
    const out = [];
    for (const [name, coord] of Object.entries(b.positions)) {
        const pt = parseCoord(coord, b.map);
        if (!pt) continue;
        const rest = b.kind === 'place' ? poseNow(b.place, name) : null;
        const conds = conditionsOf(c.docs.world, name).join(' ').toLowerCase();
        const hp = hpOf(c, name);
        if (rest?.pose === 'sleep' || /asleep|sleeping/.test(conds)) out.push({ kind: 'z', x: pt.x, y: pt.y });
        else if (hp?.hp_max && hp.hp > 0 && hp.hp / hp.hp_max <= 0.25) out.push({ kind: 'drop', x: pt.x, y: pt.y });
    }
    return out;
}

/** Anything moving on the map right now: figures, or fire, spells and the ambience. */
function animated() {
    return settings().mapFigures !== false || Boolean(live && (live.fx || effectsActive(live.b.map, settings().mapAmbience !== false)));
}

/** Who moved (walk and face that way), who lost HP (flinch). */
function noteMotion(c, b) {
    const now = performance.now();
    const party = new Set([c.meta.persona.name, ...c.meta.party.map(p => p.name)]);
    for (const [name, coord] of Object.entries(b.positions)) {
        const pt = parseCoord(coord, b.map);
        if (!pt) continue;
        const m = motion.get(name);
        const hp = hpOf(c, name)?.hp;
        if (!m) { motion.set(name, { x: pt.x, y: pt.y, facing: party.has(name) ? 1 : -1, hp }); continue; }
        if (m.x !== pt.x || m.y !== pt.y) {
            if (pt.x !== m.x) m.facing = pt.x > m.x ? 1 : -1;
            m.walkUntil = now + (Math.abs(pt.x - m.x) + Math.abs(pt.y - m.y) > 1 ? 600 : 260);
            m.x = pt.x; m.y = pt.y;
        }
        if (typeof hp === 'number' && typeof m.hp === 'number' && hp < m.hp) Object.assign(m, { anim: 'hurt', animStart: now, animUntil: now + 500 });
        m.hp = hp;
    }
}

function drawTokens(ctx, c, b, tile, now, restore) {
    const map = b.map;
    const player = c.meta.persona.name;
    const friends = new Set([player, ...c.meta.party.map(pt => pt.name)]);
    const figures = settings().mapFigures !== false;
    for (const [name, coord] of Object.entries(b.positions)) {
        const pt = parseCoord(coord, map);
        if (!pt) continue;
        const px = MARGIN + pt.x * tile, py = (map.h - 1 - pt.y) * tile;
        if (restore) ctx.drawImage(live.layer, px, py, tile, tile, px, py, tile, tile);
        const cx = px + tile / 2, cy = py + tile / 2;
        const side = name === player ? '#ffd54a' : friends.has(name) ? '#4caf50' : b.enemies.has(name) ? '#e53935' : '#8fb4d9';
        const hp = hpOf(c, name);
        const held = restraintOf(conditionsOf(c.docs.world, name));
        const hid = b.kind === 'place' ? hiddenNow(b.place, name) : null;
        if (hid) {
            drawHidden(ctx, c, name, hid, px, py, tile, now, figures);
            continue;
        }
        if (figures) {
            // A colored ring on the floor, the figure standing on it.
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.beginPath(); ctx.ellipse(cx, py + tile * 0.84, tile * 0.32, tile * 0.11, 0, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = selection.target === name ? '#ffd54a' : side;
            ctx.lineWidth = selection.target === name ? 4 : 2.5;
            ctx.beginPath(); ctx.ellipse(cx, py + tile * 0.84, tile * 0.34, tile * 0.12, 0, 0, Math.PI * 2); ctx.stroke();
            const m = motion.get(name) ?? {};
            let anim = 'idle', elapsed = now + nameOffset(name);
            const rest = b.kind === 'place' ? poseNow(b.place, name) : null;
            const conds = conditionsOf(c.docs.world, name).join(' ').toLowerCase();
            const out = (hp && hp.hp_max && hp.hp <= 0) || /unconscious|knocked out|dead/.test(conds) || b.place?.guards?.[name]?.state === 'dead';
            if (out) anim = 'down';
            else if (rest) anim = rest.pose;
            else if (/asleep|sleeping/.test(conds)) anim = 'sleep';
            else if (m.anim && now < m.animUntil) { anim = m.anim; elapsed = now - m.animStart; }
            else if (m.walkUntil && now < m.walkUntil) anim = 'walk';
            else if (held.hurt || (hp?.hp_max && hp.hp / hp.hp_max <= 0.3)) anim = 'injured';
            const look = figureFor(name);
            const shown = held.bound && !look.beast ? { ...look, bound: held.bound } : look;
            const trapped = b.kind === 'place' ? caughtNow(b.place, name) : null;
            if (trapped && !out) drawCaught(ctx, shown, trapped, px, py, tile, { flip: (m.facing ?? (friends.has(name) ? 1 : -1)) < 0, offset: nameOffset(name) });
            else if (rest?.type === 'bed' && !out) drawInBed(ctx, shown, b, rest, name, tile, now);
            else drawFigure(ctx, shown, px, py - tile * (anim === 'sit' ? 0.02 : 0.06), tile, { anim, elapsed, flip: (m.facing ?? (friends.has(name) ? 1 : -1)) < 0, red: anim === 'hurt' && Math.floor(elapsed / 120) % 2 === 0 });
        } else {
            const rad = tile * 0.38;
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
                ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(tile * 0.28)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(initials(name), cx, cy + 1);
            }
            ctx.restore();
            ctx.strokeStyle = selection.target === name ? '#ffd54a' : side;
            ctx.lineWidth = selection.target === name ? 5 : 3;
            ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
        }
        if (held.caged) drawCage(ctx, px, py, tile);
        if (hp?.hp_max) {
            const pct = Math.max(0, Math.min(1, hp.hp / hp.hp_max));
            ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(px + 8, py + tile - 7, tile - 16, 5);
            ctx.fillStyle = b.enemies.has(name) ? '#ff5252' : pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ffb300' : '#e53935';
            ctx.fillRect(px + 8, py + tile - 7, (tile - 16) * pct, 5);
        }
    }
}

/** Someone in a bed, seen from above: head at the headboard, tucked under a blanket. */
function drawInBed(ctx, look, b, rest, name, tile, now) {
    const prop = (b.map.props || []).find(p => p.id === rest.prop);
    if (!prop) return;
    const w = prop.w || 1, h = prop.h || 1;
    const cx = MARGIN + (prop.x + w / 2) * tile, cy = (b.map.h - prop.y - h / 2) * tile;
    const turn = { s: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }[prop.side] ?? 0;
    const sideways = prop.side === 'e' || prop.side === 'w';
    const len = (sideways ? w : h) * tile, wid = (sideways ? h : w) * tile;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(turn);
    drawFigure(ctx, look, -tile / 2, -len / 2 + tile * 0.02, tile, { anim: rest.pose === 'sleep' ? 'asleep' : 'abed', elapsed: now + nameOffset(name) });
    const top = -len / 2 + tile * 0.48, bottom = len / 2 - tile * 0.1;
    ctx.fillStyle = 'hsl(215,28,36)';
    ctx.fillRect(-wid * 0.42, top, wid * 0.84, bottom - top);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-wid * 0.42, top, wid * 0.84, tile * 0.08);
    // Breathing under the blanket.
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(-wid * 0.3, top + tile * 0.2 + Math.sin(now / 900) * tile * 0.02, wid * 0.6, tile * 0.05);
    ctx.restore();
}

/**
 * Someone hiding. For half a second they duck into their spot (sinking and fading); then: inside or
 * under something, only a pair of eyes peeks out (blinking now and then); behind something, a faint
 * crouched figure.
 */
function drawHidden(ctx, c, name, hid, px, py, tile, now, figures) {
    const started = motion.get(name)?.hideStart ?? 0;
    const t = Math.min(1, (now - started) / 500);
    if (figures && t < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.beginPath(); ctx.rect(px, py, tile, tile); ctx.clip();
        drawFigure(ctx, figureFor(name), px, py - tile * 0.06 + t * tile * 0.5, tile, { anim: 'idle', elapsed: now });
        ctx.restore();
        return;
    }
    if (hid.mode === 'behind') {
        ctx.save();
        ctx.globalAlpha = 0.42;
        ctx.beginPath(); ctx.rect(px, py + tile * 0.25, tile, tile * 0.75); ctx.clip();
        if (figures) drawFigure(ctx, figureFor(name), px, py + tile * 0.18, tile, { anim: 'idle', elapsed: now + nameOffset(name) });
        ctx.restore();
    }
    // The eyes: two little whites with dark pupils, closing for a moment now and then.
    const cx = px + tile / 2, cy = py + (hid.mode === 'under' ? tile * 0.7 : hid.mode === 'in' ? tile * 0.42 : tile * 0.5);
    const blink = (now + nameOffset(name)) % 3400 < 160;
    for (const dx of [-0.09, 0.09]) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(cx + dx * tile - tile * 0.06, cy - tile * 0.05, tile * 0.12, tile * 0.1);
        if (blink) { ctx.fillStyle = '#e8e2d6'; ctx.fillRect(cx + dx * tile - tile * 0.045, cy, tile * 0.09, Math.max(1, tile * 0.015)); continue; }
        ctx.fillStyle = '#f2efe8'; ctx.fillRect(cx + dx * tile - tile * 0.045, cy - tile * 0.03, tile * 0.09, tile * 0.06);
        ctx.fillStyle = '#17131a'; ctx.fillRect(cx + dx * tile, cy - tile * 0.025, tile * 0.035, tile * 0.05);
    }
}

/** Iron bars around whoever is caged (drawn over the figure, inside their square). */
function drawCage(ctx, x, y, s) {
    const bar = Math.max(2, Math.round(s * 0.04));
    ctx.fillStyle = '#23232a';
    ctx.fillRect(x + s * 0.06, y + s * 0.03, s * 0.88, bar + 2);
    ctx.fillRect(x + s * 0.06, y + s * 0.93 - bar, s * 0.88, bar + 2);
    for (let i = 0; i <= 5; i++) {
        const bx = Math.round(x + s * 0.08 + i * (s * 0.84 - bar) / 5);
        ctx.fillStyle = '#3c3c46';
        ctx.fillRect(bx, y + s * 0.04, bar, s * 0.9);
        ctx.fillStyle = 'rgba(200, 205, 220, 0.45)';
        ctx.fillRect(bx, y + s * 0.04, 1, s * 0.9);
    }
    // The lock on the door.
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(x + s * 0.47, y + s * 0.5, Math.max(3, s * 0.08), Math.max(4, s * 0.1));
}

/** The animation loop: only while the map is open, shown, and has figures to animate. */
function ensureLoop() {
    if (loopTimer || !animated()) return;
    const tick = () => {
        loopTimer = null;
        if (!live || !live.canvas.isConnected || !panel || panel.classList.contains('dm-hidden') || panel.classList.contains('dm-map-min') || document.hidden || !animated()) return;
        drawFrame(performance.now());
        // A little smoother while fire and weather move; otherwise light on a phone.
        loopTimer = setTimeout(() => requestAnimationFrame(tick), live.fx ? FX_TICK_MS : TICK_MS);
    };
    loopTimer = setTimeout(() => requestAnimationFrame(tick), TICK_MS);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureLoop(); });

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
    if (b.place && b.fog && !isExplored(b.place, b.floor.id, sq.x, sq.y)) return `${toCoord(sq.x, sq.y)} · unexplored`;
    const who = whoAt(b.positions, map, sq);
    const prop = squareName(map, sq.x, sq.y);
    const ground = TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'floor';
    const room = b.kind === 'place' ? roomAt(b.place, b.floor.id, sq.x, sq.y)?.name : '';
    const door = b.kind === 'place' ? doorAt(b.place, b.floor.id, sq.x, sq.y) : null;
    const doorText = door ? (door.enter ? `door to ${b.place.buildings[door.enter]?.name ?? 'a building'}` : door.exit ? 'the way out' : `door (${door.state === 'closed' ? 'closed' : door.state})`) : '';
    const burning = fireAt(map, sq.x, sq.y) ? '🔥 on fire' : map.burnt?.[`${sq.x},${sq.y}`] ? 'burnt' : '';
    return [toCoord(sq.x, sq.y), room, who, doorText || prop, doorText ? '' : ground, burning].filter(Boolean).join(' · ');
}

async function onSquare(sq, positions) {
    const c = campaign();
    const map = board(c).map;
    const who = whoAt(positions, map, sq);
    let coord = toCoord(sq.x, sq.y);
    if (who) {
        if (who === c.meta.persona.name) return;
        selection.target = selection.target === who ? '' : who;
    } else {
        const { isRunning } = await import('../st/orchestrator.js');
        if (isRunning()) { toastr.info('The DM is working out the round. Pick your move when it\'s your turn again.', 'Map', { timeOut: 3000 }); return; }
        const held = lockedReason(c, c.meta.persona.name);
        if (held) { toastr.info(held, 'Map', { timeOut: 4000 }); return; }
        const fb = board(c);
        if (fb?.fog && fb.place && !isExplored(fb.place, fb.floor.id, sq.x, sq.y) && !isWalkable(map, sq.x, sq.y)) {
            const reach = reachFor(c, fb);
            const near = reach && [...reach.keys()].map(k => k.split(',').map(Number)).sort((p, q) => Math.max(Math.abs(p[0] - sq.x), Math.abs(p[1] - sq.y)) - Math.max(Math.abs(q[0] - sq.x), Math.abs(q[1] - sq.y)))[0];
            if (near) { sq = { x: near[0], y: near[1] }; coord = toCoord(sq.x, sq.y); }
        }
        if (!isWalkable(map, sq.x, sq.y)) {
            toastr.info(`${coord} is ${squareName(map, sq.x, sq.y) || TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'blocked'}: you can't stand there.`, 'Map', { timeOut: 2500 });
            return;
        }
        const b = board(c);
        const reach = b?.kind === 'combat' ? reachFor(c, b) : null;
        if (reach && !reach.has(`${sq.x},${sq.y}`)) {
            toastr.info(`Too far: ${c.meta.persona.name} can move ${playerSpeed(c)} squares (${playerSpeed(c) * 5} ft) this round. Tell the DM if you Dash.`, 'Map', { timeOut: 3500 });
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

// ---------- the tap menu for someone on the map ----------

function closeMenu() {
    panel?.querySelector('.dm-map-menu')?.remove();
}

/** Put text in the message box and send it as the player's move (or leave it there if they were typing). */
function sendAsPlayer(text, { send = true } = {}) {
    const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    if (!ta) return;
    const typed = ta.value.trim();
    ta.value = typed ? `${text} ${typed}` : (send ? text : `${text} `);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (send && !typed) document.getElementById('send_but')?.click();
    else ta.focus();
    if (window.matchMedia('(max-width: 700px)').matches) panel.classList.add('dm-map-min');
}

/** Tapping someone: who they are, their health, and what they're doing. No actions. */
function showPerson(ev, c, b, who) {
    const hp = hpOf(c, who);
    const place = b.place;
    const conds = conditionsOf(c.docs.world, who);
    const hid = place ? hiddenNow(place, who) : null;
    const rest = place ? poseNow(place, who) : null;
    const lines = [
        hp?.hp_max ? `HP ${hp.hp}/${hp.hp_max}${hp.hp <= 0 ? ' (down)' : hp.hp / hp.hp_max <= 0.3 ? ' (badly hurt)' : ''}` : '',
        conds.length ? conds.join(', ') : '',
        hid ? `hiding ${hid.mode} the ${hid.what}` : '',
        rest ? `${rest.pose === 'sit' ? 'sitting on' : rest.pose === 'sleep' ? 'asleep on' : 'lying on'} the ${rest.what}` : '',
        place && caughtNow(place, who) ? `caught in the ${caughtNow(place, who).kind}` : '',
        place?.state.waiting?.[who] ? 'staying here' : '',
        place?.guards[who]?.description || '',
    ].filter(Boolean);
    showMenu(ev, who, lines.join(' · ') || (c.meta.party.some(p => p.name === who) || who === c.meta.persona.name ? 'fine' : ''), []);
}

// ---------- the tap menu for things: furniture and windows ----------

/** Something you can act on at a square: a window, or furniture that's in the way. */
function thingAt(b, sq) {
    const win = windowAt(b.place, b.floor.id, sq.x, sq.y);
    if (win) return { kind: 'window', win, name: win.state === 'barred' ? 'barred window' : win.state === 'broken' ? 'broken window' : 'window', spot: { x: win.x, y: win.y } };
    const prop = propAt(b.map, sq.x, sq.y);
    if (!prop || (!PROPS[prop.type]?.blocks && !HIDE[prop.type] && !SEATS[prop.type])) return null;
    return { kind: 'prop', prop, name: prop.label || PROPS[prop.type]?.name || prop.type, spot: { x: prop.x, y: prop.y, w: prop.w, h: prop.h } };
}

const DIR_WORDS = { n: 'north', s: 'south', e: 'east', w: 'west' };

function openThingMenu(ev, c, b, thing, view, canvas) {
    const player = c.meta.persona.name;
    const redraw = () => { const nb = board(c); if (nb?.kind === 'place') { drawBoard(canvas, c, nb); if (follow) centerOnParty(view, canvas, nb); } };
    const done = () => renderMap();
    const where = toCoord(thing.spot.x, thing.spot.y);
    const near = () => approachSpot(thing.spot, redraw);
    let actions;
    if (thing.kind === 'window') {
        const w = thing.win;
        actions = w.state === 'broken'
            ? [['Climb out', 'fa-person-falling', async () => { if (await near()) await climbOut(w.id); done(); }]]
            : w.state === 'barred'
                ? [['Pry the bars', 'fa-grip-lines-vertical', async () => { if (!(await near())) return; setMapAction(`${player} tries to pry the bars off window ${w.id} at ${where}. A hard Strength (Athletics) roll; on a success set place_changes.windows {"${w.id}": "broken"} (the bars and glass are out, they can climb through).`); sendAsPlayer(`*${player} grips the bars of the window and pulls with everything they've got.*`); done(); }]]
                : [['Break it', 'fa-hammer', async () => { if (!(await near())) return; setMapAction(`${player} smashes window ${w.id} at ${where}. It's loud: anyone nearby may hear. Unless something stops them, set place_changes.windows {"${w.id}": "broken"}.`); sendAsPlayer(`*${player} smashes the window.*`); done(); }]];
    } else {
        const p = thing.prop;
        const light = isLight(p);
        const how = HIDE[p.type];
        const seat = SEATS[p.type];
        const use = (verb, icon, label) => [label, icon, async () => {
            if (!(await near())) return;
            const r = restAt(c, player, p.id, verb);
            if (!r) { toastr.info('Someone is already there.', 'Map', { timeOut: 2000 }); return; }
            // Going to sleep matters to the story (time passes, a rest); sitting down doesn't need the DM.
            if (verb === 'sleep') { setMapAction(`${player} lies down on the ${r.what} (${p.id}) to sleep. A short or long rest if it's safe; otherwise someone may come.`); sendAsPlayer(`*${player} lies down on the ${r.what} and goes to sleep.*`); }
            done();
        }];
        actions = [
            ...(seat === 'sit' ? [use('sit', 'fa-chair', 'Sit down')] : []),
            ...(seat === 'lie' ? [use('lie', 'fa-bed', 'Lie down'), use('sleep', 'fa-moon', 'Sleep'), ...(p.type === 'bed' ? [use('sit', 'fa-chair', 'Sit on it')] : [])] : []),
            ...(how ? [[`Hide ${how === 'in' ? 'in' : how === 'under' ? 'under' : 'behind'} it`, 'fa-user-secret', async () => {
                if (!(await near())) return;
                const h = hideAt(c, player, p.id);
                if (!h) return;
                motion.set(player, { ...(motion.get(player) ?? {}), hideStart: performance.now() });
                setMapAction(`${player} hides ${h.mode} the ${h.name} (${p.id} at ${where}). If anyone might see or come looking, they roll Stealth; otherwise just note it.`);
                sendAsPlayer(`*${player} hides ${h.mode} the ${h.name}.*`);
                done();
            }]] : []),
            ['Search', 'fa-magnifying-glass', async () => { if (!(await near())) return; setMapAction(`${player} searches the ${thing.name} (${p.id} at ${where}). Say what they find, if anything (items in this room are in the place notes).`); sendAsPlayer(`*${player} searches the ${thing.name}.*`); done(); }],
            ['Smash', 'fa-hammer', async () => { if (!(await near())) return; setMapAction(`${player} tries to smash the ${thing.name} (${p.id} at ${where}). Ask for a Strength (Athletics) roll, harder for sturdy things; on a success set place_changes.props {"${p.id}": "broken"}. It's noisy.`); sendAsPlayer(`*${player} tries to smash the ${thing.name}.*`); done(); }],
            ['Push', 'fa-hand-back-fist', async () => { if (!(await near())) return; openPushMenu(ev, c, thing, light, redraw, done); }],
        ];
    }
    showMenu(ev, `${thing.name}`, thing.kind === 'prop' ? (isLight(thing.prop) ? 'light enough to shove' : 'heavy: shoving it takes a roll') : thing.win.state === 'barred' ? 'iron bars over the glass' : '', actions);
}

function openPushMenu(ev, c, thing, light, redraw, done) {
    const player = c.meta.persona.name, p = thing.prop;
    const push = dir => async () => {
        if (light) {
            const r = pushProp(p.id, dir);
            if (!r.ok) toastr.info(`It won't go that way: ${r.why}.`, 'Map', { timeOut: 2500 });
            else if (r.door) toastr.info(`The ${thing.name} now blocks the door.`, 'Map', { timeOut: 2500 });
            done();
            return;
        }
        setMapAction(`${player} tries to shove the heavy ${thing.name} (${p.id} at ${toCoord(p.x, p.y)}) one square ${DIR_WORDS[dir]}. Ask for a Strength (Athletics) roll; on a success set place_changes.props {"${p.id}": {"move": "${dir}"}}. If that puts it in a doorway, the door is barricaded.`);
        sendAsPlayer(`*${player} puts a shoulder into the ${thing.name} and shoves it ${DIR_WORDS[dir]}.*`);
        done();
    };
    showMenu(ev, `Push the ${thing.name}`, light ? 'which way?' : 'which way? (a roll)', [
        ['North', 'fa-arrow-up', push('n')], ['South', 'fa-arrow-down', push('s')],
        ['West', 'fa-arrow-left', push('w')], ['East', 'fa-arrow-right', push('e')],
    ]);
}

/** A small menu of buttons next to the tap (a bar along the bottom on phones). */
function showMenu(ev, title, sub, actions) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dm-map-menu';
    menu.innerHTML = `<div class="dm-map-menu-title">${escapeHtml(title)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>${actions.map(([label, icon], i) => `<div class="menu_button" data-i="${i}"><i class="fa-solid ${icon}"></i> ${escapeHtml(label)}</div>`).join('')}`;
    const body = panel.querySelector('.dm-map-body');
    body.appendChild(menu);
    const box = body.getBoundingClientRect();
    const tapX = ev.clientX - box.left, tapY = ev.clientY - box.top;
    const below = tapY + 8 + menu.offsetHeight <= body.clientHeight;
    menu.style.left = `${Math.max(8, Math.min(tapX + 8, box.width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${body.scrollTop + Math.max(8, below ? tapY + 8 : tapY - menu.offsetHeight - 8)}px`;
    menu.addEventListener('click', async e => {
        const i = Number(e.target.closest('[data-i]')?.dataset.i);
        if (!Number.isInteger(i)) return;
        e.stopPropagation();
        closeMenu();
        try { await actions[i][2](); } catch (error) { toastr.error(String(error?.message || error), 'Map'); }
    });
}
