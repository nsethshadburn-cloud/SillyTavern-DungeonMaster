// Actors: party members speak through SillyTavern's normal group generation (your selected
// prompts, formats and samplers). The plugin adds ONE note per reply, built from editable
// templates (Settings → "What the bot is told"), and hides the DM's narration from the bot:
// the bot only learns what the DM's private brief tells it.
// NPCs are voiced by the same local model with a prompt built from your system prompt + the NPC template.

import { ST, waitUntilIdle, findCharacterIndex, currentGroup } from './st.js';
import { settings, profileById, selectedProfileId } from './settings.js';
import { callLocal, cleanLocalOutput } from './llm.js';
import { campaign, saveDoc } from './campaign.js';
import { postNpc, dmType } from './messages.js';
import { pickNpcVoice, voiceLine } from './voices.js';
import { addNpcs } from '../core/world.js';
import { renderTemplate, lengthText, pronounsFor } from '../core/notes.js';
import { trimToTokens, stripSpeakerPrefix, matchName } from '../core/text.js';

const KEY_NOTE = 'DM_NOTE';
const LEGACY_KEYS = ['DM_DIRECTION', 'DM_STANDING'];
/** Message types the bot never sees in campaign chats. */
const HIDDEN_TYPES = new Set(['narration', 'ooc', 'roll', 'note']);

// ---------------- The note ----------------

function sceneVars(c) {
    const w = c.docs.world;
    const npcsHere = (c.docs.npcs || []).filter(n => w.location && n.lastSeen === w.location).map(n => n.name);
    return {
        player: c.meta.persona.name,
        party: c.meta.party.map(p => p.name).join(', '),
        location: [w.location, w.time].filter(Boolean).join(', '),
        present: npcsHere.join(', '),
        situation: c.meta.standing || '',
        goal: c.meta.objective || '',
    };
}

/**
 * Build the note the bot gets for one reply.
 * @param {{brief?: string, length?: string}} [opts] brief = the DM's private note for this reply
 */
export function buildNote({ brief = '', length = 'normal' } = {}) {
    const c = campaign();
    if (!c) return '';
    const s = settings();
    const vars = sceneVars(c);
    const parts = [renderTemplate(s.templates.scene, vars)];
    if (c.meta.pacing?.inCombat) parts.push(renderTemplate(s.templates.combat, vars));
    if (brief) parts.push(renderTemplate(s.templates.brief, { ...vars, brief, length: lengthText(length, s.lengths) }));
    return parts.filter(Boolean).join('\n');
}

function setNote(text) {
    const s = settings();
    const role = s.noteRole === 'user' ? ST.promptRoles.USER : ST.promptRoles.SYSTEM;
    const depth = Math.max(0, Math.min(10, Number(s.noteDepth) || 0));
    ST.setExtensionPrompt(KEY_NOTE, text, ST.promptTypes.IN_CHAT, depth, false, role);
}

/** The base note (no brief) stays in every local generation while a campaign is active. */
export function refreshStandingPrompt() {
    const c = campaign();
    for (const key of LEGACY_KEYS) ST.setExtensionPrompt(key, '', ST.promptTypes.IN_CHAT, 0);
    if (!c || c.meta.paused) {
        setNote('');
        return;
    }
    setNote(buildNote());
}

/** Use the DM's brief for the next reply. */
export function injectDirection(brief, length = 'normal') {
    setNote(buildNote({ brief, length }));
}

/** Back to the base note. */
export function clearDirection() {
    refreshStandingPrompt();
}

export function clearPrompts() {
    setNote('');
    for (const key of LEGACY_KEYS) ST.setExtensionPrompt(key, '', ST.promptTypes.IN_CHAT, 0);
}

/**
 * SillyTavern generation interceptor (registered in index.js, declared in manifest.json):
 * remove the DM's narration and other plugin-only messages from what the bot reads.
 * `chat` is SillyTavern's per-generation copy, so the visible chat is untouched.
 */
export function hideNarrationFromBot(chat) {
    const c = campaign();
    if (!c || c.meta.paused || !settings().hideNarration || !Array.isArray(chat)) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (HIDDEN_TYPES.has(dmType(chat[i]))) chat.splice(i, 1);
    }
}

// ---------------- Who can speak ----------------

/** Names the extension can make speak: party members + NPCs in the roster here. */
export function speakerCandidates() {
    const c = campaign();
    if (!c) return [];
    const npcsHere = (c.docs.npcs || []).filter(n => !c.docs.world.location || n.lastSeen === c.docs.world.location).map(n => n.name);
    return [...c.meta.party.map(p => p.name), ...npcsHere];
}

/**
 * Make someone speak. Returns 'party' | 'npc' | null.
 * @param {string} speaker
 * @param {string} brief the DM's private note ('' = none: the bot plays freely)
 * @param {{signal?: AbortSignal, length?: string}} [opts]
 */
export async function makeSpeak(speaker, brief, { signal, length = 'normal' } = {}) {
    const c = campaign();
    if (!c) return null;
    const partyNames = c.meta.party.map(p => p.name);
    const partyMatch = matchName(speaker, partyNames);
    if (partyMatch) {
        await speakPartyMember(partyMatch, brief, { signal, length });
        return 'party';
    }
    const npcMatch = matchName(speaker, (c.docs.npcs || []).map(n => n.name));
    let npc = (c.docs.npcs || []).find(n => n.name === npcMatch);
    if (!npc) {
        // The DM briefed someone it never registered: add them so they keep a voice and a memory.
        [npc] = addNpcs(c.docs.npcs, [{ name: speaker, description: '', gender: 'any', attitude: 'neutral' }], c.docs.world.location);
        npc.voice = pickNpcVoice(npc, c.docs.npcs);
        saveDoc('npcs');
    }
    npc.lastSeen = c.docs.world.location || npc.lastSeen;
    await speakNpc(npc, brief, { signal, length });
    return 'npc';
}

async function speakPartyMember(name, brief, { signal, length = 'normal' } = {}) {
    const c = campaign();
    const member = c.meta.party.find(p => p.name === name);
    const chid = findCharacterIndex(member?.avatar || name);
    const group = currentGroup();
    if (chid === -1 || !group || !group.members.includes(ST.characters[chid].avatar)) {
        throw new Error(`${name} isn't a member of this group chat.`);
    }
    if (signal?.aborted) return;
    await waitUntilIdle();
    const textarea = document.getElementById('send_textarea');
    if (textarea && textarea.value) {
        // Never let a group trigger swallow text the user is typing.
        throw new Error('Clear the message box so the party can reply.');
    }
    if (brief) injectDirection(brief, length);
    const restoreTts = pauseTtsStreamingIfNeeded();
    try {
        await withActorProfile(async () => {
            await ST.Generate('normal', { force_chid: chid });
        });
    } finally {
        clearDirection();
        restoreTts();
    }
    await stripEchoedName(name);
    rememberBriefOnReply(name, brief, length);
}

/** Store the brief on the reply itself, so swiping THAT reply reuses the same brief. */
function rememberBriefOnReply(name, brief, length) {
    const msg = ST.chat[ST.chat.length - 1];
    if (!msg || msg.is_user || msg.name !== name) return;
    msg.extra = msg.extra || {};
    msg.extra.dm_direction = brief || '';
    msg.extra.dm_length = length || 'normal';
    ST.saveChat();
}

/** For swipes: the brief a given reply was written with. */
export function briefForMessage(msg) {
    if (!msg?.extra?.dm_direction) return null;
    return { brief: msg.extra.dm_direction, length: msg.extra.dm_length || 'normal' };
}

/**
 * In group chats SillyTavern starts the requested reply with "Name:". Thinking models like
 * Gemma 4 / Orion then skip thinking and garble words (tested: 2-3 of 6 replies mangled with the
 * prefix, 0 of 6 without). In campaign chats only, drop that one prefix; names on earlier
 * messages stay, so the model still knows who said what.
 * @param {{prompt: string}} eventData from GENERATE_AFTER_COMBINE_PROMPTS
 */
export function stripReplyNamePrefix(eventData) {
    const c = campaign();
    if (!c || c.meta.paused || !ST.selectedGroup || typeof eventData?.prompt !== 'string') return;
    const instruct = ST.powerUser.instruct;
    if (!instruct?.enabled || !['force', 'always'].includes(String(instruct.names_behavior))) return;
    const name = ST.context().name2;
    if (!name) return;
    const bias = ST.substituteParams(String(ST.powerUser.user_prompt_bias || ''));
    const prompt = eventData.prompt;
    const withBias = `${name}:${bias}`;
    if (bias && prompt.endsWith(withBias)) {
        eventData.prompt = prompt.slice(0, prompt.length - withBias.length) + bias;
        return;
    }
    const trimmed = prompt.replace(/[ \t]+$/, '');
    if (trimmed.endsWith(`${name}:`)) {
        eventData.prompt = trimmed.slice(0, trimmed.length - name.length - 1);
    }
}

/**
 * Any party member's reply in a campaign chat (including swipes): remove an echoed "Name:" start.
 * Runs on CHARACTER_MESSAGE_RENDERED, before the reply is voiced.
 */
export async function cleanPartyReply(messageId) {
    const c = campaign();
    if (!c || c.meta.paused) return;
    const msg = ST.chat[Number(messageId)];
    if (!msg || msg.is_user || !c.meta.party.some(p => p.name === msg.name)) return;
    await stripEchoedName(msg.name, Number(messageId));
}

/** Models sometimes start a reply with "Name:"; remove it from the message. */
async function stripEchoedName(name, messageId = ST.chat.length - 1) {
    const id = messageId;
    const msg = ST.chat[id];
    if (!msg || msg.is_user || msg.name !== name) return;
    const cleaned = stripSpeakerPrefix(msg.mes, name);
    if (cleaned === msg.mes.trim() || !cleaned) return;
    msg.mes = cleaned;
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number') msg.swipes[msg.swipe_id] = cleaned;
    ST.updateMessageBlock(id, msg);
    await ST.saveChat();
}

/**
 * Only matters when SillyTavern's own TTS is still on (plugin voices turned off): its "speak while
 * streaming" mode peeks at the previous message, and if that's the DM's or an NPC's it errors
 * ("not in voicemap"). Pause that mode for this one reply.
 */
function pauseTtsStreamingIfNeeded() {
    const tts = ST.extensionSettings.tts;
    const last = ST.chat[ST.chat.length - 1];
    const type = dmType(last);
    if (!tts?.enabled || !tts?.periodic_auto_generation || !(type === 'narration' || type === 'npc')) return () => { };
    tts.periodic_auto_generation = false;
    return () => {
        tts.periodic_auto_generation = true;
        ST.saveSettingsDebounced();
    };
}

/** Temporarily switch to the actor connection profile, if one is set. */
async function withActorProfile(fn) {
    const s = settings();
    const target = profileById(s.actorProfileId);
    const before = selectedProfileId();
    if (!target || target.id === before) return fn();
    const ctx = ST.context();
    const previous = profileById(before);
    await ctx.executeSlashCommandsWithOptions(`/profile await=true ${JSON.stringify(target.name)}`);
    try {
        return await fn();
    } finally {
        if (previous) await ctx.executeSlashCommandsWithOptions(`/profile await=true ${JSON.stringify(previous.name)}`);
    }
}

// ---------------- NPCs ----------------

/** Recent chat for an NPC prompt: the DM's narration and plugin cards are left out, like for companions. */
function npcChatMessages(maxMessages = 16) {
    const out = [];
    const chat = ST.chat;
    // If the selected instruct format already writes speaker names, don't add them twice
    // (doubled names teach the model to echo "Name:" at the start of its reply).
    const instruct = ST.powerUser.instruct ?? {};
    const formatAddsNames = instruct.enabled && ['always', 'force'].includes(String(instruct.names_behavior));
    const hide = settings().hideNarration;
    for (let i = Math.max(0, chat.length - maxMessages * 2); i < chat.length; i++) {
        const m = chat[i];
        if (!m?.mes || m.is_system) continue;
        const type = dmType(m);
        if (type === 'note' || (hide && HIDDEN_TYPES.has(type))) continue;
        const body = trimToTokens(m.mes, 350);
        out.push({ role: m.is_user ? 'user' : 'assistant', name: m.name, content: formatAddsNames ? body : `${m.name}: ${body}` });
    }
    return out.slice(-maxMessages);
}

async function speakNpc(npc, brief, { signal, length = 'normal' } = {}) {
    const c = campaign();
    const s = settings();
    const pu = ST.powerUser;
    const sysTemplate = pu.sysprompt?.enabled === false ? '' : (pu.sysprompt?.content || '');
    const sub = (text) => ST.substituteParams(text, { name1Override: c.meta.persona.name, name2Override: npc.name, replaceCharacterCard: false });
    const vars = {
        ...sceneVars(c),
        npc: npc.name,
        description: [npc.description, npc.stats ? `Capabilities: ${npc.stats}.` : ''].filter(Boolean).join(' '),
        pronouns: pronounsFor(npc.gender),
        attitude: npc.attitude || '',
    };
    const npcNote = sub(renderTemplate(s.templates.npc, vars));
    const where = [vars.location ? `Where: ${vars.location}.` : '', vars.situation ? `Right now: ${vars.situation}` : ''].filter(Boolean).join(' ');
    const system = [sub(sysTemplate), '', npcNote, where ? `[${where}]` : ''].filter(Boolean).join('\n').trim();
    const postHistory = pu.sysprompt?.post_history ? sub(pu.sysprompt.post_history) : '';
    const messages = npcChatMessages();
    const finalNote = [
        brief ? sub(renderTemplate(s.templates.brief, { ...vars, brief, length: lengthText(length, s.lengths) })) : '',
        postHistory,
    ].filter(Boolean).join('\n');
    if (finalNote) messages.push({ role: 'system', content: finalNote });
    if (signal?.aborted) return;
    const raw = await callLocal({ system, messages, maxTokens: ST.responseLength || 400, profileId: s.actorProfileId });
    const text = stripSpeakerPrefix(cleanLocalOutput(raw), npc.name);
    if (!text) throw new Error(`The local model returned nothing for ${npc.name}.`);
    await postNpc(npc.name, text, npc);
    voiceLine({ kind: 'npc', name: npc.name, text, voice: npc.voice });
}
