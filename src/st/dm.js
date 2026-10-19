// Talking to the DM (Claude): building its prompt and reading its decisions.

import { ST } from './st.js';
import { settings } from './settings.js';
import { callClaude } from './llm.js';
import { campaign, saveDoc } from './campaign.js';
import { personaSheet, characterSheet, sheetMarkdown } from './sheets.js';
import { dmType } from './messages.js';
import { DM_RULES, CONDENSE_NOTES_INSTRUCTIONS, RECAP_INSTRUCTIONS, parseDmTurn } from '../core/protocol.js';
import { pacingReport } from '../core/pacing.js';
import { rosterSummary, combatSummary } from '../core/world.js';
import { estimateTokens, trimToTokens, extractJson } from '../core/text.js';

let stableCache = { key: '', text: '' };

/** The stable, cache-friendly part: rules + bible + character sheets. */
export async function stableSystem() {
    const c = campaign();
    const sheetsKey = JSON.stringify([
        personaSheet(c.meta.persona.avatar)?.file,
        ...c.meta.party.map(p => characterSheet(p.avatar)?.file),
    ]);
    const key = `${c.meta.id}|${c.docs.bible.length}|${sheetsKey}`;
    if (stableCache.key === key) return stableCache.text;

    const parts = [DM_RULES, '', '# CAMPAIGN BIBLE', c.docs.bible || '(none yet)'];
    parts.push('', '# THE PLAYER CHARACTER');
    parts.push(`Name: ${c.meta.persona.name}`);
    const pSheet = personaSheet(c.meta.persona.avatar);
    if (pSheet) parts.push(await sheetMarkdown(pSheet));
    else if (c.meta.persona.description) parts.push(trimToTokens(c.meta.persona.description, 800));
    parts.push('', '# PARTY MEMBERS (played by the local model)');
    for (const member of c.meta.party) {
        parts.push(`## ${member.name}`);
        if (member.summary) parts.push(member.summary);
        const sheet = characterSheet(member.avatar);
        if (sheet) parts.push(trimToTokens(await sheetMarkdown(sheet), 1500));
    }
    const text = parts.join('\n');
    stableCache = { key, text };
    return text;
}

export function resetStableCache() {
    stableCache = { key: '', text: '' };
}

/** Recent chat as plain text for the DM. */
export function transcript(maxMessages) {
    const out = [];
    const chat = ST.chat;
    const start = Math.max(0, chat.length - maxMessages);
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        const type = dmType(m);
        if (type === 'note') continue;
        let text = String(m.mes).replace(/<[^>]+>/g, '').trim();
        if (!text) continue;
        text = trimToTokens(text, 400);
        if (type === 'roll') out.push(`[DICE] ${text}`);
        else if (type === 'ooc') out.push(`[DM, out of character] ${text}`);
        else if (m.is_user) out.push(`${m.name} (PLAYER): ${text}`);
        else out.push(`${m.name}: ${text}`);
    }
    return out.join('\n');
}

/** MemoryBooks summaries in the chat's lorebook, newest last. */
async function memoryBookEntries(max = 4) {
    const book = ST.chatMetadata?.[ST.WORLD_INFO_KEY];
    if (!book) return '';
    try {
        const data = await ST.loadWorldInfo(book);
        const entries = Object.values(data?.entries ?? {}).filter(e => e?.stmemorybooks && e.content);
        entries.sort((a, b) => String(a.comment).localeCompare(String(b.comment), undefined, { numeric: true }));
        return entries.slice(-max).map(e => `### ${e.comment || 'Memory'}\n${trimToTokens(e.content, 500)}`).join('\n\n');
    } catch {
        return '';
    }
}

const REASON_TEXT = {
    ooc: 'The player asked you something out of character. Answer in "ooc". Only add narration if the question changes the scene.',
    roll_result: 'The player rolled for your last request. The result is below. Narrate the outcome.',
    risky_action: 'The player attempted something with an uncertain outcome. Rule on it: ask for a roll (player_roll) or narrate the result if no roll is needed.',
    scene_move: 'The player wants to move the scene (travel, rest, leave, time skip). Handle the transition with good pacing.',
    combat_action: 'Combat action. Resolve it fairly and keep the fight moving.',
    combat_round: 'Combat is ongoing. Run this round: enemies act (npc_rolls), keep it tense and readable.',
    event: 'A random event was drawn (below). Weave it in now, reshape it to fit, or set event.delay=true if the timing would ruin the moment.',
    stalled: 'The scene seems stuck going in circles. Nudge it forward from inside the world.',
    drift: 'The player has been off the main plot for a while. Follow the drift-stage guidance in the pacing report.',
    npc_addressed: 'The player is talking to a character who is not in the NPC list yet. Register them in new_npcs (if they exist in the scene) and give them a direction so they answer, or narrate why they can\'t.',
    checkin: 'Routine director check-in. Usually: no narration, just refresh standing_direction and maybe a direction or two. Only intervene if pacing needs it. Keep this response SHORT.',
    opening: 'Open the campaign.',
    manual: 'The player asked the DM to step in.',
};

/**
 * Build the volatile part of a DM call.
 * @param {{reasons:string[], playerMessage?:string, rollResolution?:string, event?:object|null, extraFiles?:string[], oocText?:string}} p
 */
export async function volatilePrompt({ reasons, playerMessage = '', rollResolution = '', event = null, extraFiles = [], oocText = '' }) {
    const c = campaign();
    const s = settings();
    const w = c.docs.world;
    const sections = [];
    const sessionMinutes = (Date.now() - (c.meta.session?.startedAt || Date.now())) / 60000;

    sections.push('# WHERE THINGS STAND');
    sections.push(`Location: ${w.location || 'unknown'} (${w.setting || 'any'}), time: ${w.time || '?'}, day ${w.day ?? 1}.`);
    sections.push(`Party HP: ${Object.entries(w.party).map(([n, p]) => `${n} ${p.hp}/${p.hp_max}${p.conditions?.length ? ` [${p.conditions.join(', ')}]` : ''}`).join('; ') || 'unknown'}.`);
    sections.push(`Gold: ${w.gold ?? 0}. Items: ${w.items?.length ? w.items.join(', ') : 'none noted'}.`);
    if (Object.keys(w.flags || {}).length) sections.push(`Flags: ${JSON.stringify(w.flags)}`);
    sections.push(combatSummary(w));
    sections.push(`Last standing direction you gave: ${c.meta.standing || '(none)'}`);
    sections.push(`Party's current objective (shown to companions): ${c.meta.objective || '(none set: set "objective")'}`);

    sections.push('', '# PACING REPORT', pacingReport(c.meta.pacing, { length: c.meta.options.length, sessionMinutes, usualSessionMinutes: Number(s.usualSessionMinutes) || 90 }));

    sections.push('', '# PLOT (tick beats via beats_completed using their ids)', c.docs.plot || '(no plot)');

    if (c.docs.notes) sections.push('', '# YOUR PRIVATE NOTES', trimToTokens(c.docs.notes, 2500, true));
    if (c.docs.story) sections.push('', '# STORY SO FAR', trimToTokens(c.docs.story, 2000, true));
    const memories = await memoryBookEntries();
    if (memories) sections.push('', '# MEMORY BOOK ENTRIES (from the MemoryBooks extension)', memories);
    if (c.docs.npcs?.length) sections.push('', '# NPCS MET', rosterSummary(c.docs.npcs));

    for (const f of extraFiles) {
        if (f === 'rolls_log') sections.push('', '# ROLLS LOG (recent)', JSON.stringify(c.docs.rolls_log.slice(-40)));
        if (f === 'events_log') sections.push('', '# EVENTS LOG', JSON.stringify(c.docs.events_log.slice(-40)));
    }

    sections.push('', '# RECENT CHAT (oldest first)', transcript(Number(s.recentMessages) || 24) || '(empty)');

    sections.push('', '# WHY YOU ARE BEING CALLED');
    for (const r of reasons) sections.push(`- ${REASON_TEXT[r] ?? r}`);
    if (oocText) sections.push('', `Player's out-of-character question: ${oocText}`);
    if (rollResolution) sections.push('', `ROLL RESULT: ${rollResolution}`);
    if (event) sections.push('', `RANDOM EVENT DRAWN: "${event.title}" (${event.type}, danger ${event.danger}/5): ${event.seed}`);
    if (playerMessage && !reasons.includes('checkin')) sections.push('', `The player's latest message: ${trimToTokens(playerMessage, 800)}`);

    const companions = c.meta.party.map(p => p.name);
    const present = (c.docs.npcs || []).filter(n => n.lastSeen && n.lastSeen === w.location).map(n => n.name);
    sections.push('', `Valid speakers for directions: party ${JSON.stringify(companions)}; NPCs here ${JSON.stringify(present)} (or new NPCs you introduce now).`);
    sections.push('Reply with the JSON object only.');
    return sections.join('\n');
}

/**
 * Run one DM call. Handles a single "need_files" round-trip.
 * @returns {Promise<{turn: ReturnType<typeof parseDmTurn>, usd: number, raw: string}>}
 */
export async function askDm(args, { label = 'DM turn', signal = null } = {}) {
    const system = await stableSystem();
    let user = await volatilePrompt(args);
    let reply = await callClaude({ system, user, label, signal });
    let usd = reply.usd;
    let turn = parseDmTurn(reply.text);
    if (turn && turn.need_files.length && !args.extraFiles?.length && !turn.narration && !turn.directions.length) {
        user = await volatilePrompt({ ...args, extraFiles: turn.need_files });
        reply = await callClaude({ system, user, label: `${label} (with files)`, signal });
        usd += reply.usd;
        turn = parseDmTurn(reply.text);
    }
    if (!turn) {
        // One retry asking for valid JSON.
        reply = await callClaude({ system, user: `${user}\n\nYour previous reply was not valid JSON. Reply with ONE valid JSON object only.`, label: `${label} (retry)`, signal });
        usd += reply.usd;
        turn = parseDmTurn(reply.text);
    }
    if (!turn) throw new Error('The DM did not return a usable answer.');
    logCost(label, usd);
    return { turn, usd, raw: reply.text };
}

function logCost(label, usd) {
    const c = campaign();
    if (!c) return;
    c.docs.costs.push({ at: new Date().toISOString(), label, usd });
    if (c.docs.costs.length > 2000) c.docs.costs.splice(0, c.docs.costs.length - 2000);
    c.meta.stats.usd = Math.round(((c.meta.stats.usd || 0) + usd) * 1e6) / 1e6;
    c.meta.stats.dmCalls = (c.meta.stats.dmCalls || 0) + 1;
    saveDoc('costs');
}

/** Keep the DM's notes compact (one cheap call when they get long). */
export async function maybeCondenseNotes() {
    const c = campaign();
    if (!c || estimateTokens(c.docs.notes) < 3000) return 0;
    const system = await stableSystem();
    const reply = await callClaude({ system: `${system}\n\n${CONDENSE_NOTES_INSTRUCTIONS}`, user: `# CURRENT NOTES\n${c.docs.notes}`, label: 'condense notes', maxTokens: 4000 });
    const json = extractJson(reply.text);
    if (json?.notes) {
        c.docs.notes = String(json.notes);
        saveDoc('notes');
    }
    logCost('condense notes', reply.usd);
    return reply.usd;
}

/** "Previously on…" after a long break. */
export async function recap() {
    const c = campaign();
    const system = await stableSystem();
    const user = [
        '# STORY SO FAR', c.docs.story || '(none)',
        '', '# PLOT', c.docs.plot,
        '', '# RECENT CHAT', transcript(30),
        '', RECAP_INSTRUCTIONS,
    ].join('\n');
    const reply = await callClaude({ system, user, label: 'recap', maxTokens: 2000 });
    logCost('recap', reply.usd);
    const json = extractJson(reply.text);
    return { text: String(json?.recap ?? reply.text), usd: reply.usd };
}
