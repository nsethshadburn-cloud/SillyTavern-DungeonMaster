// The map panel. Two kinds of boards:
// - a fight: a chess-style grid with figures and HP. Tap a square to move there, or tap an enemy
//   to target it; the plugin writes "(move to d4)" / "(target Bandit 1)" into your message box.
// - the sketch: a small picture of the scene drawn from the DM's scene card (the story is the
//   truth; this only shows it). Tap someone for a word with them; tap a thing to go over to it.
// Claude never sees an image: it reads and writes battle maps as plain text.

import { campaign, saveDoc } from '../st/campaign.js';
import { parseCoord, toCoord, colName, terrainAt, isWalkable, TERRAIN, PROPS, reachable, speedSquares, propAt } from '../core/grid.js';
import { paintMapBase, squareName } from './tiles.js';
import { escapeHtml } from '../core/text.js';
import { moveOnSketch } from '../core/sketch.js';
import { moveBudget, conditionsOf } from '../core/world.js';
import { restraintOf, escapeOptions, lockedLine } from '../core/restraints.js';
import { statsForName } from '../st/sheets.js';
import { settings, saveSettings, mapsOn } from '../st/settings.js';
import { drawEffects, effectsActive } from './effects.js';
import { drawFigure } from './sprite-render.js';
import { figureFor } from '../st/figures.js';
import { setBubbleStage, clearBubbleStage } from './bubbles.js';
import { sfx, syncAmbient, setAmbient } from './sound.js';
import { nameKey } from '../core/text.js';
import { ensureClock, clockText, hhmm, timeIcon, WEATHER_ICON, WEATHER_WORDS } from '../core/clock.js';
import { sexFromText } from '../core/sprites.js';

let panel = null;
let selection = { move: '', target: '' };
let lastViewKey = '';       // the board the view was last showing (a redraw of the same one keeps the scroll)

/** How far the player can move this combat round, in squares. */
function playerSpeed(c) {
    return speedSquares(statsForName(c.meta.persona.name, c.meta));
}

/** The player's movement this round: used, allowed, left (a fight keeps the count over all their messages). */
function moveLeft(c) {
    return moveBudget(c.docs.world, c.meta.persona.name, playerSpeed(c));
}

/** Can the player move on their own right now? A reason they can't, or ''. */
function lockedReason(c, name) {
    const r = restraintOf(conditionsOf(c.docs.world, name));
    return r.locked ? lockedLine(name, r) : '';
}

/** Squares the player can still reach this round (fights): around walls, not onto other people. */
function reachFor(c, b) {
    const me = parseCoord(b.positions[c.meta.persona.name], b.map);
    if (!me) return null;
    if (lockedReason(c, c.meta.persona.name)) return new Set();
    const blocked = new Set(Object.entries(b.positions).filter(([n]) => n !== c.meta.persona.name && !(hpOf(c, n)?.hp <= 0 && b.enemies.has(n))).map(([, cd]) => parseCoord(cd, b.map)).filter(Boolean).map(p => `${p.x},${p.y}`));
    return reachable(b.map, me, moveLeft(c).left, blocked);
}

/** The fight's turn strip: the round, whose turn it is, the player's movement left, the order. */
function turnStrip(c) {
    const w = c.docs.world, cb = w.combat;
    if (!cb) return '';
    const me = c.meta.persona.name;
    const inOrder = (cb.order || []).some(o => o.name === me);
    const budget = moveLeft(c);
    const others = (cb.order || []).map(o => o.name).filter(n => n !== me);
    let who, cls;
    if (!inOrder) { who = 'Roll your initiative first'; cls = 'wait'; }
    else if (busy) { who = cb.phase === 'others' ? `The DM runs ${others.length ? others.join(', ') : 'the others'}` : 'The DM is resolving your action'; cls = 'wait'; }
    else { who = 'YOUR TURN'; cls = 'you'; }
    const chips = (cb.order || []).map(o => `<span class="dm-turn-chip ${o.name === me ? 'me' : cb.enemies?.[o.name] ? 'foe' : 'friend'}${o.name === me && cls === 'you' ? ' active' : ''}">${escapeHtml(o.name)} <b>${o.init}</b></span>`).join('');
    return `<span class="dm-turn-round">⚔️ Round ${cb.round ?? 1}</span><span class="dm-turn-who ${cls}">${who}</span>${inOrder ? `<span class="dm-turn-move" title="Squares moved this round / allowed (a Dash doubles it)">Moved ${budget.used} of ${budget.max}${budget.dashing ? ' (dashing)' : ''} · ${budget.left} left (${budget.left * 5} ft)</span>` : ''}<span class="dm-turn-order">${chips}</span>`;
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
        toastr.info('The map is off (Dungeon Master settings). The whole campaign stays in the chat.', 'Dungeon Master');
        return;
    }
    if (!c || !board(c)) {
        toastr.info('No map right now. The sketch appears once the DM has set the scene; a battle map in fights.', 'Dungeon Master');
        return;
    }
    const wasOpen = panel && document.body.contains(panel) && !panel.classList.contains('dm-hidden');
    ensurePanel().classList.remove('dm-hidden', 'dm-map-min');
    if (wasOpen) { renderMap(); return; }
    selection = { move: '', target: '' };
    renderMap();
}

export function closeMap() {
    panel?.classList.add('dm-hidden');
    clearBubbleStage();
    setAmbient(null);
}

/** The speech bubbles live on a layer over the canvas; each render tells them where every figure is. */
function mountBubbles(canvas, b) {
    const layer = panel?.querySelector('.dm-map-bubbles');
    if (!layer) return;
    setBubbleStage(layer, name => {
        const key = b.positions[name] !== undefined ? name : Object.keys(b.positions).find(n => nameKey(n) === nameKey(name));
        const pt = key ? parseCoord(b.positions[key], b.map) : null;
        if (!pt) return null;
        const scale = canvas.clientWidth / canvas.width || 1, tile = tileFor(b.map);
        return { x: (MARGIN + (pt.x + 0.5) * tile) * scale, y: ((b.map.h - pt.y - 1) * tile + 6) * scale };
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
        return { kind: 'combat', title: '⚔️ Battle map', sub: `Round ${w.combat.round ?? 1}`, map: w.combat.map, positions: w.combat.positions || {}, enemies: new Set(Object.keys(w.combat.enemies || {})) };
    }
    if (w.sketch?.map) {
        const hostile = new Set((c.docs.npcs || []).filter(n => n.attitude === 'hostile' && !n.dead).map(n => n.name));
        return { kind: 'sketch', key: w.sketch.key, title: `🗺️ ${w.sceneCard?.place ? String(w.sceneCard.place).split(/[,;.]/)[0] : w.location || 'The scene'}`, sub: w.location && w.sceneCard?.place && !nameKey(w.sceneCard.place).includes(nameKey(w.location)) ? w.location : '', map: w.sketch.map, positions: w.sketch.positions || {}, enemies: hostile, objects: w.sketch.objects || {}, zones: w.sketch.zones || {} };
    }
    return null;
}

function tileFor(map) {
    return map.w > 20 || map.h > 20 ? 48 : 64;
}

/** The clock in the map's corner: time of day, the hour, the day, and the weather. */
function clockChip(c) {
    const w = c.docs.world;
    const clock = ensureClock(w);
    const weather = WEATHER_WORDS[w.weather] ?? w.weather;
    return `<span class="dm-map-clock" title="${escapeHtml(`${clockText(w)} · ${weather}`)}">${timeIcon(clock.minutes)} ${hhmm(clock.minutes)} <i>day ${clock.day}</i> ${WEATHER_ICON[w.weather] ?? ''}</span>`;
}

/**
 * Minimized on a phone, the map is a bar just above the message box, never over it. The bar is placed by its
 * top edge from where the message box starts on screen (see .dm-map-min in style.css for why not "bottom").
 */
function anchorAboveForm() {
    const top = document.getElementById('form_sheld')?.getBoundingClientRect().top;
    panel.style.setProperty('--dm-form-top', `${Math.round(top || (window.innerHeight - 100))}px`);
}

let busy = false;

/** The DM is working: say so on the map and take no taps that move anyone until it's done. */
export function setMapBusy(on) {
    busy = Boolean(on);
    panel?.classList.toggle('dm-map-busy', busy);
    const strip = panel?.querySelector('.dm-map-turn');
    const c = strip ? campaign() : null;
    if (strip && c) strip.innerHTML = turnStrip(c);
}

function renderMap() {
    const c = campaign();
    const b = c ? board(c) : null;
    if (!b) {
        closeMap();
        return;
    }
    const map = b.map;
    const party = new Set([c.meta.persona.name, ...c.meta.party.map(p => p.name)]);
    const roster = Object.entries(b.positions).map(([name, coord]) => {
        const hp = hpOf(c, name);
        const cls = b.enemies.has(name) ? 'foe' : party.has(name) ? 'friend' : 'other';
        const zone = b.zones?.[name] && b.zones[name] !== 'player' ? ` · ${b.zones[name]}` : '';
        return `<span class="dm-map-chip ${cls}">${escapeHtml(name)} <b>${coord}</b>${hp ? ` · ${hp.hp}/${hp.hp_max}` : ''}${zone}</span>`;
    }).join('');
    const propItems = (map.props || []).filter(pr => !pr.hidden && !PROPS[pr.type]?.decal).map(pr => `<span>${escapeHtml(pr.label || PROPS[pr.type]?.name || pr.type)} <b>${toCoord(pr.x, pr.y)}</b></span>`);
    const props = propItems.length > 12 ? `<details><summary>${propItems.length} things on the map</summary>${propItems.join('')}</details>` : propItems.join('');
    const pending = [selection.move ? `move to ${selection.move}` : '', selection.target ? `target ${selection.target}` : ''].filter(Boolean).join(', ');
    const fight = b.kind === 'combat';

    // Where the player was looking: a redraw of the same board keeps the view right there.
    const oldView = panel.querySelector('.dm-map-view');
    const viewKey = `${b.kind}:${b.key ?? b.title}`;
    const kept = oldView?.isConnected && oldView.clientWidth && lastViewKey === viewKey ? { left: oldView.scrollLeft, top: oldView.scrollTop, body: panel.querySelector('.dm-map-body')?.scrollTop ?? 0 } : null;
    lastViewKey = viewKey;
    panel.classList.toggle('dm-map-wide', map.w > 16);
    panel.classList.toggle('dm-map-busy', busy);
    syncAmbient(c, b);
    anchorAboveForm();
    const hint = lockedReason(c, c.meta.persona.name)
        || (fight ? (pending ? pending : moveLeft(c).left > 0 ? `Your move: tap a lit square (${moveLeft(c).left} of ${moveLeft(c).max} squares left this round, ${moveLeft(c).left * 5} ft), or an enemy to target.` : 'No movement left this round (say you Dash for more). Tap an enemy to target.')
            : 'A sketch of the scene, drawn from the DM\'s words. Tap someone for a word with them, or a thing to go over to it.');
    panel.innerHTML = `
<div class="dm-map-head">
  <div class="dm-map-title"><b>${escapeHtml(b.title)}</b><span class="dm-muted">${escapeHtml(b.sub || '')}</span>${clockChip(c)}</div>
  <div class="dm-map-tools">
  <span class="dm-map-btn fa-solid fa-cloud-rain ${settings().mapAmbience === false ? 'dm-map-off' : ''}" data-act="ambience" title="Weather and ambient particles: on/off"></span>
  <span class="dm-map-btn fa-solid fa-window-minimize" data-act="min" title="Minimize"></span>
  <span class="dm-map-btn fa-solid fa-xmark" data-act="close" title="Close (reopen from the wand menu)"></span>
  </div>
</div>
${fight ? `<div class="dm-map-turn">${turnStrip(c)}</div>` : ''}
<div class="dm-map-body">
  <div class="dm-map-busy-note"><i class="fa-solid fa-hourglass-half"></i> The DM is thinking. Hold on: nobody moves until it's done.</div>
  <div class="dm-map-actions">
    <span class="dm-map-pending">${escapeHtml(hint)}</span>
    ${fight ? `<div class="menu_button" data-act="add" ${pending ? '' : 'disabled'}>Add to message</div><div class="menu_button" data-act="clear">Clear</div>` : ''}
  </div>
  <div class="dm-map-view"><div class="dm-map-stage"><canvas class="dm-map-canvas"></canvas><div class="dm-map-bubbles"></div></div></div>
  <div class="dm-map-hover dm-muted">&nbsp;</div>
  <div class="dm-map-roster">${roster}</div>
  ${props ? `<div class="dm-map-legend">${props}</div>` : ''}
</div>`;

    const canvas = panel.querySelector('.dm-map-canvas');
    const view = panel.querySelector('.dm-map-view');
    drawBoard(canvas, c, b);
    sizeCanvas(canvas, b);
    mountBubbles(canvas, b);
    if (kept) { view.scrollLeft = kept.left; view.scrollTop = kept.top; if (kept.body) panel.querySelector('.dm-map-body').scrollTop = kept.body; }
    canvas.addEventListener('click', ev => {
        closeMenu();
        const sq = squareFromEvent(ev, canvas, map);
        if (!sq) return;
        if (busy) { toastr.info('The DM is still working on the last turn. Wait for it to finish.', 'Dungeon Master'); return; }
        const who = whoAt(b.positions, map, sq);
        if (who) {
            if (!(who === c.meta.persona.name && showEscapeMenu(ev, c))) showPerson(ev, c, b, who);
            return;
        }
        if (fight) { onSquare(sq, b.positions); return; }
        const thing = thingAt(b, sq);
        if (thing) { openThingMenu(ev, c, thing); return; }
        // An empty square on the sketch: the player's figure goes there (a picture, nothing more).
        if (lockedReason(c, c.meta.persona.name)) { toastr.info(lockedReason(c, c.meta.persona.name), 'Map', { timeOut: 4000 }); return; }
        if (moveOnSketch(c.docs.world.sketch, c.meta.persona.name, sq.x, sq.y)) { saveDoc('world'); renderMap(); }
    });
    canvas.addEventListener('mousemove', ev => {
        const sq = squareFromEvent(ev, canvas, map);
        panel.querySelector('.dm-map-hover').textContent = sq ? describeSquare(b, sq) : ' ';
    });
    panel.querySelector('[data-act="close"]').addEventListener('click', closeMap);
    panel.querySelector('[data-act="ambience"]')?.addEventListener('click', () => { settings().mapAmbience = settings().mapAmbience === false; saveSettings(); renderMap(); });
    panel.querySelector('[data-act="min"]').addEventListener('click', () => {
        anchorAboveForm();
        panel.classList.toggle('dm-map-min');
        ensureLoop();
    });
    panel.querySelector('[data-act="clear"]')?.addEventListener('click', () => { selection = { move: '', target: '' }; renderMap(); });
    panel.querySelector('[data-act="add"]')?.addEventListener('click', addToMessage);
}

/** Big maps keep their real size (scrollable); small ones fit the panel. */
function sizeCanvas(canvas, b) {
    const big = b.map.w > 16 || b.map.h > 16;
    canvas.classList.toggle('dm-map-canvas-free', big);
    canvas.style.width = '';
}

// ---------- drawing: a static layer (map, labels) and the figures on top ----------

let live = null; // {canvas, c, b, layer, tile} for the animation loop
const motion = new Map(); // name -> {x, y, facing, walkUntil, anim, animStart, animUntil, hp}
let loopTimer = null;
const TICK_MS = 110; // about 9 frames a second: lively, and light on a phone
const FX_TICK_MS = 70; // about 14 a second while weather moves

function nameOffset(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h) % 2000;
}

/** Play an animation on someone's figure (attack, hurt) from the turn code. */
export function playAnim(name, anim, ms = anim === 'attack' ? 420 : 500) {
    if (anim === 'attack') sfx('whoosh');
    else if (anim === 'hurt') sfx('hit');
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
    const layer = live?.layer && live.layer.width === canvas.width && live.layer.height === canvas.height ? live.layer : document.createElement('canvas');
    layer.width = canvas.width; layer.height = canvas.height;
    const lctx = layer.getContext('2d');
    lctx.fillStyle = 'rgba(0,0,0,0.55)';
    lctx.fillRect(0, 0, layer.width, layer.height);
    lctx.drawImage(paintMapBase(map, tile), MARGIN, 0);
    // Labels: row numbers on the left (1 at the bottom), column letters along the bottom.
    lctx.fillStyle = 'rgba(255,255,255,0.75)';
    lctx.font = `${tile > 50 ? 13 : 11}px sans-serif`;
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    for (let y = 0; y < map.h; y++) lctx.fillText(String(y + 1), MARGIN / 2, (map.h - 1 - y) * tile + tile / 2);
    for (let x = 0; x < map.w; x++) lctx.fillText(colName(x), MARGIN + x * tile + tile / 2, map.h * tile + MARGIN / 2);
    const cell = (x, y) => [MARGIN + x * tile, (map.h - 1 - y) * tile];
    // Reach: the squares the player can get to this round (their speed, around walls and people).
    const reach = b.kind === 'combat' ? reachFor(c, b) : null;
    if (reach) {
        lctx.fillStyle = 'rgba(120,200,255,0.16)';
        for (const k of reach.keys()) { const [x, y] = k.split(',').map(Number); const [px, py] = cell(x, y); lctx.fillRect(px + 2, py + 2, tile - 4, tile - 4); }
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
        const o = { map: b.map, tile, margin: MARGIN, now, ambient, view: viewRect(canvas), seen: () => true, figures: figureFx(c, b) };
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
        const conds = conditionsOf(c.docs.world, name).join(' ').toLowerCase();
        const hp = hpOf(c, name);
        if (/asleep|sleeping/.test(conds)) out.push({ kind: 'z', x: pt.x, y: pt.y });
        else if (hp?.hp_max && hp.hp > 0 && hp.hp / hp.hp_max <= 0.25) out.push({ kind: 'drop', x: pt.x, y: pt.y });
    }
    return out;
}

/** Anything moving on the map right now: figures, or the ambience. */
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
        if (figures) {
            // A colored ring on the floor, the figure standing on it.
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.beginPath(); ctx.ellipse(cx, py + tile * 0.84, tile * 0.32, tile * 0.11, 0, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = selection.target === name ? '#ffd54a' : side;
            ctx.lineWidth = selection.target === name ? 4 : 2.5;
            ctx.beginPath(); ctx.ellipse(cx, py + tile * 0.84, tile * 0.34, tile * 0.12, 0, 0, Math.PI * 2); ctx.stroke();
            const m = motion.get(name) ?? {};
            let anim = 'idle', elapsed = now + nameOffset(name);
            const conds = conditionsOf(c.docs.world, name).join(' ').toLowerCase();
            const out = (hp && hp.hp_max && hp.hp <= 0) || /unconscious|knocked out|dead/.test(conds) || c.docs.world.combat?.enemies?.[name]?.dead;
            if (out) anim = 'down';
            else if (held.prone) anim = 'lie';
            else if (/asleep|sleeping/.test(conds)) anim = 'sleep';
            else if (m.anim && now < m.animUntil) { anim = m.anim; elapsed = now - m.animStart; }
            else if (m.walkUntil && now < m.walkUntil) anim = 'walk';
            else if (held.hurt || (hp?.hp_max && hp.hp / hp.hp_max <= 0.3)) anim = 'injured';
            const look = figureFor(name);
            const shown = held.bound && !look.beast ? { ...look, bound: held.bound } : look;
            drawFigure(ctx, shown, px, py - tile * 0.06, tile, { anim, elapsed, flip: (m.facing ?? (friends.has(name) ? 1 : -1)) < 0, red: anim === 'hurt' && Math.floor(elapsed / 120) % 2 === 0 });
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
        loopTimer = setTimeout(() => requestAnimationFrame(tick), live.fx ? FX_TICK_MS : TICK_MS);
    };
    loopTimer = setTimeout(() => requestAnimationFrame(tick), TICK_MS);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureLoop(); });

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
    const who = whoAt(b.positions, map, sq);
    const prop = squareName(map, sq.x, sq.y);
    const ground = TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'floor';
    return [toCoord(sq.x, sq.y), who, prop, ground].filter(Boolean).join(' · ');
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
        if (!isWalkable(map, sq.x, sq.y)) {
            toastr.info(`${coord} is ${squareName(map, sq.x, sq.y) || TERRAIN[terrainAt(map, sq.x, sq.y)]?.name || 'blocked'}: you can't stand there.`, 'Map', { timeOut: 2500 });
            return;
        }
        const b = board(c);
        const reach = b?.kind === 'combat' ? reachFor(c, b) : null;
        if (reach && !reach.has(`${sq.x},${sq.y}`)) {
            toastr.info(`Too far: ${c.meta.persona.name} has ${moveLeft(c).left} of ${moveLeft(c).max} squares left this round (${moveLeft(c).left * 5} ft). Tell the DM if you Dash.`, 'Map', { timeOut: 3500 });
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
}

// ---------- the tap menu for someone on the map ----------

function closeMenu() {
    panel?.querySelector('.dm-map-menu')?.remove();
}
if (typeof document !== 'undefined') document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

/** "Talk to Judy", "Talk to Wolf 1": the first name, unless the name is numbered or one word. */
function talkName(who) {
    const parts = String(who).split(' ');
    return parts.length > 1 && !/^\d+$/.test(parts.at(-1)) ? parts[0] : who;
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
}

/** Tapping someone: who they are, their health, and a word with them. What they do goes through the chat. */
function showPerson(ev, c, b, who) {
    const w = c.docs.world;
    const hp = hpOf(c, who);
    const conds = conditionsOf(w, who);
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(who));
    const lines = [
        hp?.hp_max ? `HP ${hp.hp}/${hp.hp_max}${hp.hp <= 0 ? ' (down)' : hp.hp / hp.hp_max <= 0.3 ? ' (badly hurt)' : ''}` : '',
        conds.length ? conds.join(', ') : '',
        (w.combat?.enemies?.[who]?.ac) ? `AC ${w.combat.enemies[who].ac}` : '',
        (w.inventory?.[who] || []).length ? `carries ${w.inventory[who].join(', ')}` : '',
        w.sceneCard?.people?.[who] || npc?.role || '',
    ].filter(Boolean);
    const player = c.meta.persona.name;
    const isPlayer = who === player;
    const companion = c.meta.party.some(p => p.name === who);
    const first = who.split(' ')[0];
    const actions = [];
    if (isPlayer) {
        // What they carry: put it down here, or hand it to a companion.
        const mine = w.inventory?.[who] || [];
        if (mine.length) {
            actions.push(['Drop something', 'fa-arrow-down', () => showMenu(ev, 'Put down what?', '', mine.map(it => [it, 'fa-box-open', () => { closeMenu(); sendAsPlayer(`*${player} puts down the ${it}.*`); }]))]);
            for (const n of c.meta.party.map(p => p.name)) actions.push([`Give to ${n.split(' ')[0]}`, 'fa-hand-holding', () => showMenu(ev, `Give ${n.split(' ')[0]} what?`, '', mine.map(it => [it, 'fa-box-open', () => { closeMenu(); sendAsPlayer(`*${player} hands ${n} the ${it}.*`); }]))]);
        }
    } else if (companion) {
        const chp = w.party?.[who];
        const out = Boolean(chp?.hp_max && chp.hp <= 0) || /unconscious|knocked out|dead/i.test(conds.join(' '));
        const prone = !out && conds.some(x => /^prone\b/i.test(String(x)));
        if (out) {
            actions.push([`Tend to ${first}`, 'fa-hand-holding-medical', () => { closeMenu(); sendAsPlayer(`*${player} kneels by ${who}, checks ${first} is breathing and looks over the hurts.*`); }]);
            actions.push(['Shake awake', 'fa-bell', () => { closeMenu(); sendAsPlayer(`*${player} shakes ${who} by the shoulder.* "${first}. ${first}! Wake up."`); }]);
        } else {
            if (prone) actions.push(['Help up', 'fa-hands-helping', () => { closeMenu(); sendAsPlayer(`*${player} takes ${who} by the arm and hauls ${first} up onto ${first}'s feet.*`); }]);
            actions.push([`Talk to ${talkName(who)}`, 'fa-comment', () => { closeMenu(); sendAsPlayer(`*${player} turns to ${who}.*`, { send: false }); }]);
            actions.push(['Wait here', 'fa-hand', () => { closeMenu(); sendAsPlayer(`*${player} turns to ${who}.* "Wait here, ${first}. I'll be back."`); }]);
            actions.push(['Come along', 'fa-person-walking', () => { closeMenu(); sendAsPlayer(`*${player} nods to ${who}.* "Come on, ${first}. With me."`); }]);
        }
    } else if (!(w.combat?.enemies?.[who]?.hp <= 0) && !npc?.dead) {
        actions.push([`Talk to ${talkName(who)}`, 'fa-comment', () => { closeMenu(); sendAsPlayer(`*${player} walks up to ${who}.*`, { send: false }); }]);
        actions.push(['Attack', 'fa-khanda', () => { closeMenu(); sendAsPlayer(`*${player} attacks ${who}!*`); }]);
        if (b.kind === 'combat') actions.push(['Target', 'fa-crosshairs', () => { closeMenu(); selection.target = who; renderMap(); }]);
    }
    showMenu(ev, who, lines.join(' · ') || (companion || isPlayer ? 'fine' : ''), actions);
}

// ---------- the tap menu for things on the sketch ----------

/** A thing of the scene at a square (the card's objects, drawn as props). */
function thingAt(b, sq) {
    const prop = propAt(b.map, sq.x, sq.y);
    if (!prop || PROPS[prop.type]?.decal) return null;
    return { prop, name: prop.label || PROPS[prop.type]?.name || prop.type };
}

function openThingMenu(ev, c, thing) {
    const player = c.meta.persona.name;
    const name = thing.name;
    showMenu(ev, name, c.docs.world.sceneCard?.objects?.[name] || '', [
        ['Go over to it', 'fa-person-walking', () => { closeMenu(); sendAsPlayer(`*${player} goes over to the ${name}.*`, { send: false }); }],
        ['Search it', 'fa-magnifying-glass', () => { closeMenu(); sendAsPlayer(`*${player} searches the ${name}.*`); }],
        ['Take it', 'fa-hand', () => { closeMenu(); sendAsPlayer(`*${player} takes the ${name}.*`); }],
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

/**
 * Tapped yourself while tied up, cuffed or caged: the ways to try to get free (each one is said in
 * the chat as what you do; the DM asks for the roll). Nothing when you can move.
 */
function showEscapeMenu(ev, c) {
    const player = c.meta.persona.name;
    const r = restraintOf(conditionsOf(c.docs.world, player));
    if (!r.locked || r.hurt) return false;
    const options = escapeOptions(player, r, { male: 'his', female: 'her' }[sexFromText(c.meta.persona.description || '') || ''] ?? 'their');
    if (!options.length) return false;
    showMenu(ev, player, lockedLine(player, r).replace(/\s*Tap .*$/, ''), options.map(([label, icon, text]) => [label, icon, () => { closeMenu(); sendAsPlayer(text); }]));
    return true;
}
