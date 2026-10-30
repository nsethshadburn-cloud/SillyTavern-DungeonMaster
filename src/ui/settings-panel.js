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
import { TASKS, defaultTaskModels } from '../core/models.js';

const MODELS = [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-opus-5-5', 'Claude Opus 5.5 (pricier)'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest, recommended for routine turns)'],
];

function profileOptions(selected, { emptyLabel, filter = () => true }) {
    const opts = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
    for (const p of connectionProfiles().filter(filter)) {
        const where = p['api-url'] ? ` · ${p['api-url']}` : '';
        opts.push(`<option value="${escapeHtml(p.id)}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.api || p.mode)}${escapeHtml(where)})</option>`);
    }
    return opts.join('');
}

/** A model picker with a "Custom…" box. */
function modelPicker(id, value, label) {
    const known = MODELS.some(([m]) => m === value);
    return `<label>${label}
        <select id="${id}" class="text_pole">
          ${MODELS.map(([m, text]) => `<option value="${m}" ${m === value ? 'selected' : ''}>${text}</option>`).join('')}
          <option value="__custom" ${known ? '' : 'selected'}>Custom…</option>
        </select></label>
      <input id="${id}-custom" class="text_pole ${known ? 'dm-hidden' : ''}" placeholder="model id, e.g. claude-sonnet-5-5" value="${known ? '' : escapeHtml(value)}">`;
}

function bindModelPicker(id, onPick) {
    $(`#${id}`).on('change', function () {
        const v = String($(this).val());
        $(`#${id}-custom`).toggleClass('dm-hidden', v !== '__custom');
        if (v !== '__custom') onPick(v);
    });
    $(`#${id}-custom`).on('change', function () {
        const v = String($(this).val()).trim();
        if (v) onPick(v);
    });
}

/** Every model id the per-job dropdowns can offer: the known list plus any custom ids in use. */
function modelChoices() {
    const s = settings();
    const short = id => (MODELS.find(([m]) => m === id)?.[1] ?? id).replace(/ \(.*\)$/, '');
    const ids = [...new Set([...MODELS.map(([m]) => m), s.dmModel, ...Object.values(s.taskModels), s.criticalModel].filter(Boolean))];
    return ids.map(id => [id, short(id)]);
}

/** The per-job model dropdowns, grouped as in core/models.js TASKS. */
function renderTaskModels() {
    const s = settings();
    const choices = modelChoices();
    const options = value => choices.map(([id, text]) => `<option value="${escapeHtml(id)}" ${id === value ? 'selected' : ''}>${escapeHtml(text)}${id === s.dmModel ? ' (main)' : ''}</option>`).join('');
    const groups = [...new Set(TASKS.map(t => t.group))];
    const html = groups.map(g => `<div class="dm-task-group"><b>${escapeHtml(g)}</b>${TASKS.filter(t => t.group === g).map(t => `
        <label class="dm-task-row"><span>${escapeHtml(t.label)}</span><select class="text_pole" data-task-model="${t.key}">${options(s.taskModels[t.key])}</select></label>`).join('')}</div>`).join('')
        + `<div class="dm-task-group"><b>Dice</b>
        <label class="dm-task-row"><span>Turns with your natural 1 or 20</span><select class="text_pole" id="dm-critical-model"><option value="" ${s.criticalModel ? '' : 'selected'}>Same as the turn</option>${options(s.criticalModel)}</select></label></div>`;
    $('#dm-task-models-body').html(html);
}

/** Price rows for the models in use (USD per million tokens). */
function renderPrices() {
    const s = settings();
    const models = [...new Set([s.dmModel, ...(s.hybridModels ? [...Object.values(s.taskModels), s.criticalModel] : [])].filter(Boolean))];
    const rows = models.map(m => {
        const p = s.modelPrices[m] ?? { input: s.priceInput, output: s.priceOutput, cacheRead: s.priceCacheRead };
        const field = (k, label) => `<label>${label}<input type="number" step="0.01" min="0" class="text_pole" data-price-model="${escapeHtml(m)}" data-price-key="${k}" value="${p[k]}"></label>`;
        return `<div class="dm-price-row"><b>${escapeHtml(m)}</b><div class="dm-grid2">${field('input', 'Input')}${field('output', 'Output')}${field('cacheRead', 'Cache read')}</div></div>`;
    });
    $('#dm-prices').html(rows.join(''));
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

      <h4>Dungeon Master models</h4>
      ${modelPicker('dm-model', s.dmModel, 'Main DM model')}
      <label class="checkbox_label"><input id="dm-hybrid" type="checkbox" ${s.hybridModels ? 'checked' : ''}> Hybrid models: each job uses its own model (recommended, much cheaper). Off = the main model does everything.</label>
      <div id="dm-task-models" class="${s.hybridModels ? '' : 'dm-hidden'}">
        <small>Recommended: Sonnet for setup, story direction and combat; Haiku for everyday play.</small>
        <div id="dm-task-models-body"></div>
        <label class="checkbox_label"><input id="dm-hand-up" type="checkbox" ${s.handUp ? 'checked' : ''}> Let cheaper models hand a big story moment (major reveal, plot beat, a fight breaking out, a new chapter) up to the main model</label>
        <div id="dm-task-models-reset" class="menu_button">Reset to recommended</div>
      </div>
      <label>DM thinking effort
        <select id="dm-effort" class="text_pole">
          ${['low', 'medium', 'high'].map(e => `<option value="${e}" ${e === s.dmEffort ? 'selected' : ''}>${e}${e === 'low' ? ' (cheapest, recommended)' : ''}</option>`).join('')}
        </select></label>
      <label>Actors (party members &amp; NPC voices)
        <select id="dm-actor-profile" class="text_pole">${profileOptions(s.actorProfileId, { emptyLabel: 'Current connection (whatever is selected)', filter: p => p.mode === 'tc' || p.api !== 'claude' })}</select></label>
      <label>Helper (quick decisions)
        <select id="dm-helper-profile" class="text_pole">${profileOptions(s.helperProfileId, { emptyLabel: 'Same as actors (current connection)', filter: p => p.api !== 'claude' })}</select></label>
      <label>Maps
        <select id="dm-map-tier" class="text_pole">
          <option value="off" ${s.mapTier === 'off' ? 'selected' : ''}>Off: no maps, the whole campaign stays in the chat</option>
          <option value="some" ${!s.mapTier || s.mapTier === 'some' ? 'selected' : ''}>Sometimes: maps where they're needed, or when you ask</option>
          <option value="always" ${s.mapTier === 'always' ? 'selected' : ''}>Always: a map for every new place (small for a short stop, big only for big story places)</option>
        </select></label>
      <label class="checkbox_label"><input id="dm-use-helper" type="checkbox" ${s.useHelper ? 'checked' : ''}> Use the helper to read your moves (saves Claude calls)</label>
      <label class="checkbox_label"><input id="dm-bookkeeper" type="checkbox" ${s.bookkeeper !== false ? 'checked' : ''}> Bookkeeper: after each turn the helper checks what was said against everyone's conditions and items, and fills in what the DM forgot (shown on a 📜 card)</label>
      <label class="dm-task-row"><span>Map builder: how new maps are made</span><select id="dm-map-builder" class="text_pole"><option value="algorithm" ${(s.mapBuilder ?? 'algorithm') === 'algorithm' ? 'selected' : ''}>Algorithm from a short brief (seconds, nearly free)</option><option value="claude" ${s.mapBuilder === 'claude' ? 'selected' : ''}>Claude plans every room (slow, about $0.05–0.30)</option></select></label>
      <label class="dm-task-row"><span>Who writes a map's brief</span><select id="dm-map-brief" class="text_pole"><option value="local" ${(s.mapBrief ?? 'local') === 'local' ? 'selected' : ''}>Local helper (free; Haiku if there is no helper)</option><option value="haiku" ${s.mapBrief === 'haiku' ? 'selected' : ''}>Haiku</option></select></label>
      <label class="dm-task-row"><span>Map sync: after each turn, put on the map what the story did (someone appears, walks over to something, hides, a door is kicked in)</span><select id="dm-map-sync" class="text_pole"><option value="local" ${(s.mapSync ?? 'local') === 'local' ? 'selected' : ''}>Local helper (free; Haiku if there is no helper)</option><option value="claude" ${s.mapSync === 'claude' ? 'selected' : ''}>Haiku</option><option value="off" ${s.mapSync === 'off' ? 'selected' : ''}>Off</option></select></label>
      <label class="checkbox_label"><input id="dm-auto-dice" type="checkbox" ${s.autoReadDice ? 'checked' : ''}> Read SillyTavern's dice rolls automatically when the DM asks for a roll (no need to type the number)</label>
      <label class="checkbox_label"><input id="dm-map-figures" type="checkbox" ${s.mapFigures !== false ? 'checked' : ''}> Little animated figures on the map (off = round portraits). Your party's are drawn once by Claude from their card and picture (about 1-2 cents each); type <code>/dmfigure Judy</code> to redraw one.</label>
      <label class="checkbox_label"><input id="dm-map-ambience" type="checkbox" ${s.mapAmbience !== false ? 'checked' : ''}> Weather and ambient particles on the map (rain, snow, dust, fireflies, glints on water, flickering torches). Fire and spell effects always show. Also a button on the map.</label>
      <label class="checkbox_label"><input id="dm-map-bubbles" type="checkbox" ${s.mapBubbles !== false ? 'checked' : ''}> Speech bubbles on the map: what a companion or NPC says appears over their figure, word by word, in time with their voice (right away when voices are off), and stays a few seconds after they finish.</label>
      <label class="checkbox_label"><input id="dm-turn-prompts" type="checkbox" ${s.turnPrompts !== false ? 'checked' : ''}> Turn prompts in a fight: after your action, a popup asks whether your turn is done (you may still move); before an enemy's hit lands, it asks whether you react (Uncanny Dodge halves it; anything else goes to the DM).</label>
      <label class="checkbox_label"><input id="dm-guards-talk" type="checkbox" ${s.guardsTalk !== false ? 'checked' : ''}> Guards and locals talk: when one sees you and has a word to say, now and then it comes from the local model (one short line) instead of the canned pool.</label>
      <small>Profiles come from SillyTavern's Connection Manager. A profile brings its own saved formats, so update old profiles before using them here.</small>

      <h4>Budget</h4>
      <div class="dm-grid2">
        <label>Monthly cap ($)<input id="dm-monthly" type="number" min="0" step="1" class="text_pole" value="${s.monthlyCap}"></label>
        <label>Nightly soft cap ($)<input id="dm-nightly" type="number" min="0" step="0.05" class="text_pole" value="${s.nightlySoftCap}"></label>
      </div>
      <div id="dm-spend" class="dm-muted"></div>
      <label class="checkbox_label"><input id="dm-caching" type="checkbox" ${s.cachingEnabled ? 'checked' : ''}> I turned on Claude prompt caching in config.yaml (<code>enableSystemPromptCache: true</code> and <code>cachingAtDepth: 2</code> under <code>claude:</code>)</label>
      <label>Cache lifetime
        <select id="dm-cache-ttl" class="text_pole">
          <option value="5" ${Number(s.cacheTtlMinutes) < 60 ? 'selected' : ''}>5 minutes (default)</option>
          <option value="60" ${Number(s.cacheTtlMinutes) >= 60 ? 'selected' : ''}>1 hour (needs extendedTTL: true)</option>
        </select></label>
      <details><summary>Prices (USD per million tokens) &amp; estimate tuning</summary>
        <div id="dm-prices"></div>
        <div class="dm-grid2">
          <label>Thinking allowance (tokens/call)<input id="dm-think" type="number" step="50" class="text_pole" value="${s.thinkingAllowance}"></label>
        </div>
        <small>SillyTavern doesn't pass token usage back, so costs are estimates. Your Anthropic console shows real spend.</small>
      </details>

      <h4>Pacing</h4>
      <div class="dm-grid2">
        <label>Clock: minutes of story that pass each turn (the map's clock; a minute a round in fights, an hour or a night for rests)<input id="dm-minutes" type="number" min="1" max="120" class="text_pole" value="${s.minutesPerTurn ?? 10}"></label>
        <label>World pace: the world moves on its own every N turns (faster when people are actively doing things to you)<input id="dm-checkin" type="number" min="1" max="20" class="text_pole" value="${s.checkinEvery}"></label>
        <label>Usual session length (min)<input id="dm-session" type="number" min="15" max="600" class="text_pole" value="${s.usualSessionMinutes}"></label>
        <label>Chat messages sent to the DM<input id="dm-recent" type="number" min="6" max="80" class="text_pole" value="${s.recentMessages}"></label>
        <label>Max tokens the bot's note may add to a local prompt (never more than a sixth of your free context; the brief is always kept whole)<input id="dm-inject" type="number" min="100" max="2000" class="text_pole" value="${s.injectionMaxTokens}"></label>
      </div>

      <h4>What the bot is told</h4>
      <small>This works like a small system prompt for your roleplay model in D&amp;D chats. Your own system prompt, formatting and samplers are always used as they are; this is added on top.</small>
      <label class="checkbox_label"><input id="dm-hide-narration" type="checkbox" ${s.hideNarration ? 'checked' : ''}> Hide the DM's narration from the bot (it only gets the DM's private briefs)</label>
      <label>How the note is added
        <select id="dm-note-mode" class="text_pole">
          <option value="message" ${s.noteMode !== 'separate' ? 'selected' : ''}>Inside your latest message (recommended: keeps your format's turns as they are, so thinking models aren't disturbed)</option>
          <option value="separate" ${s.noteMode === 'separate' ? 'selected' : ''}>As its own message (older behavior)</option>
        </select></label>
      <div id="dm-note-separate" class="dm-grid2 ${s.noteMode === 'separate' ? '' : 'dm-hidden'}">
        <label>Note position (0 = right before the reply)<input id="dm-note-depth" type="number" min="0" max="10" class="text_pole" value="${s.noteDepth}"></label>
        <label>Note sent as
          <select id="dm-note-role" class="text_pole">
            <option value="system" ${s.noteRole !== 'user' ? 'selected' : ''}>System message</option>
            <option value="user" ${s.noteRole === 'user' ? 'selected' : ''}>User message</option>
          </select></label>
      </div>
      ${templateEditor('scene', 'Scene note (every reply in a D&D chat)', 'Fill-ins: {{player}} {{party}} {{location}} {{present}} {{situation}} {{goal}} and SillyTavern macros like {{char}}. A line whose fill-in is empty is left out.')}
      ${templateEditor('brief', 'DM brief (only when Claude handles the turn)', 'Fill-ins: {{brief}} (what Claude says the character needs to know) and {{length}}.')}
      ${templateEditor('state', 'What is true right now (scene card, people, timeline, table rules)', 'Fill-ins: {{scenecard}} (place, where everyone is and their hands/restraints, objects), {{people}} (people met, with roles), {{timeline}} (earlier events with when they happened; companions only), {{rules}} (table rules). Kept up to date by the DM.')}
      ${templateEditor('happened', 'Just happened (what the last DM turn changed)', 'Fill-in: {{happened}}. Stops companions from redoing actions the DM already resolved.')}
      ${templateEditor('knowledge', 'What each companion knows (written by the DM at the start, updated now and then)', 'Fill-in: {{knowledge}}. Added to that companion\'s note on every reply.')}
      ${templateEditor('avoid', 'Repeated phrases (when a character keeps reusing the same words)', 'Fill-in: {{avoid}}. Found automatically in that character\'s last 8 replies.')}
      ${templateEditor('room', 'The room on the map (when inside a built place)', 'Fill-ins: {{room}} (its name and description), {{things}} (what is in it), {{exits}} (doors, stairs, windows). So companions talk about what is really there.')}
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
    bindModelPicker('dm-model', v => {
        const st = settings();
        // Jobs that used the old main model follow it to the new one.
        for (const t of TASKS) if (st.taskModels[t.key] === st.dmModel) st.taskModels[t.key] = v;
        if (st.criticalModel === st.dmModel) st.criticalModel = v;
        st.dmModel = v;
        saveSettings();
        renderTaskModels();
        renderPrices();
    });
    bindCheck('dm-hybrid', 'hybridModels', () => {
        $('#dm-task-models').toggleClass('dm-hidden', !settings().hybridModels);
        renderPrices();
    });
    bindCheck('dm-hand-up', 'handUp');
    renderTaskModels();
    $('#dm-task-models').on('change', '[data-task-model]', function () {
        settings().taskModels[String($(this).attr('data-task-model'))] = String($(this).val());
        saveSettings();
        renderPrices();
    });
    $('#dm-task-models').on('change', '#dm-critical-model', function () {
        settings().criticalModel = String($(this).val());
        saveSettings();
        renderPrices();
    });
    $('#dm-task-models-reset').on('click', () => {
        const st = settings();
        st.taskModels = defaultTaskModels(st.dmModel);
        st.criticalModel = '';
        st.handUp = true;
        $('#dm-hand-up').prop('checked', true);
        saveSettings();
        renderTaskModels();
        renderPrices();
    });
    renderPrices();
    $('#dm-prices').on('change', '[data-price-model]', function () {
        const s = settings();
        const model = String($(this).attr('data-price-model'));
        const v = Number($(this).val());
        if (!Number.isFinite(v)) return;
        s.modelPrices[model] ??= { input: s.priceInput, output: s.priceOutput, cacheRead: s.priceCacheRead };
        s.modelPrices[model][String($(this).attr('data-price-key'))] = v;
        saveSettings();
    });
    $('#dm-cache-ttl').on('change', function () {
        settings().cacheTtlMinutes = Number($(this).val()) || 5;
        saveSettings();
    });
    bindSelect('dm-effort', 'dmEffort');
    bindSelect('dm-map-tier', 'mapTier');
    bindSelect('dm-actor-profile', 'actorProfileId');
    bindSelect('dm-helper-profile', 'helperProfileId');
    bindCheck('dm-use-helper', 'useHelper');
    bindCheck('dm-bookkeeper', 'bookkeeper');
    bindSelect('dm-map-sync', 'mapSync');
    bindSelect('dm-map-builder', 'mapBuilder');
    bindSelect('dm-map-brief', 'mapBrief');
    bindCheck('dm-auto-dice', 'autoReadDice');
    bindCheck('dm-map-figures', 'mapFigures');
    bindCheck('dm-map-ambience', 'mapAmbience');
    bindCheck('dm-map-bubbles', 'mapBubbles');
    bindCheck('dm-turn-prompts', 'turnPrompts');
    bindCheck('dm-guards-talk', 'guardsTalk');
    bindNumber('dm-monthly', 'monthlyCap');
    bindNumber('dm-nightly', 'nightlySoftCap');
    bindCheck('dm-caching', 'cachingEnabled');
    bindNumber('dm-think', 'thinkingAllowance');
    bindNumber('dm-checkin', 'checkinEvery');
    bindNumber('dm-minutes', 'minutesPerTurn');
    bindNumber('dm-session', 'usualSessionMinutes');
    bindNumber('dm-recent', 'recentMessages');
    bindNumber('dm-inject', 'injectionMaxTokens');
    bindCheck('dm-voices', 'voicesEnabled', async () => {
        const { syncTtsTakeover } = await import('../st/voices.js');
        syncTtsTakeover(Boolean(campaign() && !campaign().meta.paused));
    });
    bindCheck('dm-hide-narration', 'hideNarration');
    $('#dm-note-mode').on('change', function () {
        settings().noteMode = String($(this).val());
        $('#dm-note-separate').toggleClass('dm-hidden', settings().noteMode !== 'separate');
        saveSettings();
        refreshStandingPrompt();
    });
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
            `<h3>What ${escapeHtml(char)} gets in this chat</h3><p>Plain roleplay turns:</p><div class="dm-preview">${escapeHtml(base)}</div><p>When Claude handles the turn (example brief):</p><div class="dm-preview">${escapeHtml(withBrief)}</div><small>Position: ${settings().noteMode !== 'separate' ? 'added to the end of your latest message (or as a plain user turn when the latest message is someone elses)' : `${settings().noteDepth === 0 ? 'right before the reply' : `${settings().noteDepth} message(s) back`}, as a ${settings().noteRole === 'user' ? 'user' : 'system'} message`}. ${settings().hideNarration ? 'The DM\'s narration is hidden from the bot.' : 'The DM\'s narration is visible to the bot.'}</small>`,
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
