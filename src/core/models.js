// Which Claude model handles a DM call: the big model (Sonnet) for moments that shape the story,
// the routine model (Haiku) for everything else. Pure module.

/** Why the DM gets called, with a plain label for the settings panel. */
export const DM_REASON_LABELS = Object.freeze({
    opening: 'Opening a campaign',
    scene_move: 'Travel, rests and time skips',
    event: 'Random events',
    drift: 'Steering back to the plot',
    stalled: 'Unsticking a stuck scene',
    combat_round: 'Combat rounds',
    combat_action: 'Your actions in combat',
    risky_action: 'Risky actions (sneak, lie, climb, attack)',
    roll_result: 'Narrating your roll results',
    npc_addressed: 'Talking to someone new',
    ooc: 'Out-of-character questions',
    checkin: 'Routine check-ins',
    manual: 'When you ask the DM to step in',
});

/**
 * Defaults: true = big model. The big model opens the story, keeps its direction (drift, stuck
 * scenes, check-ins) and runs every fight, including the turn that starts one. Everything else
 * goes to the routine model, which can hand a turn up when it's a real story moment (escalate).
 */
export const DEFAULT_BIG_REASONS = Object.freeze({
    opening: true,
    scene_move: false,
    event: false,
    drift: true,
    stalled: true,
    combat_round: true,
    combat_action: true,
    risky_action: false,
    roll_result: false,
    npc_addressed: false,
    ooc: false,
    checkin: true,
    manual: false,
});
export const DEFAULT_BIG_ON_CRITICAL = false;
export const MODEL_DEFAULTS_VERSION = 2;

/** v0.4.0's defaults, so saved settings that were never customized can move to the new ones. */
const V1_BIG_REASONS = Object.freeze({
    opening: true, scene_move: true, event: true, drift: true, stalled: true, combat_round: true,
    combat_action: false, risky_action: false, roll_result: false, npc_addressed: false, ooc: false, checkin: false, manual: true,
});

/**
 * Bring saved model-routing settings up to the current defaults, unless the player changed them.
 * @param {{bigReasons?:Record<string, boolean>, bigOnCritical?:boolean, modelDefaultsVersion?:number}} saved
 * @returns {boolean} true if anything changed
 */
export function migrateModelDefaults(saved) {
    if ((saved.modelDefaultsVersion ?? 1) >= MODEL_DEFAULTS_VERSION) return false;
    const untouched = Object.entries(V1_BIG_REASONS).every(([k, v]) => (saved.bigReasons?.[k] ?? v) === v) && saved.bigOnCritical !== false;
    if (untouched) {
        saved.bigReasons = { ...DEFAULT_BIG_REASONS };
        saved.bigOnCritical = DEFAULT_BIG_ON_CRITICAL;
    }
    saved.modelDefaultsVersion = MODEL_DEFAULTS_VERSION;
    return true;
}

/**
 * @param {string[]} reasons why the DM is being called
 * @param {{auto?:boolean, bigReasons?:Record<string, boolean>, criticalRoll?:boolean, bigOnCritical?:boolean}} opts
 * @returns {'big'|'routine'}
 */
export function pickDmTier(reasons, { auto = true, bigReasons = DEFAULT_BIG_REASONS, criticalRoll = false, bigOnCritical = DEFAULT_BIG_ON_CRITICAL } = {}) {
    if (!auto) return 'big';
    if (criticalRoll && bigOnCritical) return 'big';
    // A reason the settings don't know about (added in a later version) counts as big.
    return reasons.some(r => bigReasons[r] ?? true) ? 'big' : 'routine';
}

/** "claude-haiku-5-5" → "Haiku" for status lines and cost logs. */
export function modelLabel(id) {
    const s = String(id || '');
    for (const name of ['Haiku', 'Sonnet', 'Opus', 'Fable']) {
        if (s.toLowerCase().includes(name.toLowerCase())) return name;
    }
    return s || 'Claude';
}
