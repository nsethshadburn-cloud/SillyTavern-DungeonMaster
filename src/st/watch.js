// The people on the map notice the party (the decision is core/notice.js; this is the posting).
// A trespasser or an escaped prisoner in view, someone found lying unconscious, someone bumping
// into a guard who hadn't noticed them: the DM is called to rule. Someone allowed where they are:
// the watcher may say a vague canned line, which goes in their speech bubble AND in the chat as
// their own line, so the companions, the DM and the player all hear the same thing.

import { noticeParty } from '../core/notice.js';
import { noteSeen, conditionsOf, isNight } from '../core/world.js';
import { sayOnMap } from '../ui/bubbles.js';
import { postNpc } from './messages.js';
import { ST } from './st.js';

/** Did this person speak in the last few messages (a conversation is going on)? */
function spokeLately(name, within = 8) {
    let n = 0;
    for (let i = ST.chat.length - 1; i >= 0 && n < within; i--) {
        const m = ST.chat[i];
        if (!m?.mes || m.is_system) continue;
        n++;
        if (!m.is_user && m.name === name) return true;
    }
    return false;
}

/**
 * @param {object} c the campaign
 * @param {{key: string, place: object}} cur the current place
 * @param {string[]} names party members on the map (the player first)
 * @returns {{events: string[], lines: {name: string, text: string}[]}}
 */
export function watchParty(c, cur, names) {
    if (!cur) return { events: [], lines: [] };
    const { place } = cur;
    const w = c.docs.world;
    const r = noticeParty(place, names, {
        turn: c.meta.turn,
        time: isNight(w.time) ? 'night' : 'day',
        condsOf: n => conditionsOf(w, n),
        hpOf: n => w.party?.[n] ?? null,
        spokeLately,
    });
    for (const s of r.seen) noteSeen(w, s.seer, s.seen, true);
    for (const l of r.lines) {
        sayOnMap({ name: l.name, text: l.text, voiced: false });
        place.state.said = [...(place.state.said || []).slice(-5), { name: l.name, text: l.text, turn: c.meta.turn }];
        postNpc(l.name, `"${l.text}"`).catch(error => console.warn('[Dungeon Master] could not post a line', error));
    }
    return { events: r.events, lines: r.lines };
}
