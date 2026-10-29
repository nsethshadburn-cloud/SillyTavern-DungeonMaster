// Actors: party members speak through SillyTavern's normal group generation (your selected
// prompts, formats and samplers). The plugin adds ONE note per reply, built from editable
// templates (Settings → "What the bot is told"), and hides the DM's narration from the bot:
// the bot only learns what the DM's private brief tells it.
// NPCs are voiced by the same local model with a prompt built from your system prompt + the NPC template.

import { ST, waitUntilIdle, findCharacterIndex, currentGroup } from './st.js';
import { settings, profileById, selectedProfileId } from './settings.js';
import { campaign, saveDoc } from './campaign.js';
import { dmType } from './messages.js';
import { ensureNpcMember, touchNpc, npcForName } from './npccards.js';
import { pickNpcVoice, voiceLine } from './voices.js';
import { addNpcs, isAway, awareSummary, isHere } from '../core/world.js';
import { renderTemplate, lengthText, pronounsFor, fitNote, noteBudget } from '../core/notes.js';
import { trimToTokens, stripSpeakerPrefix, matchName, nameKey, repeatedPhrases } from '../core/text.js';
import { renderSceneCard, renderTimeline, renderPeople } from '../core/state.js';
import { roomBrief, currentPlace } from './atlas.js';
import { personByName, isOut, EARSHOT } from '../core/explore.js';
import { ensureClock, hhmm, WEATHER_WORDS } from '../core/clock.js';

const KEY_NOTE = 'DM_NOTE';
const LEGACY_KEYS = ['DM_DIRECTION', 'DM_STANDING'];
/** Message types the bot never sees in campaign chats. */
const HIDDEN_TYPES = new Set(['narration', 'ooc', 'roll', 'note']);

// ---------------- The note ----------------

function sceneVars(c) {
    const w = c.docs.world;
    const clock = ensureClock(w);
    const npcsHere = w.location ? npcsInReach(c).map(n => n.name) : [];
    return {
        player: c.meta.persona.name,
        party: c.meta.party.map(p => p.name).join(', '),
        location: [w.location, w.time ? `${w.time} (${hhmm(clock.minutes)})` : '', w.weather && w.weather !== 'clear' ? WEATHER_WORDS[w.weather] : ''].filter(Boolean).join(', '),
        present: npcsHere.join(', '),
        situation: c.meta.standing || '',
        goal: c.meta.objective || '',
    };
}

/** Party conditions by name (poisoned, prone...), for the scene card. */
function partyConditions(w) {
    return Object.fromEntries(Object.entries(w.party || {}).map(([n, p]) => [n, p?.conditions || []]));
}

/** A character's recent replies (the shown swipe), newest last. */
function recentRepliesOf(name, max = 8) {
    const out = [];
    for (let i = ST.chat.length - 1; i >= 0 && out.length < max; i--) {
        const m = ST.chat[i];
        if (m && !m.is_user && !m.is_system && m.name === name && m.mes) out.unshift(m.mes);
    }
    return out;
}

/** The fight's enemies, the people on the map (their side, the dead), and who has spotted the party. */
function mapPeople(c) {
    const w = c.docs.world;
    const foes = Object.keys(w.combat?.enemies ?? {});
    const here = currentPlace(c);
    const others = here ? Object.values(here.place.guards).filter(g => g.state !== 'gone').map(g => ({ name: g.name, description: g.description, hostile: g.hostile === true || g.intent === 'attack', dead: g.state === 'dead' })) : [];
    return { foes, others, aware: awareSummary(w) };
}

/** What is true right now: the scene card, people met, the timeline (companions only), table rules. */
function stateVars(c, speaker, { npc = false } = {}) {
    const w = c.docs.world;
    const avoid = speaker
        ? repeatedPhrases(recentRepliesOf(speaker), { exclude: [speaker, c.meta.persona.name, ...c.meta.party.map(p => p.name)] })
        : [];
    return {
        scenecard: renderSceneCard(w.sceneCard, partyConditions(w)),
        people: renderPeople(c.docs.npcs, { exclude: speaker, ...mapPeople(c) }),
        // NPCs don't get the party's timeline: it can hold things only the party knows.
        timeline: npc ? '' : renderTimeline(c.meta.timeline, { day: w.day, time: w.time }, { skipLatest: Boolean(c.meta.happened) }),
        rules: (c.meta.tableRules || []).join(' '),
        avoid: avoid.map(p => `"${p}"`).join(', '),
    };
}

/**
 * Build the note the bot gets for one reply.
 * @param {{brief?: string, length?: string, npc?: object|null}} [opts] brief = the DM's private note
 *  for this reply; npc = the NPC who is replying (uses the NPC template instead of the scene note)
 */
export function buildNote({ brief = '', length = 'normal', npc = null, speaker = '' } = {}) {
    const c = campaign();
    if (!c) return '';
    const s = settings();
    const vars = sceneVars(c);
    const parts = [];
    parts.push({
        key: 'scene', text: npc
            ? renderTemplate(s.templates.npc, {
                ...vars,
                npc: npc.name,
                description: [npc.description, npc.stats ? `Capabilities: ${npc.stats}.` : ''].filter(Boolean).join(' '),
                pronouns: pronounsFor(npc.gender),
                attitude: npc.attitude || '',
            })
            : renderTemplate(s.templates.scene, vars),
    });
    const state = stateVars(c, speaker, { npc: Boolean(npc) });
    parts.push({ key: 'state', text: renderTemplate(s.templates.state, { ...vars, ...state }) });
    if (c.meta.happened) parts.push({ key: 'happened', text: renderTemplate(s.templates.happened, { ...vars, happened: c.meta.happened }) });
    const knowledge = speaker ? c.meta.knowledge?.[speaker] : '';
    if (knowledge) parts.push({ key: 'knowledge', text: renderTemplate(s.templates.knowledge, { ...vars, knowledge }) });
    if (speaker) {
        const here = roomBrief(c, speaker);
        if (here.room && s.templates.room) parts.push({ key: 'room', text: renderTemplate(s.templates.room, { ...vars, ...here }) });
    }
    if (c.meta.pacing?.inCombat) parts.push({ key: 'combat', text: renderTemplate(s.templates.combat, vars) });
    if (state.avoid) parts.push({ key: 'avoid', text: renderTemplate(s.templates.avoid, { ...vars, avoid: state.avoid }) });
    if (brief) parts.push({ key: 'brief', text: renderTemplate(s.templates.brief, { ...vars, brief, length: lengthText(length, s.lengths) }) });
    // Sized to the player's setting and the live context, so the note never crowds out the chat.
    return fitNote(parts, noteBudget(s, { maxContext: ST.maxContext, responseLength: ST.responseLength })).join('\n');
}

/** The note for the next generation when it rides inside the player's turn (noteMode 'message'). */
let noteForMessage = '';

function setNote(text) {
    const s = settings();
    if (s.noteMode !== 'separate') {
        // Added by the generation interceptor instead (addNoteToChat), so SillyTavern's prompt keeps
        // its own shape: no extra turn of ours between the player's message and its post-history turn.
        noteForMessage = text;
        ST.setExtensionPrompt(KEY_NOTE, '', ST.promptTypes.IN_CHAT, 0);
        return;
    }
    noteForMessage = '';
    const role = s.noteRole === 'user' ? ST.promptRoles.USER : ST.promptRoles.SYSTEM;
    const depth = Math.max(0, Math.min(10, Number(s.noteDepth) || 0));
    ST.setExtensionPrompt(KEY_NOTE, text, ST.promptTypes.IN_CHAT, depth, false, role);
}

/**
 * Generation interceptor part 2: put the note inside the player's turn.
 * Why: SillyTavern already ends every prompt with its own turns (the player's message, then the
 * post-history instruction as another user turn). A separate system turn of ours in between is a
 * second system turn mid-conversation, which models like Gemma 4 treat as a new system setup
 * (Gemma wants <|think|> and all system instructions in ONE system turn). Inside the player's
 * message, the note uses whatever format the player has selected and adds no turn at all.
 * If the latest message isn't the player's (a companion speaking after an NPC), it becomes a
 * plain user turn; SillyTavern adds no name to the player's own turns, so it stays unlabeled.
 * `chat` is SillyTavern's per-generation copy (fresh objects), so the saved chat is untouched.
 */
export function addNoteToChat(chat) {
    const c = campaign();
    if (!c || c.meta.paused || !noteForMessage || !Array.isArray(chat) || settings().noteMode === 'separate') return;
    const note = ST.substituteParams(noteForMessage);
    if (!note.trim()) return;
    const last = chat[chat.length - 1];
    if (last?.is_user && !dmType(last)) {
        chat[chat.length - 1] = { ...last, mes: `${String(last.mes ?? '').trimEnd()}\n\n${note}` };
    } else {
        chat.push({ name: ST.context().name1, is_user: true, is_system: false, mes: note, send_date: '', extra: { type: 'dm_note' } });
    }
}

/** The base note (no brief) stays in every local generation while a campaign is active. */
export function refreshStandingPrompt() {
    const c = campaign();
    for (const key of LEGACY_KEYS) ST.setExtensionPrompt(key, '', ST.promptTypes.IN_CHAT, 0);
    if (!c || c.meta.paused) {
        setNote('');
        return;
    }
    // With one companion, the base note can carry what they know.
    setNote(buildNote({ speaker: c.meta.party.length === 1 ? c.meta.party[0].name : '' }));
}

/** Use the DM's brief for the next reply (and the NPC template when an NPC is replying). */
export function injectDirection(brief, length = 'normal', npc = null, speaker = '') {
    setNote(buildNote({ brief, length, npc, speaker: speaker || npc?.name || '' }));
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
    if (!c || c.meta.paused || !Array.isArray(chat)) return;
    hideOtherScenesFromNpc(c, chat);
    if (!settings().hideNarration) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (HIDDEN_TYPES.has(dmType(chat[i]))) chat.splice(i, 1);
    }
}

/** Message flag set where a new scene starts (see markSceneStart). */
export function isSceneStart(message) {
    return Boolean(message?.extra?.dungeon_master?.sceneStart || message?.extra?.dm_scene_start);
}

/**
 * NPCs only remember the scene they're in: everything before the latest scene start is dropped
 * from an NPC's prompt, so a magistrate can't quote what was said in a cell. Their brief and the
 * scene card tell them what they need. SillyTavern's copy keeps each message's `extra`.
 */
function hideOtherScenesFromNpc(c, chat) {
    const speaker = ST.context().name2;
    if (!speaker || c.meta.party.some(p => p.name === speaker) || !npcForName(speaker)) return;
    const start = chat.findLastIndex(m => isSceneStart(m));
    if (start > 0) chat.splice(0, start);
}

/** Mark a message as the start of a new scene (the arrival narration, or the latest message). */
export async function markSceneStart(messageId = ST.chat.length - 1) {
    const msg = ST.chat[messageId];
    if (!msg) return;
    msg.extra = msg.extra || {};
    msg.extra.dm_scene_start = true;
    await ST.saveChat();
}

// ---------------- Who can speak ----------------

/** Names the extension can make speak: party members + NPCs in the roster here. */
/**
 * The roster NPCs who are here and in reach. On a map, someone who is on it counts only from the
 * same floor, within earshot, and awake (a warden two floors up, or a jailer asleep at his desk,
 * is not in the conversation); tied up still talks.
 */
export function npcsInReach(c = campaign()) {
    if (!c) return [];
    const here = currentPlace(c);
    const lead = here?.place.state.positions[c.meta.persona.name];
    const inReach = name => {
        const g = here && personByName(here.place, name);
        if (!g || !lead) return true;
        if (isOut(g) && g.down !== 'bound') return false;
        return g.floor === lead.floor && Math.max(Math.abs(g.x - lead.x), Math.abs(g.y - lead.y)) <= EARSHOT;
    };
    return (c.docs.npcs || []).filter(n => isHere(n, c.docs.world.location) && inReach(n.name));
}

export function speakerCandidates() {
    const c = campaign();
    if (!c) return [];
    return [...c.meta.party.map(p => p.name).filter(n => !isAway(c.docs.world, n)), ...npcsInReach(c).map(n => n.name)];
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
    const exactNpc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(speaker));
    // An exact NPC name beats a loose match on a companion ("Nick the barkeep" vs "Nick Wilde").
    const partyMatch = partyNames.find(n => nameKey(n) === nameKey(speaker)) ?? (exactNpc ? null : matchName(speaker, partyNames));
    if (partyMatch) {
        await speakPartyMember(partyMatch, brief, { signal, length });
        return 'party';
    }
    const npcMatch = matchName(speaker, (c.docs.npcs || []).map(n => n.name));
    let npc = exactNpc ?? (c.docs.npcs || []).find(n => n.name === npcMatch);
    if (!npc) {
        // The DM briefed someone it never registered: add them so they keep a voice and a memory.
        [npc] = addNpcs(c.docs.npcs, [{ name: speaker, description: '', gender: 'any', attitude: 'neutral' }], c.docs.world.location);
        npc.voice = pickNpcVoice(npc, c.docs.npcs);
        saveDoc('npcs');
    }
    npc.lastSeen = c.docs.world.location || npc.lastSeen;
    await speakNpcMember(npc, brief, { signal, length });
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
    await speakMember(name, chid, brief, { signal, length });
}

/** One reply from a group member (party member or NPC) through SillyTavern's own generation. */
async function speakMember(name, chid, brief, { signal, length = 'normal', npc = null } = {}) {
    if (signal?.aborted) return;
    await waitUntilIdle();
    const textarea = document.getElementById('send_textarea');
    if (textarea && textarea.value) {
        // Never let a group trigger swallow text the user is typing.
        throw new Error('Clear the message box so the party can reply.');
    }
    injectDirection(brief, length, npc, name);
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
 * Any party member's or NPC's reply in a campaign chat (including swipes): remove an echoed
 * "Name:" start. Runs on CHARACTER_MESSAGE_RENDERED, before the reply is voiced.
 */
export async function cleanPartyReply(messageId) {
    const c = campaign();
    if (!c || c.meta.paused) return;
    const msg = ST.chat[Number(messageId)];
    if (!msg || msg.is_user || !(c.meta.party.some(p => p.name === msg.name) || npcForName(msg.name))) return;
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
// NPCs are real characters in the group chat (see npccards.js), so they speak through the same
// SillyTavern generation as party members. Only their note differs (the NPC template).

async function speakNpcMember(npc, brief, { signal, length = 'normal' } = {}) {
    const chid = await ensureNpcMember(npc);
    await speakMember(npc.name, chid, brief, { signal, length: length === 'long' ? 'normal' : 'short', npc });
    touchNpc(npc);
}
