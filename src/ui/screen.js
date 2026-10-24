// The DM Screen: a side panel showing the campaign at a glance.

import { ST } from '../st/st.js';
import { settings, currentSpend } from '../st/settings.js';
import { campaign, saveMeta, saveDoc } from '../st/campaign.js';
import { askDmNow, runTurn, resetCaches } from '../st/orchestrator.js';
import { recap } from '../st/dm.js';
import { postNarration } from '../st/messages.js';
import { refreshStandingPrompt, clearPrompts } from '../st/actors.js';
import { voiceLine, syncTtsTakeover } from '../st/voices.js';
import { toggleMap } from './map.js';
import { turnHistory } from './status.js';
import { escapeHtml } from '../core/text.js';
import { formatUsd } from '../core/budget.js';
import { driftBudget, PRESSURE_STAGES, nextBeat } from '../core/pacing.js';

let panel = null;

function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'dm-screen';
    panel.className = 'dm-screen dm-hidden';
    document.body.appendChild(panel);
    return panel;
}

export function toggleScreen(force) {
    const el = ensurePanel();
    const show = force ?? el.classList.contains('dm-hidden');
    el.classList.toggle('dm-hidden', !show);
    if (show) renderScreen();
}

export function isScreenOpen() {
    return panel && !panel.classList.contains('dm-hidden');
}

function plotHtml(plot) {
    return String(plot || '').split('\n').map(line => {
        const done = line.match(/^\s*-\s*\[x\]\s*(.*)$/i);
        const open = line.match(/^\s*-\s*\[ \]\s*(.*)$/);
        const head = line.match(/^#+\s*(.*)$/);
        if (head) return `<div class="dm-plot-act">${escapeHtml(head[1])}</div>`;
        if (done) return `<div class="dm-plot-beat dm-done-beat">☑ ${escapeHtml(done[1])}</div>`;
        if (open) return `<div class="dm-plot-beat">☐ ${escapeHtml(open[1])}</div>`;
        return '';
    }).join('');
}

function meter(value, max) {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    return `<div class="dm-meter"><div class="dm-meter-fill" style="width:${pct}%"></div></div>`;
}

export function renderScreen() {
    if (!isScreenOpen()) return;
    const c = campaign();
    const s = settings();
    const spend = currentSpend();
    const head = `<div class="dm-screen-head"><b>🎲 DM Screen</b><span class="dm-screen-close fa-solid fa-xmark" title="Close"></span></div>`;
    if (!c) {
        panel.innerHTML = `${head}<div class="dm-screen-body"><p>No campaign in this chat.</p><div id="dm-scr-start" class="menu_button">Start a D&amp;D campaign</div>
        <p class="dm-muted">Spend: tonight ${formatUsd(spend.nightUsd)} · month ${formatUsd(spend.monthUsd)} / $${s.monthlyCap}</p></div>`;
        panel.querySelector('.dm-screen-close').addEventListener('click', () => toggleScreen(false));
        panel.querySelector('#dm-scr-start').addEventListener('click', () => $('#dm-start').trigger('click'));
        return;
    }
    const m = c.meta;
    const w = c.docs.world;
    const p = m.pacing;
    const budget = driftBudget(m.options.length);
    const party = Object.entries(w.party).map(([n, v]) => `<div class="dm-hp-row"><span>${escapeHtml(n)}</span>${meter(v.hp, v.hp_max || 1)}<small>${v.hp}/${v.hp_max}${v.conditions?.length ? ` · ${escapeHtml(v.conditions.join(', '))}` : ''}</small></div>`).join('');
    const enemies = w.combat ? Object.entries(w.combat.enemies).map(([n, e]) => `<div class="dm-hp-row dm-enemy"><span>${escapeHtml(n)}</span>${meter(e.hp, e.hp_max || 1)}<small>${e.hp}/${e.hp_max} · AC ${e.ac}</small></div>`).join('') : '';
    const events = c.docs.events_log.slice(-6).reverse().map(e => `<li>${escapeHtml(e.title)} <small>(turn ${e.turn})</small></li>`).join('') || '<li class="dm-muted">none yet</li>';
    const rolls = c.docs.rolls_log.slice(-6).reverse().map(r => `<li>${escapeHtml(r.who)}: ${escapeHtml(r.what)} = <b>${r.total}</b>${r.success === true ? ' ✔' : r.success === false ? ' ✘' : ''}</li>`).join('') || '<li class="dm-muted">none yet</li>';
    const turns = turnHistory().slice(-5).reverse().map(t => `<li>${escapeHtml(t.at)} · ${escapeHtml(t.title)} <small>${t.secs.toFixed(1)}s${t.usd ? ` · ${formatUsd(t.usd)}` : ''}</small></li>`).join('') || '<li class="dm-muted">none yet</li>';
    const npcs = (c.docs.npcs || []).slice(-8).reverse().map(n => `<li><b>${escapeHtml(n.name)}</b> <small>${escapeHtml(n.attitude)}${n.voice ? ' · 🔊' : ''}</small></li>`).join('') || '<li class="dm-muted">none yet</li>';

    panel.innerHTML = `${head}
<div class="dm-screen-body">
  <div class="dm-scr-title">${escapeHtml(m.title)}${m.paused ? ' <span class="dm-badge">paused</span>' : ''}</div>
  <div class="dm-muted">${escapeHtml(w.location || 'somewhere')} · ${escapeHtml(w.time || '')} · day ${w.day ?? 1}</div>
  <div class="dm-scr-buttons">
    <div class="menu_button" id="dm-scr-ask" title="Ask the DM something out of character">Ask the DM</div>
    <div class="menu_button" id="dm-scr-force" title="Have the DM step in now">DM step in</div>
    <div class="menu_button" id="dm-scr-recap" title="Previously on…">Recap</div>
    <div class="menu_button" id="dm-scr-resync" title="After deleting or editing messages: Claude re-reads the chat and fixes what it has logged">Fix mismatch</div>
    ${w.combat || w.sceneMap ? '<div class="menu_button" id="dm-scr-map" title="Map">Map</div>' : ''}
    <div class="menu_button" id="dm-scr-pause">${m.paused ? 'Resume' : 'Pause'}</div>
  </div>
  ${m.pendingRoll ? `<div class="dm-scr-note">Waiting for your roll: <b>${escapeHtml(m.pendingRoll.skill)}</b> <span class="menu_button" id="dm-scr-cancel-roll">Cancel</span></div>` : ''}
  <h5>Pacing</h5>
  <div class="dm-kv"><span>Scene</span><b>${escapeHtml(p.sceneType)}</b></div>
  <div class="dm-kv"><span>Tension</span>${meter(p.tension, 10)}<small>${p.tension}/10</small></div>
  <div class="dm-kv"><span>Off-plot</span>${meter(p.turnsSinceBeat, budget[budget.length - 1])}<small>${p.turnsSinceBeat} turns · pressure: ${PRESSURE_STAGES[Math.min(p.driftStage ?? 0, PRESSURE_STAGES.length - 1)].name}${nextBeat(c.docs.plot) ? ` · next: ${escapeHtml(nextBeat(c.docs.plot).id)}` : ''}</small></div>
  <div class="dm-kv"><span>Engagement</span>${meter(p.fun, 3)}<small>${p.fun}</small></div>
  <div class="dm-muted">Recent scenes: ${escapeHtml([...p.sceneHistory.slice(-4), p.sceneType].join(' → '))}</div>
  <h5>Party</h5>${party || '<div class="dm-muted">unknown</div>'}
  ${enemies ? `<h5>Enemies (round ${w.combat.round})</h5>${enemies}` : ''}
  <div class="dm-muted">Gold ${w.gold ?? 0}${w.items?.length ? ` · ${escapeHtml(w.items.join(', '))}` : ''}</div>
  <h5>Plot</h5><div class="dm-plot">${plotHtml(c.docs.plot)}</div>
  <h5>NPCs</h5><ul>${npcs}</ul>
  <h5>Events</h5><ul>${events}</ul>
  <h5>Rolls</h5><ul>${rolls}</ul>
  <h5>Recent turns</h5><ul>${turns}</ul>
  <h5>Spend (estimates)</h5>
  <div class="dm-muted">Tonight ${formatUsd(spend.nightUsd)} · month ${formatUsd(spend.monthUsd)} / $${s.monthlyCap} · this campaign ${formatUsd(m.stats.usd)} over ${m.stats.dmCalls || 0} DM calls, ${m.stats.localTurns || 0} local-only turns</div>
  <h5>Files</h5>
  <div class="dm-scr-buttons">
    <div class="menu_button" data-file="bible">Bible</div>
    <div class="menu_button" data-file="plot">Plot</div>
    <div class="menu_button" data-file="notes">DM notes</div>
    <div class="menu_button" data-file="story">Story so far</div>
  </div>
</div>`;
    panel.querySelector('.dm-screen-close').addEventListener('click', () => toggleScreen(false));
    panel.querySelector('#dm-scr-ask').addEventListener('click', async () => {
        const q = await ST.callGenericPopup('Ask the Dungeon Master (out of character):', ST.POPUP_TYPE.INPUT, '', { rows: 3 });
        if (q) askDmNow(String(q));
    });
    panel.querySelector('#dm-scr-force').addEventListener('click', () => runTurn({ force: 'manual' }));
    panel.querySelector('#dm-scr-recap').addEventListener('click', async () => {
        try {
            const { withDmThinking } = await import('./thinking.js');
            const r = await withDmThinking('The Dungeon Master is writing a recap', () => recap());
            await postNarration(`**Previously…** ${r.text}`);
            voiceLine({ kind: 'dm', text: r.text });
        } catch (error) {
            toastr.error(String(error?.message || error), 'Dungeon Master');
        }
    });
    panel.querySelector('#dm-scr-pause').addEventListener('click', () => {
        m.paused = !m.paused;
        saveMeta();
        if (m.paused) clearPrompts();
        else refreshStandingPrompt();
        syncTtsTakeover(!m.paused);
        renderScreen();
        toastr.info(m.paused ? 'D&D mode paused: this chat behaves like a normal group chat.' : 'D&D mode resumed.', 'Dungeon Master');
    });
    panel.querySelector('#dm-scr-map')?.addEventListener('click', () => toggleMap());
    panel.querySelector('#dm-scr-resync').addEventListener('click', () => runResync());
    panel.querySelector('#dm-scr-skip')?.addEventListener('click', () => {
        m.pendingEvent = null;
        saveMeta();
        renderScreen();
    });
    panel.querySelector('#dm-scr-cancel-roll')?.addEventListener('click', () => {
        m.pendingRoll = null;
        saveMeta();
        renderScreen();
    });
    panel.querySelectorAll('[data-file]').forEach(el => el.addEventListener('click', () => openDoc(el.getAttribute('data-file'))));
}

async function openDoc(key) {
    const c = campaign();
    if (!c) return;
    const titles = { bible: 'Campaign bible', plot: 'Plot', notes: 'DM notes (private)', story: 'Story so far' };
    const result = await ST.callGenericPopup(`<h3>${titles[key]}</h3><small>You can edit this. The DM reads the saved version on its next turn.</small>`, ST.POPUP_TYPE.INPUT, c.docs[key] || '', { rows: 24, wide: true, large: true, okButton: 'Save', cancelButton: 'Close' });
    if (typeof result === 'string' && result !== c.docs[key]) {
        c.docs[key] = result;
        saveDoc(key);
        if (key === 'bible') resetCaches();
        toastr.success('Saved.', 'Dungeon Master');
        renderScreen();
    }
}

/** "Fix mismatch": Claude re-reads the chat and corrects its logs. */
export async function runResync() {
    toastr.info('Re-reading the chat to fix the DM\'s logs…', 'Dungeon Master');
    try {
        const { resyncWithChat } = await import('../st/dm.js');
        const { withDmThinking } = await import('./thinking.js');
        const r = await withDmThinking('The Dungeon Master is re-reading the chat', () => resyncWithChat());
        const { postOoc } = await import('../st/messages.js');
        await postOoc(`Fixed to match the chat: ${r.summary}`);
        const { refreshStandingPrompt } = await import('../st/actors.js');
        refreshStandingPrompt();
        renderScreen();
    } catch (error) {
        toastr.error(String(error?.message || error), 'Dungeon Master');
    }
}
