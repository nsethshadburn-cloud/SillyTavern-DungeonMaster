// World state, NPC roster, combat and character-sheet lookups. Pure module.

import { abilityModifier, roll } from './dice.js';
import { nameKey, matchName } from './text.js';
import { parseCondition, defaultUntil, noteUntil, forgetUntil, hurtWhileDown, clearDeath } from './upkeep.js';
import { weatherFlags } from './clock.js';

export function createWorldState() {
    return {
        location: '',
        setting: 'any',
        time: 'morning',  // the time of day in a word (kept in step with the clock)
        day: 1,
        clock: null,      // {day, minutes since midnight} (see core/clock.js); made from `time` the first time it's needed
        weather: 'clear', // clear | overcast | rain | storm | fog | snow | wind
        gold: 0,
        items: [],
        party: {},        // name -> {hp, hp_max, conditions: []}
        flags: {},
        combat: null,     // {round, order: [{name, init}], enemies: {name: {hp, hp_max, ac}}}
        away: {},         // companion name -> where they are (split off from the player)
        sceneCard: null,  // {place, people: {name: body/position}, objects: {name: look}} (see state.js)
        place: null,      // {key, floor} while the party is inside a mapped place (see st/atlas.js)
        others: {},       // name -> {conditions: []} for NPCs outside a fight (a tied-up prisoner)
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

/** Turns a lingering condition stays off after it ends (outside fights), so a stale mention can't bring it back. */
export const CONDITION_SETTLE = 6;
/** Conditions that really can come and go quickly (tied up again, knocked down again): never held. */
const QUICK_CONDITIONS = /restrain|tied|bound|grappl|cuff|shackl|cage|prone|unconscious|asleep|sleep|hidden|invisible/i;

/**
 * Apply the DM's state_changes. Returns a list of human-readable change lines.
 */
export function applyStateChanges(world, changes, knownNames = [], { turn = null } = {}) {
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
            const target = resolveCreature(world, who, names) ?? otherCreature(world, who);
            if (!target) continue;
            // "poisoned (1 hour)": the condition, and how long it lasts (a sensible default if not said).
            const parsed = (Array.isArray(conds) ? conds : [conds]).filter(Boolean).map(parseCondition).filter(p => p.name);
            const list = parsed.map(p => p.name);
            target.ref.conditions = target.ref.conditions || [];
            const changed = [], held = [];
            for (const [i, c] of list.entries()) {
                const has = target.ref.conditions.some(x => x.toLowerCase() === c.toLowerCase());
                if (add && (has || turn !== null)) noteUntil(world, target.name, c, parsed[i].until ?? defaultUntil(c, Boolean(world.combat)), { turn: turn ?? 0, round: world.combat?.round ?? null });
                if (!add && has) forgetUntil(world, target.name, c);
                if (add === has) continue;
                // Steady conditions: outside a fight, a lingering one (groggy, poisoned, frightened) taken
                // off in the last few turns isn't put back by a stale mention; it used to flicker on and off.
                const k = `${target.name.toLowerCase()}|${c.toLowerCase()}`;
                const last = world.condTurns?.[k];
                if (turn !== null && !world.combat && add && last && !last.add && turn - last.turn < CONDITION_SETTLE && !QUICK_CONDITIONS.test(c)) { held.push(c); continue; }
                if (add) target.ref.conditions.push(c);
                else target.ref.conditions = target.ref.conditions.filter(x => x.toLowerCase() !== c.toLowerCase());
                if (turn !== null) { world.condTurns ??= {}; world.condTurns[k] = { turn, add }; }
                changed.push(c);
            }
            if (changed.length) log.push(`${target.name}: ${add ? '+' : '−'}${changed.join(', ')}`);
            if (held.length) log.push(`${target.name}: not ${held.join(', ')} again (it only just wore off)`);
        }
    }
    const gold = Number(changes.gold);
    if (Number.isFinite(gold) && gold !== 0) {
        world.gold = Math.max(0, (Number(world.gold) || 0) + gold);
        log.push(`Gold ${gold > 0 ? '+' : ''}${gold} (now ${world.gold})`);
    }
    const owners = [...new Set([...Object.keys(world.party), ...knownNames])];
    const packOf = who => {
        const name = matchName(who, owners);
        if (!name) return null;
        world.inventory ??= {};
        return { name, list: (world.inventory[name] ??= []) };
    };
    const byOwner = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [[null, v]]);
    for (const [who, items] of byOwner(changes.items_add)) {
        const pack = who ? packOf(who) : null;
        for (const item of arrayOf(items)) {
            (pack?.list ?? world.items).push(String(item));
            log.push(`+ ${item}${pack ? ` (${pack.name})` : ''}`);
        }
    }
    for (const [who, items] of byOwner(changes.items_remove)) {
        const pack = who ? packOf(who) : null;
        for (const item of arrayOf(items)) {
            // From whoever has it: the named person, else the shared pack, else anyone.
            const lists = [pack?.list, world.items, ...Object.values(world.inventory ?? {})].filter(Boolean);
            const from = lists.find(l => l.some(x => nameKey(x) === nameKey(item)));
            if (!from) continue;
            from.splice(from.findIndex(x => nameKey(x) === nameKey(item)), 1);
            log.push(`− ${item}${pack ? ` (${pack.name})` : ''}`);
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

export function changeHp(world, who, delta, names = [], { critical = false } = {}) {
    const target = resolveCreature(world, who, names);
    if (!target) return null;
    const ref = target.ref;
    const before = Number(ref.hp) || 0;
    ref.hp = Math.max(0, Math.min(Number(ref.hp_max) || before + Math.max(0, delta), before + delta));
    let line = `${target.name} HP ${before} → ${ref.hp}${ref.hp_max ? `/${ref.hp_max}` : ''}`;
    // Dying: a hit while already down is a failed death save; damage past 0 of their whole HP kills.
    if (!target.isEnemy && delta < 0) {
        const overflow = before > 0 ? -(before + delta) : -delta;
        const down = before > 0 ? (overflow >= (Number(ref.hp_max) || 1) ? hurtWhileDown(world, target.name, overflow) : '') : hurtWhileDown(world, target.name, -delta, { critical });
        if (down) return `${line} · ${down}`;
    }
    if (!target.isEnemy && delta > 0 && ref.hp > 0) clearDeath(world, target.name);
    if (ref.hp === 0) line += target.isEnemy ? ' (down)' : ' (unconscious!)';
    if (!target.isEnemy) {
        ref.conditions = ref.conditions || [];
        const out = ref.conditions.some(c => /^unconscious$/i.test(c));
        if (ref.hp === 0 && !out) ref.conditions.push('unconscious');
        if (ref.hp > 0 && before === 0 && out) { ref.conditions = ref.conditions.filter(c => !/^unconscious$/i.test(c)); line += ' (conscious again)'; }
    }
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

/** Anyone else (an NPC outside a fight): a place to keep their conditions. */
function otherCreature(world, who) {
    const name = String(who || '').trim().slice(0, 60);
    if (!name) return null;
    world.others ??= {};
    const key = matchName(name, Object.keys(world.others)) ?? name;
    world.others[key] ??= { conditions: [] };
    return { name: key, ref: world.others[key], isEnemy: false };
}

/** Someone's conditions, whoever they are (party, enemy, or anyone else). */
export function conditionsOf(world, name) {
    const pick = obj => obj?.[matchName(name, Object.keys(obj || {})) ?? '']?.conditions;
    return pick(world.party) ?? pick(world.combat?.enemies) ?? pick(world.others) ?? [];
}

/** Flags used by event prerequisites. */
export function worldFlags(world) {
    const flags = new Set(Object.keys(world.flags || {}).filter(k => world.flags[k]));
    const time = String(world.time || '').toLowerCase();
    if (/night|evening|dusk|midnight/.test(time)) flags.add('night');
    else flags.add('day');
    if (/dawn|morning|afternoon|evening/.test(time)) flags.add(time);
    for (const f of weatherFlags(world.weather)) flags.add(f);
    if ((Number(world.gold) || 0) > 0) flags.add('has_gold');
    if (Object.values(world.party || {}).some(p => p.hp_max && p.hp < p.hp_max * 0.6)) flags.add('injured');
    if (world.items?.some(i => /\b(horse|mount|pony|wagon|cart|mule)\b/i.test(i))) flags.add('has_mounts');
    return flags;
}

/** Dark outside: evening, dusk, night. */
export function isNight(time) {
    return /night|midnight|dusk|evening|late/i.test(String(time || ''));
}

/** Deep night: lived-in places are asleep and shut. */
export function isLate(time) {
    const t = String(time || '');
    return /night|midnight|late/i.test(t) && !/evening/i.test(t);
}

// ---------- NPC roster ----------

/** Two location names mean the same place: the same words, or one inside the other ("Blackmoor Prison" ~ "Blackmoor Prison, cell block"). */
export function sameLocation(a, b) {
    const x = nameKey(a), y = nameKey(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

/** Is this NPC here right now: alive, and last seen where the party is (loosely matched)? With no location known, everyone counts. */
export function isHere(npc, location) {
    if (!npc || npc.dead) return false;
    return !location || sameLocation(npc.lastSeen, location);
}

export function addNpcs(roster, newNpcs, scene = '') {
    const added = [];
    for (const npc of newNpcs || []) {
        if (!npc?.name) continue;
        const existing = roster.find(n => nameKey(n.name) === nameKey(npc.name));
        if (existing) {
            if (npc.description) existing.description = npc.description;
            if (npc.role) existing.role = npc.role;
            if (npc.sprite) existing.sprite = npc.sprite;
            if (npc.attitude) existing.attitude = npc.attitude;
            if (npc.stats) existing.stats = npc.stats;
            existing.lastSeen = scene || existing.lastSeen;
            continue;
        }
        const entry = {
            name: npc.name,
            description: npc.description || '',
            role: npc.role || '',
            sprite: npc.sprite || '',
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
    // Skills, then tools (loose key match: "Thieves Tools" = "Thieves' Tools").
    const loose = s => String(s).toLowerCase().replace(/[^a-z]+/g, '');
    for (const group of [stats.skills, stats.tools]) {
        const list = group && typeof group === 'object' ? group : {};
        const key = Object.keys(list).find(k => loose(k) === loose(skill));
        if (key && Number.isFinite(Number(list[key]))) return { mod: Number(list[key]), source: key };
    }
    // The DM read the bonus off the sheet (a tool or feature the stats have no number for).
    if (req.bonus !== null && req.bonus !== undefined && Number.isFinite(Number(req.bonus))) return { mod: Number(req.bonus), source: 'sheet' };
    // Unlisted skill: fall back to its ability.
    const ab = abilityKey || SKILL_ABILITY[skill] || ABILITY_ALIASES[skill];
    if (ab && stats.abilities?.[ab] !== undefined) return { mod: abilityModifier(stats.abilities[ab]), source: ab };
    return { mod: 0, source: 'flat' };
}

/**
 * The damage dice for one of someone's sheet attacks, when the DM asked for a damage roll without
 * saying what to roll: the attack named in `hint` (the roll's reason), else their first attack; the
 * dice doubled on a critical hit ("1d4+5" -> "2d4+5"). '' when the sheet has none.
 */
export function attackDamage(stats, hint = '', { critical = false } = {}) {
    const attacks = Array.isArray(stats?.attacks) ? stats.attacks.filter(a => a && a.damage) : [];
    if (!attacks.length) return '';
    const h = String(hint || '').toLowerCase();
    const atk = attacks.find(a => a.name && h.includes(String(a.name).toLowerCase())) ?? attacks[0];
    let dmg = String(atk.damage).trim();
    if (critical) dmg = dmg.replace(/(\d*)d(\d+)/gi, (m, n, s) => `${(Number(n) || 1) * 2}d${s}`);
    return dmg;
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
        enemies[e.name] = { hp: e.hp, hp_max: e.hp, ac: e.ac, conditions: [], ...(e.sprite ? { sprite: e.sprite } : {}), ...(e.damage ? { damage: e.damage } : {}) };
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

/**
 * Movement in a fight, per round: squares used so far, the round's allowance (speed, doubled by a
 * Dash this round), and what's left. The code stops anyone at their allowance, however many
 * messages their turn takes.
 */
export function moveBudget(world, name, speed = 6) {
    const cb = world?.combat;
    if (!cb) return { max: speed, used: 0, left: speed, dashing: false };
    const dashing = cb.dash?.[name] === (cb.round || 1);
    const max = speed * (dashing ? 2 : 1);
    const used = cb.moved?.[name] ?? 0;
    return { max, used, left: Math.max(0, max - used), dashing };
}

/** Squares spent this round. */
export function spendMove(world, name, squares) {
    const cb = world?.combat;
    if (!cb || !(squares > 0)) return;
    cb.moved ??= {};
    cb.moved[name] = (cb.moved[name] ?? 0) + squares;
}

/** A Dash this round: the allowance doubles for it. */
export function markDash(world, name) {
    const cb = world?.combat;
    if (!cb) return;
    cb.dash ??= {};
    cb.dash[name] = cb.round || 1;
}

/** The next round: everyone's movement starts over. */
export function newRound(world) {
    const cb = world?.combat;
    if (!cb) return;
    cb.round = (cb.round || 1) + 1;
    cb.moved = {};
}

export function combatSummary(world, player = '') {
    if (!world.combat) return 'Not in combat.';
    const lines = [`Round ${world.combat.round}. Initiative: ${world.combat.order.map(o => `${o.name} ${o.init}`).join(', ')}.`];
    const at = world.combat.order.findIndex(o => o.name === player);
    if (player && at < 0) lines.push(`WAITING for ${player}'s initiative roll: nobody acts yet. Ask for it (player_roll kind "initiative") if it isn't already asked.`);
    else if (player) {
        const before = world.combat.order.slice(0, at).map(o => o.name), after = world.combat.order.slice(at + 1).map(o => o.name);
        lines.push(`Order around the player: ${before.length ? before.join(', ') : 'nobody'} act before ${player}; ${after.length ? after.join(', ') : 'nobody'} after. Act only for those whose turn it is, then stop at ${player}'s turn.`);
        if (world.combat.phase === 'player') lines.push(`${player}'S TURN IS IN PROGRESS: resolve only what ${player} does; nobody else acts, moves or rolls until the code says the turn has ended.`);
        else if (world.combat.phase === 'others') lines.push(`${player} has ended their turn: those after ${player} act, then the next round from the top down to ${player}, then stop.`);
    }
    const enemies = Object.entries(world.combat.enemies);
    if (enemies.length) {
        lines.push('Enemies: ' + enemies.map(([n, e]) => `${n} HP ${e.hp}/${e.hp_max} AC ${e.ac}${e.conditions?.length ? ` (${e.conditions.join(', ')})` : ''}`).join('; ') + '.');
    }
    const moved = Object.entries(world.combat.speed ?? {}).map(([n, sp]) => { const b = moveBudget(world, n, sp); return `${n} ${b.used}/${b.max}${b.dashing ? ' (dashing)' : ''}`; });
    if (moved.length) lines.push(`Movement this round, squares used/allowed (the code stops each of them at their allowance, over all their messages this round; "dashing" doubles it): ${moved.join('; ')}.`);
    return lines.join('\n');
}

function arrayOf(v) {
    if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined && x !== '');
    if (v === null || v === undefined || v === '') return [];
    return [v];
}

// ---------- who has noticed whom ----------

/** Record a sighting (or that someone stayed unseen): world.aware = {watcher: [who they've seen]}. */
export function noteSeen(world, seer, seen, yes) {
    const a = String(seer || '').trim(), b = String(seen || '').trim();
    if (!a || !b) return;
    world.aware ??= {};
    const key = Object.keys(world.aware).find(k => k.toLowerCase() === a.toLowerCase()) ?? a;
    const list = (world.aware[key] ?? []).filter(n => n.toLowerCase() !== b.toLowerCase());
    if (yes) list.push(b);
    if (list.length) world.aware[key] = list; else delete world.aware[key];
}

/** The DM's "noticed" field: {watcher: [names]} replaces what that watcher has seen ([] = lost track of everyone). */
export function applyNoticed(world, noticed) {
    const log = [];
    for (const [seer, raw] of Object.entries(noticed && typeof noticed === 'object' ? noticed : {})) {
        const names = arrayOf(raw).map(String).filter(n => !/^(none|nobody|no one)$/i.test(n));
        world.aware ??= {};
        const key = Object.keys(world.aware).find(k => k.toLowerCase() === seer.toLowerCase()) ?? seer;
        if (names.length) world.aware[key] = [...new Set(names)]; else delete world.aware[key];
        log.push(names.length ? `${seer} has seen ${names.join(', ')}` : `${seer} has seen nobody`);
    }
    return log;
}

/** Who has noticed whom, for the DM. */
export function awareSummary(world) {
    const rows = Object.entries(world.aware ?? {}).filter(([, l]) => l?.length);
    return rows.length ? rows.map(([k, l]) => `${k} has seen ${l.join(', ')}`).join('; ') + '. Everyone else is unaware of the party.' : '';
}
