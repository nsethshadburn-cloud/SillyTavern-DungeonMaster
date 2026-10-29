// Upkeep: the bookkeeping D&D does between and during turns, done in code so it never depends on
// the DM remembering. Conditions wear off (a duration the DM gives, or a sensible default); rests
// restore HP, hit dice, spell slots and abilities and end what a rest ends; spell slots and limited
// abilities are spent and counted; someone at 0 HP makes death saving throws. Pure module.

import { matchName } from './text.js';

// ---------- conditions that wear off ----------

/** Conditions that only last a fight (or a minute or so). */
const BRIEF = /^(frightened|charmed|stunned|dazed|blinded|deafened|incapacitated|paralyzed|paralysed|slowed|hasted|blessed|baned|confused|reeling|winded|staggered|off balance)$/i;
/** Lingering ones that a long rest clears (or that fade over a good while). */
const LINGERING = /^(poisoned|groggy|sick|nauseous|nauseated|drunk|tipsy|hungover|dizzy|weakened|shaken|feverish|bleeding|sore|tired|drowsy|drained|cold|soaked|burned|singed)$/i;
/** Turns that "a while" outside a fight lasts when there is no clock to go by: a player turn is a few minutes of story. */
const TURNS_PER_HOUR = 6;
const MINUTES_PER_TURN = 10;

/** The world's clock as one number (minutes since the campaign's day 1), or null without a clock. */
function clockNow(world) {
    const c = world?.clock;
    return c && Number.isFinite(c.minutes) ? (Number(c.day) || 1) * 1440 + c.minutes : null;
}

/**
 * A condition as the DM wrote it, with an optional duration: "poisoned (1 hour)", "frightened
 * (until the end of the fight)", "groggy (until a long rest)", "stunned (1 round)", or
 * {name, until}. Returns {name, until} where until is {turns} | {rest} | {combat} | null.
 */
export function parseCondition(raw) {
    const obj = raw && typeof raw === 'object' ? raw : null;
    const text = String(obj ? obj.name ?? '' : raw ?? '').trim();
    const m = /^(.*?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(text);
    // Brackets are a duration only when they say one: "restrained (rope)" is a kind of restraint, kept whole.
    if (obj) return { name: text, until: untilFrom(obj.until ?? obj.duration ?? '') };
    const until = m ? untilFrom(m[2]) : null;
    return until ? { name: m[1].trim(), until } : { name: text, until: null };
}

/** A duration in words, as a rule the code can check. */
export function untilFrom(spec) {
    const s = String(spec || '').toLowerCase();
    if (!s) return null;
    if (/long rest/.test(s)) return { rest: 'long' };
    if (/short rest|any rest|a rest/.test(s)) return { rest: 'short' };
    if (/fight|combat|battle|encounter/.test(s)) return { combat: true };
    const n = Number((/(\d+)/.exec(s) || [])[1]) || 1;
    if (/round|turn of combat/.test(s)) return { rounds: n };
    if (/minute/.test(s)) return { minutes: n };
    if (/hour/.test(s)) return { minutes: n * 60 };
    if (/day|dawn|morning|tomorrow/.test(s)) return { rest: 'long' };
    if (/turn/.test(s)) return { turns: n };
    return null;
}

/** When a condition ends if nobody said: brief ones with the fight (or a few turns), lingering ones with a long rest. */
export function defaultUntil(name, inCombat = false) {
    const n = String(name || '').trim();
    if (BRIEF.test(n)) return inCombat ? { combat: true } : { turns: 3 };
    if (LINGERING.test(n)) return { rest: 'long', minutes: 4 * 60 };
    if (/^exhaust/i.test(n)) return { rest: 'long' };
    return null; // tied up, unconscious, caged, cursed: until something in the story ends it
}

/**
 * Remember when a condition someone just got ends. world.condUntil["name|cond"] =
 * {turn (expires at that player turn), round (in a fight), rest, combat}.
 */
export function noteUntil(world, who, cond, until, { turn = 0, round = null, now = clockNow(world) } = {}) {
    world.condUntil ??= {};
    const k = `${String(who).toLowerCase()}|${String(cond).toLowerCase()}`;
    if (!until) { delete world.condUntil[k]; return; }
    const rec = {};
    if (until.turns) rec.turn = turn + until.turns;
    // Hours and minutes go by the world's clock (a night's sleep or a time skip ages them); in turns only without one.
    if (until.minutes) { if (now !== null) rec.minute = now + until.minutes; else rec.turn = turn + Math.max(1, Math.ceil(until.minutes / MINUTES_PER_TURN)); }
    if (until.rounds) { if (round !== null) rec.round = round + until.rounds; else rec.turn = turn + 1; }
    if (until.rest) rec.rest = until.rest;
    if (until.combat) rec.combat = true;
    world.condUntil[k] = rec;
}

/** Forget a condition's duration (it was removed). */
export function forgetUntil(world, who, cond) {
    if (world.condUntil) delete world.condUntil[`${String(who).toLowerCase()}|${String(cond).toLowerCase()}`];
}

/** "until a long rest", "for 2 more turns": how long a condition has left, for the DM. */
export function untilWords(world, who, cond, { turn = 0, round = null, now = clockNow(world) } = {}) {
    const rec = world.condUntil?.[`${String(who).toLowerCase()}|${String(cond).toLowerCase()}`];
    if (!rec) return '';
    const bits = [];
    if (rec.round !== undefined && round !== null) bits.push(`${Math.max(0, rec.round - round)} more round${rec.round - round === 1 ? '' : 's'}`);
    if (rec.turn !== undefined) bits.push(`${Math.max(0, rec.turn - turn)} more turn${rec.turn - turn === 1 ? '' : 's'}`);
    if (rec.minute !== undefined && now !== null) { const left = Math.max(0, rec.minute - now); bits.push(left >= 90 ? `about ${Math.round(left / 60)} more hours` : left >= 60 ? 'about an hour more' : `${left} more minutes`); }
    if (rec.combat) bits.push('until the fight ends');
    if (rec.rest) bits.push(`until a ${rec.rest} rest`);
    return bits.join(' or ');
}

/**
 * Take off what has run out: by turn, by round, at the end of a fight, or with a rest (a long rest
 * ends short-rest ones too). Returns plain lines ("Amber is no longer poisoned").
 */
export function expireConditions(world, { turn = null, round = null, combatOver = false, rest = null, now = clockNow(world) } = {}) {
    const log = [];
    for (const [k, rec] of Object.entries(world.condUntil ?? {})) {
        const ends = (turn !== null && rec.turn !== undefined && turn >= rec.turn)
            || (now !== null && rec.minute !== undefined && now >= rec.minute)
            || (round !== null && rec.round !== undefined && round >= rec.round)
            || (combatOver && rec.combat)
            || (rest && rec.rest && (rest === 'long' || rec.rest === 'short'));
        if (!ends) continue;
        delete world.condUntil[k];
        const [who, cond] = k.split('|');
        const holder = findHolder(world, who);
        if (!holder) continue;
        const before = holder.ref.conditions?.length ?? 0;
        holder.ref.conditions = (holder.ref.conditions ?? []).filter(c => c.toLowerCase() !== cond);
        if (holder.ref.conditions.length < before) log.push(`${holder.name} is no longer ${cond}`);
    }
    return log;
}

function findHolder(world, who) {
    for (const group of [world.party, world.combat?.enemies, world.others]) {
        const name = matchName(who, Object.keys(group ?? {}));
        if (name) return { name, ref: group[name] };
    }
    return null;
}

// ---------- classes: hit dice and spell slots ----------

const HIT_DIE = [[/barbarian/, 12], [/fighter|paladin|ranger/, 10], [/sorcerer|wizard/, 6], [/bard|cleric|druid|monk|rogue|warlock|artificer/, 8]];
const FULL = /bard|cleric|druid|sorcerer|wizard/;
const HALF = /paladin|ranger|artificer/;
const THIRD = /eldritch knight|arcane trickster/;
/** Spell slots by caster level (1st to 9th), the 5e table. */
const SLOTS = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
/** Warlock pact slots: [count, slot level] by warlock level. */
const PACT = l => [l >= 17 ? 4 : l >= 11 ? 3 : l >= 2 ? 2 : 1, Math.min(5, Math.ceil(l / 2))];
/** Abilities that come back on a short rest (everything else limited comes back on a long rest). */
const SHORT_REST = /second wind|action surge|channel divinity|wild shape|ki\b|ki points|bardic inspiration|superiority|arcane recovery|pact|warlock slot|healing light|relentless|fey step|misty step \(fey\)/i;

/** What a sheet says about someone's class: hit die, caster type, level, CON modifier. */
export function classInfo(stats) {
    const cls = String(stats?.class ?? '').toLowerCase();
    const level = Math.max(1, Math.min(20, Math.round(Number(stats?.level) || 1)));
    const hitDie = HIT_DIE.find(([re]) => re.test(cls))?.[1] ?? 8;
    const caster = /warlock/.test(cls) ? 'pact' : FULL.test(cls) ? 'full' : HALF.test(cls) ? 'half' : THIRD.test(cls) ? 'third' : null;
    const con = Number(stats?.abilities?.CON);
    return { cls, level, hitDie, caster, conMod: Number.isFinite(con) ? Math.floor((con - 10) / 2) : 0 };
}

/** Spell slots someone has at most: {1: 4, 2: 3, ...} (warlocks: their pact slots). */
export function maxSlots(stats) {
    const { caster, level } = classInfo(stats);
    if (!caster) return {};
    if (caster === 'pact') { const [n, lvl] = PACT(level); return { [lvl]: n }; }
    const casterLevel = caster === 'full' ? level : caster === 'half' ? (level < 2 ? 0 : Math.ceil(level / 2)) : level < 3 ? 0 : Math.ceil(level / 3);
    return Object.fromEntries((SLOTS[casterLevel] ?? []).map((n, i) => [i + 1, n]));
}

/** Someone's resources record (made the first time it's needed): slots used, hit dice used, abilities used. */
export function resourcesOf(world, name) {
    world.resources ??= {};
    return (world.resources[name] ??= { slots: {}, hitDice: 0, used: {} });
}

/**
 * Spend things: "slot 2" / "2nd-level slot" / "level 3 spell", "hit die", or a limited ability by
 * name ("Second Wind"). Returns {log, refused}: refused = what they had none left of.
 */
export function spend(world, name, items, stats) {
    const log = [], refused = [];
    const res = resourcesOf(world, name);
    const max = maxSlots(stats);
    for (const raw of [].concat(items ?? [])) {
        const t = String(raw || '').toLowerCase().trim();
        if (!t) continue;
        const lvl = /(?:slot|level|lvl)\D*(\d)|(\d)(?:st|nd|rd|th)?[- ]?(?:level|lvl)?[- ]?(?:spell )?slot/.exec(t);
        if (lvl) {
            let L = Number(lvl[1] ?? lvl[2]);
            // Warlocks cast with their pact slots, whatever the spell's level.
            if (classInfo(stats).caster === 'pact') L = Number(Object.keys(max)[0]) || L;
            const have = (max[L] ?? 0) - (res.slots[L] ?? 0);
            if (have <= 0) { refused.push(`${name} has no level ${L} slots left`); continue; }
            res.slots[L] = (res.slots[L] ?? 0) + 1;
            log.push(`${name}: level ${L} slot used (${have - 1}/${max[L]} left)`);
            continue;
        }
        if (/hit di(c)?e/.test(t)) {
            const { level } = classInfo(stats);
            if (res.hitDice >= level) { refused.push(`${name} has no hit dice left`); continue; }
            res.hitDice++;
            log.push(`${name}: hit die spent (${level - res.hitDice}/${level} left)`);
            continue;
        }
        const ability = String(raw).trim().slice(0, 40);
        if (res.used[ability]) { refused.push(`${name} already used ${ability}`); continue; }
        res.used[ability] = SHORT_REST.test(ability) ? 'short' : 'long';
        log.push(`${name}: ${ability} used (back after a ${res.used[ability]} rest)`);
    }
    return { log, refused };
}

/** What's left, for the DM: "slots 1st 2/4, 2nd 1/3; hit dice 3/5; used: Second Wind". */
export function resourcesLine(world, name, stats) {
    const res = world.resources?.[name] ?? { slots: {}, hitDice: 0, used: {} };
    const max = maxSlots(stats);
    const ord = n => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
    const slots = Object.entries(max).map(([l, n]) => `${ord(Number(l))} ${n - (res.slots[l] ?? 0)}/${n}`);
    const { level } = classInfo(stats);
    const bits = [];
    if (slots.length) bits.push(`spell slots ${slots.join(', ')}`);
    if (stats) bits.push(`hit dice ${level - (res.hitDice ?? 0)}/${level}`);
    const used = Object.keys(res.used ?? {});
    if (used.length) bits.push(`used: ${used.join(', ')}`);
    return bits.join('; ');
}

/**
 * A rest for the party. Long: HP to full, half their hit dice back, every slot and ability back,
 * what a rest ends ends, exhaustion eases, death saves reset. Short: abilities that come back on a
 * short rest (and a warlock's pact slots) return, and anyone hurt spends hit dice (rolled, plus CON)
 * until they're mostly healed or out of dice.
 * statsOf(name) gives a sheet's stats; roll(notation) a dice roll {total}.
 */
export function takeRest(world, kind, names, statsOf, roll) {
    const log = [];
    for (const name of names) {
        const ref = world.party?.[name];
        if (!ref || (ref.conditions ?? []).some(c => /^dead$/i.test(c))) continue;
        const stats = statsOf(name);
        const res = resourcesOf(world, name);
        const { level, hitDie, conMod, caster } = classInfo(stats);
        if (kind === 'long') {
            const before = ref.hp;
            ref.hp = ref.hp_max;
            res.slots = {};
            res.used = {};
            res.hitDice = Math.max(0, (res.hitDice ?? 0) - Math.max(1, Math.floor(level / 2)));
            ref.conditions = (ref.conditions ?? []).filter(c => !/^(exhausted|exhaustion|unconscious|stable)$/i.test(c));
            delete ref.death;
            log.push(`${name}: ${before < ref.hp ? `HP ${before} → ${ref.hp}` : 'rested'}${Object.keys(maxSlots(stats)).length ? ', spell slots back' : ''}`);
        } else {
            for (const [k, v] of Object.entries(res.used ?? {})) if (v === 'short') delete res.used[k];
            if (caster === 'pact') res.slots = {};
            let healed = 0;
            while (ref.hp > 0 && ref.hp < ref.hp_max * 0.75 && (res.hitDice ?? 0) < level) {
                const r = roll(`1d${hitDie}${conMod >= 0 ? '+' : ''}${conMod}`);
                const gain = Math.max(1, r?.total ?? Math.ceil(hitDie / 2));
                ref.hp = Math.min(ref.hp_max, ref.hp + gain);
                res.hitDice = (res.hitDice ?? 0) + 1;
                healed += gain;
            }
            if (healed) log.push(`${name}: spent hit dice, +${healed} HP (now ${ref.hp}/${ref.hp_max})`);
        }
    }
    log.push(...expireConditions(world, { rest: kind }));
    return log;
}

// ---------- dying ----------

/**
 * Someone at 0 HP took a hit: a failed death save (two for a critical). Damage at or past their
 * HP max beyond 0 kills outright. Returns a line, or ''.
 */
export function hurtWhileDown(world, name, damage, { critical = false } = {}) {
    const ref = world.party?.[name];
    if (!ref || ref.hp > 0) return '';
    if ((ref.conditions ?? []).some(c => /^dead$/i.test(c))) return '';
    if (damage >= (ref.hp_max || 1)) return die(ref, name);
    ref.death ??= { s: 0, f: 0 };
    ref.death.f += critical ? 2 : 1;
    ref.conditions = (ref.conditions ?? []).filter(c => !/^stable$/i.test(c));
    if (ref.death.f >= 3) return die(ref, name);
    return `${name} takes a hit while down: ${ref.death.f} failed death save${ref.death.f > 1 ? 's' : ''}`;
}

function die(ref, name) {
    ref.conditions = [...(ref.conditions ?? []).filter(c => !/^(unconscious|stable)$/i.test(c)), 'dead'];
    ref.death = { s: 0, f: 3 };
    return `${name} has died`;
}

/** Who is dying (at 0 HP, not stable, not dead). */
export function dying(world) {
    return Object.entries(world.party ?? {}).filter(([, p]) => p.hp <= 0 && !(p.conditions ?? []).some(c => /^(dead|stable)$/i.test(c))).map(([n]) => n);
}

/**
 * One death saving throw (the natural d20): 10+ is a success, a 20 brings them back with 1 HP, a 1
 * is two failures; three successes and they're stable, three failures and they die.
 * Returns {line, result: 'success'|'failure'|'revived'|'stable'|'dead'}.
 */
export function deathSave(world, name, natural) {
    const ref = world.party?.[name];
    if (!ref) return { line: '', result: '' };
    ref.death ??= { s: 0, f: 0 };
    if (natural === 20) {
        ref.hp = 1;
        ref.conditions = (ref.conditions ?? []).filter(c => !/^(unconscious|stable)$/i.test(c));
        delete ref.death;
        return { line: `${name} rolls a natural 20 on the death save and comes back with 1 HP!`, result: 'revived' };
    }
    if (natural === 1) ref.death.f += 2;
    else if (natural >= 10) ref.death.s += 1;
    else ref.death.f += 1;
    if (ref.death.f >= 3) { die(ref, name); return { line: `${name} fails a third death save and dies.`, result: 'dead' }; }
    if (ref.death.s >= 3) {
        ref.conditions = [...(ref.conditions ?? []).filter(c => !/^stable$/i.test(c)), 'stable'];
        ref.death = { s: 0, f: 0 };
        return { line: `${name} is stable (unconscious, no longer dying).`, result: 'stable' };
    }
    return { line: `${name}'s death save: ${natural} (${natural >= 10 ? 'success' : natural === 1 ? 'two failures' : 'failure'}) · ${ref.death.s} success${ref.death.s === 1 ? '' : 'es'}, ${ref.death.f} failure${ref.death.f === 1 ? '' : 's'}`, result: natural >= 10 ? 'success' : 'failure' };
}

/** Healed above 0: the death saves are over. */
export function clearDeath(world, name) {
    const ref = world.party?.[name];
    if (ref && ref.hp > 0) { delete ref.death; ref.conditions = (ref.conditions ?? []).filter(c => !/^stable$/i.test(c)); }
}

