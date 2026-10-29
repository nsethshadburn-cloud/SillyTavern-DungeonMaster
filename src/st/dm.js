// Talking to the DM (Claude): building its prompt and reading its decisions.

import { ST } from './st.js';
import { settings, SURPRISES } from './settings.js';
import { callClaude, callLocal, resolveDmConnection } from './llm.js';
import { campaign, saveDoc, saveMeta } from './campaign.js';
import { personaSheet, characterSheet, sheetMarkdown, statsForName } from './sheets.js';
import { dmType } from './messages.js';
import { dmRules, CONDENSE_NOTES_INSTRUCTIONS, RECAP_INSTRUCTIONS, ESCALATE_INSTRUCTION, RESYNC_INSTRUCTIONS, PLACE_PLAN_INSTRUCTIONS, SMALL_PLACE_INSTRUCTIONS, TOWN_PLAN_INSTRUCTIONS, PLACE_BRIEF_INSTRUCTIONS, parseDmTurn } from '../core/protocol.js';
import { placeSummary, placeView, cropText } from '../core/explore.js';
import { atlas, currentPlace, partyOnMap, loadPlace } from './atlas.js';
import { activeBoard } from './fire-turn.js';
import { fireSummary } from '../core/fire.js';
import { GRAND_KINDS } from '../core/layout.js';
import { pacingReport } from '../core/pacing.js';
import { rosterSummary, combatSummary, isAway, awareSummary } from '../core/world.js';
import { renderMapText } from '../core/grid.js';
import { estimateTokens, trimToTokens, extractJson } from '../core/text.js';
import { renderSceneCard, normalizeSceneCard, applySceneCard } from '../core/state.js';
import { modelLabel } from '../core/models.js';
import { untilWords, resourcesLine } from '../core/upkeep.js';

let stableCache = { key: '', text: '' };

/** The stable, cache-friendly part: rules + bible + character sheets. */
export async function stableSystem() {
    const c = campaign();
    const sheetsKey = JSON.stringify([
        personaSheet(c.meta.persona.avatar)?.file,
        ...c.meta.party.map(p => characterSheet(p.avatar)?.file),
    ]);
    const surprises = surprisesText();
    const key = `${c.meta.id}|${c.docs.bible.length}|${sheetsKey}|${surprises}|${settings().mapTier}`;
    if (stableCache.key === key) return stableCache.text;

    const parts = [dmRules(settings().mapTier), '', '# SURPRISES YOU MAY ADD', surprises, '', '# CAMPAIGN BIBLE', c.docs.bible || '(none yet)'];
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

/** The player's surprise toggles, as an instruction. */
function surprisesText() {
    const s = settings();
    const on = Object.entries(SURPRISES).filter(([k]) => s.surprises?.[k]).map(([, label]) => `- ${label}`);
    if (!on.length) return 'None. Do not add traps, hazards, puzzles, secret doors, hidden treasure or ambushes unless the plot requires it.';
    const freq = { rare: 'Rarely (a few times per campaign act)', occasional: 'Occasionally (now and then, when it fits the place)', often: 'Often (most new locations have something)' }[s.surpriseFrequency] || 'Occasionally';
    return `${freq}, and only where it makes sense for the place and moment, you may add:\n${on.join('\n')}\nGive the player a fair chance to notice or avoid them (Perception, Investigation, etc.).`;
}

export function resetStableCache() {
    stableCache = { key: '', text: '' };
}

/** Recent chat as plain text for the DM. */
export function transcript(maxMessages) {
    // Counts story messages only. Dice results ride along without counting, SillyTavern's own
    // system messages (its dice roller's "X rolls a d20…") and typed roll numbers are left out,
    // and a roll request is dropped once its result card exists. Otherwise a fight's dice spam
    // pushes the actual story out of the window.
    const chat = ST.chat;
    const out = [];
    const pending = campaign()?.meta.pendingRoll;
    let openRequest = -1;
    if (pending) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.dungeon_master?.request) { openRequest = i; break; }
        }
    }
    let counted = 0;
    for (let i = chat.length - 1; i >= 0 && counted < maxMessages; i--) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        const type = dmType(m);
        // The plugin's own cards are hidden (is_system) too; only skip SillyTavern's messages.
        if (m.is_system && !type) continue;
        if (type === 'note') continue;
        let text = String(m.mes).replace(/<[^>]+>/g, '').trim();
        if (!text) continue;
        if (type === 'roll') {
            if (m.extra?.dungeon_master?.request && i !== openRequest) continue;
            out.unshift(`[DICE] ${trimToTokens(text, 150)}`);
            continue;
        }
        if (m.is_user && /^\s*(nat(ural)?\s*)?\d{1,3}\b.{0,40}$/i.test(text)) continue;
        text = trimToTokens(text, 400);
        if (type === 'ooc') out.unshift(m.is_user ? `${m.name} (PLAYER, out of character): ${text}` : `[DM, out of character] ${text}`);
        else if (m.is_user) out.unshift(`${m.name} (PLAYER): ${text}`);
        else out.unshift(`${m.name}: ${text}`);
        counted++;
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
    scene_move: 'The player wants to move the scene (travel, rest, leave, time skip). Compress the uneventful part unless they are in a real conversation, then land them at the next interesting moment or the destination, and describe where they arrive.',
    combat_action: 'Combat action. Resolve the player\'s action fairly (they may name a square to move to, like "d4"; update "positions").',
    combat_round: 'Combat is ongoing. You run this round: decide what each companion and enemy does, roll for them (npc_rolls), move them ("positions"), and narrate. Companions get only a "short" brief for a quick line.',
    event: 'The dice say a random event COULD happen now. Candidates are below. First decide if any event fits this exact moment and place. Set event.use to a candidate id, to "custom" (and describe yours in event.text) for a small event that fits better, or to "none" if nothing should happen right now.',
    deadlock: 'Deadlock: the player has refused or resisted what a character wants several times in a row. That character changes approach now (bargain, a firmer push, force it with a contested roll, call for help, or let it go and move on). Brief them with the NEW approach and update "objective"; never repeat the old demand.',
    stalled: 'The scene has stalled (filler replies or going in circles). Move it forward yourself: skip ahead, arrive somewhere, or let someone or something push in.',
    drift: 'The party has been away from the plot for a while. Apply the PLOT PRESSURE stage in the pacing report, building on any pressure you set up before.',
    npc_addressed: 'The player is talking to a character who is not in the NPC list yet. Register them in new_npcs (if they exist in the scene) and give them a direction so they answer, or narrate why they can\'t.',
    companion_task: 'The player told a companion to do something whose result isn\'t known yet (COMPANION TASK below). The companion does it now (the code already walks them to where they have to go on the map). Rule on it: roll for them in npc_rolls if it needs a roll (Investigation to search something, Perception to look or listen, Stealth, Sleight of Hand, Thieves\' Tools...), decide what they actually find or what happens, and brief them with that result so they tell the player in their own words. Never let them find something you haven\'t decided is there.',
    companion_action: 'A companion just attempted something risky in their own reply (below). Rule on it like a player\'s action: roll for them in npc_rolls against a DC or the right opponent (for example the player\'s passive Perception), narrate what actually happens, and brief them only if they need to react. If it truly needs no roll, just narrate the result.',
    solo: 'No companion or NPC is with the player right now, or nobody nearby would answer. Respond as the world: what they notice, what happens, who shows up. Keep it short if nothing much happens. Absent companions stay silent.',
    checkin: 'The world moves on: a few turns have passed since it last acted. Advance it one clear step: NPCs who are here act on their own jobs and agendas, anything underway (intake, a march, a search, a deal) takes its next step, time passes, something new shows up or is learned. Usually that happens through briefs to the NPCs and companions, with narration only if something new arrives, a place changes or time skips. If the player is mid-conversation, weave this around them without cutting the conversation off; they can keep talking while it happens. But if they just set something up ("I have a question…", "there\'s something I need to tell you"), the world waits: brief the listener only. Then set world_next (at least 2 after a setup).',
    opening: 'Open the campaign.',
    manual: 'The player asked the DM to step in.',
    explore: 'The party is exploring a mapped place and something happened as they moved (PLACE EVENT below). Rule on it: ask for a roll if one is needed (a save against a sprung trap, Stealth to stay unseen), narrate briefly, brief companions or NPCs, and record changes with place_changes.',
};

/**
 * Build the per-call part of a DM prompt, split by how often each piece changes so Claude's
 * prompt cache can reuse the slow parts (see callClaude):
 *   layers[0] = plot and NPCs met (changes when a beat is ticked or someone new shows up)
 *   layers[1] = notes, story so far, memories (changes when the DM adds notes or story)
 *   user      = everything that changes every call
 * Both layers are always sent, even when empty, so the cache positions stay the same.
 * @param {{reasons:string[], playerMessage?:string, rollResolution?:string, events?:object[], extraFiles?:string[], oocText?:string, handUp?:boolean}} p
 *  handUp = this model may hand the turn to the main DM model
 * @returns {Promise<{layers:string[], user:string}>}
 */
export async function volatilePrompt({ reasons, playerMessage = '', rollResolution = '', events = [], extraFiles = [], oocText = '', handUp = false, companionAction = null, companionTask = null, placeEvent = '', target = null }) {
    const c = campaign();
    const s = settings();
    const w = c.docs.world;

    const here = currentPlace(c);
    // A building is two maps: whichever side the party is on, the DM also knows the other (its rooms and secrets).
    let otherSide = '';
    if (here?.place.kind === 'grounds') {
        const inside = await Promise.all(Object.values(here.place.buildings).filter(b => b.interior).map(b => loadPlace(b.interior, c)));
        otherSide = inside.filter(Boolean).map(p => `(INSIDE, through the front door; the party is outside now)\n${placeSummary(p)}`).join('\n\n');
    } else if (here?.place.parent) {
        const out = await loadPlace(here.place.parent.key, c);
        if (out?.kind === 'grounds') otherSide = `(OUTSIDE, through the front door: the grounds; the party is inside now)\n${placeSummary(out)}`;
    }
    const plotLayer = [
        '# TABLE RULES (settled by the player out of character; always true)', c.meta.tableRules?.length ? c.meta.tableRules.map(r => `- ${r}`).join('\n') : '(none yet)',
        '', '# PLOT (tick beats via beats_completed using their ids)', c.docs.plot || '(no plot)',
        '', '# NPCS MET', c.docs.npcs?.length ? rosterSummary(c.docs.npcs) : '(none yet)',
        '', '# ATLAS (maps already built and kept; never build these again, send the party back with "enter_place")', Object.values(atlas(c).places).filter(e => !e.parent).map(e => `- ${e.name} (${e.kind}${e.size ? `, ${e.size}` : ''})`).join('\n') || '(none yet)',
        ...(here ? ['', placeSummary(here.place)] : []),
        ...(otherSide ? ['', otherSide] : []),
    ].join('\n');

    const memories = await memoryBookEntries();
    const knowledgeLines = c.meta.party.map(p => `## ${p.name}\n${c.meta.knowledge?.[p.name] || '(MISSING: write "knowledge_update" for them this turn)'}`);
    const notesLayer = [
        '# WHAT COMPANIONS KNOW (each one\'s private summary; sent with every reply they give)', knowledgeLines.join('\n\n'),
        '', '# YOUR PRIVATE NOTES', c.docs.notes ? trimToTokens(c.docs.notes, 2500, true) : '(none yet)',
        '', '# STORY SO FAR', c.docs.story ? trimToTokens(c.docs.story, 2000, true) : '(none yet)',
        '', '# MEMORY BOOK ENTRIES (from the MemoryBooks extension)', memories || '(none yet)',
    ].join('\n');

    const sections = [];
    const sessionMinutes = (Date.now() - (c.meta.session?.startedAt || Date.now())) / 60000;

    sections.push('# WHERE THINGS STAND');
    sections.push(`Location: ${w.location || 'unknown'} (${w.setting || 'any'}), time: ${w.time || '?'}, day ${w.day ?? 1}.`);
    const lasts = (n, cond) => untilWords(w, n, cond, { turn: c.meta.turn, round: w.combat?.round ?? null });
    sections.push(`Party HP: ${Object.entries(w.party).map(([n, p]) => `${n} ${p.hp}/${p.hp_max}${p.conditions?.length ? ` [${p.conditions.map(x => (lasts(n, x) ? `${x}, ${lasts(n, x)}` : x)).join('; ')}]` : ''}${p.hp <= 0 && p.death ? ` DYING: ${p.death.s} death-save successes, ${p.death.f} failures (the code rolls them)` : ''}`).join('; ') || 'unknown'}.`);
    const resources = [c.meta.persona.name, ...c.meta.party.map(p => p.name)].map(n => { const line = resourcesLine(w, n, statsForName(n, c.meta)); return line ? `${n}: ${line}` : ''; }).filter(Boolean);
    if (resources.length) sections.push(`Resources (tracked by the code): ${resources.join(' | ')}.`);
    const held = Object.entries(w.others || {}).filter(([, o]) => o.conditions?.length);
    if (held.length) sections.push(`Others' conditions: ${held.map(([n, o]) => `${n} [${o.conditions.join(', ')}]`).join('; ')}.`);
    const carried = Object.entries(w.inventory || {}).filter(([, l]) => l.length).map(([n, l]) => `${n}: ${l.join(', ')}`);
    sections.push(`Gold: ${w.gold ?? 0}. Shared pack: ${w.items?.length ? w.items.join(', ') : 'nothing noted'}.${carried.length ? ` Carried: ${carried.join('; ')}.` : ''}`);
    if (Object.keys(w.flags || {}).length) sections.push(`Flags: ${JSON.stringify(w.flags)}`);
    sections.push(combatSummary(w, c.meta.persona.name));
    const aware = awareSummary(w);
    if (aware) sections.push(`AWARE (who has noticed whom; decided by rolls, keep to it): ${aware}`);
    if (w.combat?.map && w.combat.inPlace && here) {
        // A fight inside a big place: only the area around the party, in the floor's own squares.
        const lead = Object.values(w.combat.positions || {}).map(cd => /^([a-z]{1,2})(\d+)$/.exec(cd)).filter(Boolean)[0];
        const pos = Object.fromEntries(Object.entries(w.combat.positions || {}).map(([n, cd]) => { const m = /^([a-z]{1,2})(\d+)$/.exec(cd); if (!m) return [n, null]; const col = m[1].length === 1 ? m[1].charCodeAt(0) - 97 : (m[1].charCodeAt(0) - 96) * 26 + m[1].charCodeAt(1) - 97; return [n, { floor: w.combat.inPlace.floor, x: col, y: Number(m[2]) - 1 }]; }));
        const pts = Object.values(pos).filter(Boolean);
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        if (lead && pts.length) sections.push('Battle area (the floor\'s own squares; columns a.., rows 1.. from the bottom):', cropText(here.place, w.combat.inPlace.floor, { x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, w: Math.max(...xs) - Math.min(...xs) + 7, h: Math.max(...ys) - Math.min(...ys) + 7 }, pos));
    } else if (w.combat?.map) sections.push('Battle map (columns a.., rows 1.. from the bottom):', renderMapText(w.combat.map, w.combat.positions || {}));
    else if (here) sections.push(`# INSIDE ${here.place.name.toUpperCase()}`, placeView(here.place, partyOnMap(c)));
    else if (w.sceneMap?.map) sections.push(`Scene map "${w.sceneMap.title}" (columns a.., rows 1.. from the bottom; send "scene_map": "close" when they leave):`, renderMapText(w.sceneMap.map, w.sceneMap.positions || {}));
    // Fire, spell effects and the air on the map in play.
    const board = activeBoard(c);
    const burning = board ? fireSummary(board.map, board.nameAt) : '';
    if (burning) sections.push(burning);
    sections.push(`Last standing_direction (what companions currently know): ${c.meta.standing || '(none)'}`);
    sections.push('SCENE CARD (what companions and NPCs are told is physically true right now; send "scene_card" changes to fix or update it):', renderSceneCard(w.sceneCard) || '(empty: send a full "scene_card" this turn)');
    sections.push(`Party's current objective (shown to companions): ${c.meta.objective || '(none set: set "objective")'}`);

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
    if (rollResolution) sections.push('', `ROLL RESULT: ${rollResolution}`);
    if (placeEvent) sections.push('', `PLACE EVENT: ${placeEvent}`);
    if (events.length) {
        sections.push('', 'RANDOM EVENT CANDIDATES (use one by id, "custom", or "none"):');
        for (const ev of events) sections.push(`- [${ev.id}] ${ev.title} (${ev.type}, danger ${ev.danger}/5): ${ev.seed}`);
    }
    if (playerMessage) sections.push('', `The player's latest message: ${trimToTokens(playerMessage, 800)}`);
    if (companionTask) sections.push('', `COMPANION TASK: the player told ${companionTask.name} to ${companionTask.what || 'do something'}${companionTask.went ? ` (they're now at ${companionTask.went} on the map)` : ''}.`);
    if (target) sections.push('', `TARGET: ${target.actor} acts on ${target.line}, ${target.where}${target.reached ? `; ${target.actor} is standing right beside it now` : ''}. It's that one exactly (picked on the map), not another ${target.name}: any place_changes for it use ${target.kind === 'person' ? 'that name' : `the id ${target.id}`}.`);
    if (companionAction) sections.push('', `COMPANION ATTEMPT TO RULE ON: ${companionAction.name} tries to ${companionAction.what || 'do something risky'}. Their reply: ${trimToTokens(companionAction.text, 500)}`);

    const companions = c.meta.party.map(p => p.name).filter(n => !isAway(w, n));
    const awayList = Object.entries(w.away ?? {}).map(([n, where]) => `${n} (${where})`);
    const present = (c.docs.npcs || []).filter(n => n.lastSeen && n.lastSeen === w.location).map(n => n.name);
    sections.push('', `Valid speakers for directions: party with the player ${JSON.stringify(companions)}; NPCs here ${JSON.stringify(present)} (or new NPCs you introduce now).`);
    if (awayList.length) sections.push(`Companions AWAY from the player (no briefs; they can't hear or speak until "party_back"): ${awayList.join('; ')}.`);
    sections.push('Reply with the JSON object only.');
    return { layers: [plotLayer, notesLayer], user: sections.join('\n') };
}

/**
 * Run one DM call. Handles a single "need_files" round-trip, and a single hand-up to the main DM
 * model when a different model handled the turn and says it's a big story moment.
 * @param {string} model the model for this turn (settings modelFor)
 * @returns {Promise<{turn: ReturnType<typeof parseDmTurn>, usd: number, raw: string, model: string, escalated: boolean}>}
 */
export async function askDm(args, { label = 'DM turn', signal = null, model = '' } = {}) {
    const mainModel = resolveDmConnection().model;
    model ||= mainModel;
    const handUp = settings().handUp !== false && model !== mainModel;
    const first = await askDmOnce({ ...args, handUp }, { label, signal, model });
    if (!handUp || !first.turn.escalate) return { ...first, escalated: false };
    const result = await askDmOnce({ ...args, handUp: false }, { label: `${label} (handed up)`, signal, model: mainModel });
    return { ...result, usd: result.usd + first.usd, escalated: true };
}

async function askDmOnce(args, { label, signal, model }) {
    const system = await stableSystem();
    let prompt = await volatilePrompt(args);
    let reply = await callClaude({ system, ...prompt, model, label, signal });
    let usd = reply.usd;
    let turn = parseDmTurn(reply.text);
    if (turn && turn.need_files.length && !args.extraFiles?.length && !turn.narration && !turn.directions.length) {
        prompt = await volatilePrompt({ ...args, extraFiles: turn.need_files });
        reply = await callClaude({ system, ...prompt, model, label: `${label} (with files)`, signal });
        usd += reply.usd;
        turn = parseDmTurn(reply.text);
    }
    if (!turn) {
        // One retry asking for valid JSON.
        reply = await callClaude({ system, layers: prompt.layers, user: `${prompt.user}\n\nYour previous reply was not valid JSON. Reply with ONE valid JSON object only.`, model, label: `${label} (retry)`, signal });
        usd += reply.usd;
        turn = parseDmTurn(reply.text);
    }
    if (!turn) {
        logCost(`${label} (unusable reply) · ${modelLabel(reply.model)}`, usd);
        throw new Error('The DM did not return a usable answer.');
    }
    logCost(`${label} · ${modelLabel(reply.model)}`, usd);
    return { turn, usd, raw: reply.text, model: reply.model };
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

/**
 * Ask Claude for a place's full plan (every room of a big site, or a town's buildings).
 * @param {{name:string, size:string, kind:string, why?:string, town?:boolean}} req
 */
export async function askPlacePlan(req, { signal = null } = {}) {
    const c = campaign();
    const big = req.size === 'big';
    // A mansion or castle is never a handful of rooms, even as a "small" map: it gets the full rules.
    const grand = !big && GRAND_KINDS.test(`${req.kind} ${req.name}`.toLowerCase());
    const rooms = big ? (/castle|palace|fortress|dungeon|prison|asylum/.test(req.kind) ? 40 : /mansion|manor|estate|temple|tower|mine|crypt|catacomb/.test(req.kind) ? 34 : 26) : grand ? 12 : 6;
    const user = [
        '# PLOT', c.docs.plot || '(none)',
        '', '# YOUR PRIVATE NOTES', c.docs.notes ? trimToTokens(c.docs.notes, 2500, true) : '(none)',
        '', '# STORY SO FAR', c.docs.story ? trimToTokens(c.docs.story, 2000, true) : '(none)',
        '', '# NPCS MET', c.docs.npcs?.length ? rosterSummary(c.docs.npcs) : '(none yet)',
        '', '# TABLE RULES', c.meta.tableRules?.length ? c.meta.tableRules.map(r => `- ${r}`).join('\n') : '(none)',
        '', '# RECENT CHAT (oldest first)', transcript(30) || '(empty)',
        '', '# WHERE THE PARTY IS RIGHT NOW (the scene card)', renderSceneCard(c.docs.world.sceneCard) || '(not set)',
        '', '# BUILD THIS PLACE',
        `Name: ${req.name}\nKind: ${req.kind || 'unspecified'}\nWhy it's needed: ${req.why || 'the story is going there'}${req.start ? `\nThe party starts: ${req.start}` : ''}${req.town ? '' : `\nAbout ${rooms} rooms${big ? '' : ' at most'}.`}`,
        '', req.town ? TOWN_PLAN_INSTRUCTIONS : big || grand ? PLACE_PLAN_INSTRUCTIONS : SMALL_PLACE_INSTRUCTIONS,
    ].join('\n');
    const reply = await callClaude({ system: await stableSystem(), user, task: 'build_place', label: `planning ${req.name}`, maxTokens: big ? 20000 : grand ? 12000 : 6000, signal });
    logCost(`planning ${req.name} · ${modelLabel(reply.model)}`, reply.usd);
    const json = extractJson(reply.text);
    if (!json) throw new Error('Claude did not return a usable plan. Ask the DM to try again.');
    return json;
}

/**
 * Ask for a place's BRIEF (a few lines: what it is, how big, where the party starts, the story's
 * rooms, people, locks and secrets); the architect (core/architect.js) builds the rest by algorithm.
 * The local helper writes it when there is one (free), else Haiku (a fraction of a cent).
 * Returns the parsed JSON, or {} when the reply was unusable (the request alone still builds a place).
 */
export async function askPlaceBrief(req, { signal = null } = {}) {
    const c = campaign();
    const s = settings();
    const local = (s.mapBrief ?? 'local') === 'local' && s.useHelper;
    const context = [
        '# THE STORY', c.docs.story ? trimToTokens(c.docs.story, local ? 600 : 1200, true) : c.docs.bible ? `(just begun) The campaign: ${trimToTokens(c.docs.bible, local ? 500 : 1000, true)}` : '(just begun)',
        req.context ? `\n# AT THE START\n${trimToTokens(req.context, 400, true)}` : '',
        '', '# DM NOTES (secrets)', c.docs.notes ? trimToTokens(c.docs.notes, local ? 500 : 1500, true) : '(none)',
        '', '# PEOPLE MET', c.docs.npcs?.length ? trimToTokens(rosterSummary(c.docs.npcs), local ? 300 : 800, true) : '(none yet)',
        '', '# RECENT CHAT (oldest first)', transcript(local ? 8 : 16) || '(empty)',
        '', '# WHERE THE PARTY IS RIGHT NOW', renderSceneCard(c.docs.world.sceneCard) || '(not set)',
        '', '# THE PLACE TO BUILD', `Name: ${req.name}\nKind: ${req.kind || 'unspecified'}\nSize asked: ${req.size || 'small'}\nWhy: ${req.why || 'the story is going there'}${req.start ? `\nThe party starts: ${req.start}` : ''}${req.objective ? `\nWhat they're there for: ${req.objective}` : ''}`,
        '', PLACE_BRIEF_INSTRUCTIONS,
    ].join('\n');
    if (local) {
        const raw = await callLocal({ system: 'You plan places for a tabletop roleplaying game. Reply with ONE JSON object and nothing else.', messages: [{ role: 'user', content: context }], maxTokens: 700, profileId: s.helperProfileId });
        return extractJson(raw) ?? {};
    }
    const reply = await callClaude({ system: 'You plan places for a tabletop roleplaying game. Reply with ONE JSON object and nothing else.', user: context, task: 'map_brief', label: `brief for ${req.name}`, maxTokens: 900, signal });
    logCost(`brief for ${req.name} · ${modelLabel(reply.model)}`, reply.usd);
    return extractJson(reply.text) ?? {};
}

/** Keep the DM's notes compact (one cheap call when they get long). */
export async function maybeCondenseNotes() {
    const c = campaign();
    if (!c || estimateTokens(c.docs.notes) < 3000) return 0;
    const system = await stableSystem();
    const reply = await callClaude({ system, user: `# CURRENT NOTES\n${c.docs.notes}\n\n${CONDENSE_NOTES_INSTRUCTIONS}`, task: 'condense_notes', label: 'condense notes', maxTokens: 4000 });
    const json = extractJson(reply.text);
    if (json?.notes) {
        c.docs.notes = String(json.notes);
        saveDoc('notes');
    }
    logCost('condense notes', reply.usd);
    return reply.usd;
}

/**
 * Fix a mismatch after the player edited or deleted messages: Claude re-reads the chat as it is
 * now and corrects the logged state (world, plot ticks, notes, story, NPCs met, knowledge).
 * @returns {Promise<{summary: string, usd: number}>}
 */
export async function resyncWithChat() {
    const c = campaign();
    if (!c) throw new Error('No campaign in this chat.');
    const w = c.docs.world;
    const logged = {
        world: { location: w.location, time: w.time, day: w.day, gold: w.gold, items: w.items, party: w.party, flags: w.flags, away: w.away ?? {}, in_combat: Boolean(w.combat) },
        standing_direction: c.meta.standing,
        objective: c.meta.objective,
        knowledge: c.meta.knowledge ?? {},
        scene_card: w.sceneCard ?? {},
        timeline: c.meta.timeline ?? [],
        npcs_met: (c.docs.npcs || []).map(n => `${n.name} (${n.attitude}${n.lastSeen ? `, last seen: ${n.lastSeen}` : ''})`),
        pending_roll: c.meta.pendingRoll ? `${c.meta.pendingRoll.skill}: ${c.meta.pendingRoll.reason || ''}` : 'none',
    };
    const user = [
        '# LOGGED STATE', JSON.stringify(logged, null, 1),
        '', '# PLOT', c.docs.plot || '(none)',
        '', '# YOUR NOTES', c.docs.notes || '(none)',
        '', '# STORY SO FAR', c.docs.story || '(none)',
        '', '# THE CHAT AS IT IS NOW (oldest first)', transcript(80) || '(empty)',
        '', RESYNC_INSTRUCTIONS,
    ].join('\n');
    const reply = await callClaude({ system: await stableSystem(), user, task: 'resync', label: 'resync with chat', maxTokens: 8000 });
    logCost('resync with chat', reply.usd);
    const json = extractJson(reply.text);
    if (!json) throw new Error('Claude did not return a usable answer. Try again.');
    applyResync(c, json);
    return { summary: String(json.summary || 'Done.'), usd: reply.usd };
}

function applyResync(c, j) {
    const w = c.docs.world;
    if (j.world && typeof j.world === 'object') {
        for (const key of ['location', 'time']) if (typeof j.world[key] === 'string' && j.world[key]) w[key] = j.world[key];
        for (const key of ['day', 'gold']) if (Number.isFinite(Number(j.world[key]))) w[key] = Number(j.world[key]);
        if (Array.isArray(j.world.items)) w.items = j.world.items.map(String);
        if (j.world.flags && typeof j.world.flags === 'object') w.flags = j.world.flags;
        if (j.world.away && typeof j.world.away === 'object') w.away = Object.fromEntries(Object.entries(j.world.away).map(([k, v]) => [k, String(v)]));
        if (j.world.party && typeof j.world.party === 'object') {
            for (const [name, p] of Object.entries(j.world.party)) {
                const key = Object.keys(w.party).find(k => k.toLowerCase() === name.toLowerCase());
                if (!key || !p || typeof p !== 'object') continue;
                if (Number.isFinite(Number(p.hp_max))) w.party[key].hp_max = Number(p.hp_max);
                if (Number.isFinite(Number(p.hp))) w.party[key].hp = Math.max(0, Math.min(Number(p.hp), w.party[key].hp_max || Number(p.hp)));
                if (Array.isArray(p.conditions)) w.party[key].conditions = p.conditions.map(String);
            }
        }
    }
    if (j.combat === 'end' && w.combat) {
        w.combat = null;
        c.meta.pacing.inCombat = false;
    }
    if (Array.isArray(j.plot_done) && c.docs.plot) {
        const done = new Set(j.plot_done.map(String));
        c.docs.plot = c.docs.plot.replace(/^(\s*[-*]\s*)\[(?:x|X| )\](\s*)(A\d+\.\d+)/gm, (m, a, b, id) => `${a}[${done.has(id) ? 'x' : ' '}]${b}${id}`);
    }
    if (typeof j.notes === 'string') c.docs.notes = j.notes;
    if (typeof j.story === 'string') c.docs.story = j.story;
    if (typeof j.standing_direction === 'string' && j.standing_direction) c.meta.standing = j.standing_direction;
    if (typeof j.objective === 'string' && j.objective) c.meta.objective = j.objective;
    const card = normalizeSceneCard(j.scene_card);
    if (card) w.sceneCard = applySceneCard(null, card);
    if (Array.isArray(j.timeline)) {
        c.meta.timeline = j.timeline.filter(e => e && e.text).slice(-8).map(e => ({ day: Number(e.day) || 1, time: String(e.time || ''), place: String(e.place || ''), text: String(e.text) }));
    }
    if (j.knowledge && typeof j.knowledge === 'object') {
        c.meta.knowledge ??= {};
        for (const p of c.meta.party) {
            const text = Object.entries(j.knowledge).find(([k]) => k.toLowerCase() === p.name.toLowerCase())?.[1];
            if (text) c.meta.knowledge[p.name] = String(text);
        }
    }
    if (Array.isArray(j.npcs_forget) && j.npcs_forget.length) {
        const forget = new Set(j.npcs_forget.map(n => String(n).toLowerCase()));
        c.docs.npcs = (c.docs.npcs || []).filter(n => !forget.has(n.name.toLowerCase()));
    }
    if (j.pending_roll === 'clear') c.meta.pendingRoll = null;
    for (const key of ['world', 'plot', 'notes', 'story', 'npcs']) saveDoc(key);
    saveMeta();
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
    const reply = await callClaude({ system, user, task: 'recap', label: 'recap', maxTokens: 2000 });
    logCost('recap', reply.usd);
    const json = extractJson(reply.text);
    return { text: String(json?.recap ?? reply.text), usd: reply.usd };
}
