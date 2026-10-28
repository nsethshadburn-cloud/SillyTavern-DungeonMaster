// Tied up, cuffed, caged, held: read from the DM's condition words ("restrained (rope)", "cuffed",
// "caged", "grappled"...). Decides what the figure shows on the map and whether someone can move
// themselves. Being restrained only stops you moving yourself: others can still drag or carry you.
// Cuffs (like D&D manacles) bind the hands only; ankle shackles and chains stop walking.

const CAGE = /\bcage/;
const ROPE = /\b(restrain|tied|bound\b|rope|entangl|webbed|netted)/;
const CUFFS = /\b(cuff|handcuff|manacle|shackl|irons\b)/;
const LOCK = /\b(restrain|tied|bound\b|rope|entangl|webbed|netted|grappl|grabbed|pinned|cage|shackl|chained|paraly|petrif|stun|unconscious|knocked out|asleep|incapacitat|can'?t walk|cannot walk|unable to walk|immobil|too (?:hurt|injured|weak|wounded)|dying|bedridden|carried)/;
/** Not held by anything: too hurt or out cold. Nobody "breaks free" of that; someone carries them. */
const HURT = /\b(unconscious|knocked out|asleep|incapacitat|can'?t walk|cannot walk|unable to walk|immobil|too (?:hurt|injured|weak|wounded)|dying|bedridden|carried|paraly|petrif|stun)/;

/**
 * What someone's conditions mean for the map: {locked, look, bound, caged, reason}.
 * look = the main one ('cage' | 'rope' | 'cuffs' | null); bound = what's on the figure itself
 * ('rope' | 'cuffs' | null; someone can be tied up inside a cage); caged = bars around them.
 */
export function restraintOf(conditions = []) {
    const list = (Array.isArray(conditions) ? conditions : []).map(c => String(c || '').toLowerCase().trim()).filter(Boolean);
    const find = re => list.find(t => re.test(t)) ?? null;
    const caged = Boolean(find(CAGE));
    const bound = find(ROPE) ? 'rope' : find(CUFFS) ? 'cuffs' : null;
    const reason = find(LOCK);
    return { locked: Boolean(reason), look: caged ? 'cage' : bound, bound, caged, reason, hurt: Boolean(reason && HURT.test(reason) && !caged && !bound) };
}

/** A short "why you can't move" line for the player. */
export function lockedLine(name, r) {
    if (r.hurt) return `${name} is ${r.reason} and can't walk. Someone can carry them: tell the DM.`;
    const what = r.look === 'cage' ? 'locked in a cage' : r.look === 'rope' ? 'tied up' : /grappl|grabbed|pinned|held/.test(r.reason) ? 'being held' : r.reason;
    return `${name} is ${what} and can't move. Tap ${name} on the map to try to get free.`;
}

/** Ways to try to get free, for the tap menu on yourself: [label, icon, what the player does]. */
export function escapeOptions(name, r) {
    if (!r.locked && r.look !== 'cuffs') return [['Search for traps', 'fa-magnifying-glass', `*${name} carefully searches the room for traps.* (Perception)`]];
    if (r.hurt) return [];
    const out = [];
    if (r.look === 'cage') {
        out.push(['Pick the lock', 'fa-key', `*${name} works at the cage's lock.* (Sleight of Hand with thieves' tools)`]);
        out.push(['Force the bars', 'fa-hand-fist', `*${name} throws their weight against the cage bars.* (Athletics)`]);
    } else if (r.look === 'cuffs') {
        out.push(['Slip the cuffs', 'fa-hand', `*${name} twists, trying to slip out of the cuffs.* (Acrobatics)`]);
        out.push(['Pick the cuffs', 'fa-key', `*${name} works at the cuffs' lock.* (Sleight of Hand)`]);
    } else {
        out.push(['Struggle free', 'fa-hand-fist', `*${name} strains against the bonds.* (Athletics)`]);
        out.push(['Slip free', 'fa-hand', `*${name} wriggles, trying to slip free.* (Acrobatics)`]);
    }
    return out;
}
