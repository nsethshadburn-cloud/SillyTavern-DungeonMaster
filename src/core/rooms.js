// Room recipes: how each kind of room is floored, walled and furnished, so a generated place looks
// lived-in without Claude listing every chair. Claude's own props and marks for a room are added
// on top. Pure data.
//
// Placement words: wall = against a wall inside the room; center = middle of the room;
// corner = an inside corner; any = anywhere free; onwall = hung on a wall square (paintings,
// shackles, fireplaces); ceiling = hangs over the floor (chandeliers, hooks); floor = a mark on the
// floor (blood, papers). [type, where, [min, max], {size: [w, h], fill: true (stretch along the wall)}]

export const ROOM_SIZES = Object.freeze({
    tiny: [[3, 3], [4, 4]],
    small: [[4, 4], [6, 5]],
    medium: [[6, 5], [8, 7]],
    large: [[8, 7], [11, 9]],
    huge: [[11, 9], [14, 12]],
    long: [[2, 8], [3, 13]],
});

const WALLPAPER_HUES = [350, 220, 140, 30, 280, 200, 10];
const CARPET_HUES = [352, 220, 140, 28, 280, 0];

/** Recipes by room type. Unknown types use "room". */
export const RECIPES = {
    foyer: { size: 'large', lit: true, floor: 'marble', wall: 'stoneblock', items: [['chandelier', 'ceiling', [1, 1]], ['rug', 'center', [1, 1], { fill: true }], ['statue', 'corner', [2, 2]], ['plant', 'corner', [1, 2]], ['painting', 'onwall', [2, 3]], ['clock', 'wall', [0, 1]], ['armor', 'wall', [0, 2]]] },
    hallway: { size: 'long', lit: false, floor: 'parquet', wall: 'wallpaper', items: [['rug', 'center', [1, 1], { fill: true }], ['painting', 'onwall', [2, 4]], ['torch', 'onwall', [1, 2]], ['plant', 'corner', [0, 1]], ['armor', 'wall', [0, 1]]] },
    gallery: { size: 'long', lit: true, floor: 'marble', wall: 'wallpaper', items: [['painting', 'onwall', [4, 7]], ['statue', 'wall', [1, 3]], ['rug', 'center', [1, 1], { fill: true }], ['chandelier', 'ceiling', [1, 2]]] },
    library: { size: 'large', lit: false, floor: 'parquet', wall: 'panel', items: [['bookshelf', 'wall', [4, 7], { size: [3, 1] }], ['desk', 'center', [1, 1], { size: [2, 1] }], ['chair', 'any', [1, 2]], ['armchair', 'any', [1, 2]], ['rug', 'center', [1, 1], { fill: true }], ['candles', 'any', [1, 2]], ['papers', 'floor', [0, 2]], ['chandelier', 'ceiling', [0, 1]]] },
    study: { size: 'small', lit: false, floor: 'parquet', wall: 'panel', items: [['desk', 'wall', [1, 1], { size: [2, 1] }], ['chair', 'any', [1, 1]], ['bookshelf', 'wall', [1, 2], { size: [2, 1] }], ['cabinet', 'wall', [0, 1]], ['fireplace', 'onwall', [0, 1]], ['painting', 'onwall', [1, 1]], ['papers', 'floor', [1, 2]], ['candles', 'any', [1, 1]]] },
    bedroom: { size: 'medium', lit: false, floor: 'carpet', wall: 'wallpaper', items: [['bed', 'wall', [1, 1], { size: [1, 2] }], ['nightstand', 'wall', [1, 2]], ['wardrobe', 'wall', [1, 1]], ['dresser', 'wall', [0, 1]], ['mirror', 'onwall', [0, 1]], ['painting', 'onwall', [0, 1]], ['rug', 'center', [0, 1], { size: [2, 2] }], ['candles', 'any', [0, 1]]] },
    master_bedroom: { size: 'large', lit: false, floor: 'carpet', wall: 'wallpaper', items: [['bed', 'wall', [1, 1], { size: [2, 2] }], ['nightstand', 'wall', [2, 2]], ['wardrobe', 'wall', [1, 2]], ['dresser', 'wall', [1, 1]], ['fireplace', 'onwall', [1, 1]], ['sofa', 'any', [0, 1]], ['armchair', 'any', [1, 1]], ['mirror', 'onwall', [1, 1]], ['painting', 'onwall', [1, 2]], ['rug', 'center', [1, 1], { size: [3, 2] }], ['chandelier', 'ceiling', [0, 1]]] },
    dining_room: { size: 'large', lit: true, floor: 'parquet', wall: 'wallpaper', items: [['table', 'center', [1, 1], { long: true }], ['chandelier', 'ceiling', [1, 2]], ['cabinet', 'wall', [1, 2]], ['painting', 'onwall', [1, 3]], ['fireplace', 'onwall', [0, 1]], ['plant', 'corner', [0, 2]], ['clock', 'wall', [0, 1]]] },
    kitchen: { size: 'medium', lit: true, floor: 'tiles', wall: 'plaster', items: [['counter', 'wall', [1, 2], { size: [3, 1] }], ['fireplace', 'onwall', [1, 1]], ['table', 'center', [1, 1], { size: [2, 1] }], ['cauldron', 'any', [0, 1]], ['barrel', 'corner', [1, 2]], ['sack', 'corner', [1, 2]], ['pot', 'any', [1, 2]], ['hooks', 'ceiling', [0, 1]], ['stain', 'floor', [0, 2]]] },
    pantry: { size: 'small', lit: false, floor: 'stone', wall: 'brick', items: [['barrel', 'wall', [2, 3]], ['sack', 'wall', [2, 3]], ['crate', 'wall', [1, 2]], ['cabinet', 'wall', [0, 1]], ['hooks', 'ceiling', [0, 1]], ['web', 'corner', [0, 1]]] },
    storage: { size: 'small', lit: false, floor: 'stone', wall: 'brick', items: [['crate', 'wall', [2, 4]], ['barrel', 'wall', [1, 3]], ['sack', 'any', [1, 2]], ['chest', 'wall', [0, 1]], ['web', 'corner', [1, 2]]] },
    cellar: { size: 'medium', lit: false, floor: 'dirt', wall: 'brick', items: [['barrel', 'wall', [3, 6]], ['crate', 'wall', [1, 3]], ['sack', 'any', [1, 2]], ['web', 'corner', [1, 2]], ['stain', 'floor', [1, 2]]] },
    wine_cellar: { size: 'medium', lit: false, floor: 'stone', wall: 'brick', items: [['barrel', 'wall', [5, 9]], ['table', 'center', [0, 1]], ['candles', 'any', [1, 1]], ['web', 'corner', [1, 2]]] },
    parlor: { size: 'medium', lit: true, floor: 'carpet', wall: 'wallpaper', items: [['sofa', 'wall', [1, 1]], ['armchair', 'any', [1, 2]], ['table', 'center', [1, 1]], ['fireplace', 'onwall', [1, 1]], ['piano', 'wall', [0, 1]], ['painting', 'onwall', [1, 2]], ['plant', 'corner', [1, 2]], ['clock', 'wall', [0, 1]]] },
    ballroom: { size: 'huge', lit: true, floor: 'marble', wall: 'wallpaper', items: [['chandelier', 'ceiling', [2, 3]], ['piano', 'wall', [1, 1]], ['statue', 'corner', [2, 4]], ['plant', 'corner', [0, 2]], ['painting', 'onwall', [2, 4]], ['sofa', 'wall', [0, 2]]] },
    music_room: { size: 'medium', lit: true, floor: 'parquet', wall: 'panel', items: [['piano', 'center', [1, 1]], ['chair', 'any', [2, 3]], ['bookshelf', 'wall', [0, 1], { size: [2, 1] }], ['painting', 'onwall', [1, 2]], ['plant', 'corner', [1, 1]]] },
    bathroom: { size: 'small', lit: false, floor: 'tiles', wall: 'plaster', items: [['bathtub', 'wall', [1, 1]], ['mirror', 'onwall', [1, 1]], ['cabinet', 'wall', [0, 1]], ['pot', 'corner', [0, 1]]] },
    chapel: { size: 'large', lit: true, floor: 'marble', wall: 'stoneblock', items: [['altar', 'wall', [1, 1], { size: [2, 1] }], ['pew', 'center', [2, 4], { rows: true }], ['candles', 'any', [2, 3]], ['statue', 'corner', [0, 2]], ['banner', 'onwall', [1, 2]]] },
    trophy_room: { size: 'medium', lit: true, floor: 'parquet', wall: 'panel', items: [['armor', 'wall', [1, 3]], ['weaponrack', 'wall', [1, 2]], ['statue', 'corner', [0, 2]], ['painting', 'onwall', [1, 3]], ['banner', 'onwall', [0, 2]], ['skull', 'any', [0, 2]], ['rug', 'center', [1, 1], { size: [3, 2] }]] },
    torture_chamber: { size: 'medium', lit: false, floor: 'stone', wall: 'brick', grime: 0.6, items: [['rack', 'any', [1, 1]], ['iron_maiden', 'wall', [0, 1]], ['stocks', 'wall', [0, 1]], ['slab', 'center', [0, 1], { size: [1, 2] }], ['chains', 'onwall', [2, 4]], ['brazier', 'any', [1, 1]], ['cage', 'corner', [0, 1]], ['hooks', 'ceiling', [0, 2]], ['blood', 'floor', [3, 6]], ['scratches', 'floor', [1, 2]], ['bones', 'floor', [1, 2]], ['skull', 'any', [0, 1]], ['torch', 'onwall', [1, 2]]] },
    cell: { size: 'tiny', lit: false, floor: 'stone', wall: 'brick', grime: 0.6, items: [['chains', 'onwall', [1, 2]], ['bowl', 'any', [0, 1]], ['pot', 'corner', [0, 1]], ['scratches', 'floor', [0, 2]], ['bones', 'floor', [0, 1]], ['blood', 'floor', [0, 1]]] },
    kennel: { size: 'medium', lit: false, floor: 'stone', wall: 'brick', grime: 0.5, items: [['kennel', 'wall', [2, 4]], ['cage', 'wall', [1, 2]], ['petbed', 'any', [1, 2]], ['bowl', 'any', [2, 4]], ['chains', 'onwall', [1, 3]], ['scratches', 'floor', [2, 3]], ['bones', 'floor', [0, 2]], ['stain', 'floor', [1, 2]]] },
    laboratory: { size: 'medium', lit: true, floor: 'tiles', wall: 'brick', items: [['workbench', 'wall', [1, 2], { size: [2, 1] }], ['cauldron', 'any', [1, 1]], ['cabinet', 'wall', [1, 2]], ['bookshelf', 'wall', [0, 1], { size: [2, 1] }], ['slab', 'center', [0, 1], { size: [1, 2] }], ['candles', 'any', [1, 2]], ['papers', 'floor', [1, 2]], ['blood', 'floor', [0, 2]], ['stain', 'floor', [1, 2]]] },
    workshop: { size: 'medium', lit: true, floor: 'planks', wall: 'timber', items: [['workbench', 'wall', [1, 2], { size: [2, 1] }], ['anvil', 'any', [0, 1]], ['crate', 'corner', [1, 2]], ['barrel', 'corner', [1, 1]], ['weaponrack', 'wall', [0, 1]]] },
    smithy: { size: 'medium', lit: true, floor: 'dirt', wall: 'stoneblock', items: [['forge', 'wall', [1, 1]], ['anvil', 'center', [1, 1]], ['workbench', 'wall', [1, 1], { size: [2, 1] }], ['weaponrack', 'wall', [1, 2]], ['barrel', 'corner', [1, 1]], ['crate', 'corner', [0, 1]]] },
    armory: { size: 'medium', lit: false, floor: 'stone', wall: 'stoneblock', items: [['weaponrack', 'wall', [2, 4]], ['armor', 'wall', [1, 3]], ['chest', 'wall', [1, 2]], ['crate', 'corner', [0, 2]], ['torch', 'onwall', [1, 2]]] },
    guard_room: { size: 'medium', lit: true, floor: 'stone', wall: 'stoneblock', items: [['table', 'center', [1, 1], { size: [2, 1] }], ['chair', 'any', [2, 3]], ['weaponrack', 'wall', [1, 1]], ['bed', 'wall', [0, 2], { size: [1, 2] }], ['chest', 'wall', [0, 1]], ['barrel', 'corner', [0, 1]], ['torch', 'onwall', [1, 2]]] },
    servants_quarters: { size: 'medium', lit: false, floor: 'planks', wall: 'plaster', items: [['bed', 'wall', [2, 3], { size: [1, 2] }], ['chest', 'wall', [1, 2]], ['table', 'any', [0, 1]], ['chair', 'any', [1, 2]], ['candles', 'any', [1, 1]]] },
    nursery: { size: 'small', lit: false, floor: 'carpet', wall: 'wallpaper', items: [['bed', 'wall', [1, 1], { size: [1, 2] }], ['chest', 'wall', [1, 1]], ['rug', 'center', [1, 1], { size: [2, 2] }], ['dresser', 'wall', [0, 1]], ['scratches', 'floor', [0, 1]]] },
    conservatory: { size: 'large', lit: true, floor: 'tiles', wall: 'plaster', items: [['plant', 'wall', [4, 8]], ['flowers', 'any', [2, 3]], ['fountain', 'center', [0, 1]], ['statue', 'corner', [0, 2]], ['pew', 'any', [0, 2], { size: [2, 1] }]] },
    crypt: { size: 'medium', lit: false, floor: 'stone', wall: 'brick', items: [['coffin', 'wall', [2, 5]], ['altar', 'wall', [0, 1]], ['candles', 'any', [1, 2]], ['bones', 'floor', [1, 3]], ['skull', 'any', [1, 2]], ['web', 'corner', [1, 3]]] },
    throne_room: { size: 'huge', lit: true, floor: 'flag', wall: 'stoneblock', items: [['throne', 'wall', [1, 1]], ['rug', 'center', [1, 1], { runner: true }], ['pillar', 'wall', [2, 6]], ['banner', 'onwall', [2, 4]], ['brazier', 'corner', [2, 2]], ['statue', 'wall', [0, 2]]] },
    attic: { size: 'large', lit: false, floor: 'planks', wall: 'timber', items: [['crate', 'any', [2, 4]], ['chest', 'wall', [1, 2]], ['wardrobe', 'wall', [0, 1]], ['sack', 'any', [1, 2]], ['web', 'corner', [2, 4]], ['papers', 'floor', [0, 1]], ['bones', 'floor', [0, 1]]] },
    tavern: { size: 'large', lit: true, floor: 'planks', wall: 'timber', items: [['counter', 'wall', [1, 1], { size: [4, 1] }], ['table', 'any', [3, 5]], ['chair', 'any', [6, 10]], ['fireplace', 'onwall', [1, 1]], ['barrel', 'corner', [2, 3]], ['candles', 'any', [1, 2]]] },
    shop: { size: 'medium', lit: true, floor: 'planks', wall: 'timber', items: [['counter', 'wall', [1, 1], { size: [3, 1] }], ['cabinet', 'wall', [1, 2]], ['bookshelf', 'wall', [0, 1], { size: [2, 1] }], ['crate', 'corner', [1, 2]], ['barrel', 'corner', [1, 1]], ['sack', 'any', [0, 2]]] },
    vault: { size: 'small', lit: false, floor: 'stone', wall: 'stoneblock', items: [['chest', 'wall', [2, 4]], ['cabinet', 'wall', [0, 1]], ['crate', 'corner', [0, 1]]] },
    stable: { size: 'large', lit: true, floor: 'dirt', wall: 'timber', items: [['hay', 'wall', [2, 4]], ['trough', 'wall', [1, 2]], ['barrel', 'corner', [1, 1]], ['fence', 'any', [1, 2], { size: [3, 1] }], ['sack', 'any', [0, 1]]] },
    office: { size: 'small', lit: true, floor: 'parquet', wall: 'panel', items: [['desk', 'center', [1, 1], { size: [2, 1] }], ['chair', 'any', [2, 2]], ['cabinet', 'wall', [1, 2]], ['bookshelf', 'wall', [0, 1], { size: [2, 1] }], ['papers', 'floor', [0, 1]]] },
    cave: { size: 'large', lit: false, floor: 'rock', wall: 'rock', items: [['stalagmite', 'any', [2, 4]], ['boulder', 'any', [1, 2]], ['mushroom', 'any', [1, 3]], ['crystal', 'any', [0, 2]], ['bones', 'floor', [0, 2]]] },
    courtyard: { size: 'large', lit: true, floor: 'grass', wall: 'hedge', items: [['fountain', 'center', [0, 1]], ['statue', 'corner', [1, 2]], ['bush', 'any', [2, 4]], ['flowers', 'wall', [1, 3]], ['tombstone', 'any', [0, 0]]] },
    graveyard: { size: 'large', lit: false, floor: 'grass', wall: 'hedge', items: [['tombstone', 'any', [5, 9]], ['statue', 'any', [0, 1]], ['bush', 'any', [1, 2]], ['coffin', 'any', [0, 1]]] },
    room: { size: 'medium', lit: false, floor: 'planks', wall: 'plaster', items: [['table', 'any', [0, 1]], ['chair', 'any', [1, 2]], ['chest', 'wall', [0, 1]], ['crate', 'corner', [0, 2]], ['candles', 'any', [0, 1]]] },
};

/** Other words Claude may use for a room type. */
const ALIASES = {
    entrance: 'foyer', entrance_hall: 'foyer', hall: 'foyer', great_hall: 'throne_room', lobby: 'foyer', vestibule: 'foyer',
    corridor: 'hallway', passage: 'hallway', landing: 'hallway', stairwell: 'hallway', balcony: 'gallery', portrait_gallery: 'gallery',
    den: 'parlor', sitting_room: 'parlor', drawing_room: 'parlor', lounge: 'parlor', salon: 'parlor',
    guest_room: 'bedroom', bedchamber: 'bedroom', chamber: 'bedroom', quarters: 'servants_quarters', servants: 'servants_quarters', barracks: 'guard_room', guardroom: 'guard_room', guard_post: 'guard_room',
    dining_hall: 'dining_room', dining: 'dining_room', banquet_hall: 'dining_room', scullery: 'kitchen', larder: 'pantry',
    store_room: 'storage', storeroom: 'storage', closet: 'storage', basement: 'cellar', dungeon: 'torture_chamber', interrogation_room: 'torture_chamber', torture_room: 'torture_chamber',
    prison: 'cell', prison_cell: 'cell', jail: 'cell', cage_room: 'kennel', pet_room: 'kennel', menagerie: 'kennel', lab: 'laboratory', alchemy_lab: 'laboratory',
    forge: 'smithy', blacksmith: 'smithy', smithy_shop: 'smithy', armoury: 'armory', treasury: 'vault', bank: 'vault', strongroom: 'vault',
    shrine: 'chapel', temple: 'chapel', church: 'chapel', tomb: 'crypt', ossuary: 'crypt', mausoleum: 'crypt', catacomb: 'crypt',
    garden: 'courtyard', greenhouse: 'conservatory', inn: 'tavern', common_room: 'tavern', bar: 'tavern', store: 'shop', market: 'shop',
    cavern: 'cave', grotto: 'cave', master_suite: 'master_bedroom', master_bedroom_suite: 'master_bedroom', bath: 'bathroom', washroom: 'bathroom',
    trophy_hall: 'trophy_room', museum: 'gallery', music: 'music_room', ballroom_hall: 'ballroom', office_room: 'office', archive: 'library', archives: 'library',
};

export function roomType(type) {
    const key = String(type || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (RECIPES[key]) return key;
    if (ALIASES[key]) return ALIASES[key];
    const hit = Object.keys(RECIPES).find(k => key.includes(k)) ?? Object.keys(ALIASES).find(k => key.includes(k));
    return hit ? (RECIPES[hit] ? hit : ALIASES[hit]) : 'room';
}

export function recipeFor(type) {
    return RECIPES[roomType(type)] ?? RECIPES.room;
}

export { WALLPAPER_HUES, CARPET_HUES };
