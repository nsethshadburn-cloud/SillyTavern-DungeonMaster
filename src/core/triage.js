// Triage: classify the player's message, cheaply.
// Code rules first; the local helper model only when the rules can't tell.
// Pure module (no SillyTavern imports).

import { parsePlayerRoll } from './dice.js';
import { extractJson } from './text.js';

export const CATEGORIES = ['banter', 'action', 'risky_action', 'scene_move', 'combat_action', 'question'];

/**
 * Rule-based triage. Returns a partial result; `needsHelper` says whether the helper should refine it.
 * @param {string} text the player's message
 * @param {{pendingRoll?: object|null, inCombat?: boolean}} ctx
 */
export function ruleTriage(text, ctx = {}) {
    const raw = String(text ?? '').trim();
    const t = raw.toLowerCase();
    const result = { category: null, ooc: false, oocText: '', rollResult: false, roll: null, needsHelper: true };

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
        const parsed = parsePlayerRoll(raw, sides);
        if (parsed && (raw.length < 80 || /\broll|rolled|nat\b/i.test(raw))) {
            result.rollResult = true;
            result.roll = parsed;
            result.category = ctx.inCombat ? 'combat_action' : 'action';
            result.needsHelper = false;
            return result;
        }
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
            ? `"speakers": who would naturally reply next, 0, 1 or 2 names chosen ONLY from: ${speakers.map(s => JSON.stringify(s)).join(', ')}. Use [] when nobody nearby would answer (the player is acting alone, talking to themselves, or nothing calls for a reply). Nobody has to reply every time.`
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

export function parseCompanionAction(text, places = []) {
    const data = extractJson(text) || {};
    const attempt = data.attempt === true || data.attempt === 'true';
    const go = String(data.go ?? '').trim();
    const ok = places.some(p => p.id === go);
    const pose = String(data.pose ?? '').trim().toLowerCase();
    const stance = String(data.stance ?? '').trim().toLowerCase();
    return {
        attempt, what: attempt ? String(data.what ?? '').trim().slice(0, 120) : '', go: ok ? go : '',
        ...(ok && (data.hide === true || data.hide === 'true') ? { hide: true } : {}),
        ...(ok && ['sit', 'lie', 'sleep'].includes(pose) ? { pose } : {}),
        ...(['close', 'follow', 'stay'].includes(stance) ? { stance } : {}),
    };
}
