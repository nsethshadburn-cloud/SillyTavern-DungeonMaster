// Who may be where: every room of a place has a zone (public, staff only, private, a cell, or the
// wild where nobody owns anything), and every party member has a standing in the place (a prisoner
// allowed only in their own cell, an intruder allowed nowhere, a guest allowed in the public rooms,
// a resident allowed everywhere). Being where you're not allowed is trespassing: the map shows it,
// guards who see it react, and the DM is told. The DM (or an NPC through the DM) can widen or narrow
// anyone's standing. Pure module.

import { nameKey } from './text.js';

export const ZONES = Object.freeze(['public', 'restricted', 'private', 'cell', 'wild']);

/** Places open to the public (a tavern's taproom, a shop floor, a temple's nave): their back rooms are staff only. */
export const PUBLIC_KINDS = /tavern|inn\b|pub\b|alehouse|taproom|roadhouse|hostel|lodging|shop|store|smith|forge|bakery|apothecary|alchemist|tailor|butcher|jeweler|jeweller|market|temple|church|cathedral|chapel|shrine|sanctuary|monastery|abbey|bank|guild|exchange|library|academy|school|stable|interior|town|village|city|hamlet/i;
/** Places that belong to someone: everything in them is private unless you're invited. */
export const PRIVATE_KINDS = /mansion|manor|estate|chateau|villa|house|home|cottage|hut|shack|farm|cabin|lodge|hovel|homestead|mill|lighthouse|castle|keep|fortress|citadel|palace|stronghold|tower|spire|observatory|wizard|ship|galleon|boat|vessel|barge|frigate/i;
/** Places where the law is force: prisoners belong in cells, everyone else is staff. */
export const LOCKUP_KINDS = /prison|jail|gaol|stockade|lockup|penitentiary|brig\b|detention|holding|barracks|garrison|outpost|watch ?house|guard ?house|guard ?post|town ?watch/i;
/** Nobody's land: dungeons, caves, ruins, the wilds. No such thing as trespassing. */
export const WILD_KINDS = /dungeon|ruin|lair|labyrinth|maze|warren|den\b|hideout|crypt|tomb|catacomb|mausoleum|barrow|ossuary|necropolis|cave|cavern|grotto|mine|tunnel|sewer|forest|jungle|swamp|camp|wild|oasis|river|road|wilds/i;

const PUBLIC_TYPES = new Set(['tavern', 'shop', 'foyer', 'chapel', 'dining_room', 'parlor', 'courtyard', 'graveyard', 'library', 'gallery', 'ballroom', 'music_room', 'throne_room', 'smithy', 'workshop', 'stable', 'conservatory', 'trophy_room']);
const STAFF_TYPES = new Set(['kitchen', 'pantry', 'storage', 'cellar', 'wine_cellar', 'office', 'servants_quarters', 'vault', 'armory', 'guard_room', 'attic', 'laboratory', 'kennel', 'torture_chamber', 'hallway', 'crypt']);
const HOSPITALITY = new Set(['foyer', 'hallway', 'gallery', 'parlor', 'dining_room', 'ballroom', 'music_room', 'throne_room', 'chapel', 'courtyard', 'library', 'conservatory']);

/** The words that make a zone plain to the DM and on the map. */
export const ZONE_WORDS = Object.freeze({ public: 'open to anyone', restricted: 'staff only', private: 'private', cell: 'a cell (prisoners stay in their own)', wild: 'nobody\'s' });

function kindOf(place) {
    return `${place.kind || ''} ${place.hostKind || ''} ${place.name || ''}`;
}

/** What kind of place this is for access: 'wild' | 'lockup' | 'public' | 'private'. */
/**
 * Does the player's own message give in to a guard (so a DM "escort" may stand)? Their words only:
 * "fine", "I'll go", "take me back", hands up, surrender. Nothing from silence or anyone else.
 */
export function givesIn(text) {
    const t = String(text ?? '').toLowerCase().replace(/[*_~`]/g, ' ');
    if (!t.trim()) return false;
    if (/\b(never|no way|not a chance|won'?t go|will not go|refuse|get lost|make me|try me|come and get me|over my dead body)\b/.test(t)) return false;
    return /\b(fine|okay|ok|alright|all right|i give (up|in)|give up|i surrender|surrender|i yield|yield|take me( back| in)?|lead (the way|on)|i'?ll go|i go( with)?( you)?|i'?ll come|i come( quietly)?|go back( to (my|the) cell)?|back to (my|the) cell|i submit|hands up|(raise|put up|put)s? (my|his|her|their) hands|i'?ll cooperate|cooperate|don'?t hurt me|no fight|i won'?t fight|i'?ll behave|you win|as you say|i'?ll follow|you got me|you've got me|no trouble|i'?m not going anywhere|lock me up|i'?ll walk)\b/.test(t);
}

export function placeClass(place) {
    const k = kindOf(place);
    if (place.kind === 'town' || place.kind === 'wilds') return place.kind === 'town' ? 'public' : 'wild';
    if (LOCKUP_KINDS.test(k)) return 'lockup';
    if (WILD_KINDS.test(k) && !PUBLIC_KINDS.test(k) && !PRIVATE_KINDS.test(k)) return 'wild';
    if (PUBLIC_KINDS.test(k)) return 'public';
    if (PRIVATE_KINDS.test(k)) return 'private';
    return 'public';
}

/**
 * The zone of a room (or of a corridor, with room = null) in this place.
 * @returns {'public'|'restricted'|'private'|'cell'|'wild'}
 */
export function zoneOf(place, room) {
    if (room?.zone && ZONES.includes(room.zone)) return room.zone;
    const cls = placeClass(place);
    if (cls === 'wild') return 'wild';
    if (place.kind === 'town') return 'public';
    const type = String(room?.type || '');
    if (cls === 'lockup') return type === 'cell' ? 'cell' : 'restricted';
    if (!room) return cls === 'public' ? 'restricted' : 'private';
    if (cls === 'public') {
        if (room.exit || PUBLIC_TYPES.has(type)) return 'public';
        if (STAFF_TYPES.has(type)) return 'restricted';
        return /bedroom|nursery|bathroom|study/.test(type) ? 'private' : 'restricted';
    }
    // Someone's home, castle or tower: all private (a courtyard or graveyard outside is fair to cross).
    return ['courtyard', 'graveyard'].includes(type) && place.kind === 'grounds' ? 'public' : 'private';
}

/** The standing someone has: what zones and rooms they're allowed in. */
export function standingFor(label, { home = null, rooms = [] } = {}) {
    const base = { label, zones: [], rooms: [...rooms], home: home || null };
    if (label === 'free') base.zones = [...ZONES];
    else if (label === 'resident') base.zones = ['public', 'restricted', 'private', 'wild'];
    else if (label === 'guest') base.zones = ['public', 'wild'];
    else if (label === 'prisoner') { base.zones = ['wild']; if (home && !base.rooms.includes(home)) base.rooms.push(home); }
    else base.zones = ['wild']; // intruder
    return base;
}

/**
 * The party's standing when a place is built, from how they arrive. Locked in a cell: prisoners
 * (their own cell only). Sneaking, breaking in, robbing: intruders (nowhere). A tavern, shop or
 * temple: guests of its public rooms. Someone's house: guests only if invited, else intruders. The
 * wilds and dungeons: free.
 * @param {object} place
 * @param {{start?: string, why?: string, objective?: string, startRoom?: string}} how
 */
export function inferStanding(place, { start = '', why = '', objective = '', startRoom = null } = {}) {
    const cls = placeClass(place);
    const text = `${start} ${why} ${objective}`.toLowerCase();
    if (cls === 'wild') return standingFor('free');
    if (cls === 'lockup' && /\b(cell|locked|prisoner|captive|cage|caged|chained|jailed|arrested|condemned|held)\b/.test(text)) return standingFor('prisoner', { home: startRoom });
    if (/\b(sneak|break in|breaking in|infiltrat|rob|heist|steal|stealing|intrud|climb in|creep|burgl|slip in|unseen|unnoticed|escape)\b/.test(text)) return standingFor('intruder');
    if (/\b(live|lives|living|own|owner|home|resident|staff|work here|works here|employed)\b/.test(text)) return standingFor('resident');
    if (cls === 'public') return standingFor('guest');
    if (cls === 'lockup') return /\b(guard|warden|visit|visiting|hired|deliver|report|summon|invit)\b/.test(text) ? standingFor('guest', { rooms: hospitalityRooms(place) }) : standingFor('intruder');
    // A private place: guests when invited or arriving openly, else intruders.
    if (/\b(invit|guest|welcome|host|visit|dinner|party|audience|summon|meeting|received|expected|arriv|knock|front door|announc)\b/.test(text)) return standingFor('guest', { rooms: hospitalityRooms(place) });
    return standingFor('intruder');
}

/** The rooms a guest of a private house may be in: the hall, parlor, dining room and the like. */
export function hospitalityRooms(place) {
    return Object.values(place.rooms || {}).filter(r => HOSPITALITY.has(String(r.type)) || r.exit).map(r => r.id);
}

/** Someone's standing in this place (a plain 'guest' when none was ever set). */
export function standingOf(place, name) {
    const acc = place.state?.access?.[name];
    return acc && Array.isArray(acc.zones) ? acc : standingFor(placeClass(place) === 'wild' ? 'free' : 'guest');
}

export function setStanding(place, name, standing) {
    place.state.access ??= {};
    place.state.access[name] = { label: standing.label, zones: [...standing.zones], rooms: [...(standing.rooms || [])], home: standing.home || null };
    return place.state.access[name];
}

/** May this person be in this room (null = a corridor on `floorId`)? */
export function allowedIn(place, name, room) {
    const st = standingOf(place, name);
    if (room && st.rooms.includes(room.id)) return true;
    const zone = zoneOf(place, room);
    if (st.zones.includes(zone)) return true;
    // A prisoner may stand in the doorway of their own cell block? No: out of the cell is out.
    return false;
}

/**
 * Is `name` somewhere they're not allowed right now? {room, zone, why} or null.
 * why: 'escaped' (a prisoner out of their cell), 'private', 'staff only', 'not allowed'.
 */
export function trespassOf(place, name, roomAtFn) {
    const pos = place.state?.positions?.[name];
    if (!pos) return null;
    const room = roomAtFn(place, pos.floor, pos.x, pos.y);
    if (allowedIn(place, name, room)) return null;
    const st = standingOf(place, name);
    const zone = zoneOf(place, room);
    const why = st.label === 'prisoner' ? 'escaped' : zone === 'restricted' ? 'staff only' : zone === 'private' ? 'private' : zone === 'cell' ? 'not their cell' : 'not allowed';
    return { room: room?.name ?? 'a passage', roomId: room?.id ?? null, zone, why, label: st.label };
}

/**
 * The DM widens or narrows someone's standing. spec: "all" | "public" | "none" | "prisoner" |
 * ["G4", "G5"] (those rooms added) | {"allow": [rooms], "deny": [rooms], "zones": [...], "label": "guest"}.
 * name "*" = every party member listed in `party`. Returns a log line or ''.
 */
export function grantAccess(place, name, spec, party = []) {
    const names = name === '*' ? party : [name];
    const lines = [];
    for (const n of names) {
        const cur = { ...standingOf(place, n), rooms: [...standingOf(place, n).rooms] };
        if (typeof spec === 'string') {
            const s = spec.toLowerCase().trim();
            if (s === 'all' || s === 'everywhere' || s === 'resident' || s === 'free') Object.assign(cur, { label: 'resident', zones: ['public', 'restricted', 'private', 'cell', 'wild'] });
            else if (s === 'public' || s === 'guest') Object.assign(cur, { label: 'guest', zones: ['public', 'wild'] });
            else if (s === 'none' || s === 'intruder' || s === 'nowhere') Object.assign(cur, { label: 'intruder', zones: ['wild'], rooms: [] });
            else if (s === 'prisoner') Object.assign(cur, standingFor('prisoner', { home: cur.home }));
            else if (place.rooms?.[spec]) { if (!cur.rooms.includes(spec)) cur.rooms.push(spec); }
            else continue;
        } else if (Array.isArray(spec)) {
            for (const id of spec) { const rm = roomRef(place, id); if (rm && !cur.rooms.includes(rm.id)) cur.rooms.push(rm.id); }
        } else if (spec && typeof spec === 'object') {
            for (const id of Array.isArray(spec.allow) ? spec.allow : []) { const rm = roomRef(place, id); if (rm && !cur.rooms.includes(rm.id)) cur.rooms.push(rm.id); }
            for (const id of Array.isArray(spec.deny) ? spec.deny : []) { const rm = roomRef(place, id); if (rm) cur.rooms = cur.rooms.filter(x => x !== rm.id); }
            if (Array.isArray(spec.zones)) cur.zones = spec.zones.map(z => String(z).toLowerCase()).filter(z => ZONES.includes(z));
            if (typeof spec.label === 'string' && ['prisoner', 'intruder', 'guest', 'resident', 'free'].includes(spec.label)) cur.label = spec.label;
        } else continue;
        setStanding(place, n, cur);
        lines.push(`${n}: ${describeStanding(place, cur)}`);
    }
    return lines.join('; ');
}

function roomRef(place, ref) {
    const s = String(ref ?? '').trim();
    return place.rooms?.[s] ?? Object.values(place.rooms || {}).find(r => nameKey(r.name) === nameKey(s.replace(/^the\s+/i, ''))) ?? null;
}

/** A standing in words. */
export function describeStanding(place, st) {
    const rooms = (st.rooms || []).map(id => place.rooms?.[id]?.name ?? id);
    const where = st.label === 'resident' || st.label === 'free' ? 'allowed everywhere'
        : st.label === 'prisoner' ? `a prisoner: allowed only in ${rooms.length ? rooms.join(', ') : 'their cell'}`
            : st.label === 'guest' ? `a guest: the public rooms${rooms.length ? `, and ${rooms.join(', ')}` : ''}`
                : `an intruder: allowed nowhere${rooms.length ? ` but ${rooms.join(', ')}` : ''}`;
    return where;
}

/** The access picture for the DM: each party member's standing and the zones of the place's rooms. */
export function accessSummary(place, partyNames, roomAtFn) {
    const cls = placeClass(place);
    if (cls === 'wild') return '';
    const lines = ['ACCESS (who may be where; the code marks trespassing on the map and tells you when a guard sees it):'];
    for (const n of partyNames) {
        const st = standingOf(place, n);
        const t = trespassOf(place, n, roomAtFn);
        lines.push(`- ${n}: ${describeStanding(place, st)}${t ? `. NOW TRESPASSING in ${t.room} (${t.why === 'escaped' ? 'an escaped prisoner' : t.why})` : ''}`);
    }
    const byZone = {};
    for (const r of Object.values(place.rooms || {})) (byZone[zoneOf(place, r)] ??= []).push(r.name);
    for (const z of ['public', 'restricted', 'private', 'cell']) if (byZone[z]?.length) lines.push(`- ${ZONE_WORDS[z]}: ${byZone[z].slice(0, 24).join(', ')}${byZone[z].length > 24 ? '…' : ''}`);
    lines.push('Change a standing with place_changes.access ({"Amber": "public" | "all" | "none" | ["G4", "G5"] | {"allow": ["the kitchen"], "deny": [...]}}; "*" = the whole party): a guard lets them through, the host invites them in, they\'re caught and locked up.');
    return lines.join('\n');
}
