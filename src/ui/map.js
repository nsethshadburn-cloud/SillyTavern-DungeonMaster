// Battle map: pops up when combat starts. A chess-style grid (a1 bottom-left) with portraits,
// terrain and HP. Tap a square to move there, or tap an enemy to target it; the plugin writes
// "(move to d4)" / "(target Bandit 1)" into your message box so you can add what you do.
// Claude never sees an image: it reads and writes the map as plain text.

import { campaign } from '../st/campaign.js';
import { parseCoord, toCoord, colName, terrainAt, distance, TERRAIN, activeMap } from '../core/grid.js';
import { escapeHtml } from '../core/text.js';

const TERRAIN_CLASS = { '.': 'floor', '#': 'wall', '~': 'water', '^': 'rough', 'T': 'cover', '+': 'door', 'o': 'pit' };
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

function renderMap() {
    const c = campaign();
    const combat = activeMap(c?.docs.world);
    if (!combat?.map) {
        closeMap();
        return;
    }
    const inCombat = combat === c.docs.world.combat;
    const map = combat.map;
    const positions = combat.positions || {};
    const player = c.meta.persona.name;
    const friends = new Set([player, ...c.meta.party.map(p => p.name)]);
    const enemies = new Set(Object.keys(combat.enemies || {}));
    const byCell = {};
    for (const [name, coord] of Object.entries(positions)) {
        const p = parseCoord(coord, map);
        if (p) byCell[`${p.x},${p.y}`] = name;
    }
    const playerPos = parseCoord(positions[player], map);

    let cells = '';
    for (let y = map.h - 1; y >= 0; y--) {
        cells += `<div class="dm-map-label">${y + 1}</div>`;
        for (let x = 0; x < map.w; x++) {
            const t = terrainAt(map, x, y);
            const coord = toCoord(x, y);
            const who = byCell[`${x},${y}`];
            const inRange = playerPos && distance(playerPos, { x, y }) <= MOVE_SQUARES && TERRAIN[t]?.walk !== false;
            const classes = ['dm-cell', `t-${TERRAIN_CLASS[t] || 'floor'}`];
            if (inRange && !who) classes.push('dm-in-range');
            if (selection.move === coord) classes.push('dm-selected');
            let token = '';
            if (who) {
                const side = who === player ? 'me' : friends.has(who) ? 'friend' : enemies.has(who) ? 'foe' : 'npc';
                if (selection.target === who) classes.push('dm-selected');
                const hp = hpOf(c, who);
                const pct = hp?.hp_max ? Math.max(0, Math.min(100, (hp.hp / hp.hp_max) * 100)) : null;
                const img = portraitFor(c, who);
                token = `<div class="dm-token dm-${side}" title="${escapeHtml(who)}${hp ? ` · HP ${hp.hp}/${hp.hp_max}` : ''}">
                    ${img ? `<img src="${img}" alt="">` : `<span>${escapeHtml(initials(who))}</span>`}
                    ${pct !== null ? `<i class="dm-token-hp" style="width:${pct}%"></i>` : ''}
                </div>`;
            }
            cells += `<div class="${classes.join(' ')}" data-coord="${coord}"${who ? ` data-who="${escapeHtml(who)}"` : ''} title="${coord}${who ? ` · ${escapeHtml(who)}` : ` · ${TERRAIN[t]?.name || 'floor'}`}">${token}</div>`;
        }
    }
    let colLabels = '<div class="dm-map-label"></div>';
    for (let x = 0; x < map.w; x++) colLabels += `<div class="dm-map-label">${colName(x)}</div>`;

    const roster = Object.entries(positions).map(([name, coord]) => {
        const hp = hpOf(c, name);
        return `<span class="dm-map-chip ${enemies.has(name) ? 'foe' : 'friend'}">${escapeHtml(name)} <b>${coord}</b>${hp ? ` · ${hp.hp}/${hp.hp_max}` : ''}</span>`;
    }).join('');
    const pending = [selection.move ? `move to ${selection.move}` : '', selection.target ? `target ${selection.target}` : ''].filter(Boolean).join(', ');

    panel.innerHTML = `
<div class="dm-map-head">
  <b>${inCombat ? '⚔️ Battle map' : `🗺️ ${escapeHtml(combat.title || 'Map')}`}</b><span class="dm-muted">${inCombat ? `Round ${combat.round ?? 1}` : ''}</span>
  <span class="dm-map-btn fa-solid fa-window-minimize" data-act="min" title="Minimize"></span>
  <span class="dm-map-btn fa-solid fa-xmark" data-act="close" title="Close (reopen from the wand menu)"></span>
</div>
<div class="dm-map-body">
  <div class="dm-map-grid" style="grid-template-columns: 1.4em repeat(${map.w}, minmax(0, 1fr));">${cells}${colLabels}</div>
  <div class="dm-map-roster">${roster}</div>
  <div class="dm-map-actions">
    <span class="dm-map-pending">${pending ? escapeHtml(pending) : 'Tap a square to move, or an enemy to target.'}</span>
    <div class="menu_button" data-act="add" ${pending ? '' : 'disabled'}>Add to message</div>
    <div class="menu_button" data-act="clear">Clear</div>
  </div>
  <div class="dm-map-legend">${Object.entries(TERRAIN_CLASS).filter(([ch]) => ch !== '.').map(([ch, cls]) => `<span><i class="dm-cell t-${cls}"></i>${escapeHtml(TERRAIN[ch].name)}</span>`).join('')}<span><i class="dm-cell dm-in-range"></i>within ${MOVE_SQUARES} squares</span></div>
</div>`;

    panel.querySelectorAll('.dm-cell[data-coord]').forEach(el => el.addEventListener('click', () => onCell(el)));
    panel.querySelector('[data-act="close"]').addEventListener('click', closeMap);
    panel.querySelector('[data-act="min"]').addEventListener('click', () => panel.classList.toggle('dm-map-min'));
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => { selection = { move: '', target: '' }; renderMap(); });
    panel.querySelector('[data-act="add"]').addEventListener('click', addToMessage);
}

function onCell(el) {
    const c = campaign();
    const who = el.getAttribute('data-who');
    const coord = el.getAttribute('data-coord');
    if (who) {
        if (who === c.meta.persona.name) return;
        selection.target = selection.target === who ? '' : who;
    } else {
        const t = terrainAt(activeMap(c.docs.world).map, parseCoord(coord).x, parseCoord(coord).y);
        if (TERRAIN[t]?.walk === false) {
            toastr.info(`${coord} is ${TERRAIN[t].name}: you can't stand there.`, 'Battle map', { timeOut: 2500 });
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
