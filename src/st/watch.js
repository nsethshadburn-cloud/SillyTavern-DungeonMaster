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
import { look } from './atlas.js';
import { queueTalk } from './talk.js';
import { settings } from './settings.js';
import { floorById, personByName, setIntent } from '../core/explore.js';
import { lineRole } from '../core/lines.js';
import { matchName } from '../core/text.js';
import { sfx } from '../ui/sound.js';

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
    const vis = look(c, cur.key, place);
    const canSee = g => { const map = floorById(place, g.floor).map; return Boolean(vis[g.y * map.w + g.x]); };
    const r = noticeParty(place, names, {
        turn: c.meta.turn,
        canSee,
        time: isNight(w.time) ? 'night' : 'day',
        condsOf: n => conditionsOf(w, n),
        hpOf: n => w.party?.[n] ?? null,
        spokeLately,
    });
    for (const s of r.seen) noteSeen(w, s.seer, s.seen, true);
    // A guard who has seen them loose comes after them: talk first, then grab (atlas.grabAttempts).
    for (const s of r.seize) {
        const g = personByName(place, s.guard);
        if (!g || g.hostile === true || g.seize || g.fedUp) continue;
        g.seize = { target: s.target, attempts: 0, asked: false, since: c.meta.turn };
        setIntent(g, 'follow', s.target);
    }
    for (const l of r.lines) {
        // Now and then the line comes from the local model instead of the canned pool (one a turn, short).
        const g = personByName(place, l.name);
        const partyNames = [c.meta.persona.name, ...c.meta.party.map(p => p.name)];
        // Guards, keepers and locals get a model line; a fellow prisoner stays canned; never a party namesake.
        if (g && settings().guardsTalk !== false && lineRole(g) !== 'prisoner' && !matchName(l.name, partyNames) && Math.random() < 0.6) {
            const who = l.prisoner ? `${l.to}, a prisoner in their own cell` : `${l.to}, who is allowed to be there`;
            queueTalk({
                name: l.name,
                fallback: l.text,
                brief: `You are ${g.name}${g.description ? `, ${g.description}` : ''}, on duty in ${place.name}. You can see ${who}, ${l.dist} squares away${l.room ? ` in ${l.room}` : ''}. Say ONE short line, a sentence at most, plain and gruff: an order, a warning, a passing remark, to ${l.to} or under your breath. Nothing else: no narration, no action beyond a glance.`,
            });
            continue;
        }
        sayOnMap({ name: l.name, text: l.text, voiced: false });
        place.state.said = [...(place.state.said || []).slice(-5), { name: l.name, text: l.text, turn: c.meta.turn }];
        postNpc(l.name, `"${l.text}"`).catch(error => console.warn('[Dungeon Master] could not post a line', error));
    }
    if (r.events.length) sfx('alert');
    return { events: r.events, lines: r.lines };
}
