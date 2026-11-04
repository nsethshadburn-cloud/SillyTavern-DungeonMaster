// The smoke harness: a campaign in memory, the turn loop with a scripted referee and storyteller.
// Import this AFTER the loader is registered (see smoke.test.mjs), so every st/ui import below gets its fake.
import { fake } from './fake-st.js';
import { llm } from './fake-llm.js';
import { status } from './fake-status.js';
import { mapCalls } from './fake-map.js';
import { files } from './fake-storage.js';

// The globals the real modules touch at call time.
globalThis.toastr = { info() { }, warning() { }, error() { }, success() { }, clear() { } };
globalThis.document = { getElementById: () => null, addEventListener() { }, body: { contains: () => false, appendChild() { }, classList: { add() { }, remove() { }, toggle() { } } }, createElement: () => ({ classList: { add() { }, remove() { }, toggle() { }, contains: () => true }, style: {}, addEventListener() { }, querySelector: () => null }) };
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, json: async () => [] });

const { newMeta, loadForCurrentChat, campaign, clearActive, META_KEY } = await import('../../src/st/campaign.js');
const { settings } = await import('../../src/st/settings.js');
const orchestrator = await import('../../src/st/orchestrator.js');
const { createWorldState, ensureParty } = await import('../../src/core/world.js');
const { normalizeDmTurn } = await import('../../src/core/protocol.js');
const { refreshStandingPrompt } = await import('../../src/st/actors.js');

export { fake, llm, status, mapCalls, files, orchestrator, campaign, settings, normalizeDmTurn };

/**
 * A fresh campaign: Amber (the player) and Judy Hopps, files in memory, the helper off (the rules
 * triage alone decides), turn prompts off (no popups), the map on. Returns the campaign.
 */
export async function freshCampaign({ premise = 'A river town at dusk.', bible = '# Bible\nA town.', plot = '## Act 1: Arrival\n- [ ] A1.1 Reach the town\n- [ ] A1.2 Find the fence' } = {}) {
    fake.reset(); llm.reset(); status.reset(); mapCalls.length = 0; files.clear();
    clearActive();
    fake.extensionSettings = { dungeon_master: { useHelper: false, turnPrompts: false, autoReadDice: false, mapTier: 'some', voicesEnabled: false, checkinEvery: 50, eventBase: 0, eventGrowth: 0, eventCap: 0, cachingEnabled: false } };
    settings();
    const meta = newMeta({ id: 'c1', title: 'Test', persona: { avatar: 'amber.png', name: 'Amber', description: 'A thief going straight.' }, party: [{ avatar: 'judy.png', name: 'Judy Hopps', summary: 'A rabbit constable.' }], options: { tone: '', intensity: 3, length: 'breathe', combat: 'normal', strictness: 'loose', eventFrequency: 'off', premise } });
    meta.knowledge = { 'Judy Hopps': 'She vouched for Amber.' };
    const world = createWorldState();
    ensureParty(world, [{ name: 'Amber', hp_max: 24 }, { name: 'Judy Hopps', hp_max: 27 }]);
    world.location = 'Marrow Ford';
    world.setting = 'town';
    world.time = 'evening';
    fake.chatMetadata = { [META_KEY]: meta };
    files.set('dm_c1_bible.md', bible);
    files.set('dm_c1_plot.md', plot);
    files.set('dm_c1_world_state.json', JSON.stringify(world));
    files.set('dm_c1_npcs.json', '[]');
    const c = await loadForCurrentChat();
    refreshStandingPrompt();
    return c;
}

/** Queue scripted replies: a ruling() goes to the referee, a story() to the storyteller. */
function script(replies) {
    for (const r of replies) {
        if (r?.__story) { const { __story, ...rest } = r; llm.story.push(rest); }
        else { const { __ruling, ...rest } = r ?? {}; llm.referee.push(rest); }
    }
}

/** The player sends a message and the turn runs (the table answers from the scripted queues). */
export async function playerSays(text, replies = []) {
    script(replies);
    fake.chat.push({ name: 'Amber', is_user: true, is_system: false, send_date: new Date().toISOString() + Math.random(), mes: text, extra: {} });
    await orchestrator.runTurn();
    return campaign();
}

/** The table steps in by itself (a forced turn), with scripted answers. */
export async function dmTurn(replies, opts = {}) {
    script(Array.isArray(replies) ? replies : [replies]);
    await orchestrator.runTurn({ force: 'manual', ...opts });
    return campaign();
}

/** A referee's reply (the mechanics of a turn), for playerSays. */
export function ruling(extra = {}) {
    return { __ruling: true, ...extra };
}

/** A storyteller's reply (the prose of a turn), for playerSays. */
export function story(extra = {}) {
    return { __story: true, scene: { type: 'social' }, tension: 2, standing_direction: 'Dusk in Marrow Ford.', world_next: 5, ...extra };
}

/** The chat's messages of one kind, as text (narration, roll, note, ooc, npc). */
export function cards(type) {
    return fake.chat.filter(m => m.extra?.dungeon_master?.type === type).map(m => m.mes);
}

/** A whole turn in the old one-object shape (the wizard's opening). */
export function turn(extra = {}) {
    return { scene: { type: 'social', location: 'Marrow Ford', setting: 'town', changed: false }, tension: 2, standing_direction: 'Dusk in Marrow Ford.', world_next: 5, ...extra };
}
