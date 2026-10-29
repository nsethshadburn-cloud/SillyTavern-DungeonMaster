// The people on the map notice the party. Each turn, and each step of a walk, every guard and
// resident on the party's floor checks who they can see from where they stand (lit squares in their
// line of sight, their own lantern in the dark, two squares around them otherwise). Someone where
// they're allowed to be: the watcher is marked as having seen them and may say a vague line in their
// speech bubble (no model is called). Someone trespassing, or an escaped prisoner: the DM is called
// to decide what the watcher does. Hostile creatures aren't handled here (the fight rules are).

import { guardSees, roomAt, hiddenNow } from '../core/explore.js';
import { trespassOf } from '../core/access.js';
import { cannedLine, lineRole } from '../core/lines.js';
import { noteSeen } from '../core/world.js';
import { sayOnMap } from '../ui/bubbles.js';

/** A watcher doesn't react again to the same person in the same room for this many turns. */
const SETTLE_TURNS = 6;

/**
 * @param {object} c the campaign
 * @param {{key: string, place: object}} cur the current place
 * @param {string[]} names party members on the map (the player first)
 * @returns {{events: string[], lines: {name: string, text: string}[]}}
 *  events = what the DM must rule on (trespassers seen); lines = canned lines to show in bubbles
 */
export function watchParty(c, cur, names) {
    const out = { events: [], lines: [] };
    if (!cur) return out;
    const { place } = cur;
    const w = c.docs.world;
    const lead = place.state.positions[names[0]];
    if (!lead) return out;
    const floorId = lead.floor;
    const here = names.filter(n => place.state.positions[n]?.floor === floorId && !place.state.held?.[n]);
    if (!here.length) return out;
    const turn = c.meta.turn;
    for (const g of Object.values(place.guards)) {
        if (g.state === 'gone' || g.state === 'dead' || g.floor !== floorId || g.hostile === true || g.intent === 'attack') continue;
        const seen = guardSees(place, floorId, g, here);
        if (!seen.length) continue;
        g.spotted ??= {};
        for (const n of seen) {
            const p = place.state.positions[n];
            const room = roomAt(place, floorId, p.x, p.y)?.id ?? 'corridor';
            const prev = g.spotted[n];
            if (prev && prev.room === room && turn - prev.turn < SETTLE_TURNS) continue;
            g.spotted[n] = { room, turn };
            const hid = hiddenNow(place, n);
            const t = trespassOf(place, n, roomAt);
            if (t) {
                const who = lineRole(g) === 'guard' ? 'a guard: he challenges them, raises the alarm or moves to stop them' : 'not a guard: he may shout for help, run, or confront them';
                out.events.push(`${g.name} (${g.description || 'someone who belongs here'}) can see ${n}${hid ? ` hiding ${hid.mode} the ${hid.what} (roll whether he notices: his Perception against their Stealth, with "spot")` : ''} in ${t.room}, where ${n} is not allowed (${t.why === 'escaped' ? 'an escaped prisoner, out of their cell' : t.why}). ${g.name} is ${who}; decide what he does, brief him if he speaks, and set his intent if he goes after them.`);
                if (!hid) noteSeen(w, g.name, n, true);
                continue;
            }
            if (hid) continue;
            noteSeen(w, g.name, n, true);
            const hp = w.party?.[n];
            const hurt = Boolean(hp && hp.hp_max && hp.hp / hp.hp_max < 0.5);
            const line = cannedLine(g, { hurt });
            if (line) out.lines.push({ name: g.name, text: line });
        }
    }
    for (const l of out.lines) sayOnMap({ name: l.name, text: l.text, voiced: false });
    return out;
}
