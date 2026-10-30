// The people on the map notice the party: the decision, with no I/O (st/watch.js does the posting).
// Each turn, and each step of a walk, every guard and resident on the party's floor who is awake
// and free checks who they can see from where they stand (lit squares in their line of sight,
// their own lantern in the dark, two squares around them otherwise). Then:
// - someone they haven't noticed (a Stealth roll went the party's way) stays unnoticed, unless the
//   two are right beside each other: then the DM is asked to roll again;
// - someone lying unconscious (or asleep where they shouldn't be) is found: the DM is told;
// - a trespasser, or an escaped prisoner out of their cell: the DM is told once (per person, for a
//   few turns), and not at all by someone already escorting or chasing them;
// - someone where they're allowed to be: the watcher is marked as having seen them and may say a
//   vague line (unless they're in the middle of a conversation already). Pure module.

import { guardSees, roomAt, hiddenNow, poseNow, isOut } from './explore.js';
import { trespassOf, standingOf } from './access.js';
import { cannedLine, lineRole } from './lines.js';
import { nameKey } from './text.js';

/** A watcher doesn't react again to the same person (in the same room, for lines) for this many turns. */
export const SETTLE_TURNS = 6;

const OUT = [
    [/unconscious|knocked out|out cold|senseless|stunned|paralyz|paralys|petrified|incapacit|dying|dead/i, 'unconscious'],
    [/asleep|sleeping|drugged|passed out/i, 'asleep'],
    [/restrained|tied|bound|shackl|chained|cuffed|manacl|in irons|grappled|caged/i, 'bound'],
];

/** What the DM's conditions on someone say about whether they're out of it: 'unconscious' | 'asleep' | 'bound' | null. */
export function outBy(conditions) {
    const text = (Array.isArray(conditions) ? conditions : [conditions]).filter(Boolean).join(' ');
    if (!text) return null;
    for (const [re, kind] of OUT) if (re.test(text)) return kind;
    return null;
}

const settled = (store, key, turn) => store?.[key] !== undefined && turn - store[key] < SETTLE_TURNS;

/**
 * @param {object} place
 * @param {string[]} names party members on the map (the player first)
 * @param {{turn: number, time?: string, canSee?: (g: object) => boolean, condsOf?: (name: string) => string[], hpOf?: (name: string) => ({hp: number, hp_max: number} | null), spokeLately?: (name: string) => boolean, rng?: () => number}} ctx
 * @returns {{events: string[], lines: {name: string, text: string}[], seen: {seer: string, seen: string}[]}}
 *  events = what the DM must rule on; lines = canned lines to say; seen = sightings to record
 */
export function noticeParty(place, names, ctx) {
    const out = { events: [], lines: [], seen: [] };
    const turn = Number(ctx?.turn) || 0;
    const condsOf = ctx?.condsOf ?? (() => []);
    const hpOf = ctx?.hpOf ?? (() => null);
    const spokeLately = ctx?.spokeLately ?? (() => false);
    const time = ctx?.time === 'night' ? 'night' : 'day';
    const lead = place.state?.positions?.[names[0]];
    if (!lead) return out;
    const floorId = lead.floor;
    const here = names.filter(n => place.state.positions[n]?.floor === floorId && !place.state.held?.[n]);
    if (!here.length) return out;
    const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    for (const g of Object.values(place.guards || {})) {
        if (isOut(g) || g.floor !== floorId || g.hostile === true || g.intent === 'attack' || g.intent === 'follow' || outBy(condsOf(g.name))) continue;
        const seen = guardSees(place, floorId, g, here);
        if (!seen.length) continue;
        g.spotted ??= {};
        g.reported ??= {};
        for (const n of seen) {
            const p = place.state.positions[n];
            const room = roomAt(place, floorId, p.x, p.y);
            const roomId = room?.id ?? 'corridor';
            const who = `${g.name} (${g.description || 'someone who belongs here'})`;
            // A roll said they didn't notice this one: they still haven't, unless the two are right beside each other.
            if ((g.unaware ?? []).some(u => nameKey(u) === nameKey(n))) {
                if (dist(g, p) <= 1 && !settled(g.reported, `bump:${n}`, turn)) {
                    g.reported[`bump:${n}`] = turn;
                    out.events.push(`${n} is right beside ${who}, who hasn't noticed them so far. Roll whether he does now (his Perception against their Stealth, with "spot"), then decide what he does.`);
                }
                continue;
            }
            const hp = hpOf(n);
            const down = outBy(condsOf(n)) ?? (hp && hp.hp_max && hp.hp <= 0 ? 'unconscious' : null);
            const t = trespassOf(place, n, roomAt);
            // Someone lying there out cold (or tied up): found, whoever they are.
            if (down && down !== 'asleep') {
                if (settled(g.reported, `down:${n}`, turn)) continue;
                g.reported[`down:${n}`] = turn;
                out.seen.push({ seer: g.name, seen: n });
                out.events.push(`${who} finds ${n} ${down === 'bound' ? 'tied up' : 'lying unconscious'} in ${room?.name ?? 'the passage'}${t ? `, where ${n} is not allowed (${t.why === 'escaped' ? 'an escaped prisoner' : t.why})` : ''}. Decide what he does (help, raise the alarm, rob them, lock them up), and brief him if he speaks.`);
                continue;
            }
            const hid = hiddenNow(place, n);
            if (t) {
                if (settled(g.reported, n, turn)) {
                    // Already reported, and now they walk right up to him (or run circles around him)
                    // and nothing has stopped them: that's not a sighting, it's a confrontation.
                    if (dist(g, p) <= 1 && g.reported[`near:${n}`] !== turn) {
                        g.reported[`near:${n}`] = turn;
                        out.events.push(`${n} is right beside ${who}, who has already seen them ${t.why === 'escaped' ? 'out of their cell' : `where they are not allowed (${t.why})`}, and nothing has stopped them. He acts now (grabs them, blocks the way, raises the alarm, attacks), or you say why he doesn't.`);
                    }
                    continue;
                }
                g.reported[n] = turn;
                // He can see them, but they can't see him (he stands in the dark, or out of their sight):
                // that's not a sure thing from a distance; the dice say whether he notices.
                const unseen = !hid && Boolean(ctx?.canSee) && !ctx.canSee(g) && dist(g, p) > 1;
                const does = (lineRole(g) === 'guard' ? 'a guard: he challenges them, raises the alarm or moves to stop them' : 'not a guard: he may shout for help, run, or confront them') + '. Narrate what he does and STOP there: the player decides how to answer (talk, run, fight, give up). Never ask the player for a roll of something they have not tried';
                out.events.push(`${who} can see ${n}${hid ? ` hiding ${hid.mode} the ${hid.what} (roll whether he notices: his Perception against their Stealth, with "spot")` : unseen ? ' (the party can\'t see him: he is in the dark or out of their sight. Roll whether he notices them at all: his Perception against their passive Stealth, with "spot". Don\'t narrate him seeing them before the roll)' : ''} in ${t.room}, where ${n} is not allowed (${t.why === 'escaped' ? 'an escaped prisoner, out of their cell' : t.why}). ${g.name} is ${does}; decide what he does, brief him if he speaks, and set his intent if he goes after them.`);
                if (!hid && !unseen) out.seen.push({ seer: g.name, seen: n });
                continue;
            }
            if (hid) continue;
            // Allowed there: noted, and now and then a word (not to someone asleep, not mid-conversation).
            const prev = g.spotted[n];
            if (prev && prev.room === roomId && turn - prev.turn < SETTLE_TURNS) continue;
            g.spotted[n] = { room: roomId, turn };
            out.seen.push({ seer: g.name, seen: n });
            if (down === 'asleep' || poseNow(place, n)?.pose === 'sleep' || spokeLately(g.name)) continue;
            // A word from someone the party can't see is a voice out of nowhere: the DM narrates those.
            if (ctx?.canSee && !ctx.canSee(g)) continue;
            const st = standingOf(place, n);
            const prisoner = st.label === 'prisoner' && Boolean(room) && (st.home === room.id || st.rooms.includes(room.id));
            const hurt = Boolean(hp && hp.hp_max && hp.hp / hp.hp_max < 0.5);
            const line = cannedLine(g, { hurt, time, prisoner, rng: ctx?.rng });
            if (line) out.lines.push({ name: g.name, text: line });
        }
    }
    return out;
}
