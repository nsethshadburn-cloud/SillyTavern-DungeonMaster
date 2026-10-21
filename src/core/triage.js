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
export function helperTriagePrompt({ player, message, recent, speakers, scene, away = [] }) {
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
        speakers.length
            ? `"speakers": who would naturally reply next, 0, 1 or 2 names chosen ONLY from: ${speakers.map(s => JSON.stringify(s)).join(', ')}. Use [] when nobody nearby would answer (the player is acting alone, talking to themselves, or nothing calls for a reply). Nobody has to reply every time.`
            : '"speakers": [] (nobody is with the player right now).',
        away.length ? `Not with the player (can't hear or reply): ${away.join('; ')}.` : '',
        '"addressed": the name of the character the player is speaking to or acting toward (any name, even if not in that list), or "" if nobody in particular.',
        'Example: {"category":"banter","engaged":2,"stalled":false,"speakers":["Judy Hopps"],"addressed":"Judy Hopps"}',
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
        speakers: picked.filter(s => speakers.some(x => x.toLowerCase() === s.toLowerCase())).slice(0, 2),
        addressed: typeof data.addressed === 'string' ? data.addressed.trim().slice(0, 60) : '',
    };
}
