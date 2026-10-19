// Extension settings (stored in SillyTavern's settings.json under extension_settings.dungeon_master).

import { ST, MODULE } from './st.js';
import { monthKey, nightKey } from '../core/budget.js';

export const DEFAULTS = Object.freeze({
    enabled: true,

    // Connections (Connection Manager profile ids; '' = default behavior)
    dmProfileId: '',            // '' = first Claude profile, else SillyTavern's saved Claude key
    dmModel: 'claude-sonnet-5-5',
    dmEffort: 'low',            // Claude thinking effort: low | medium | high
    dmMaxTokens: 6000,
    actorProfileId: '',         // '' = whatever connection is currently selected
    helperProfileId: '',        // '' = same as actors (current connection)
    helperMaxTokens: 160,
    useHelper: true,

    // Budget (USD) and Claude prices (USD per million tokens)
    monthlyCap: 20,
    nightlySoftCap: 0.65,
    priceInput: 2,
    priceOutput: 10,
    priceCacheRead: 0.2,
    priceCacheWrite: 2.5,
    thinkingAllowance: 500,
    cachingEnabled: false,      // set true after enabling claude.enableSystemPromptCache in config.yaml

    // Pacing
    checkinEvery: 10,
    usualSessionMinutes: 90,
    eventBase: 0.04,
    eventGrowth: 0.025,
    eventCap: 0.45,
    recentMessages: 24,         // transcript messages sent to the DM
    injectionMaxTokens: 450,    // budget for directions added to the local model's prompt

    // Voices (Chatterbox)
    voicesEnabled: true,
    dmVoice: '',
    npcVoicePool: {},           // voiceId -> {enabled:boolean, gender:'male'|'female'|'any', label:string}
    voiceSpeed: 1,

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
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
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
