// Map sync: after a turn, a model reads what was just said (the DM's narration, the companions'
// replies, the dice) next to what the map shows, and lists what the story did that the map doesn't
// show yet: a dog bursting out of a kennel, Judy walking over to it, a door kicked in, Judy ducking
// behind a crate. Everything it says is checked here against the real map (only ids and names
// that exist, only sensible states) before anything moves. Pure module.

import { extractJson, nameKey, matchName } from './text.js';
import { INTENTS, looksLikeThing } from './explore.js';

/**
 * The prompt. party/people: [{name, at, room, note}]; things: [{id, name, at, room}];
 * rooms: [{id, name}]; story: what was just said.
 */
export function mapSyncPrompt({ party, people, things, rooms, items = [], carried = {}, story }) {
    const system = 'You keep the map of a tabletop roleplaying game in step with its story. Reply with ONE line of JSON and nothing else.';
    const line = p => `${p.name} at ${p.at}${p.room ? ` in ${p.room}` : ''}${p.note ? ` (${p.note})` : ''}`;
    const user = [
        'THE MAP RIGHT NOW',
        `Party: ${party.map(line).join('; ')}.`,
        `Others on the map: ${people.length ? people.map(line).join('; ') : 'nobody'}.`,
        `Things (id = what, where): ${things.map(t => `${t.id} = ${t.name} at ${t.at}${t.room ? `, ${t.room}` : ''}`).join('; ') || 'none'}.`,
        rooms.length ? `Rooms: ${rooms.map(r => `${r.id} = ${r.name}`).join('; ')}.` : '',
        `Items lying here (id = what, where): ${items.length ? items.map(i => `${i.id} = ${i.name}${i.hidden ? ' (hidden, not found yet)' : ''}, ${i.room}`).join('; ') : 'none'}.`,
        Object.keys(carried).length ? `Carried: ${Object.entries(carried).map(([n, l]) => `${n}: ${l.join(', ')}`).join('; ')}.` : '',
        '',
        'WHAT JUST HAPPENED IN THE STORY',
        story,
        '',
        'List only what the story says happened that the map does NOT show yet. Each change is one of:',
        '{"op":"spawn","name":"short name","what":"one line: who or what it is","near":"a thing id, room id or someone\'s name: where they showed up","hostile":true or false,"intent":"attack|follow|flee|stay|wander","target":"who they go after (attack/follow), or empty"} = a PERSON or CREATURE appeared who isn\'t on the map (never the party, and never an object or item: a lamp, a key or a tin of oil is not someone).',
        '{"op":"move","who":"exact name","to":"a thing id, room id or someone\'s name"} = someone went somewhere (walked over to it, went into that room).',
        '{"op":"hide","who":"exact name","in":"the thing id they hide in, under or behind, or empty"} = someone hid.',
        '{"op":"pose","who":"exact name","on":"thing id","how":"sit|lie|sleep|stand"} = someone sat or lay down on something, or got up.',
        '{"op":"door","id":"door id","state":"open|closed|locked|broken"}',
        '{"op":"thing","id":"thing id","state":"smashed|gone"} = something was smashed to pieces or taken away whole.',
        '{"op":"gone","who":"exact name"} = someone left the area, died or was put away.',
        `{"op":"intent","who":"exact name","intent":"${INTENTS.join('|')}","target":"who, or empty"} = someone already on the map now goes after someone, follows them, runs away, holds still or wanders off (never "attack" or "follow" toward someone they haven\'t noticed).`,
        '{"op":"take","who":"exact name","item":"item id"} = someone picked up an item lying here.',
        '{"op":"found","item":"item id"} = a hidden item was found (it is now known, still lying there).',
        '{"op":"drop","who":"exact name","item":"what they carried"} = someone put down or left an item they carried, here.',
        'Only what the story clearly says ALREADY HAPPENED. Leave out: plans and offers ("I\'ll check the kennel", "let me hide": not done yet), guesses and maybes, what might happen after a roll, and anything only heard or sensed (barking somewhere, footsteps above, a voice behind a door: that someone is not here yet). Someone already listed is never spawned again under another name ("the hound" is the Guard Dog). Use names and ids exactly as listed above.',
        'Reply {"changes":[...]}, or {"changes":[]} when the map already matches.',
        'Example: {"changes":[{"op":"move","who":"Judy Hopps","to":"P12"},{"op":"spawn","name":"Guard Dog","what":"a snarling mastiff","near":"P12","hostile":true,"intent":"attack","target":"Judy Hopps"}]}',
    ].filter(s => s !== '').join('\n');
    return { system, user };
}

const OPS = new Set(['spawn', 'move', 'hide', 'pose', 'door', 'thing', 'gone', 'intent', 'take', 'found', 'drop']);
const NOT_EVIDENCE = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'from', 'one', 'two', 'old', 'big', 'small', 'large', 'young']);

/** Words of a name or description worth matching (no little words). */
const SAME = { hound: 'dog', mastiff: 'dog', mutt: 'dog', cur: 'dog', puppy: 'dog', pup: 'dog', watchman: 'guard', sentry: 'guard', jailer: 'guard', turnkey: 'guard', gaoler: 'guard', soldier: 'guard', wolve: 'wolf', fellow: 'man', gent: 'man', lass: 'woman', lady: 'woman', creature: 'beast', monster: 'beast' };
const words = s => (nameKey(s).match(/[a-z]{3,}/g) ?? []).filter(w => !NOT_EVIDENCE.has(w)).map(w => w.replace(/s$/, '')).map(w => SAME[w] ?? w);

/**
 * The model's reply as checked changes. known: {party:[names], people:[names], things:[ids],
 * doors:[ids], rooms:[ids]}. Anything naming someone or something that isn't there is dropped.
 */
export function parseMapSync(text, known, { story = '' } = {}) {
    const data = extractJson(text);
    const told = new Set(words(story));
    // Something the story never mentions didn't happen in it (a spawn must be named or described there).
    const inStory = (...texts) => !story || texts.some(t => words(t).some(w => told.has(w)));
    const peopleInfo = known.peopleInfo || {};
    // "the hound" when a Guard Dog (a hound) is already there: the same one, not a second.
    // Only a plain description ("the hound"), never a numbered or second one ("Guard 2"), and only one match.
    const sameAs = (name, what) => {
        if (/[0-9]/.test(name)) return null;
        const mine = new Set([...words(name), ...words(what).slice(-2)]);
        const hits = (known.people || []).filter(p => [...words(p), ...words(peopleInfo[p] || '').slice(-2)].some(w => mine.has(w)));
        return hits.length === 1 && !/\b(another|second|more|other)\b/i.test(`${name} ${what}`) ? hits[0] : null;
    };
    const list = Array.isArray(data) ? data : Array.isArray(data?.changes) ? data.changes : [];
    const party = known.party || [], people = known.people || [];
    const everyone = [...party, ...people];
    const idOf = (raw, ids) => { const s = String(raw ?? '').trim().toLowerCase(); return ids.find(i => i.toLowerCase() === s) ?? null; };
    // Where: a thing, a door, a room, or someone (by name).
    const spotOf = raw => {
        const s = String(raw ?? '').trim();
        if (!s) return null;
        const id = idOf(s, [...(known.things || []), ...(known.doors || []), ...(known.rooms || [])]);
        if (id) return id;
        return matchName(s, everyone);
    };
    const out = [];
    const seen = new Set();
    for (const raw of list.slice(0, 12)) {
        if (!raw || typeof raw !== 'object') continue;
        const op = String(raw.op ?? '').toLowerCase().trim();
        if (!OPS.has(op)) continue;
        let ch = null;
        if (op === 'spawn') {
            const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
            if (!name || party.some(p => nameKey(p) === nameKey(name)) || looksLikeThing(name)) continue;
            const what = String(raw.what ?? '').trim();
            if (!inStory(name, what)) continue;
            const already = people.find(p => nameKey(p) === nameKey(name)) ?? sameAs(name, what);
            const intent = INTENTS.includes(String(raw.intent).toLowerCase()) ? String(raw.intent).toLowerCase() : '';
            const target = matchName(String(raw.target ?? ''), everyone) ?? '';
            ch = already
                ? (intent ? { op: 'intent', who: already, intent, target } : null)
                : { op, name, what: String(raw.what ?? '').trim().slice(0, 160), near: spotOf(raw.near), hostile: raw.hostile === true || raw.hostile === 'true' || intent === 'attack', intent, target };
        } else if (op === 'move' || op === 'hide' || op === 'pose' || op === 'gone' || op === 'intent') {
            const who = matchName(String(raw.who ?? ''), everyone);
            if (!who) continue;
            // Someone the story doesn't mention didn't move.
            if (op !== 'intent' && op !== 'gone' && !inStory(who)) continue;
            if (op === 'move') { const to = spotOf(raw.to); if (to && nameKey(to) !== nameKey(who)) ch = { op, who, to }; }
            else if (op === 'hide') { if (party.includes(who)) ch = { op, who, in: idOf(raw.in, known.things || []) ?? '' }; }
            else if (op === 'pose') {
                const how = String(raw.how ?? '').toLowerCase().trim();
                if (!['sit', 'lie', 'sleep', 'stand'].includes(how) || !party.includes(who)) continue;
                const on = idOf(raw.on, known.things || []);
                if (how !== 'stand' && !on) continue;
                ch = { op, who, on: on ?? '', how };
            } else if (op === 'gone') { if (people.includes(who)) ch = { op, who }; }
            else {
                const intent = String(raw.intent ?? '').toLowerCase().trim();
                if (!INTENTS.includes(intent) || !people.includes(who)) continue;
                ch = { op, who, intent, target: matchName(String(raw.target ?? ''), everyone) ?? '' };
            }
        } else if (op === 'take' || op === 'found') {
            const id = idOf(raw.item, known.items || []);
            if (!id) continue;
            if (op === 'found') ch = { op, id };
            else { const who = matchName(String(raw.who ?? ''), party); if (who) ch = { op, who, id }; }
        } else if (op === 'drop') {
            const who = matchName(String(raw.who ?? ''), party);
            const theirs = who ? (known.carried?.[who] ?? []) : [];
            const item = theirs.find(i => nameKey(i) === nameKey(raw.item)) ?? theirs.find(i => nameKey(i).includes(nameKey(raw.item)) || nameKey(raw.item).includes(nameKey(i)));
            if (who && item && nameKey(raw.item)) ch = { op, who, item };
        } else if (op === 'door') {
            const id = idOf(raw.id, known.doors || []);
            const state = { open: 'open', opened: 'open', closed: 'closed', shut: 'closed', locked: 'locked', broken: 'broken', smashed: 'broken' }[String(raw.state ?? '').toLowerCase().trim()];
            if (id && state) ch = { op, id, state };
        } else if (op === 'thing') {
            const id = idOf(raw.id, known.things || []);
            const state = { smashed: 'broken', broken: 'broken', destroyed: 'broken', gone: 'removed', taken: 'removed', removed: 'removed' }[String(raw.state ?? '').toLowerCase().trim()];
            if (id && state) ch = { op, id, state };
        }
        if (!ch) continue;
        const key = `${ch.op}:${ch.who ?? ch.name ?? ch.id}:${ch.item ?? ch.id ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ch);
    }
    return out;
}
