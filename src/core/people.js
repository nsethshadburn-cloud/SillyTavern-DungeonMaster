// Is a name a person (or a creature), or a place or a thing the DM mislabelled? The DM now and then
// puts "The Drowned Eel" or "Silver Candlesticks" in new_npcs or in a brief; a shop and a candlestick
// never get a voice or a figure. Words only: a name with a being word in it is a person. Pure module.

const PLACE_WORDS = /\b(?:street|lane|road|alley|square|market|inn|tavern|taproom|common room|back room|shop|store|smithy|forge|temple|church|shrine|hall|house|home|cottage|cabin|hut|manor|mansion|castle|keep|tower|gate|gatehouse|bridge|dock|docks|wharf|harbou?r|quay|mill|farm|barn|stable|stables|camp|cave|cavern|grove|clearing|wood|woods|forest|river|stream|lake|pond|ford|pass|trail|path|room|cell|cellar|kitchen|yard|court|courtyard|garden|chapel|crypt|tomb|dungeon|prison|jail|gaol|town|village|city|hamlet|district|quarter|ward|warehouse|office|study|library|vault|bank|guild|guildhall|barracks|watchtower|lighthouse|ruins?|crossroads|plaza|bazaar)\b/i;
const THING_WORDS = /\b(?:ledger|book|books|key|keys|lantern|lamp|torch|candle|candles|rope|chain|chains|cuffs|manacles|shackles|sword|dagger|knife|blade|bow|arrows?|shield|armou?r|cloak|coat|boots|purse|coin|coins|gold|silver|ring|amulet|gem|gems|jewel|jewels|candlestick|candlesticks|chest|box|crate|barrel|sack|bag|pack|letter|note|map|scroll|potion|vial|flask|bottle|cup|mug|plate|bowl|table|chair|bed|door|window|wagon|cart|statue|idol|painting|mirror|tools|lockpick|lockpicks|rations|bread|meat|cheese|wine|ale|trap|tripwire|lever|lock)\b/i;
const BEING_WORDS = /\b(?:man|woman|boy|girl|lad|lass|guard|guards|watchman|watchmen|soldier|knight|captain|sergeant|constable|sheriff|bruiser|thug|bandit|raider|outlaw|thief|rogue|merchant|trader|shopkeeper|keeper|innkeeper|landlord|landlady|barkeep|barmaid|smith|blacksmith|locksmith|priest|priestess|monk|nun|wizard|witch|mage|sorcerer|elder|chief|chieftain|lord|lady|king|queen|prince|princess|duke|baron|farmer|hunter|fisher|fisherman|sailor|cook|servant|maid|butler|jailer|warden|turnkey|prisoner|beggar|child|children|dog|hound|wolf|wolves|horse|mare|stallion|pony|cat|raven|crow|bear|boar|rat|rabbit|hare|fox|deer|goat|pig|cow|ox|oxen|mule|donkey|bird|hawk|owl|snake|spider|goblin|orc|troll|ogre|giant|dragon|skeleton|zombie|ghost|ghoul|demon|devil|elf|dwarf|halfling|gnome|tiefling|dragonborn|hopps|wilde|fence)\b/i;

/** The last word of a name: what it is ("Olwen Tusk's Locksmith Shop" is a shop, whoever the locksmith is). */
function headWord(s) {
    return String(s).replace(/[,;(].*$/, '').trim().split(/\s+/).pop() || '';
}

/** A place by its words (The Drowned Eel Inn, Eel Street, the back room, Olwen Tusk's Locksmith Shop). */
export function looksLikePlace(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (PLACE_WORDS.test(headWord(s))) return true;
    return PLACE_WORDS.test(s) && !BEING_WORDS.test(s);
}

/** A thing by its words (Silver Candlesticks, the ledger, a hooded lantern). */
export function looksLikeThing(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (THING_WORDS.test(headWord(s)) && !BEING_WORDS.test(headWord(s))) return true;
    return THING_WORDS.test(s) && !BEING_WORDS.test(s);
}

/** Not someone who can speak or stand on a map: a place or a thing. */
export function notAPerson(name) {
    return looksLikePlace(name) || looksLikeThing(name);
}

/**
 * An entry of new_npcs judged by its name, then by what the DM says it is: "The Drowned Eel" with
 * the role "the inn" is a place; "Hob", "bruiser, Tusk's man" is a person; a role with a being word
 * in it ("keeper of the Drowned Eel Inn") is a person whatever else it says.
 */
export function notAPersonEntry(npc) {
    const name = String(npc?.name || '');
    if (notAPerson(name)) return true;
    if (BEING_WORDS.test(name)) return false;
    const said = `${npc?.role || ''} ${npc?.description || ''}`;
    if (BEING_WORDS.test(said)) return false;
    const role = String(npc?.role || '');
    return Boolean(role) && (PLACE_WORDS.test(role) || THING_WORDS.test(role));
}
