// Map figures for everyone on the board. The player and companions get one described by Claude
// (Sonnet looks at their card and picture, once, and the look is kept per character for every
// campaign). NPCs, guards and enemies use the built-in library, matched to what they are, in a
// color variant that's stable for their name.

import { ST } from './st.js';
import { settings } from './settings.js';
import { campaign } from './campaign.js';
import { callClaude } from './llm.js';
import { statsForName } from './sheets.js';
import { currentPlace } from './atlas.js';
import { normalizeLook, lookForNpc, presetFor, libraryLook, SPRITE_INSTRUCTIONS, LIBRARY } from '../core/sprites.js';
import { extractJson, trimToTokens, nameKey } from '../core/text.js';

const keyFor = (kind, avatar) => `${kind === 'persona' ? 'p' : 'c'}:${avatar}`;

function stored(kind, avatar) {
    return settings().figures?.[keyFor(kind, avatar)] ?? null;
}

/** The look for anyone on the map, by name. */
export function figureFor(name) {
    const c = campaign();
    if (!c) return libraryLook(presetFor(name));
    if (name === c.meta.persona.name) return stored('persona', c.meta.persona.avatar) ?? libraryLook(presetFor(c.meta.persona.description || name), 0);
    const member = c.meta.party.find(p => p.name === name);
    if (member) return stored('character', member.avatar) ?? libraryLook(presetFor(member.summary || name), 1);
    const npc = (c.docs.npcs || []).find(n => nameKey(n.name) === nameKey(name));
    if (npc) return lookForNpc(npc.name, npc.description, npc.sprite);
    const person = currentPlace(c)?.place.guards?.[name];
    if (person) return lookForNpc(person.name, person.description, person.sprite);
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

/** Ask Claude to describe one character's figure (with their picture) and keep it. */
async function describe(kind, avatar, name, text, c) {
    const weapon = statsForName(name, c?.meta)?.attacks?.[0]?.name;
    const user = [
        `Name: ${name}`,
        `Card / description: ${trimToTokens(String(text || ''), 700)}`,
        weapon ? `Main weapon on their character sheet: ${weapon}` : '',
        'Describe their map figure.',
    ].filter(Boolean).join('\n');
    const picture = await pictureOf(kind, avatar);
    const reply = await callClaude({ system: SPRITE_INSTRUCTIONS, user, images: picture ? [picture] : [], task: 'sprite', label: `map figure for ${name}`, maxTokens: 500, effort: 'low' });
    const json = extractJson(reply.text);
    if (!json) throw new Error(`Claude didn't describe ${name}'s figure.`);
    const look = normalizeLook(json);
    const s = settings();
    s.figures ??= {};
    s.figures[keyFor(kind, avatar)] = look;
    ST.saveSettingsDebounced();
    return look;
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

/** Draw someone's figure again (the player asked). */
export async function redoFigure(name) {
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
    toastr.info(`Drawing ${persona ? c.meta.persona.name : member.name}'s map figure…`, 'Dungeon Master', { timeOut: 2500 });
    await describe(kind, avatar, persona ? c.meta.persona.name : member.name, persona ? c.meta.persona.description : member.summary, c);
    const { refreshMap } = await import('../ui/map.js');
    refreshMap();
    toastr.success('New map figure ready.', 'Dungeon Master', { timeOut: 2500 });
}

export { LIBRARY };
