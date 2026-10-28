// Which Claude model does each job. With hybrid mode on, every job has its own model (Sonnet for
// setup, story direction and combat; Haiku for everyday play by default). With it off, the main
// DM model does everything. Pure module.

export const DEFAULT_MAIN_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_LIGHT_MODEL = 'claude-haiku-5-5';

/**
 * Every job Claude does, in the order the settings panel shows them.
 * key = the DM call reason (core/pacing.js dmReasons) or a non-turn job; main = uses the main model by default.
 */
/** Everyday jobs that moved to the light model in v0.24 (they hand up to the main model for big moments). */
export const LIGHT_V24 = Object.freeze(['checkin', 'combat_action', 'combat_round', 'risky_action', 'roll_result', 'scene_move', 'event', 'companion_task', 'companion_action', 'sprite']);

export const TASKS = Object.freeze([
    { key: 'campaign_design', group: 'Setup', label: 'Designing a new campaign', main: true },
    { key: 'pitches', group: 'Setup', label: 'Pitching story ideas', main: true },
    { key: 'opening', group: 'Setup', label: 'The opening scene', main: true },
    { key: 'persona_sheet', group: 'Setup', label: 'Reading your PDF character sheet', main: true },
    { key: 'character_sheet', group: 'Setup', label: 'Writing sheets for party members', main: true },
    { key: 'build_place', group: 'Setup', label: 'Planning a map room by room (only when the map builder is set to Claude)', main: true },
    { key: 'map_brief', group: 'Setup', label: 'A map\'s short brief for the map algorithm (when the local helper isn\'t used)', main: false },
    { key: 'sprite', group: 'Setup', label: 'Describing your party\'s little map figures', main: false },
    { key: 'drift', group: 'Story direction', label: 'Steering back to the plot', main: true },
    { key: 'stalled', group: 'Story direction', label: 'Unsticking a stuck scene', main: true },
    { key: 'deadlock', group: 'Story direction', label: 'Breaking a deadlock (you keep refusing)', main: true },
    { key: 'checkin', group: 'Story direction', label: 'The world moving on between your actions', main: false },
    { key: 'combat_action', group: 'Combat', label: 'Starting fights and your combat actions', main: false },
    { key: 'combat_round', group: 'Combat', label: 'Running combat rounds', main: false },
    { key: 'risky_action', group: 'Everyday play', label: 'Risky actions (sneak, lie, climb)', main: false },
    { key: 'roll_result', group: 'Everyday play', label: 'Narrating your roll results', main: false },
    { key: 'scene_move', group: 'Everyday play', label: 'Travel, rests and time skips', main: false },
    { key: 'event', group: 'Everyday play', label: 'Random events', main: false },
    { key: 'companion_task', group: 'Everyday play', label: 'Things you tell a companion to do (search, scout)', main: false },
    { key: 'companion_action', group: 'Everyday play', label: 'Ruling on a companion\'s risky attempt', main: false },
    { key: 'npc_addressed', group: 'Everyday play', label: 'Talking to someone new', main: false },
    { key: 'ooc', group: 'Everyday play', label: 'Out-of-character questions', main: false },
    { key: 'manual', group: 'Everyday play', label: 'When you ask the DM to step in', main: false },
    { key: 'solo', group: 'Everyday play', label: 'Your moments with no companion around', main: false },
    { key: 'explore', group: 'Everyday play', label: 'Exploring a map (traps, guards spotted)', main: false },
    { key: 'map_sync', group: 'Housekeeping', label: 'Keeping the map in step with the story (when the local helper is off)', main: false },
    { key: 'recap', group: 'Housekeeping', label: '"Previously on…" recaps', main: false },
    { key: 'condense_notes', group: 'Housekeeping', label: 'Tidying the DM\'s notes', main: false },
    { key: 'resync', group: 'Housekeeping', label: 'Fixing a mismatch with the chat', main: true },
]);

/** The recommended model for every job. */
export function defaultTaskModels(main = DEFAULT_MAIN_MODEL, light = DEFAULT_LIGHT_MODEL) {
    return Object.fromEntries(TASKS.map(t => [t.key, t.main ? main : light]));
}

/**
 * The model for one call.
 * @param {string[]} tasks the jobs this call covers (a DM turn can have several reasons)
 * @param {{hybrid:boolean, mainModel:string, taskModels:Record<string,string>, criticalModel?:string, criticalRoll?:boolean, rank?:(model:string)=>number}} o
 *  rank: bigger = more capable; when a call covers several jobs, the highest-ranked model wins.
 *  criticalModel: '' = no change for natural 1s and 20s.
 */
export function pickModel(tasks, { hybrid, mainModel, taskModels, criticalModel = '', criticalRoll = false, rank = () => 0 }) {
    if (!hybrid) return mainModel;
    // A job the settings don't know about (added in a later version) uses the main model.
    const models = tasks.map(t => taskModels?.[t] || mainModel);
    if (criticalRoll && criticalModel) models.push(criticalModel);
    if (!models.length) return mainModel;
    // Highest rank wins; on a tie the main model wins, then the first listed.
    return models.reduce((best, m) => {
        const diff = rank(m) - rank(best);
        if (diff > 0) return m;
        if (diff === 0 && m === mainModel) return m;
        return best;
    });
}

/** v0.4.0's big-model checklist, to tell untouched settings from customized ones. */
const V040_BIG = Object.freeze({
    opening: true, scene_move: true, event: true, drift: true, stalled: true, combat_round: true,
    combat_action: false, risky_action: false, roll_result: false, npc_addressed: false, ooc: false, checkin: false, manual: true,
});

/**
 * Move v0.4.x settings (a big/routine model pair plus a big-model checklist) to per-job models.
 * Untouched v0.4.0 defaults become the current recommended models; anything else keeps its choices.
 * @param {any} s saved settings (mutated)
 * @returns {boolean} true if anything changed
 */
export function migrateModelSettings(s) {
    if (s.taskModels && typeof s.taskModels === 'object') return false;
    const main = s.dmModel || DEFAULT_MAIN_MODEL;
    const light = s.dmModelRoutine || DEFAULT_LIGHT_MODEL;
    s.taskModels = defaultTaskModels(main, light);
    if (s.bigReasons && typeof s.bigReasons === 'object') {
        const untouchedV040 = (s.modelDefaultsVersion ?? 1) < 2 && Object.entries(V040_BIG).every(([k, v]) => s.bigReasons[k] === v);
        if (!untouchedV040) {
            for (const [k, big] of Object.entries(s.bigReasons)) if (k in s.taskModels) s.taskModels[k] = big ? main : light;
            if (s.bigOnCritical === true) s.criticalModel = main;
        }
        if (s.autoModel === false) s.hybridModels = false;
    }
    for (const k of ['bigReasons', 'bigOnCritical', 'dmModelRoutine', 'autoModel', 'modelDefaultsVersion']) delete s[k];
    return true;
}

/** "claude-haiku-5-5" → "Haiku" for status lines and cost logs. */
export function modelLabel(id) {
    const s = String(id || '');
    for (const name of ['Haiku', 'Sonnet', 'Opus', 'Fable']) {
        if (s.toLowerCase().includes(name.toLowerCase())) return name;
    }
    return s || 'Claude';
}
