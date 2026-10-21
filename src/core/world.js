// World state, NPC roster, combat and character-sheet lookups. Pure module.

import { abilityModifier, roll } from './dice.js';
import { nameKey, matchName } from './text.js';

export function createWorldState() {
    return {
        location: '',
        setting: 'any',
        time: 'morning',
        day: 1,
        gold: 0,
        items: [],
        party: {},        // name -> {hp, hp_max, conditions: []}
        flags: {},
        combat: null,     // {round, order: [{name, init}], enemies: {name: {hp, hp_max, ac}}}
        away: {},         // companion name -> where they are (split off from the player)
    };
}

/**
 * Companions who split off from the player: name -> where they are. They can't hear or speak
 * until they rejoin. The DM reports it with "party_away" / "party_back".
 */
export function applyPresence(world, partyNames, away = {}, back = []) {
    world.away ??= {};
    for (const [name, where] of Object.entries(away ?? {})) {
        const match = partyNames.find(p => p.toLowerCase() === String(name).toLowerCase());
        if (match) world.away[match] = String(where || 'elsewhere').slice(0, 120);
    }
    for (const name of back ?? []) {
        const match = Object.keys(world.away).find(p => p.toLowerCase() === String(name).toLowerCase());
        if (match) delete world.away[match];
    }
    return world.away;
}

/** Is this party member away from the player right now? */
export function isAway(world, name) {
    return Object.keys(world?.away ?? {}).some(p => p.toLowerCase() === String(name).toLowerCase());
}

/** Make sure every party member (incl. the player) has an HP entry. */
export function ensureParty(world, members) {
    for (const m of members) {
        if (!m?.name) continue;
        const existing = world.party[m.name];
        const sheetMax = Number(m.hp_max) || 0;
        const max = sheetMax || existing?.hp_max || 10;
        if (!existing) world.party[m.name] = { hp: max, hp_max: max, conditions: [] };
        else if (sheetMax && existing.hp_max !== sheetMax) {
            // A sheet arrived or changed: shift current HP by the same amount as the max.
            const delta = sheetMax - (Number(existing.hp_max) || 0);
            existing.hp_max = sheetMax;
            existing.hp = Math.max(0, Math.min(sheetMax, (Number(existing.hp) || 0) + delta));
        }
    }
}

/**
 * Apply the DM's state_changes. Returns a list of human-readable change lines.
 */
export function applyStateChanges(world, changes, knownNames = []) {
    const log = [];
    if (!changes || typeof changes !== 'object') return log;
    const names = [...new Set([...Object.keys(world.party), ...Object.keys(world.combat?.enemies ?? {}), ...knownNames])];

    if (changes.hp && typeof changes.hp === 'object') {
        for (const [who, delta] of Object.entries(changes.hp)) {
            const d = Number(delta);
            if (!Number.isFinite(d) || d === 0) continue;
            const line = changeHp(world, who, d, names);
            if (line) log.push(line);
        }
    }
    for (const [key, add] of [['conditions_add', true], ['conditions_remove', false]]) {
        const map = changes[key];
        if (!map || typeof map !== 'object') continue;
        for (const [who, conds] of Object.entries(map)) {
            const target = resolveCreature(world, who, names);
            if (!target) continue;
            const list = (Array.isArray(conds) ? conds : [conds]).map(String).filter(Boolean);
            target.ref.conditions = target.ref.conditions || [];
            for (const c of list) {
                const has = target.ref.conditions.some(x => x.toLowerCase() === c.toLowerCase());
                if (add && !has) target.ref.conditions.push(c);
                if (!add && has) target.ref.conditions = target.ref.conditions.filter(x => x.toLowerCase() !== c.toLowerCase());
            }
            log.push(`${target.name}: ${add ? '+' : '−'}${list.join(', ')}`);
        }
    }
    const gold = Number(changes.gold);
    if (Number.isFinite(gold) && gold !== 0) {
        world.gold = Math.max(0, (Number(world.gold) || 0) + gold);
        log.push(`Gold ${gold > 0 ? '+' : ''}${gold} (now ${world.gold})`);
    }
    for (const item of arrayOf(changes.items_add)) {
        world.items.push(String(item));
        log.push(`+ ${item}`);
    }
    for (const item of arrayOf(changes.items_remove)) {
        const idx = world.items.findIndex(x => nameKey(x) === nameKey(item));
        if (idx !== -1) {
            world.items.splice(idx, 1);
            log.push(`− ${item}`);
        }
    }
    if (changes.flags && typeof changes.flags === 'object') {
        for (const [k, v] of Object.entries(changes.flags)) {
            if (v === null || v === false || v === '') delete world.flags[k];
            else world.flags[k] = v;
        }
    }
    return log;
}

export function changeHp(world, who, delta, names = []) {
    const target = resolveCreature(world, who, names);
    if (!target) return null;
    const ref = target.ref;
    const before = Number(ref.hp) || 0;
    ref.hp = Math.max(0, Math.min(Number(ref.hp_max) || before + Math.max(0, delta), before + delta));
    let line = `${target.name} HP ${before} → ${ref.hp}${ref.hp_max ? `/${ref.hp_max}` : ''}`;
    if (ref.hp === 0) line += target.isEnemy ? ' (down)' : ' (unconscious!)';
    return line;
}

function resolveCreature(world, who, names) {
    const enemies = world.combat?.enemies ?? {};
    const partyName = matchName(who, Object.keys(world.party));
    if (partyName) return { name: partyName, ref: world.party[partyName], isEnemy: false };
    const enemyName = matchName(who, Object.keys(enemies));
    if (enemyName) return { name: enemyName, ref: enemies[enemyName], isEnemy: true };
    return null;
}

/** Flags used by event prerequisites. */
export function worldFlags(world) {
    const flags = new Set(Object.keys(world.flags || {}).filter(k => world.flags[k]));
    const time = String(world.time || '').toLowerCase();
    if (/night|evening|dusk|midnight/.test(time)) flags.add('night');
    else flags.add('day');
    if ((Number(world.gold) || 0) > 0) flags.add('has_gold');
    if (Object.values(world.party || {}).some(p => p.hp_max && p.hp < p.hp_max * 0.6)) flags.add('injured');
    if (world.items?.some(i => /\b(horse|mount|pony|wagon|cart|mule)\b/i.test(i))) flags.add('has_mounts');
    return flags;
}

// ---------- NPC roster ----------

export function addNpcs(roster, newNpcs, scene = '') {
    const added = [];
    for (const npc of newNpcs || []) {
        if (!npc?.name) continue;
        const existing = roster.find(n => nameKey(n.name) === nameKey(npc.name));
        if (existing) {
            if (npc.description) existing.description = npc.description;
            if (npc.attitude) existing.attitude = npc.attitude;
            if (npc.stats) existing.stats = npc.stats;
            existing.lastSeen = scene || existing.lastSeen;
            continue;
        }
        const entry = {
            name: npc.name,
            description: npc.description || '',
            gender: npc.gender || 'any',
            attitude: npc.attitude || 'neutral',
            stats: npc.stats || '',
            voice: '',
            firstSeen: scene,
            lastSeen: scene,
        };
        roster.push(entry);
        added.push(entry);
    }
    return added;
}

export function rosterSummary(roster, max = 30) {
    return roster.slice(-max).map(n => `- ${n.name} (${n.attitude}${n.lastSeen ? `, last seen: ${n.lastSeen}` : ''}): ${n.description}${n.stats ? ` [${n.stats}]` : ''}`).join('\n');
}

// ---------- Character sheets ----------

const SKILL_ABILITY = {
    'acrobatics': 'DEX', 'animal handling': 'WIS', 'arcana': 'INT', 'athletics': 'STR', 'deception': 'CHA',
    'history': 'INT', 'insight': 'WIS', 'intimidation': 'CHA', 'investigation': 'INT', 'medicine': 'WIS',
    'nature': 'INT', 'perception': 'WIS', 'performance': 'CHA', 'persuasion': 'CHA', 'religion': 'INT',
    'sleight of hand': 'DEX', 'stealth': 'DEX', 'survival': 'WIS',
};

const ABILITY_ALIASES = {
    str: 'STR', strength: 'STR', dex: 'DEX', dexterity: 'DEX', con: 'CON', constitution: 'CON',
    int: 'INT', intelligence: 'INT', wis: 'WIS', wisdom: 'WIS', cha: 'CHA', charisma: 'CHA',
};

/**
 * Find the modifier for a roll request from a sheet's stats.
 * @param {object|null} stats sheet stats JSON
 * @param {{kind:string, skill:string, ability:string}} req
 * @returns {{mod:number, source:string}}
 */
export function lookupModifier(stats, req) {
    if (!stats) return { mod: 0, source: 'no sheet' };
    const skill = String(req.skill || '').toLowerCase().trim();
    const abilityKey = ABILITY_ALIASES[String(req.ability || '').toLowerCase()] || null;

    if (req.kind === 'initiative' || skill === 'initiative') {
        if (Number.isFinite(Number(stats.initiative))) return { mod: Number(stats.initiative), source: 'initiative' };
        return { mod: abilityModifier(stats.abilities?.DEX), source: 'DEX' };
    }
    if (req.kind === 'attack') {
        const atk = (stats.attacks || []).find(a => a.name && skill.includes(String(a.name).toLowerCase())) || (stats.attacks || [])[0];
        if (atk && Number.isFinite(Number(atk.to_hit))) return { mod: Number(atk.to_hit), source: atk.name || 'attack' };
    }
    if (req.kind === 'save' || /\bsav(e|ing)\b/.test(skill)) {
        const ab = abilityKey || ABILITY_ALIASES[skill.split(/\s+/)[0]];
        if (ab && Number.isFinite(Number(stats.saves?.[ab]))) return { mod: Number(stats.saves[ab]), source: `${ab} save` };
        if (ab) return { mod: abilityModifier(stats.abilities?.[ab]), source: `${ab} save` };
    }
    // Skills (case-insensitive key match).
    const skills = stats.skills || {};
    const skillKey = Object.keys(skills).find(k => k.toLowerCase() === skill);
    if (skillKey && Number.isFinite(Number(skills[skillKey]))) return { mod: Number(skills[skillKey]), source: skillKey };
    // Unlisted skill: fall back to its ability.
    const ab = abilityKey || SKILL_ABILITY[skill] || ABILITY_ALIASES[skill];
    if (ab && stats.abilities?.[ab] !== undefined) return { mod: abilityModifier(stats.abilities[ab]), source: ab };
    return { mod: 0, source: 'flat' };
}

// ---------- Combat ----------

/**
 * Start combat: roll initiative for party members (from sheets) and enemies.
 * The player's own initiative is NOT rolled here; they roll it themselves.
 * @param {object} world
 * @param {{enemies:Array<{name:string, ac:number, hp:number, dex:number}>}} start
 * @param {Array<{name:string, stats:object|null}>} companions party members other than the player
 */
export function startCombat(world, start, companions, rng) {
    const enemies = {};
    const order = [];
    for (const e of start.enemies || []) {
        enemies[e.name] = { hp: e.hp, hp_max: e.hp, ac: e.ac, conditions: [] };
        const r = roll(`1d20${e.dex >= 0 ? '+' : ''}${e.dex}`, { rng });
        order.push({ name: e.name, init: r?.total ?? 10, detail: r?.detail ?? '' });
    }
    for (const c of companions) {
        const mod = lookupModifier(c.stats, { kind: 'initiative', skill: 'initiative', ability: 'DEX' }).mod;
        const r = roll(`1d20${mod >= 0 ? '+' : ''}${mod}`, { rng });
        order.push({ name: c.name, init: r?.total ?? 10, detail: r?.detail ?? '' });
    }
    world.combat = { round: 1, order, enemies };
    sortInitiative(world.combat);
    return world.combat;
}

export function addToInitiative(world, name, total) {
    if (!world.combat) return;
    world.combat.order = world.combat.order.filter(o => o.name !== name);
    world.combat.order.push({ name, init: total, detail: 'player roll' });
    sortInitiative(world.combat);
}

function sortInitiative(combat) {
    combat.order.sort((a, b) => b.init - a.init);
}

export function endCombat(world) {
    world.combat = null;
}

export function combatSummary(world) {
    if (!world.combat) return 'Not in combat.';
    const lines = [`Round ${world.combat.round}. Initiative: ${world.combat.order.map(o => `${o.name} ${o.init}`).join(', ')}.`];
    const enemies = Object.entries(world.combat.enemies);
    if (enemies.length) {
        lines.push('Enemies: ' + enemies.map(([n, e]) => `${n} HP ${e.hp}/${e.hp_max} AC ${e.ac}${e.conditions?.length ? ` (${e.conditions.join(', ')})` : ''}`).join('; ') + '.');
    }
    return lines.join('\n');
}

function arrayOf(v) {
    if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined && x !== '');
    if (v === null || v === undefined || v === '') return [];
    return [v];
}
