// Little animated figures for the map. A character is a short description (species, build, ears,
// colors, outfit, weapon...) and this module draws it as 24x24 pixel frames for every animation:
// idle (breathing and blinking), walk, attack, hurt and down. Everything is drawn from the same
// parts, so frames always line up. Party members' descriptions come from Claude (who looks at the
// card and picture and describes what the character IS, not a copy of a design); NPCs and monsters
// use the built-in library with color variants. Pure module: frames are arrays of palette indices.

export const SIZE = 24;

// ---------- the vocabulary ----------

export const SPECIES = {
    human: { body: 'humanoid', ears: 'human', skins: ['#f1c9a5', '#e0ac85', '#c68863', '#9c6644', '#7a4b2e', '#f5d6bd'], hairs: ['#3b2a20', '#6b4423', '#c9a05a', '#1f1b1b', '#8c3b1f', '#d8d0c0'] },
    elf: { body: 'humanoid', ears: 'pointed', skins: ['#f3d7bd', '#e9c29f', '#c79a7a', '#b4a7c9'], hairs: ['#e8d9a8', '#f2f0e6', '#2b2233', '#7a4a2a', '#9fb7c9'] },
    dwarf: { body: 'humanoid', ears: 'human', build: 'small', beard: true, skins: ['#e9b993', '#c98f6a', '#a96f4f'], hairs: ['#8c3b1f', '#3b2a20', '#b7b0a3', '#d08a3a'] },
    halfling: { body: 'humanoid', ears: 'pointed', build: 'small', skins: ['#f1c9a5', '#d9a57f', '#b98260'], hairs: ['#6b4423', '#c9a05a', '#3b2a20'] },
    orc: { body: 'humanoid', ears: 'pointed', build: 'large', tusks: true, skins: ['#7c9a54', '#6a8a4a', '#8a9e66', '#5f7a4a'], hairs: ['#1f1b1b', '#3b2a20'] },
    goblin: { body: 'humanoid', ears: 'pointed', build: 'small', skins: ['#8cad4f', '#9cbc5e', '#7a9a44'], hairs: ['#1f1b1b', '#3b2a20'] },
    tiefling: { body: 'humanoid', ears: 'pointed', horns: true, tail: 'devil', skins: ['#b5463e', '#9b4f8a', '#c4645a', '#7a4ea0'], hairs: ['#1f1b1b', '#3b2233', '#6b1f2a'] },
    rabbit: { body: 'humanoid', ears: 'long', tail: 'puff', snout: 'small', fur: true, skins: ['#9aa0a8', '#d9cfc0', '#8a6b4e', '#f2efe8', '#5c5650'], hairs: ['#7d838c'] },
    cat: { body: 'humanoid', ears: 'cat', tail: 'cat', snout: 'small', fur: true, skins: ['#d08a3a', '#3b3b3b', '#e8e2d6', '#8a7a6a', '#b07a4a'], hairs: ['#a86a2a'] },
    fox: { body: 'humanoid', ears: 'fox', tail: 'fox', snout: 'long', fur: true, skins: ['#d0682a', '#c4552a', '#9a9a9a', '#e8dcc8'], hairs: ['#a84a1a'] },
    wolf: { body: 'humanoid', ears: 'wolf', tail: 'wolf', snout: 'long', fur: true, skins: ['#7d7d80', '#5a5650', '#a8a49a', '#3b3836'], hairs: ['#5a5a5e'] },
    mouse: { body: 'humanoid', ears: 'round', tail: 'thin', snout: 'small', fur: true, build: 'small', skins: ['#a89a8a', '#d8cfc4', '#7a6a5a'], hairs: ['#8a7a6a'] },
    lizard: { body: 'humanoid', ears: 'none', tail: 'lizard', snout: 'long', fur: true, skins: ['#5f8a4a', '#4a7a6a', '#8a7a3a', '#6a5a8a'], hairs: ['#3f6a3a'] },
    skeleton: { body: 'humanoid', ears: 'none', undead: 'skeleton', skins: ['#e8e2cc'], hairs: ['#e8e2cc'] },
    zombie: { body: 'humanoid', ears: 'human', undead: 'zombie', skins: ['#8a9a7a', '#7a8a8a', '#9a9a7a'], hairs: ['#3b3530', '#5a4a3a'] },
    ghost: { body: 'humanoid', ears: 'none', undead: 'ghost', skins: ['#cfe3f0', '#d8f0e8'], hairs: ['#cfe3f0'] },
};

export const BEASTS = {
    wolf: { ears: 'pointed', tail: 'bushy', snout: 3, furs: ['#7d7d80', '#5a5650', '#a8a49a', '#3b3836'] },
    hound: { ears: 'floppy', tail: 'thin', snout: 3, furs: ['#7a5a3a', '#3b3330', '#a88a5a', '#5a5a5a'] },
    rat: { ears: 'round', tail: 'long', snout: 2, small: true, furs: ['#6a5a50', '#8a7a6a', '#4a4440'] },
    spider: { spider: true, furs: ['#2b2630', '#4a3a2a', '#3a2a3a'] },
    horse: { ears: 'pointed', tail: 'long', snout: 3, big: true, mane: true, furs: ['#7a4a2a', '#3b2a20', '#e8e2d6', '#a87a4a', '#5a5a5a'] },
    bear: { ears: 'round', tail: 'stub', snout: 2, bulky: true, furs: ['#5a3a20', '#3b2a20', '#e8e2d6', '#7a5a3a'] },
    boar: { ears: 'pointed', tail: 'thin', snout: 2, tusks: true, bulky: true, furs: ['#5a4030', '#3b3030', '#6a5a4a'] },
    big_cat: { ears: 'round', tail: 'long', snout: 2, furs: ['#d0a050', '#3b3b3b', '#e8e2d6', '#c48a3a'] },
};

export const OUTFITS = ['tunic', 'vest', 'robe', 'dress', 'leather', 'armor', 'rags', 'none'];
export const HEADWEAR = ['none', 'hood', 'helmet', 'hat', 'crown', 'bandana'];
export const WEAPONS = ['none', 'sword', 'dagger', 'axe', 'mace', 'club', 'spear', 'staff', 'bow', 'claws'];
export const HAIRSTYLES = ['short', 'long', 'ponytail', 'bun', 'mohawk', 'none'];
export const BUILDS = ['small', 'medium', 'large'];
export const FACIAL_HAIR = ['none', 'stubble', 'mustache', 'beard'];
/** Restraints drawn on the figure itself (a cage is drawn around them by the map). */
export const BOUND = ['rope', 'cuffs'];

/** The NPC and monster library: a base look, plus color variants so several can share a map. */
export const LIBRARY = {
    human_guard: { species: 'human', outfit: 'armor', head: 'helmet', weapon: 'spear', outfitColors: ['#4a5a7a', '#7a2a2a', '#3a5a3a', '#5a4a6a'] },
    human_knight: { species: 'human', outfit: 'armor', head: 'helmet', weapon: 'sword', outfitColors: ['#c9a227', '#7a2a2a', '#2a4a7a'] },
    human_noble: { species: 'human', outfit: 'vest', head: 'none', weapon: 'none', outfitColors: ['#5a2a6a', '#2a4a6a', '#6a2a2a', '#2a5a4a'], accentColors: ['#c9a227'] },
    human_lady: { species: 'human', female: true, outfit: 'dress', head: 'none', weapon: 'none', hair: 'long', outfitColors: ['#8a2a4a', '#2a4a7a', '#4a6a3a', '#6a3a7a'], accentColors: ['#e8d9a8'] },
    human_servant: { species: 'human', female: 'some', outfit: 'tunic', head: 'none', weapon: 'none', outfitColors: ['#3b3836', '#5a5048', '#2a2a3a'], accentColors: ['#f2efe8'] },
    human_peasant: { species: 'human', female: 'some', outfit: 'tunic', head: 'none', weapon: 'none', outfitColors: ['#7a6a4a', '#5a6a4a', '#7a5a3a', '#6a5a5a'] },
    human_merchant: { species: 'human', female: 'some', outfit: 'vest', head: 'hat', weapon: 'none', outfitColors: ['#2a5a4a', '#6a4a2a', '#4a3a6a'], accentColors: ['#c9a227'] },
    human_thug: { species: 'human', outfit: 'leather', head: 'bandana', weapon: 'club', outfitColors: ['#5a3a20', '#3b3330', '#4a4030'], accentColors: ['#7a2a2a', '#2a3a5a'] },
    human_bandit: { species: 'human', female: 'some', outfit: 'leather', head: 'hood', weapon: 'dagger', outfitColors: ['#3a4a2a', '#4a3a2a', '#2a2a2a'] },
    human_archer: { species: 'human', female: 'some', outfit: 'leather', head: 'hood', weapon: 'bow', outfitColors: ['#3a5a2a', '#5a4a2a'] },
    human_cultist: { species: 'human', outfit: 'robe', head: 'hood', weapon: 'dagger', outfitColors: ['#5a1a1a', '#2a1a2a', '#1a1a1a'], accentColors: ['#c9a227', '#9a2a2a'] },
    human_priest: { species: 'human', female: 'some', outfit: 'robe', head: 'none', weapon: 'mace', outfitColors: ['#e8e2d6', '#d8c8a8'], accentColors: ['#c9a227'] },
    human_mage: { species: 'human', female: 'some', outfit: 'robe', head: 'hat', weapon: 'staff', outfitColors: ['#2a3a7a', '#5a2a7a', '#2a5a5a'], accentColors: ['#c9a227'] },
    human_child: { species: 'human', female: 'some', young: true, build: 'small', outfit: 'tunic', head: 'none', weapon: 'none', outfitColors: ['#7a5a3a', '#4a6a8a', '#8a4a4a'] },
    human_butler: { species: 'human', outfit: 'vest', head: 'none', weapon: 'none', hair: 'short', outfitColors: ['#1f1f24'], accentColors: ['#f2efe8'] },
    human_brute: { species: 'human', build: 'large', outfit: 'rags', head: 'none', weapon: 'axe', outfitColors: ['#5a4a3a', '#4a3a30'] },
    human_cook: { species: 'human', female: 'some', outfit: 'tunic', head: 'bandana', weapon: 'none', outfitColors: ['#e8e2d6', '#d8d0c0'], accentColors: ['#c9a227', '#7a2a2a'] },
    human_smith: { species: 'human', build: 'large', outfit: 'leather', head: 'none', weapon: 'mace', outfitColors: ['#4a3a2a', '#3b3330'], accentColors: ['#7a5a3a'] },
    human_jailer: { species: 'human', outfit: 'leather', head: 'none', weapon: 'club', outfitColors: ['#3b3330', '#2a2a2a', '#4a3a2a'], accentColors: ['#b8c0c8', '#7a5a2a'] },
    human_farmer: { species: 'human', female: 'some', outfit: 'tunic', head: 'hat', weapon: 'none', outfitColors: ['#8a7a4a', '#6a7a3a', '#7a6a4a'], accentColors: ['#c9a227', '#5a4a2a'] },
    human_laborer: { species: 'human', female: 'some', outfit: 'vest', head: 'bandana', weapon: 'none', outfitColors: ['#6a5a4a', '#4a4a3a', '#5a4a3a'], accentColors: ['#8a3a2a', '#3a5a7a'] },
    human_sailor: { species: 'human', female: 'some', outfit: 'tunic', head: 'bandana', weapon: 'dagger', outfitColors: ['#2a4a7a', '#e8e2d6', '#3a3a5a'], accentColors: ['#9a2a2a', '#2a2a2a'] },
    human_miner: { species: 'human', build: 'large', outfit: 'rags', head: 'helmet', weapon: 'axe', outfitColors: ['#5a5048', '#4a4440'] },
    human_scholar: { species: 'human', female: 'some', outfit: 'robe', head: 'none', weapon: 'none', outfitColors: ['#5a4a3a', '#3a4a3a', '#4a3a4a'], accentColors: ['#c9a227'] },
    human_bard: { species: 'human', female: 'some', outfit: 'vest', head: 'hat', weapon: 'dagger', outfitColors: ['#7a2a4a', '#2a6a5a', '#7a5a1a'], accentColors: ['#e0b83a', '#e8e2d6'] },
    human_healer: { species: 'human', female: 'some', outfit: 'robe', head: 'hood', weapon: 'staff', outfitColors: ['#5a7a5a', '#e8e2d6', '#6a8a7a'], accentColors: ['#9a2a2a'] },
    human_beggar: { species: 'human', female: 'some', outfit: 'rags', head: 'hood', weapon: 'none', outfitColors: ['#5a5048', '#4a4440', '#6a5a4a'] },
    human_elder: { species: 'human', female: 'some', outfit: 'robe', head: 'none', weapon: 'staff', hair: 'short', outfitColors: ['#6a6a6a', '#5a4a3a', '#4a4a5a'] },
    human_executioner: { species: 'human', build: 'large', outfit: 'none', head: 'hood', weapon: 'axe', outfitColors: ['#1a1a1a'] },
    human_townsfolk: { species: 'human', female: 'some', outfit: 'tunic', head: 'none', weapon: 'none', outfitColors: ['#4a6a8a', '#8a4a4a', '#5a7a4a', '#7a6a8a', '#8a7a5a'] },
    elf: { species: 'elf', female: 'some', outfit: 'leather', head: 'none', weapon: 'bow', outfitColors: ['#3a6a3a', '#5a6a3a', '#3a4a6a'] },
    dwarf: { species: 'dwarf', outfit: 'armor', head: 'helmet', weapon: 'axe', outfitColors: ['#7a5a3a', '#5a5a6a'] },
    halfling: { species: 'halfling', female: 'some', outfit: 'vest', head: 'none', weapon: 'dagger', outfitColors: ['#5a7a3a', '#7a5a2a', '#3a5a7a'] },
    orc: { species: 'orc', outfit: 'leather', head: 'none', weapon: 'axe', outfitColors: ['#4a3a2a', '#3b3330', '#5a3a2a'] },
    goblin: { species: 'goblin', outfit: 'rags', head: 'none', weapon: 'dagger', outfitColors: ['#5a4a3a', '#4a4a2a', '#6a3a2a'] },
    tiefling: { species: 'tiefling', female: 'some', outfit: 'robe', head: 'none', weapon: 'staff', outfitColors: ['#2a1a2a', '#3a2a4a', '#4a1a1a'] },
    rabbitfolk: { species: 'rabbit', female: 'some', outfit: 'leather', head: 'none', weapon: 'dagger', outfitColors: ['#5a3a20', '#3a4a5a', '#5a5a3a'] },
    catfolk: { species: 'cat', female: 'some', outfit: 'vest', head: 'none', weapon: 'dagger', outfitColors: ['#6a2a2a', '#2a4a5a', '#4a3a2a'] },
    foxfolk: { species: 'fox', female: 'some', outfit: 'tunic', head: 'none', weapon: 'sword', outfitColors: ['#2a4a3a', '#4a2a2a', '#3a3a5a'] },
    wolffolk: { species: 'wolf', outfit: 'leather', head: 'none', weapon: 'axe', outfitColors: ['#3b3330', '#4a3a2a'] },
    mousefolk: { species: 'mouse', female: 'some', outfit: 'tunic', head: 'none', weapon: 'none', outfitColors: ['#5a6a4a', '#7a5a3a'] },
    lizardfolk: { species: 'lizard', outfit: 'leather', head: 'none', weapon: 'spear', outfitColors: ['#4a3a20', '#3a3a2a'] },
    skeleton: { species: 'skeleton', outfit: 'none', head: 'none', weapon: 'sword', outfitColors: ['#e8e2cc'] },
    zombie: { species: 'zombie', outfit: 'rags', head: 'none', weapon: 'none', outfitColors: ['#4a4a3a', '#3a3a4a', '#5a3a3a'] },
    ghost: { species: 'ghost', outfit: 'robe', head: 'none', weapon: 'none', outfitColors: ['#cfe3f0', '#d8f0e8'] },
    wolf: { beast: 'wolf' }, hound: { beast: 'hound' }, rat: { beast: 'rat' }, giant_spider: { beast: 'spider' },
    horse: { beast: 'horse' }, bear: { beast: 'bear' }, boar: { beast: 'boar' }, big_cat: { beast: 'big_cat' },
};

/** Pick a library figure from what an NPC or enemy is called and described as. */
export function presetFor(text) {
    const t = String(text || '').toLowerCase();
    const w = list => new RegExp(`\\b(${list})\\b`);
    const rules = [
        [/\b(giant )?spiders?\b/, 'giant_spider'], [/\b(rat|rats)\b/, 'rat'], [/\b(horse|pony|steed|mare|stallion)\b/, 'horse'], [/\bbear\b/, 'bear'], [/\bboar\b/, 'boar'],
        [/\b(hound|mastiff|dog|cur)\b/, 'hound'], [/\b(lion|panther|tiger|big cat|leopard)\b/, 'big_cat'],
        [/\b(wolf|wolves|warg)\b(?!.*folk)/, /folk|man\b|woman\b/.test(t) ? 'wolffolk' : 'wolf'],
        [w('skeletons?|skeletal'), 'skeleton'], [w('zombies?|ghouls?|corpses?|undead|walking dead'), 'zombie'], [w('ghosts?|spirits?|specters?|spectres?|phantoms?|wraiths?|apparitions?|ghostly'), 'ghost'],
        [w('harengon|rabbits?|bunny|bunnies|hares?|rabbit-?folk'), 'rabbitfolk'], [w('tabaxi|cat-?folk|cats?'), 'catfolk'], [w('fox|foxes|fox-?folk'), 'foxfolk'], [w('mouse|mice|mouse-?folk'), 'mousefolk'], [w('lizard-?folk|lizards?|kobolds?|dragonborn'), 'lizardfolk'],
        [w('orcs?|half-orcs?|orcish'), 'orc'], [w('goblins?|hobgoblins?'), 'goblin'], [w('tieflings?|devils?|demons?'), 'tiefling'], [w('dwarf|dwarves|dwarven'), 'dwarf'], [w('halflings?|gnomes?'), 'halfling'], [w('elf|elves|elven|elvish|drow'), 'elf'],
        [w('knights?|captain|commander|paladins?'), 'human_knight'], [w('jailers?|turnkeys?|gaolers?|keykeepers?'), 'human_jailer'],
        [w('guards?|soldiers?|watch(man|men)?|sentry|sentries|wardens?|city watch'), 'human_guard'], [w('butlers?|valets?|stewards?'), 'human_butler'],
        [w('cooks?|chefs?|bakers?|butchers?'), 'human_cook'], [w('maids?|servants?|housekeepers?|footmen|footman|barmaids?|serving girl'), 'human_servant'],
        [w('lady|queen|princess|duchess|countess|baroness|madam|noblewoman'), 'human_lady'],
        [w('nobles?|nobleman|lord|king|prince|duke|count|baron|aristocrats?|magistrate'), 'human_noble'], [w('cultists?|acolytes?|zealots?'), 'human_cultist'],
        [w('priests?|priestess|clerics?|monks?|nuns?|bishops?|abbots?|abbess|brother|friars?'), 'human_priest'], [w('healers?|physicians?|surgeons?|herbalists?|midwife|apothecary'), 'human_healer'],
        [w('mages?|wizards?|sorcerers?|sorceress|warlocks?|witch|witches|alchemists?|magician'), 'human_mage'], [w('scholars?|scribes?|librarians?|sages?|clerks?|tutors?|archivists?'), 'human_scholar'],
        [w('archers?|hunters?|rangers?|scouts?|trappers?|poachers?'), 'human_archer'], [w('bandits?|thie(f|ves)|rogues?|cutpurses?|assassins?|smugglers?|highwaym[ae]n|pickpockets?'), 'human_bandit'],
        [w('executioners?|headsm[ae]n|torturers?'), 'human_executioner'],
        [w('ogres?|giants?|brutes?|bruisers?|groundskeepers?'), 'human_brute'], [w('thugs?|enforcers?|heavies|bouncers?|mercenar(y|ies)'), 'human_thug'],
        [w('(black|silver|gold|lock|white)?smiths?|farriers?|armou?rers?'), 'human_smith'], [w('miners?|diggers?|prospectors?'), 'human_miner'],
        [w('sailors?|deckhands?|pirates?|fisherm[ae]n|boatm[ae]n|dockworkers?'), 'human_sailor'], [w('farmers?|farmhands?|shepherds?|peasants?|milkmaids?|plowm[ae]n|stablehands?|stable boy'), 'human_farmer'],
        [w('laborers?|labourers?|workers?|porters?|carpenters?|masons?|builders?|dockhands?'), 'human_laborer'],
        [w('bards?|minstrels?|musicians?|singers?|performers?|jugglers?|entertainers?'), 'human_bard'],
        [w('merchants?|shopkeepers?|traders?|innkeepers?|barkeeps?|tavern ?keepers?|peddlers?|vendors?|landlord|landlady|bartenders?'), 'human_merchant'],
        [w('beggars?|vagrants?|drunks?|drunkards?|vagabonds?|hermits?'), 'human_beggar'], [w('elders?|old m[ae]n|old wom[ae]n|grandmother|grandfather|crone|matron|village elder'), 'human_elder'],
        [w('child|children|kids?|boys?|girls?|urchins?|orphans?|youngsters?'), 'human_child'],
    ];
    return rules.find(([re]) => re.test(t))?.[1] ?? null;
}

function hashText(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

const FEMALE_WORDS = /\b(she|her|woman|women|lady|ladies|girl|maid|maiden|wife|mother|sister|daughter|aunt|grandmother|queen|princess|duchess|countess|baroness|madam|mistress|widow|nun|priestess|sorceress|witch|matron|crone|hag|barmaid|waitress|heiress|abbess)\b/;
const MALE_WORDS = /\b(he|him|his|man|men|lord|boy|husband|father|brother|son|uncle|grandfather|king|prince|duke|count|baron|sir|monk|butler|footman|valet|barman|widower|abbot)\b/;

/** 'female' or 'male' when the words say so ("the cook, a stout old woman"), else ''. */
export function sexFromText(text) {
    const t = String(text || '').toLowerCase();
    const f = t.match(FEMALE_WORDS)?.index ?? Infinity, m = t.match(MALE_WORDS)?.index ?? Infinity;
    return f === m ? '' : f < m ? 'female' : 'male';
}

/**
 * A library figure in one of its color variants (the same name always gets the same one).
 * sex: 'female' / 'male' when known; otherwise the library decides (and "either" figures alternate).
 */
export function libraryLook(key, variant = 0, sex = '') {
    const base = LIBRARY[key] ?? LIBRARY.human_peasant;
    const n = Math.abs(Math.round(Number(variant) || 0));
    if (base.beast) {
        const b = BEASTS[base.beast];
        return { beast: base.beast, fur: b.furs[n % b.furs.length] };
    }
    const sp = SPECIES[base.species] ?? SPECIES.human;
    const female = sex === 'female' || (sex !== 'male' && (base.female === true || (base.female === 'some' && n % 2 === 1)));
    const plain = base.young || sp.fur || sp.undead || sp.beard;
    return normalizeLook({
        species: base.species,
        build: base.build ?? sp.build ?? 'medium',
        outfit: base.outfit, head: base.head, weapon: base.weapon,
        female, young: base.young,
        facialHair: female || plain ? 'none' : ['none', 'stubble', 'beard', 'mustache', 'none'][(n * 2 + 1) % 5],
        hair: base.hair ?? (female ? ['long', 'ponytail', 'bun', 'long'][(n * 3 + 1) % 4] : ['short', 'short', 'none', 'long', 'mohawk'][(n * 3 + 1) % 5]),
        skin: sp.skins[(n * 7 + 2) % sp.skins.length],
        hairColor: sp.hairs[(n * 5 + 1) % sp.hairs.length],
        outfitColor: base.outfitColors[n % base.outfitColors.length],
        accentColor: (base.accentColors ?? ['#c9a227', '#7a5a2a', '#e8e2d6'])[(n * 3) % (base.accentColors?.length ?? 3)],
    });
}

/** The look for an NPC by name and description, with a variant that's stable for that name. */
const COMMONERS = ['human_townsfolk', 'human_peasant', 'human_laborer', 'human_farmer', 'human_townsfolk', 'human_merchant'];

export function lookForNpc(name, description = '', key = '', gender = '') {
    const sex = gender === 'male' || gender === 'female' ? gender : sexFromText(`${name} ${description}`);
    const h = hashText(name);
    const preset = LIBRARY[key] ? key : presetFor(`${name} ${description}`) ?? COMMONERS[Math.floor(h / 7) % COMMONERS.length];
    return libraryLook(preset, h % 7, sex);
}

const hex = v => (/^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null);
const pickIn = (v, list, fallback) => (list.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fallback);

/** Validate a look (from Claude or the library). Never throws. */
export function normalizeLook(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (d.beast && BEASTS[d.beast]) return { beast: d.beast, fur: hex(d.fur) ?? BEASTS[d.beast].furs[0] };
    const species = SPECIES[String(d.species || '').toLowerCase()] ? String(d.species).toLowerCase() : 'human';
    const sp = SPECIES[species];
    return {
        species,
        build: pickIn(d.build, BUILDS, sp.build ?? 'medium'),
        skin: hex(d.skin) ?? sp.skins[0],
        hair: pickIn(d.hair, HAIRSTYLES, sp.fur || sp.undead ? 'none' : 'short'),
        hairColor: hex(d.hairColor) ?? sp.hairs[0],
        eyes: hex(d.eyes) ?? (sp.undead === 'skeleton' ? '#1a1418' : '#2a2030'),
        outfit: pickIn(d.outfit, OUTFITS, 'tunic'),
        outfitColor: hex(d.outfitColor) ?? '#5a4a3a',
        accentColor: hex(d.accentColor) ?? '#c9a227',
        head: pickIn(d.head, HEADWEAR, 'none'),
        weapon: pickIn(d.weapon, WEAPONS, 'none'),
        female: d.female === true || d.female === 'true',
        facialHair: d.female === true || d.female === 'true' ? 'none' : pickIn(d.facialHair, FACIAL_HAIR, 'none'),
        young: d.young === true,
        ...(BOUND.includes(d.bound) ? { bound: d.bound } : {}),
    };
}

// ---------- colors ----------

function mix(a, b, f) {
    const ca = parseInt(a.slice(1), 16), cb = parseInt(b.slice(1), 16);
    const ch = [16, 8, 0].map(sh => Math.round(((ca >> sh) & 255) * (1 - f) + ((cb >> sh) & 255) * f));
    return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function shade(hexColor, f) {
    const n = parseInt(hexColor.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))));
    return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Palette slots.
const O = 1, SK = 2, SKD = 3, HR = 4, HRD = 5, OF = 6, OFD = 7, AC = 8, EYE = 9, MET = 10, METD = 11, WOOD = 12, WH = 13, PINK = 14, BOOT = 15, BLK = 16, GOLD = 17, HORN = 18, SKL = 19, STB = 20, ROPE = 21, ROPED = 22;

function paletteFor(look) {
    const p = new Array(23).fill(null);
    const skin = look.skin ?? look.fur ?? '#9aa0a8';
    p[O] = '#17131a';
    p[SK] = skin; p[SKD] = shade(skin, -0.22); p[SKL] = shade(skin, 0.28);
    p[HR] = look.hairColor ?? shade(skin, -0.15); p[HRD] = shade(p[HR], -0.25);
    p[STB] = mix(shade(skin, -0.12), p[HRD], 0.45);
    p[ROPE] = '#c2a06a'; p[ROPED] = '#7d6238';
    p[OF] = look.outfitColor ?? '#5a4a3a'; p[OFD] = shade(p[OF], -0.3);
    p[AC] = look.accentColor ?? '#c9a227';
    p[EYE] = look.eyes ?? '#2a2030';
    p[MET] = '#b8c0c8'; p[METD] = '#6a727a'; p[WOOD] = '#7a5230'; p[WH] = '#f2efe8'; p[PINK] = '#e8a0a8';
    p[BOOT] = '#3a2a20'; p[BLK] = '#120e12'; p[GOLD] = '#e0b83a'; p[HORN] = '#d8ccb0';
    return p;
}

// ---------- pixels ----------

class Px {
    constructor() { this.d = new Uint8Array(SIZE * SIZE); }
    set(x, y, c) { x = Math.round(x); y = Math.round(y); if (c && x >= 0 && y >= 0 && x < SIZE && y < SIZE) this.d[y * SIZE + x] = c; }
    get(x, y) { return x < 0 || y < 0 || x >= SIZE || y >= SIZE ? 0 : this.d[y * SIZE + x]; }
    rect(x, y, w, h, c) { for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) this.set(x + i, y + j, c); }
    clear(x, y) { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) this.d[y * SIZE + x] = 0; }
    line(x0, y0, x1, y1, c, thick = 1) {
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let i = 0; i <= n; i++) {
            const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
            this.set(x, y, c);
            if (thick > 1) this.set(x + 1, y, c);
        }
    }
    /** A dark 1-pixel outline around everything drawn: makes tiny sprites readable on any floor. */
    outline() {
        const src = this.d.slice();
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
            if (src[y * SIZE + x]) continue;
            const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < SIZE && yy < SIZE && src[yy * SIZE + xx] && src[yy * SIZE + xx] !== O; });
            if (n) this.d[y * SIZE + x] = O;
        }
        return this;
    }
}

// ---------- weapons ----------

function weapon(px, type, hx, hy, deg) {
    if (type === 'none' || type === 'claws') {
        if (type === 'claws') for (const [dx, dy] of [[1, -1], [2, 0], [1, 1]]) px.set(hx + dx, hy + dy, WH);
        return;
    }
    const a = deg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), pxp = -dy, pyp = dx;
    const at = (i, side = 0) => [hx + dx * i + pxp * side, hy + dy * i + pyp * side];
    const seg = (from, to, c) => { for (let i = from; i <= to; i++) px.set(...at(i), c); };
    if (type === 'sword' || type === 'dagger') {
        const len = type === 'sword' ? 8 : 4;
        px.set(...at(-1), AC);
        px.set(...at(1, -1), AC); px.set(...at(1, 1), AC);
        seg(1, len, MET);
        for (let i = 2; i < len; i++) px.set(...at(i, 0.6), WH);
    } else if (type === 'axe') {
        seg(-1, 7, WOOD);
        for (let i = 5; i <= 7; i++) { px.set(...at(i, -1), MET); px.set(...at(i, -2), MET); }
        px.set(...at(6, -3), METD);
    } else if (type === 'mace' || type === 'club') {
        seg(-1, 5, WOOD);
        const c = type === 'mace' ? MET : WOOD;
        for (let i = 5; i <= 7; i++) for (const s of [-1, 0, 1]) px.set(...at(i, s), c);
        if (type === 'mace') px.set(...at(8), METD);
    } else if (type === 'spear') {
        seg(-4, 9, WOOD);
        seg(10, 11, MET);
        px.set(...at(10, 1), MET); px.set(...at(10, -1), MET);
    } else if (type === 'staff') {
        seg(-5, 8, WOOD);
        px.set(...at(9), GOLD); px.set(...at(9, 1), GOLD); px.set(...at(10), WH);
    }
}

/** A bow held up in front, with its string; pulled = drawn back to the other hand. */
function bow(px, hx, hy, pulled, backX) {
    for (let j = -5; j <= 5; j++) px.set(hx + 1 + Math.round(Math.cos(j / 5.5 * Math.PI / 2) * 2), hy + j, WOOD);
    if (pulled) { px.line(hx + 1, hy - 5, backX, hy, WH); px.line(backX, hy, hx + 1, hy + 5, WH); px.line(backX, hy, hx + 5, hy, MET); }
    else px.line(hx + 1, hy - 5, hx + 1, hy + 5, WH);
}

// ---------- the humanoid rig (facing right) ----------

const POSES = {
    idle: [{}, { bob: 1 }, {}, { blink: true }],
    walk: [{ back: -2, front: 2, armF: -2, armB: 2 }, { bob: -1 }, { back: 2, front: -2, armF: 2, armB: -2 }, { bob: -1 }],
    attack: [{ wpn: -150, handUp: true, lean: -1 }, { wpn: -5, reach: 3, lean: 1, pull: true }, { wpn: 35, reach: 2 }],
    hurt: [{ lean: -2, blink: true, armsUp: true }],
};

// Badly hurt: hunched over with a hand pressed to the side, swaying a little.
const INJURED = [{ bob: 2, lean: 2, armF: -3, armB: 1 }, { bob: 2, lean: 2, armF: -3, armB: 1 }, { bob: 2, lean: 1, armF: -3, armB: 1 }, { bob: 2, lean: 2, armF: -3, armB: 1, blink: true }];
const BEAST_INJURED = [{ bob: 1, lean: -1 }, { bob: 1 }, { bob: 1, lean: -1, blink: true }];

// Tied up: a slow squirm (lean one way, then the other) instead of breathing; dragged, a little bob.
const SQUIRM = [{}, { lean: 1 }, { lean: 1, bob: 1 }, { lean: -1, blink: true }];
const DRAGGED = [{ lean: -1 }, { lean: -1, bob: 1 }, { lean: -1 }, { lean: -1, bob: 1 }];

function humanoid(look, poseIn) {
    const tied = look.bound === 'rope', cuffed = look.bound === 'cuffs';
    const pose = tied ? { ...poseIn, back: 0, front: 0, armF: 0, armB: 0, reach: 0, wpn: undefined, handUp: false, armsUp: false, pull: false }
        : cuffed ? { ...poseIn, reach: 0, wpn: undefined, handUp: false, armsUp: false, pull: false } : poseIn;
    const sp = SPECIES[look.species] ?? SPECIES.human;
    const px = new Px();
    const small = look.build === 'small', large = look.build === 'large';
    const ghost = sp.undead === 'ghost', skeleton = sp.undead === 'skeleton', zombie = sp.undead === 'zombie';
    const feet = 22, legLen = small ? 3 : large ? 5 : 4;
    const hip = feet - legLen;
    const torsoH = small ? 4 : large ? 6 : 5;
    const torsoW = small ? 5 : large ? 7 : 6;
    const tl = 12 - Math.floor(torsoW / 2);
    const lean = pose.lean ?? 0, bob = pose.bob ?? 0;
    const tt = hip - torsoH + 1 + bob;
    const headH = sp.ears === 'long' ? 7 : 8;
    const hl = tl - 1 + lean + (large ? 0 : 0), ht = tt - headH;
    const robe = ['robe', 'dress'].includes(look.outfit) || ghost;
    const fur = sp.fur;
    // Men get a heavier, sterner look (brow, nose, jaw, shoulders); women and children keep the soft face.
    const masc = !look.female && !look.young && !ghost && !skeleton;

    // Tail (behind everything).
    if (sp.tail === 'puff') px.rect(tl - 2 + lean, hip - 2 + bob, 2, 2, WH);
    else if (sp.tail === 'cat') px.line(tl - 1 + lean, hip - 1 + bob, tl - 4 + lean, hip - 6 + bob, SK, 1);
    else if (sp.tail === 'thin') px.line(tl - 1 + lean, hip + bob, tl - 5 + lean, hip + 3, PINK, 1);
    else if (sp.tail === 'fox' || sp.tail === 'wolf') {
        for (let i = 0; i < 5; i++) px.rect(tl - 2 - i + lean, hip - 2 + bob + (sp.tail === 'wolf' ? Math.floor(i / 2) : -Math.floor(i / 2)), 2, 2, i >= 3 && sp.tail === 'fox' ? WH : SK);
    } else if (sp.tail === 'lizard') { px.line(tl - 1 + lean, hip + bob, tl - 5, feet, SK, 2); }
    else if (sp.tail === 'devil') { px.line(tl - 1 + lean, hip + bob, tl - 4, hip + 2, SKD, 1); px.set(tl - 5, hip + 1, SKD); }

    // Back arm and back leg (darker, behind the body).
    const shoulderB = [tl + 1 + lean, tt + 1], shoulderF = [tl + torsoW - 2 + lean, tt + 1];
    const handB = tied ? [shoulderB[0] - 1, shoulderB[1] + 4] : cuffed ? [tl + Math.floor(torsoW / 2) - 1 + lean, tt + 3] : zombie ? [shoulderB[0] + 5, shoulderB[1] + 1] : pose.armsUp ? [shoulderB[0] - 1, shoulderB[1] - 2] : [shoulderB[0] + (pose.armB ?? -1), shoulderB[1] + 4];
    const sleeve = look.outfit === 'none' || skeleton ? SKD : look.outfit === 'armor' ? METD : OFD;
    px.line(...shoulderB, ...handB, sleeve, 2);
    px.rect(handB[0], handB[1], 2, 2, SKD);
    if (!robe) {
        const legC = look.outfit === 'armor' ? METD : skeleton ? SKD : fur && look.outfit === 'none' ? SKD : OFD;
        const hx = tl + 1 + lean, fx = hx + (pose.back ?? 0);
        px.line(hx, hip + 1, fx, feet, legC, 2);
        px.rect(fx, feet, 2, 1, skeleton ? SKD : fur ? SKD : BOOT);
    }

    // Body.
    if (ghost) {
        // A drifting sheet of a body: wider at the bottom, with a wavy hem.
        for (let y = tt; y <= feet - 1; y++) { const w = torsoW + Math.floor((y - tt) / 3); px.rect(12 - Math.floor(w / 2) + lean, y, w, 1, y > feet - 3 ? SKD : SK); }
        const phase = (pose.bob ?? 0) + (pose.back ?? 0);
        for (let x = 6; x < 18; x++) if ((x + phase) % 3 === 0) px.clear(x, feet - 1);
    } else {
        px.rect(tl + lean, tt, torsoW, torsoH, look.outfit === 'none' ? SK : look.outfit === 'armor' ? MET : OF);
        px.rect(tl + lean, tt, 1, torsoH, look.outfit === 'none' ? SKD : look.outfit === 'armor' ? METD : OFD);
        if (look.outfit === 'none' && fur) px.rect(tl + 2 + lean, tt + 1, torsoW - 3, torsoH - 2, SKL);
        if (skeleton) for (let y = tt + 1; y < tt + torsoH - 1; y += 2) px.rect(tl + 1 + lean, y, torsoW - 2, 1, BLK);
        if (look.outfit === 'vest') { px.rect(tl + 2 + lean, tt, 2, torsoH - 1, WH); px.set(tl + 3 + lean, tt + 1, AC); }
        if (look.outfit === 'armor') { px.rect(tl + 1 + lean, tt, 3, 2, METD); px.set(tl + torsoW - 2 + lean, tt + 1, WH); }
        if (look.outfit === 'leather') { px.line(tl + lean, tt, tl + torsoW - 1 + lean, tt + torsoH - 2, AC); }
        if (!['none', 'armor'].includes(look.outfit) && !skeleton) px.rect(tl + lean, hip - 1 + bob, torsoW, 1, AC);
        if (look.outfit === 'tunic' || look.outfit === 'rags') {
            px.rect(tl + lean, hip + bob, torsoW, 1, OF);
            if (look.outfit === 'rags') for (let x = 0; x < torsoW; x += 2) px.set(tl + x + lean, hip + 1 + bob, OF);
        }
        if (robe) {
            for (let y = hip; y <= feet; y++) { const w = torsoW + 1 + Math.floor((y - hip) / 2); px.rect(12 - Math.ceil(w / 2) + lean, y, w, 1, y === feet ? OFD : OF); }
            px.rect(12 - 1 + (pose.front ?? 0) / 2, feet, 2, 1, BOOT);
        }
        // Men: broad, square shoulders (a pixel wider each side, tapering to the waist).
        if (masc) {
            const top = look.outfit === 'none' ? SK : look.outfit === 'armor' ? MET : OF, side = look.outfit === 'none' ? SKD : look.outfit === 'armor' ? METD : OFD;
            px.rect(tl - 1 + lean, tt, 1, 2, side);
            px.rect(tl + torsoW + lean, tt, 1, 2, top);
            if (look.outfit === 'armor') { px.set(tl - 1 + lean, tt, MET); px.set(tl + torsoW + lean, tt, WH); }
        }
    }

    // Front leg.
    if (!robe) {
        const legC = look.outfit === 'armor' ? MET : skeleton ? SK : fur && look.outfit === 'none' ? SK : OF;
        const hx = tl + torsoW - 3 + lean, fx = hx + (pose.front ?? 0);
        px.line(hx, hip + 1, fx, feet, look.outfit === 'tunic' || look.outfit === 'rags' || look.outfit === 'vest' ? OFD : legC, 2);
        px.rect(fx, feet, 2, 1, skeleton ? SK : fur ? SKD : BOOT);
        if (look.outfit !== 'none' && !skeleton) px.rect(fx, feet - 1, 2, 1, fur ? SK : BOOT);
    }

    // Head.
    const H = (x, y, c) => px.set(hl + x, ht + y, c);
    px.rect(hl, ht, 8, headH, SK);
    for (const [x, y] of [[0, 0], [7, 0], [0, headH - 1], [7, headH - 1]]) px.clear(hl + x, ht + y);
    px.rect(hl, ht + 1, 1, headH - 2, SKD);
    if (fur) px.rect(hl + 4, ht + headH - 3, 3, 2, SKL);
    // Snout (beastfolk), tusks (orcs).
    if (sp.snout === 'small') { H(8, 4, SK); H(8, 5, SKL); H(8, 4, PINK); }
    else if (sp.snout === 'long') { px.rect(hl + 8, ht + 4, 2, 2, SK); px.rect(hl + 8, ht + 5, 2, 1, SKL); H(9, 4, BLK); }
    if (sp.tusks) { H(6, headH - 2, WH); H(4, headH - 2, WH); }
    // Men: a square jaw, a nose, a set mouth.
    if (masc) {
        H(7, headH - 1, SK); H(6, headH - 1, SKD);
        if (!sp.snout) { H(8, 4, SK); H(8, 5, SKD); }
        if (!sp.tusks && !zombie) { H(5, 6, SKD); H(6, 6, SKD); }
    }
    // Eyes (closed for a blink). Men: a heavy brow over small dark eyes.
    if (skeleton) { px.rect(hl + 3, ht + 3, 2, 2, BLK); px.rect(hl + 6, ht + 3, 2, 2, BLK); H(5, 6, BLK); }
    else if (masc) {
        const brow = fur ? SKD : HRD;
        H(2, 3, brow); H(3, 3, brow); H(5, 3, brow); H(6, 3, brow); H(7, 3, brow);
        if (pose.blink) { H(3, 4, BLK); H(6, 4, BLK); } else { H(3, 4, EYE); H(6, 4, EYE); H(4, 4, WH); H(7, 4, WH); }
    }
    else if (pose.blink) { H(3, 4, BLK); H(4, 4, BLK); H(6, 4, BLK); }
    else { H(3, 3, WH); H(3, 4, EYE); H(6, 3, WH); H(6, 4, EYE); if (ghost) { H(3, 4, BLK); H(6, 4, BLK); } }
    if (zombie) { H(2, 6, SKD); H(5, 6, BLK); }
    // Facial hair.
    if (masc && !fur && !sp.beard) {
        const fh = look.facialHair;
        if (fh === 'stubble') { px.rect(hl + 2, ht + headH - 2, 6, 2, STB); H(2, headH - 3, STB); H(5, 6, SKD); H(6, 6, SKD); }
        if (fh === 'mustache') { H(4, 5, HR); H(5, 5, HR); H(6, 5, HR); H(7, 5, HR); H(4, 6, HRD); H(5, 6, HRD); H(6, 6, HRD); H(7, 6, HRD); }
        if (fh === 'beard') { px.rect(hl + 2, ht + headH - 3, 6, 3, HR); px.rect(hl + 3, ht + headH, 4, 1, HRD); H(5, 5, HR); H(6, 5, HR); H(7, 5, HR); H(5, 6, SKD); H(6, 6, SKD); }
    }
    // Hair.
    if (!fur && !skeleton && !ghost && look.head !== 'hood' && look.head !== 'helmet') {
        const st = look.hair;
        if (st !== 'none') {
            px.rect(hl + 1, ht - 1, 6, 1, HR); px.rect(hl, ht, 8, 2, HR); px.rect(hl, ht, 2, st === 'long' ? headH + 3 : 4, HR);
            px.rect(hl + 6, ht, 2, 1, HRD);
            if (st === 'ponytail') px.rect(hl - 2, ht + 2, 2, 5, HR);
            if (st === 'bun') px.rect(hl - 1, ht - 2, 3, 3, HR);
            if (st === 'mohawk') { px.rect(hl + 3, ht - 3, 2, 3, HR); }
            if (st === 'long') px.rect(hl - 1, ht + 3, 1, headH, HRD);
        }
    }
    if (sp.beard) { px.rect(hl + 3, ht + headH - 3, 5, 4, HR); px.rect(hl + 3, ht + headH, 4, 1, HRD); }
    // Ears.
    if (sp.ears === 'human' && !['hood', 'helmet'].includes(look.head)) H(1, 4, SKD);
    if (sp.ears === 'pointed' && look.head !== 'hood') { H(0, 3, SK); H(-1, 2, SK); H(-2, 1, SKD); }
    if (sp.ears === 'long') {
        // Rabbit ears: the back one darker, both with a pink inside; one flops a little when walking.
        const flop = pose.bob === -1 ? 1 : 0;
        px.rect(hl + 1, ht - 6, 2, 6, SKD); px.set(hl + 2, ht - 4, PINK); px.set(hl + 2, ht - 3, PINK);
        px.rect(hl + 4 + flop, ht - 7 + flop, 2, 7 - flop, SK); px.set(hl + 5 + flop, ht - 5 + flop, PINK); px.set(hl + 5 + flop, ht - 4 + flop, PINK); px.set(hl + 5 + flop, ht - 3 + flop, PINK);
    }
    if (sp.ears === 'cat' || sp.ears === 'fox' || sp.ears === 'wolf') {
        const tall = sp.ears === 'cat' ? 2 : 3;
        for (const ex of [1, 5]) for (let j = 0; j < tall; j++) { px.rect(hl + ex + Math.floor(j / 2), ht - tall + j, tall - j + (j ? 0 : 0), 1, j === 0 ? SKD : SK); }
        H(2, -1, PINK); H(6, -1, PINK);
    }
    if (sp.ears === 'round') { px.rect(hl, ht - 2, 3, 3, SK); px.rect(hl + 5, ht - 2, 3, 3, SK); H(1, -1, PINK); H(6, -1, PINK); }
    if (sp.horns) { px.set(hl + 2, ht - 1, HORN); px.set(hl + 1, ht - 2, HORN); px.set(hl + 1, ht - 3, HORN); px.set(hl + 5, ht - 1, HORN); px.set(hl + 5, ht - 2, HORN); px.set(hl + 6, ht - 3, HORN); }
    // Headwear.
    if (look.head === 'hood') { px.rect(hl - 1, ht - 1, 9, 3, OF); px.rect(hl - 1, ht, 3, headH - 1, OF); px.rect(hl - 1, ht + 1, 1, headH - 3, OFD); }
    if (look.head === 'helmet') { px.rect(hl, ht - 1, 8, 4, MET); px.rect(hl, ht - 1, 2, 4, METD); px.set(hl + 7, ht + 3, MET); px.set(hl + 7, ht + 4, MET); px.rect(hl + 1, ht - 1, 6, 1, WH); }
    if (look.head === 'hat') { px.rect(hl - 2, ht, 12, 1, OFD); px.rect(hl + 1, ht - 3, 6, 3, OF); px.rect(hl + 1, ht - 1, 6, 1, AC); }
    if (look.head === 'crown') { px.rect(hl + 1, ht - 1, 6, 1, GOLD); for (const x of [1, 3, 5, 6]) px.set(hl + x, ht - 2, GOLD); }
    if (look.head === 'bandana') { px.rect(hl, ht, 8, 2, AC); px.set(hl - 1, ht + 2, AC); px.set(hl - 2, ht + 3, AC); }

    // Front arm, hand and weapon.
    const reach = pose.reach ?? 0;
    let handF = tied ? [shoulderF[0] + 1, shoulderF[1] + 4] : cuffed ? [tl + Math.floor(torsoW / 2) + lean, tt + 3] : zombie ? [shoulderF[0] + 5, shoulderF[1] + 1] : pose.handUp ? [shoulderF[0] - 1, shoulderF[1] - 2] : pose.armsUp ? [shoulderF[0], shoulderF[1] - 3] : [shoulderF[0] + 1 + (pose.armF ?? 0) + reach, shoulderF[1] + 4 - (reach ? 1 : 0)];
    const sleeveF = look.outfit === 'none' || skeleton ? SK : look.outfit === 'armor' ? MET : OF;
    if (look.weapon === 'bow' && !tied && !cuffed) {
        handF = [shoulderF[0] + 3, shoulderF[1] + 1];
        px.line(...shoulderF, ...handF, sleeveF, 2);
        bow(px, handF[0] + 1, handF[1], Boolean(pose.pull) || Boolean(pose.handUp), shoulderB[0] + 1);
        px.rect(handF[0], handF[1], 2, 2, SK);
    } else {
        px.line(...shoulderF, ...handF, sleeveF, 2);
        if (!tied && !cuffed && (pose.wpn !== undefined || !['none', 'claws'].includes(look.weapon))) weapon(px, look.weapon, handF[0] + 1, handF[1], pose.wpn ?? -65);
        px.rect(handF[0], handF[1], 2, 2, SK);
    }
    if (tied) {
        // Coils of rope around the chest and arms, and around the ankles; knots in a darker brown.
        for (const y of [tt + 1, tt + 3]) {
            px.rect(tl - 2 + lean, y + bob * 0, torsoW + 4, 1, ROPE);
            for (let x = tl - 2 + lean; x < tl + torsoW + 2 + lean; x += 3) px.set(x, y, ROPED);
        }
        px.set(tl + torsoW + 2 + lean, tt + 2, ROPED);
        px.rect(tl + lean, feet - 2, torsoW, 1, ROPE);
        px.set(tl + 1 + lean, feet - 2, ROPED); px.set(tl + torsoW - 2 + lean, feet - 2, ROPED);
    }
    if (cuffed) {
        // Iron cuffs on both wrists and a short chain between them.
        px.rect(handF[0] - 1, handF[1], 4, 1, MET);
        px.set(handF[0], handF[1], WH); px.set(handF[0] + 2, handF[1], WH);
        px.rect(handF[0] - 1, handF[1] - 1, 4, 1, METD);
        px.set(handF[0] + 1, handF[1] + 2, METD); px.set(handF[0], handF[1] + 3, METD); px.set(handF[0] + 1, handF[1] + 4, METD);
    }
    return px.outline();
}

// ---------- the four-legged rig (facing right) ----------

const BEAST_POSES = {
    idle: [{}, { bob: 1 }, {}, { blink: true }],
    walk: [{ a: 2, b: -2 }, { bob: -1 }, { a: -2, b: 2 }, { bob: -1 }],
    attack: [{ lean: -2 }, { lean: 3, open: true }, { lean: 1 }],
    hurt: [{ lean: -2, blink: true }],
};

function beast(look, pose) {
    const b = BEASTS[look.beast];
    const px = new Px();
    const lean = pose.lean ?? 0, bob = pose.bob ?? 0;
    if (b.spider) {
        // A round abdomen at the back, a smaller head-body at the front, and eight jointed legs
        // (the far four behind the body, the near four in front), stepping in turns.
        const by = 14 + bob, cx = 11 + lean;
        const legs = side => {
            for (let i = 0; i < 4; i++) {
                const step = ((i % 2 ? pose.a : pose.b) ?? 0) / 2 * (side ? 1 : -1);
                const rootX = cx + 1 + i, rootY = by + 1;
                const kneeX = cx - 6 + i * 4 + step, kneeY = by - 4 - (i === 1 || i === 2 ? 1 : 0);
                const footX = cx - 9 + i * 6 + step, footY = 21;
                const c = side ? SK : SKD;
                px.line(rootX, rootY, kneeX, kneeY, c);
                px.line(kneeX, kneeY, footX, footY, c);
            }
        };
        legs(0);
        for (let y = -4; y <= 4; y++) for (let x = -5; x <= 5; x++) if ((x * x) / 30 + (y * y) / 18 <= 1) px.set(cx - 4 + x, by + y - 1, y < -2 ? SKD : SK);
        px.rect(cx - 6, by - 3, 3, 2, SKL);
        for (let y = -2; y <= 2; y++) for (let x = -3; x <= 3; x++) if ((x * x) / 10 + (y * y) / 6 <= 1) px.set(cx + 4 + x, by + y + 1, SK);
        legs(1);
        if (!pose.blink) { px.set(cx + 6, by, PINK); px.set(cx + 5, by - 1, PINK); px.set(cx + 7, by - 1, PINK); }
        px.set(cx + 7, by + 3, WH); px.set(cx + 6, by + 3, WH);
        if (pose.open) { px.set(cx + 8, by + 3, WH); px.set(cx + 8, by + 4, WH); }
        return px.outline();
    }
    const big = b.big, bulky = b.bulky, small = b.small;
    const groundY = 22, legH = big ? 8 : small ? 3 : 5;
    const bodyTop = groundY - legH - (bulky ? 7 : small ? 4 : 5) + bob, bodyH = bulky ? 7 : small ? 4 : 5;
    const bx = (small ? 7 : bulky ? 3 : 4) + lean, bw = small ? 9 : bulky ? 14 : 12;
    // Tail.
    const tx = bx, ty = bodyTop + 1;
    if (b.tail === 'bushy') for (let i = 0; i < 4; i++) px.rect(tx - 1 - i, ty - Math.floor(i / 2), 2, 2, i === 3 ? SKL : SK);
    else if (b.tail === 'long') px.line(tx, ty + 1, tx - 4, ty + (look.beast === 'horse' ? 6 : 4), look.beast === 'rat' ? PINK : HRD, look.beast === 'horse' ? 2 : 1);
    else if (b.tail === 'thin') px.line(tx, ty, tx - 3, ty + 2, SKD);
    else if (b.tail === 'stub') px.rect(tx - 1, ty, 1, 2, SKD);
    // Far legs, body, near legs.
    const leg = (x, off, c) => { px.line(x, bodyTop + bodyH - 1, x + off, groundY, c, 2); px.rect(x + off, groundY, 2, 1, c === SK ? SKD : O === c ? O : SKD); };
    leg(bx + 1, (pose.b ?? 0) / 2, SKD); leg(bx + bw - 5, (pose.a ?? 0) / 2, SKD);
    px.rect(bx, bodyTop, bw, bodyH, SK);
    px.rect(bx + 1, bodyTop + bodyH - 1, bw - 2, 1, SKL);
    px.rect(bx + 1, bodyTop, bw - 2, 1, SKD);
    // Rounded ends.
    for (const [x, y] of [[bx, bodyTop], [bx + bw - 1, bodyTop], [bx, bodyTop + bodyH - 1], [bx + bw - 1, bodyTop + bodyH - 1]]) px.clear(x, y);
    if (b.mane) px.rect(bx + bw - 4, bodyTop - 1, 4, 2, HRD);
    leg(bx + 3, (pose.a ?? 0) / 2, SK); leg(bx + bw - 3, (pose.b ?? 0) / 2, SK);
    // Head: up on a neck for a horse, low and forward for the rest.
    const hx = bx + bw - 2, hy = big ? bodyTop - 6 : bodyTop - 2;
    if (big) px.line(bx + bw - 3, bodyTop, hx + 1, hy + 3, SK, 2);
    px.rect(hx, hy, 5, 4, SK);
    px.rect(hx, hy, 5, 1, SKD);
    const sn = b.snout;
    px.rect(hx + 5, hy + 1 + (pose.open ? 0 : 0), sn, 2, SK);
    px.set(hx + 4 + sn, hy + 1, BLK);
    if (pose.open) { px.rect(hx + 5, hy + 3, sn, 1, PINK); px.set(hx + 5, hy + 3, WH); }
    if (b.tusks) px.set(hx + 5, hy + 3, WH);
    if (b.mane) px.rect(hx - 1, hy - 1, 3, 3, HRD);
    if (!pose.blink) px.set(hx + 3, hy + 1, EYE); else px.set(hx + 3, hy + 1, BLK);
    if (b.ears === 'pointed') { px.set(hx + 1, hy - 1, SK); px.set(hx + 1, hy - 2, SKD); px.set(hx + 2, hy - 1, SKD); }
    if (b.ears === 'round') { px.rect(hx, hy - 1, 2, 1, SK); px.set(hx, hy - 2, SK); }
    if (b.ears === 'floppy') { px.rect(hx, hy, 2, 3, SKD); }
    return px.outline();
}

// ---------- the whole sprite ----------

/**
 * Sitting: the body drops onto the seat and the legs fold forward (thighs out in front, feet down).
 * legLen = how long the figure's legs are (by build).
 */
function sitting(frame, legLen) {
    const feet = 22, hip = feet - legLen, drop = legLen - 1;
    const out = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < hip; y++) for (let x = 0; x < SIZE; x++) { const c = frame[y * SIZE + x]; if (c && y + drop < SIZE) out[(y + drop) * SIZE + x] = c; }
    // The legs: what's at the top of the legs becomes the thighs, reaching forward; the boots end them.
    const cols = [];
    for (let x = 0; x < SIZE; x++) if (frame[(hip + 1) * SIZE + x]) cols.push(x);
    if (!cols.length) return out;
    const right = Math.max(...cols), boot = frame[feet * SIZE + right] || frame[(feet - 1) * SIZE + right] || frame[(hip + 1) * SIZE + right];
    for (const x of cols) for (let t = 0; t <= 3; t++) {
        const c = frame[(hip + 1) * SIZE + x], nx = x + t;
        if (nx < SIZE) { out[(feet - 1) * SIZE + nx] ||= c; out[(feet - 2) * SIZE + nx] ||= frame[hip * SIZE + x] || c; }
    }
    for (let t = 0; t < 2; t++) if (right + 3 - t < SIZE) out[feet * SIZE + right + 3 - t] = boot;
    return out;
}

/** A beast settling down: the whole body lower (legs tucked under). */
function crouched(frame, rows) {
    const out = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE - rows; y++) for (let x = 0; x < SIZE; x++) { const c = frame[y * SIZE + x]; if (c) out[(y + rows) * SIZE + x] = c; }
    return out;
}

/** Lying down at 0 HP: the standing frame turned on its side, resting on the ground. */
function lyingDown(frame) {
    const out = new Uint8Array(SIZE * SIZE);
    let minY = SIZE;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const c = frame[y * SIZE + x];
        if (!c) continue;
        // Rotate a quarter turn (head to the left), then sit it on the floor.
        const nx = y, ny = SIZE - 1 - x;
        out[ny * SIZE + nx] = c;
        minY = Math.min(minY, ny);
    }
    const rows = [];
    for (let y = 0; y < SIZE; y++) if (out.slice(y * SIZE, y * SIZE + SIZE).some(Boolean)) rows.push(y);
    const drop = SIZE - 2 - (rows.at(-1) ?? SIZE - 2);
    const shifted = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const c = out[y * SIZE + x]; if (c && y + drop < SIZE) shifted[(y + drop) * SIZE + x] = c; }
    return shifted;
}

/**
 * Build every frame of a figure.
 * @returns {{size:number, palette:(string|null)[], alpha:number, anims:Record<string, Uint8Array[]>}}
 */
export function buildSprite(lookIn) {
    const look = lookIn?.beast ? normalizeLook(lookIn) : normalizeLook(lookIn);
    const isBeast = Boolean(look.beast);
    const draw = isBeast ? beast : humanoid;
    const poses = isBeast ? BEAST_POSES : look.bound === 'rope' ? { ...POSES, idle: SQUIRM, walk: DRAGGED } : POSES;
    const anims = {};
    for (const [name, list] of Object.entries(poses)) anims[name] = list.map(p => draw(look, p).d);
    anims.down = [lyingDown(anims.idle[3])];
    // Badly hurt (low HP), sitting, lying down awake or asleep, and asleep in a bed seen from above.
    anims.injured = (isBeast ? BEAST_INJURED : INJURED).map(p => draw(look, p).d);
    const legLen = look.build === 'small' ? 3 : look.build === 'large' ? 5 : 4;
    anims.sit = isBeast ? [crouched(anims.idle[0], 2), crouched(anims.idle[1], 2)] : [sitting(anims.idle[0], legLen), sitting(anims.idle[1], legLen)];
    anims.lie = isBeast ? [crouched(anims.idle[0], 4)] : [lyingDown(anims.idle[0])];
    anims.sleep = isBeast ? [crouched(anims.idle[3], 4)] : [lyingDown(anims.idle[3])];
    anims.abed = [anims.idle[0]];
    anims.asleep = [anims.idle[3]];
    const alpha = !isBeast && SPECIES[look.species]?.undead === 'ghost' ? 0.72 : 1;
    return { size: SIZE, palette: paletteFor(isBeast ? { skin: look.fur, hairColor: shade(look.fur, -0.3) } : look), alpha, anims };
}

/** How fast each animation plays (frames per second) and whether it loops. */
export const ANIM_TIMING = { idle: { fps: 3, loop: true }, walk: { fps: 10, loop: true }, attack: { fps: 9, loop: false }, hurt: { fps: 4, loop: false }, down: { fps: 1, loop: true }, injured: { fps: 2, loop: true }, sit: { fps: 1.5, loop: true }, lie: { fps: 1, loop: true }, sleep: { fps: 1, loop: true }, abed: { fps: 1, loop: true }, asleep: { fps: 1, loop: true } };

/** Instructions for Claude: describe a character for their map figure (sent with their picture). */
export const SPRITE_INSTRUCTIONS = `You design tiny pixel-art map figures (24x24 pixels) for a tabletop game. Look at the character's picture and card and describe what they ARE, in generic terms, as a small figure: their kind of creature, build and colors, what they wear and carry. Do not try to reproduce a specific copyrighted design; a generic figure of the same kind is the goal (a well-known rabbit police officer becomes "a small female rabbit-folk in light armor").
Return ONE JSON object and nothing else:
{
  "species": "${Object.keys(SPECIES).join('|')}",
  "build": "small|medium|large",
  "female": "true for a woman or girl, false for a man or boy (men are drawn with a heavier brow, jaw and shoulders)",
  "facialHair": "${FACIAL_HAIR.join('|')} (men only)",
  "skin": "#hex (skin, or main fur color for furry folk)",
  "hair": "${HAIRSTYLES.join('|')} (furry folk and the bald: none)",
  "hairColor": "#hex",
  "eyes": "#hex",
  "outfit": "${OUTFITS.join('|')}",
  "outfitColor": "#hex (main clothing or armor color)",
  "accentColor": "#hex (belt, trim)",
  "head": "${HEADWEAR.join('|')}",
  "weapon": "${WEAPONS.join('|')} (what they'd fight with: their sheet's main weapon if given)"
}
Pick the closest species: rabbit-folk (harengon) = rabbit, cat-folk (tabaxi) = cat, kobolds and dragonborn = lizard, gnomes = halfling. Colors should match the picture.`;
