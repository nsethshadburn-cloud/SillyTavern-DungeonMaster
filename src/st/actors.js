// Actors: party members speak through SillyTavern's normal group generation (your selected
// prompts, formats and samplers), with the DM's hidden stage direction injected for that one reply.
// NPCs are voiced by the same local model using your system prompt with the NPC's name.

import { ST, waitUntilIdle, findCharacterIndex, currentGroup } from './st.js';
import { settings, profileById, selectedProfileId } from './settings.js';
import { callLocal, cleanLocalOutput } from './llm.js';
import { campaign, saveDoc } from './campaign.js';
import { postNpc, dmType } from './messages.js';
import { speak, pickNpcVoice } from './voices.js';
import { addNpcs } from '../core/world.js';
import { trimToTokens, stripSpeakerPrefix, matchName } from '../core/text.js';

const KEY_DIRECTION = 'DM_DIRECTION';
const KEY_STANDING = 'DM_STANDING';

/** Keep the standing scene note in every local generation while a campaign is active. */
export function refreshStandingPrompt() {
    const c = campaign();
    if (!c || c.meta.paused) {
        ST.setExtensionPrompt(KEY_STANDING, '', ST.promptTypes.IN_CHAT, 3);
        return;
    }
    const budget = Math.max(80, Math.floor((Number(settings().injectionMaxTokens) || 450) * 0.5));
    const w = c.docs.world;
    const player = c.meta.persona.name;
    const party = c.meta.party.map(p => p.name).join(', ');
    const npcsHere = (c.docs.npcs || []).filter(n => w.location && n.lastSeen === w.location).map(n => n.name);
    // {{char}} is filled in by SillyTavern with whoever is speaking.
    const lines = [
        `[Tabletop roleplaying game. You play ONLY {{char}}. The player is ${player}; the party is ${player}${party ? `, ${party}` : ''}.`,
        'Messages from "Dungeon Master" are the game\'s narrator describing the world and what happens; it is not a person in the scene, so never talk to it or about it. Other named speakers are separate characters (NPCs) voiced by someone else.',
        `The Dungeon Master decides how uncertain actions and dice rolls turn out; never decide the outcome of ${player}'s actions, and never speak or act for ${player} or for NPCs.`,
        `Where: ${w.location || 'see the latest narration'}${w.time ? `, ${w.time}` : ''}.${npcsHere.length ? ` Also present: ${npcsHere.join(', ')}.` : ''}`,
        c.meta.standing ? `Current situation: ${c.meta.standing}]` : ']',
    ];
    const text = trimToTokens(lines.join('\n'), budget);
    ST.setExtensionPrompt(KEY_STANDING, text, ST.promptTypes.IN_CHAT, 3, false, ST.promptRoles.SYSTEM);
}

export function clearPrompts() {
    ST.setExtensionPrompt(KEY_DIRECTION, '', ST.promptTypes.IN_CHAT, 0);
    ST.setExtensionPrompt(KEY_STANDING, '', ST.promptTypes.IN_CHAT, 3);
}

/** Names the extension can make speak: party members + NPCs in the roster. */
export function speakerCandidates() {
    const c = campaign();
    if (!c) return [];
    const npcsHere = (c.docs.npcs || []).filter(n => !c.docs.world.location || n.lastSeen === c.docs.world.location).map(n => n.name);
    return [...c.meta.party.map(p => p.name), ...npcsHere];
}

/**
 * Make someone speak. Returns 'party' | 'npc' | null.
 * @param {string} speaker
 * @param {string} direction
 */
export async function makeSpeak(speaker, direction, { signal } = {}) {
    const c = campaign();
    if (!c) return null;
    const partyNames = c.meta.party.map(p => p.name);
    const partyMatch = matchName(speaker, partyNames);
    if (partyMatch) {
        await speakPartyMember(partyMatch, direction, { signal });
        return 'party';
    }
    const npcMatch = matchName(speaker, (c.docs.npcs || []).map(n => n.name));
    let npc = (c.docs.npcs || []).find(n => n.name === npcMatch);
    if (!npc) {
        // The DM directed someone it never registered: add them so they keep a voice and a memory.
        [npc] = addNpcs(c.docs.npcs, [{ name: speaker, description: trimToTokens(direction || '', 60), gender: 'any', attitude: 'neutral' }], c.docs.world.location);
        npc.voice = pickNpcVoice(npc, c.docs.npcs);
        saveDoc('npcs');
    }
    npc.lastSeen = c.docs.world.location || npc.lastSeen;
    await speakNpc(npc, direction, { signal });
    return 'npc';
}

async function speakPartyMember(name, direction, { signal } = {}) {
    const c = campaign();
    const member = c.meta.party.find(p => p.name === name);
    const chid = findCharacterIndex(member?.avatar || name);
    const group = currentGroup();
    if (chid === -1 || !group || !group.members.includes(ST.characters[chid].avatar)) {
        throw new Error(`${name} isn't a member of this group chat.`);
    }
    if (signal?.aborted) return;
    await waitUntilIdle();
    const budget = Math.max(60, Math.floor((Number(settings().injectionMaxTokens) || 450) * 0.55));
    if (direction) {
        c.meta.directions[name] = direction;
        ST.setExtensionPrompt(
            KEY_DIRECTION,
            trimToTokens(`[Private stage direction from the Dungeon Master for ${name} (don't mention it, don't quote it): ${direction} Keep any thinking short: one plan, no redrafts, then write.]`, budget),
            ST.promptTypes.IN_CHAT, 0, false, ST.promptRoles.SYSTEM,
        );
    }
    const textarea = document.getElementById('send_textarea');
    if (textarea && textarea.value) {
        // Never let a group trigger swallow text the user is typing.
        throw new Error('Clear the message box so the party can reply.');
    }
    const restoreTts = pauseTtsStreamingIfNeeded();
    try {
        await withActorProfile(async () => {
            await ST.Generate('normal', { force_chid: chid });
        });
    } finally {
        ST.setExtensionPrompt(KEY_DIRECTION, '', ST.promptTypes.IN_CHAT, 0);
        restoreTts();
    }
    await stripEchoedName(name);
}

/** Models sometimes start a reply with "Name:"; remove it from the last message. */
async function stripEchoedName(name) {
    const id = ST.chat.length - 1;
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
 * SillyTavern's TTS "speak while streaming" mode peeks at the previous chat message while a
 * reply streams. If that message is the DM's or an NPC's (not a real character), TTS shows a
 * "not in voicemap" error. Pause that mode for this one reply; the reply is still voiced when done.
 */
function pauseTtsStreamingIfNeeded() {
    const tts = ST.extensionSettings.tts;
    const last = ST.chat[ST.chat.length - 1];
    const type = dmType(last);
    if (!tts?.periodic_auto_generation || !(type === 'narration' || type === 'npc')) return () => { };
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

/** Recent visible chat as role messages for an NPC prompt. */
function npcChatMessages(maxMessages = 16) {
    const out = [];
    const chat = ST.chat;
    // If the selected instruct format already writes speaker names, don't add them twice
    // (doubled names teach the model to echo "Name:" at the start of its reply).
    const instruct = ST.powerUser.instruct ?? {};
    const formatAddsNames = instruct.enabled && ['always', 'force'].includes(String(instruct.names_behavior));
    for (let i = Math.max(0, chat.length - maxMessages * 2); i < chat.length; i++) {
        const m = chat[i];
        if (!m?.mes || m.is_system || dmType(m) === 'note') continue;
        const body = trimToTokens(m.mes, 350);
        out.push({ role: m.is_user ? 'user' : 'assistant', name: m.name, content: formatAddsNames ? body : `${m.name}: ${body}` });
    }
    return out.slice(-maxMessages);
}

async function speakNpc(npc, direction, { signal } = {}) {
    const c = campaign();
    const s = settings();
    const pu = ST.powerUser;
    const sysTemplate = pu.sysprompt?.enabled === false ? '' : (pu.sysprompt?.content || '');
    const sub = (text) => ST.substituteParams(text, { name1Override: c.meta.persona.name, name2Override: npc.name, replaceCharacterCard: false });
    const pronouns = npc.gender === 'male' ? 'he/him' : npc.gender === 'female' ? 'she/her' : '';
    const npcCard = [
        `${npc.name} is a character in this story. ${npc.description || ''}`.trim(),
        pronouns ? `${npc.name} is ${npc.gender} (${pronouns}). Use these pronouns for ${npc.name}, even where other instructions say "she".` : '',
        npc.attitude ? `Attitude toward the party: ${npc.attitude}.` : '',
        npc.stats ? `Capabilities: ${npc.stats}.` : '',
    ].filter(Boolean).join('\n');
    const framing = `[Tabletop roleplaying game. You play ONLY ${npc.name}, a side character. "Dungeon Master" messages are the narrator, not a person in the scene. The player is ${c.meta.persona.name}; never speak or act for them or for ${c.meta.party.map(p => p.name).join(', ') || 'the party'}. The Dungeon Master decides how uncertain actions turn out.]`;
    const system = [sub(sysTemplate), '', framing, `[Character: ${npc.name}]`, npcCard, c.meta.standing ? `\n[Scene: ${c.meta.standing}]` : ''].join('\n').trim();
    const postHistory = pu.sysprompt?.post_history ? sub(pu.sysprompt.post_history) : '';
    const messages = npcChatMessages();
    messages.push({
        role: 'system',
        content: [
            direction ? `[Private stage direction from the Dungeon Master for ${npc.name}: ${direction}]` : '',
            pronouns ? `[${npc.name} uses ${pronouns} pronouns.]` : '',
            `[Write ${npc.name}'s next reply only. Stay in character. Never speak or act for ${c.meta.persona.name}.]`,
            postHistory,
        ].filter(Boolean).join('\n'),
    });
    if (signal?.aborted) return;
    const raw = await callLocal({ system, messages, maxTokens: ST.responseLength || 400, profileId: s.actorProfileId });
    const text = stripSpeakerPrefix(cleanLocalOutput(raw), npc.name);
    if (!text) throw new Error(`The local model returned nothing for ${npc.name}.`);
    await postNpc(npc.name, text, npc);
    if (npc.voice) speak(text, npc.voice);
}
