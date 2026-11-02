// Triage: classify the player's message, cheaply.
// Code rules first; the local helper model only when the rules can't tell.
// Pure module (no SillyTavern imports).

import { parsePlayerRoll } from './dice.js';
import { extractJson, nameKey } from './text.js';

export const CATEGORIES = ['banter', 'action', 'risky_action', 'scene_move', 'combat_action', 'question'];

/**
 * Rule-based triage. Returns a partial result; `needsHelper` says whether the helper should refine it.
 * @param {string} text the player's message
 * @param {{pendingRoll?: object|null, inCombat?: boolean}} ctx
 */
export function ruleTriage(text, ctx = {}) {
    // "*(OOC)* ..." (the marker in italics, as players type it) is OOC like the plain forms.
    const raw = String(text ?? '').trim().replace(/^[*_]+\s*\(\s*ooc\s*\)\s*[*_]+\s*:?\s*/i, 'OOC: ');
    const t = raw.toLowerCase();
    const result = { category: null, ooc: false, oocText: '', rollResult: false, roll: null, needsHelper: true };

    // Out of character: "((...))", "(OOC ...)", "OOC:", "DM, ...", "@DM ..."
    const ooc = raw.match(/^\s*(?:\(\((.*?)\)\)?|\(\s*ooc\s*[:\-]?\s*(.*?)\)?|ooc\s*[:\-]\s*(.*)|@?dm\s*[,:\-]\s*(.*)|@dm\s+(.*))\s*$/is);
    if (ooc) {
        result.ooc = true;
        result.oocText = (ooc[1] ?? ooc[2] ?? ooc[3] ?? ooc[4] ?? ooc[5] ?? '').trim() || raw;
        result.mapRequest = mapRequest(result.oocText);
        result.category = 'question';
        result.needsHelper = false;
        return result;
    }

    // "Claude, regenerate the map": said in character, still a request for a map.
    const mr = /\b(claude|dm|game master|gm)\b/i.test(raw) ? mapRequest(raw) : null;
    if (mr) result.mapRequest = mr;

    // Answer to a pending roll request.
    if (ctx.pendingRoll) {
        const sides = Number(ctx.pendingRoll.die ?? 20) || 20;
        const parsed = parsePlayerRoll(raw, sides, { advantage: ctx.pendingRoll.advantage });
        if (parsed && (raw.length < 80 || /\broll|rolled|nat\b/i.test(raw))) {
            result.rollResult = true;
            result.roll = parsed;
            result.category = ctx.inCombat ? 'combat_action' : 'action';
            result.needsHelper = false;
            return result;
        }
    }

    // An order to the people of the place ("Bring Judy to me, unharmed.", "You. Unlock this door.", "Go and fetch her"):
    // the world has to act on it, so the DM rules and moves them. A word to a companion by name is the helper's: a task.
    if (!ctx.inCombat && isOrder(raw, ctx.companions || [])) {
        result.category = 'risky_action';
        result.order = true;
        result.needsHelper = true;
        return result;
    }
    // Obvious scene moves.
    if (/\b(let'?s|we|i)\s+(head|go|travel|leave|set off|ride|sail|walk|move on|make camp|rest|sleep|camp)\b/.test(t) ||
        /\b(long rest|short rest|fast[- ]travel|skip (ahead|to))\b/.test(t)) {
        result.category = 'scene_move';
        result.needsHelper = false;
        return result;
    }

    // Obvious combat.
    if (ctx.inCombat || /\b(attack|stab|slash|shoot|swing at|punch|cast .* at|fireball|draw (my|a) (sword|blade|bow|weapon)|charge at|tackle)\b/.test(t)) {
        result.category = ctx.inCombat || /\b(attack|stab|slash|shoot|swing at|punch|charge at|tackle|cast .* at|fireball)\b/.test(t) ? 'combat_action' : 'risky_action';
        result.needsHelper = false;
        return result;
    }

    // Obvious risky attempts.
    if (/\b(try to|attempt to|sneak|pick the lock|lockpick|pickpocket|steal|climb|jump|persuade|intimidate|deceive|lie to|bluff|search for|investigate|hide|disarm|break (down|open)|force (the|it) open|sense motive|insight)\b/.test(t)) {
        result.category = 'risky_action';
        result.needsHelper = true; // helper can still downgrade, but default to DM
        return result;
    }

    return result;
}

/**
 * Prompt for the local helper. Kept tiny, no thinking trigger.
 * @param {{player:string, message:string, recent:string, speakers:string[], scene:string}} p
 */
export function helperTriagePrompt({ player, message, recent, speakers, scene, away = [], companions = [], places = [], mapOn = false }) {
    const system = 'You are a fast classifier for a tabletop roleplaying game. Reply with ONE line of JSON and nothing else.';
    const user = [
        `Scene: ${scene || 'unknown'}`,
        'Recent chat:',
        recent || '(none)',
        '',
        `New message from the player (${player}):`,
        message,
        '',
        'Classify the new message. JSON keys:',
        '"category": one of "banter" (talking/roleplay, no risk), "action" (simple action, no real risk), "risky_action" (outcome uncertain: needs a dice roll or a ruling), "scene_move" (travel, rest, leave, time skip), "combat_action", "question" (asking about the world).',
        '"engaged": 0-3, how invested/playful the player seems right now.',
        '"stalled": true if the conversation is going in circles with no progress for several messages.',
        '"refusing": true if the player refuses, resists, dodges or bargains against what another character is asking or trying to make them do (even calmly).',
        speakers.length
            ? `"speakers": who would naturally reply next, 0, 1 or 2 names chosen ONLY from: ${speakers.map(s => JSON.stringify(s)).join(', ')}. Use [] when nobody nearby would answer (the player is acting alone, talking to themselves, or nothing calls for a reply). Nobody has to reply every time. While the player is just moving about, searching, or working a lock (not talking to anyone), companions usually say nothing: use [] unless the player speaks to them or something right in front of them is worth a quick word.`
            : '"speakers": [] (nobody is with the player right now).',
        away.length ? `Not with the player (can't hear or reply): ${away.join('; ')}.` : '',
        '"addressed": the name of the character the player is speaking to or acting toward (any name, even if not in that list), or "" if nobody in particular.',
        companions.length ? `"task": only if the player tells or asks a companion (${companions.map(s => JSON.stringify(s)).join(', ')}) to DO something now (not just talk): {"who": their name, "what": "a few words", "go": ${places.length ? '"the id of a room they have to go to, from the list below, or empty"' : '""'}, "dm": true if what happens or what they find isn't known yet and the Dungeon Master has to decide it (searching, looking inside, checking for something, opening, picking a lock, sneaking, scouting, listening at a door, anything that could need a dice roll), false for simple things whose result is obvious (follow me, wait here, sit down, hand me that, go stand over there)}. Otherwise "task": null.` : '',
        mapOn ? '"thing": the object, door, window or creature on the map that the player (or the companion given the task) is about to touch, open, search, smash, take from, hide in, sit on, climb, unlock or attack, in the words the player used ("bookshelf", "the kennel", "north door", "the dog"), or "" if they only talk or move about.' : '',
        companions.length ? `"warned": the name of the companion the player tells or warns about a trap or a dangerous spot (where it is, to watch out for it), or "".` : '',
        companions.length && places.length ? `Rooms near the party: ${places.map(p => `${p.id} = ${p.name}`).join('; ')}.` : '',
        'Example: {"category":"banter","engaged":2,"stalled":false,"speakers":["Judy Hopps"],"addressed":"Judy Hopps"' + (companions.length ? ',"task":null' : '') + '}',
    ].filter(Boolean).join('\n');
    return { system, user };
}

/** Parse the helper's reply, tolerating junk. */
export function parseHelperTriage(text, speakers = []) {
    const data = extractJson(text) || {};
    let category = String(data.category ?? '').toLowerCase().trim();
    if (!CATEGORIES.includes(category)) {
        const lower = String(text ?? '').toLowerCase();
        category = CATEGORIES.find(c => lower.includes(c)) ?? 'banter';
    }
    let engaged = Number(data.engaged);
    if (!Number.isFinite(engaged)) engaged = null;
    else engaged = Math.min(3, Math.max(0, engaged));
    const picked = Array.isArray(data.speakers) ? data.speakers.map(String) : [];
    return {
        category,
        engaged,
        stalled: data.stalled === true || data.stalled === 'true',
        refusing: data.refusing === true || data.refusing === 'true',
        speakers: picked.filter(s => speakers.some(x => x.toLowerCase() === s.toLowerCase())).slice(0, 2),
        addressed: typeof data.addressed === 'string' ? data.addressed.trim().slice(0, 60) : '',
        task: parseTask(data.task),
        warned: typeof data.warned === 'string' ? data.warned.trim().slice(0, 60) : '',
        thing: typeof data.thing === 'string' ? data.thing.trim().slice(0, 60) : '',
    };
}

/** The companion task in the helper's reply ({who, what, go, dm}), or null. */
function parseTask(t) {
    if (!t || typeof t !== 'object' || typeof t.who !== 'string' || !t.who.trim()) return null;
    return {
        who: t.who.trim().slice(0, 60),
        what: String(t.what ?? '').trim().slice(0, 120),
        go: String(t.go ?? '').trim().slice(0, 40),
        dm: t.dm === true || t.dm === 'true',
    };
}

/** Ask the helper whether a companion's own reply attempts something that needs a roll. */
/**
 * Ask the helper about a companion's reply: do they attempt something risky (askAttempt), go
 * somewhere on the map (places), and are they coming along with the player, sticking by their side,
 * or staying behind (askStance: the player asks in chat, the companion answers in character)?
 */
export function companionActionPrompt({ name, message, scene, places = [], askAttempt = true, player = 'the player', askStance = false }) {
    const system = 'You are a fast classifier for a tabletop roleplaying game. Reply with ONE line of JSON and nothing else.';
    const questions = [
        askAttempt ? `Does ${name} ATTEMPT something with an uncertain outcome that would need a dice roll in D&D: sneaking, stealing or slipping something, picking a lock, lying to someone, a hard climb or jump, attacking, casting a spell on someone, forcing something open? Talking, feelings, looking around, simple everyday actions and agreeing do NOT count.` : '',
        places.length ? `Does ${name} go somewhere right now, on their own (walks over to something, goes to hide somewhere, goes into another room)? Only if they actually go now (on their own or because they were asked to), not if they only suggest it or talk about it. If so, which of these: ${places.map(p => `${p.id} = ${p.name}`).join('; ')}; and are they hiding there (in it, under it or behind it), or sitting or lying down on it ("sit", "lie", "sleep", or "")?` : '',
        askStance ? `Going by this reply, is ${name} now coming along with ${player}? "close" if they agree to stay right by ${player}'s side; "follow" if they agree to follow or come along; "stay" if they say they'll stay, wait here, or refuse to come; "" if the reply doesn't say.` : '',
    ].filter(Boolean);
    const fields = [
        askAttempt ? '"attempt": true or false, "what": "a few words: what they try, or empty"' : '',
        places.length ? '"go": "the id they go to, or empty", "hide": true or false, "pose": "sit, lie, sleep or empty"' : '',
        askStance ? '"stance": "close, follow, stay or empty"' : '',
    ].filter(Boolean);
    const user = [
        `Scene: ${scene || 'unknown'}`,
        `${name} (a companion in the party) just wrote:`,
        message,
        '',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        `JSON: {${fields.join(', ')}}`,
    ].join('\n');
    return { system, user };
}

/** Words that really mean a companion is staying behind (the classifier over-reads "I'll watch the door" as staying). */
const STAY_WORDS = /\b(wait here|stay here|stay behind|stay put|staying here|staying behind|i('ll| will) stay|i('m| am) staying|i('ll| will) wait|not coming|go (on )?without me|leave me here|you go ahead|i('m| am) not (going|coming|leaving))\b/i;

export function parseCompanionAction(text, places = [], message = '') {
    const data = extractJson(text) || {};
    const attempt = data.attempt === true || data.attempt === 'true';
    const go = String(data.go ?? '').trim();
    const ok = places.some(p => p.id === go);
    const pose = String(data.pose ?? '').trim().toLowerCase();
    let stance = String(data.stance ?? '').trim().toLowerCase();
    if (stance === 'stay' && message && !STAY_WORDS.test(String(message))) stance = '';
    return {
        attempt, what: attempt ? String(data.what ?? '').trim().slice(0, 120) : '', go: ok ? go : '',
        ...(ok && (data.hide === true || data.hide === 'true') ? { hide: true } : {}),
        ...(ok && ['sit', 'lie', 'sleep'].includes(pose) ? { pose } : {}),
        ...(['close', 'follow', 'stay'].includes(stance) ? { stance } : {}),
    };
}

// ---------- a map, asked for in the player's own words ----------

const KIND_WORDS = [
    [/\b(jungle|rainforest)\b/, 'jungle'], [/\b(swamp|marsh|bog)\b/, 'swamp'], [/\b(desert|dunes?)\b/, 'desert'], [/\b(snow|snowy|frozen|tundra)\b/, 'snow'],
    [/\b(bandit camp|war camp|raiders?' camp|cannibal camp|camp)\b/, 'camp'], [/\b(town|village|city|hamlet)\b/, 'town'],
    [/\b(woods?|forest|trees|woodland|grove|wooded)\b/, 'forest'], [/\b(downs|hills?|plains?|meadow|grass(land)?|fields?|moor|heath|prairie|steppe|open country|wilderness|wilds|countryside|standing stones)\b/, 'downs'],
    [/\b(cave|cavern|grotto)\b/, 'cave'], [/\b(crypt|tomb|catacombs?)\b/, 'crypt'], [/\bdungeon\b/, 'dungeon'], [/\b(castle|keep|fortress|fort)\b/, 'castle'],
    [/\b(mansion|manor|estate)\b/, 'mansion'], [/\b(tavern|inn)\b/, 'tavern'], [/\b(temple|church|shrine)\b/, 'temple'], [/\b(prison|jail|gaol)\b/, 'prison'], [/\b(house|cottage|cabin)\b/, 'house'], [/\b(ship|boat)\b/, 'ship'],
];

/** The kind of place some words describe ("a big forest with a stream" → forest), or ''. */
export function kindFromWords(text) {
    const w = String(text ?? '').toLowerCase();
    return KIND_WORDS.find(([re]) => re.test(w))?.[1] ?? '';
}

/**
 * The player asking for a map ("make the map", "regenerate the map, a large map of woods with a
 * stream"): what they asked for, or null. kind and size come from their words when they gave any;
 * redo = they want the current map done again (not just one made).
 */
export function mapRequest(text) {
    const t = String(text ?? '').trim();
    if (!t || !/\b(map|grid|battle ?map)\b/i.test(t)) return null;
    // A question about the map ("do the guards on the map see me?") or a word about something on it ("I can't pick it up from the map") is not a request for one.
    if (/^\s*(?:do|does|did|is|are|was|were|what|where|who|why|how|which|will|would|should)\b/i.test(t)) return null;
    if (/\?\s*$/.test(t) && !/\b(?:can|could|would|will) you\b/i.test(t)) return null;
    if (/\b(don'?t|do not|never|without|no need|stop)\b[^.?!]{0,40}\b(map|grid)\b/i.test(t) || /\b(can i see|where is|open|show|hide|close|minimi[sz]e)\b[^.?!]{0,30}\b(the )?map\b/i.test(t)) return null;
    // The build word has to be about the map itself: "regenerate the map", "make a map of the woods", "a new map", "the map again".
    const build = '(?:re-?gen(?:erate|erated|erating)?|regen\\w*|build|rebuild|make|remake|create|draw|redraw|render|redo|re-?roll|generate|fix|change|update|replace)';
    const asks = new RegExp(`\\b${build}\\b[^.?!,;]{0,24}\\b(?:map|grid|battle ?map)\\b`, 'i').test(t)
        || /\bnew (?:map|grid|battle ?map)\b/i.test(t)
        || /\b(?:map|grid)\b[^.?!]{0,12}\b(?:again|please|now|correctly|properly|redo|regen\w*)\b/i.test(t)
        || /\b(?:want|need|give (?:me|us)|can (?:i|we) (?:get|have))\b[^.?!]{0,16}\b(?:map|grid|battle ?map)\b/i.test(t);
    if (!asks) return null;
    const w = t.toLowerCase();
    return {
        text: t,
        kind: kindFromWords(w),
        size: /\b(large|big|huge|massive|wide|bigger|larger|vast|sprawling|great big)\b/.test(w) ? 'big' : /\b(small|tiny|little)\b/.test(w) ? 'small' : '',
        redo: /\b(re-?gen\w*|regen\w*|rebuild|redo|re-?make|remake|again|change|fix|correctly|properly|new map|replace|different|other)\b/.test(w),
    };
}

/** A place name out of a request's words: "regenerate the map: a small bandit camp by a river" → "Bandit Camp by a River". */
export function nameFromWords(text) {
    let t = String(text || '').replace(/^.*?\b(?:map|grid)\b\s*[:,-]?\s*/i, '').replace(/^(?:make it|make|build|with|of)\s+/i, '').replace(/[.!?].*$/, '').trim();
    t = t.replace(/^(?:a|an|the|some)\s+/i, '').replace(/\b(large|big|huge|massive|small|tiny|little|wide|vast|sprawling|please|now|map)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:a|an|the|some)\s+/i, '');
    const words = t.split(' ').filter(Boolean).slice(0, 6);
    if (!words.length) return '';
    return words.map((w, i) => (i > 0 && /^(by|of|on|in|at|with|and|under|near|the|to|a|an)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/**
 * A companion's own turn in a fight, decided by the local model from what the code knows: the foes
 * and how far and hurt they are, their own weapons and items, their HP, who needs help.
 */
export function companionCombatPrompt({ name, hp, hpMax, conditions = [], foes = [], allies = [], weapons = [], items = [], player = 'the player', last = '' }) {
    const system = 'You decide one character\'s action in a D&D fight, as that character would. Reply with ONE line of JSON and nothing else.';
    const user = [
        `${name}: HP ${hp}/${hpMax}${conditions.length ? `, ${conditions.join(', ')}` : ''}.`,
        `Enemies: ${foes.map(f => `${f.name} (HP ${f.hp}/${f.hpMax}${f.ac ? `, AC ${f.ac}` : ''}, ${f.dist} square${f.dist === 1 ? '' : 's'} away${f.dist <= 1 ? ', in reach' : ''})`).join('; ') || 'none in sight'}.`,
        `Allies: ${allies.map(a => `${a.name} (HP ${a.hp}/${a.hpMax}, ${a.dist} squares away${a.down ? ', DOWN' : ''})`).join('; ') || 'none'}.`,
        `${name}'s weapons: ${weapons.map(w => `${w.name} (${w.damage}${w.range ? `, range ${w.range}` : ''})`).join('; ') || 'unarmed (1 bludgeoning)'}.`,
        `${name} carries: ${items.join(', ') || 'nothing useful'}.`,
        last ? `Last round: ${last}` : '',
        `What does ${name} do this turn? Pick ONE: "attack" (a named enemy, with a named weapon; melee needs them in reach, else a ranged weapon or move closer first), "move" (toward an enemy or away: "closer" or "away"), "help" (a downed or badly hurt ally: steady them, pull them back), "dodge" (hard pressed, no good attack), "hide", "use" (a named item: a potion, a tool), "hold" (wait and watch). Be sensible: a hurt ally matters, a dying one more; don't swing a dagger at someone 6 squares away.`,
        `JSON: {"action": "attack|move|help|dodge|hide|use|hold", "target": "enemy or ally name or empty", "weapon": "weapon name or empty", "item": "item name or empty", "where": "closer|away|empty", "why": "a few words"}`,
    ].filter(Boolean).join('\n');
    return { system, user };
}

export function parseCompanionCombat(text, { foes = [], allies = [], weapons = [], items = [] } = {}) {
    const d = extractJson(text) || {};
    const action = ['attack', 'move', 'help', 'dodge', 'hide', 'use', 'hold'].includes(String(d.action || '').toLowerCase()) ? String(d.action).toLowerCase() : 'attack';
    const pick = (want, list) => { const k = nameKey(String(want || '')); return k ? list.find(x => nameKey(x) === k) ?? list.find(x => nameKey(x).includes(k) || k.includes(nameKey(x))) ?? '' : ''; };
    const foeNames = foes.map(f => f.name), allyNames = allies.map(a => a.name), weaponNames = weapons.map(w => w.name), itemNames = items;
    let target = action === 'help' ? pick(d.target, allyNames) : pick(d.target, foeNames);
    let weapon = pick(d.weapon, weaponNames);
    const item = pick(d.item, itemNames);
    if (action === 'attack') {
        if (!target) target = foes.slice().sort((a, b) => a.dist - b.dist)[0]?.name ?? '';
        const f = foes.find(x => x.name === target);
        // A melee weapon at range is no use: the ranged one if there is one, else close in.
        if (f && f.dist > 1) { const ranged = weapons.find(w => w.range); if (ranged && (!weapon || !weapons.find(w => w.name === weapon)?.range)) weapon = ranged.name; }
        if (!weapon) weapon = weaponNames[0] ?? '';
        if (!target) return { action: 'hold', target: '', weapon: '', item: '', where: '', why: 'no enemy in sight' };
    }
    if (action === 'help' && !target) target = allies.find(a => a.down)?.name ?? allies.slice().sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0]?.name ?? '';
    if (action === 'use' && !item) return { action: 'hold', target: '', weapon: '', item: '', where: '', why: 'nothing to use' };
    const where = ['closer', 'away'].includes(String(d.where || '').toLowerCase()) ? String(d.where).toLowerCase() : '';
    return { action, target, weapon, item, where, why: String(d.why || '').slice(0, 80) };
}

const ROLL_WORDS = 'save|saving throw|check|roll|skill|attack|test|contest|acrobatics|athletics|perception|stealth|insight|persuasion|deception|intimidation|investigation|survival|arcana|history|medicine|nature|religion|sleight of hand|animal handling|performance|initiative|dex|str|con|wis|int|cha|dexterity|strength|constitution|wisdom|intelligence|charisma';

/**
 * Whose roll a player_roll really is: the player's, unless its words make it a companion's own
 * ("Judy's DEX save", "for Judy", "Judy must climb"). A reason that speaks to the player ("you",
 * "your") is the player's whatever names it mentions ("Judy's weight on your back"), and so is
 * one that names the player. Returns the companion's name, or null.
 * @param {string} text the request's reason and skill
 * @param {string} player
 * @param {string[]} companions
 */
export function rollBelongsTo(text, player, companions) {
    const raw = String(text || '').toLowerCase();
    const esc = s => String(s || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const first = n => esc(nameKey(n).split(' ')[0]);
    if (new RegExp(`\\b${first(player)}(?:'s|’s)?\\b`).test(raw)) return null;
    const addressed = /\b(?:you|your|yourself)\b/.test(raw);
    for (const n of companions) {
        const f = first(n);
        if (!f) continue;
        if (new RegExp(`\\bfor ${f}\\b`).test(raw)) return n;
        if (addressed) continue;
        if (new RegExp(`(?:^|\\s|\\()${f}(?:'s|’s)\\s+(?:\\w+\\s+){0,2}(?:${ROLL_WORDS})\\b`).test(raw)) return n;
        if (new RegExp(`^${f} (?:must|needs to|has to|rolls|makes|saves|tries|attempts)\\b`).test(raw)) return n;
    }
    return null;
}

const ORDER_VERBS = 'bring|fetch|take|carry|drag|haul|seize|grab|release|free|unlock|unchain|untie|open|lock|bind|chain|kill|escort|send|summon|gather|feed|keep|leave|let|put|throw|cut|strike|get|hand|give|guard|stand|kneel|bow|drop|lower|raise|follow|stop|back';
const ORDER_RE = new RegExp(`(?:^|["“]\\s*|\\*\\s*|\\b(?:you|now)[.,!]\\s+|\\b(?:go|come) (?:and |now and )?)(?:${ORDER_VERBS})\\b[^.!?]{0,60}\\b(?:me|here|him|her|them|us|to me|loose|alone|away|out|off|down|back|(?:the|this|that|these|those|my|his|her|their|your) (?:door|gate|cage|cuffs|irons|chains|bars|prisoner|captive|wagon|wrists|hands|weapon|weapons|spear|spears|knife|rope|cloak))\\b`, 'i');

/**
 * The player's line is an order to the people of the place ("Bring Judy to me", "Unlock this door"),
 * not a word to a companion by name ("Judy, bring me the rope": a task for the helper). The world
 * has to act on an order, so it goes to the DM.
 */
export function isOrder(text, companions = []) {
    const raw = String(text || '');
    if (!raw.trim() || /^\s*\(\(|^\s*ooc\b/i.test(raw)) return false;
    const esc = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firsts = companions.map(n => esc(String(n).split(' ')[0])).filter(Boolean);
    if (firsts.length && new RegExp(`^\\s*[*"“_]*\\s*(?:${firsts.join('|')})\\b`, 'i').test(raw)) return false;
    return ORDER_RE.test(raw);
}

const ATTACK_WORDS = /\b(attacks?|stabs?|slash(?:es)?|shoots?|swings? (?:at|his|her|the)|punch(?:es)?|strikes?|hits?|kicks?|lunges?|charges? at|tackles?|fires? (?:an? )?(?:arrow|bolt)|casts? \w+ at|throws? (?:a|the|his|her) \w+ at)\b/i;

/** The player attacks someone: not "strike these irons off my wrists", "hit the road", "kick the door down", "break the chain". */
export function attacksSomeone(text) {
    const t = String(text || '')
        .replace(/\b(?:strikes?|knocks?|cuts?|breaks?|smash(?:es)?|hits?|kicks?)\b[^.!?]{0,30}\b(?:off|out|loose|free|open|the door|the lock|the chain|the chains|the irons|the cuffs|the bars)\b/gi, ' ')
        .replace(/\b(?:strikes? (?:a|the|up a) (?:deal|bargain|conversation)|hits? the (?:road|hay|sack|deck|ground)|kicks? (?:off|back|the (?:fire|dirt|dust)))\b/gi, ' ')
        // "Draws his sword, not to attack, just to show he'll defend himself": a threat, not a swing.
        .replace(/\b(?:not (?:to |going to |gonna )?(?:attack|strike|hit|stab|swing|fight)\w*|without (?:attacking|striking|swinging)|(?:just|only) to (?:show|warn|scare|make a point)|no(?:t an?)? attack)\b[^.!?]*/gi, ' ');
    return ATTACK_WORDS.test(t);
}
/** "I end my turn.", "end turn", "done": the player hands the round on in words (the same as the End my turn button). */
export function isEndTurn(text) {
    const s = String(text || '').trim().replace(/^[*_("\s]+|[*_)".!\s]+$/g, '').toLowerCase();
    return /^(?:(?:i|i'll|ill)\s+)?(?:end|pass|finish)(?:\s+my)?\s+turn$|^(?:that'?s|thats)\s+(?:my|it for my|the end of my)\s+turn$|^end of (?:my )?turn$|^(?:done|i'm done|im done|next)$/.test(s);
}
// ---------- a keeper and her prisoner: guard or companion ----------

/** "Stay put", "sit down", "don't move": the keeper has her prisoner stay. */
const KEEPER_GUARD = /\b(?:stay (?:put|there|where you are|right there|here|still|down|on the ground)|don'?t (?:you )?(?:move|get up|take another step)|not (?:going|moving) anywhere|you'?re not (?:going|leaving|moving|getting up)|sit (?:down|still|there|tight)|hold still|stop right there|not another step|on your knees|keep still|you stay|stay close|don'?t wander|(?:get|come) back here|back[.!,]? now|(?:get )?back on the (?:trail|path|road))\b/i;
/** "I'll follow you", "lead the way", "let's go": the keeper lets her prisoner walk, or goes along (even mid-chase: she's calling it off). */
const KEEPER_LET = /\b(?:i'?ll (?:follow|come|go|walk|keep up|be with|be right behind|stick with) (?:with |after |behind |beside )?you|lead (?:the way|on)|after you|let'?s go|come on,? then|go (?:on|ahead)(?:,? i'?m)?|we(?:'?ll)? (?:go|walk) together|walk,? then|fine,? (?:go|walk|lead|move|come on)|have it your way)\b/i;
/** "I'm coming with you", "right behind you": going along, in a quiet moment. In a chase these are her closing in, not letting go. */
const KEEPER_ALONG = /\b(?:i'?m (?:coming (?:with you|along|too)|following(?: you)?|with you|right behind you)|right behind you)\b/i;

/** What a keeper's own reply means for her prisoner: 'guard' (stay put), 'companion' (she lets them walk, or comes along), or '' (nothing said). */
export function keeperWords(message, { chase = false } = {}) {
    const t = String(message ?? '').replace(/[*_~`]/g, ' ');
    if (KEEPER_GUARD.test(t)) return 'guard';
    if (KEEPER_LET.test(t)) return 'companion';
    if (!chase && KEEPER_ALONG.test(t)) return 'companion';
    return '';
}

/** The player asks their keeper along ("come with me", "follow me", "let's go to the fire"): walking together, not away. */
export function asksAlong(text) {
    return /\b(?:come (?:with me|along|on)|follow me|let'?s (?:go|walk|head|move)|walk with me|with me,? (?:now|then|come)|lead the way|you coming\?)\b/i.test(String(text ?? '').replace(/[*_~`]/g, ' '));
}

/** Ask the helper what the keeper's reply means when her words don't say outright. */
export function keeperStancePrompt({ keeper, prisoner, message, scene }) {
    const system = 'You are a fast classifier for a tabletop roleplaying game. Reply with ONE line of JSON and nothing else.';
    const user = [
        `Scene: ${scene || 'unknown'}`,
        `${keeper} holds ${prisoner} as a prisoner (cuffed or tied), and goes where ${prisoner} goes only if ${keeper} chooses to. ${keeper} just wrote:`,
        message,
        '',
        `Going by this reply only: does ${keeper} now let ${prisoner} walk about, or agree to go along with ${prisoner} wherever ${prisoner} is going ("companion")? Or does ${keeper} tell ${prisoner} to stay put, sit, stop or not move, or hold ${prisoner} in place ("guard")? If the reply says neither (talk, questions, feelings, a warning about something else), "".`,
        'JSON: {"mode": "companion, guard or empty"}',
    ].join('\n');
    return { system, user };
}

export function parseKeeperStance(text) {
    const data = extractJson(text) || {};
    const m = String(data.mode ?? '').trim().toLowerCase();
    return m === 'guard' || m === 'companion' ? m : '';
}
