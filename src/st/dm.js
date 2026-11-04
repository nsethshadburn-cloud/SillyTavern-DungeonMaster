// What the referee and the storyteller share: the story's stable prompt (rules, bible, sheets), the
// state block (WHERE THINGS STAND), the recent chat, the memory book, the cost log; and the one-off
// jobs on the story (condensing notes, resync after edits, the recap).

import { ST } from './st.js';
import { settings, SURPRISES } from './settings.js';
import { callClaude } from './llm.js';
import { campaign, saveDoc, saveMeta } from './campaign.js';
import { personaSheet, characterSheet, sheetMarkdown, statsForName } from './sheets.js';
import { dmType } from './messages.js';
import { storyRules, CONDENSE_NOTES_INSTRUCTIONS, RECAP_INSTRUCTIONS, RESYNC_INSTRUCTIONS } from '../core/protocol.js';
import { combatSummary, isAway, awareSummary } from '../core/world.js';
import { renderMapText } from '../core/grid.js';
import { estimateTokens, trimToTokens, extractJson } from '../core/text.js';
import { ensureClock, clockText, WEATHER_WORDS } from '../core/clock.js';
import { renderSceneCard, normalizeSceneCard, applySceneCard } from '../core/state.js';
import { untilWords, resourcesLine } from '../core/upkeep.js';
import { mergeMind, normalizeMind } from '../core/minds.js';

let stableCache = { key: '', text: '' };

/** The storyteller's stable, cache-friendly part: its rules + bible + character sheets. */
export async function storySystem() {
    const c = campaign();
    const sheetsKey = JSON.stringify([
        personaSheet(c.meta.persona.avatar)?.file,
        ...c.meta.party.map(p => characterSheet(p.avatar)?.file),
    ]);
    const surprises = surprisesText();
    const key = `${c.meta.id}|${c.docs.bible.length}|${sheetsKey}|${surprises}|${settings().mapTier}`;
    if (stableCache.key === key) return stableCache.text;

    const parts = [storyRules(settings().mapTier), '', '# SURPRISES YOU MAY ADD (the referee rules on them; you place them)', surprises, '', '# CAMPAIGN BIBLE', c.docs.bible || '(none yet)'];
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

/**
 * Each party member's numbers in one line, for the referee: AC, HP, speed, the skills and tools with
 * a bonus, attacks with dice, initiative. Cheap, and all a ruling needs.
 */
export function statsLines() {
    const c = campaign();
    const lines = [];
    for (const name of [c.meta.persona.name, ...c.meta.party.map(p => p.name)]) {
        const s = statsForName(name, c.meta);
        if (!s) { lines.push(`${name}: no sheet (treat as a level 1 commoner: AC 10, +2 on anything)`); continue; }
        const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
        const sign = v => `${num(v) >= 0 ? '+' : ''}${num(v)}`;
        const skills = Object.entries(s.skills || {}).filter(([, v]) => num(v) !== 0).map(([k, v]) => `${k} ${sign(v)}`);
        const tools = Object.entries(s.tools || {}).map(([k, v]) => `${k} ${sign(v)}`);
        const saves = Object.entries(s.saves || {}).filter(([, v]) => num(v) !== 0).map(([k, v]) => `${k} save ${sign(v)}`);
        const attacks = (s.attacks || []).filter(a => a?.name).map(a => `${a.name} ${sign(a.to_hit)} (${a.damage || '1d4'}${a.range ? `, ${a.range}` : ''})`);
        const passive = 10 + num(s.skills?.Perception);
        lines.push(`${name}${s.class ? ` (${s.class}${s.level ? ` ${s.level}` : ''})` : ''}: AC ${num(s.ac) || 10}, HP max ${num(s.hp_max) || '?'}, speed ${num(s.speed) || 30} ft, initiative ${sign(s.initiative)}, passive Perception ${passive}${skills.length ? `; skills ${skills.join(', ')}` : ''}${tools.length ? `; tools ${tools.join(', ')}` : ''}${saves.length ? `; ${saves.join(', ')}` : ''}${attacks.length ? `; attacks: ${attacks.join(', ')}` : ''}`);
    }
    return lines.join('\n');
}

/** Recent chat as plain text for the table. */
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
export async function memoryBookEntries(max = 4) {
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

/**
 * WHERE THINGS STAND: the state both the referee and the storyteller read. The clock and weather,
 * party HP with conditions and what's left of them, resources, others' conditions, gold and packs,
 * flags, the fight (and the battle map), who has noticed whom, the scene card and spots, the objective.
 * @param {{forReferee?: boolean}} [o] the referee gets the squares and the numbers; the storyteller the words
 */
export function stateBlock({ forReferee = false } = {}) {
    const c = campaign();
    const s = settings();
    const w = c.docs.world;
    const sections = ['# WHERE THINGS STAND'];
    ensureClock(w);
    sections.push(`Location: ${w.location || 'unknown'} (${w.setting || 'any'}). Clock: ${clockText(w)}. Weather: ${WEATHER_WORDS[w.weather] ?? w.weather}.${forReferee ? ` (The code keeps both: time passes about ${Number(s.minutesPerTurn) || 10} minutes a turn and the weather drifts; skip ahead with "clock", turn the weather with "weather".)` : ' (The code keeps both; narrate the time of day and the weather you are given, never another.)'}`);
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
    if (w.combat?.enemies && Object.keys(w.combat.enemies).length) sections.push(`Enemies: ${Object.entries(w.combat.enemies).map(([n, e]) => `${n} HP ${e.hp}/${e.hp_max ?? e.hp}, AC ${e.ac}${e.damage ? `, ${e.damage}` : ''}${e.conditions?.length ? ` [${e.conditions.join(', ')}]` : ''}${e.hp <= 0 ? ' (dead)' : ''}`).join('; ')}.`);
    const aware = awareSummary(w);
    if (aware) sections.push(`AWARE (who has noticed whom; decided by rolls, keep to it): ${aware}`);
    if (w.combat?.map && forReferee) sections.push(`Battle map${w.combat.onSketch ? ' (the sketch of the scene: the party fights where it stood)' : ''} (columns a.., rows 1.. from the bottom):`, renderMapText(w.combat.map, w.combat.positions || {}));
    else if (w.combat?.positions) sections.push(`Where everyone stands (squares, for your eyes only; say it in words): ${Object.entries(w.combat.positions).map(([n, sq]) => `${n} ${sq}`).join(', ')}.`);
    sections.push(`Last standing_direction (what companions currently know): ${c.meta.standing || '(none)'}`);
    sections.push(`SCENE CARD (what companions and NPCs are told is physically true right now, and what the sketch is drawn from${forReferee ? '; send "scene" changes to fix or update it' : ''}):`, renderSceneCard(w.sceneCard) || (forReferee ? '(empty: send a full "scene" this turn)' : '(empty)'));
    const spots = Object.entries(w.sceneCard?.spots || {}).filter(([, z]) => z);
    if (spots.length) sections.push(`Spots (where each one stands, relative to ${c.meta.persona.name}): ${spots.map(([n, z]) => `${n}: ${z}`).join('; ')}.`);
    const awayList = Object.entries(w.away ?? {}).map(([n, where]) => `${n} (${where})`);
    if (awayList.length) sections.push(`Companions AWAY from the player: ${awayList.join('; ')}.`);
    sections.push(`Party's current objective (shown to companions): ${c.meta.objective || '(none set)'}`);
    return sections.join('\n');
}

/** Companions with the player (not away). */
export function companionsHere() {
    const c = campaign();
    return c.meta.party.map(p => p.name).filter(n => !isAway(c.docs.world, n));
}

export function logCost(label, usd) {
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
    const system = await storySystem();
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
        minds: c.meta.minds ?? {},
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
    const reply = await callClaude({ system: await storySystem(), user, task: 'resync', label: 'resync with chat', maxTokens: 8000 });
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
    if (j.minds && typeof j.minds === 'object') {
        c.meta.minds ??= {};
        for (const p of c.meta.party) {
            const update = normalizeMind(Object.entries(j.minds).find(([k]) => k.toLowerCase() === p.name.toLowerCase())?.[1]);
            if (update) c.meta.minds[p.name] = mergeMind(c.meta.minds[p.name], update);
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
    const system = await storySystem();
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
