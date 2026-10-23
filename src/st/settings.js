// Extension settings (stored in SillyTavern's settings.json under extension_settings.dungeon_master).

import { ST, MODULE } from './st.js';
import { monthKey, nightKey } from '../core/budget.js';
import { DEFAULT_TEMPLATES, DEFAULT_LENGTHS, OLD_DEFAULTS } from '../core/notes.js';
import { DEFAULT_MAIN_MODEL, TASKS, defaultTaskModels, migrateModelSettings, pickModel } from '../core/models.js';

/** Surprise types Claude may add, each with its own toggle. */
export const SURPRISES = Object.freeze({
    traps: 'Traps (tripwires, pressure plates, snares)',
    hazards: 'Environmental hazards (collapsing floors, fire, flooding, bad weather)',
    puzzles: 'Puzzles and locks (riddles, mechanisms, locked doors)',
    secretDoors: 'Secret doors and hidden passages',
    treasure: 'Hidden treasure and stashes',
    ambushes: 'Ambushes',
});

export const DEFAULTS = Object.freeze({
    enabled: true,

    // Connections (Connection Manager profile ids; '' = default behavior)
    dmProfileId: '',            // '' = first Claude profile, else SillyTavern's saved Claude key
    dmModel: DEFAULT_MAIN_MODEL, // main DM model: does everything when hybrid is off, and takes handed-up turns
    hybridModels: true,         // true = each job uses its own model (taskModels); false = dmModel for everything
    taskModels: defaultTaskModels(), // job -> model id (see core/models.js TASKS)
    criticalModel: '',          // model for turns with your natural 1 or 20 ('' = no change)
    handUp: true,               // cheaper models may hand a big story moment up to the main model
    dmEffort: 'low',            // Claude thinking effort: low | medium | high
    dmMaxTokens: 6000,
    actorProfileId: '',         // '' = whatever connection is currently selected
    helperProfileId: '',        // '' = same as actors (current connection)
    helperMaxTokens: 160,
    useHelper: true,

    // Budget (USD) and Claude prices (USD per million tokens)
    monthlyCap: 20,
    nightlySoftCap: 0.65,
    modelPrices: {
        'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
        'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
    },
    priceInput: 2,              // fallback prices for models not in modelPrices
    priceOutput: 10,
    priceCacheRead: 0.2,
    thinkingAllowance: 500,
    cachingEnabled: false,      // set true after turning on caching in config.yaml (see README)
    cacheTtlMinutes: 5,         // 5, or 60 with claude.extendedTTL: true

    // Pacing
    checkinEvery: 5,            // the world's normal pace: it acts on its own every N player turns (the DM goes faster when people are actively doing things)
    usualSessionMinutes: 90,
    eventBase: 0.04,
    eventGrowth: 0.025,
    eventCap: 0.45,
    recentMessages: 24,         // transcript messages sent to the DM

    // What the roleplay model is told (editable, each with "reset to default")
    templates: { ...DEFAULT_TEMPLATES },
    lengths: { ...DEFAULT_LENGTHS },
    noteMode: 'message',        // 'message' = inside the player's turn (no extra turns); 'separate' = its own message (noteDepth/noteRole)
    noteDepth: 0,               // 'separate' mode: 0 = right before the reply; higher = further back in the chat
    noteRole: 'system',         // 'system' | 'user': how the note is formatted in your instruct template
    hideNarration: true,        // the bot never sees "Dungeon Master" messages; it gets briefs instead
    autoReadDice: true,         // read SillyTavern's dice rolls for a pending roll (no need to type the number)

    // Surprises Claude may add
    surprises: { traps: true, hazards: true, puzzles: true, secretDoors: true, treasure: true, ambushes: true },
    surpriseFrequency: 'occasional', // rare | occasional | often

    // Voices (Chatterbox). In campaign chats the plugin voices everyone and SillyTavern's TTS is paused.
    voicesEnabled: true,
    dmVoice: '',
    npcVoicePool: {},           // voiceId -> {enabled:boolean, gender:'male'|'female'|'any', label:string}
    voiceSpeed: 1,
    ttsPausedByPlugin: false,   // true while the plugin has SillyTavern's TTS switched off

    // UI
    showStatus: true,
    statusAutoCollapse: true,

    // Sheets (locked once created)
    personaSheets: {},          // personaAvatar -> {file, name, created, stats}
    characterSheets: {},        // characterAvatar -> {file, name, created, stats}

    // Spending (estimates)
    spend: {},                  // 'YYYY-MM' -> usd
    nightSpend: { key: '', usd: 0 },
});

export function settings() {
    const all = ST.extensionSettings;
    if (!all[MODULE]) all[MODULE] = {};
    const s = all[MODULE];
    // Saved defaults from older versions (10 let scenes freeze; 3 was v0.5.2's) move to the current 5.
    if (!s.worldPaceV5) {
        if (s.checkinEvery === 10 || s.checkinEvery === 3) s.checkinEvery = 5;
        s.worldPaceV5 = true;
        delete s.worldPaceMigrated;
    }
    // v0.7: untouched old defaults move to the new ones (short NPC lines, shorter "long",
    // judgment-heavy everyday turns on the main model).
    if (!s.defaultsV7) {
        if (typeof s.templates?.npc === 'string' && s.templates.npc.endsWith(OLD_DEFAULTS.npcLast)) s.templates.npc = DEFAULT_TEMPLATES.npc;
        if (s.lengths?.long === OLD_DEFAULTS.long) s.lengths.long = DEFAULT_LENGTHS.long;
        if (s.taskModels) {
            const main = s.dmModel || DEFAULT_MAIN_MODEL;
            for (const k of ['risky_action', 'roll_result', 'scene_move', 'event']) if (s.taskModels[k] === 'claude-haiku-5-5') s.taskModels[k] = main;
        }
        s.defaultsV7 = true;
    }
    // Per-job models (v0.4.2): start from the saved main model, or carry over v0.4.x choices.
    if (s.taskModels === undefined && migrateModelSettings(s)) ST.saveSettingsDebounced();
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    // Nested defaults added in later versions.
    for (const [k, v] of Object.entries(DEFAULT_TEMPLATES)) if (typeof s.templates[k] !== 'string') s.templates[k] = v;
    for (const [k, v] of Object.entries(DEFAULT_LENGTHS)) if (typeof s.lengths[k] !== 'string') s.lengths[k] = v;
    for (const k of Object.keys(SURPRISES)) if (typeof s.surprises[k] !== 'boolean') s.surprises[k] = true;
    const recommended = defaultTaskModels(s.dmModel || DEFAULT_MAIN_MODEL);
    for (const t of TASKS) if (typeof s.taskModels[t.key] !== 'string' || !s.taskModels[t.key]) s.taskModels[t.key] = recommended[t.key];
    for (const [k, v] of Object.entries(DEFAULTS.modelPrices)) if (!s.modelPrices[k]) s.modelPrices[k] = { ...v };
    return s;
}

/** Prices (USD per million tokens) for a model: its own row, or the fallback prices. */
export function pricesFor(model) {
    const s = settings();
    const row = s.modelPrices?.[model];
    if (row) return { input: Number(row.input) || 0, output: Number(row.output) || 0, cacheRead: Number(row.cacheRead) || 0 };
    return { input: Number(s.priceInput) || 0, output: Number(s.priceOutput) || 0, cacheRead: Number(s.priceCacheRead) || 0 };
}

/**
 * The Claude model for a call covering these jobs (DM call reasons or other TASKS keys).
 * When jobs disagree, the model with the higher input price is taken as the more capable one.
 */
export function modelFor(tasks, { criticalRoll = false } = {}) {
    const s = settings();
    const mainModel = s.dmModel || DEFAULT_MAIN_MODEL;
    return pickModel([].concat(tasks), {
        hybrid: s.hybridModels !== false,
        mainModel,
        taskModels: s.taskModels,
        criticalModel: s.criticalModel,
        criticalRoll,
        rank: m => pricesFor(m).input,
    });
}

export function saveSettings() {
    ST.saveSettingsDebounced();
}

export function recordSpend(usd) {
    const s = settings();
    const m = monthKey();
    s.spend[m] = Math.round(((s.spend[m] || 0) + usd) * 1e6) / 1e6;
    const n = nightKey();
    if (s.nightSpend.key !== n) s.nightSpend = { key: n, usd: 0 };
    s.nightSpend.usd = Math.round((s.nightSpend.usd + usd) * 1e6) / 1e6;
    saveSettings();
}

export function currentSpend() {
    const s = settings();
    const n = nightKey();
    return {
        monthUsd: s.spend[monthKey()] || 0,
        nightUsd: s.nightSpend.key === n ? s.nightSpend.usd : 0,
    };
}

/** All saved Connection Manager profiles. */
export function connectionProfiles() {
    return ST.extensionSettings.connectionManager?.profiles ?? [];
}

export function profileById(id) {
    if (!id) return null;
    return connectionProfiles().find(p => p.id === id) ?? null;
}

export function selectedProfileId() {
    return ST.extensionSettings.connectionManager?.selectedProfile ?? '';
}
