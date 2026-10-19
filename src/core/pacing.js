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
        fun: 1,                    // smoothed engagement 0..3
        stalledStreak: 0,
        driftStage: 0,             // 0 lean in, 1 soft hooks, 2 firm hooks
        beatsThisScene: 0,
        inCombat: false,
    };
}

/** Drift budget (player turns away from the plot before each hook stage), by campaign feel. */
export function driftBudget(length = 'breathe') {
    switch (length) {
        case 'short': return { soft: 6, firm: 12 };
        case 'long': return { soft: 12, firm: 22 };
        case 'breathe':
        default: return { soft: 16, firm: 30 };
    }
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

/** Call once per player turn, before deciding anything. */
export function tickPlayerTurn(pacing, length) {
    pacing.turnsInScene++;
    pacing.turnsSinceBeat++;
    pacing.turnsSinceEvent++;
    const budget = driftBudget(length);
    pacing.driftStage = pacing.turnsSinceBeat >= budget.firm ? 2 : pacing.turnsSinceBeat >= budget.soft ? 1 : 0;
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
    if (triage.stalled) reasons.push('stalled');
    if (triage.unknownAddressee) reasons.push('npc_addressed');
    if (pacing.driftStage > lastDriftStageCalled) reasons.push('drift');
    let every = Math.max(3, Number(checkinEvery) || 10);
    if (budgetTight) every *= 2;
    if (pacing.fun >= 2.2) every = Math.round(every * 1.5);
    if (pacing.localTurnsSinceDM >= every) reasons.push('checkin');
    return [...new Set(reasons)];
}

/** Apply the DM's pacing-relevant output. */
export function applyDmPacing(pacing, dm) {
    pacing.localTurnsSinceDM = 0;
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
        pacing.beatsThisScene += beats.length;
    }
    if (dm.start_combat) pacing.inCombat = true;
    if (dm.end_combat) pacing.inCombat = false;
    if (dm.scene?.type === 'combat') pacing.inCombat = true;
    else if (dm.scene?.type && dm.scene.type !== 'combat' && dm.scene.changed) pacing.inCombat = false;
}

/** Human-readable pacing summary for the DM prompt. */
export function pacingReport(pacing, { length = 'breathe', sessionMinutes = 0, usualSessionMinutes = 90 } = {}) {
    const budget = driftBudget(length);
    const recent = [...pacing.sceneHistory.slice(-5), pacing.sceneType];
    const lines = [
        `Current scene type: ${pacing.sceneType} (for ${pacing.turnsInScene} player turns). Recent scene types, oldest→newest: ${recent.join(' → ')}.`,
        `Tension: ${pacing.tension}/10.`,
        `Player turns since a plot beat was completed: ${pacing.turnsSinceBeat} (soft hooks from ${budget.soft}, firm hooks from ${budget.firm}). Drift stage: ${['lean in', 'soft hooks', 'firm hooks'][pacing.driftStage]}.`,
        `Player engagement (0–3, smoothed): ${pacing.fun}${pacing.fun >= 2.2 ? ' — HIGH: let the moment breathe, no new plot pressure' : ''}.`,
        `Major beats completed in this scene: ${pacing.beatsThisScene} (max 1 per scene).`,
        `Combat: ${pacing.inCombat ? 'IN COMBAT' : 'no'}.`,
    ];
    if (sessionMinutes > 0) {
        const left = usualSessionMinutes - sessionMinutes;
        lines.push(`Tonight's session has run ${Math.round(sessionMinutes)} min (usual ~${usualSessionMinutes}).${left < 20 ? ' Start steering toward a satisfying stopping point (cliffhanger or campfire).' : ''}`);
    }
    return lines.join('\n');
}

function round2(n) {
    return Math.round(n * 100) / 100;
}
