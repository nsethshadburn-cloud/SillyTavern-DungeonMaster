// Settings drawer in SillyTavern's Extensions panel.

import { ST } from '../st/st.js';
import { settings, saveSettings, connectionProfiles, currentSpend, SURPRISES } from '../st/settings.js';
import { DEFAULT_TEMPLATES, DEFAULT_LENGTHS } from '../core/notes.js';
import { buildNote, refreshStandingPrompt } from '../st/actors.js';
import { campaign } from '../st/campaign.js';
import { resetCaches } from '../st/orchestrator.js';
import { fetchVoices, syncVoicePool, speak, ttsConfig } from '../st/voices.js';
import { sheetMarkdown } from '../st/sheets.js';
import { escapeHtml } from '../core/text.js';
import { formatUsd } from '../core/budget.js';

const MODELS = [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-opus-5-5', 'Claude Opus 5.5 (pricier)'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)'],
];

function profileOptions(selected, { emptyLabel, filter = () => true }) {
    const opts = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    for (const p of connectionProfiles().filter(filter)) {
        const where = p['api-url'] ? ` · ${p['api-url']}` : '';
        opts.push(`<option value="${escapeHtml(p.id)}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.api || p.mode)}${escapeHtml(where)})</option>`);
    }
    return opts.join('');
}

function templateEditor(key, title, help) {
    const s = settings();
    return `<div class="dm-template">
  <div class="dm-template-head"><b>${escapeHtml(title)}</b><div class="menu_button" data-reset-template="${key}">Reset to default</div></div>
  ${help ? `<small>${escapeHtml(help)}</small>` : ''}
  <textarea class="text_pole" data-template="${key}" rows="5">${escapeHtml(s.templates[key])}</textarea>
</div>`;
}

function panelHtml() {
    const s = settings();
    const modelKnown = MODELS.some(([id]) => id === s.dmModel);
    return `
<div id="dm-settings" class="dm-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🎲 Dungeon Master <span class="dm-beta">BETA</span></b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="dm-beta-note">⚠️ Experimental and unstable. It can break things, spends real Claude credit, and creates chats, lorebooks and files. Back up your data. Use at your own risk.</div>
      <div class="dm-row">
        <div id="dm-start" class="menu_button menu_button_icon"><i class="fa-solid fa-dice-d20"></i> Start D&amp;D campaign</div>
        <div id="dm-open-screen" class="menu_button menu_button_icon"><i class="fa-solid fa-scroll"></i> DM Screen</div>
      </div>
      <label class="checkbox_label"><input id="dm-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> Enabled</label>

      <h4>Connections</h4>
      <label>Dungeon Master (Claude) profile
        <select id="dm-dm-profile" class="text_pole">${profileOptions(s.dmProfileId, { emptyLabel: 'Auto: first Claude profile / saved Claude key', filter: p => p.api === 'claude' })}</select></label>
      <label>DM model
        <select id="dm-model" class="text_pole">
          ${MODELS.map(([id, label]) => `<option value="${id}" ${id === s.dmModel ? 'selected' : ''}>${label}</option>`).join('')}
          <option value="__custom" ${modelKnown ? '' : 'selected'}>Custom…</option>
        </select></label>
      <input id="dm-model-custom" class="text_pole ${modelKnown ? 'dm-hidden' : ''}" placeholder="model id, e.g. claude-sonnet-5-5" value="${modelKnown ? '' : escapeHtml(s.dmModel)}">
      <label>DM thinking effort
        <select id="dm-effort" class="text_pole">
          ${['low', 'medium', 'high'].map(e => `<option value="${e}" ${e === s.dmEffort ? 'selected' : ''}>${e}${e === 'low' ? ' (cheapest, recommended)' : ''}</option>`).join('')}
        </select></label>
      <label>Actors (party members &amp; NPC voices)
        <select id="dm-actor-profile" class="text_pole">${profileOptions(s.actorProfileId, { emptyLabel: 'Current connection (whatever is selected)', filter: p => p.mode === 'tc' || p.api !== 'claude' })}</select></label>
      <label>Helper (quick decisions)
        <select id="dm-helper-profile" class="text_pole">${profileOptions(s.helperProfileId, { emptyLabel: 'Same as actors (current connection)', filter: p => p.api !== 'claude' })}</select></label>
      <label class="checkbox_label"><input id="dm-use-helper" type="checkbox" ${s.useHelper ? 'checked' : ''}> Use the helper to read your moves (saves Claude calls)</label>
      <small>Profiles come from SillyTavern's Connection Manager. A profile brings its own saved formats, so update old profiles before using them here.</small>

      <h4>Budget</h4>
      <div class="dm-grid2">
        <label>Monthly cap ($)<input id="dm-monthly" type="number" min="0" step="1" class="text_pole" value="${s.monthlyCap}"></label>
        <label>Nightly soft cap ($)<input id="dm-nightly" type="number" min="0" step="0.05" class="text_pole" value="${s.nightlySoftCap}"></label>
      </div>
      <div id="dm-spend" class="dm-muted"></div>
      <label class="checkbox_label"><input id="dm-caching" type="checkbox" ${s.cachingEnabled ? 'checked' : ''}> I turned on Claude prompt caching in config.yaml (<code>claude.enableSystemPromptCache: true</code>)</label>
      <details><summary>Prices (USD per million tokens) &amp; estimate tuning</summary>
        <div class="dm-grid2">
          <label>Input<input id="dm-p-in" type="number" step="0.01" class="text_pole" value="${s.priceInput}"></label>
          <label>Output<input id="dm-p-out" type="number" step="0.01" class="text_pole" value="${s.priceOutput}"></label>
          <label>Cache read<input id="dm-p-cr" type="number" step="0.01" class="text_pole" value="${s.priceCacheRead}"></label>
          <label>Cache write<input id="dm-p-cw" type="number" step="0.01" class="text_pole" value="${s.priceCacheWrite}"></label>
          <label>Thinking allowance (tokens/call)<input id="dm-think" type="number" step="50" class="text_pole" value="${s.thinkingAllowance}"></label>
        </div>
        <small>SillyTavern doesn't pass token usage back, so costs are estimates. Your Anthropic console shows real spend.</small>
      </details>

      <h4>Pacing</h4>
      <div class="dm-grid2">
        <label>DM check-in every N local turns<input id="dm-checkin" type="number" min="3" max="50" class="text_pole" value="${s.checkinEvery}"></label>
        <label>Usual session length (min)<input id="dm-session" type="number" min="15" max="600" class="text_pole" value="${s.usualSessionMinutes}"></label>
        <label>Chat messages sent to the DM<input id="dm-recent" type="number" min="6" max="80" class="text_pole" value="${s.recentMessages}"></label>
        <label>Max tokens added to local prompts<input id="dm-inject" type="number" min="100" max="2000" class="text_pole" value="${s.injectionMaxTokens}"></label>
      </div>

      <h4>What the bot is told</h4>
      <small>This works like a small system prompt for your roleplay model in D&amp;D chats. Your own system prompt, formatting and samplers are always used as they are; this is added on top.</small>
      <label class="checkbox_label"><input id="dm-hide-narration" type="checkbox" ${s.hideNarration ? 'checked' : ''}> Hide the DM's narration from the bot (it only gets the DM's private briefs)</label>
      <div class="dm-grid2">
        <label>Note position (0 = right before the reply)<input id="dm-note-depth" type="number" min="0" max="10" class="text_pole" value="${s.noteDepth}"></label>
        <label>Note sent as
          <select id="dm-note-role" class="text_pole">
            <option value="system" ${s.noteRole !== 'user' ? 'selected' : ''}>System message</option>
            <option value="user" ${s.noteRole === 'user' ? 'selected' : ''}>User message</option>
          </select></label>
      </div>
      ${templateEditor('scene', 'Scene note (every reply in a D&D chat)', 'Fill-ins: {{player}} {{party}} {{location}} {{present}} {{situation}} {{goal}} and SillyTavern macros like {{char}}. A line whose fill-in is empty is left out.')}
      ${templateEditor('brief', 'DM brief (only when Claude handles the turn)', 'Fill-ins: {{brief}} (what Claude says the character needs to know) and {{length}}.')}
      ${templateEditor('combat', 'Combat note (added during fights)', '')}
      ${templateEditor('npc', 'NPC note (side characters the bot voices)', 'Fill-ins: {{npc}} {{description}} {{pronouns}} {{attitude}} {{player}} {{party}}.')}
      <div class="dm-template">
        <div class="dm-template-head"><b>Reply lengths</b><div class="menu_button" data-reset-lengths>Reset to default</div></div>
        <div class="dm-grid2">
          <label>Short<input class="text_pole" data-length="short" value="${escapeHtml(s.lengths.short)}"></label>
          <label>Normal<input class="text_pole" data-length="normal" value="${escapeHtml(s.lengths.normal)}"></label>
          <label>Long<input class="text_pole" data-length="long" value="${escapeHtml(s.lengths.long)}"></label>
        </div>
      </div>
      <div class="dm-row"><div id="dm-preview-note" class="menu_button">Preview what the bot gets in this chat</div></div>

      <h4>Surprises</h4>
      <small>Things Claude may add to the world, only where they make sense.</small>
      ${Object.entries(SURPRISES).map(([k, label]) => `<label class="checkbox_label"><input type="checkbox" data-surprise="${k}" ${s.surprises[k] ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}
      <label>How often
        <select id="dm-surprise-freq" class="text_pole">
          ${['rare', 'occasional', 'often'].map(f => `<option value="${f}" ${f === s.surpriseFrequency ? 'selected' : ''}>${f}</option>`).join('')}
        </select></label>

      <h4>Voices (Chatterbox)</h4>
      <div id="dm-tts-note" class="dm-muted"></div>
      <label class="checkbox_label"><input id="dm-voices" type="checkbox" ${s.voicesEnabled ? 'checked' : ''}> Voice everyone in D&amp;D chats (DM, NPCs and party, one at a time, in order)</label>
      <small>While a D&amp;D chat is open, SillyTavern's own TTS is switched off so voices never overlap. It switches back on when you leave the chat. Party members use the voices you picked in SillyTavern's TTS panel.</small>
      <label>DM voice <select id="dm-dm-voice" class="text_pole"><option value="">(none)</option></select></label>
      <div class="dm-row"><div id="dm-voice-test" class="menu_button">Test DM voice</div><div id="dm-voice-refresh" class="menu_button">Refresh voices</div></div>
      <details><summary>NPC voice pool</summary>
        <small>Random NPCs get a random enabled voice matching their gender. Joke/celebrity voices and voices your characters use start disabled.</small>
        <div id="dm-pool" class="dm-pool"></div>
      </details>

      <h4>Display</h4>
      <label class="checkbox_label"><input id="dm-show-status" type="checkbox" ${s.showStatus ? 'checked' : ''}> Show the live status bar</label>
      <label class="checkbox_label"><input id="dm-collapse-status" type="checkbox" ${s.statusAutoCollapse ? 'checked' : ''}> Collapse it when a turn finishes</label>

      <h4>Character sheets</h4>
      <div id="dm-sheets" class="dm-sheets"></div>
    </div>
  </div>
</div>`;
}

function bindNumber(id, key) {
    $(`#${id}`).on('change', function () {
        const v = Number($(this).val());
        if (Number.isFinite(v)) {
            settings()[key] = v;
            saveSettings();
            renderSpend();
        }
    });
}

function bindCheck(id, key, after) {
    $(`#${id}`).on('change', function () {
        settings()[key] = $(this).is(':checked');
        saveSettings();
        after?.();
    });
}

function bindSelect(id, key) {
    $(`#${id}`).on('change', function () {
        settings()[key] = String($(this).val());
        saveSettings();
    });
}

export function renderSpend() {
    const s = settings();
    const { monthUsd, nightUsd } = currentSpend();
    $('#dm-spend').text(`Estimated spend: tonight ${formatUsd(nightUsd)} · this month ${formatUsd(monthUsd)} of $${s.monthlyCap}`);
}

async function renderVoices() {
    const s = settings();
    const cfg = ttsConfig();
    if (!cfg.isChatterbox) {
        $('#dm-tts-note').text(`Voices need SillyTavern's TTS set to Chatterbox (current: ${cfg.provider || 'none'}).`);
    } else if (!cfg.enabled) {
        $('#dm-tts-note').text('SillyTavern TTS is turned off. Turn it on in the TTS panel to hear voices.');
    } else {
        $('#dm-tts-note').text(`Chatterbox at ${cfg.endpoint}`);
    }
    const voices = await fetchVoices();
    const sel = $('#dm-dm-voice').empty().append('<option value="">(none)</option>');
    for (const v of voices) sel.append(`<option value="${escapeHtml(v.id)}" ${v.id === s.dmVoice ? 'selected' : ''}>${escapeHtml(v.name)}</option>`);
    const pool = await syncVoicePool();
    const box = $('#dm-pool').empty();
    for (const v of voices) {
        const entry = pool[v.id];
        if (!entry) continue;
        const row = $(`<div class="dm-pool-row">
            <label class="checkbox_label"><input type="checkbox" ${entry.enabled ? 'checked' : ''}> ${escapeHtml(v.name)}</label>
            <select class="text_pole">${['any', 'female', 'male'].map(g => `<option value="${g}" ${g === entry.gender ? 'selected' : ''}>${g}</option>`).join('')}</select>
        </div>`);
        row.find('input').on('change', function () { entry.enabled = $(this).is(':checked'); saveSettings(); });
        row.find('select').on('change', function () { entry.gender = String($(this).val()); saveSettings(); });
        box.append(row);
    }
    if (!voices.length) box.append('<small>No voices found.</small>');
}

export function renderSheets() {
    const s = settings();
    const box = $('#dm-sheets').empty();
    const rows = [
        ...Object.entries(s.personaSheets).map(([k, v]) => ({ kind: 'Persona', key: k, rec: v })),
        ...Object.entries(s.characterSheets).map(([k, v]) => ({ kind: 'Character', key: k, rec: v })),
    ];
    if (!rows.length) {
        box.append('<small>No sheets yet. Upload a persona sheet from the Persona panel (📜 button); party sheets are made when a campaign starts.</small>');
        return;
    }
    for (const r of rows) {
        const row = $(`<div class="dm-sheet-row"><span>${r.kind}: <b>${escapeHtml(r.rec.name)}</b> <small>${escapeHtml(new Date(r.rec.created).toLocaleDateString())} · 🔒 locked</small></span><div class="menu_button menu_button_icon fa-solid fa-eye" title="View"></div></div>`);
        row.find('.fa-eye').on('click', async () => {
            const md = await sheetMarkdown(r.rec);
            const html = ST.messageFormatting(md, '', false, false, -1);
            await ST.callGenericPopup(`<div class="dm-sheet-view">${html}</div>`, ST.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
        });
        box.append(row);
    }
}

export async function mountSettingsPanel({ onStart, onScreen }) {
    const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    target.append(panelHtml());
    $('#dm-start').on('click', onStart);
    $('#dm-open-screen').on('click', onScreen);
    bindCheck('dm-enabled', 'enabled');
    bindSelect('dm-dm-profile', 'dmProfileId');
    $('#dm-model').on('change', function () {
        const v = String($(this).val());
        $('#dm-model-custom').toggleClass('dm-hidden', v !== '__custom');
        if (v !== '__custom') { settings().dmModel = v; saveSettings(); }
    });
    $('#dm-model-custom').on('change', function () {
        const v = String($(this).val()).trim();
        if (v) { settings().dmModel = v; saveSettings(); }
    });
    bindSelect('dm-effort', 'dmEffort');
    bindSelect('dm-actor-profile', 'actorProfileId');
    bindSelect('dm-helper-profile', 'helperProfileId');
    bindCheck('dm-use-helper', 'useHelper');
    bindNumber('dm-monthly', 'monthlyCap');
    bindNumber('dm-nightly', 'nightlySoftCap');
    bindCheck('dm-caching', 'cachingEnabled');
    bindNumber('dm-p-in', 'priceInput');
    bindNumber('dm-p-out', 'priceOutput');
    bindNumber('dm-p-cr', 'priceCacheRead');
    bindNumber('dm-p-cw', 'priceCacheWrite');
    bindNumber('dm-think', 'thinkingAllowance');
    bindNumber('dm-checkin', 'checkinEvery');
    bindNumber('dm-session', 'usualSessionMinutes');
    bindNumber('dm-recent', 'recentMessages');
    bindNumber('dm-inject', 'injectionMaxTokens');
    bindCheck('dm-voices', 'voicesEnabled', async () => {
        const { syncTtsTakeover } = await import('../st/voices.js');
        syncTtsTakeover(Boolean(campaign() && !campaign().meta.paused));
    });
    bindCheck('dm-hide-narration', 'hideNarration');
    bindNumber('dm-note-depth', 'noteDepth');
    $('#dm-note-depth').on('change', () => refreshStandingPrompt());
    $('#dm-note-role').on('change', function () {
        settings().noteRole = String($(this).val());
        saveSettings();
        refreshStandingPrompt();
    });
    $('#dm-settings [data-template]').on('input', function () {
        settings().templates[$(this).data('template')] = String($(this).val());
        saveSettings();
        refreshStandingPrompt();
    });
    $('#dm-settings [data-reset-template]').on('click', async function () {
        const key = $(this).data('reset-template');
        const ok = await ST.callGenericPopup('Reset this template to the default text? Your edits to it will be lost.', ST.POPUP_TYPE.CONFIRM);
        if (ok !== ST.POPUP_RESULT.AFFIRMATIVE) return;
        settings().templates[key] = DEFAULT_TEMPLATES[key];
        $(`#dm-settings [data-template="${key}"]`).val(DEFAULT_TEMPLATES[key]);
        saveSettings();
        refreshStandingPrompt();
    });
    $('#dm-settings [data-length]').on('input', function () {
        settings().lengths[$(this).data('length')] = String($(this).val());
        saveSettings();
    });
    $('#dm-settings [data-reset-lengths]').on('click', () => {
        settings().lengths = { ...DEFAULT_LENGTHS };
        for (const [k, v] of Object.entries(DEFAULT_LENGTHS)) $(`#dm-settings [data-length="${k}"]`).val(v);
        saveSettings();
    });
    $('#dm-preview-note').on('click', async () => {
        if (!campaign()) return toastr.info('Open a D&D chat to preview what the bot gets there.', 'Dungeon Master');
        const char = campaign().meta.party[0]?.name || '{{char}}';
        const fill = (t) => t.replaceAll('{{char}}', char);
        const base = fill(buildNote());
        const withBrief = fill(buildNote({ brief: '(example) The riders are closing in. She wants Amber to give up before anyone gets hurt.', length: 'normal' }));
        await ST.callGenericPopup(
            `<h3>What ${escapeHtml(char)} gets in this chat</h3><p>Plain roleplay turns:</p><div class="dm-preview">${escapeHtml(base)}</div><p>When Claude handles the turn (example brief):</p><div class="dm-preview">${escapeHtml(withBrief)}</div><small>Position: ${settings().noteDepth === 0 ? 'right before the reply' : `${settings().noteDepth} message(s) back`}, as a ${settings().noteRole === 'user' ? 'user' : 'system'} message. ${settings().hideNarration ? 'The DM\'s narration is hidden from the bot.' : 'The DM\'s narration is visible to the bot.'}</small>`,
            ST.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true },
        );
    });
    $('#dm-settings [data-surprise]').on('change', function () {
        settings().surprises[$(this).data('surprise')] = $(this).is(':checked');
        saveSettings();
        resetCaches();
    });
    $('#dm-surprise-freq').on('change', function () {
        settings().surpriseFrequency = String($(this).val());
        saveSettings();
        resetCaches();
    });
    bindSelect('dm-dm-voice', 'dmVoice');
    bindCheck('dm-show-status', 'showStatus');
    bindCheck('dm-collapse-status', 'statusAutoCollapse');
    $('#dm-voice-test').on('click', () => {
        const v = settings().dmVoice;
        if (!v) return toastr.info('Pick a DM voice first.', 'Dungeon Master');
        speak('The road ahead is dark, and something is watching from the trees.', v);
    });
    $('#dm-voice-refresh').on('click', async () => {
        await fetchVoices(true);
        await renderVoices();
    });
    renderSpend();
    renderSheets();
    // Voices need the TTS extension's settings, which load a moment later.
    setTimeout(() => renderVoices().catch(err => console.warn('[Dungeon Master] voices', err)), 1500);
}

/** Re-render profile dropdowns (profiles can change while SillyTavern runs). */
export function refreshProfileSelects() {
    const s = settings();
    $('#dm-dm-profile').html(profileOptions(s.dmProfileId, { emptyLabel: 'Auto: first Claude profile / saved Claude key', filter: p => p.api === 'claude' }));
    $('#dm-actor-profile').html(profileOptions(s.actorProfileId, { emptyLabel: 'Current connection (whatever is selected)', filter: p => p.mode === 'tc' || p.api !== 'claude' }));
    $('#dm-helper-profile').html(profileOptions(s.helperProfileId, { emptyLabel: 'Same as actors (current connection)', filter: p => p.api !== 'claude' }));
}
