// Pacing: scene rhythm, tension, drift budget, fun detection, and
// the decision of when the DM (Claude) should step in.
// Pure module (no SillyTavern imports).

export const SCENE_TYPES = ['social', 'exploration', 'tension', 'combat', 'downtime'];

export function createPacingState() {
    return {
        tension: 2,
        sceneType: 'exploration',
        sceneHistory: [],          // last scene types, most recent last
        turnsInScene: 0,
        turnsSinceBeat: 0,         // player turns since a plot beat was completed
        turnsSinceEvent: 0,
        localTurnsSinceDM: 0,
        worldClock: null,          // player turns until the world acts on its own (set by the DM's "world_next")
        fun: 1,                    // smoothed engagement 0..3
        stalledStreak: 0,
        fillerStreak: 0,           // player messages in a row that were short filler (stall detection)
        driftStage: 0,             // plot pressure stage, see PRESSURE_STAGES
        pressureCallAge: 0,        // player turns since the DM was last called about plot pressure
        beatsThisScene: 0,
        inCombat: false,
    };
}

/** Plot pressure, from "play along" to "the plot takes them back". */
export const PRESSURE_STAGES = Object.freeze([
    { name: 'lean in', guide: 'Play along with what the party is doing.' },
    { name: 'hints', guide: 'Let the plot show up in the background: rumors, signs, news, a familiar face.' },
    { name: 'pursuit', guide: 'The plot comes looking for them: messengers, hunters on the trail, doors closing behind them.' },
    { name: 'pressure', guide: 'Direct threats and close calls. Their options narrow and resisting the plot starts to cost them.' },
    { name: 'force', guide: 'An overwhelming but fair turn of events puts the plot back on track (a much larger force, a trap they walk into, an offer they can\'t refuse). Set it up in the fiction first; never ignore good rolls or invent impossible odds out of nowhere.' },
]);

/** Player turns without a plot beat before each pressure stage (1..4), by campaign feel. */
export function driftBudget(length = 'breathe') {
    switch (length) {
        case 'short': return [6, 10, 14, 18];
        case 'long': return [10, 16, 22, 28];
        case 'breathe':
        default: return [12, 20, 28, 36];
    }
}

/** At the top pressure stages, the DM is called again this often (player turns) until a beat lands. */
export const PRESSURE_RECALL_TURNS = 4;
/** This many filler messages in a row counts as a stall. */
export const STALL_FILLER_STREAK = 3;

const FILLER_WORDS = /^(ok(ay)?|k|fine|sure|yeah|yep|yes|no|nope|alright|right|cool|go|lets go|let's go|lets do it|let's do it|uh huh|hm+|huh|whatever|done|good|great|nice|thanks|ty|same|agreed|follow( (him|her|them|me))?|wait|continue|keep going)\b/i;
const FILLER_ACTIONS = /\b(nods?|shrugs?|sighs?|follows?|complies|complys|waits?|sits?|sitting|silence|silently|stays? quiet|agrees?|smirks?|yawns?|rests?|sleeps?|walks? (along|on|with)|keeps? (walking|going|riding))\b/i;

/**
 * Is this player message low-content filler (no question, no plan, nothing new)?
 * Questions and anything with substance are never filler.
 * @param {string} text
 * @param {number|null} engaged the helper's 0..3 engagement guess, if any
 */
export function isFillerMessage(text, engaged = null) {
    const t = String(text ?? '').replace(/[*_~]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    if (t.includes('?')) return false;
    const words = t.split(' ').filter(Boolean).length;
    if (words <= 3) return true;
    if (words <= 8 && (FILLER_WORDS.test(t) || FILLER_ACTIONS.test(t))) return true;
    if (words <= 8 && engaged !== null && Number(engaged) <= 0) return true;
    return false;
}

/** The first unticked beat in the plot checklist ("- [ ] A2.1 description"), or null. */
export function nextBeat(plot) {
    const m = String(plot ?? '').match(/^\s*[-*]\s*\[\s\]\s*(A\d+\.\d+)\s*[:.\-–]?\s*(.+)$/m);
    return m ? { id: m[1], text: m[2].trim() } : null;
}

/**
 * Update the fun estimate from a player message and the helper's 0..3 engagement guess.
 * Long messages and in-character roleplay push it up; terse ones pull it down.
 */
export function updateFun(pacing, { engaged = null, messageLength = 0 } = {}) {
    let signal = 1;
    if (messageLength > 400) signal = 2.6;
    else if (messageLength > 180) signal = 2;
    else if (messageLength > 60) signal = 1.3;
    else signal = 0.8;
    if (engaged !== null && Number.isFinite(Number(engaged))) {
        signal = (signal + Number(engaged)) / 2;
    }
    pacing.fun = round2(pacing.fun * 0.65 + signal * 0.35);
    return pacing.fun;
}

/**
 * Call once per player turn (not for typed roll results), before deciding anything.
 * Plot pressure climbs at most one stage per turn, and holds while the player is
 * genuinely engaged in conversation (high fun), so quiet moments and travel chat aren't rushed.
 * @param {{filler?:boolean}} o filler = this message was low-content filler (isFillerMessage)
 */
export function tickPlayerTurn(pacing, length, { filler = false, chatting = false } = {}) {
    // Real conversation lets the moment breathe: the world's clock runs at half speed.
    if (Number.isFinite(pacing.worldClock)) pacing.worldClock -= chatting ? 0.5 : 1;
    pacing.turnsInScene++;
    pacing.turnsSinceBeat++;
    pacing.turnsSinceEvent++;
    pacing.pressureCallAge = (pacing.pressureCallAge ?? 0) + 1;
    pacing.fillerStreak = filler ? (pacing.fillerStreak ?? 0) + 1 : 0;
    const thresholds = driftBudget(length);
    const target = thresholds.filter(n => pacing.turnsSinceBeat >= n).length;
    const current = pacing.driftStage ?? 0;
    if (pacing.fun >= 2.2) pacing.driftStage = Math.min(target, current);
    else pacing.driftStage = Math.min(target, current + 1);
}

/**
 * Should the DM be called this turn? Returns the reasons (empty = stay local).
 * @param {object} p
 * @param {ReturnType<typeof createPacingState>} p.pacing
 * @param {{category?:string, ooc?:boolean, rollResult?:boolean, stalled?:boolean}} p.triage
 * @param {boolean} p.eventDue
 * @param {number} p.checkinEvery
 * @param {boolean} p.budgetBlocked
 * @param {boolean} p.budgetTight
 * @param {number} p.lastDriftStageCalled
 */
export function dmReasons({ pacing, triage, eventDue, checkinEvery, budgetBlocked, budgetTight, lastDriftStageCalled = 0 }) {
    if (budgetBlocked) return [];
    const reasons = [];
    if (triage.ooc) reasons.push('ooc');
    if (triage.rollResult) reasons.push('roll_result');
    if (['risky_action', 'scene_move', 'combat_action'].includes(triage.category)) reasons.push(triage.category);
    if (pacing.inCombat && triage.category !== 'banter') reasons.push('combat_round');
    if (eventDue) reasons.push('event');
    if (triage.stalled || (pacing.fillerStreak ?? 0) >= STALL_FILLER_STREAK) reasons.push('stalled');
    if (triage.unknownAddressee) reasons.push('npc_addressed');
    if (pacing.driftStage > lastDriftStageCalled) reasons.push('drift');
    // At the top stages, keep the pressure on until a beat lands (but not mid-conversation).
    else if (pacing.driftStage >= 3 && (pacing.pressureCallAge ?? 0) >= PRESSURE_RECALL_TURNS && pacing.fun < 2.2) reasons.push('drift');
    // The world acts on its own clock: the DM sets how many player turns until it moves again
    // (world_next); before the DM has set one, every `checkinEvery` local turns.
    let worldDue;
    if (Number.isFinite(pacing.worldClock)) {
        worldDue = pacing.worldClock <= (budgetTight ? -2 : 0);
    } else {
        let every = Math.max(1, Number(checkinEvery) || DEFAULT_WORLD_EVERY);
        if (budgetTight) every *= 2;
        worldDue = pacing.localTurnsSinceDM >= every;
    }
    if (worldDue) reasons.push('checkin');
    return [...new Set(reasons)];
}

/** Default player turns between the world's own moves when the DM hasn't set a pace. */
export const DEFAULT_WORLD_EVERY = 5;

/**
 * Apply the DM's pacing-relevant output.
 * @param {{worldEvery?:number}} [o] worldEvery = the pace to use when the DM doesn't set "world_next"
 */
export function applyDmPacing(pacing, dm, { worldEvery = DEFAULT_WORLD_EVERY } = {}) {
    pacing.localTurnsSinceDM = 0;
    const next = Number(dm.world_next);
    pacing.worldClock = Math.min(10, Math.max(1, Math.round(Number.isFinite(next) && next > 0 ? next : (Number(worldEvery) || DEFAULT_WORLD_EVERY))));
    if (dm.scene?.type && SCENE_TYPES.includes(dm.scene.type)) {
        const changed = dm.scene.type !== pacing.sceneType || (dm.scene.changed && pacing.turnsInScene > 0);
        if (changed) {
            pacing.sceneHistory.push(pacing.sceneType);
            if (pacing.sceneHistory.length > 12) pacing.sceneHistory.shift();
            pacing.sceneType = dm.scene.type;
            pacing.turnsInScene = 0;
            pacing.beatsThisScene = 0;
        }
    }
    if (Number.isFinite(Number(dm.tension))) {
        pacing.tension = Math.min(10, Math.max(0, Math.round(Number(dm.tension))));
    }
    const beats = Array.isArray(dm.beats_completed) ? dm.beats_completed.filter(Boolean) : [];
    if (beats.length) {
        pacing.turnsSinceBeat = 0;
        pacing.driftStage = 0;
        pacing.pressureCallAge = 0;
        pacing.beatsThisScene += beats.length;
    }
    if (dm.start_combat) pacing.inCombat = true;
    if (dm.end_combat) pacing.inCombat = false;
    if (dm.scene?.type === 'combat') pacing.inCombat = true;
    else if (dm.scene?.type && dm.scene.type !== 'combat' && dm.scene.changed) pacing.inCombat = false;
}

/** Human-readable pacing summary for the DM prompt. */
export function pacingReport(pacing, { length = 'breathe', sessionMinutes = 0, usualSessionMinutes = 90, plot = '', worldEvery = DEFAULT_WORLD_EVERY } = {}) {
    const thresholds = driftBudget(length);
    const recent = [...pacing.sceneHistory.slice(-5), pacing.sceneType];
    const stage = Math.min(pacing.driftStage ?? 0, PRESSURE_STAGES.length - 1);
    const beat = nextBeat(plot);
    const engagedChat = pacing.fun >= 2.2;
    const lines = [
        beat ? `NEXT BEAT: ${beat.id} ${beat.text}. Tick it in beats_completed as soon as its goal is reached, even if it happened differently than planned.` : 'NEXT BEAT: none left (the plot is complete or empty).',
        `Player turns since a plot beat was completed: ${pacing.turnsSinceBeat} (pressure rises at ${thresholds.join(', ')}).`,
        `PLOT PRESSURE: stage ${stage} of 4, "${PRESSURE_STAGES[stage].name}": ${PRESSURE_STAGES[stage].guide}${engagedChat && stage > 0 ? ' (Holding: the player is engaged in real conversation, so let it play out first.)' : ''}`,
        `WORLD PACE: the player's normal pace is every ${worldEvery} player turns. Set world_next to ${worldEvery} normally, 1-2 while people are actively doing things to or around the party, and longer (up to 10) only for genuinely quiet moments.`,
        `Current scene type: ${pacing.sceneType} (for ${pacing.turnsInScene} player turns). Recent scene types, oldest→newest: ${recent.join(' → ')}.`,
        `Tension: ${pacing.tension}/10.`,
        `Player engagement (0–3, smoothed): ${pacing.fun}${engagedChat ? ' — HIGH: they are enjoying the conversation; let it breathe and keep narration light' : ''}.`,
        `Combat: ${pacing.inCombat ? 'IN COMBAT' : 'no'}.`,
    ];
    if ((pacing.fillerStreak ?? 0) >= 2) {
        lines.push(`STALL: the player's last ${pacing.fillerStreak} messages were short filler with no questions or plans. Move the scene on yourself: skip ahead, arrive somewhere, or have someone or something push in.`);
    }
    if (sessionMinutes > 0) {
        const left = usualSessionMinutes - sessionMinutes;
        lines.push(`Tonight's session has run ${Math.round(sessionMinutes)} min (usual ~${usualSessionMinutes}).${left < 20 ? ' Start steering toward a satisfying stopping point (cliffhanger or campfire).' : ''}`);
    }
    return lines.join('\n');
}

function round2(n) {
    return Math.round(n * 100) / 100;
}
