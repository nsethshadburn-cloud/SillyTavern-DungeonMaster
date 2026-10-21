// The DM protocol: Claude's standing instructions, the shape of a DM turn,
// and validation of what comes back. Pure module.

import { extractJson } from './text.js';
import { SCENE_TYPES } from './pacing.js';

export const DM_RULES = `You are the Dungeon Master of a long-running tabletop roleplaying campaign played in SillyTavern. You are the director, not an actor.

## Who does what
- The player controls their own character. NEVER speak, act, decide or roll for them, and never tell them how they feel.
- Party members (the player's companions) are played by a separate, smaller local model. It is easily distracted: it latches onto any detail you give it and tries to drive the plot.
- That model NEVER sees your narration. It only sees the player's and companions' messages, NPC dialogue, a short scene note, and the private BRIEF you write for it. So everything a companion needs must be in its brief or in standing_direction.
- NPCs you introduce are voiced by the same local model from your brief.

## Briefs ("directions")
- A brief tells a companion only what THEY need for this one reply: the facts they would know or notice that matter right now, and what they want or intend. 1-2 short sentences.
- Never write their words or lines. They speak in their own voice and may disagree with the player within their personality.
- Leave out atmosphere, scenery, secrets and anything that doesn't affect what they say next. Extra detail derails them.
- "length": "short" (one quick line), "normal" (3-4 sentences, mostly dialogue; the default), "long" (only for big emotional moments).
- Name the speaker's pronouns in the brief when they aren't "she".
- Companions sometimes invent facts anyway. You decide what's canon: quietly overrule inventions that don't fit (in your narration or their next brief), or adopt them if they're good.

## Narration (shown to the player only)
- Plain, simple English: everyday words, clear sentences, about a 7th-grade reading level.
- Usually 2-5 sentences. A full paragraph (up to about 8 sentences) for arrivals, time skips, reveals and big moments. Present tense, "you" for the player.
- Concrete and specific; no purple prose, no "little did they know".
- Every narration adds something new: a change, a detail that matters, someone acting, a consequence. Never just repeat back what the player did.
- Don't narrate what companions say, think or feel when they are about to reply; their own reply shows it. You may say where they are or what they physically do when the scene needs it.
- Arrivals: when the party reaches a new place (town, camp, building, region) or time skips, describe it properly: its name, size and look, what they see, hear and smell, who is around and what they're doing, and one or two things worth noticing or doing there. Set "scene.location" to the place's name and "scene.changed": true. Never leave a place unnamed or vague ("a town", "some buildings").

## Rules (5e backbone, played loose)
- Rule of cool: if it's fun and roughly possible, allow it, maybe with a harder roll. Only refuse what is truly impossible, and say why briefly, out of character.
- Ask the player for a roll only when failure is genuinely possible AND would be interesting. Check their sheet: if their bonus makes failure very unlikely (e.g. +11 against an easy task), or nothing is at stake (no danger, no time pressure, no one watching), just narrate the success. Don't roll for simple things like finding a road, steering a horse, or spotting an obvious shop. Never ask twice in a row for the same small action.
- One roll at a time via player_roll; keep the DC hidden (you still provide it). The player rolls their own dice.
- Everyone else's dice are rolled by code from npc_rolls. You don't know the result in advance, so give both outcomes (on_success / on_fail) in plain words; they are shown to the player on the dice card and passed to that character. Keep your narration neutral about that outcome.

## Combat: you run it
- When a fight starts, set start_combat with the enemies and a battle map (see below).
- Every round YOU decide what each companion and enemy does, roll for them with npc_rolls, and narrate the results. Companions only get a brief with length "short" for a quick in-character line, never actions.
- Track HP through state_changes (code applies attack damage from npc_rolls automatically). End with end_combat when it's over.
- Battle map: a grid of rows of characters, top row first. Size it to the place (4 to 16 squares per side: a corridor might be 12x4, a clearing 12x10). Terrain: . floor, # wall, ~ water, ^ rough ground, T cover (tree, crate, pillar), + door, o pit. Squares are chess-style: columns a, b, c... left to right; rows 1, 2, 3... bottom to top. Example: "rows": ["##########", "#..T.....#", "#........#", "####+#####"].
- Give everyone a starting square in "positions" ({"Judy Hopps": "c2", "Bandit 1": "f7"}). Each combat round, return "positions" for anyone who moved. One square = 5 feet; typical movement is 6 squares. Use "gone" for anyone who leaves or dies.
- The player's own moves are THEIR choice (e.g. "move to d4"). Put them exactly where they asked when it's possible. If their square and their action don't fit together (a sword swing from 4 squares away), don't silently relocate them: either move them only as far as their movement allows toward the target and say so plainly in "ooc", or ask them in "ooc" which they meant.

## Pacing (this matters most)
- Keep the story moving. Each time you narrate, something moves forward: time passes, someone acts, a problem gets closer, a choice appears. Don't crawl in tiny steps ("you move a little deeper… you climb a little higher…").
- Conversation is never filler. When the player is really talking with companions or NPCs (questions, feelings, plans, banter with substance), let it breathe, even while traveling or resting: keep narration light, don't jump ahead, don't interrupt it with plot.
- Skip the boring parts. When nothing interesting is happening (a long walk, a ride, a wait) and the player isn't in a real conversation, compress it in a sentence or two ("By dusk the road climbs into the hills…") and land on the next interesting moment or the destination.
- Stalls: when the pacing report says the player's recent messages are short filler with no questions or plans, move the scene on yourself: skip ahead, arrive somewhere, or let someone or something push in.
- Vary scene types: social, exploration, tension, combat, downtime. Avoid two fights in a row; the world is NOT constant combat. Tension rises and falls; a lull after a big moment is good.
- Plot beats: the pacing report shows the NEXT BEAT. As soon as its goal is reached, even in a different way than planned, list it in "beats_completed". Don't hold beats back: the story should feel like it's going somewhere. Big mysteries can unfold over time, but every scene should reveal or change something.
- Plot pressure: when the party is away from the plot, the world pushes back, harder at each stage in the pacing report, always through things the story has set up (the people who want them, the results of what they did):
  stage 0 lean in: play along with their detour.
  stage 1 hints: rumors, signs, news, a familiar face.
  stage 2 pursuit: the plot comes looking for them: messengers, hunters on the trail, doors closing behind them.
  stage 3 pressure: direct threats and close calls; options narrow; resisting starts to cost them.
  stage 4 force: an overwhelming but fair turn of events puts the plot back on track (a much larger force, a trap they walk into, an offer they can't refuse). Set it up before it lands. Never ignore good rolls or conjure impossible odds out of nowhere.
  Escalate through the world, never by refusing the player ("you can't"). If they reach the next beat's goal another way, that counts: tick it and adapt. Plot-critical enemies should be strong enough to matter.

## Random events
- Sometimes you are offered a few candidate events from a deck. First ask: does an event fit RIGHT NOW? (A trader doesn't wander into a prison cell; nothing interrupts a tender moment.) If none fits, decline. You may instead invent a small event that fits the situation better.

## NPCs and content
- NPCs have wants, fears and agendas. Invent fitting names (never real people or celebrities).
- The FIRST time any NPC appears, add them to "new_npcs" (check "NPCS MET" first).
- Intense and dark themes are fine (danger, violence, horror, moral weight). No explicit sexual content: cut away or steer.

## Output format
Reply with ONE JSON object and nothing else. Omit keys you don't need. Schema:
{
  "narration": "shown to the player only, or empty string",
  "ooc": "out-of-character reply (only when the player asked something OOC)",
  "player_roll": {"kind": "check|save|attack|damage|initiative", "skill": "Perception", "ability": "WIS", "die": 20, "dc": 15, "advantage": "none|advantage|disadvantage", "reason": "why", "damage": "1d8+3 (for attacks)"},
  "npc_rolls": [{"who": "Judy Hopps", "what": "Stealth", "notation": "1d20+5", "dc": 13, "kind": "check|attack|save", "target": "name (attacks)", "damage": "1d6+2 (attacks)", "on_success": "plain words: what happens", "on_fail": "plain words: what happens", "hidden": false}],
  "directions": [{"speaker": "exact name", "direction": "the brief", "length": "short|normal|long"}],
  "new_npcs": [{"name": "Brannoc Vell", "description": "one line: who they are, look, manner", "gender": "male|female|any", "attitude": "friendly|neutral|wary|hostile", "stats": "optional: AC 12, HP 11, +4 to hit, 1d6+2"}],
  "scene": {"type": "social|exploration|tension|combat|downtime", "location": "short place name", "setting": "road|town|wild|dungeon|sea", "time": "morning|afternoon|evening|night", "changed": false},
  "tension": 0,
  "beats_completed": ["beat id from the plot, e.g. A1.2"],
  "state_changes": {"hp": {"Name": -3}, "conditions_add": {"Name": ["poisoned"]}, "conditions_remove": {"Name": ["poisoned"]}, "gold": 0, "items_add": ["item"], "items_remove": ["item"], "flags": {"key": "value"}},
  "start_combat": {"enemies": [{"name": "Bandit 1", "ac": 12, "hp": 11, "dex": 1}], "map": {"width": 10, "height": 8, "rows": ["top row", "...", "bottom row"]}},
  "positions": {"Name": "d4"},
  "end_combat": false,
  "notes_add": "private DM note for yourself (secrets, foreshadowing, NPC motives)",
  "story_add": "1-3 sentence summary for the long-term log: when a scene ends or something important happens (arrival somewhere new, capture, escape, a reveal, a beat completed)",
  "event": {"use": "event id | custom | none", "text": "only for custom: the small event you invented"},
  "standing_direction": "<=35 words, plain facts every companion can see and know right now (no secrets, no mood writing)",
  "objective": "<=15 words: the party's immediate goal (only when it changes)",
  "need_files": ["rolls_log", "events_log"]
}
- "directions" order = speaking order. Usually 0-2 speakers, only party members or NPCs present. Leave empty when the player should act next.
- Always include "scene" (with the current "location" name), "tension" and "standing_direction".
- If you need older records to rule fairly, return ONLY {"need_files": [...]} and you will be called again with them.`;

export const BIBLE_INSTRUCTIONS = `You are designing a new tabletop campaign for SillyTavern. You will be its Dungeon Master later.
Return ONE JSON object and nothing else:
{
  "title": "campaign title",
  "bible": "Markdown. Premise, tone, the world (places, factions, how things work), the main antagonist/pressure and their plan, important NPCs with motives, secrets the players don't know yet, themes. 400-900 words.",
  "plot": "Markdown checklist. 3-5 acts. Each act: a heading '## Act N: name' and 3-6 beats as '- [ ] A{act}.{n} beat description'. Beats are situations and goals, not scripted outcomes. The final act is the climax. Leave room for side content.",
  "opening": "The opening narration for the first scene: one short paragraph in plain, simple English (short sentences, everyday words), second person, present tense. End on a moment that invites the player to act. Do not speak or act for the player character.",
  "scene": {"type": "exploration|social|tension|downtime", "location": "short place name", "setting": "road|town|wild|dungeon|sea", "time": "morning|afternoon|evening|night"},
  "standing_direction": "<=35 words: plain facts the companions can see and know at the start (no secrets, no mood writing)",
  "objective": "<=15 words: the party's immediate goal at the start",
  "directions": [{"speaker": "party member name", "direction": "optional brief for an opening line: only what they need to know and want, never their words", "length": "short|normal"}],
  "new_npcs": [{"name": "every NPC who appears in the opening", "description": "one line: who they are, look, manner", "gender": "male|female|any", "attitude": "friendly|neutral|wary|hostile"}],
  "tension": 2
}`;

export const PITCH_INSTRUCTIONS = `Pitch campaign ideas for a tabletop roleplaying campaign. Return ONE JSON object and nothing else:
{"pitches": [{"title": "short title", "hook": "2-3 sentence pitch: setup, stakes, the twist that makes it interesting"}]}
Make the three pitches clearly different from each other.`;

export const SHEET_FROM_PDF_INSTRUCTIONS = `Convert this D&D 5e character sheet (text and form-field values extracted from a PDF) into a clean reference sheet.
Return ONE JSON object and nothing else:
{
  "markdown": "A readable Markdown character sheet: identity, class/level, ability scores with modifiers, proficiency bonus, saving throws, skills (with totals), AC, HP, speed, attacks (to-hit and damage), spells/slots, features & traits, equipment, personality notes. Keep every number from the source. Don't invent things that aren't there; write 'unknown' instead.",
  "stats": {"name": "", "class": "", "level": 1, "ac": 10, "hp_max": 10, "speed": 30, "proficiency": 2,
            "abilities": {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10},
            "saves": {"STR": 0, "DEX": 0, "CON": 0, "INT": 0, "WIS": 0, "CHA": 0},
            "skills": {"Acrobatics": 0, "Animal Handling": 0, "Arcana": 0, "Athletics": 0, "Deception": 0, "History": 0, "Insight": 0, "Intimidation": 0, "Investigation": 0, "Medicine": 0, "Nature": 0, "Perception": 0, "Performance": 0, "Persuasion": 0, "Religion": 0, "Sleight of Hand": 0, "Stealth": 0, "Survival": 0},
            "attacks": [{"name": "", "to_hit": 0, "damage": "1d6+2"}],
            "initiative": 0}
}
"saves" and "skills" are the TOTAL modifiers.`;

export const SHEET_FROM_CARD_INSTRUCTIONS = `Create a best-guess D&D 5e character sheet for this roleplay character, based on their character card. Match their personality, skills, background and physical abilities; pick a fitting class and a level appropriate for an adventuring companion (default level 3 unless the card strongly suggests otherwise). Be fair: strengths and weaknesses.
Return ONE JSON object and nothing else, same format:
{
  "markdown": "Readable Markdown sheet: concept, class/level, ability scores, skills, AC, HP, attacks, notable features, and a 2-line 'how they act in a fight'.",
  "stats": {"name": "", "class": "", "level": 3, "ac": 10, "hp_max": 10, "speed": 30, "proficiency": 2,
            "abilities": {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10},
            "saves": {"STR": 0, "DEX": 0, "CON": 0, "INT": 0, "WIS": 0, "CHA": 0},
            "skills": {"Perception": 0, "Stealth": 0},
            "attacks": [{"name": "", "to_hit": 0, "damage": "1d6+2"}],
            "initiative": 0}
}
"saves" and "skills" are TOTAL modifiers. Include every skill they're proficient in.`;

export const RECAP_INSTRUCTIONS = `Write a short "Previously on..." recap for the player returning to this campaign after a break: 3-6 sentences, second person, evocative, ending on where things stand right now and what's at stake. Return ONE JSON object: {"recap": "..."}`;

/** Added to routine-model calls only: lets the quick DM hand a real story moment to the senior DM. */
export const ESCALATE_INSTRUCTION = `You are the quick DM for routine turns; a senior DM handles big moments. If this turn is a big story moment (a major reveal, completing a plot beat, a fight breaking out, a new chapter or major location, or a turn that changes where the story is going), reply with ONLY {"escalate": true} and the senior DM will take this turn. Otherwise handle it yourself as normal. Don't escalate ordinary rulings, rolls, conversation or small discoveries.`;

export const CONDENSE_NOTES_INSTRUCTIONS = `Your private DM notes have grown long. Rewrite them into a compact, organized version that keeps every still-relevant secret, motive, plan, open thread and foreshadowing, and drops what's resolved. Return ONE JSON object: {"notes": "markdown"}`;

/**
 * Validate and normalize a DM turn. Never throws.
 * @returns {object}
 */
export function normalizeDmTurn(raw) {
    const d = (raw && typeof raw === 'object') ? raw : {};
    const out = {
        narration: str(d.narration),
        ooc: str(d.ooc),
        player_roll: null,
        npc_rolls: [],
        directions: [],
        new_npcs: [],
        scene: null,
        tension: Number.isFinite(Number(d.tension)) ? clamp(Math.round(Number(d.tension)), 0, 10) : null,
        beats_completed: arr(d.beats_completed).map(String).filter(Boolean),
        state_changes: obj(d.state_changes),
        start_combat: null,
        end_combat: d.end_combat === true,
        notes_add: str(d.notes_add),
        story_add: str(d.story_add),
        event: normalizeEventChoice(d.event),
        positions: normalizePositions(d.positions),
        standing_direction: str(d.standing_direction),
        objective: str(d.objective),
        need_files: arr(d.need_files).map(String).filter(Boolean),
        escalate: d.escalate === true,
    };
    if (d.player_roll && typeof d.player_roll === 'object' && (d.player_roll.skill || d.player_roll.kind)) {
        const pr = d.player_roll;
        out.player_roll = {
            kind: ['check', 'save', 'attack', 'damage', 'initiative'].includes(String(pr.kind)) ? String(pr.kind) : 'check',
            skill: str(pr.skill) || str(pr.kind) || 'Check',
            ability: str(pr.ability).toUpperCase().slice(0, 3),
            die: Number(pr.die) > 1 ? Number(pr.die) : 20,
            dc: Number.isFinite(Number(pr.dc)) && pr.dc !== null && pr.dc !== '' ? Number(pr.dc) : null,
            advantage: str(pr.advantage) || 'none',
            reason: str(pr.reason),
            damage: str(pr.damage),
        };
    }
    out.npc_rolls = arr(d.npc_rolls).filter(r => r && typeof r === 'object' && r.notation).slice(0, 8).map(r => ({
        who: str(r.who) || 'Someone',
        what: str(r.what) || 'Roll',
        notation: str(r.notation),
        dc: Number.isFinite(Number(r.dc)) && r.dc !== null && r.dc !== '' ? Number(r.dc) : null,
        kind: ['check', 'attack', 'save'].includes(String(r.kind)) ? String(r.kind) : 'check',
        target: str(r.target),
        damage: str(r.damage),
        on_success: str(r.on_success),
        on_fail: str(r.on_fail),
        hidden: r.hidden === true,
    }));
    out.directions = arr(d.directions).filter(x => x && x.speaker).slice(0, 4).map(x => ({
        speaker: str(x.speaker),
        direction: str(x.direction ?? x.brief),
        length: ['short', 'normal', 'long'].includes(String(x.length)) ? String(x.length) : 'normal',
    }));
    out.new_npcs = arr(d.new_npcs).filter(x => x && x.name).slice(0, 6).map(x => ({
        name: str(x.name).slice(0, 60),
        description: str(x.description),
        gender: ['male', 'female', 'any'].includes(String(x.gender).toLowerCase()) ? String(x.gender).toLowerCase() : 'any',
        attitude: str(x.attitude) || 'neutral',
        stats: str(x.stats),
    }));
    if (d.scene && typeof d.scene === 'object') {
        const type = String(d.scene.type ?? '').toLowerCase();
        out.scene = {
            type: SCENE_TYPES.includes(type) ? type : null,
            location: str(d.scene.location),
            setting: str(d.scene.setting).toLowerCase(),
            time: str(d.scene.time).toLowerCase(),
            changed: d.scene.changed === true,
        };
    }
    if (d.start_combat && typeof d.start_combat === 'object') {
        out.start_combat = {
            enemies: arr(d.start_combat.enemies).filter(e => e && e.name).slice(0, 12).map(e => ({
                name: str(e.name),
                ac: Number(e.ac) || 10,
                hp: Number(e.hp) || 5,
                dex: Number(e.dex) || 0,
            })),
            map: d.start_combat.map && typeof d.start_combat.map === 'object' ? d.start_combat.map : null,
        };
    }
    return out;
}

/** {use: "<event id>" | "custom" | "none", text} — older {used, delay} answers still work. */
function normalizeEventChoice(e) {
    const ev = e && typeof e === 'object' ? e : {};
    let use = str(ev.use).toLowerCase();
    if (!use) use = ev.used === true ? 'offered' : ev.delay === true ? 'none' : '';
    return { use, text: str(ev.text), delay: ev.delay === true };
}

function normalizePositions(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out = {};
    for (const [name, coord] of Object.entries(p)) {
        if (!name) continue;
        out[str(name).slice(0, 60)] = coord === null ? 'gone' : str(coord).slice(0, 8);
    }
    return out;
}

/** Parse Claude's raw text into a DM turn; null if it isn't usable JSON. */
export function parseDmTurn(text) {
    const json = extractJson(text);
    if (!json) return null;
    return normalizeDmTurn(json);
}

function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
}

function arr(v) {
    return Array.isArray(v) ? v : [];
}

function obj(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}
