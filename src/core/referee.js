// The referee: one-word rulings on what a line means, for the custody machine (core/custody.js).
// A small, fast model (Haiku by default) answers with a single word from a short list; no JSON, no
// explanation. Pure: prompts and the parser only. The call is made in st/custody.js.

export const REFEREE_SYSTEM = 'You referee a tabletop roleplaying game. Reply with exactly ONE word from the list you are given, lowercase, and nothing else.';

const quote = s => `"${String(s || '').replace(/\s+/g, ' ').trim().slice(0, 700)}"`;

/**
 * What the player's line does about their keeper.
 * Words: run | along | give | trip | hide | none
 */
export function playerLinePrompt({ keeper, player, text, mode, chase }) {
    return [
        `${keeper} holds ${player} prisoner (cuffed or tied). Right now ${mode === 'companion' ? `${keeper} is going along with ${player} wherever ${player} walks` : `${keeper} has told ${player} to stay close`}.${chase ? ` ${keeper} is chasing ${player}, who is getting away.` : ''}`,
        `${player}'s line: ${quote(text)}`,
        '',
        `Which ONE word fits what ${player} does in that line?`,
        `run - ${player} runs, bolts, flees, sprints or breaks away FROM ${keeper} right now, as an action (not a boast, threat or plan about escaping later; not walking with her; not a figure of speech like "runs a hand along")`,
        `along - ${player} asks ${keeper} to come along with him or leads her somewhere he chooses (not a question about where to go, not "lead on", not walking on alone)`,
        `give - ${player} gives in, surrenders, stops resisting, agrees to go where ${keeper} takes him`,
        `trip - ${player} trips, sweeps, shoves, tackles or throws ${keeper} down (an attempt, not a threat or a thought)`,
        `hide - ${player} hides, ducks behind cover, drops flat or goes still so as not to be seen (not running)`,
        `none - anything else (talk, a question, a threat, a boast or a taunt, an action that isn't about getting away from ${keeper})`,
        'Word:',
    ].join('\n');
}

/**
 * What the keeper's line does about her prisoner.
 * Words: stay | along | none
 */
export function keeperLinePrompt({ keeper, player, text, chase }) {
    return [
        `${keeper} holds ${player} prisoner (cuffed or tied).${chase ? ` ${player} is running from her and she is after him.` : ''} ${keeper} just said:`,
        quote(text),
        '',
        'Which ONE word fits what she tells him?',
        `stay - she tells ${player} to stay put, sit, stop, not move, hold still or come back; or keeps him in place, shortens the rope, tightens her hold, or marches him on under her control ("Move.", "Walk.", "Keep up.")`,
        `along - she lets ${player} walk where HE likes, lets him lead or choose the way, follows him, or calls off chasing him (only when she is clearly giving up control of where they go)`,
        'none - neither (talk, questions, feelings, a warning, a taunt, a threat, or "I\'m coming" while chasing him)',
        'Word:',
    ].join('\n');
}

/**
 * Does a companion take hold of the player in this text (the DM's narration, or the player's aside)?
 * Words: yes | no
 */
export function grabPrompt({ keeper, player, text }) {
    return [
        `In a tabletop game, ${keeper} is a companion and ${player} is the player's character. This text was just written:`,
        quote(text),
        '',
        `Does ${keeper} grab, seize, tackle, pin or take hold of ${player} in it (an attempt counts; "tries to grab" counts; grabbing a rope, a bag or someone else does not; a hold already in place from before does not)?`,
        'yes - she goes for him now',
        'no - she does not',
        'Word:',
    ].join('\n');
}

/** The first word of the reply, if it's one of the allowed ones; else the last allowed word (the "nothing" answer). */
export function parseWord(reply, allowed) {
    const w = String(reply || '').toLowerCase().match(/[a-z]+/)?.[0] || '';
    return allowed.includes(w) ? w : allowed[allowed.length - 1];
}
