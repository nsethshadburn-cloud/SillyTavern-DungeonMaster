// The referee (Claude, a small prompt): rules on the mechanics of one turn and writes no prose.
// It sees its rules, the party's numbers, the NPCs met, where things stand, the last few messages
// and the player's line; it answers with rolls, acts, changes, the scene and the fight (core/protocol.js
// normalizeRuling). The code then does what the ruling says.

import { settings } from './settings.js';
import { callClaude } from './llm.js';
import { campaign } from './campaign.js';
import { statsForName } from './sheets.js';
import { refereeRules, parseRuling, rulingToTurn } from '../core/protocol.js';
import { rosterSummary, lookupModifier } from '../core/world.js';
import { trimToTokens, nameKey, matchName } from '../core/text.js';
import { modelLabel } from '../core/models.js';
import { stateBlock, statsLines, transcript, logCost } from './dm.js';

/** Why the referee is being called, in its own terms: what to rule on this turn. */
const REASON_TEXT = {
    ooc: 'The player spoke out of character. A rules question: answer it in "ooc". A request about the scene (an enemy breaks and runs, a lull, skip ahead): grant it unless it breaks the story, by the rules (a grab is still a contest), and put what changed in "changes", "scene", "clock" or "fight".',
    roll_result: 'The player rolled for the last request; ROLL RESULT says how it went. Rule what came of it: "fact" says what is now true (the lock gives; the hold breaks; the blow lands and the code asks for damage), with any "changes" it causes (a condition on or off, an item taken). Ask no new roll unless the result itself calls for one.',
    risky_action: 'The player attempts something with an uncertain outcome (a lock, a climb, a lie, a theft, a search). Rule it: a roll in "rolls" with "why" (the attempt, never its outcome), or a plain success in "fact" when their numbers or the stakes make a roll pointless.',
    trade: 'Coin is changing hands: the player is buying, selling, paying or asking a price. Set the price in "fact"; when the player pays, book it NOW: changes.gold (negative for paying) and items_add / items_remove the same turn.',
    round_opens: 'The initiative is in and round 1 opens. WHO MUST ACT NOW lists those who beat the player; give each an entry in "acts" (COMPANION CHOICES as given). Nobody else acts; the player\'s own first action is asked for on their turn.',
    scene_move: 'The player moves the scene (travel, rest, leave, go into or out of a place, a time skip). Put them there: "scene" with "moved": true, the new location and the FULL card (place, people with spots, objects); "clock" for time that passes; "rest" when they rest.',
    combat_action: 'A combat action. If no fight is on yet, this starts one: fight.start (the enemies by name, with a map or none) and one roll, kind "initiative", for the player; nothing else this turn. In a fight on the player\'s turn: rule only what the player did (their attack as a roll with its target; a move in "moves").',
    combat_round: 'A fight is on and the round runs. WHO MUST ACT NOW lists who acts in this reply: an entry in "acts" for each. The player\'s own action, if their line has one, is a roll.',
    player_turn: 'It is the PLAYER\'s turn and they just acted. Rule ONLY what the player did: their attack or action as a roll, their move in "moves". Nobody else acts: no "acts" at all. The code then asks the player whether their turn is done.',
    end_turn: 'The player ENDS their turn. WHO MUST ACT NOW lists everyone who acts before the player\'s next turn (those after them this round, then those before them next round): an entry in "acts" for EACH name, every one. Never ask the player for a roll of something they did not do.',
    reaction: 'The player REACTS to a hit before its damage lands (the REACTION line says what). Rule on it: what damage is left goes in changes.hp (the code has NOT applied it), and "fact" says what happened.',
    event: 'The storyteller may add a random event this turn; nothing for you to rule unless it needs dice.',
    deadlock: 'A character has been refused several times and will change approach; if the new approach is force, it is a contest or a fight: rule it.',
    stalled: 'The scene has stalled; the storyteller will move it. Rule only what the player\'s line needs.',
    drift: 'The storyteller applies plot pressure this turn. Rule only what the player\'s line needs.',
    npc_addressed: 'The player is talking to someone not on the NPC list; put them on the scene card ("scene": people and spots) if they are there.',
    companion_task: 'The player told a companion to do something (COMPANION TASK). Decide what it takes: a roll for the companion in "rolls" (Investigation to search, Perception to look or listen, Stealth, Sleight of Hand, Thieves\' Tools...) with both outcomes, or "fact" with what they find when no roll is needed; and move their spot in "scene".',
    contest: 'Someone grabs, tackles, pins or holds someone in this line. That is a CONTEST: a roll of kind "contest" now (the player\'s side if they are in it, with "vs" for the other side; both sides as NPC rolls if not). Nothing holds anyone until it is rolled.',
    companion_action: 'A companion attempted something risky in their own reply (COMPANION ATTEMPT). Rule it like a player\'s action: a roll for them in "rolls" against a DC or the right opponent (the player\'s passive Perception for something covert), or "fact" when it needs no roll.',
    solo: 'The player is alone, or nobody nearby would answer; the storyteller responds as the world. Rule only what the player\'s line needs.',
    checkin: 'The world moves on by itself this turn (the storyteller tells it). Rule only what the player\'s line needs; if the storyteller\'s world would need dice, it says so next turn.',
    opening: 'The campaign opens; nothing to rule.',
    manual: 'The player asked the table to step in. Rule whatever their line needs.',
};

/**
 * The referee's prompt: its rules and the party's numbers (stable), the NPCs met (a layer), and
 * everything that changes every turn.
 */
export function refereePrompt({ reasons, playerMessage = '', rollResolution = '', oocText = '', placeEvent = '', companionAction = null, companionTask = null, companionChoices = null, mustAct = [], again = [] }) {
    const c = campaign();
    const s = settings();
    const system = [refereeRules(s.mapTier), '', '# THE PARTY\'S NUMBERS (the player first; the code adds these bonuses to their rolls)', statsLines()].join('\n');
    const layers = [['# NPCS MET (stat blocks in brackets; use them for enemies and their dice)', c.docs.npcs?.length ? rosterSummary(c.docs.npcs) : '(none yet)'].join('\n')];
    const sections = [stateBlock({ forReferee: true })];
    sections.push('', '# RECENT CHAT (oldest first)', transcript(Math.min(8, Number(s.recentMessages) || 8)) || '(empty)');
    sections.push('', '# WHAT TO RULE ON');
    for (const r of reasons) sections.push(`- ${REASON_TEXT[r] ?? r}`);
    if (oocText) sections.push('', `Player's out-of-character line: ${oocText}`);
    if (c.meta.turnProblems?.length) sections.push('', `WHAT DIDN'T TAKE LAST TURN (the code dropped these). Use the exact names in the state above, and never claim what the books don't show:\n${c.meta.turnProblems.map(p => `- ${p}`).join('\n')}`);
    if (rollResolution) sections.push('', `ROLL RESULT: ${rollResolution}`);
    if (placeEvent) sections.push('', placeEvent);
    if (playerMessage) sections.push('', `The player's latest message: ${trimToTokens(playerMessage, 800)}`);
    if (companionTask) sections.push('', `COMPANION TASK: the player told ${companionTask.name} to ${companionTask.what || 'do something'}.`);
    if (companionAction) sections.push('', `COMPANION ATTEMPT: ${companionAction.name} tries to ${companionAction.what || 'do something risky'}. Their reply: ${trimToTokens(companionAction.text, 500)}`);
    if (mustAct.length) sections.push('', `WHO MUST ACT NOW (an entry in "acts" for each, by this exact name; nobody else): ${mustAct.join(', ')}.`);
    if (companionChoices && Object.keys(companionChoices).length) sections.push('', `COMPANION CHOICES this round (each companion decided their own turn; put each in "acts" exactly as given; don't choose for them): ${Object.entries(companionChoices).map(([n, ch]) => `${n}: ${ch.action}${ch.target ? ` ${ch.target}` : ''}${ch.weapon ? ` with ${ch.weapon}${ch.damage ? ` (${ch.damage})` : ''}` : ''}${ch.item ? ` (${ch.item})` : ''}${ch.where ? ` (${ch.where})` : ''}${ch.why ? `; ${ch.why}` : ''}`).join(' | ')}.`);
    if (again.length) sections.push('', `YOUR LAST REPLY LEFT OUT ${again.join(', ')}: they were listed under WHO MUST ACT NOW and had no entry in "acts". Reply again with an entry for each of them (and everything else as before).`);
    if (Number.isFinite(c.meta.pacing?.calmUntil) && c.meta.turn < c.meta.pacing.calmUntil) sections.push('', `CALM (${c.meta.pacing.calmUntil - c.meta.turn} more turn(s)): the story breathes after what just happened. No new people, no alarm, no attack.`);
    sections.push('', 'Reply with the JSON object only.');
    return { system, layers, user: sections.join('\n') };
}

/** Who the referee must give an act this turn: the living enemies in the order who are due, by name (the code lists them; the referee answers per name). */
export function dueToAct(c, { reasons, opening = null }) {
    const cb = c.docs.world.combat;
    if (!cb) return [];
    if (reasons.includes('roll_result') && !reasons.includes('round_opens')) return [];
    if (reasons.includes('reaction') || reasons.includes('player_turn')) return [];
    const living = Object.keys(cb.enemies || {}).filter(n => !(cb.enemies[n].hp <= 0) && cb.order.some(o => o.name === n));
    if (reasons.includes('round_opens') && opening) return living.filter(n => (opening.names || []).some(x => nameKey(x) === nameKey(n)));
    if (reasons.includes('end_turn') || reasons.includes('combat_round')) return living;
    return [];
}

/** The ruling → the turn the code applies, with the party's bonuses and the NPCs' stat blocks filled in. */
export function turnFromRuling(c, ruling) {
    const meta = c.meta;
    const party = meta.party.map(p => p.name);
    return rulingToTurn(ruling, {
        player: meta.persona.name,
        party,
        bonusFor: (name, req) => {
            const who = matchName(name, [meta.persona.name, ...party]);
            if (!who) return null;
            const stats = statsForName(who, meta);
            return stats ? lookupModifier(stats, { kind: req.kind, skill: req.skill || '', ability: req.ability || '' }).mod : null;
        },
        foeStats: name => {
            const foes = c.docs.world.combat?.enemies ?? {};
            const foe = foes[matchName(name, Object.keys(foes)) ?? ''];
            const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name)) ?? (c.docs.npcs || []).find(n => matchName(name, [n.name]));
            const stats = String(npc?.stats || '');
            const toHit = /([+-]\s*\d+)\s*to hit/i.exec(stats)?.[1];
            const dice = foe?.damage || /\b\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(stats)?.[0]?.replace(/\s+/g, '') || '';
            if (!foe && !npc) return null;
            return { toHit: toHit ? Number(toHit.replace(/\s+/g, '')) : null, damage: dice };
        },
    });
}

/**
 * One referee call: the ruling, parsed, with one retry for invalid JSON and one for names it left out
 * of "acts" when they had to act. Returns the turn the code applies (turnFromRuling) and the cost.
 * @returns {Promise<{turn: object, ruling: object, usd: number, model: string}>}
 */
export async function askReferee(args, { label = 'referee', signal = null, model = '' } = {}) {
    const c = campaign();
    let prompt = refereePrompt(args);
    let reply = await callClaude({ ...prompt, model, label, signal });
    let usd = reply.usd;
    let ruling = parseRuling(reply.text);
    if (!ruling) {
        reply = await callClaude({ system: prompt.system, layers: prompt.layers, user: `${prompt.user}\n\nYour previous reply was not valid JSON. Reply with ONE valid JSON object only.`, model, label: `${label} (retry)`, signal });
        usd += reply.usd;
        ruling = parseRuling(reply.text);
    }
    if (!ruling) {
        logCost(`${label} (unusable reply) · ${modelLabel(reply.model)}`, usd);
        throw new Error('The referee did not return a usable answer.');
    }
    // Everyone who had to act gets an entry (a move or "gone" counts), or the referee is asked once more for
    // the ones it skipped; a ruling that ends the fight owes nobody a turn.
    const acted = n => Object.keys(ruling.acts).some(a => nameKey(a) === nameKey(n) || matchName(a, [n])) || Object.keys(ruling.moves).some(a => nameKey(a) === nameKey(n) || matchName(a, [n]));
    const missing = ruling.fight?.end ? [] : (args.mustAct || []).filter(n => !acted(n));
    if (missing.length) {
        prompt = refereePrompt({ ...args, again: missing });
        const second = await callClaude({ ...prompt, model, label: `${label} (acts for ${missing.join(', ')})`, signal });
        usd += second.usd;
        const again = parseRuling(second.text);
        if (again) ruling = again;
        for (const n of missing) if (!acted(n) && !ruling.fight?.end) ruling.acts[n] = { do: 'hold', target: '', weapon: '', to_hit: null, damage: '', move: '', skill: '', ability: '', dc: null, why: 'holds (the referee gave no action)', on_success: '', on_fail: '', half: false, spot: null };
    }
    logCost(`${label} · ${modelLabel(reply.model)}`, usd);
    return { turn: turnFromRuling(c, ruling), ruling, usd, model: reply.model };
}
