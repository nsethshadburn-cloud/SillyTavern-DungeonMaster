// Campaign store. Small, frequently-changing state lives in the chat's metadata
// (so it travels with the chat). Bigger documents live in files the DM can request.

import { ST } from './st.js';
import { readFile, readJson, writeLater, writeFile, writeJson, flushWrites } from './storage.js';
import { createPacingState } from '../core/pacing.js';
import { createWorldState } from '../core/world.js';

export const META_KEY = 'dungeon_master';

/** Campaign file keys → [suffix, kind, default]. */
export const FILES = {
    bible: ['bible.md', 'text', ''],
    plot: ['plot.md', 'text', ''],
    notes: ['dm_notes.md', 'text', ''],
    story: ['story_so_far.md', 'text', ''],
    world: ['world_state.json', 'json', null],
    npcs: ['npcs.json', 'json', []],
    events_log: ['events_log.json', 'json', []],
    rolls_log: ['rolls_log.json', 'json', []],
    costs: ['costs.json', 'json', []],
};

export function fileName(campaignId, key) {
    return `dm_${campaignId}_${FILES[key][0]}`;
}

/** @type {any} */
let active = null;

export function campaign() {
    return active;
}

export function isActive() {
    return Boolean(active && !active.meta.paused);
}

/** The metadata blob stored in the chat. */
export function newMeta({ id, title, persona, party, options }) {
    return {
        version: 1,
        id,
        title,
        createdAt: new Date().toISOString(),
        persona,             // {avatar, name}
        party,               // [{avatar, name}]
        options,             // {tone, intensity, length, combat, strictness, eventFrequency, premise}
        paused: false,
        turn: 0,
        pacing: createPacingState(),
        pendingRoll: null,
        pendingEvent: null,
        eventHistory: {},    // eventId -> {lastTurn, count}
        recentEventTypes: [],
        lastDriftStageCalled: 0,
        standing: '',
        objective: '',       // party's immediate goal (set by the DM)
        knowledge: {},       // companion name -> what they know about the story (DM-written)
        timeline: [],        // recent "happened" lines with day, time and place
        tableRules: [],      // things the player settled out of character (always true)
        directions: {},      // speaker -> last direction from the DM
        session: { startedAt: Date.now(), lastActivity: Date.now() },
        stats: { dmCalls: 0, localTurns: 0, usd: 0 },
    };
}

/** Load the campaign for the chat that's open now (or clear it). */
export async function loadForCurrentChat() {
    const meta = ST.chatMetadata?.[META_KEY];
    if (!meta?.id) {
        active = null;
        return null;
    }
    // Fill in fields added by newer versions.
    const defaults = newMeta({ id: meta.id, title: meta.title, persona: meta.persona, party: meta.party, options: meta.options });
    for (const [k, v] of Object.entries(defaults)) {
        if (meta[k] === undefined) meta[k] = v;
    }
    for (const [k, v] of Object.entries(createPacingState())) {
        if (meta.pacing[k] === undefined) meta.pacing[k] = v;
    }
    const docs = {};
    for (const [key, [, kind, fallback]] of Object.entries(FILES)) {
        const name = fileName(meta.id, key);
        docs[key] = kind === 'json' ? await readJson(name, fallback ?? createWorldState()) : await readFile(name, fallback);
    }
    if (!docs.world || typeof docs.world !== 'object' || Array.isArray(docs.world)) docs.world = createWorldState();
    for (const [k, v] of Object.entries(createWorldState())) {
        if (docs.world[k] === undefined) docs.world[k] = v;
    }
    active = { meta, docs };
    return active;
}

/** Create files + metadata for a brand-new campaign (chat already exists or is about to). */
export async function initCampaignFiles(meta, docs) {
    for (const [key, [, kind]] of Object.entries(FILES)) {
        const name = fileName(meta.id, key);
        const value = docs[key] ?? (kind === 'json' ? (key === 'world' ? createWorldState() : []) : '');
        if (kind === 'json') await writeJson(name, value);
        else await writeFile(name, value);
    }
}

export function setActive(meta, docs) {
    active = { meta, docs };
}

export function saveMeta() {
    if (!active) return;
    active.meta.session.lastActivity = Date.now();
    ST.chatMetadata[META_KEY] = active.meta;
    ST.saveMetadataDebounced();
}

export function saveDoc(key) {
    if (!active) return;
    // Bound to this campaign's docs, so a save queued just before switching chats still lands.
    const docs = active.docs;
    writeLater(fileName(active.meta.id, key), () => docs[key]);
}

export async function saveAllNow() {
    if (!active) return;
    saveMeta();
    await flushWrites();
}

export function clearActive() {
    active = null;
}
