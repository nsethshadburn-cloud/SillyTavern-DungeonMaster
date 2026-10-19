// Voices for the DM and NPCs, played through your Chatterbox server.
// SillyTavern's TTS only voices real characters, so DM/NPC lines are spoken here,
// using the same Chatterbox endpoint and settings you configured in SillyTavern's TTS panel.

import { ST } from './st.js';
import { settings, saveSettings } from './settings.js';
import { random01 } from '../core/dice.js';

// Voices that should never be handed to a random NPC by default.
const NOT_GENERIC = /trump|shrek|scammer|jamaican|clone|thrax|from rio|morgan|freeman|teshin|judy|tulin|jewel/i;
const FEMALE = new Set(['abigail', 'alexa', 'alice', 'amber', 'cora', 'elena', 'emily', 'gianna', 'jade', 'layla', 'olivia', 'sophia', 'emma', 'ava', 'mia', 'grace', 'chloe', 'zoe', 'lily', 'ella', 'ruby', 'nora', 'hazel', 'aria', 'luna', 'stella', 'violet', 'claire', 'sarah', 'anna', 'maria', 'kate', 'lucy']);
const MALE = new Set(['adrian', 'alexander', 'austin', 'axel', 'connor', 'eli', 'everett', 'gabriel', 'henry', 'ian', 'jeremiah', 'julian', 'leonardo', 'max', 'michael', 'miles', 'ryan', 'thomas', 'robert', 'arnold', 'james', 'john', 'david', 'daniel', 'jack', 'liam', 'noah', 'oliver', 'lucas', 'ethan', 'mason', 'logan', 'owen', 'caleb', 'isaac', 'nathan', 'samuel', 'william', 'benjamin', 'jacob', 'luke', 'mark', 'paul', 'peter', 'george', 'edward', 'victor', 'marcus', 'oscar']);

let voiceCache = null;

export function ttsConfig() {
    const tts = ST.extensionSettings.tts ?? {};
    const provider = tts.currentProvider;
    const cfg = tts[provider] ?? {};
    return {
        enabled: Boolean(tts.enabled),
        provider,
        isChatterbox: provider === 'Chatterbox',
        endpoint: String(cfg.provider_endpoint || '').replace(/\/+$/, ''),
        settings: cfg,
        voiceMap: (typeof cfg.voiceMap === 'object' && cfg.voiceMap) ? cfg.voiceMap : {},
    };
}

/** Voices offered by the Chatterbox server: [{id, name, kind}] */
export async function fetchVoices(force = false) {
    if (voiceCache && !force) return voiceCache;
    const cfg = ttsConfig();
    if (!cfg.isChatterbox || !cfg.endpoint) return [];
    const voices = [];
    try {
        const res = await fetch(`${cfg.endpoint}/get_predefined_voices`);
        if (res.ok) {
            const data = await res.json();
            for (const v of data) voices.push({ id: v.voice_id || v.filename, name: v.display_name || v.filename, kind: 'predefined' });
        }
    } catch (error) {
        console.warn('[Dungeon Master] Could not load Chatterbox voices', error);
    }
    try {
        const res = await fetch(`${cfg.endpoint}/get_reference_files`);
        if (res.ok) {
            const data = await res.json();
            for (const f of data) voices.push({ id: `ref_${f}`, name: `[Clone] ${f}`, kind: 'clone' });
        }
    } catch { /* optional */ }
    voiceCache = voices;
    return voices;
}

export function guessGender(name) {
    const first = String(name).toLowerCase().replace(/\.(wav|mp3|flac|ogg)$/, '').split(/[\s_-]+/)[0];
    if (FEMALE.has(first)) return 'female';
    if (MALE.has(first)) return 'male';
    return 'any';
}

/** Voice ids already used by your characters in SillyTavern's voice map. */
function voicesUsedByCharacters() {
    const used = new Set();
    for (const [char, voice] of Object.entries(ttsConfig().voiceMap)) {
        if (!voice || voice === 'disabled' || voice === '[Default Voice]') continue;
        if (char === '[Default Voice]') continue;
        used.add(String(voice).toLowerCase());
    }
    return used;
}

/**
 * Make sure every server voice has a pool entry. New voices default to enabled
 * only if they look like a plain first name and aren't used by a character.
 */
export async function syncVoicePool() {
    const s = settings();
    const voices = await fetchVoices();
    const used = voicesUsedByCharacters();
    let changed = false;
    for (const v of voices) {
        if (s.npcVoicePool[v.id]) continue;
        const plainName = v.kind === 'predefined' && /^[A-Za-z]+$/.test(v.name);
        const isUsed = used.has(v.name.toLowerCase()) || used.has(v.id.toLowerCase());
        s.npcVoicePool[v.id] = {
            enabled: plainName && !NOT_GENERIC.test(v.name) && !isUsed,
            gender: guessGender(v.name),
            label: v.name,
        };
        changed = true;
    }
    if (changed) saveSettings();
    return s.npcVoicePool;
}

/**
 * Pick a voice for a new NPC: matching gender if possible, avoiding voices other NPCs already have.
 * @param {{gender:string}} npc
 * @param {Array<{voice:string}>} roster
 */
export function pickNpcVoice(npc, roster = []) {
    const pool = Object.entries(settings().npcVoicePool).filter(([, v]) => v.enabled);
    if (!pool.length) return '';
    const taken = new Set(roster.map(n => n.voice).filter(Boolean));
    const want = npc.gender === 'male' || npc.gender === 'female' ? npc.gender : null;
    const tiers = [
        pool.filter(([id, v]) => !taken.has(id) && (!want || v.gender === want)),
        pool.filter(([id, v]) => !taken.has(id) && (!want || v.gender === want || v.gender === 'any')),
        pool.filter(([, v]) => !want || v.gender === want || v.gender === 'any'),
        pool,
    ];
    const options = tiers.find(t => t.length) ?? pool;
    return options[Math.floor(random01() * options.length)][0];
}

// ---------------- Playback ----------------

let chain = Promise.resolve();
let currentAudio = null;

export function stopVoices() {
    chain = Promise.resolve();
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
}

/** Clean text for speech: drop markdown, OOC bits and dice notation. */
export function speechText(text) {
    return String(text ?? '')
        .replace(/\(\(.*?\)\)/gs, '')
        .replace(/[*_~`#>]/g, '')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Queue a line to be spoken. voiceId: Chatterbox file name or 'ref_<file>'. */
export function speak(text, voiceId) {
    const s = settings();
    const cfg = ttsConfig();
    if (!s.voicesEnabled || !cfg.enabled || !cfg.isChatterbox || !cfg.endpoint || !voiceId) return Promise.resolve();
    const clean = speechText(text);
    if (!clean) return Promise.resolve();
    const run = chain.then(() => playOne(cfg, clean, voiceId));
    chain = run.catch(() => { });
    return run;
}

async function playOne(cfg, text, voiceId) {
    const c = cfg.settings;
    const isRef = voiceId.startsWith('ref_');
    const body = {
        text,
        voice_mode: isRef ? 'clone' : 'predefined',
        temperature: c.temperature,
        exaggeration: c.exaggeration,
        cfg_weight: c.cfg_weight,
        seed: c.seed >= 0 ? c.seed : Math.floor(Math.random() * 2147483648),
        speed_factor: c.speed_factor,
        language: c.language,
        split_text: c.split_text,
        chunk_size: c.chunk_size,
        output_format: c.output_format || 'wav',
    };
    if (isRef) body.reference_audio_filename = voiceId.slice(4);
    else body.predefined_voice_id = voiceId;

    const res = await fetch(`${cfg.endpoint}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Chatterbox ${res.status}`);
    const blob = await res.blob();
    await waitForSillyTavernAudio();
    const url = URL.createObjectURL(blob);
    try {
        await new Promise((resolve) => {
            const audio = new Audio(url);
            currentAudio = audio;
            const rate = Number(ST.extensionSettings.tts?.playback_rate) || 1;
            audio.playbackRate = rate;
            audio.onended = resolve;
            audio.onerror = resolve;
            audio.play().catch(resolve);
        });
    } finally {
        currentAudio = null;
        URL.revokeObjectURL(url);
    }
}

/** Don't talk over SillyTavern's own TTS (party members' voices). */
async function waitForSillyTavernAudio(maxMs = 60000) {
    const el = document.getElementById('tts_audio');
    if (!el) return;
    const start = Date.now();
    while (!el.paused && !el.ended && Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 200));
    }
}
