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
//
// Judgement about words (did he run? did she tell him to stay?) is not here: a one-word referee
// reads the line (core/referee.js) and the verdict comes in. Everything here is a table.

export const MODES = Object.freeze(['guard', 'companion']);
export const PLAYER_VERDICTS = Object.freeze(['run', 'along', 'give', 'trip', 'none']);
export const KEEPER_VERDICTS = Object.freeze(['stay', 'along', 'none']);
export const DEFAULT_RADIUS = 2;

/** A clean record from whatever is stored (older versions kept escorts, searches and grace turns; those are gone). */
export function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || !raw.by) return null;
    const rec = { by: String(raw.by), radius: Math.max(1, Math.min(6, Number(raw.radius) || DEFAULT_RADIUS)), mode: raw.mode === 'companion' ? 'companion' : 'guard', attempts: Number(raw.attempts) || 0 };
    if (raw.chase === true) rec.chase = true;
    if (Number.isInteger(raw.lastGrabTurn)) rec.lastGrabTurn = raw.lastGrabTurn;
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
 */
export function onPlayerVerdict(rec, verdict) {
    const r = { ...rec };
    switch (verdict) {
        case 'run': r.chase = true; return { rec: r, event: 'bolt' };
        case 'along': { const was = r.mode === 'companion' && !r.chase; r.mode = 'companion'; delete r.chase; return { rec: r, event: was ? '' : 'along' }; }
        case 'give': { const was = Boolean(r.chase); delete r.chase; r.mode = 'guard'; r.attempts = 0; return { rec: r, event: was ? 'give' : '' }; }
        case 'trip': return { rec: r, event: 'trip' };
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
    if (verdict === 'along' && (r.mode !== 'companion' || r.chase)) { r.mode = 'companion'; delete r.chase; r.attempts = 0; return { rec: r, event: 'companion' }; }
    return { rec: r, event: '' };
}

/**
 * The player's step on the map, before the keeper moves.
 * @param {object} rec
 * @param {{gap:number, prevGap:number, keeperProne:boolean}} s gap = squares between them after the step; prevGap = before it
 * @returns {''|'caught'} walking back into her reach mid-chase (the gap closed by his own step, she's on her feet) is being caught: no roll
 */
export function stepBefore(rec, { gap, prevGap, keeperProne }) {
    return rec.chase && gap <= 1 && prevGap > gap && !keeperProne ? 'caught' : '';
}

/**
 * The player's step on the map, after the keeper has had her move.
 * @param {object} rec
 * @param {{gap:number, fromStart:number, sees:boolean, keeperProne:boolean, turn:number}} s
 *  gap = squares between them now; fromStart = squares from where she stood when the walk began;
 *  sees = she can see them (sight, light, stealth); keeperProne = she's on the ground
 * @returns {''|'grab'|'standup'|'start'|'lost'}
 *  grab:    she's within reach mid-chase: the slip-free card (one per turn)
 *  standup: she's on the ground mid-chase: she gets up instead (no roll, no grab this turn)
 *  start:   guard mode, beyond her radius, in her sight: the chase begins now
 *  lost:    mid-chase, out of her sight: the chase is off; she stands where she lost them
 */
export function stepAfter(rec, { gap, fromStart, sees, keeperProne, turn }) {
    if (rec.chase) {
        if (keeperProne) return 'standup';
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
        case 'caught': delete r.chase; r.mode = 'guard'; r.attempts = 0; break;
        case 'start': r.chase = true; break;
        case 'lost': delete r.chase; break;
        default: break;
    }
    return r;
}

/**
 * The slip-free roll came in. A miss: she has them (grappled, guard mode, the chase is over).
 * A slip: loose for now, she stays after them; after three slips she can't hold them by hand.
 * @returns {{rec: object, held: boolean, tries: number, exhausted: boolean}}
 */
export function onSlip(rec, success) {
    const r = { ...rec };
    if (!success) { delete r.chase; r.mode = 'guard'; r.attempts = 0; return { rec: r, held: true, tries: 0, exhausted: false }; }
    const tries = r.attempts || 0;
    return { rec: r, held: false, tries, exhausted: tries >= 3 };
}

/** A grab is made: counted, and dated so it can't double in a turn. */
export function onGrab(rec, turn) {
    return { ...rec, attempts: (rec.attempts || 0) + 1, lastGrabTurn: turn };
}

/**
 * The trip or shove came in. Landed: her hold is broken (the chase, if any, is still hers to run
 * once she's up). Missed: she keeps her feet and has them (guard mode, no chase).
 */
export function onTrip(rec, success) {
    const r = { ...rec };
    if (!success) { delete r.chase; r.mode = 'guard'; r.attempts = 0; }
    return r;
}

/** Nobody holds them and nothing binds them: custody is over. */
export function freed({ bound, grappled }) {
    return !bound && !grappled;
}

/** The DM's op: a new keeper or a re-send. Mode from the op, else kept; a chase kept unless the op says. */
export function fromOp(prev, { by, radius, mode, chase }) {
    const keep = prev?.by === by ? prev : null;
    const rec = { by, radius: Math.max(1, Math.min(6, Number(radius) || keep?.radius || DEFAULT_RADIUS)), attempts: 0, mode: mode === 'companion' || mode === 'guard' ? mode : keep?.mode === 'companion' ? 'companion' : 'guard' };
    if (chase === true || (chase !== false && keep?.chase)) rec.chase = true;
    return rec;
}
