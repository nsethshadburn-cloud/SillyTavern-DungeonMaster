// Triage: classify the player's message, cheaply.
// Code rules first; the local helper model only when the rules can't tell.
// Pure module (no SillyTavern imports).

import { parsePlayerRoll } from './dice.js';
import { extractJson, nameKey } from './text.js';

export const CATEGORIES = ['banter', 'action', 'risky_action', 'scene_move', 'combat_action', 'question'];

/**
 * Rule-based triage. Returns a partial result; `needsHelper` says whether the helper should refine it.
 * @param {string} text the player's message
 * @param {{pendingRoll?: object|null, inCombat?: boolean, companions?: string[], player?: string}} ctx player = the player's name ("Amber goes in" is "I go in")
 */
export function ruleTriage(text, ctx = {}) {
    // "*(OOC)* ..." (the marker in italics, as players type it) is OOC like the plain forms.
    const raw = String(text ?? '').trim().replace(/^[*_]+\s*\(\s*ooc\s*\)\s*[*_]+\s*:?\s*/i, 'OOC: ');
    const t = raw.toLowerCase();
    const result = { category: null, ooc: false, oocText: '', rollResult: false, roll: null, needsHelper: true };
    // Someone grabbing, tackling or pinning someone, in the player's line or an aside to the DM: a contest, decided by dice (the DM is told so).
    result.contest = !ctx.inCombat && grabsSomeone(raw);

    // Out of character: "((...))", "(OOC ...)", "OOC:", "DM, ...", "@DM ..."
    const ooc = raw.match(/^\s*(?:\(\((.*?)\)\)?|\(\s*ooc\s*[:\-]?\s*(.*?)\)?|ooc\s*[:\-]\s*(.*)|@?dm\s*[,:\-]\s*(.*)|@dm\s+(.*))\s*$/is);
    if (ooc) {
        result.ooc = true;
        result.oocText = (ooc[1] ?? ooc[2] ?? ooc[3] ?? ooc[4] ?? ooc[5] ?? '').trim() || raw;
        result.category = 'question';
        result.needsHelper = false;
        return result;
    }

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
    // the world has to act on it, so the DM rules. A word to a companion by name is the helper's: a task.
    if (!ctx.inCombat && isOrder(raw, ctx.companions || [])) {
        result.category = 'risky_action';
        result.order = true;
        result.needsHelper = true;
        return result;
    }
    // The player's own doings, in the first person or by their name ("*Amber goes into the shop*").
    const me = String(ctx.player || '').toLowerCase().split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const self = me ? `(?:let'?s|we|i|${me})` : "(?:let'?s|we|i)";
    // Obvious scene moves: travel, rests, going into or out of a place.
    if (new RegExp(`\\b${self}\\s+(?:head|heads|go|goes|travel|travels|leave|leaves|set off|sets off|ride|rides|sail|sails|walk|walks|move on|moves on|make camp|makes camp|rest|rests|sleep|sleeps|camp|camps|enter|enters|step|steps) (?:into|in|inside|out|outside|through|to|for|on|off|back|away|up|down|over|along|toward|towards|the|a|an|out of)\\b`).test(t) ||
        new RegExp(`\\b${self}\\s+(?:head|heads|go|goes|travel|travels|leave|leaves|set off|sets off|ride|rides|sail|sails|move on|moves on|make camp|makes camp|rest|rests|sleep|sleeps|camp|camps)\\b`).test(t) ||
        /\b(long rest|short rest|fast[- ]travel|skip (ahead|to))\b/.test(t)) {
        result.category = 'scene_move';
        result.needsHelper = false;
        return result;
    }

    // Obvious combat.
    const fight = /\b(attack|attacks|attacking|stab|stabs|stabbing|slash|slashes|slashing|shoot|shoots|shooting|swing|swings at|punch|punches|cast|casts \w+ at|fireball|charge|charges at|tackle|tackles|lunge|lunges at)\b/;
    if (ctx.inCombat || fight.test(t) || /\bdraws? (?:my|a|his|her|their) (?:sword|blade|bow|weapon|dagger|knife)\b/.test(t)) {
        result.category = ctx.inCombat || fight.test(t) ? 'combat_action' : 'risky_action';
        result.needsHelper = false;
        return result;
    }

    // Coin changing hands (buying, paying, asking a price, the room for the night): the DM sets the price
    // and sends the gold; left to an NPC's own line, the price is never paid on the books.
    if (!ctx.inCombat && TRADE_WORDS.test(t)) {
        result.category = 'risky_action';
        result.trade = true;
        result.needsHelper = true; // the helper still picks who answers; the category stands
        return result;
    }

    // Obvious risky attempts.
    if (/\b(try|tries|trying|attempt|attempts|attempting) to\b|\b(sneak|sneaks|sneaking|pick(?:s|ing)? the lock|lockpick|pickpocket|steal|steals|stealing|climb|climbs|climbing|jump|jumps|persuade|persuades|intimidate|intimidates|deceive|deceives|lie|lies to|bluff|bluffs|search(?:es|ing)? (?:for|the)|investigate|investigates|hide|hides|disarm|disarms|break(?:s)? (?:down|open)|force(?:s)? (?:the|it) open|sense motive|insight|grab|grabs|trip|trips|shove|shoves)\b/.test(t)) {
        result.category = 'risky_action';
        result.needsHelper = true; // helper can still downgrade, but default to DM
        return result;
    }

    return result;
}

/** Coin changing hands, in the words a shop hears: a price asked or named, coin counted out, the room for the night. */
const TRADE_WORDS = /\b(?:pay|pays|paying|paid|buy|buys|buying|bought|purchase|purchases|sell|sells|selling|sold|haggle|haggles|bargain|bargains|how much\b|what(?:'s| is| does| will) (?:it|that|this|the \w+) cost|what do (?:i|we) owe|name (?:your|the|a) price|the price|(?:count|counts|counting) out|coins?\b|purse|rooms? for the night|a room for the night|the (?:tab|bill)|settle up|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|fifty|a few|some|half a|a) (?:gp|sp|cp|gold|silver|copper|crowns?|marks?)\b|(?:i'?ll|we'?ll|i will|we will) take (?:the|a|an|one|two|three|it|that|those|them|both)\b)/;

/** Someone grabbing, tackling, pinning or holding someone (not a thing): the words of a contest. */
const CONTEST_WORDS = /\b(?:grab|grabs|grabbed|grabbing|seize|seizes|seized|tackle|tackles|tackled|tackling|pin|pins|pinned|pinning|wrestle|wrestles|wrestling|hold(?:s|ing)? (?:him|her|them|me|you|\w+) down|catch(?:es)? hold of|take(?:s)? hold of|lunge(?:s|d)? (?:for|at)|snatch(?:es)? at|collar(?:s|ed)?)\b (?:\w+ ){0,3}?(?:him|her|them|me|you|amber|judy|the (?:player|thief|constable|rabbit|hare|fox|man|woman|boy|girl)|\w+'s (?:arm|wrist|collar|coat|cloak|sleeve|shoulder|leg|ankle|hair|ear|ears|paw|scruff|throat|neck))\b/i;

/** A grab, a tackle, a hold on someone in this text (a hand on a thing isn't one: "grabs the ledger", "grabs the rope"). */
export function grabsSomeone(text) {
    const s = String(text || '').replace(/\(\(|\)\)/g, ' ');
    return CONTEST_WORDS.test(s) || /\b(?:tries|try|trying|tried|reaches|reaching|goes|going) to (?:grab|seize|tackle|pin|hold|catch|collar) (?:him|her|them|me|you|amber|judy)\b/i.test(s);
}

/**
 * Prompt for the local helper. Kept tiny, no thinking trigger.
 * @param {{player:string, message:string, recent:string, speakers:string[], scene:string, away?:string[], companions?:string[]}} p
 */
export function helperTriagePrompt({ player, message, recent, speakers, scene, away = [], companions = [] }) {
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
        '"category": one of "banter" (talking/roleplay, no risk), "action" (simple action, no real risk), "risky_action" (outcome uncertain: needs a dice roll or a ruling), "scene_move" (travel, rest, leave, time skip, going into or out of a building), "combat_action", "question" (asking about the world).',
        '"engaged": 0-3, how invested/playful the player seems right now.',
        '"stalled": true if the conversation is going in circles with no progress for several messages.',
        '"refusing": true if the player refuses, resists, dodges or bargains against what another character is asking or trying to make them do (even calmly).',
        speakers.length
            ? `"speakers": who would naturally reply next, 0, 1 or 2 names chosen ONLY from: ${speakers.map(s => JSON.stringify(s)).join(', ')}. Use [] when nobody nearby would answer (the player is acting alone, talking to themselves, or nothing calls for a reply). Nobody has to reply every time. While the player is just moving about, searching, or working a lock (not talking to anyone), companions usually say nothing: use [] unless the player speaks to them or something right in front of them is worth a quick word.`
            : '"speakers": [] (nobody is with the player right now).',
        away.length ? `Not with the player (can't hear or reply): ${away.join('; ')}.` : '',
        '"addressed": the name of the character the player is speaking to or acting toward (any name, even if not in that list), or "" if nobody in particular.',
        companions.length ? `"task": only if the player tells or asks a companion (${companions.map(s => JSON.stringify(s)).join(', ')}) to DO something now (not just talk): {"who": their name, "what": "a few words", "dm": true if what happens or what they find isn't known yet and the Dungeon Master has to decide it (searching, looking inside, checking for something, opening, picking a lock, sneaking, scouting, listening at a door, going to look at something and reporting back, anything that could need a dice roll), false for simple things whose result is obvious (follow me, wait here, sit down, hand me that, go stand over there)}. Otherwise "task": null.` : '',
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
    };
}

/** The companion task in the helper's reply ({who, what, dm}), or null. */
function parseTask(t) {
    if (!t || typeof t !== 'object' || typeof t.who !== 'string' || !t.who.trim()) return null;
    return {
        who: t.who.trim().slice(0, 60),
        what: String(t.what ?? '').trim().slice(0, 120),
        dm: t.dm === true || t.dm === 'true',
    };
}

/** Ask the helper whether a companion's own reply attempts something that needs a roll. */
export function companionActionPrompt({ name, message, scene }) {
    const system = 'You are a fast classifier for a tabletop roleplaying game. Reply with ONE line of JSON and nothing else.';
    const user = [
        `Scene: ${scene || 'unknown'}`,
        `${name} (a companion in the party) just wrote:`,
        message,
        '',
        `1. Does ${name} ATTEMPT something with an uncertain outcome that would need a dice roll in D&D: sneaking, stealing or slipping something, picking a lock, lying to someone, a hard climb or jump, attacking, casting a spell on someone, forcing something open? Talking, feelings, looking around, simple everyday actions and agreeing do NOT count.`,
        'JSON: {"attempt": true or false, "what": "a few words: what they try, or empty"}',
    ].join('\n');
    return { system, user };
}

export function parseCompanionAction(text) {
    const data = extractJson(text) || {};
    const attempt = data.attempt === true || data.attempt === 'true';
    return { attempt, what: attempt ? String(data.what ?? '').trim().slice(0, 120) : '' };
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
