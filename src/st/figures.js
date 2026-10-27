// Map figures for everyone on the board. The player and companions get one described by Claude
// (Sonnet looks at their card and picture, once, and the look is kept per character for every
// campaign). NPCs, guards and enemies use the built-in library, matched to what they are, in a
// color variant that's stable for their name.

import { ST } from './st.js';
import { settings } from './settings.js';
import { campaign } from './campaign.js';
import { callClaude } from './llm.js';
import { statsForName } from './sheets.js';
import { guessGender } from './voices.js';
import { currentPlace } from './atlas.js';
import { normalizeLook, lookForNpc, presetFor, libraryLook, sexFromText, SPRITE_INSTRUCTIONS, LIBRARY } from '../core/sprites.js';
import { extractJson, trimToTokens, nameKey } from '../core/text.js';

const keyFor = (kind, avatar) => `${kind === 'persona' ? 'p' : 'c'}:${avatar}`;

function stored(kind, avatar) {
    return settings().figures?.[keyFor(kind, avatar)] ?? null;
}

// Figures drawn before v0.15.1 (no facialHair) didn't reliably say man or woman: go by the name and card.
function settled(look, name, text) {
    if (!look || 'facialHair' in look || look.beast || look.female) return look;
    const sex = guessGender(name) !== 'any' ? guessGender(name) : sexFromText(text);
    return { ...look, female: sex === 'female' };
}

/** The look for anyone on the map, by name. */
export function figureFor(name) {
    const c = campaign();
    if (!c) return libraryLook(presetFor(name));
    if (name === c.meta.persona.name) return settled(stored('persona', c.meta.persona.avatar), name, c.meta.persona.description) ?? libraryLook(presetFor(c.meta.persona.description || name), 0, sexFromText(c.meta.persona.description));
    const member = c.meta.party.find(p => p.name === name);
    if (member) return settled(stored('character', member.avatar), name, member.summary) ?? libraryLook(presetFor(member.summary || name), 1, sexFromText(member.summary));
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
    // Men and women look different on the map: the DM's gender for them, else the words or the first name.
    const sex = who => (who.gender === 'male' || who.gender === 'female' ? who.gender : guessGender(who.name));
    if (npc) return lookForNpc(npc.name, npc.description, npc.sprite, sex(npc));
    const person = currentPlace(c)?.place.guards?.[name];
    if (person) return lookForNpc(person.name, person.description, person.sprite, sex(person));
    const enemy = c.docs.world.combat?.enemies?.[name];
    return lookForNpc(name.replace(/\s*\d+$/, ''), '', enemy?.sprite);
}

async function pictureOf(kind, avatar) {
    try {
        const res = await fetch(`/thumbnail?type=${kind === 'persona' ? 'persona' : 'avatar'}&file=${encodeURIComponent(avatar)}`, { cache: 'force-cache' });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
    } catch {
        return null;
    }
}

let busy = Promise.resolve();

/** The player's own instructions for someone's figure (kept, so later redraws follow them too). */
export function wishesFor(kind, avatar) {
    return settings().figureWishes?.[keyFor(kind, avatar)] ?? '';
}

/**
 * Ask Claude to describe one character's figure (with their picture) and keep it.
 * custom = the player's own instructions ("give her a red cloak and a bow"); they win over the card.
 */
async function describe(kind, avatar, name, text, c, custom = wishesFor(kind, avatar)) {
    const weapon = statsForName(name, c?.meta)?.attacks?.[0]?.name;
    const current = stored(kind, avatar);
    const user = [
        `Name: ${name}`,
        `Card / description: ${trimToTokens(String(text || ''), 700)}`,
        weapon ? `Main weapon on their character sheet: ${weapon}` : '',
        custom && current ? `Their figure right now: ${JSON.stringify(current)}` : '',
        custom ? `THE PLAYER'S INSTRUCTIONS for this figure (follow them; they win over the card and picture where they disagree; keep everything else as it is): ${String(custom).slice(0, 600)}` : '',
        'Describe their map figure.',
    ].filter(Boolean).join('\n');
    const picture = await pictureOf(kind, avatar);
    const reply = await callClaude({ system: SPRITE_INSTRUCTIONS, user, images: picture ? [picture] : [], task: 'sprite', label: `map figure for ${name}`, maxTokens: 3000, effort: 'low' });
    const json = extractJson(reply.text);
    if (!json) throw new Error(`Claude didn't describe ${name}'s figure.`);
    const look = normalizeLook(json);
    const s = settings();
    s.figures ??= {};
    s.figures[keyFor(kind, avatar)] = look;
    s.figureWishes ??= {};
    if (custom) s.figureWishes[keyFor(kind, avatar)] = String(custom).slice(0, 600);
    else delete s.figureWishes[keyFor(kind, avatar)];
    ST.saveSettingsDebounced();
    return look;
}

/** The player and companions with their figure, for the Map figures window. */
export function partyFigures(c = campaign()) {
    if (!c) return [];
    return [
        { kind: 'persona', avatar: c.meta.persona.avatar, name: c.meta.persona.name, text: c.meta.persona.description },
        ...c.meta.party.map(p => ({ kind: 'character', avatar: p.avatar, name: p.name, text: p.summary })),
    ].map(f => ({ ...f, look: figureFor(f.name), drawn: Boolean(stored(f.kind, f.avatar)), wishes: wishesFor(f.kind, f.avatar) }));
}

/** Make figures for the player and companions who don't have one yet (once each, in the background). */
export function ensureFigures(c = campaign()) {
    if (!c || settings().mapFigures === false) return busy;
    const todo = [
        ['persona', c.meta.persona.avatar, c.meta.persona.name, c.meta.persona.description],
        ...c.meta.party.map(p => ['character', p.avatar, p.name, p.summary]),
    ].filter(([kind, avatar]) => avatar && !stored(kind, avatar));
    if (!todo.length) return busy;
    busy = busy.then(async () => {
        for (const [kind, avatar, name, text] of todo) {
            if (stored(kind, avatar)) continue;
            try {
                await describe(kind, avatar, name, text, c);
            } catch (error) {
                console.warn('[Dungeon Master] map figure failed', name, error);
            }
        }
        const { refreshMap } = await import('../ui/map.js');
        refreshMap();
    });
    return busy;
}

/**
 * Draw someone's figure again (the player asked).
 * @param {string} name
 * @param {string|null} custom the player's instructions; '' = back to just the card and picture; null = keep the saved ones
 */
export async function redoFigure(name, custom = null) {
    const c = campaign();
    if (!c) return;
    const persona = nameKey(name) === nameKey(c.meta.persona.name);
    const member = c.meta.party.find(p => nameKey(p.name) === nameKey(name) || nameKey(p.name).startsWith(nameKey(name)));
    if (!persona && !member) {
        toastr.info(`Only you and your companions get their own figure; NPCs use the built-in ones.`, 'Dungeon Master');
        return;
    }
    const kind = persona ? 'persona' : 'character';
    const avatar = persona ? c.meta.persona.avatar : member.avatar;
    const look = await describe(kind, avatar, persona ? c.meta.persona.name : member.name, persona ? c.meta.persona.description : member.summary, c, custom === null ? wishesFor(kind, avatar) : custom);
    const { refreshMap } = await import('../ui/map.js');
    refreshMap();
    return look;
}

export { LIBRARY };
