// Room descriptions, written the first time the party walks in (not all up front): the local model
// writes one from the room's facts (its kind, what's really in it, how the place is kept, the
// planner's notes), or, without a model, it's put together here from varied pieces so no two rooms
// read the same. Pure module.

/** What a room of each kind is like at a glance (several ways to say it). */
const OPENERS = {
    foyer: ['A high hall opens up, its floor worn smooth by years of boots.', 'The entrance hall is wide and echoing, built to impress visitors.', 'A grand stair hall greets you, colder than you expected.'],
    hallway: ['A corridor runs on ahead, doors set along its walls.', 'The passage is narrow and draughty.', 'A long hall stretches out, your footsteps loud in it.'],
    gallery: ['Paintings line the walls, their eyes following you down the room.', 'A long gallery, lined with portraits and old statues.'],
    library: ['Shelves climb to the ceiling, packed with books.', 'The smell of old paper and leather fills the room.', 'Books everywhere: on shelves, on the desk, stacked on the floor.'],
    study: ['A cramped study, the desk buried in papers.', 'A private room for work, with a writing desk and a single chair.'],
    bedroom: ['A bedroom, the bed neatly made.', 'Someone sleeps here: the bed, a wardrobe, a few personal things.', 'A small bedroom with the curtains drawn.'],
    master_bedroom: ['A large, rich bedchamber with a great bed hung with curtains.', 'The master\'s bedroom: heavy furniture, a fireplace, the best of everything.'],
    dining_room: ['A long table runs down the room, set with chairs.', 'The dining room smells faintly of old meals and candle wax.'],
    kitchen: ['A busy kitchen: a big hearth, pots hanging, a worn table.', 'The kitchen is warm and smells of smoke and bread.'],
    pantry: ['Shelves of jars, sacks and barrels crowd the pantry.', 'A cool little store room full of food.'],
    storage: ['Crates and barrels are stacked against the walls.', 'A cluttered store room, everything covered in dust.'],
    cellar: ['A low, damp cellar, the walls sweating.', 'Stone steps lead down into a cold, musty cellar.'],
    wine_cellar: ['Racks of barrels and dusty bottles fill the wine cellar.', 'It smells of oak and old wine down here.'],
    parlor: ['A comfortable parlor with soft chairs round the fireplace.', 'A sitting room, cozy and a little cluttered.'],
    ballroom: ['A vast ballroom, its polished floor reflecting the chandeliers.', 'The ballroom is huge and silent, built for a hundred dancers.'],
    music_room: ['A piano stands in the middle of the room.', 'A music room, instruments resting in the corners.'],
    bathroom: ['A small bathroom with a tub and a mirror.', 'A tiled washroom, cold underfoot.'],
    chapel: ['Rows of pews face an altar at the far end.', 'A quiet chapel, candles flickering before the altar.'],
    trophy_room: ['Mounted heads and old weapons cover the walls.', 'A room of trophies: antlers, armor, things in glass cases.'],
    torture_chamber: ['Chains hang from the walls; there are tools here no one should own.', 'A grim room with a rack, chains and old stains on the floor.'],
    cell: ['A cramped stone cell behind iron bars.', 'A tiny cell: a straw mat, a bucket, a chain bolted to the wall.', 'Four close walls and a barred door.'],
    kennel: ['Kennels and cages line the room; it smells of wet dog.', 'Pens with chains and empty bowls.'],
    laboratory: ['Glassware, burners and strange jars cover the benches.', 'A laboratory that smells sharp and bitter.'],
    workshop: ['Benches and tools fill the workshop.', 'A working room, sawdust and shavings on the floor.'],
    smithy: ['A forge glows red; an anvil stands before it.', 'Heat rolls off the forge; tools hang in neat rows.'],
    armory: ['Racks of weapons and suits of armor stand in rows.', 'The armory is full of steel, oiled and ready.'],
    guard_room: ['A guard room: a table, a few chairs, a rack of spears.', 'A plain room where guards wait out their shift.'],
    servants_quarters: ['Narrow beds in a row, a trunk at the foot of each.', 'The servants\' rooms are plain and crowded.'],
    nursery: ['A child\'s room: a small bed, old toys.', 'A nursery, painted in faded colors.'],
    conservatory: ['Plants crowd the glass-walled room.', 'Warm, damp air and greenery everywhere.'],
    crypt: ['Stone coffins rest in niches along the walls.', 'A cold crypt; the dead lie in rows here.'],
    throne_room: ['A great hall leads up to a throne on a raised dais.', 'Banners hang above a long carpet running to the throne.'],
    attic: ['A dusty attic under the slope of the roof.', 'The attic is cramped and full of forgotten things.'],
    tavern: ['A noisy common room: tables, a long counter, a fire.', 'The taproom smells of ale and woodsmoke.'],
    shop: ['A shop with a long counter and shelves of goods.', 'Wares cover every shelf of the little shop.'],
    vault: ['A heavy stone room with chests along the walls.', 'The vault is small, thick-walled and silent.'],
    stable: ['Stalls line the stable; it smells of hay and horse.', 'A stable with a few horses shifting in their stalls.'],
    office: ['A tidy office with a desk and cabinets of records.', 'A small office, ledgers piled on the desk.'],
    cave: ['A rough cave, water dripping somewhere in the dark.', 'The cavern opens up around you, its ceiling lost in shadow.', 'A cave of cold, damp rock.'],
    courtyard: ['An open courtyard under the sky.', 'A yard paved with old stones.'],
    room: ['A plain room.', 'A small, bare chamber.'],
};
/** The feel of the place: by how it's kept and the kind of place. */
const AIR = {
    kept: ['Everything is clean and in its place.', 'It\'s tidy and well kept.', 'Someone looks after this room.'],
    worn: ['It has seen better days.', 'Things are worn and a little shabby.', 'Dust has gathered in the corners.'],
    ruined: ['Dust and rubble lie everywhere.', 'It\'s been abandoned a long time.', 'Decay has crept into everything.', 'Cobwebs hang thick in the corners.'],
};
const DARK = ['It\'s dark; only your light shows the way.', 'Shadows fill the corners.', 'No lamps burn here.'];
const LIT = ['Lamps burn on the walls.', 'Candles light the room.', 'Light comes in through the windows.'];

function pick(seed, list) {
    let h = 2166136261;
    for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return list[(h >>> 0) % list.length];
}

/**
 * A description from pieces, without a model: what the room is, what's notable in it, its air.
 * room: {id, name, type, lit, hint}; things: names of what's in it; condition: kept|worn|ruined.
 */
export function describeRoom(room, { things = [], condition = 'kept', placeName = '' } = {}) {
    const key = `${placeName}:${room.id}`;
    const parts = [pick(key, OPENERS[room.type] ?? OPENERS.room)];
    // What's here that the opening line didn't already mention ("shelves" covers the bookshelf).
    const said = parts[0].toLowerCase();
    const notable = [...new Set(things)].filter(t => !/torch|candles|rug|painting|chandelier|plant/.test(t) && !said.includes(t.toLowerCase().split(' ').pop().slice(0, 4))).slice(0, 2);
    const a = t => (/[^s]s$/.test(t) ? t : /^[aeiou]/i.test(t) ? `an ${t}` : `a ${t}`);
    if (notable.length) parts.push(`There ${notable.length > 1 || /[^s]s$/.test(notable[0]) ? 'are' : 'is'} ${notable.map(a).join(' and ')} here.`);
    if (room.hint) parts.push(room.hint.charAt(0).toUpperCase() + room.hint.slice(1).replace(/[.;]?$/, '.'));
    parts.push(pick(`${key}:air`, room.lit ? [...LIT, ...(AIR[condition] ?? AIR.kept)] : [...DARK, ...(AIR[condition] ?? AIR.kept)]));
    return parts.join(' ');
}

/** The prompt for the local model to describe a room from its facts. */
export function describePrompt(room, { things = [], condition = 'kept', placeName = '', kind = '', mood = '', time = '', outdoors = false } = {}) {
    const system = 'You write short, vivid room descriptions for a tabletop roleplaying game. Plain simple English. Reply with the description only.';
    const user = [
        `Place: ${placeName}${kind ? ` (${kind})` : ''}${mood ? `, ${mood}` : ''}; ${condition === 'ruined' ? 'ruined and abandoned' : condition === 'worn' ? 'lived in and a bit run down' : 'kept up and tidy'}.`,
        `${outdoors ? 'Spot' : 'Room'}: ${room.name} (${String(room.type).replace(/_/g, ' ')}), ${room.lit ? 'lit' : 'dark'}${time ? `, ${time}` : ''}.${outdoors ? ' Outdoors, open land: no walls, lamps or furniture unless listed.' : ''}`,
        `In it: ${things.length ? things.join(', ') : 'nothing much'}.`,
        room.hint ? `Notes: ${room.hint}` : '',
        '',
        'Write 1-2 sentences (at most 40 words): what the party sees, hears and smells as they walk in. Use only these facts: no people, no new exits, no items or secrets that are not listed, and no mention of game rules.',
    ].filter(Boolean).join('\n');
    return { system, user };
}

/** A model's reply cleaned up: one or two sentences, no quotes or labels. Empty when it's unusable. */
const PEOPLE = /\b(guards?|watchm[ae]n|jailers?|turnkeys?|soldiers?|servants?|cooks?|clerks?|priests?|monks?|prisoners?|men|women|man|woman|boys?|girls?|child(ren)?|figures?|someone|somebody|people|person|wardens?|sentr(y|ies))\b/i;

export function cleanDescription(text) {
    let t = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/^\s*(description|room)\s*:\s*/i, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
    // Nobody is in a room description: people on the map are the map's business ("a lone guard sits" invents a guard).
    const sentences = (t.match(/[^.!?]+[.!?]+/g) ?? []).filter(s => !PEOPLE.test(s));
    t = sentences.slice(0, 2).map(x => x.trim()).join(' ') || t;
    return t.length >= 12 && t.length <= 400 ? t : '';
}
