// Custody: who holds whom, as a small state machine. Pure: no map, no chat, no model.
//
// A record is three facts and a counter:
//   by       the keeper's name (a companion, or someone of the place)
//   mode     'guard'     she's told them to stay, or has just caught them: a step beyond her radius, in her sight, is an escape
//            'companion' she goes along with them: she follows like any companion and a walk is never an escape
//   chase    she is after them right now (set by a step beyond the radius, or the player's "I run"; cleared by a catch, a slip
//            that goes out of her sight, her letting them go, or the player giving in)
//   attempts grabs she has made this chase (three slips and she can't hold them by hand)
//   radius   how far they may wander in guard mode (squares)
//   lastGrabTurn  one grab per turn, so a card never doubles
//   stumble  she lunged and missed: off balance for his next few steps (no run, no grab), so a slip opens a gap
//
// Judgement about words (did he run? did she tell him to stay?) is not here: a one-word referee
// reads the line (core/referee.js) and the verdict comes in. Everything here is a table.

export const MODES = Object.freeze(['guard', 'companion']);
export const PLAYER_VERDICTS = Object.freeze(['run', 'along', 'give', 'trip', 'hide', 'none']);
export const KEEPER_VERDICTS = Object.freeze(['stay', 'along', 'none']);
export const DEFAULT_RADIUS = 2;
/** A missed grab leaves her off balance for this many of his steps: the gap a slip buys. */
export const STUMBLE_STEPS = 3;

/** A clean record from whatever is stored (older versions kept escorts, searches and grace turns; those are gone). */
export function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || !raw.by) return null;
    const rec = { by: String(raw.by), radius: Math.max(1, Math.min(6, Number(raw.radius) || DEFAULT_RADIUS)), mode: raw.mode === 'companion' ? 'companion' : 'guard', attempts: Number(raw.attempts) || 0 };
    if (raw.chase === true) rec.chase = true;
    if (Number.isInteger(raw.lastGrabTurn)) rec.lastGrabTurn = raw.lastGrabTurn;
    if (Number.isInteger(raw.stumble) && raw.stumble > 0) rec.stumble = raw.stumble;
    return rec;
}

/** A fresh record: she has just taken them, so she's guarding. */
export function newRecord(by, radius = DEFAULT_RADIUS) {
    return { by: String(by), radius: Math.max(1, Math.min(6, Number(radius) || DEFAULT_RADIUS)), mode: 'guard', attempts: 0 };
}

/**
 * The player's line, as the referee read it.
 * @returns {{rec: object, event: ''|'bolt'|'along'|'give'|'trip'}} the next record and what happened
 *  bolt:  a chase is on (she goes after them now)
 *  along: she goes along with them (companion mode; any chase is off)
 *  give:  they gave in: a chase ends and she has them (guard mode)
 *  trip:  they try to trip or shove her: the code's contest (the record is untouched until it lands)
 *  hide:  they duck behind cover mid-chase: the code's Stealth contest (the record is untouched until it lands)
 */
export function onPlayerVerdict(rec, verdict) {
    const r = { ...rec };
    switch (verdict) {
        case 'run': r.chase = true; return { rec: r, event: 'bolt' };
        case 'along': { const was = r.mode === 'companion' && !r.chase; r.mode = 'companion'; delete r.chase; delete r.stumble; return { rec: r, event: was ? '' : 'along' }; }
        case 'give': { const was = Boolean(r.chase); delete r.chase; delete r.stumble; r.mode = 'guard'; r.attempts = 0; return { rec: r, event: was ? 'give' : '' }; }
        case 'trip': return { rec: r, event: 'trip' };
        case 'hide': return { rec: r, event: 'hide' };
        default: return { rec: r, event: '' };
    }
}

/**
 * The keeper's line, as the referee read it: 'stay' (guard mode), 'along' (companion mode; a chase
 * is off: she's letting them go), 'none'.
 * @returns {{rec: object, event: ''|'guard'|'companion'}}
 */
export function onKeeperVerdict(rec, verdict) {
    const r = { ...rec };
    if (verdict === 'stay' && r.mode !== 'guard') { r.mode = 'guard'; return { rec: r, event: 'guard' }; }
    if (verdict === 'along' && (r.mode !== 'companion' || r.chase)) { r.mode = 'companion'; delete r.chase; delete r.stumble; r.attempts = 0; return { rec: r, event: 'companion' }; }
    return { rec: r, event: '' };
}

/**
 * The player's step on the map, before the keeper moves.
 * @param {object} rec
 * @param {{gap:number, prevGap:number, keeperProne:boolean, closing?:number, targetGap?:number}} s gap = squares between them after the step; prevGap = before it;
 *  closing = squares she runs this step (0 when she's on the ground or off balance); targetGap = squares from her to where the walk is going
 * @returns {''|'caught'} walking back to her mid-chase (the gap closed by his own step, or the walk's end beside her) where she reaches him, she on her feet, is being caught: no roll
 */
export function stepBefore(rec, { gap, prevGap, keeperProne, closing = 0, targetGap = Infinity }) {
    return rec.chase && (prevGap > gap || targetGap <= 1) && gap - closing <= 1 && !keeperProne ? 'caught' : '';
}

/**
 * The player's step on the map, after the keeper has had her move.
 * @param {object} rec
 * @param {{gap:number, fromStart:number, sees:boolean, keeperProne:boolean, turn:number, recovering?:boolean}} s
 *  gap = squares between them now; fromStart = squares from where she stood when the walk began;
 *  sees = she can see them (sight, light, stealth); keeperProne = she's on the ground;
 *  recovering = she's off balance after a missed grab (she stood still for this step: no grab, but out of her sight is still lost)
 * @returns {''|'grab'|'standup'|'start'|'lost'}
 *  grab:    she's within reach mid-chase: the slip-free card (one per turn)
 *  standup: she's on the ground mid-chase: she gets up instead (no roll, no grab this turn)
 *  start:   guard mode, beyond her radius, in her sight: the chase begins now
 *  lost:    mid-chase, out of her sight: the chase is off; she stands where she lost them
 */
export function stepAfter(rec, { gap, fromStart, sees, keeperProne, turn, recovering = false }) {
    if (rec.chase) {
        if (keeperProne) return 'standup';
        if (recovering) return sees ? '' : 'lost';
        if (gap <= 1) return rec.lastGrabTurn === turn ? '' : 'grab';
        return sees ? '' : 'lost';
    }
    if (rec.mode === 'companion') return '';
    if (fromStart <= rec.radius && gap <= rec.radius) return '';
    return sees ? 'start' : '';
}

/** Apply a step verdict to the record. */
export function afterStep(rec, verdict) {
    const r = { ...rec };
    switch (verdict) {
        case 'caught': delete r.chase; delete r.stumble; r.mode = 'guard'; r.attempts = 0; break;
        case 'start': r.chase = true; break;
        case 'lost': delete r.chase; delete r.stumble; break;
        default: break;
    }
    return r;
}

/** One of his steps while she's off balance: one fewer to go before she runs again. */
export function stumbleStep(rec) {
    const r = { ...rec };
    if (r.stumble > 1) r.stumble -= 1; else delete r.stumble;
    return r;
}

/**
 * The slip-free roll came in. A miss: she has them (grappled, guard mode, the chase is over).
 * A slip: loose for now, and she's off balance (STUMBLE_STEPS of his steps before she runs again:
 * the gap a slip buys); she stays after them; after three slips she can't hold them by hand.
 * @returns {{rec: object, held: boolean, tries: number, exhausted: boolean}}
 */
export function onSlip(rec, success) {
    const r = { ...rec };
    if (!success) { delete r.chase; delete r.stumble; r.mode = 'guard'; r.attempts = 0; return { rec: r, held: true, tries: 0, exhausted: false }; }
    const tries = r.attempts || 0;
    r.stumble = STUMBLE_STEPS;
    return { rec: r, held: false, tries, exhausted: tries >= 3 };
}

/** A grab is made: counted, and dated so it can't double in a turn. She's on her feet for it: no stumble left. */
export function onGrab(rec, turn) {
    const r = { ...rec, attempts: (rec.attempts || 0) + 1, lastGrabTurn: turn };
    delete r.stumble;
    return r;
}

/**
 * The trip or shove came in. Landed: her hold is broken (the chase, if any, is still hers to run
 * once she's up). Missed: she keeps her feet and has them (guard mode, no chase).
 */
export function onTrip(rec, success) {
    const r = { ...rec };
    if (!success) { delete r.chase; delete r.stumble; r.mode = 'guard'; r.attempts = 0; }
    return r;
}

/** Nobody holds them and nothing binds them: custody is over (checked the moment restraints come off, never while she holds them by her word alone). */
export function freed({ bound, grappled }) {
    return !bound && !grappled;
}

/**
 * The DM's op: a new keeper or a re-send. Mode from the op, else kept; a chase kept unless the op
 * says; a re-send mid-chase keeps the chase's books (grabs made, the stumble, the turn of the last
 * grab), so the DM echoing "chase": true never hands the keeper a fresh grab or her balance back.
 */
export function fromOp(prev, { by, radius, mode, chase }) {
    const keep = prev?.by === by ? prev : null;
    const rec = { by, radius: Math.max(1, Math.min(6, Number(radius) || keep?.radius || DEFAULT_RADIUS)), attempts: 0, mode: mode === 'companion' || mode === 'guard' ? mode : keep?.mode === 'companion' ? 'companion' : 'guard' };
    if (chase === true || (chase !== false && keep?.chase)) rec.chase = true;
    const going = Boolean(keep?.chase) && Boolean(rec.chase);
    if (going) rec.attempts = keep.attempts || 0;
    if (keep && Number.isInteger(keep.lastGrabTurn)) rec.lastGrabTurn = keep.lastGrabTurn;
    if (going && keep.stumble > 0) rec.stumble = keep.stumble;
    return rec;
}
