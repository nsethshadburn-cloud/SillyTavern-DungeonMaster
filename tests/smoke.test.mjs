// The smoke test: the whole turn loop under node, with SillyTavern faked (tests/harness). A scripted
// DM answers; the test reads the books, the sketch, the fight and the cards the player would see.
// This is the safety net the st layer never had: a slip in applyDmTurn fails here, not in play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const H = await import('./harness/world.js');
const { freshCampaign, playerSays, dmTurn, cards, turn, fake, llm, status, mapCalls, orchestrator, normalizeDmTurn } = H;

const opening = () => normalizeDmTurn({
    narration: 'Marrow Ford at dusk. The Drowned Eel\'s lamps are lit across the lane; two men watch its door.',
    scene: { type: 'exploration', location: 'Marrow Ford', setting: 'town', changed: true },
    standing_direction: 'Dusk; the inn across the lane; two bruisers at its door.',
    scene_card: { place: 'Eel Street at dusk, lamplight from the inn', people: { 'Judy Hopps': 'at your shoulder', Hob: 'at the inn door, arms folded', Scald: 'beside Hob' }, spots: { 'Judy Hopps': 'beside', Hob: 'door', Scald: 'door' }, objects: { 'the inn sign': 'a painted eel, swinging', 'a hand cart': 'empty, by the wall' } },
    new_npcs: [{ name: 'Hob', role: 'bruiser, Tusk\'s man', description: 'a big man with a raven tattoo', gender: 'male', attitude: 'hostile', stats: 'AC 12, HP 11, +4 to hit, 1d6+2' }, { name: 'Scald', role: 'bruiser, Tusk\'s man', description: 'wiry, a scar', gender: 'male', attitude: 'hostile' }, { name: 'The Drowned Eel', role: 'the inn', description: 'a riverside inn', gender: 'any', attitude: 'neutral' }],
    state_changes: { gold: 40, items_add: { Amber: ["thieves' tools"] } },
    tension: 3, world_next: 3,
});

test('the opening: the books, the people, the sketch; a place named as a person is refused', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    assert.equal(w.gold, 40);
    assert.deepEqual(w.inventory.Amber, ["thieves' tools"]);
    assert.deepEqual(c.docs.npcs.map(n => n.name), ['Hob', 'Scald'], 'the inn is not a person');
    assert.ok(cards('note').some(t => /The Drowned Eel/.test(t) && /⚠️/.test(t)), 'the player sees that the inn was refused');
    assert.deepEqual(w.sceneCard.spots, { 'Judy Hopps': 'beside', Hob: 'door', Scald: 'door' });
    assert.ok(w.sketch, 'a sketch of the scene');
    assert.equal(w.sketch.map.theme, 'town');
    assert.deepEqual(Object.keys(w.sketch.positions).sort(), ['Amber', 'Hob', 'Judy Hopps', 'Scald']);
    assert.ok(w.sketch.map.props.some(p => p.type === 'cart'), 'the hand cart is drawn');
    assert.ok(mapCalls.includes('open'), 'the map opens on the opening');
    assert.equal(cards('narration').length, 1);
    assert.equal(c.meta.standing, 'Dusk; the inn across the lane; two bruisers at its door.');
});

test('a risky action: the DM asks for a roll, the player rolls, the DM is told the result', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    await playerSays('*Amber slips round to the back of the shop and tries to pick the lock.*', [turn({ narration: 'You kneel at the back door. The lock is old but stiff.', player_roll: { kind: 'check', skill: "Thieves' Tools", ability: 'DEX', dc: 15, reason: 'the back room lock' } })]);
    assert.ok(c.meta.pendingRoll, 'a roll is pending');
    assert.equal(c.meta.pendingRoll.skill, "Thieves' Tools");
    assert.ok(cards('roll').some(t => /roll a \*\*d20\*\*/.test(t)), 'the 🎲 request card');
    const before = llm.calls.length;
    await playerSays('17', [turn({ narration: 'The lock gives with a click.', happened: 'The back door of the shop is open.' })]);
    assert.equal(llm.calls.length, before + 1, 'one DM call for the result');
    assert.match(llm.calls.at(-1).user, /ROLL RESULT: Amber rolled 17 on the d20 \+10 \(Thieves' Tools\) = 27 vs hidden DC 15: SUCCESS/);
    assert.equal(c.meta.pendingRoll, null);
    assert.equal(c.docs.rolls_log.at(-1).total, 27);
    assert.equal(c.meta.timeline.at(-1).text, 'The back door of the shop is open.');
    assert.match(cards('narration').at(-1), /lock gives/);
});

test('buying something: coin and gear on the books the same turn', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"risky_action","engaged":2,"speakers":[],"addressed":"the shopkeeper"}');
    await playerSays('"I\'ll take a hooded lantern, if you have one. How much?"', [turn({ narration: 'Five silver, says the shopkeeper, and hands it over.', state_changes: { gold: -0.5, items_add: { Amber: ['hooded lantern'] } }, scene_card: { objects: { 'hooded lantern': '' } } })]);
    H.settings().useHelper = false;
    assert.equal(c.docs.world.gold, 39.5);
    assert.deepEqual(c.docs.world.inventory.Amber, ["thieves' tools", 'hooded lantern']);
    assert.ok(cards('roll').some(t => /📜.*Gold -0\.5.*hooded lantern/.test(t)), 'a 📜 card for the purchase');
});

test('a companion task: the helper reads it, the DM rules, the companion moves on the sketch and reports', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"action","engaged":2,"stalled":false,"speakers":[],"addressed":"Judy Hopps","task":{"who":"Judy Hopps","what":"check the lane","dm":true}}');
    fake.lines.push('"Two of them, still at the door. They haven\'t moved," Judy says.');
    await playerSays('Judy, go check the lane and tell me if Tusk\'s people are still about.', [turn({
        npc_rolls: [{ who: 'Judy Hopps', what: 'Perception (the lane)', notation: '1d20+4', dc: 10, kind: 'check', on_success: 'she sees Hob and Scald still at the door', on_fail: 'she sees nothing useful' }],
        scene_card: { spots: { 'Judy Hopps': 'near' } },
        directions: [{ speaker: 'Judy Hopps', direction: 'You looked down the lane: Hob and Scald are still at the inn door. Tell Amber.', length: 'short' }],
    })]);
    H.settings().useHelper = false;
    assert.match(llm.calls.at(-1).user, /COMPANION TASK: the player told Judy Hopps to check the lane/);
    assert.ok(cards('roll').some(t => /Judy Hopps.*Perception/.test(t)), 'her roll is on a card');
    assert.equal(c.docs.world.sketch.zones['Judy Hopps'], 'near');
    assert.equal(fake.generated.length, 1, 'Judy spoke once');
    assert.match(fake.chat.at(-1).mes, /still at the door/);
});

test('a fight on the sketch: initiative, the attack, the damage, a round, the end', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    const sketchBefore = JSON.stringify(w.sketch.map);
    H.settings().useHelper = true;
    llm.local.push('{"category":"combat_action","engaged":3,"speakers":[],"addressed":"Hob"}');
    await playerSays('*Amber draws his short sword and stabs Hob.*', [turn({ narration: 'Hob sees the blade and roars.', scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, start_combat: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d6+2' }, { name: 'Scald', ac: 11, hp: 9, dex: 2 }] }, player_roll: { kind: 'initiative', skill: 'Initiative' } })]);
    H.settings().useHelper = false;
    assert.ok(w.combat, 'a fight is on');
    assert.equal(w.combat.onSketch, true, 'fought on the sketch');
    assert.equal(JSON.stringify(w.combat.map), sketchBefore, 'the sketch is the battle map');
    assert.equal(w.combat.positions.Amber, 'g4', 'everyone keeps their square');
    assert.ok(w.combat.positions.Hob && w.combat.positions.Scald);
    assert.ok(cards('roll').some(t => /⚔️ \*\*Initiative\*\*/.test(t)));
    assert.equal(c.meta.pendingRoll.kind, 'initiative');
    assert.ok(mapCalls.includes('open'));
    // The player's initiative, then the DM asks for the attack it put aside for it.
    await playerSays('15', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, player_roll: { kind: 'attack', skill: 'Short sword', target: 'Hob', dc: 99, damage: '1d6+4', reason: 'the stab at Hob' } })]);
    assert.ok(w.combat.order.some(o => o.name === 'Amber' && o.init === 19), 'initiative 15 + 4');
    assert.equal(c.meta.pendingRoll.kind, 'attack');
    assert.equal(c.meta.pendingRoll.dc, 12, 'the attack is against Hob\'s real AC, not the number the DM sent');
    assert.ok(c.meta.turnProblems.some(p => /replaced by their AC 12/.test(p)));
    await playerSays('18', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'The blade bites.' })]);
    assert.equal(c.meta.pendingRoll.kind, 'damage', 'a hit asks for damage by itself');
    assert.equal(c.meta.pendingRoll.target, 'Hob');
    await playerSays('7', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Hob staggers back, blood on his shirt.' })]);
    assert.equal(w.combat.enemies.Hob.hp, 4, 'the code took the damage off');
    assert.ok(cards('roll').some(t => /💥 \*\*Hob\*\* takes \*\*7\*\*/.test(t)));
    assert.match(llm.calls.at(-1).user, /already took it off Hob/);
    // The next round: Hob swings (from two squares off he walks up first); Amber moves within her speed.
    const round = w.combat.round;
    await playerSays('*Amber steps back along the wall.*', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Hob comes at you.', positions: { Amber: 'e4' }, npc_rolls: [{ who: 'Hob', what: 'club swing at Amber', notation: '1d20+4', kind: 'attack', target: 'Amber', damage: '1d6+2', on_success: 'the club lands', on_fail: 'it whistles past' }] })]);
    assert.equal(w.combat.round, round + 1, 'a new round');
    assert.equal(w.combat.positions.Amber, 'e4');
    const hobCard = cards('roll').find(t => /\*\*Hob\*\* · club swing/.test(t));
    assert.ok(hobCard, 'Hob\'s swing is on a card');
    const hobAt = w.combat.positions.Hob, amberAt = w.combat.positions.Amber;
    const dist = (a, b) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a.slice(1)) - Number(b.slice(1))));
    assert.ok(dist(hobAt, amberAt) <= 1, `Hob walked up to reach (${hobAt} vs ${amberAt})`);
    // Over: the party keeps the squares the fight left them on; the story breathes.
    await playerSays('((Hob and Scald run))', [turn({ narration: 'They bolt down the lane.', end_combat: true, positions: { Hob: 'gone', Scald: 'gone' }, scene_card: { people: { Hob: '', Scald: '' } } })]);
    assert.equal(w.combat, null);
    assert.equal(w.sketch.positions.Amber, 'g4', 'the sketch is drawn again from the card: the player at home');
    assert.equal(w.sketch.positions.Hob, undefined, 'gone from the card, gone from the sketch');
    assert.ok(c.meta.pacing.calmUntil > c.meta.turn);
});

test('a rest moves the clock and the books; a new place needs a card, and gets its own sketch', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    w.party.Amber.hp = 10;
    const minutes = w.clock.minutes;
    await playerSays('((we take a short rest))', [turn({ narration: 'You sit on the cart and bind the cut.', rest: 'short' })]);
    assert.ok(cards('roll').some(t => /📜 Short rest/.test(t)));
    assert.equal(w.clock.minutes - minutes, 60, 'an hour for the rest (an out-of-character line ticks no turn)');
    // Into the shop with no card: the DM is told; with a card: a new sketch, indoors.
    const key = w.sketch.key;
    await playerSays('*Amber goes into the locksmith\'s shop.*', [turn({ narration: 'Brass and oil. Tusk looks up from the counter.', scene: { type: 'social', location: "Tusk's Locksmith Shop", setting: 'town', changed: true } })]);
    assert.ok(c.meta.turnProblems.some(p => /sent no scene_card/.test(p)), 'the DM is told to send the card');
    await dmTurn(turn({ scene: { type: 'social', location: "Tusk's Locksmith Shop", setting: 'town', changed: false }, scene_card: { place: 'the front room of the locksmith\'s shop, one lamp', people: { 'Olwen Tusk': 'behind the counter' }, spots: { 'Olwen Tusk': 'across' }, objects: { 'the counter': 'scarred oak', 'a rack of keys': 'on the wall' } }, new_npcs: [{ name: 'Olwen Tusk', role: 'locksmith and fence', description: 'grey, sharp', gender: 'female', attitude: 'wary' }] }));
    assert.notEqual(w.sketch.key, key, 'a new picture');
    assert.equal(w.sketch.map.theme, 'house', 'a shop is a room');
    assert.ok(w.sketch.map.rows.join('').includes('#'), 'walls');
    assert.ok(w.sketch.positions['Olwen Tusk']);
    assert.equal(w.sketch.positions.Hob, undefined, 'the bruisers stayed outside');
    assert.ok(w.sketch.map.props.some(p => p.type === 'counter'));
});

test('a dropped roll: the code asked first; a roll for a companion is rolled by the code', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    await playerSays('*Amber climbs the drainpipe to the shop\'s upper window.*', [turn({ narration: 'The pipe groans.', player_roll: { kind: 'check', skill: 'Athletics', dc: 12, reason: 'the climb' } })]);
    await playerSays('3', [turn({ narration: 'Your boot slips and you drop into the mud.', state_changes: { conditions_add: { Amber: ['prone'] } }, player_roll: { kind: 'check', skill: 'Stealth', dc: 12, reason: "Judy's climb" } })]);
    assert.ok(c.docs.world.party.Amber.conditions.includes('prone'));
    assert.equal(c.meta.pendingRoll, null, 'the roll "for Judy" is Judy\'s: rolled by the code, not asked of the player');
    assert.ok(cards('roll').some(t => /\*\*Judy Hopps\*\* · Judy's climb/.test(t)));
    assert.ok(c.meta.turnProblems.some(p => /the code rolled it for Judy Hopps instead/.test(p)));
    assert.ok(status.notes.some(n => /Amber: \+prone/.test(n)) || cards('roll').some(t => /Amber: \+prone/.test(t)));
});
