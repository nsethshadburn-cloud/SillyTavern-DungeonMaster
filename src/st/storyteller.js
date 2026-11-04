// The storyteller (Claude): writes the narration and the companions' briefs from the table's ruling
// and the dice, which are settled before it is called. It sees the story (bible, plot, notes, minds,
// the transcript) and THE TABLE'S RULING; it may not send a roll or a state change (core/protocol.js
// normalizeStory drops those and the code tells it so next turn).

import { settings } from './settings.js';
import { callClaude, resolveDmConnection } from './llm.js';
import { campaign } from './campaign.js';
import { ESCALATE_INSTRUCTION, parseStory } from '../core/protocol.js';
import { pacingReport } from '../core/pacing.js';
import { rosterSummary, isHere } from '../core/world.js';
import { trimToTokens } from '../core/text.js';
import { renderMinds } from '../core/minds.js';
import { isBeast } from '../core/sprites.js';
import { modelLabel } from '../core/models.js';
import { storySystem, stateBlock, transcript, memoryBookEntries, companionsHere, logCost } from './dm.js';

/** Why the storyteller is being called: what to tell this turn. */
const REASON_TEXT = {
    ooc: 'The player said something out of character. If the referee answered it (its "ooc" is already posted), add nothing; a story question is yours to answer in "ooc", with narration only if the answer changes the scene.',
    roll_result: 'The player rolled for the last request and the ruling says how it went. Tell the outcome as fact.',
    risky_action: 'The player attempted something; the ruling says what it needs. If a roll is being asked, your narration stops at the moment before; if the ruling settled it, tell the result.',
    trade: 'Coin is changing hands; the ruling names the price and books what was paid. Tell it (the seller may name the price in their own line: brief them).',
    round_opens: 'Round 1 opens: the ruling ran those who beat the player. Narrate what they did (the dice say how it went), then hand the turn to the player.',
    scene_move: 'The party moved the scene (travel, rest, going in or out, a time skip): the ruling has them there. Compress the uneventful part, then describe where they arrive like a real DM would.',
    combat_action: 'A fight is starting or the player acted in one. Narrate the moment it breaks out (nobody\'s blow lands before the dice), or what the player\'s action looked like up to the ruling\'s result.',
    combat_round: 'The round ran: the ruling lists every roll and its result. Narrate them as settled facts, in initiative order, then hand the turn to the player. Companions get only a "short" brief for a quick line.',
    player_turn: 'It is the player\'s turn and they just acted; the ruling resolved only that. Narrate it and stop: nobody else acts.',
    end_turn: 'The player ended their turn and the ruling ran everyone up to the player\'s next turn. Narrate what each did, with the results as the dice gave them, then stop at the player\'s turn and say it is theirs.',
    reaction: 'The player reacted to a hit and the ruling says what came of it. Tell it.',
    event: 'The dice say a random event COULD happen now. Candidates are below. First decide if any event fits this exact moment and place. Set event.use to a candidate id, to "custom" (and describe yours in event.text) for a small event that fits better, or to "none" if nothing should happen right now.',
    deadlock: 'Deadlock: the player has refused or resisted what a character wants several times in a row. That character changes approach now (bargain, a firmer push, call for help, or let it go). Brief them with the NEW approach and update "objective"; never repeat the old demand.',
    stalled: 'The scene has stalled (filler replies or going in circles). Move it forward yourself: skip ahead, arrive somewhere, or let someone or something push in (anything that needs dice, the referee rules next turn).',
    drift: 'The party has been away from the plot for a while. Apply the PLOT PRESSURE stage in the pacing report, building on any pressure you set up before.',
    npc_addressed: 'The player is talking to a character who is not in the NPC list yet. Register them in new_npcs (if they exist in the scene) and give them a direction so they answer, or narrate why they can\'t.',
    companion_task: 'The player told a companion to do something (COMPANION TASK); the ruling says what they did and found. Brief them with that result so they tell the player in their own words, and put it in "happened".',
    contest: 'Someone grabbed at someone: the ruling has the contest (a roll asked, or rolled). Narrate the reaching hand, never the hold, until the dice say.',
    companion_action: 'A companion attempted something risky in their own reply and the ruling says how it went. Narrate what actually happens, and brief them only if they need to react.',
    solo: 'No companion or NPC is with the player right now, or nobody nearby would answer. Respond as the world: what they notice, what happens, who shows up. Keep it short if nothing much happens. Absent companions stay silent.',
    checkin: 'The world moves on: a few turns have passed since it last acted. Advance it one clear step: NPCs who are here act on their own jobs and agendas, anything underway takes its next step, something new shows up or is learned. A quiet moment is also when a companion acts on their MIND unprompted. Usually that happens through briefs, with narration only if something new arrives. If the player is mid-conversation, weave this around them. If they just set something up ("I have a question…"), the world waits: brief the listener only. Then set world_next (at least 2 after a setup). Anyone who arrives goes on the scene card ("scene_card"); anything that needs dice, say in a brief or narration what they attempt and the referee rules it next turn.',
    opening: 'Open the campaign.',
    manual: 'The player asked the DM to step in.',
};

/**
 * THE TABLE'S RULING: what the referee settled and the code did this turn, as lines the storyteller
 * tells and never changes.
 * @param {{fact?: string, cards?: string[], request?: object|null, held?: Record<string,string>, moved?: string, hp?: string}} r
 */
export function rulingBlock(r) {
    const lines = ['# THE TABLE\'S RULING (settled before you were called: tell it, never change it)'];
    if (r.fact) lines.push(`- Ruling: ${r.fact}`);
    for (const card of r.cards || []) lines.push(`- ${card}`);
    for (const [who, why] of Object.entries(r.held || {})) lines.push(`- ${who} holds this turn: ${why}`);
    if (r.moved) lines.push(`- The party is now at: ${r.moved}`);
    if (r.hp) lines.push(`- HP now: ${r.hp}`);
    if (r.request) lines.push(`- ASKED OF THE PLAYER, NOT YET ROLLED: ${r.request.skill || r.request.kind}${r.request.reason ? ` (${r.request.reason})` : ''}. Nothing about it is decided: stop at the moment before, and brief nobody to settle it.`);
    if (lines.length === 1) lines.push('- Nothing was rolled or changed this turn.');
    lines.push('These are settled; do not change them, do not re-roll, do not add a wound, a coin or a condition the ruling doesn\'t have.');
    return lines.join('\n');
}

/**
 * The storyteller's prompt, split by how often each piece changes so Claude's prompt cache can reuse
 * the slow parts (see callClaude): layers[0] = plot and NPCs met; layers[1] = notes, story so far,
 * minds, memories; user = everything that changes every call.
 */
export async function storyPrompt({ reasons, playerMessage = '', events = [], extraFiles = [], oocText = '', handUp = false, companionAction = null, companionTask = null, placeEvent = '', ruling = null }) {
    const c = campaign();
    const s = settings();
    const w = c.docs.world;

    const plotLayer = [
        '# TABLE RULES (settled by the player out of character; always true)', c.meta.tableRules?.length ? c.meta.tableRules.map(r => `- ${r}`).join('\n') : '(none yet)',
        '', '# PLOT (tick beats via beats_completed using their ids)', c.docs.plot || '(no plot)',
        '', '# NPCS MET', c.docs.npcs?.length ? rosterSummary(c.docs.npcs) : '(none yet)',
    ].join('\n');

    const memories = await memoryBookEntries();
    const knowledgeLines = c.meta.party.map(p => `## ${p.name}\n${c.meta.knowledge?.[p.name] || '(MISSING: write "knowledge_update" for them this turn)'}`);
    const notesLayer = [
        '# WHAT COMPANIONS KNOW (each one\'s private summary; sent with every reply they give)', knowledgeLines.join('\n\n'),
        '', '# COMPANIONS\' MINDS (their inner state, yours alone: write their briefs from it; update it with "mind_update" only when something changes it)', renderMinds(c.meta.party.map(p => p.name), c.meta.minds),
        '', '# YOUR PRIVATE NOTES', c.docs.notes ? trimToTokens(c.docs.notes, 2500, true) : '(none yet)',
        '', '# STORY SO FAR', c.docs.story ? trimToTokens(c.docs.story, 2000, true) : '(none yet)',
        '', '# MEMORY BOOK ENTRIES (from the MemoryBooks extension)', memories || '(none yet)',
    ].join('\n');

    const sections = [stateBlock()];
    const sessionMinutes = (Date.now() - (c.meta.session?.startedAt || Date.now())) / 60000;
    sections.push('', '# PACING REPORT', pacingReport(c.meta.pacing, { length: c.meta.options.length, sessionMinutes, usualSessionMinutes: Number(s.usualSessionMinutes) || 90, plot: c.docs.plot, worldEvery: Number(s.checkinEvery) || 5 }));
    for (const f of extraFiles) {
        if (f === 'rolls_log') sections.push('', '# ROLLS LOG (recent)', JSON.stringify(c.docs.rolls_log.slice(-40)));
        if (f === 'events_log') sections.push('', '# EVENTS LOG', JSON.stringify(c.docs.events_log.slice(-40)));
    }
    sections.push('', '# RECENT CHAT (oldest first)', transcript(Number(s.recentMessages) || 24) || '(empty)');
    sections.push('', '# WHY YOU ARE BEING CALLED');
    for (const r of reasons) sections.push(`- ${REASON_TEXT[r] ?? r}`);
    if (handUp) sections.push('', ESCALATE_INSTRUCTION);
    if (oocText) sections.push('', `Player's out-of-character question: ${oocText}`);
    if (c.meta.storyProblems?.length) sections.push('', `WHAT DIDN'T TAKE LAST TURN (the code dropped these):\n${c.meta.storyProblems.map(p => `- ${p}`).join('\n')}`);
    sections.push('', rulingBlock(ruling || {}));
    if (placeEvent) sections.push('', placeEvent);
    if (events.length) {
        sections.push('', 'RANDOM EVENT CANDIDATES (use one by id, "custom", or "none"):');
        for (const ev of events) sections.push(`- [${ev.id}] ${ev.title} (${ev.type}, danger ${ev.danger}/5): ${ev.seed}`);
    }
    if (playerMessage) sections.push('', `The player's latest message: ${trimToTokens(playerMessage, 800)}`);
    if (companionTask) sections.push('', `COMPANION TASK: the player told ${companionTask.name} to ${companionTask.what || 'do something'}.`);
    if (companionAction) sections.push('', `COMPANION ATTEMPT: ${companionAction.name} tried to ${companionAction.what || 'do something risky'}. Their reply: ${trimToTokens(companionAction.text, 500)}`);

    const companions = companionsHere();
    const present = (c.docs.npcs || []).filter(n => isHere(n, w.location) && !n.dead && !isBeast(n)).map(n => n.name);
    sections.push('', `Valid speakers for directions: party with the player ${JSON.stringify(companions)}; NPCs here ${JSON.stringify(present)} (or new NPCs you introduce now).`);
    const awayList = Object.entries(w.away ?? {}).map(([n, where]) => `${n} (${where})`);
    if (awayList.length) sections.push(`Companions AWAY from the player (no briefs; they can't hear or speak until they rejoin): ${awayList.join('; ')}.`);
    if (Number.isFinite(c.meta.pacing?.calmUntil) && c.meta.turn < c.meta.pacing.calmUntil) sections.push(`CALM (${c.meta.pacing.calmUntil - c.meta.turn} more turn(s)): the story breathes after what just happened. No new people, no alarm, no attack, no one arriving. Let the player search, talk, plan; answer what they do and stop.`);
    sections.push('Reply with the JSON object only.');
    return { layers: [plotLayer, notesLayer], user: sections.join('\n') };
}

/**
 * One storyteller call. Handles a single "need_files" round-trip, and a single hand-up to the main
 * model when a cheaper model handled the turn and says it's a big story moment.
 * @returns {Promise<{turn: object, dropped: string[], usd: number, raw: string, model: string, escalated: boolean}>}
 */
export async function askStoryteller(args, { label = 'storyteller', signal = null, model = '' } = {}) {
    const mainModel = resolveDmConnection().model;
    model ||= mainModel;
    const handUp = settings().handUp !== false && model !== mainModel;
    const first = await askOnce({ ...args, handUp }, { label, signal, model });
    if (!handUp || !first.turn.escalate) return { ...first, escalated: false };
    const result = await askOnce({ ...args, handUp: false }, { label: `${label} (handed up)`, signal, model: mainModel });
    return { ...result, usd: result.usd + first.usd, escalated: true };
}

async function askOnce(args, { label, signal, model }) {
    const system = await storySystem();
    let prompt = await storyPrompt(args);
    let reply = await callClaude({ system, ...prompt, model, label, signal });
    let usd = reply.usd;
    let story = parseStory(reply.text);
    if (story && story.turn.need_files.length && !args.extraFiles?.length && !story.turn.narration && !story.turn.directions.length) {
        prompt = await storyPrompt({ ...args, extraFiles: story.turn.need_files });
        reply = await callClaude({ system, ...prompt, model, label: `${label} (with files)`, signal });
        usd += reply.usd;
        story = parseStory(reply.text);
    }
    if (!story) {
        reply = await callClaude({ system, layers: prompt.layers, user: `${prompt.user}\n\nYour previous reply was not valid JSON. Reply with ONE valid JSON object only.`, model, label: `${label} (retry)`, signal });
        usd += reply.usd;
        story = parseStory(reply.text);
    }
    if (!story) {
        logCost(`${label} (unusable reply) · ${modelLabel(reply.model)}`, usd);
        throw new Error('The storyteller did not return a usable answer.');
    }
    logCost(`${label} · ${modelLabel(reply.model)}`, usd);
    return { turn: story.turn, dropped: story.dropped, usd, raw: reply.text, model: reply.model };
}
