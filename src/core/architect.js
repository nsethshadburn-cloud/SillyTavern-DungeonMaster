// The architect: builds a whole place's plan from a short brief, by algorithm, from a seed. A model
// (the local helper or Haiku) only writes the brief: what the place is, how big, its mood, and the
// few things the story needs there (the ledger in a hidden study, the warden with the keys, the
// party locked in a cell). Everything else is decided here: which rooms a place of that kind has,
// what they're called, how they join up (a spine corridor, wings, a hub, a maze), floors and stairs,
// locks and keys, secrets, guards and residents, traps, loot, and a couple of twists so no two
// places feel the same. The plan goes through the same normalizePlan and common-sense rules
// (rules.js) as a plan Claude writes, then the same geometry. Pure module.

import { roomType } from './rooms.js';
import { nameKey } from './text.js';

// ---------- randomness ----------

function rngOf(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const chance = (r, p) => r() < p;
function shuffle(r, list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- names ----------

const FAMILY_A = ['Black', 'Ash', 'Thorn', 'Raven', 'Hollow', 'Grey', 'Wyn', 'Mor', 'Ald', 'Hal', 'Cor', 'Vel', 'Dun', 'Fen', 'Stor', 'Wex', 'Brann', 'Lock', 'Mar', 'Sel', 'Crow', 'Elder', 'Frost', 'Gal', 'Har', 'Ives', 'Kel', 'Lark', 'Nor', 'Oak', 'Pell', 'Quill', 'Rook', 'Sable', 'Tarn', 'Umber', 'Vane', 'Whit', 'Yew'];
const FAMILY_B = ['wood', 'more', 'ridge', 'stone', 'vale', 'croft', 'by', 'ford', 'well', 'holt', 'mere', 'hart', 'wick', 'ley', 'ton', 'borne', 'gate', 'field', 'ward', 'cliff', 'hollow', 'marsh', 'combe', 'fell', 'water'];
const GIVEN = ['Aldric', 'Mira', 'Tobias', 'Isolde', 'Corin', 'Wren', 'Edda', 'Halvard', 'Sabine', 'Osric', 'Lys', 'Bram', 'Celia', 'Dorian', 'Fenna', 'Gideon', 'Hester', 'Ivo', 'Jessamy', 'Kester', 'Liesel', 'Magnus', 'Nell', 'Orla', 'Percival', 'Quenna', 'Rowan', 'Silas', 'Tamsin', 'Ulric', 'Verity', 'Wendel', 'Yara', 'Agatha', 'Benedikt', 'Cressida', 'Darrow', 'Elspeth', 'Florian', 'Greta', 'Hollis', 'Ingrid', 'Jasper', 'Katrin', 'Leopold', 'Maud', 'Nikolai', 'Ottilie'];
const COLORS = ['Blue', 'Green', 'Rose', 'Gold', 'Ivory', 'Crimson', 'Amber', 'Jade', 'Violet', 'Silver', 'Ochre', 'Saffron', 'Grey', 'Copper', 'Pearl'];
const SAINTS = ['Saint Aldwyn', 'Saint Vey', 'the Lantern Saint', 'Saint Morrow', 'the Quiet Mother', 'Saint Hesk', 'the Drowned Saint', 'Saint Ilse', 'the Pale Shepherd'];
const ADJ = ['Old', 'Long', 'Low', 'High', 'Narrow', 'Cold', 'Quiet', 'Lower', 'Upper', 'Back', 'Sunken', 'Crooked'];
const WINGS = ['East', 'West', 'North', 'South'];

function familyName(r) { return pick(r, FAMILY_A) + pick(r, FAMILY_B); }

/**
 * Room names by type: templates with {fam} (the household's name), {given} (someone's first
 * name), {color}, {saint}, {adj}, {wing}. Each place uses a name once.
 */
const ROOM_NAMES = {
    foyer: ['Entrance Hall', 'Great Hall', 'Vestibule', '{fam} Hall', 'Front Hall', 'Marble Hall', 'Stair Hall', 'Reception Hall'],
    hallway: ['{wing} Corridor', '{adj} Passage', '{wing} Wing Hall', 'Servants\' Passage', '{color} Corridor', 'Upper Landing', 'Portrait Walk', '{adj} Hall'],
    gallery: ['Portrait Gallery', 'Long Gallery', '{color} Gallery', 'Sculpture Gallery', '{fam} Gallery'],
    library: ['Library', '{fam} Library', 'Reading Room', 'Map Room', 'Old Library', 'Archive'],
    study: ['Study', '{given}\'s Study', 'Writing Room', 'Private Study', 'Cabinet Room', 'Counting Room'],
    bedroom: ['{given}\'s Bedroom', 'The {color} Bedroom', 'Guest Room', '{given}\'s Room', 'East Bedroom', 'West Bedroom', 'Corner Bedroom', 'The {color} Room'],
    master_bedroom: ['Master Bedroom', 'Lord\'s Chamber', 'Lady\'s Chamber', 'The {fam} Suite', 'Great Chamber', 'Master Suite'],
    dining_room: ['Dining Room', 'Banquet Hall', 'Long Dining Hall', 'Breakfast Room', 'Supper Room'],
    kitchen: ['Kitchen', 'Kitchens', 'Scullery Kitchen', 'Bakehouse'],
    pantry: ['Pantry', 'Larder', 'Cold Store', 'Buttery', 'Spice Pantry'],
    storage: ['Storeroom', 'Linen Closet', 'Box Room', 'Lumber Room', 'Supply Closet', 'Broom Closet', 'Tack Room'],
    cellar: ['Cellar', 'Root Cellar', 'Undercroft', 'Coal Cellar', 'Old Cellar'],
    wine_cellar: ['Wine Cellar', 'Wine Vault', '{fam} Vintage Cellar'],
    parlor: ['Parlor', 'Drawing Room', 'The {color} Parlor', 'Sitting Room', 'Morning Room', 'Card Room', 'Smoking Room'],
    ballroom: ['Ballroom', 'Mirror Ballroom', 'Grand Ballroom', 'Dancing Hall'],
    music_room: ['Music Room', 'Harp Room', 'Recital Room'],
    bathroom: ['Bathroom', 'Bath', 'Washroom', 'Privy', 'Bathing Room'],
    chapel: ['Chapel', 'Chapel of {saint}', 'Shrine of {saint}', 'Oratory', 'Prayer Room'],
    trophy_room: ['Trophy Room', 'Hunting Room', 'Hall of Trophies', 'Curiosity Room'],
    torture_chamber: ['Interrogation Room', 'Question Room', 'Torture Chamber', 'The Pit Room', 'Room of Confessions'],
    cell: ['Cell {n}', 'Cell {n}', 'Cell {n}', 'Holding Cell {n}', 'Cell {n}'],
    kennel: ['Kennels', 'Hound Room', 'Dog Pens', 'Beast Pens'],
    laboratory: ['Laboratory', 'Alchemy Room', 'Still Room', 'Workroom', 'The {given} Laboratory'],
    workshop: ['Workshop', 'Joinery', 'Tinker\'s Room', 'Repair Shop'],
    smithy: ['Forge', 'Smithy', 'Armorer\'s Forge'],
    armory: ['Armory', 'Arms Room', 'Weapon Store', 'Guard Armory'],
    guard_room: ['Guardroom', 'Guard Post', 'Watch Room', 'Turnkey\'s Post', 'Barracks', 'Gate Room'],
    servants_quarters: ['Servants\' Quarters', 'Servants\' Hall', 'Maids\' Room', 'Footmen\'s Room', 'Staff Dormitory'],
    nursery: ['Nursery', 'Children\'s Room', 'Schoolroom', 'Playroom'],
    conservatory: ['Conservatory', 'Orangery', 'Glasshouse', 'Winter Garden'],
    crypt: ['Crypt', 'Ossuary', 'Burial Vault', 'Tomb of {given}', 'Charnel Room', 'Catacomb'],
    throne_room: ['Throne Room', 'Great Hall', 'Hall of Audience', 'Lord\'s Hall'],
    attic: ['Attic', 'Garret', 'Loft', 'Roof Space'],
    tavern: ['Common Room', 'Taproom', 'Main Hall', 'Bar Room'],
    shop: ['Shop Floor', 'Front Shop', 'Showroom', 'Counter Room'],
    vault: ['Vault', 'Strongroom', 'Treasury', 'Coin Vault', 'Reliquary'],
    stable: ['Stables', 'Stable', 'Coach House'],
    office: ['Office', '{given}\'s Office', 'Warden\'s Office', 'Records Office', 'Steward\'s Office', 'Clerk\'s Room'],
    cave: ['Cavern', 'Grotto', '{adj} Cave', 'Dripping Hollow', 'Crystal Grotto', 'Bone Cave', 'Echo Chamber', 'Fungus Cave', 'Sinkhole'],
    room: ['Chamber', 'Side Room', 'Small Room', 'Old Room', 'Back Room'],
};

/** Every kind of place: its rooms, how they join up, who's there, its traps, loot and twists. */
// Room slots: [type, level, [min, max], chance, opts]. opts: name (a fixed name or list), size,
// parent (types it opens off), hub (rooms open off it), exit (the way out), lit, locked (chance).
const BLUEPRINTS = [
    {
        id: 'prison', match: /prison|jail|gaol|stockade|lockup|penitentiary|brig\b|detention|holding/, theme: 'prison', building: true, style: ['spine', 'spine', 'wings'],
        sizes: { small: [8, 12], medium: [18, 26], big: [40, 52] },
        rooms: [
            ['guard_room', 0, [1, 1], 1, { hub: true, exit: true, name: ['Gate Room', 'Front Guardroom', 'Intake Hall', 'Turnkey\'s Post'] }],
            ['cell', 0, [3, 6], 1, {}],
            ['office', 0, [1, 1], 1, { name: ['Warden\'s Office', 'Jailer\'s Office', 'Keeper\'s Office'], parent: ['guard_room', 'hallway'] }],
            ['armory', 0, [1, 1], 0.7, { parent: ['guard_room', 'hallway'] }],
            ['storage', 0, [1, 2], 0.8, { name: ['Evidence Room', 'Confiscated Goods', 'Supply Closet', 'Linen Store'] }],
            ['kitchen', 0, [1, 1], 0.6, { name: ['Prison Kitchen', 'Mess Kitchen'] }],
            ['dining_room', 0, [1, 1], 0.5, { name: ['Mess Hall', 'Guards\' Mess'] }],
            ['servants_quarters', 0, [1, 2], 0.6, { name: ['Guards\' Bunks', 'Barracks Room', 'Night Watch Room'] }],
            ['torture_chamber', -1, [1, 1], 0.5, {}],
            ['cell', -1, [2, 4], 0.45, { name: ['Solitary {n}', 'The Hole', 'Deep Cell {n}', 'Oubliette'] }],
            ['chapel', 0, [1, 1], 0.25, { name: ['Prison Chapel', 'Confessional'] }],
            ['room', 0, [1, 1], 0.4, { name: ['Infirmary', 'Sick Ward'], type: 'bedroom' }],
            ['library', 0, [1, 1], 0.2, { name: ['Records Room', 'Ledger Room'] }],
            ['kennel', 0, [1, 1], 0.25, { name: ['Dog Kennels', 'Hound Pens'] }],
            ['cell', 1, [3, 5], 0.35, {}],
            ['guard_room', 1, [1, 1], 0.35, { name: ['Upper Watch', 'Tower Post'] }],
        ],
        filler: ['cell', 'storage', 'cell'],
        guards: { n: { small: [1, 2], medium: [2, 3], big: [3, 5] }, words: ['Guard', 'Turnkey', 'Jailer', 'Watchman'], named: 0.5, titles: ['Sergeant', 'Turnkey', 'Guard Captain', 'Old'] },
        people: [['prisoner', 'cell', 0.6, ['a hollow-eyed prisoner', 'a chatty pickpocket in for a week', 'a silent prisoner chained to the wall', 'a debtor who swears he\'s innocent']]],
        traps: 'none', locks: [['armory', 0.9], ['office', 0.5], ['storage', 0.4]], keyHolders: ['office', 'guard_room'],
        loot: ['a ring of spare keys', 'a confiscated dagger', 'a sack of prisoners\' belongings', 'the prisoner ledger', 'a stolen signet ring', 'a forged writ of release'],
        twists: ['tunnel', 'riot', 'bribe', 'oubliette', 'hound', 'records'],
    },
    {
        id: 'mansion', match: /mansion|manor|estate|chateau|villa|hall\b|house of|residence/, theme: 'mansion', building: true, style: ['wings', 'spine', 'hub'],
        sizes: { small: [10, 14], medium: [18, 26], big: [36, 48] },
        rooms: [
            ['foyer', 0, [1, 1], 1, { hub: true, exit: true }],
            ['parlor', 0, [1, 2], 1, {}],
            ['dining_room', 0, [1, 1], 1, {}],
            ['kitchen', 0, [1, 1], 1, {}],
            ['pantry', 0, [1, 1], 0.8, { parent: ['kitchen'] }],
            ['library', 0, [1, 1], 0.8, {}],
            ['study', 0, [1, 1], 0.8, { parent: ['library', 'hallway'] }],
            ['servants_quarters', 0, [1, 1], 0.7, { parent: ['kitchen', 'hallway'] }],
            ['ballroom', 0, [1, 1], 0.35, {}],
            ['music_room', 0, [1, 1], 0.35, {}],
            ['gallery', 0, [1, 1], 0.4, {}],
            ['conservatory', 0, [1, 1], 0.3, {}],
            ['trophy_room', 0, [1, 1], 0.25, {}],
            ['chapel', 0, [1, 1], 0.2, {}],
            ['master_bedroom', 1, [1, 1], 1, {}],
            ['bedroom', 1, [2, 4], 1, {}],
            ['bathroom', 1, [1, 2], 0.8, { parent: ['master_bedroom', 'bedroom', 'hallway'] }],
            ['nursery', 1, [1, 1], 0.35, {}],
            ['storage', 1, [1, 1], 0.5, { name: ['Linen Closet', 'Box Room'] }],
            ['study', 1, [1, 1], 0.3, { name: ['Lady\'s Writing Room', 'Upstairs Study'] }],
            ['cellar', -1, [1, 1], 0.7, {}],
            ['wine_cellar', -1, [1, 1], 0.6, {}],
            ['storage', -1, [1, 1], 0.4, { name: ['Coal Store', 'Old Storeroom'] }],
            ['attic', 2, [1, 1], 0.35, {}],
            ['storage', 2, [1, 1], 0.25, { name: ['Garret Storeroom'] }],
        ],
        filler: ['bedroom', 'parlor', 'storage', 'bedroom'],
        guards: { n: { small: [0, 1], medium: [0, 2], big: [1, 3] }, words: ['Footman', 'Groundsman', 'House Guard'], named: 0.6, titles: ['Old', 'Master', 'Sergeant'] },
        people: [['servant', 'kitchen', 0.6, ['the cook, flour to the elbows', 'a nervous scullery maid', 'the housekeeper with a ring of keys']], ['servant', 'servants_quarters', 0.4, ['a footman off duty', 'a maid mending linen']]],
        traps: 'few', locks: [['study', 0.5], ['master_bedroom', 0.3], ['wine_cellar', 0.4], ['nursery', 0.2]], keyHolders: ['master_bedroom', 'study', 'servants_quarters', 'kitchen'],
        loot: ['a silver candelabra', 'a bundle of love letters', 'the household accounts', 'a jeweled snuffbox', 'a family signet ring', 'a locket with a faded portrait', 'a decanter of very old brandy', 'a deed to the estate'],
        twists: ['sealed_room', 'priest_hole', 'burnt_wing', 'missing_portrait', 'servant_stair', 'collector', 'flooded_cellar', 'hidden_vault'],
    },
    {
        id: 'castle', match: /castle|keep|fortress|citadel|palace|stronghold|bastion|fort\b/, theme: 'castle', building: true, style: ['spine', 'hub', 'wings'],
        sizes: { small: [12, 16], medium: [22, 30], big: [42, 55] },
        rooms: [
            ['foyer', 0, [1, 1], 1, { hub: true, exit: true, name: ['Gatehouse Hall', 'Entrance Hall', 'Outer Hall'] }],
            ['throne_room', 0, [1, 1], 1, {}],
            ['guard_room', 0, [1, 2], 1, {}],
            ['armory', 0, [1, 1], 0.9, {}],
            ['kitchen', 0, [1, 1], 1, { name: ['Great Kitchen', 'Kitchens'] }],
            ['pantry', 0, [1, 1], 0.8, { parent: ['kitchen'] }],
            ['dining_room', 0, [1, 1], 0.8, { name: ['Great Hall', 'Feast Hall', 'Banquet Hall'] }],
            ['chapel', 0, [1, 1], 0.6, {}],
            ['smithy', 0, [1, 1], 0.4, {}],
            ['stable', 0, [1, 1], 0.3, {}],
            ['servants_quarters', 0, [1, 2], 0.7, { name: ['Barracks', 'Soldiers\' Hall', 'Servants\' Hall'] }],
            ['master_bedroom', 1, [1, 1], 1, { name: ['Royal Chamber', 'Lord\'s Solar', 'The Solar'] }],
            ['bedroom', 1, [2, 4], 1, {}],
            ['library', 1, [1, 1], 0.6, {}],
            ['study', 1, [1, 1], 0.6, { name: ['Council Room', 'War Room', 'Lord\'s Study'] }],
            ['gallery', 1, [1, 1], 0.4, { name: ['Long Gallery', 'Banner Hall'] }],
            ['bathroom', 1, [1, 1], 0.5, {}],
            ['vault', -1, [1, 1], 0.7, { name: ['Treasury', 'Strongroom'] }],
            ['cell', -1, [2, 5], 0.7, {}],
            ['torture_chamber', -1, [1, 1], 0.4, {}],
            ['cellar', -1, [1, 1], 0.7, { name: ['Undercroft', 'Storage Vaults'] }],
            ['crypt', -2, [1, 1], 0.3, { name: ['Royal Crypt', 'Ancestral Tomb'] }],
            ['guard_room', 2, [1, 1], 0.5, { name: ['Tower Watch', 'Battlement Post'] }],
            ['storage', 2, [1, 1], 0.4, { name: ['Tower Store'] }],
        ],
        filler: ['bedroom', 'guard_room', 'storage', 'hallway'],
        guards: { n: { small: [2, 3], medium: [3, 4], big: [4, 6] }, words: ['Guard', 'Soldier', 'Man-at-arms', 'Sentry', 'Knight'], named: 0.5, titles: ['Sir', 'Captain', 'Sergeant'] },
        people: [['servant', 'kitchen', 0.5, ['a red-faced cook', 'a kitchen boy']], ['servant', 'chapel', 0.4, ['the castle chaplain']], ['prisoner', 'cell', 0.5, ['a starving prisoner', 'a captured spy']]],
        traps: 'few', locks: [['vault', 1], ['armory', 0.7], ['study', 0.4], ['master_bedroom', 0.3]], keyHolders: ['master_bedroom', 'study', 'guard_room'],
        loot: ['a sealed royal decree', 'a chest of tax coin', 'a jeweled circlet', 'old war maps', 'a ceremonial sword', 'a ledger of bribes'],
        twists: ['siege_damage', 'throne_passage', 'collapsed_tower', 'hidden_vault', 'servant_stair', 'oubliette'],
    },
    {
        id: 'temple', match: /temple|church|cathedral|chapel|monastery|abbey|shrine|sanctuary|priory|convent|cloister/, theme: 'temple', building: true, style: ['spine', 'hub'],
        sizes: { small: [6, 9], medium: [12, 18], big: [26, 36] },
        rooms: [
            ['chapel', 0, [1, 1], 1, { hub: true, exit: true, name: ['Nave', 'Great Nave', 'Hall of {saint}'] }],
            ['chapel', 0, [1, 1], 1, { name: ['Sanctum', 'Inner Sanctum', 'Altar of {saint}', 'Holy of Holies'] }],
            ['study', 0, [1, 1], 0.9, { name: ['Vestry', 'Sacristy', 'Priest\'s Study'] }],
            ['library', 0, [1, 1], 0.6, { name: ['Scriptorium', 'Temple Library'] }],
            ['servants_quarters', 0, [1, 2], 0.7, { name: ['Dormitory', 'Monks\' Cells', 'Acolytes\' Hall'] }],
            ['dining_room', 0, [1, 1], 0.5, { name: ['Refectory'] }],
            ['kitchen', 0, [1, 1], 0.5, {}],
            ['storage', 0, [1, 1], 0.5, { name: ['Candle Store', 'Vestment Closet'] }],
            ['vault', 0, [1, 1], 0.4, { name: ['Reliquary', 'Offering Vault'] }],
            ['crypt', -1, [1, 3], 0.7, {}],
            ['hallway', -1, [1, 1], 0.4, { name: ['Catacomb Passage', 'Bone Walk'] }],
            ['guard_room', 1, [1, 1], 0.3, { name: ['Bell Tower'] }],
        ],
        filler: ['crypt', 'storage', 'servants_quarters'],
        guards: { n: { small: [0, 1], medium: [1, 2], big: [2, 4] }, words: ['Temple Guard', 'Warden', 'Zealot'], named: 0.4, titles: ['Deacon', 'Acolyte', 'Warden'] },
        people: [['priest', 'chapel', 0.7, ['the high priest, tired and watchful', 'a young acolyte sweeping', 'an old nun lighting candles']]],
        traps: 'few', locks: [['vault', 0.9], ['study', 0.3]], keyHolders: ['study', 'servants_quarters'],
        loot: ['a silver reliquary', 'a holy symbol', 'a censer', 'a forbidden prayer book', 'the temple tithe box', 'a vial of holy water'],
        twists: ['desecrated', 'hidden_reliquary', 'false_tomb', 'bone_wall', 'sealed_room'],
    },
    {
        id: 'tavern', match: /tavern|inn\b|pub\b|alehouse|taproom|roadhouse|hostel|lodging/, theme: 'tavern', building: true, style: ['hub', 'spine'],
        sizes: { small: [5, 7], medium: [9, 13], big: [16, 22] },
        rooms: [
            ['tavern', 0, [1, 1], 1, { hub: true, exit: true }],
            ['kitchen', 0, [1, 1], 1, {}],
            ['pantry', 0, [1, 1], 0.6, { parent: ['kitchen'] }],
            ['storage', 0, [1, 1], 0.6, { name: ['Keg Room', 'Back Room', 'Storeroom'] }],
            ['parlor', 0, [1, 1], 0.4, { name: ['Private Room', 'Card Room', 'Snug'] }],
            ['cellar', -1, [1, 1], 0.8, { name: ['Beer Cellar', 'Cellar'] }],
            ['hallway', 1, [1, 1], 1, { name: ['Upstairs Landing', 'Guest Hall'] }],
            ['bedroom', 1, [3, 6], 1, { name: ['Room {n}', 'Room {n}', 'The {color} Room', 'Best Room', 'Attic Room'] }],
            ['master_bedroom', 1, [1, 1], 0.7, { name: ['Innkeeper\'s Room', 'Owner\'s Room'] }],
            ['bathroom', 1, [1, 1], 0.5, { name: ['Bath House', 'Washroom'] }],
            ['stable', 0, [1, 1], 0.4, {}],
        ],
        filler: ['bedroom', 'storage'],
        guards: { n: { small: [0, 0], medium: [0, 1], big: [0, 2] }, words: ['Bouncer', 'Thug'], named: 0.7, titles: ['Big', 'One-Eyed'] },
        people: [['keeper', 'tavern', 1, ['the innkeeper, wiping a mug', 'a barmaid weaving between tables']], ['patron', 'tavern', 0.8, ['a drunk singing badly', 'two card players arguing', 'a hooded stranger in the corner', 'a tired caravan guard']], ['servant', 'kitchen', 0.5, ['a harried cook']]],
        traps: 'none', locks: [['master_bedroom', 0.5], ['storage', 0.3]], keyHolders: ['tavern', 'master_bedroom'],
        loot: ['a strongbox of takings', 'a guest\'s forgotten satchel', 'a crumpled letter', 'a marked deck of cards'],
        twists: ['smuggler_trapdoor', 'gambling_den', 'locked_guest', 'secret_meeting'],
    },
    {
        id: 'house', match: /house|home|cottage|hut|shack|farmhouse|cabin|lodge|hovel|homestead|mill|lighthouse|hideout|safehouse/, theme: 'house', building: true, style: ['hub', 'hub', 'spine'],
        sizes: { small: [1, 3], medium: [3, 6], big: [6, 10] },
        rooms: [
            ['parlor', 0, [1, 1], 1, { hub: true, exit: true, name: ['Main Room', 'Front Room', 'Hearth Room', 'Living Room'] }],
            ['bedroom', 0, [1, 2], 0.85, {}],
            ['kitchen', 0, [1, 1], 0.7, {}],
            ['pantry', 0, [1, 1], 0.4, { parent: ['kitchen'] }],
            ['storage', 0, [1, 1], 0.5, { name: ['Mudroom', 'Lean-to', 'Woodshed', 'Back Room'] }],
            ['study', 0, [1, 1], 0.3, { name: ['Workroom', 'Den', 'Little Study'] }],
            ['workshop', 0, [1, 1], 0.3, {}],
            ['cellar', -1, [1, 1], 0.5, { name: ['Root Cellar', 'Cellar'] }],
            ['attic', 1, [1, 1], 0.4, { name: ['Loft', 'Attic'] }],
            ['bedroom', 1, [1, 2], 0.3, {}],
        ],
        filler: ['bedroom', 'storage'],
        guards: { n: { small: [0, 0], medium: [0, 0], big: [0, 1] }, words: ['Watchdog'], named: 0.3, titles: [] },
        people: [['resident', 'parlor', 0.5, ['the owner, wary of strangers', 'an old woman by the fire', 'a farmer cleaning his boots']]],
        traps: 'none', locks: [['cellar', 0.3]], keyHolders: ['bedroom', 'kitchen'],
        loot: ['a purse of coins under a floorboard', 'a family Bible with a pressed flower', 'a hunting bow', 'a jar of preserved plums'],
        twists: ['hidden_cellar', 'sealed_room', 'smuggler_trapdoor', 'secret_meeting'],
    },
    {
        id: 'tower', match: /tower|spire|observatory|wizard|sorcer|mage|lighthouse/, theme: 'castle', building: true, style: ['stack'],
        sizes: { small: [5, 7], medium: [8, 12], big: [14, 20] },
        rooms: [
            ['foyer', 0, [1, 1], 1, { hub: true, exit: true, name: ['Tower Entry', 'Ground Hall', 'Base Hall'] }],
            ['storage', 0, [1, 1], 0.6, { name: ['Store Room', 'Coal Store'] }],
            ['library', 1, [1, 1], 1, { hub: true, name: ['Library', 'Book Floor', 'Scroll Room'] }],
            ['study', 1, [1, 1], 0.6, {}],
            ['laboratory', 2, [1, 1], 1, { hub: true }],
            ['storage', 2, [1, 1], 0.5, { name: ['Reagent Closet', 'Specimen Store'] }],
            ['master_bedroom', 3, [1, 1], 0.9, { hub: true, name: ['Master\'s Quarters', 'Sleeping Chamber'] }],
            ['chapel', 4, [1, 1], 0.6, { hub: true, name: ['Summoning Room', 'Circle Chamber', 'Ritual Room'] }],
            ['attic', 5, [1, 1], 0.5, { hub: true, name: ['Observatory', 'Star Room', 'Lantern Room'] }],
            ['cellar', -1, [1, 1], 0.5, { name: ['Under-vault', 'Cellar'] }],
        ],
        filler: ['storage', 'study'],
        guards: { n: { small: [0, 1], medium: [1, 2], big: [2, 3] }, words: ['Construct', 'Homunculus', 'Animated Armor', 'Apprentice'], named: 0.4, titles: [] },
        people: [['apprentice', 'library', 0.4, ['a nervous apprentice', 'a familiar owl that watches everything']]],
        traps: 'few', locks: [['laboratory', 0.5], ['chapel', 0.6]], keyHolders: ['master_bedroom', 'study'],
        loot: ['a spellbook bound in grey leather', 'a crystal focus', 'a jar of something that moves', 'star charts', 'a wand of uncertain use', 'a half-finished letter'],
        twists: ['runaway_experiment', 'sealed_room', 'collapsed_tower', 'hidden_vault'],
    },
    {
        id: 'library', match: /library|academy|archive|school|college|university|scriptorium/, theme: 'library', building: true, style: ['spine', 'hub'],
        sizes: { small: [6, 9], medium: [12, 18], big: [24, 34] },
        rooms: [
            ['foyer', 0, [1, 1], 1, { hub: true, exit: true }],
            ['library', 0, [2, 4], 1, { name: ['Great Library', 'Reading Room', 'Map Room', 'History Stacks', 'Natural Philosophy', 'Restricted Section'] }],
            ['study', 0, [1, 3], 1, { name: ['Study Carrel', 'Scholar\'s Room', 'Copying Room'] }],
            ['office', 0, [1, 1], 0.8, { name: ['Head Librarian\'s Office', 'Dean\'s Office'] }],
            ['storage', 0, [1, 1], 0.6, { name: ['Bindery', 'Paper Store'] }],
            ['dining_room', 0, [1, 1], 0.4, { name: ['Lecture Hall', 'Refectory'] }],
            ['servants_quarters', 1, [1, 2], 0.6, { name: ['Dormitory', 'Students\' Rooms'] }],
            ['library', 1, [1, 2], 0.6, { name: ['Upper Stacks', 'Gallery Stacks'] }],
            ['vault', -1, [1, 1], 0.5, { name: ['Forbidden Archive', 'Locked Stacks'] }],
            ['cellar', -1, [1, 1], 0.4, { name: ['Book Cellar'] }],
        ],
        filler: ['library', 'study'],
        guards: { n: { small: [0, 0], medium: [0, 1], big: [1, 2] }, words: ['Archive Warden', 'Porter'], named: 0.6, titles: ['Master', 'Old'] },
        people: [['scholar', 'library', 0.7, ['a scholar buried in books', 'a librarian who shushes everyone']]],
        traps: 'few', locks: [['vault', 1], ['office', 0.5]], keyHolders: ['office', 'study'],
        loot: ['a rare atlas', 'an illuminated manuscript', 'a cipher wheel', 'a banned treatise', 'the borrowing ledger'],
        twists: ['restricted', 'hidden_vault', 'sealed_room', 'priest_hole'],
    },
    {
        id: 'bank', match: /bank|guild|counting ?house|exchange|treasury|mint|vault\b|trading house|merchant house/, theme: 'castle', building: true, style: ['spine', 'hub'],
        sizes: { small: [4, 6], medium: [8, 12], big: [16, 24] },
        rooms: [
            ['foyer', 0, [1, 1], 1, { hub: true, exit: true, name: ['Banking Hall', 'Guild Hall', 'Counting Floor'] }],
            ['office', 0, [1, 3], 1, {}],
            ['vault', -1, [1, 2], 1, {}],
            ['guard_room', 0, [1, 1], 0.8, {}],
            ['library', 0, [1, 1], 0.5, { name: ['Records Room', 'Ledger Room'] }],
            ['parlor', 0, [1, 1], 0.5, { name: ['Waiting Room', 'Members\' Lounge'] }],
            ['storage', -1, [1, 1], 0.5, { name: ['Deposit Store'] }],
            ['hallway', -1, [1, 1], 0.7, { name: ['Vault Corridor'] }],
            ['study', 1, [1, 1], 0.6, { name: ['Guildmaster\'s Study', 'Director\'s Room'] }],
        ],
        filler: ['office', 'storage'],
        guards: { n: { small: [1, 2], medium: [2, 3], big: [3, 5] }, words: ['Guard', 'Vault Guard', 'Watchman'], named: 0.5, titles: ['Sergeant', 'Captain'] },
        people: [['clerk', 'office', 0.8, ['a clerk with ink-stained fingers', 'a nervous teller']]],
        traps: 'few', locks: [['vault', 1], ['study', 0.6]], keyHolders: ['study', 'office', 'guard_room'],
        loot: ['sacks of minted coin', 'a deed box', 'promissory notes', 'a sealed deposit box', 'the master ledger'],
        twists: ['hidden_vault', 'bribe', 'records'],
    },
    {
        id: 'barracks', match: /barracks|garrison|outpost|watch ?house|guard ?house|guard ?post|town ?watch|command post|town ?hall/, theme: 'castle', building: true, style: ['spine'],
        sizes: { small: [6, 9], medium: [12, 18], big: [24, 34] },
        rooms: [
            ['guard_room', 0, [1, 1], 1, { hub: true, exit: true, name: ['Muster Hall', 'Front Post'] }],
            ['servants_quarters', 0, [1, 3], 1, { name: ['Bunk Room', 'Barracks Hall', 'Officers\' Quarters'] }],
            ['armory', 0, [1, 1], 1, {}],
            ['dining_room', 0, [1, 1], 0.7, { name: ['Mess Hall'] }],
            ['kitchen', 0, [1, 1], 0.6, {}],
            ['office', 0, [1, 1], 0.9, { name: ['Commander\'s Office', 'Captain\'s Office'] }],
            ['cell', 0, [1, 3], 0.6, {}],
            ['storage', 0, [1, 2], 0.6, { name: ['Quartermaster\'s Store', 'Supply Room'] }],
            ['smithy', 0, [1, 1], 0.3, {}],
            ['stable', 0, [1, 1], 0.3, {}],
        ],
        filler: ['servants_quarters', 'storage'],
        guards: { n: { small: [2, 3], medium: [3, 4], big: [4, 6] }, words: ['Soldier', 'Guard', 'Recruit', 'Sentry'], named: 0.5, titles: ['Sergeant', 'Corporal', 'Captain'] },
        people: [],
        traps: 'none', locks: [['armory', 0.8], ['office', 0.5]], keyHolders: ['office', 'guard_room'],
        loot: ['duty rosters', 'a sealed order', 'pay chest', 'a crate of crossbow bolts'],
        twists: ['bribe', 'records', 'riot'],
    },
    {
        id: 'smithy', match: /smith|forge|armou?rer|farrier/, theme: 'house', building: true, style: ['hub'],
        sizes: { small: [2, 3], medium: [3, 5], big: [5, 8] },
        rooms: [
            ['smithy', 0, [1, 1], 1, { hub: true, exit: true, name: ['Forge', 'Smithy', 'The Hot Room'] }],
            ['shop', 0, [1, 1], 0.7, { name: ['Front Counter', 'Display Room'] }],
            ['storage', 0, [1, 2], 1, { name: ['Coal Store', 'Iron Store', 'Tool Room'] }],
            ['workshop', 0, [1, 1], 0.4, { name: ['Finishing Room', 'Grinding Room'] }],
            ['bedroom', 1, [1, 2], 0.6, { name: ['Living Quarters', 'Apprentice\'s Room', '{given}\'s Room'] }],
            ['kitchen', 0, [1, 1], 0.3, {}],
        ],
        filler: ['storage'],
        guards: { n: { small: [0, 0], medium: [0, 0], big: [0, 1] }, words: ['Apprentice'], named: 0.5, titles: ['Young'] },
        people: [['keeper', 'smithy', 1, ['the smith, arms like hams', 'an apprentice working the bellows']]],
        traps: 'none', locks: [['storage', 0.2]], keyHolders: ['bedroom', 'smithy'],
        loot: ['a masterwork blade waiting to be collected', 'an order book', 'a strongbox of payments'],
        twists: ['secret_meeting', 'hidden_cellar', 'smuggler_trapdoor'],
    },
    {
        id: 'shop', match: /shop|store|smithy|forge|bakery|apothecary|alchemist|tailor|butcher|jeweler|jeweller|market|warehouse|emporium|trader|workshop/, theme: 'house', building: true, style: ['hub'],
        sizes: { small: [2, 3], medium: [3, 5], big: [6, 9] },
        rooms: [
            ['shop', 0, [1, 1], 1, { hub: true, exit: true }],
            ['storage', 0, [1, 2], 1, { name: ['Stockroom', 'Back Store', 'Storeroom'] }],
            ['workshop', 0, [1, 1], 0.6, { name: ['Workroom', 'Back Workshop'] }],
            ['office', 0, [1, 1], 0.4, { name: ['Counting Room', 'Office'] }],
            ['bedroom', 1, [1, 2], 0.7, { name: ['Living Quarters', 'Upstairs Room', '{given}\'s Room'] }],
            ['kitchen', 1, [1, 1], 0.4, {}],
            ['cellar', -1, [1, 1], 0.4, {}],
        ],
        filler: ['storage'],
        guards: { n: { small: [0, 0], medium: [0, 0], big: [0, 1] }, words: ['Guard Dog'], named: 0.2, titles: [] },
        people: [['keeper', 'shop', 1, ['the shopkeeper behind the counter']]],
        traps: 'none', locks: [['office', 0.4], ['cellar', 0.3]], keyHolders: ['shop', 'bedroom'],
        loot: ['the cash box', 'a ledger of debts', 'a special order nobody collected'],
        twists: ['smuggler_trapdoor', 'secret_meeting', 'hidden_cellar'],
    },
    {
        id: 'dungeon', match: /dungeon|ruin|lair|stronghold of|vault of|labyrinth|maze|warren|den\b|hideout|fortress ruins/, theme: 'dungeon', building: false, maze: true, style: ['maze'],
        sizes: { small: [8, 12], medium: [16, 24], big: [36, 50] },
        rooms: [
            ['hallway', 0, [1, 1], 1, { entry: true, name: ['Entry Passage', 'Collapsed Stair', 'Broken Gate', 'Sloping Tunnel'] }],
            ['room', 0, [2, 4], 1, { name: ['Guard Chamber', 'Pillared Hall', 'Rubble Room', 'Old Barracks', 'Collapsed Hall', 'Mural Room'] }],
            ['hallway', 0, [1, 3], 1, {}],
            ['storage', 0, [1, 2], 0.7, {}],
            ['torture_chamber', 0, [1, 1], 0.4, {}],
            ['cell', 0, [1, 3], 0.4, {}],
            ['chapel', 0, [1, 1], 0.5, { name: ['Dark Shrine', 'Idol Chamber', 'Altar of Teeth', 'Forgotten Chapel'] }],
            ['vault', 0, [1, 1], 0.5, { name: ['Treasure Room', 'Hoard Chamber'] }],
            ['crypt', -1, [1, 3], 0.5, {}],
            ['cave', -1, [1, 3], 0.5, {}],
            ['room', -1, [1, 3], 0.5, { name: ['Flooded Hall', 'Deep Chamber', 'Throne of Bones', 'Pit Room'] }],
            ['throne_room', -1, [1, 1], 0.3, { name: ['Warlord\'s Hall', 'Hall of the Old King'] }],
            ['laboratory', -1, [1, 1], 0.2, {}],
        ],
        filler: ['room', 'hallway', 'storage', 'cave'],
        guards: { n: { small: [2, 3], medium: [3, 6], big: [6, 10] }, words: ['Goblin', 'Skeleton', 'Bandit', 'Cultist', 'Giant Rat', 'Kobold', 'Zombie'], named: 0.25, titles: ['Chief', 'Boss'] },
        people: [['prisoner', 'cell', 0.4, ['a prisoner begging to be freed']]],
        traps: 'many', locks: [['vault', 0.6], ['cell', 0]], keyHolders: ['throne_room', 'guard_room', 'room'],
        loot: ['a tarnished crown', 'a pouch of old coins', 'a rusted but fine sword', 'a gem-studded idol', 'a scroll case', 'a map to somewhere deeper'],
        twists: ['flooded', 'collapsed', 'lair', 'gauntlet', 'idol', 'dead_adventurer'],
    },
    {
        id: 'crypt', match: /crypt|tomb|catacomb|mausoleum|barrow|ossuary|necropolis|sepulch|grave/, theme: 'crypt', building: false, maze: true, style: ['maze', 'spine'],
        sizes: { small: [6, 9], medium: [12, 18], big: [26, 38] },
        rooms: [
            ['hallway', 0, [1, 1], 1, { entry: true, name: ['Tomb Entrance', 'Sealed Door Hall', 'Stair Down'] }],
            ['crypt', 0, [2, 5], 1, {}],
            ['hallway', 0, [1, 3], 1, { name: ['Bone Passage', 'Niche Corridor', 'Funeral Walk'] }],
            ['chapel', 0, [1, 1], 0.6, { name: ['Mortuary Chapel', 'Shrine of the Dead'] }],
            ['laboratory', 0, [1, 1], 0.3, { name: ['Embalming Room'] }],
            ['vault', 0, [1, 1], 0.6, { name: ['Grave Goods Vault', 'The Founder\'s Tomb', 'Sealed Sepulchre'] }],
            ['crypt', -1, [1, 3], 0.5, { name: ['Deep Tomb', 'Old Ossuary', 'Forgotten Graves'] }],
        ],
        filler: ['crypt', 'hallway'],
        guards: { n: { small: [1, 3], medium: [3, 5], big: [5, 8] }, words: ['Skeleton', 'Ghoul', 'Zombie', 'Shade', 'Tomb Guardian'], named: 0.2, titles: [] },
        people: [],
        traps: 'many', locks: [['vault', 0.8]], keyHolders: ['chapel', 'crypt'],
        loot: ['a burial mask of gold', 'a funerary urn', 'an engraved dagger', 'a ring on a skeletal finger', 'a rubbing of an old inscription'],
        twists: ['false_tomb', 'bone_wall', 'dead_adventurer', 'restless', 'collapsed'],
    },
    {
        id: 'cave', match: /cave|cavern|grotto|mine|tunnel|underdark|burrow|sinkhole|chasm|sewer/, theme: 'cave', building: false, maze: true, style: ['maze'],
        sizes: { small: [6, 9], medium: [12, 18], big: [24, 36] },
        rooms: [
            ['cave', 0, [1, 1], 1, { entry: true, name: ['Cave Mouth', 'Entrance Hollow', 'Sloping Entry'] }],
            ['cave', 0, [2, 5], 1, {}],
            ['hallway', 0, [1, 3], 1, { name: ['Narrow Squeeze', 'Winding Tunnel', 'Low Crawl', 'Root Tunnel'] }],
            ['cave', -1, [1, 4], 0.6, { name: ['Underground Lake Shore', 'Deep Grotto', 'Crystal Vault', 'Hot Spring Cave'] }],
            ['storage', 0, [1, 1], 0.4, { name: ['Smugglers\' Stash', 'Supply Nook'] }],
            ['room', 0, [1, 1], 0.4, { name: ['Old Camp', 'Lair', 'Nest'] }],
        ],
        filler: ['cave', 'hallway'],
        guards: { n: { small: [1, 2], medium: [2, 4], big: [4, 7] }, words: ['Giant Spider', 'Cave Bear', 'Goblin', 'Bandit', 'Giant Bat', 'Troglodyte'], named: 0.2, titles: [] },
        people: [],
        traps: 'few', locks: [], keyHolders: ['room', 'cave'],
        loot: ['a vein of raw silver', 'a lost miner\'s pick', 'a smuggler\'s strongbox', 'glowing fungus', 'old bones with a purse'],
        twists: ['flooded', 'lair', 'collapsed', 'dead_adventurer', 'crystals'],
    },
    {
        id: 'ship', match: /ship|galleon|boat|vessel|barge|frigate|schooner|sloop/, theme: 'ship', building: false, style: ['spine'],
        sizes: { small: [4, 6], medium: [7, 10], big: [12, 18] },
        rooms: [
            ['hallway', 0, [1, 1], 1, { hub: true, exit: true, entry: true, name: ['Main Deck Passage', 'Gangway'] }],
            ['master_bedroom', 0, [1, 1], 1, { name: ['Captain\'s Cabin'] }],
            ['kitchen', 0, [1, 1], 0.7, { name: ['Galley'] }],
            ['servants_quarters', -1, [1, 2], 1, { name: ['Crew Quarters', 'Forecastle Bunks'] }],
            ['storage', -1, [1, 2], 1, { name: ['Cargo Hold', 'Rope Locker', 'Sail Locker'] }],
            ['cell', -1, [1, 2], 0.6, { name: ['Brig {n}', 'The Brig'] }],
            ['armory', -1, [1, 1], 0.5, { name: ['Powder Room', 'Gun Deck Store'] }],
            ['office', 0, [1, 1], 0.5, { name: ['Navigator\'s Room', 'Chart Room'] }],
            ['hallway', -1, [1, 1], 1, { hub: true, name: ['Lower Deck'] }],
        ],
        filler: ['storage'],
        guards: { n: { small: [1, 2], medium: [2, 4], big: [3, 6] }, words: ['Sailor', 'Deckhand', 'Pirate', 'Marine'], named: 0.5, titles: ['Bosun', 'First Mate', 'Old'] },
        people: [],
        traps: 'none', locks: [['armory', 0.7], ['master_bedroom', 0.4]], keyHolders: ['master_bedroom', 'office'],
        loot: ['the ship\'s log', 'a sea chest', 'a brass spyglass', 'smuggled spices', 'a letter of marque'],
        twists: ['smuggler_trapdoor', 'bribe', 'records'],
    },
];
const GENERIC = {
    id: 'generic', match: /.*/, theme: 'house', building: true, style: ['spine', 'hub'],
    sizes: { small: [3, 5], medium: [7, 11], big: [14, 24] },
    rooms: [
        ['foyer', 0, [1, 1], 1, { hub: true, exit: true }],
        ['room', 0, [1, 3], 1, {}],
        ['storage', 0, [1, 2], 0.7, {}],
        ['office', 0, [1, 1], 0.5, {}],
        ['bedroom', 1, [1, 3], 0.5, {}],
        ['cellar', -1, [1, 1], 0.4, {}],
    ],
    filler: ['room', 'storage'],
    guards: { n: { small: [0, 1], medium: [1, 2], big: [2, 4] }, words: ['Guard'], named: 0.5, titles: ['Old'] },
    people: [],
    traps: 'few', locks: [['office', 0.4]], keyHolders: ['office', 'bedroom'],
    loot: ['a locked box', 'a bundle of papers', 'a purse'],
    twists: ['sealed_room', 'hidden_cellar', 'secret_meeting'],
};

/** The blueprint for a kind of place. */
export function blueprintFor(kind, name = '') {
    // The kind decides first (a guard post called "Watch House" is a guard post); the name only if the kind says nothing.
    const k = String(kind || '').toLowerCase(), n = String(name || '').toLowerCase();
    return BLUEPRINTS.find(b => b.match.test(k)) ?? BLUEPRINTS.find(b => b.match.test(n)) ?? GENERIC;
}

// ---------- traps ----------

const TRAPS = {
    kept: [['pressure plate (darts)', 'DEX', '2d4 piercing'], ['poison needle in the lock', 'CON', '1d4 piercing and poisoned for an hour'], ['alarm glyph', 'WIS', 'a loud chime: everyone nearby hears it'], ['tripwire bell', 'DEX', 'bells ring through the halls'], ['falling net', 'DEX', 'restrained under a weighted net'], ['scything blade', 'DEX', '2d6 slashing'], ['gas vent (sleep)', 'CON', 'falls asleep for a minute']],
    ruined: [['covered pit', 'DEX', '2d6 bludgeoning, fall 10 feet'], ['spike pit', 'DEX', '3d6 piercing'], ['loose ceiling stones', 'DEX', '2d8 bludgeoning'], ['pressure plate (darts)', 'DEX', '2d4 piercing'], ['swinging blade', 'DEX', '2d8 slashing'], ['poison gas vent', 'CON', '2d6 poison'], ['collapsing floor', 'DEX', 'fall to the level below, 2d6'], ['rotten floorboards', 'DEX', '1d6 bludgeoning, a leg stuck']],
    magic: [['glyph of warding (fire)', 'DEX', '5d8 fire, half on a save'], ['glyph of warding (thunder)', 'CON', '4d8 thunder, deafened'], ['necrotic sigil', 'CON', '3d6 necrotic'], ['haunting ward', 'WIS', 'frightened for a minute'], ['binding rune', 'STR', 'restrained by spectral chains']],
};
const WOODEN = new Set(['bedroom', 'master_bedroom', 'library', 'study', 'parlor', 'dining_room', 'hallway', 'music_room', 'office', 'attic', 'tavern', 'shop', 'workshop', 'servants_quarters', 'nursery', 'trophy_room', 'stable']);

// ---------- the brief ----------

/**
 * A brief from a model, made safe: what the place is (name, kind, size, condition, mood), where
 * the party starts, and the story's needs (rooms with something in them, people, locks, secrets).
 * Anything missing is filled from the DM's request.
 */
export function normalizeBrief(raw, req = {}) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const str = v => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
    const arr = v => (Array.isArray(v) ? v : v ? [v] : []);
    const sizeIn = str(d.size || req.size).toLowerCase();
    const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
        normalized: true,
        name: str(d.name || req.name).slice(0, 80) || 'Unnamed place',
        kind: str(d.kind || req.kind).toLowerCase().slice(0, 40) || 'place',
        size: ['small', 'medium', 'big'].includes(sizeIn) ? sizeIn : sizeIn === 'large' || sizeIn === 'huge' ? 'big' : req.size === 'big' ? 'big' : 'small',
        condition: ['kept', 'worn', 'ruined'].includes(str(d.condition).toLowerCase()) ? str(d.condition).toLowerCase() : '',
        mood: str(d.mood || d.style).slice(0, 120),
        start: str(d.start || req.start).slice(0, 120),
        summary: str(d.summary || req.why).slice(0, 600),
        objective: str(d.objective ?? req.objective).slice(0, 80),
        objectiveNear: str(d.objective_near ?? d.objectiveNear).slice(0, 120),
        rooms: arr(d.rooms ?? d.story).filter(x => x && typeof x === 'object').slice(0, 8).map(x => ({ room: str(x.room ?? x.where ?? x.name).slice(0, 60), name: str(x.name && x.room ? x.name : '').slice(0, 60), has: arr(x.has ?? x.items ?? x.item).map(str).filter(Boolean).slice(0, 3), hidden: x.hidden === true, note: str(x.note ?? x.what).slice(0, 160) })).filter(x => x.room),
        people: arr(d.people).filter(x => x && typeof x === 'object' && str(x.name)).slice(0, 8).map(x => ({ name: str(x.name).slice(0, 50), what: str(x.what ?? x.description ?? x.role).slice(0, 160), where: str(x.where ?? x.room).slice(0, 60), hostile: x.hostile === true || x.hostile === 'true', carries: arr(x.carries).map(str).filter(Boolean).slice(0, 3) })),
        locked: arr(d.locked).filter(x => x && typeof x === 'object' && str(x.room)).slice(0, 4).map(x => ({ room: str(x.room).slice(0, 60), key: str(x.key).slice(0, 50), keyIn: str(x.key_in ?? x.keyIn ?? x.holder).slice(0, 60) })),
        secrets: arr(d.secrets).filter(x => x && typeof x === 'object' && (str(x.to) || str(x.from))).slice(0, 3).map(x => ({ from: str(x.from).slice(0, 60), to: str(x.to).slice(0, 60), how: str(x.how).slice(0, 120) })),
        guards: num(d.guards) === null ? null : Math.max(0, Math.min(6, Math.round(num(d.guards)))),
        creatures: str(d.creatures ?? d.guard_kind).slice(0, 40),
        traps: ['none', 'few', 'many'].includes(str(d.traps).toLowerCase()) ? str(d.traps).toLowerCase() : '',
        walls: ['palisade', 'stone', 'none'].includes(str(d.walls).toLowerCase()) ? str(d.walls).toLowerCase() : '',
        gates: ['open', 'closed', 'locked'].includes(str(d.gates).toLowerCase()) ? str(d.gates).toLowerCase() : '',
        shape: ['round', 'square'].includes(str(d.shape).toLowerCase()) ? str(d.shape).toLowerCase() : '',
        tunnels: ['yes', 'no'].includes(str(d.tunnels).toLowerCase()) ? str(d.tunnels).toLowerCase() : /^(true|1)$/.test(str(d.tunnels).toLowerCase()) ? 'yes' : /^(false|0)$/.test(str(d.tunnels).toLowerCase()) ? 'no' : '',
        horror: ['gruesome', 'plain'].includes(str(d.horror).toLowerCase()) ? str(d.horror).toLowerCase() : /gruesome|horror|grisly|gore/.test(str(d.horror).toLowerCase()) ? 'gruesome' : /plain|none|no\b/.test(str(d.horror).toLowerCase()) ? 'plain' : '',
        floors: num(d.floors) === null ? null : Math.max(1, Math.min(5, Math.round(num(d.floors)))),
        exterior: d.exterior && typeof d.exterior === 'object' ? d.exterior : null,
    };
}

// ---------- the plan ----------

/**
 * A whole plan from a brief, from a seed: the same brief and seed always give the same place, a
 * different seed a different one. Returns a raw plan in the same shape Claude's plans have.
 */
export function planFromBrief(briefIn, seed = 1) {
    const brief = briefIn.normalized ? briefIn : normalizeBrief(briefIn);
    const r = rngOf(seed);
    const bp = blueprintFor(brief.kind, brief.name);
    const fam = familyName(r);
    const usedNames = new Set();
    const counters = {};
    const fillName = (tpl, type) => tpl.replace('{fam}', fam).replace('{given}', pick(r, GIVEN)).replace('{color}', pick(r, COLORS)).replace('{saint}', pick(r, SAINTS)).replace('{adj}', pick(r, ADJ)).replace('{wing}', pick(r, WINGS)).replace('{n}', () => { counters[type] = (counters[type] ?? 0) + 1; return String(counters[type]); });
    const nameFor = (type, pool) => {
        const list = shuffle(r, Array.isArray(pool) ? pool : pool ? [pool] : ROOM_NAMES[type] ?? ROOM_NAMES.room);
        for (let i = 0; i < 12; i++) {
            const n = fillName(list[i % list.length], type);
            if (!usedNames.has(n)) { usedNames.add(n); return n; }
        }
        const n = `${fillName(pick(r, ROOM_NAMES[type] ?? ROOM_NAMES.room), type)} ${int(r, 2, 9)}`;
        usedNames.add(n);
        return n;
    };
    const condition = brief.condition || (bp.maze ? 'ruined' : 'kept');
    const [lo, hi] = bp.sizes[brief.size] ?? bp.sizes.small;
    const target = int(r, lo, hi);
    const maxLevels = brief.floors ?? (brief.size === 'small' ? 2 : brief.size === 'medium' ? 3 : 5);
    // A big place has more of what repeats (cells, bedrooms, guard rooms, tombs, caves), not just filler.
    const scale = brief.size === 'big' ? 2.5 : brief.size === 'medium' ? 1.5 : 1;
    const REPEATS = new Set(['cell', 'bedroom', 'guard_room', 'servants_quarters', 'storage', 'crypt', 'cave', 'room', 'office', 'library', 'study', 'hallway']);
    const countOf = (type, mn, mx) => (REPEATS.has(type) ? int(r, Math.round(mn * scale), Math.round(mx * scale)) : int(r, mn, mx));

    // Rooms: the kind's must-haves, then its maybes (in a shuffled order) until the place is its size.
    const rooms = [];
    let idN = 0;
    const addRoom = (type, level, opts = {}) => {
        const t = roomType(opts.type || type);
        const room = { id: `R${++idN}`, name: nameFor(t, opts.name), type: t, level, size: opts.size || '', lit: opts.lit, description: '', props: [], marks: [], traps: [], items: [], exit: Boolean(opts.exit), hub: Boolean(opts.hub), entry: Boolean(opts.entry), parent: opts.parent || null, hint: [] };
        rooms.push(room);
        return room;
    };
    const levelsOk = level => { const used = new Set([...rooms.map(x => x.level), level]); return used.size <= maxLevels; };
    for (const [type, level, [mn, mx], p, opts] of bp.rooms.filter(s => s[3] >= 1)) for (let i = 0, n = target <= 3 ? Math.min(countOf(type, mn, mx), Math.max(1, target - rooms.length)) : countOf(type, mn, mx); i < n; i++) addRoom(type, level, opts);
    for (const [type, level, [mn, mx], p, opts] of shuffle(r, bp.rooms.filter(s => s[3] < 1))) {
        if (rooms.length >= target) break;
        if (!chance(r, p) || !levelsOk(level)) continue;
        for (let i = 0, n = countOf(type, mn, mx); i < n && rooms.length < target + 1; i++) addRoom(type, level, opts);
    }
    // The rest spread over the floors, emptiest first; when every floor is full (about 18 rooms) a big
    // place grows another one (upstairs for a building, deeper for a dungeon) rather than one huge floor.
    const PER_FLOOR = 18;
    while (rooms.length < target) {
        const used = [...new Set(rooms.map(x => x.level))];
        const lv = used.sort((a, b) => rooms.filter(x => x.level === a).length - rooms.filter(x => x.level === b).length);
        const full = rooms.filter(x => x.level === lv[0]).length >= PER_FLOOR;
        const next = bp.maze ? Math.min(...used) - 1 : !used.includes(1) ? 1 : !used.includes(-1) ? -1 : Math.max(...used) + 1;
        addRoom(pick(r, bp.filler), full && used.length < maxLevels ? next : chance(r, 0.7) ? lv[0] : pick(r, lv), {});
    }
    const notes = [];

    // The story's rooms: an existing room of that kind takes the story's name and things; otherwise one is added.
    const findRoom = words => {
        const w = nameKey(words);
        if (!w) return null;
        const t = roomType(words);
        return rooms.find(x => nameKey(x.name) === w) ?? rooms.find(x => w.includes(nameKey(x.name)) || nameKey(x.name).includes(w))
            ?? (t !== 'room' ? rooms.find(x => x.type === t && !x.story) : null);
    };
    const levelFor = type => (['cellar', 'wine_cellar', 'crypt'].includes(type) ? Math.min(-1, ...rooms.map(x => x.level)) : ['bedroom', 'master_bedroom', 'nursery', 'attic'].includes(type) && rooms.some(x => x.level > 0) ? 1 : 0);
    for (const s of brief.rooms) {
        let room = findRoom(s.room);
        if (!room) { const t = roomType(s.room); room = addRoom(t, levelFor(t), { name: cap(s.name || s.room) }); }
        else if (s.name || (roomType(s.room) === room.type && s.room.length > 3 && !/^(the )?(room|a room)$/i.test(s.room))) room.name = cap(s.name || s.room);
        room.story = true;
        for (const it of s.has) room.items.push({ name: it, hidden: s.hidden, note: s.note });
        if (s.note) room.hint.push(s.note);
    }

    // Twists: what makes this one different from every other place of its kind.
    const twistCount = brief.size === 'big' ? int(r, 2, 3) : brief.size === 'medium' ? int(r, 1, 2) : chance(r, 0.6) ? 1 : 0;
    const ctx = { r, rooms, addRoom, nameFor, condition, notes, fam, bp };
    for (const id of shuffle(r, bp.twists).slice(0, twistCount)) { const line = TWISTS[id]?.(ctx); if (line) notes.push(line); }

    // Floors: the levels used, named for what they are.
    const levels = [...new Set(rooms.map(x => x.level))].sort((a, b) => a - b);
    const floorName = l => (l < -1 ? 'Deep Level' : l === -1 ? (bp.maze ? 'Lower Level' : bp.id === 'ship' ? 'Below Decks' : 'Cellars') : l === 0 ? (bp.maze ? 'Upper Level' : bp.id === 'ship' ? 'Main Deck' : 'Ground Floor') : bp.id === 'tower' ? `Tower, floor ${l + 1}` : l === 1 ? 'Upper Floor' : l === 2 ? (rooms.some(x => x.level === 2 && x.type === 'attic') ? 'Attic' : 'Second Floor') : `Floor ${l + 1}`);
    const floors = levels.map(l => ({ id: l < 0 ? `B${-l}` : l === 0 ? 'G' : `U${l}`, name: floorName(l), level: l }));
    const floorOf = l => floors.find(f => f.level === l).id;
    for (const room of rooms) room.floor = floorOf(room.level);

    // How the rooms join up.
    const links = [];
    const link = (a, b, via = 'door', extra = {}) => { if (a && b && a !== b && !links.some(l => (l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id))) links.push({ a: a.id, b: b.id, via: a.level !== b.level ? 'stairs' : via, key: '', dc: 15, ...extra }); };
    const degree = room => links.filter(l => l.a === room.id || l.b === room.id).length;
    const style = pick(r, bp.style);
    const hubsOn = l => rooms.filter(x => x.level === l && !x.hidden && (x.hub || x.type === 'hallway'));
    for (const l of levels) {
        const here = rooms.filter(x => x.level === l && !x.hidden);
        if (style === 'maze' || (bp.maze && condition === 'ruined')) {
            // A dungeon is a route, not a tangle: a main way through room after room from the way in to
            // the far end (where what they came for usually lies), side branches off it (dead ends,
            // loot, the key to a gate further on), and only now and then a shortcut.
            // Cells are never on the way through (a cell has one door): they hang off the route.
            const open = here.filter(x => x.type !== 'cell');
            const order = [...open.filter(x => x.entry), ...shuffle(r, open.filter(x => !x.entry))];
            const spine = order.slice(0, Math.max(2, Math.ceil(order.length * 0.6))), side = [...order.slice(spine.length), ...here.filter(x => x.type === 'cell')];
            spine.forEach((room, i) => { room.spine = i; if (i) link(spine[i - 1], room, chance(r, 0.25) ? 'arch' : 'door'); });
            for (const room of side) {
                const twigs = side.filter(x => x !== room && degree(x) > 0 && degree(x) < 3);
                const from = twigs.length && chance(r, 0.3) ? pick(r, twigs) : spine[int(r, 0, Math.max(0, spine.length - 2))];
                link(from, room, chance(r, 0.2) ? 'arch' : 'door');
            }
            for (let i = 0, n = Math.floor(order.length / 8); i < n && spine.length > 3; i++) { const a = int(r, 0, spine.length - 3); link(spine[a], spine[a + 2], chance(r, 0.5) ? 'secret' : 'door'); }
            continue;
        }
        // A building: a hub (the hall) and corridors; rooms open off their parent room, or off a corridor.
        let hubs = hubsOn(l);
        // A floor with a single ordinary room (a cottage's attic) is just that room: no landing added.
        if (!hubs.length && here.length === 1 && !['cell', 'vault', 'bathroom', 'armory'].includes(here[0].type)) hubs = [here[0]];
        if (!hubs.length) hubs = [addRoom('hallway', l, { name: l > 0 ? ['Upper Landing', 'Upstairs Hall', '{wing} Gallery'] : l < 0 ? ['Cellar Passage', 'Lower Hall', 'Stone Passage'] : null })];
        hubs.forEach(h => { h.floor = floorOf(l); });
        // Wings: a big floor gets two or three corridors off its main hall.
        const others = () => rooms.filter(x => x.level === l && !hubs.includes(x) && !x.hidden);
        if ((style === 'wings' && others().length > 5) || others().length > 9) {
            const want = others().length > 12 ? 3 : 2;
            while (hubs.filter(h => h.type === 'hallway').length < want) { const h = addRoom('hallway', l, {}); h.floor = floorOf(l); hubs.push(h); }
        }
        const main = hubs.find(h => h.hub) ?? hubs[0];
        for (const h of hubs) if (h !== main) link(main, h, chance(r, 0.35) ? 'arch' : 'door');
        for (const room of others()) {
            const parents = (room.parent ?? []).map(t => rooms.find(x => x.level === l && x.type === t && x !== room && degree(x) < 5)).filter(Boolean);
            const corridors = hubs.filter(h => degree(h) < (h.type === 'hallway' ? 9 : 7));
            const to = parents[0] ?? (style === 'hub' && degree(main) < 7 ? main : corridors.sort((a, b) => degree(a) - degree(b))[0] ?? main);
            link(to, room, chance(r, room.type === 'parlor' || room.type === 'dining_room' || room.type === 'ballroom' ? 0.3 : 0.08) ? 'arch' : 'door');
        }
        // A loop or two between public rooms (two ways round, never through a private room).
        const PUBLIC = new Set(['parlor', 'dining_room', 'ballroom', 'music_room', 'gallery', 'library', 'conservatory', 'trophy_room', 'tavern', 'chapel', 'throne_room', 'guard_room', 'kitchen']);
        const pub = here.filter(x => PUBLIC.has(x.type));
        for (let i = 0, n = Math.floor(pub.length / 3); i < n; i++) { const a = pick(r, pub), b = pick(r, pub); if (a !== b && degree(a) < 4 && degree(b) < 4) link(a, b, chance(r, 0.4) ? 'arch' : 'door'); }
    }
    // Stairs between neighbouring levels: from each level's main hall; a big place gets a second, back stair.
    const mainOf = l => rooms.find(x => x.level === l && x.hub && !x.hidden) ?? rooms.find(x => x.level === l && x.type === 'hallway' && !x.hidden) ?? rooms.find(x => x.level === l && x.entry) ?? rooms.find(x => x.level === l && !x.hidden) ?? rooms.find(x => x.level === l);
    for (let i = 1; i < levels.length; i++) {
        const lowerL = levels[i - 1], upperL = levels[i];
        // A dungeon goes down from the far end of one level's route to the start of the next one's.
        const nearL = Math.abs(lowerL) < Math.abs(upperL) ? lowerL : upperL, farL = nearL === lowerL ? upperL : lowerL;
        const routeOf = l => rooms.filter(x => x.level === l && x.spine !== undefined).sort((a, b) => a.spine - b.spine);
        if (bp.maze && routeOf(nearL).length && routeOf(farL).length) link(routeOf(nearL).at(-1), routeOf(farL)[0], 'stairs');
        else {
            const deep = bp.maze ? rooms.filter(x => x.level === (lowerL < 0 ? upperL : lowerL)).sort((a, b) => degree(a) - degree(b))[0] : null;
            link(deep ?? mainOf(upperL), mainOf(lowerL), 'stairs');
        }
        if (!bp.maze && brief.size === 'big' && chance(r, 0.6)) {
            const back = rooms.find(x => x.level === upperL && ['kitchen', 'pantry', 'servants_quarters', 'storage', 'hallway'].includes(x.type) && x !== mainOf(upperL));
            const backTo = rooms.find(x => x.level === lowerL && x.type === 'hallway' && x !== mainOf(lowerL)) ?? rooms.find(x => x.level === lowerL && ['hallway', 'storage', 'cellar'].includes(x.type) && x !== mainOf(lowerL));
            if (back && backTo) { link(back, backTo, 'stairs'); notes.push(`A back stair runs from ${back.name} to ${backTo.name}.`); }
        }
    }

    // The twists' hidden ways: secret doors to hidden rooms, back stairs; a sealed room stays shut (no key: pick it or force it).
    for (const room of rooms) {
        if (room.secretTo) link(room, room.secretTo, 'secret', { dc: int(r, 13, 16) });
        if (room.secretFrom) link(room.secretFrom, room, 'secret', { dc: int(r, 13, 16) });
        if (room.backStairTo) link(room, room.backStairTo, 'stairs');
        if (room.sealed) { const l = links.find(x => (x.a === room.id || x.b === room.id) && x.via !== 'stairs' && x.via !== 'secret'); if (l) { l.via = 'locked'; l.key = ''; } }
    }
    // Where the party starts (decided before the challenge is laid out: distances count from here).
    const startWords = brief.start.toLowerCase();
    let start = rooms.find(x => x.exit) ?? rooms.find(x => x.entry) ?? rooms[0];
    let outside = null;
    const lockedUp = /\b(cell|locked up|imprison|captive|captured|jailed|prisoner|locked in|shackled|chained)\b/.test(startWords);
    if (lockedUp) {
        // The free cell furthest from the way in (the deepest one), or a holding room if there's no cell.
        const D0 = distances(rooms, links, mainOf(0) ?? rooms[0]);
        start = rooms.filter(x => x.type === 'cell' && !x.hidden).sort((a, b) => (D0.get(b.id) ?? 0) - (D0.get(a.id) ?? 0))[0];
        if (!start) {
            const lvl = Math.min(...levels);
            start = addRoom('cell', lvl, { name: lvl < 0 ? ['Locked Cellar Room', 'Holding Room', 'The Cage Room'] : ['Locked Room', 'Holding Cell'] });
            start.floor = floorOf(lvl);
            link(rooms.find(x => x.level === lvl && x.type === 'hallway') ?? mainOf(lvl), start, 'cell');
        }
        notes.push(`The party starts locked in ${start.name}.`);
    } else if (bp.building && /\b(outside|arriv|approach|front|gate|door|yard|garden|street|walk up|sneak)/.test(startWords) && !/\binside|already in\b/.test(startWords)) {
        outside = { id: `R${++idN}`, name: pick(r, ['Front Gate', 'Courtyard', 'Front Garden', 'Forecourt', 'Yard']), type: 'courtyard', level: 0, floor: floorOf(0), description: '', props: [], marks: [], traps: [], items: [], exit: false };
        start = outside;
    } else if (startWords && !/\b(entrance|front|start)\b/.test(startWords)) {
        start = findRoom(brief.start) ?? start;
    }

    // The challenge: what they're after lies deep, the way out of a prison lies far from the cells.
    // At least half way from where they start to the furthest room, as far as it can be, unless
    // the story puts it close. (Distances are rooms walked through; stairs count double.)
    const origin = start === outside ? (rooms.find(x => x.exit) ?? rooms[0]) : start;
    const objective = brief.objective;
    const escaping = lockedUp || /\b(escape|get out|break out|way out|flee)\b/i.test(objective);
    const pinnedNear = /\b(near|next to|beside|close to|by) the (entrance|gate|door|front|start|way in)|just inside|first room\b/i.test(`${brief.objectiveNear} ${brief.rooms.map(x => x.note).join(' ')}`);
    let D = distances(rooms, links, origin);
    const reach = () => Math.max(1, ...rooms.filter(x => !x.hidden && D.has(x.id)).map(x => D.get(x.id)));
    let goal = null;
    if (escaping && bp.building) {
        // The way out: a ground-floor room people leave by, as far from the start as there is.
        const ground = levels.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), levels[0]);
        // Never a corridor the cells open onto (a cell block is where the prisoners are, not a way out).
        const cellsOff = x => links.some(l => (l.a === x.id || l.b === x.id) && rooms.find(y => y.id === (l.a === x.id ? l.b : l.a))?.type === 'cell');
        const doorsOut = rooms.filter(x => x.level === ground && !x.hidden && EXIT_TYPES.has(x.type) && x !== origin && D.has(x.id) && !cellsOff(x)).sort((a, b) => D.get(b.id) - D.get(a.id));
        if (doorsOut.length && !pinnedNear) {
            for (const x of rooms) x.exit = false;
            doorsOut[0].exit = true;
            goal = doorsOut[0];
            notes.push(`The way out is through ${goal.name}, far from where the party starts${(D.get(goal.id) ?? 0) < reach() * 0.5 ? ' (as far as this place allows)' : ''}.`);
        }
    } else if (objective && !pinnedNear) {
        // What they came for: an item the story already put somewhere, a room the words name, or (if it's neither) a new find.
        const k = nameKey(objective);
        let holder = rooms.find(x => x.items.some(i => nameKey(i.name) && (nameKey(i.name).includes(k) || k.includes(nameKey(i.name)))));
        const item = holder?.items.find(i => nameKey(i.name).includes(k) || k.includes(nameKey(i.name)));
        const named = holder ? null : rooms.find(x => !x.hidden && (nameKey(x.name) === k || (k.length > 4 && nameKey(x.name).includes(k)) || (roomType(objective) !== 'room' && x.type === roomType(objective) && !x.hub)));
        const far = () => rooms.filter(x => !x.hidden && !x.hub && !x.exit && !x.entry && x.type !== 'cell' && D.has(x.id)).sort((a, b) => D.get(b.id) - D.get(a.id));
        if (named && !named.hub && !named.exit && (D.get(named.id) ?? 0) < reach() * 0.5) {
            // Move the room itself deep: it opens off a far room instead (its old neighbours stay joined).
            const anchor = far().find(x => x !== named && !['bathroom', 'pantry', 'vault', 'storage', 'nursery'].includes(x.type) && (D.get(x.id) ?? 0) >= reach() * 0.6);
            if (anchor) {
                const old = links.filter(l => (l.a === named.id || l.b === named.id) && l.via !== 'secret');
                const nbrs = old.map(l => rooms.find(x => x.id === (l.a === named.id ? l.b : l.a))).filter(Boolean);
                for (const l of old) links.splice(links.indexOf(l), 1);
                for (const n of nbrs.slice(1)) link(nbrs[0], n, 'door');
                Object.assign(named, { level: anchor.level, floor: anchor.floor });
                link(anchor, named, 'door');
                D = distances(rooms, links, origin);
            }
            goal = named;
        } else if (named) goal = named;
        else {
            // An item: into the furthest room it would fit in (or simply the furthest), if it isn't deep already.
            const fits = far().filter(x => ['vault', 'study', 'office', 'crypt', 'throne_room', 'chapel', 'storage', 'room', 'cave', 'laboratory', 'library', 'master_bedroom', 'cellar', 'attic'].includes(x.type));
            const target = (fits[0] && (D.get(fits[0].id) ?? 0) >= reach() * 0.5 ? fits[0] : far()[0]);
            if (item && holder && target && (D.get(holder.id) ?? 0) < reach() * 0.5) { holder.items.splice(holder.items.indexOf(item), 1); target.items.push(item); holder = target; }
            else if (!item && target) { target.items.push({ name: cap(objective).slice(0, 60), hidden: false, note: '' }); holder = target; }
            goal = holder ?? null;
        }
        if (goal) notes.push(`What the party came for (${objective}) is in ${goal.name}${(D.get(goal.id) ?? 0) < reach() * 0.5 ? '' : ', deep inside'}.`);
    } else if (bp.maze && !pinnedNear) {
        // A dungeon with no particular goal: its far end is where the best of it lies.
        goal = rooms.filter(x => !x.hidden && D.has(x.id)).sort((a, b) => D.get(b.id) - D.get(a.id))[0] ?? null;
        if (goal) { goal.items.push({ name: pick(r, bp.loot), hidden: false, note: 'the prize at the end' }); notes.push(`The far end, ${goal.name}, holds the best of it.`); }
    }
    // The way there, room by room, for the challenges on it.
    const route = goal ? pathBetween(rooms, links, origin, goal) : [];
    // A gate on the way: a locked door part-way along, its key somewhere reachable before it (a side
    // branch with luck, else any room this side). Dungeons always; other places now and then.
    if (route.length >= 5 && !pinnedNear && (bp.maze || (condition !== 'kept' && chance(r, 0.5)))) {
        const at = Math.floor(route.length * 0.6);
        const a = route[at - 1], b = route[at];
        const gate = links.find(l => ((l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id)) && l.via !== 'stairs' && l.via !== 'cell');
        if (gate && gate.via !== 'locked') {
            gate.via = 'locked';
            gate.key = `${pick(r, ['iron', 'bone', 'rusted', 'black', 'brass', 'serpent'])} ${pick(r, ['gate', 'door'])} key`;
            const before = distances(rooms, links.filter(l => l !== gate), origin);
            const pockets = rooms.filter(x => x !== origin && before.has(x.id) && !route.includes(x) && !x.hidden && x.type !== 'cell').sort((p, q) => degree(p) - degree(q) || before.get(q.id) - before.get(p.id));
            const keep = pockets[0] ?? route[Math.max(0, at - 2)];
            keep.items.push({ name: gate.key, hidden: chance(r, 0.4), note: pick(r, ['among the bones', 'under a loose flagstone', 'on a hook behind the door', 'in a dead man\'s pouch', 'in a rotting chest', 'on a chain round a statue\'s neck']) });
            notes.push(`The way to ${goal.name} is barred at ${b.name} by a locked door; its ${gate.key} is in ${keep.name}.`);
        }
    }
    // Locks and keys: the kind's lockable rooms, each key kept by whoever would have it.
    const holderFor = (exclude) => {
        for (const t of bp.keyHolders) { const h = shuffle(r, rooms.filter(x => x.type === t && !exclude.includes(x.id))).find(Boolean); if (h) return h; }
        return rooms.find(x => !exclude.includes(x.id) && x.type !== 'cell');
    };
    const lockRoom = (room, key, keyIn) => {
        const l = links.find(x => (x.a === room.id || x.b === room.id) && x.via !== 'stairs' && x.via !== 'secret');
        if (!l) return null;
        l.via = 'locked';
        l.key = key;
        const holder = keyIn ? findRoom(keyIn) : holderFor([l.a, l.b]);
        if (holder && holder.id !== l.a && holder.id !== l.b) holder.items.push({ name: key, hidden: chance(r, 0.5), note: pick(r, ['in a desk drawer', 'on a hook', 'under a loose stone', 'in a coat pocket', 'on a chain by the door', 'in a tin box']) });
        return holder;
    };
    const lockedAlready = room => links.some(x => (x.a === room.id || x.b === room.id) && x.via === 'locked');
    for (const lk of brief.locked) {
        const room = findRoom(lk.room);
        if (!room || lockedAlready(room)) continue;
        const key = lk.key || `${room.name.replace(/^the /i, '')} key`;
        const holder = lockRoom(room, key, lk.keyIn);
        notes.push(`${room.name} is locked${holder ? `; the ${key} is in ${holder.name}` : ''}.`);
    }
    for (const [type, p] of bp.locks) {
        for (const room of rooms.filter(x => x.type === type)) {
            if (lockedAlready(room) || !chance(r, p) || condition === 'ruined' && chance(r, 0.4)) continue;
            const key = pick(r, [`${room.name.replace(/^the /i, '')} key`, `${pick(r, ['brass', 'iron', 'silver', 'black', 'bone', 'copper'])} key`, `${fam} family key`]);
            const holder = lockRoom(room, key);
            if (holder) notes.push(`${room.name} is locked; the ${key} is in ${holder.name}.`);
        }
    }
    // Secrets from the brief: a hidden door to where the story needs one.
    for (const s of brief.secrets) {
        // "A hidden chapel" is a new, hidden room, not the chapel everyone uses.
        let to = /\b(hidden|secret|concealed|forgotten|lost|walled[- ]up)\b/i.test(s.to) ? rooms.find(x => nameKey(x.name) === nameKey(s.to)) : findRoom(s.to);
        const from = findRoom(s.from) ?? rooms.find(x => ['library', 'study', 'cellar', 'bedroom'].includes(x.type)) ?? rooms[0];
        if (!to) { to = addRoom(roomType(s.to) === 'room' ? 'storage' : roomType(s.to), from.level, { name: cap(s.to || 'Hidden Room') }); to.floor = from.floor; }
        to.hidden = true;
        link(from, to, 'secret', { dc: int(r, 13, 17) });
        notes.push(`A secret way from ${from.name} to ${to.name}${s.how ? ` (${s.how})` : ''}.`);
    }

    // People: the kind's guards (named now and then, patrolling their floor) and residents.
    const people = [], guards = [];
    const monsters = /dungeon|crypt|cave/.test(bp.id) || (brief.creatures ? /\b(rat|skeleton|zombie|ghoul|spider|bat|wolf|goblin|bandit|cultist|kobold|troglodyte|ghost|shade|bear|boar|snake|orc|troll|ogre|zealot|thug|pirate)/i.test(brief.creatures) : false);
    const nG = brief.guards ?? int(r, ...(bp.guards.n[brief.size] ?? bp.guards.n.small));
    const word = brief.creatures ? cap(brief.creatures.replace(/s$/i, '')) : null;
    const wordUsed = {};
    const nonPrivate = l => rooms.filter(x => x.level === l && !x.hidden && !['cell', 'bathroom', 'vault', 'pantry'].includes(x.type));
    for (let i = 0; i < nG; i++) {
        const w = word ?? pick(r, bp.guards.words);
        wordUsed[w] = (wordUsed[w] ?? 0) + 1;
        const named = chance(r, bp.guards.named) && bp.guards.titles.length;
        let name = named ? `${pick(r, bp.guards.titles)} ${pick(r, GIVEN)}` : `${w} ${wordUsed[w]}`;
        while (guards.some(g => g.name === name)) name = `${name}${int(r, 2, 9)}`;
        const level = pick(r, levels.filter(l => nonPrivate(l).length));
        const home = pick(r, nonPrivate(level).filter(x => x.type === 'guard_room' || x.type === 'hallway').concat(nonPrivate(level)));
        const near = links.filter(l => l.a === home.id || l.b === home.id).map(l => rooms.find(x => x.id === (l.a === home.id ? l.b : l.a))).filter(x => x && x.level === level && !['cell', 'bathroom', 'pantry', 'vault'].includes(x.type));
        const patrol = chance(r, 0.65) && near.length ? [home.id, ...shuffle(r, near).slice(0, int(r, 1, 3)).map(x => x.id)] : [home.id];
        guards.push({ name, word: named ? '' : w, description: named ? `${w.toLowerCase()}${pick(r, [', scarred and patient', ', bored and careless', ', sharp-eyed', ', half asleep on duty', ', mean when crossed', ', new to the job'])}` : `a ${w.toLowerCase()}`, room: home.id, patrol });
    }
    // Something stands between the party and what they came for: a guardian just before it.
    if (goal && route.length >= 4 && !escaping && (bp.maze || nG > 0)) {
        const post = route[route.length - 2];
        const w = word ?? pick(r, bp.guards.words);
        wordUsed[w] = (wordUsed[w] ?? 0) + 1;
        guards.push({ name: `${w} ${wordUsed[w]}`, word: w, description: `a ${w.toLowerCase()} guarding the way to ${goal.name}`, room: post.id, patrol: [post.id] });
        notes.push(`A ${w.toLowerCase()} stands guard in ${post.name}, just before ${goal.name}.`);
    }
    // A jail is staffed: a turnkey pacing every cell block, someone at the way in. (Prisoners can't
    // be left with nobody watching them.)
    if (/prison|barracks/.test(bp.id)) {
        const addPost = (rm, label) => {
            if (!rm || guards.some(g => g.patrol.includes(rm.id))) return;
            const w = pick(r, bp.guards.words);
            wordUsed[w] = (wordUsed[w] ?? 0) + 1;
            guards.push({ name: `${w} ${wordUsed[w]}`, word: w, description: `a ${w.toLowerCase()}, ${label}`, room: rm.id, patrol: [rm.id] });
        };
        for (const hall of rooms.filter(x => x.type === 'hallway')) {
            const cells = links.filter(l => l.a === hall.id || l.b === hall.id).map(l => rooms.find(x => x.id === (l.a === hall.id ? l.b : l.a))).filter(x => x?.type === 'cell');
            if (cells.length >= 2) addPost(hall, 'watching the cells');
        }
        addPost(rooms.find(x => x.exit) ?? rooms.find(x => x.type === 'guard_room'), 'on the door');
    }
    // A lone one of a kind is just "Ghoul", not "Ghoul 1".
    for (const g of guards) if (g.word && wordUsed[g.word] === 1) g.name = g.word;
    for (const [role, type, p, looks] of bp.people) {
        if (role === 'keeper' && brief.people.length) continue;
        const rm = shuffle(r, rooms.filter(x => x.type === type && x !== start)).find(Boolean);
        if (!rm || !chance(r, p)) continue;
        // Prisoners go in a cell that isn't the party's.
        if (type === 'cell' && rooms.filter(x => x.type === 'cell').length < 2) continue;
        people.push({ name: `${pick(r, GIVEN)}${role === 'prisoner' ? ' the prisoner' : ''}`, description: pick(r, looks), room: rm.id, patrol: [rm.id], role });
    }
    // The story's people, where the brief puts them (or where they'd be).
    for (const p of brief.people) {
        let rm = findRoom(p.where) ?? findRoom(p.what) ?? (p.hostile ? rooms.find(x => x.type === 'guard_room') : rooms.find(x => x.hub)) ?? rooms[0];
        if (rm === start && rm.type === 'cell') rm = rooms.find(x => x.type === 'cell' && x !== start) ?? rm;
        // "in a cell": a cell that isn't the party's (they start in the first free one later).
        const entry = { name: p.name, description: p.what || 'someone the story needs here', room: rm.id, patrol: [rm.id], here: true, role: p.hostile ? 'hostile' : 'resident' };
        for (const it of p.carries) rm.items.push({ name: it, hidden: false, note: `carried by ${p.name}` });
        (p.hostile ? guards : people).push(entry);
    }

    // Traps: where someone would set them, from the kind's kind of traps.
    const trapLevel = brief.traps || bp.traps;
    const nT = trapLevel === 'none' ? 0 : trapLevel === 'many' ? int(r, Math.ceil(rooms.length / 5), Math.ceil(rooms.length / 3)) : int(r, 0, Math.max(1, Math.ceil(rooms.length / 8)));
    const magical = /temple|crypt|tower|library/.test(bp.id);
    const pool = condition === 'ruined' ? TRAPS.ruined : TRAPS.kept;
    // On the way to what they came for first (the route), then where traps make sense anyway.
    const trapTypes = ['vault', 'study', 'office', 'hallway', 'crypt', 'chapel', 'master_bedroom', 'library', 'room', 'cave', 'throne_room', 'laboratory', 'storage'];
    const onRoute = shuffle(r, route.slice(1).filter(x => x !== start && x.type !== 'cell'));
    const trapRooms = [...onRoute, ...shuffle(r, rooms.filter(x => trapTypes.includes(x.type) && x !== origin && !route.includes(x)))];
    for (let i = 0; i < nT && trapRooms.length; i++) {
        const rm = trapRooms[i % trapRooms.length];
        const [kind, save, effect] = pick(r, magical && chance(r, 0.5) ? TRAPS.magic : pool.filter(([k]) => !/floorboard/.test(k) || WOODEN.has(rm.type)));
        rm.traps.push({ kind, dc: int(r, 11, 16), save, effect, hidden: true });
    }

    // Loot: a few things worth finding, mostly where they'd be kept.
    for (const item of shuffle(r, bp.loot).slice(0, brief.size === 'big' ? 4 : brief.size === 'medium' ? 3 : 1)) {
        const rm = pick(r, rooms.filter(x => ['study', 'office', 'vault', 'master_bedroom', 'bedroom', 'library', 'storage', 'crypt', 'cellar', 'room', 'cave'].includes(x.type)).concat(rooms.slice(-2)));
        rm.items.push({ name: item, hidden: chance(r, 0.5), note: '' });
    }

    // Marks: a lived-in or ruined look, room by room.
    if (condition !== 'kept') for (const rm of rooms) if (chance(r, condition === 'ruined' ? 0.5 : 0.2)) rm.marks.push(pick(r, condition === 'ruined' ? ['bones', 'scratches', 'stain', 'blood', 'papers'] : ['stain', 'papers']));

    // The DM's notes: what this place is and where its secrets are.
    const exitRoom = rooms.find(x => x.exit);
    const summary = [
        brief.summary,
        `${brief.name}: ${condition === 'ruined' ? 'a ruined' : condition === 'worn' ? 'a run-down' : 'a kept-up'} ${brief.kind} of ${rooms.length} rooms${floors.length > 1 ? ` on ${floors.length} levels` : ''}${brief.mood ? `, ${brief.mood}` : ''}.`,
        ...notes,
        exitRoom ? `The way out is through ${exitRoom.name}.` : '',
    ].filter(Boolean).join(' ');

    const out = {
        name: brief.name,
        kind: brief.kind,
        theme: bp.theme,
        condition,
        summary,
        floors,
        rooms: [...rooms, ...(outside ? [outside] : [])].map(x => ({ id: x.id, name: x.name, type: x.type, floor: x.floor, size: x.size, lit: x.lit, description: x.description, hint: x.hint?.join(' ') ?? '', props: x.props, marks: x.marks, traps: x.traps, items: x.items, exit: x.exit, windows: x.windows || '' })),
        links: [...links, ...(outside && exitRoom ? [{ a: outside.id, b: exitRoom.id, via: 'door', key: '', dc: 15 }] : [])],
        // Guards keep order; they're enemies only when the place is a monster's (a dungeon, a crypt, a
        // cave) or the brief made them so. The story's own hostile people stay hostile.
        guards: guards.map(g => ({ ...g, hostile: g.role === 'hostile' || monsters, role: g.role === 'hostile' || monsters ? 'hostile' : 'guard' })),
        people: people.map(p => ({ name: p.name, description: p.description, room: p.room, patrol: p.patrol, role: p.role || 'resident' })),
        start: start.id,
        ...(brief.exterior ? { exterior: brief.exterior } : {}),
        barred_windows: bp.id === 'prison',
        architect: { blueprint: bp.id, style, seed, twists: notes },
    };
    return out;
}

// ---------- distances ----------

/** Rooms a building is left by (for an escape's way out). */
const EXIT_TYPES = new Set(['foyer', 'hallway', 'guard_room', 'kitchen', 'tavern', 'shop', 'stable', 'smithy', 'workshop', 'chapel', 'room', 'gallery', 'office']);

/** How far each room is from one, in rooms walked through (stairs count two; secret doors three, they have to be found). */
function distances(rooms, links, from) {
    const dist = new Map([[from.id, 0]]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const l of links) {
            const w = l.via === 'stairs' ? 2 : l.via === 'secret' ? 3 : 1;
            for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
                if (!dist.has(p)) continue;
                const d = dist.get(p) + w;
                if (!dist.has(q) || dist.get(q) > d) { dist.set(q, d); changed = true; }
            }
        }
    }
    return dist;
}

/** The rooms on the shortest way from one room to another (both ends included), or []. */
function pathBetween(rooms, links, from, to) {
    const dist = distances(rooms, links, from);
    if (!dist.has(to.id)) return [];
    const path = [to];
    let at = to;
    while (at !== from) {
        const prev = links.map(l => (l.a === at.id ? l.b : l.b === at.id ? l.a : null)).filter(id => id && dist.has(id))
            .map(id => rooms.find(x => x.id === id)).filter(Boolean)
            .sort((p, q) => dist.get(p.id) - dist.get(q.id))[0];
        if (!prev || dist.get(prev.id) >= dist.get(at.id)) break;
        path.unshift(prev);
        at = prev;
    }
    return path[0] === from ? path : [];
}

// ---------- twists ----------

/** Twists: each changes the plan a little and says what it did (for the DM). */
const TWISTS = {
    tunnel({ r, rooms, addRoom }) {
        const cells = rooms.filter(x => x.type === 'cell');
        if (cells.length < 2) return '';
        const cell = pick(r, cells.slice(1));
        const t = addRoom('hallway', cell.level, { name: ['Half-dug Tunnel', 'Escape Tunnel', 'Old Drain'], size: 'long' });
        t.hidden = true;
        cell.secretTo = t;
        cell.hint.push('scratches on the stones behind the bunk; one stone sits loose');
        cell.marks.push('scratches');
        return `Behind a loose stone in ${cell.name} someone has been digging: a half-finished tunnel (a secret door, DC 14).`;
    },
    riot({ r, rooms, condition }) {
        const cells = rooms.filter(x => x.type === 'cell');
        if (!cells.length) return '';
        for (const c of cells.slice(0, 2)) c.marks.push('blood', 'scratches');
        const block = rooms.find(x => x.type === 'hallway') ?? rooms[0];
        block.marks.push('blood');
        block.hint.push('signs of a recent struggle, a broken stool');
        return 'There was a riot here recently: blood on the cell block floor, the guards are jumpy.';
    },
    bribe({ r, rooms }) {
        const office = rooms.find(x => x.type === 'office' || x.type === 'guard_room');
        if (!office) return '';
        office.items.push({ name: 'a ledger of bribes', hidden: true, note: 'tucked under the blotter' });
        return `Someone here takes bribes: a hidden ledger in ${office.name} proves it.`;
    },
    oubliette({ r, rooms, addRoom }) {
        const lvl = Math.min(...rooms.map(x => x.level)) - 1;
        const o = addRoom('cell', lvl, { name: ['Oubliette', 'The Forgotten Hole'], size: 'tiny' });
        o.marks.push('bones', 'scratches');
        o.hint.push('a pit with a grate far overhead; bones of someone forgotten');
        return `Below everything is an oubliette, ${o.name}, reached by a ladder from above.`;
    },
    hound({ r, rooms, addRoom }) {
        const k = rooms.find(x => x.type === 'kennel') ?? addRoom('kennel', 0, {});
        k.hint.push('chains, bowls, the smell of wet dog');
        return `Guard dogs are kept in ${k.name}; they wake at any noise.`;
    },
    records({ r, rooms, addRoom }) {
        const lib = rooms.find(x => x.type === 'library' || x.type === 'office') ?? addRoom('library', 0, { name: ['Records Room'] });
        lib.items.push({ name: 'a record naming someone the party knows', hidden: false, note: 'filed under the wrong year' });
        return `The records in ${lib.name} mention someone the party knows.`;
    },
    sealed_room({ r, rooms }) {
        const cand = rooms.filter(x => ['nursery', 'bedroom', 'study', 'chapel', 'storage', 'library'].includes(x.type) && !x.story);
        if (!cand.length) return '';
        const rm = pick(r, cand);
        rm.sealed = true;
        rm.lit = false;
        rm.marks.push('papers', 'stain');
        rm.hint.push('thick dust over everything; nobody has been in here for years; the air is stale and cold');
        if (!/'s\b/.test(rm.name)) rm.name = pick(r, ['The Sealed ', 'The Closed ', 'The Shut ']) + rm.name.replace(/^the /i, '');
        return `${rm.name} has been locked and left alone for years; the household won't speak of why.`;
    },
    priest_hole({ r, rooms, addRoom }) {
        const from = rooms.find(x => x.type === 'library' || x.type === 'study' || x.type === 'chapel');
        if (!from) return '';
        const h = addRoom('storage', from.level, { name: ['Priest Hole', 'Hidden Closet', 'Bolt Hole'], size: 'tiny' });
        h.hidden = true;
        from.secretTo = h;
        h.items.push({ name: pick(r, ['a forbidden holy book', 'a bag of hidden coin', 'a diary in a woman\'s hand', 'an old crossbow and a blanket']), hidden: false, note: '' });
        from.hint.push(from.type === 'library' ? 'one bookshelf sits a little proud of the wall' : 'a panel in the wall sounds hollow');
        return `A hidden ${h.name} lies behind ${from.name} (a secret door).`;
    },
    burnt_wing({ r, rooms }) {
        const halls = rooms.filter(x => x.type === 'hallway' && x.level >= 0);
        if (!halls.length) return '';
        const hall = pick(r, halls);
        hall.burnt = true;
        hall.marks.push('ash', 'debris');
        hall.hint.push('scorched walls and charred floorboards from an old fire');
        return `${hall.name} and the rooms off it were burnt in a fire years ago and never repaired.`;
    },
    missing_portrait({ r, rooms, addRoom }) {
        const g = rooms.find(x => x.type === 'gallery' || x.type === 'foyer');
        if (!g) return '';
        g.props.push({ type: 'painting', count: 1, label: 'an empty frame' });
        g.hint.push('one frame among the portraits hangs empty, its nameplate scratched off');
        return `In ${g.name} one portrait has been cut from its frame; its nameplate scratched away.`;
    },
    servant_stair({ r, rooms }) {
        const k = rooms.find(x => x.type === 'kitchen' || x.type === 'servants_quarters');
        const up = rooms.find(x => x.level > (k?.level ?? 0) && ['master_bedroom', 'hallway', 'bedroom'].includes(x.type));
        if (!k || !up) return '';
        k.backStairTo = up;
        return `A narrow servants' stair, easy to miss, climbs from ${k.name} to ${up.name}.`;
    },
    collector({ r, rooms, addRoom }) {
        const t = rooms.find(x => x.type === 'trophy_room') ?? addRoom('trophy_room', 0, {});
        t.props.push({ type: 'cage', count: 1, label: pick(r, ['a cage with something asleep in it', 'an empty cage, door bent outward', 'a cage of glass']) });
        t.hint.push('the collection includes things that should not be on display');
        return `The owner collects strange things: ${t.name} has a cage with a story.`;
    },
    flooded_cellar({ r, rooms }) {
        const c = rooms.find(x => x.type === 'cellar' || x.type === 'wine_cellar');
        if (!c) return '';
        c.marks.push('stain');
        c.hint.push('ankle-deep black water, things floating in it');
        return `${c.name} is half flooded; something in the water knocks against the barrels.`;
    },
    hidden_vault({ r, rooms, addRoom }) {
        const from = rooms.find(x => ['study', 'office', 'master_bedroom', 'cellar', 'library'].includes(x.type));
        if (!from) return '';
        const v = addRoom('vault', from.level, { name: ['Hidden Vault', 'Secret Strongroom', 'Concealed Treasury'], size: 'small' });
        v.hidden = true;
        from.secretTo = v;
        v.items.push({ name: pick(r, ['a chest of gold crowns', 'a ledger of every secret in town', 'a jeweled reliquary', 'stolen deeds']), hidden: false, note: '' });
        from.hint.push('a draft from somewhere it shouldn\'t come from');
        return `${v.name} is hidden behind ${from.name} (a secret door).`;
    },
    siege_damage({ r, rooms }) {
        const hit = shuffle(r, rooms.filter(x => x.level >= 0)).slice(0, 2);
        for (const rm of hit) { rm.marks.push('debris'); rm.hint.push('a wall cracked by a siege stone, rubble swept into a corner'); }
        return `The castle took a siege: ${hit.map(x => x.name).join(' and ')} still show the damage.`;
    },
    throne_passage({ r, rooms, addRoom }) {
        const t = rooms.find(x => x.type === 'throne_room');
        if (!t) return '';
        const p = addRoom('hallway', t.level, { name: ['Escape Passage', 'Royal Bolt-hole'], size: 'long' });
        p.hidden = true;
        t.secretTo = p;
        t.hint.push('the dais is worn oddly, as if something slides beneath it');
        return `A secret escape passage starts behind the throne in ${t.name}.`;
    },
    collapsed_tower({ r, rooms }) {
        const top = rooms.filter(x => x.level === Math.max(...rooms.map(y => y.level)));
        const rm = pick(r, top);
        rm.marks.push('debris');
        rm.hint.push('part of the ceiling has come down; sky shows through');
        return `${rm.name} is partly collapsed; the floor there is not to be trusted.`;
    },
    desecrated({ r, rooms }) {
        const c = rooms.find(x => x.type === 'chapel');
        if (!c) return '';
        c.marks.push('blood', 'scratches');
        c.hint.push('the altar is defaced, a symbol scrawled over the holy one');
        return `${c.name} has been desecrated recently; whoever did it may still be here.`;
    },
    hidden_reliquary({ r, rooms, addRoom }) {
        const from = rooms.find(x => x.type === 'chapel' || x.type === 'crypt');
        if (!from) return '';
        const v = addRoom('vault', from.level, { name: ['Hidden Reliquary', 'Saint\'s Niche'], size: 'tiny' });
        v.hidden = true;
        from.secretTo = v;
        v.items.push({ name: pick(r, ['a saint\'s finger bone in silver', 'a cup said to heal', 'a relic everyone thinks was lost']), hidden: false, note: '' });
        return `A hidden reliquary lies behind ${from.name}.`;
    },
    false_tomb({ r, rooms }) {
        const c = rooms.filter(x => x.type === 'crypt');
        if (!c.length) return '';
        const rm = pick(r, c);
        rm.hint.push('one sarcophagus lid has no dust on it');
        return `In ${rm.name} one tomb is a fake: it hides a way down or something stolen.`;
    },
    bone_wall({ r, rooms }) {
        const c = rooms.find(x => x.type === 'crypt' || x.type === 'hallway');
        if (!c) return '';
        c.marks.push('bones');
        c.hint.push('walls stacked with skulls and long bones in patterns');
        return `${c.name} is walled with bones arranged in patterns that mean something.`;
    },
    smuggler_trapdoor({ r, rooms, addRoom }) {
        const from = rooms.find(x => x.type === 'cellar' || x.type === 'storage') ?? rooms.find(x => x.level === 0);
        const t = addRoom('storage', from.level, { name: from.level < 0 ? ['Smugglers\' Cellar', 'The Undercellar', 'Hidden Stash'] : ['Hidden Stash', 'Smugglers\' Cubby', 'False-wall Store'] });
        t.hidden = true;
        t.items.push({ name: pick(r, ['crates of untaxed brandy', 'stolen goods', 'a smuggler\'s ledger', 'black-market weapons']), hidden: false, note: '' });
        t.secretFrom = from;
        return `A hidden door in ${from.name} leads to ${t.name}, a smugglers' stash.`;
    },
    gambling_den({ r, rooms, addRoom }) {
        const p = rooms.find(x => x.type === 'parlor' || x.type === 'storage') ?? addRoom('parlor', 0, {});
        p.name = pick(r, ['Back Room', 'The Card Room', 'Private Room']);
        p.hint.push('cards, dice, coins on the table, a lookout by the door');
        return `${p.name} is a gambling den; regulars don't like strangers.`;
    },
    locked_guest({ r, rooms }) {
        const b = rooms.find(x => x.type === 'bedroom');
        if (!b) return '';
        b.items.push({ name: 'a guest\'s locked chest', hidden: false, note: '' });
        b.hint.push('the guest hasn\'t come out in days; meals are left at the door');
        return `The guest in ${b.name} hasn't come out in days.`;
    },
    secret_meeting({ r, rooms }) {
        const rm = pick(r, rooms.filter(x => ['parlor', 'study', 'cellar', 'storage', 'office'].includes(x.type)).concat(rooms.slice(0, 1)));
        rm.items.push({ name: 'a note setting a meeting for tonight', hidden: true, note: '' });
        return `Someone has set a secret meeting in ${rm.name} tonight.`;
    },
    hidden_cellar({ r, rooms, addRoom }) {
        const from = rooms.find(x => x.type === 'kitchen' || x.type === 'pantry' || x.type === 'bedroom') ?? rooms[0];
        const c = addRoom(from.level < 0 ? 'cellar' : 'storage', from.level, { name: from.level < 0 ? ['Hidden Cellar', 'The Room Below'] : ['Hidden Room', 'Room Behind the Wall'] });
        c.hidden = true;
        c.secretFrom = from;
        c.hint.push('a room nobody mentions');
        return `Behind a false wall in ${from.name} is ${c.name}.`;
    },
    restricted({ r, rooms }) {
        const lib = rooms.filter(x => x.type === 'library');
        if (!lib.length) return '';
        const rm = pick(r, lib);
        rm.name = 'Restricted Section';
        rm.hint.push('chained books, a warning sign, a ward that hums');
        return `The Restricted Section holds books that should have been burned.`;
    },
    runaway_experiment({ r, rooms }) {
        const lab = rooms.find(x => x.type === 'laboratory');
        if (!lab) return '';
        lab.marks.push('stain', 'scratches');
        lab.hint.push('a smashed containment jar; claw marks lead away');
        return `Something escaped from ${lab.name} and is loose in the tower.`;
    },
    flooded({ r, rooms }) {
        const deep = rooms.filter(x => x.level === Math.min(...rooms.map(y => y.level)));
        const rm = pick(r, deep);
        rm.marks.push('stain');
        rm.hint.push('waist-deep cold water; the floor slopes down under it');
        return `${rm.name} is flooded.`;
    },
    collapsed({ r, rooms }) {
        const rm = pick(r, rooms.filter(x => x.type === 'hallway' || x.type === 'room' || x.type === 'cave'));
        if (!rm) return '';
        rm.marks.push('debris');
        rm.hint.push('a cave-in half fills the room; the gap at the top could be squeezed through');
        return `${rm.name} is half collapsed.`;
    },
    lair({ r, rooms }) {
        const rm = pick(r, rooms.filter(x => x.type === 'cave' || x.type === 'room'));
        if (!rm) return '';
        rm.marks.push('bones', 'bones', 'scratches');
        rm.hint.push('gnawed bones and a nest of rags: something big sleeps here');
        rm.items.push({ name: 'treasure in the nest', hidden: true, note: 'under the bones' });
        return `${rm.name} is the lair of something big.`;
    },
    gauntlet({ r, rooms }) {
        const halls = rooms.filter(x => x.type === 'hallway');
        if (!halls.length) return '';
        const h = pick(r, halls);
        h.name = pick(r, ['Hall of Blades', 'The Gauntlet', 'Corridor of Teeth']);
        for (let i = 0; i < 2; i++) h.traps.push({ kind: pick(r, ['pressure plate (darts)', 'scything blade', 'spike pit']), dc: int(r, 12, 15), save: 'DEX', effect: '2d6', hidden: true });
        h.hint.push('the floor tiles are oddly uneven; holes in the walls at waist height');
        return `${h.name} is a trap gauntlet.`;
    },
    idol({ r, rooms }) {
        const c = rooms.find(x => x.type === 'chapel') ?? pick(r, rooms);
        c.props.push({ type: 'statue', count: 1, label: pick(r, ['a jade idol with ruby eyes', 'an idol of a many-armed god', 'a weeping stone idol']) });
        return `${c.name} holds an idol that someone will want back.`;
    },
    dead_adventurer({ r, rooms }) {
        const rm = pick(r, rooms.slice(1));
        rm.marks.push('bones');
        rm.items.push({ name: pick(r, ['a dead adventurer\'s pack', 'a journal ending mid-sentence', 'a broken sword and a map']), hidden: false, note: 'by a skeleton in rotted leather' });
        return `A dead adventurer lies in ${rm.name}, with notes about what killed them.`;
    },
    restless({ r, rooms }) {
        const c = rooms.filter(x => x.type === 'crypt');
        if (!c.length) return '';
        const rm = pick(r, c);
        rm.hint.push('lids pushed aside from the inside');
        return `The dead in ${rm.name} don't stay down.`;
    },
    crystals({ r, rooms }) {
        const c = rooms.filter(x => x.type === 'cave');
        if (!c.length) return '';
        const rm = pick(r, c);
        rm.props.push({ type: 'crystal', count: 3, label: '' });
        rm.name = pick(r, ['Crystal Grotto', 'Glittering Cave', 'Singing Crystals']);
        return `${rm.name} glitters with crystals that hum when touched.`;
    },
};

/**
 * The plan for a town building's inside (built the first time the party walks in): a small place
 * of the building's kind, its keeper inside.
 */
export function interiorPlan(building, seed = 1) {
    const plan = planFromBrief(normalizeBrief({ name: building.name, kind: building.kind || building.name, size: building.size === 'large' ? 'medium' : 'small', people: building.keeper ? [{ name: building.keeper, what: building.description || `works at ${building.name}` }] : [] }), seed);
    plan.kind = 'interior';
    plan.fog = false;
    plan.rooms = plan.rooms.filter(x => x.type !== 'courtyard');
    if (plan.rooms[0] && building.description) plan.rooms[0].hint = [building.description, plan.rooms[0].hint].filter(Boolean).join(' ');
    plan.start = (plan.rooms.find(x => x.exit) ?? plan.rooms[0]).id;
    return plan;
}

// ---------- towns ----------

const TOWN_BUILDINGS = [
    ['tavern', ['The {adj} {beast}', 'The {beast} and {thing}', 'The {color} {beast}', '{given}\'s Rest'], 1],
    ['inn', ['The {beast}\'s Head Inn', 'The {adj} Lantern', 'Wayfarer\'s {thing}'], 0.5],
    ['general store', ['{given}\'s Goods', '{fam} General Store', 'The Market House'], 1],
    ['smithy', ['{given}\'s Forge', 'The {adj} Anvil', '{fam} Ironworks'], 0.9],
    ['temple', ['Temple of {saint}', 'Chapel of {saint}', 'Shrine of {saint}'], 0.8],
    ['alchemist', ['{given}\'s Remedies', 'The {color} Vial', 'Apothecary {fam}'], 0.6],
    ['bakery', ['{given}\'s Bakery', 'The Warm Loaf', 'Hearth & Crust'], 0.5],
    ['stable', ['{fam} Stables', 'The Horse Yard'], 0.5],
    ['guard post', ['The Watch House', 'Guard Post', 'Town Watch'], 0.6],
    ['tailor', ['{given}\'s Needle', 'Fine Cloth by {given}'], 0.35],
    ['bank', ['{fam} Counting House', 'The Coin Exchange'], 0.3],
    ['butcher', ['{given} the Butcher', 'The Hook & Cleaver'], 0.3],
    ['library', ['The Scriveners\' House', '{fam} Archive'], 0.2],
    ['jeweler', ['{given}\'s Gems', 'The Glittering Case'], 0.2],
];
const BEASTS = ['Stag', 'Boar', 'Raven', 'Fox', 'Bear', 'Hound', 'Griffin', 'Dragon', 'Goose', 'Badger', 'Hart', 'Owl', 'Wolf', 'Swan', 'Toad', 'Ram'];
const THINGS = ['Anchor', 'Lantern', 'Barrel', 'Crown', 'Kettle', 'Plough', 'Tankard', 'Key', 'Bell', 'Hearth'];
const TOWN_ADJ = ['Rusty', 'Drunken', 'Prancing', 'Sleeping', 'Golden', 'Laughing', 'Crooked', 'Silver', 'Wandering', 'Lucky', 'Jolly', 'Weary', 'Rusted', 'Gilded'];
const KEEPER_LOOK = ['a gruff', 'a cheerful', 'a nervous', 'a sharp-tongued', 'a kindly', 'a suspicious', 'an ancient', 'a young', 'a gossiping', 'a tired'];

/**
 * A town plan from a brief: its buildings (always somewhere to drink, buy and mend; the rest by
 * chance and size), each with a name, a sign and someone who runs it; the story's places too.
 */
export function townFromBrief(briefIn, seed = 1) {
    const brief = briefIn.normalized ? briefIn : normalizeBrief(briefIn);
    const r = rngOf(seed);
    const fam = familyName(r);
    const fill = tpl => tpl.replace('{fam}', fam).replace('{given}', pick(r, GIVEN)).replace('{color}', pick(r, COLORS)).replace('{saint}', pick(r, SAINTS).replace(/^the /, 'the ')).replace('{adj}', pick(r, TOWN_ADJ)).replace('{beast}', pick(r, BEASTS)).replace('{thing}', pick(r, THINGS));
    const n = brief.size === 'big' ? int(r, 11, 14) : brief.size === 'medium' ? int(r, 8, 10) : int(r, 5, 7);
    const buildings = [];
    const add = (kind, name, keeper, description, size) => buildings.push({ id: `B${buildings.length + 1}`, name, kind, sign: kind === 'house' ? '' : name, size: size || pick(r, ['small', 'medium', 'medium', 'large']), keeper, description, enterable: true });
    for (const [kind, names, p] of TOWN_BUILDINGS) {
        if (buildings.length >= n - 1) break;
        if (!chance(r, p)) continue;
        const keeper = `${pick(r, GIVEN)} ${familyName(r)}`;
        add(kind, fill(pick(r, names)), keeper, `${keeper}, ${pick(r, KEEPER_LOOK)} ${kind === 'temple' ? 'priest' : kind === 'guard post' ? 'watch sergeant' : 'keeper'}.`);
    }
    // The story's places in town: a named home or shop for each person the brief mentions.
    for (const p of brief.people) {
        if (buildings.some(b => nameKey(b.keeper) === nameKey(p.name))) continue;
        const kind = /smith|forge/.test(p.what) ? 'smithy' : /priest|cleric/.test(p.what) ? 'temple' : /merchant|trader|shop/.test(p.what) ? 'general store' : 'house';
        add(kind, kind === 'house' ? `${p.name}'s House` : fill(pick(r, TOWN_BUILDINGS.find(([k]) => k === kind)?.[1] ?? ['{given}\'s Shop'])), p.name, p.what);
    }
    while (buildings.length < n) add('house', `${pick(r, ['The', 'Old', ''])} ${familyName(r)} House`.trim(), `${pick(r, GIVEN)} ${familyName(r)}`, pick(r, ['a quiet family home', 'a cramped cottage', 'a house with a well-kept garden', 'a shuttered house', 'a house full of children']), 'small');
    const features = shuffle(r, ['market square', 'fountain', 'well', 'pond', 'graveyard', 'notice board', 'stocks']).slice(0, int(r, 1, 3));
    return {
        name: brief.name,
        summary: [brief.summary, `${brief.name} is ${pick(r, ['a sleepy', 'a busy', 'a wary', 'a prosperous', 'a struggling', 'a festive'])} ${brief.size === 'big' ? 'town' : 'village'}${brief.mood ? `, ${brief.mood}` : ''}.`].filter(Boolean).join(' '),
        layout: brief.size === 'small' ? 'road' : pick(r, ['road', 'crossroads', 'crossroads']),
        walled: /\b(walled|city|capital|fortified|border|war)\b/.test(`${brief.kind} ${brief.name} ${brief.mood} ${brief.summary}`.toLowerCase()) || (brief.size === 'big' && chance(r, 0.4)),
        features,
        buildings,
    };
}

// ---------- wild places ----------

const SPOTS = {
    jungle: ['Overgrown Shrine', 'Waterfall Pool', 'Hunters\' Camp', 'Vine-choked Ruin', 'Great Fig Tree', 'Sunny Clearing', 'Beast Den', 'Stone Idol', 'Muddy Ford', 'Hidden Glade', 'Abandoned Camp', 'Rope Bridge Gorge'],
    forest: ['Woodcutters\' Camp', 'Old Shrine', 'Standing Stones', 'Fallen Giant', 'Wolf Den', 'Charcoal Burners\' Clearing', 'Forest Pool', 'Hollow Oak', 'Ruined Watchtower', 'Mossy Graves', 'Bandit Camp', 'Hunter\'s Blind'],
    swamp: ['Sunken Shrine', 'Hag\'s Hut Ruin', 'Rotting Jetty', 'Will-o\'-wisp Pool', 'Croc Bank', 'Bog Graves', 'Reed Island', 'Dead Tree Grove', 'Smugglers\' Camp', 'Drowned Statue'],
    camp: ['Campfire Circle', 'Supply Tents', 'Picket Line', 'Lookout Post', 'Latrine Ditch', 'Commander\'s Tent', 'Stream Crossing', 'Wood Pile'],
    other: ['Clearing', 'Old Ruin', 'Stream Pool', 'Shrine', 'Campsite', 'Graves', 'Den', 'Standing Stones', 'Ford', 'Lookout'],
};
const WILD_CREATURES = { jungle: ['Jungle Cat', 'Giant Snake', 'Ape', 'Poison Frog Swarm', 'Bandit'], forest: ['Wolf', 'Bandit', 'Bear', 'Boar', 'Goblin'], swamp: ['Crocodile', 'Bog Zombie', 'Giant Toad', 'Lizardfolk', 'Bandit'], camp: ['Bandit', 'Sentry', 'Mercenary'], other: ['Wolf', 'Bandit', 'Boar'] };

/** A wild place's plan from a brief: its spots (clearings), how trails join them, what lives there. */
export function wildsFromBrief(briefIn, seed = 1) {
    const brief = briefIn.normalized ? briefIn : normalizeBrief(briefIn);
    const r = rngOf(seed);
    const words = `${brief.kind} ${brief.name}`.toLowerCase();
    const set = /jungle|rainforest/.test(words) ? 'jungle' : /swamp|marsh|bog/.test(words) ? 'swamp' : /camp/.test(words) ? 'camp' : /forest|wood|grove/.test(words) ? 'forest' : 'other';
    const n = brief.size === 'big' ? int(r, 7, 10) : brief.size === 'medium' ? int(r, 5, 7) : int(r, 3, 5);
    const names = shuffle(r, SPOTS[set]);
    const rooms = [{ id: 'W1', name: pick(r, ['Trailhead', 'Edge of the Trees', 'Where the Path Starts']), type: 'room', floor: 'F0', size: 'medium', description: '', props: [], marks: [], traps: [], items: [], exit: true }];
    for (let i = 0; i < n - 1; i++) rooms.push({ id: `W${i + 2}`, name: names[i % names.length], type: 'room', floor: 'F0', size: pick(r, ['small', 'medium', 'large']), description: '', props: [], marks: [], traps: [], items: [], exit: false });
    for (const s of brief.rooms) {
        const hit = rooms.find(x => nameKey(x.name).includes(nameKey(s.room)) || nameKey(s.room).includes(nameKey(x.name)));
        const rm = hit ?? (rooms.push({ id: `W${rooms.length + 1}`, name: cap(s.name || s.room), type: 'room', floor: 'F0', size: 'medium', description: '', props: [], marks: [], traps: [], items: [], exit: false }), rooms.at(-1));
        for (const it of s.has) rm.items.push({ name: it, hidden: s.hidden, note: s.note });
    }
    const links = [];
    for (let i = 1; i < rooms.length; i++) links.push({ a: pick(r, rooms.slice(Math.max(0, i - 2), i)).id, b: rooms[i].id, via: 'door' });
    if (rooms.length > 4) links.push({ a: rooms[1].id, b: rooms[rooms.length - 1].id, via: 'door' });
    const guards = [];
    const nG = brief.guards ?? int(r, 0, brief.size === 'big' ? 5 : 3);
    for (let i = 0; i < nG; i++) { const w = brief.creatures ? cap(brief.creatures.replace(/s$/i, '')) : pick(r, WILD_CREATURES[set]); const rm = pick(r, rooms.slice(1)); guards.push({ name: `${w} ${i + 1}`, description: `a ${w.toLowerCase()}`, room: rm.id, patrol: [rm.id], hostile: true }); }
    const nT = brief.traps === 'none' ? 0 : brief.traps === 'many' ? int(r, 2, 4) : int(r, 0, 2);
    for (let i = 0; i < nT; i++) pick(r, rooms.slice(1)).traps.push({ kind: pick(r, ['hunter\'s snare', 'covered pit', 'bear trap', 'tripwire (alarm bells)']), dc: int(r, 11, 14), save: 'DEX', effect: pick(r, ['caught by the ankle', '1d6 piercing, held', '2d6 falling']), hidden: true });
    return {
        name: brief.name, kind: brief.kind, theme: set === 'other' ? 'forest' : set === 'camp' ? 'camp' : set, condition: 'worn',
        summary: [brief.summary, `${brief.name}: ${rooms.length} spots joined by trails${brief.mood ? `, ${brief.mood}` : ''}.`].filter(Boolean).join(' '),
        floors: [{ id: 'F0', name: brief.name, level: 0 }],
        rooms, links, guards, people: brief.people.filter(p => !p.hostile).map(p => ({ name: p.name, description: p.what, room: (rooms.find(x => nameKey(x.name).includes(nameKey(p.where))) ?? rooms[1] ?? rooms[0]).id })),
        start: rooms[0].id,
    };
}
