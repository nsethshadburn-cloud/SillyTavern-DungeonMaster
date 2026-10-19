// Voices, played through your Chatterbox server.
// In campaign chats the plugin voices EVERYONE (DM, NPCs and party members like Judy) through one
// queue, in chat order, one line at a time. SillyTavern's own TTS is switched off while a campaign
// chat is open (and switched back on when you leave), so two players can never talk over each other.
// Endpoint, voice settings and text rules come from SillyTavern's TTS panel.

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
        rules: tts,
    };
}

// ---------------- Taking over from SillyTavern's TTS ----------------

/**
 * Called whenever the open chat changes. In an active campaign chat (with plugin voices on),
 * switch SillyTavern's TTS off; anywhere else, switch it back on if the plugin switched it off.
 */
export function syncTtsTakeover(campaignActive) {
    const s = settings();
    const tts = ST.extensionSettings.tts;
    if (!tts) return;
    const want = Boolean(campaignActive && s.voicesEnabled && ttsConfig().isChatterbox);
    if (want && tts.enabled) {
        setSillyTavernTts(false);
        s.ttsPausedByPlugin = true;
        saveSettings();
    } else if (!want && s.ttsPausedByPlugin) {
        s.ttsPausedByPlugin = false;
        saveSettings();
        stopVoices();
        setSillyTavernTts(true);
    }
}

/**
 * Flip SillyTavern's TTS through its own switch, so it runs its own setup (and, when turning on,
 * reloads its voice list via its Refresh button). Falls back to the setting if the panel isn't there.
 */
function setSillyTavernTts(on) {
    const box = /** @type {HTMLInputElement|null} */ (document.getElementById('tts_enabled'));
    if (box) {
        if (box.checked !== on) $(box).trigger('click');
        if (on) setTimeout(() => $('#tts_refresh').trigger('click'), 50);
    } else {
        ST.extensionSettings.tts.enabled = on;
        ST.saveSettingsDebounced();
    }
}

/** Plugin voices are on when SillyTavern TTS is set up for Chatterbox (on, or paused by us). */
export function voicesActive() {
    const s = settings();
    const cfg = ttsConfig();
    return Boolean(s.voicesEnabled && cfg.isChatterbox && cfg.endpoint && (cfg.enabled || s.ttsPausedByPlugin));
}

// ---------------- Voice lists ----------------

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

/**
 * The voice SillyTavern's voice map gives a character (e.g. Judy). The map stores voice NAMES;
 * Chatterbox wants file ids. Returns '' when the character is disabled or unmapped.
 */
export async function voiceForCharacter(name) {
    const map = ttsConfig().voiceMap;
    let v = map[name];
    if (v === '[Default Voice]' || v === undefined) v = map['[Default Voice]'];
    if (!v || v === 'disabled' || v === '[Default Voice]') return '';
    const voices = await fetchVoices();
    const hit = voices.find(x => x.name === v || x.id === v);
    return hit ? hit.id : String(v);
}

// ---------------- Speaking ----------------

/** Clean text the same way SillyTavern's TTS does, following your TTS panel's options. */
export function speechText(text, { kind = 'party' } = {}) {
    const rules = ttsConfig().rules;
    let t = String(text ?? '').replace(/\(\(.*?\)\)/gs, '');
    if (rules.skip_codeblocks) t = t.replace(/```.*?```/gs, '').replace(/~~~.*?~~~/gs, '');
    if (rules.skip_tags) t = t.replace(/<.*?>[\s\S]*?<\/.*?>/g, '');
    if (kind !== 'dm') {
        if (!rules.pass_asterisks) {
            t = rules.narrate_dialogues_only ? t.replace(/\*[^*]*?(\*|$)/g, '') : t.replaceAll('*', '');
        }
        if (rules.narrate_quoted_only) {
            const quotes = t.match(/"[^"]*"|“[^”]*”/g);
            t = quotes ? quotes.join(' ... ') : '';
        }
    }
    return t.replace(/[*_~`#>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();
}

const queue = [];
let playing = false;
let currentAudio = null;
let generation = 0; // bumps on stop, so stale requests don't play

export function stopVoices() {
    generation++;
    queue.length = 0;
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    playing = false;
}

/**
 * Queue one line. kind: 'dm' (DM voice), 'npc' (voice given), 'party' (SillyTavern voice map).
 * Audio starts generating right away, but lines always PLAY in the order they were queued.
 */
export function voiceLine({ kind, name = '', text, voice = '' }) {
    if (!voicesActive()) return;
    const clean = speechText(text, { kind });
    if (!clean) return;
    const gen = generation;
    const item = { gen, audio: null };
    item.audio = (async () => {
        let id = voice;
        if (kind === 'dm') id = settings().dmVoice;
        else if (kind === 'party') id = await voiceForCharacter(name);
        if (!id) return null;
        return fetchAudio(clean, id);
    })().catch(error => {
        console.warn('[Dungeon Master] Voice failed', error);
        return null;
    });
    queue.push(item);
    if (!playing) playQueue();
}

async function playQueue() {
    playing = true;
    try {
        while (queue.length) {
            const item = queue.shift();
            const url = await item.audio;
            if (!url || item.gen !== generation) {
                if (url) URL.revokeObjectURL(url);
                continue;
            }
            await playUrl(url);
        }
    } finally {
        playing = false;
    }
}

async function fetchAudio(text, voiceId) {
    const cfg = ttsConfig();
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
    return URL.createObjectURL(await res.blob());
}

function playUrl(url) {
    return new Promise((resolve) => {
        const audio = new Audio(url);
        currentAudio = audio;
        audio.playbackRate = Number(ST.extensionSettings.tts?.playback_rate) || 1;
        const done = () => {
            if (currentAudio === audio) currentAudio = null;
            URL.revokeObjectURL(url);
            resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.onpause = () => { if (!audio.ended && currentAudio !== audio) done(); };
        audio.play().catch(done);
    });
}

/** Back-compat for older call sites: speak a DM line with a specific voice. */
export function speak(text, voiceId) {
    voiceLine({ kind: 'npc', text, voice: voiceId });
}
