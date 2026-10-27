// The "Start D&D campaign" wizard: persona → party → story → options → build.

import { ST, personaName, personaDescription, sleep } from '../st/st.js';
import { callClaude } from '../st/llm.js';
import { newMeta, initCampaignFiles, META_KEY } from '../st/campaign.js';
import { createCharacterSheet, personaSheet, characterSheet, sheetMarkdown } from '../st/sheets.js';
import { BIBLE_INSTRUCTIONS, PITCH_INSTRUCTIONS, normalizeDmTurn } from '../core/protocol.js';
import { createWorldState, ensureParty } from '../core/world.js';
import { guessSetting } from '../core/deck.js';
import { extractJson, escapeHtml, shortId, trimToTokens } from '../core/text.js';
import { beginTurn } from './status.js';

const TONES = ['adventure', 'mystery', 'horror', 'political intrigue', 'survival', 'heist', 'war', 'romance-adjacent drama', 'dark fantasy', 'comedy'];

function wizardHtml() {
    const personas = Object.entries(ST.powerUser.personas || {});
    const current = ST.userAvatar;
    const personaOptions = personas.map(([avatar, name]) => {
        const sheet = personaSheet(avatar);
        return `<option value="${escapeHtml(avatar)}" ${avatar === current ? 'selected' : ''}>${escapeHtml(name)}${sheet ? ' 📜' : ''}</option>`;
    }).join('');
    const chars = ST.characters
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c?.name && !/^default_/.test(c.avatar || ''))
        .sort((a, b) => a.c.name.localeCompare(b.c.name));
    const charList = chars.map(({ c }) => {
        const sheet = characterSheet(c.avatar);
        return `<label class="dm-wiz-char" data-name="${escapeHtml(c.name.toLowerCase())}"><input type="checkbox" value="${escapeHtml(c.avatar)}"> <img src="/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}" alt=""> <span>${escapeHtml(c.name)}</span>${sheet ? ' <small title="Has a sheet">📜</small>' : ''}</label>`;
    }).join('');
    const toneOptions = TONES.map(t => `<option value="${t}">${t}</option>`).join('');
    return `
<div class="dm-wizard">
  <h3>🎲 Start a D&amp;D campaign</h3>
  <div class="dm-wiz-section">
    <h4>1. You</h4>
    <select id="dm-wiz-persona" class="text_pole">${personaOptions}</select>
    <small>📜 = character sheet on file (upload one from the Persona panel).</small>
  </div>
  <div class="dm-wiz-section">
    <h4>2. Your party</h4>
    <input id="dm-wiz-search" class="text_pole" placeholder="Search characters…">
    <div id="dm-wiz-chars" class="dm-wiz-chars">${charList}</div>
    <small>Characters without 📜 get a best-guess sheet from Claude (one short call each, first time only).</small>
  </div>
  <div class="dm-wiz-section">
    <h4>3. The story</h4>
    <label><input type="radio" name="dm-wiz-mode" value="own" checked> I have an idea</label>
    <label><input type="radio" name="dm-wiz-mode" value="pitch"> Surprise me</label>
    <textarea id="dm-wiz-premise" class="text_pole" rows="4" placeholder="Your plot idea, as rough as you like."></textarea>
    <div id="dm-wiz-pitchbox" class="dm-hidden">
      <div class="dm-wiz-row">
        <select id="dm-wiz-tone" class="text_pole">${toneOptions}</select>
        <label>Intensity <input id="dm-wiz-intensity" type="range" min="1" max="5" value="4"> <span id="dm-wiz-intensity-val">4</span>/5</label>
        <div id="dm-wiz-pitch" class="menu_button">Pitch me 3 ideas</div>
      </div>
      <div id="dm-wiz-pitches" class="dm-wiz-pitches"></div>
    </div>
  </div>
  <div class="dm-wiz-section">
    <h4>4. Options</h4>
    <div class="dm-wiz-grid">
      <label>Campaign feel
        <select id="dm-wiz-length" class="text_pole">
          <option value="short">Short arc</option>
          <option value="long">Long campaign</option>
          <option value="breathe" selected>Let it breathe</option>
        </select></label>
      <label>Combat
        <select id="dm-wiz-combat" class="text_pole">
          <option value="rare">Rare</option>
          <option value="normal" selected>Normal</option>
          <option value="frequent">Frequent</option>
        </select></label>
      <label>Rules
        <select id="dm-wiz-strict" class="text_pole">
          <option value="loose" selected>Loose (rule of cool)</option>
          <option value="standard">Standard 5e</option>
        </select></label>
      <label>Random events
        <select id="dm-wiz-events" class="text_pole">
          <option value="off">Off</option>
          <option value="rare">Rare</option>
          <option value="normal" selected>Normal</option>
          <option value="frequent">Frequent</option>
        </select></label>
    </div>
  </div>
</div>`;
}

function wire(root, state) {
    const $root = $(root);
    $root.find('#dm-wiz-search').on('input', function () {
        const q = String($(this).val()).toLowerCase();
        $root.find('.dm-wiz-char').each(function () {
            $(this).toggle(!q || String($(this).data('name')).includes(q));
        });
    });
    $root.find('input[name="dm-wiz-mode"]').on('change', function () {
        const pitch = $(this).val() === 'pitch';
        state.mode = pitch ? 'pitch' : 'own';
        $root.find('#dm-wiz-pitchbox').toggleClass('dm-hidden', !pitch);
        $root.find('#dm-wiz-premise').attr('placeholder', pitch ? 'Optional: anything you want included (a place, a theme, a villain…).' : 'Your plot idea, as rough as you like.');
    });
    $root.find('#dm-wiz-intensity').on('input', function () {
        $root.find('#dm-wiz-intensity-val').text(String($(this).val()));
    });
    $root.find('#dm-wiz-pitch').on('click', async function () {
        const btn = $(this);
        if (btn.hasClass('disabled')) return;
        btn.addClass('disabled').text('Thinking…');
        try {
            const tone = $root.find('#dm-wiz-tone').val();
            const intensity = $root.find('#dm-wiz-intensity').val();
            const party = $root.find('#dm-wiz-chars input:checked').map((_, el) => ST.characters.find(c => c.avatar === el.value)?.name).get();
            const user = `Tone: ${tone}. Intensity: ${intensity}/5 (5 = very intense, high stakes, dark themes allowed).\nParty: ${party.join(', ') || 'unspecified'} plus the player.\nPlayer's wishes: ${$root.find('#dm-wiz-premise').val() || 'none'}\nAlready pitched (don't repeat): ${state.pitches.map(p => p.title).join('; ') || 'none'}`;
            const reply = await callClaude({ system: PITCH_INSTRUCTIONS, user, task: 'pitches', label: 'pitches', maxTokens: 3000, effort: 'low' });
            const json = extractJson(reply.text);
            const pitches = Array.isArray(json?.pitches) ? json.pitches : [];
            state.pitches.push(...pitches);
            const box = $root.find('#dm-wiz-pitches').empty();
            state.pitches.slice(-3).forEach((p, i) => {
                const id = `dm-pitch-${state.pitches.length}-${i}`;
                box.append(`<label class="dm-wiz-pitch" for="${id}"><input type="radio" name="dm-wiz-pitch-choice" id="${id}" value="${escapeHtml(p.title)}"> <b>${escapeHtml(p.title)}</b><br><span>${escapeHtml(p.hook)}</span></label>`);
            });
            box.append(`<small>Estimated cost: ${reply.usd.toFixed(4)} USD. Click "Pitch me 3 ideas" again for more.</small>`);
            btn.text('Pitch 3 more');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Dungeon Master');
            btn.text('Pitch me 3 ideas');
        } finally {
            btn.removeClass('disabled');
        }
    });
}

function readForm(root, state) {
    const $root = $(root);
    const personaAvatar = String($root.find('#dm-wiz-persona').val() || ST.userAvatar);
    const party = $root.find('#dm-wiz-chars input:checked').map((_, el) => el.value).get();
    const chosenPitchTitle = $root.find('input[name="dm-wiz-pitch-choice"]:checked').val();
    const pitch = state.pitches.find(p => p.title === chosenPitchTitle) ?? null;
    return {
        personaAvatar,
        party,
        mode: state.mode,
        premise: String($root.find('#dm-wiz-premise').val() || '').trim(),
        pitch,
        tone: String($root.find('#dm-wiz-tone').val() || ''),
        intensity: Number($root.find('#dm-wiz-intensity').val() || 3),
        length: String($root.find('#dm-wiz-length').val()),
        combat: String($root.find('#dm-wiz-combat').val()),
        strictness: String($root.find('#dm-wiz-strict').val()),
        eventFrequency: String($root.find('#dm-wiz-events').val()),
    };
}

/** Open the wizard; builds and opens the campaign chat if confirmed. */
export async function openWizard() {
    const state = { mode: 'own', pitches: [] };
    let form = null;
    const popup = new ST.Popup(wizardHtml(), ST.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Build campaign',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClosing: (p) => {
            if (p.result !== ST.POPUP_RESULT.AFFIRMATIVE) return true;
            form = readForm(p.dlg, state);
            if (!form.party.length) {
                toastr.warning('Pick at least one party member.', 'Dungeon Master');
                return false;
            }
            if (form.mode === 'own' && !form.premise) {
                toastr.warning('Write a plot idea, or choose "Surprise me".', 'Dungeon Master');
                return false;
            }
            if (form.mode === 'pitch' && !form.pitch && !form.premise) {
                toastr.warning('Pick one of the pitches (or write your own idea).', 'Dungeon Master');
                return false;
            }
            return true;
        },
    });
    const shown = popup.show();
    wire(popup.dlg, state);
    const result = await shown;
    if (result !== ST.POPUP_RESULT.AFFIRMATIVE || !form) return;
    await buildCampaign(form);
}

async function buildCampaign(form) {
    const status = beginTurn('Building your campaign');
    try {
        const persona = { avatar: form.personaAvatar, name: personaName(form.personaAvatar), description: personaDescription(form.personaAvatar) };
        const partyChars = form.party.map(av => ST.characters.find(c => c.avatar === av)).filter(Boolean);

        // Sheets for party members (first time only).
        for (const ch of partyChars) {
            if (characterSheet(ch.avatar)) continue;
            const step = status.step(`Writing a character sheet for ${ch.name}`);
            try {
                const rec = await createCharacterSheet(ch.avatar);
                step.done('', rec.usd);
            } catch (error) {
                step.fail(error);
            }
        }

        // The bible, plot and opening.
        const step = status.step('Claude is designing the campaign');
        const pSheet = personaSheet(persona.avatar);
        const partyBits = [];
        for (const ch of partyChars) {
            const sheet = characterSheet(ch.avatar);
            partyBits.push(`## ${ch.name}\n${trimToTokens(ST.substituteParams(ch.description || ''), 700)}${sheet ? `\nSheet:\n${trimToTokens(await sheetMarkdown(sheet), 600)}` : ''}`);
        }
        const user = [
            '# PLAYER CHARACTER',
            `Name: ${persona.name}`,
            trimToTokens(persona.description, 600),
            pSheet ? `Sheet:\n${trimToTokens(await sheetMarkdown(pSheet), 1200)}` : '(no sheet uploaded)',
            '',
            '# PARTY MEMBERS (companions played by a local model)',
            partyBits.join('\n\n'),
            '',
            '# WHAT THE PLAYER WANTS',
            form.pitch ? `Chosen pitch: ${form.pitch.title}: ${form.pitch.hook}` : '',
            form.premise ? `Player's idea / wishes: ${form.premise}` : '',
            form.mode === 'pitch' ? `Tone: ${form.tone}. Intensity ${form.intensity}/5.` : '',
            `Campaign feel: ${form.length === 'short' ? 'a short arc (3 acts)' : form.length === 'long' ? 'a long campaign (5 acts)' : 'let it breathe: no rush, 4-5 acts with room for side content'}.`,
            `Combat frequency: ${form.combat}. Rules: ${form.strictness === 'loose' ? 'loose, rule of cool' : 'standard 5e'}.`,
            'The player usually plays 1-2 hours a night; a campaign may run for weeks. Plan accordingly.',
        ].filter(Boolean).join('\n');
        const reply = await callClaude({ system: BIBLE_INSTRUCTIONS, user, task: 'campaign_design', label: 'campaign design', maxTokens: 12000, effort: 'medium' });
        const json = extractJson(reply.text);
        if (!json?.bible || !json?.plot) throw new Error('Claude did not return a usable campaign. Try again.');
        step.done(json.title || '', reply.usd);

        // Create the group chat (manual replies: the extension decides who speaks).
        const groupStep = status.step('Creating the group chat');
        const id = shortId();
        const title = String(json.title || 'Untitled Campaign').slice(0, 80);
        const chatName = `DnD - ${title.replace(/[\\/:*?"<>|]/g, '')} - ${new Date().toISOString().slice(0, 10)} ${id}`;
        const meta = newMeta({
            id,
            title,
            persona,
            party: partyChars.map(c => ({ avatar: c.avatar, name: c.name, summary: trimToTokens(ST.substituteParams(c.description || ''), 250) })),
            options: { tone: form.tone, intensity: form.intensity, length: form.length, combat: form.combat, strictness: form.strictness, eventFrequency: form.eventFrequency, premise: form.premise, pitch: form.pitch },
        });
        meta.stats.usd = 0;
        const world = createWorldState();
        ensureParty(world, [
            { name: persona.name, hp_max: pSheet?.stats?.hp_max },
            ...partyChars.map(c => ({ name: c.name, hp_max: characterSheet(c.avatar)?.stats?.hp_max })),
        ]);
        if (json.scene) {
            world.location = String(json.scene.location || '');
            world.setting = guessSetting(world.location, json.scene.setting);
            world.time = String(json.scene.time || 'morning');
        }
        meta.standing = String(json.standing_direction || '');
        meta.objective = String(json.objective || '');
        if (json.knowledge && typeof json.knowledge === 'object') {
            for (const ch of partyChars) {
                const text = Object.entries(json.knowledge).find(([k]) => k.toLowerCase() === ch.name.toLowerCase())?.[1];
                if (text) meta.knowledge[ch.name] = String(text);
            }
        }
        meta.pacing.tension = Number(json.tension) || 2;
        if (json.scene?.type) meta.pacing.sceneType = json.scene.type;

        await initCampaignFiles(meta, {
            bible: String(json.bible),
            plot: String(json.plot),
            notes: '',
            story: '',
            world,
            npcs: [],
            events_log: [],
            rolls_log: [],
            costs: [{ at: new Date().toISOString(), label: 'campaign design', usd: reply.usd }],
        });

        const groupRes = await fetch('/api/groups/create', {
            method: 'POST',
            headers: ST.getRequestHeaders(),
            body: JSON.stringify({
                name: title,
                members: partyChars.map(c => c.avatar),
                avatar_url: 'img/ai4.png',
                allow_self_responses: false,
                hideMutedSprites: false,
                activation_strategy: 2, // Manual: the Dungeon Master decides who speaks.
                generation_mode: 0,
                disabled_members: [],
                fav: false,
                chat_id: chatName,
                chats: [chatName],
                auto_mode_delay: 5,
            }),
        });
        if (!groupRes.ok) throw new Error(`Could not create the group chat (${groupRes.status}).`);
        const group = await groupRes.json();

        // A chat-bound lorebook for MemoryBooks: its memories land here and the DM reads them.
        // (Without one, MemoryBooks stops the chat with a "Memory Lorebook Missing" popup.)
        const lorebook = `DnD Memories - ${title.replace(/[^\w\s-]/g, '').trim().slice(0, 50) || id}`;
        try {
            const ctx = ST.context();
            if (!ctx.getWorldInfoNames().includes(lorebook)) {
                await ctx.saveWorldInfo(lorebook, { entries: {} }, true);
                await ctx.updateWorldInfoList();
            }
        } catch (error) {
            console.warn('[Dungeon Master] Could not create the memory lorebook', error);
        }

        // Pre-create the chat file so SillyTavern doesn't post the characters' card greetings.
        const header = {
            chat_metadata: { tainted: true, integrity: ST.context().uuidv4(), persona: persona.avatar, [ST.WORLD_INFO_KEY]: lorebook, [META_KEY]: meta },
            user_name: 'unused',
            character_name: 'unused',
        };
        const saveRes = await fetch('/api/chats/group/save', {
            method: 'POST',
            headers: ST.getRequestHeaders(),
            body: JSON.stringify({ id: chatName, chat: [header] }),
        });
        if (!saveRes.ok) throw new Error('Could not create the chat file.');
        await ST.getCharacters();
        groupStep.done(title);

        const openStep = status.step('Opening the chat');
        await ST.openGroupById(group.id);
        await sleep(300);
        openStep.done();
        status.finish('Campaign ready');

        // Opening scene (the chat-changed handler has loaded the campaign by now).
        const opening = normalizeDmTurn({
            narration: json.opening,
            scene: { ...(json.scene || {}), changed: true },
            standing_direction: json.standing_direction,
            directions: json.directions,
            new_npcs: json.new_npcs,
            tension: json.tension,
            world_next: json.world_next,
        });
        const { runOpening } = await import('../st/orchestrator.js');
        const { loadForCurrentChat } = await import('../st/campaign.js');
        await loadForCurrentChat();
        await runOpening(opening);
    } catch (error) {
        console.error('[Dungeon Master] Build failed', error);
        status.finish('Campaign build failed');
        toastr.error(String(error?.message || error), 'Dungeon Master', { timeOut: 12000 });
    }
}

