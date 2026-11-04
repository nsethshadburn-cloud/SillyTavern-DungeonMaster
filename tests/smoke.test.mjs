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

test('v0.71: a reworded place keeps the card; a move with no card keeps it too until the card comes', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    assert.ok(w.sketch.positions.Hob, 'Hob on the opening sketch');
    // The DM shortens the name: the same place, nobody vanishes, nothing owed.
    await dmTurn(turn({ narration: 'Rain on the lane.', scene: { type: 'social', location: 'Marrow Ford, Eel Street', setting: 'town', changed: false } }));
    assert.equal(w.location, 'Marrow Ford, Eel Street');
    assert.ok(w.sketch.positions.Hob, 'Hob is still there');
    assert.equal(w.sceneCard.people.Hob !== undefined, true);
    assert.ok(!c.meta.turnProblems.some(p => /sent no scene_card/.test(p)));
    // A real move with no card: the old card stays (the DM is told), and the card that follows replaces it whole.
    await dmTurn(turn({ narration: 'Inside, brass and oil.', scene: { type: 'social', location: "Tusk's Locksmith Shop", setting: 'town', changed: true } }));
    assert.ok(c.meta.turnProblems.some(p => /sent no scene_card/.test(p)));
    assert.ok(w.sceneCard.people.Hob !== undefined, 'not wiped to an empty picture');
    await dmTurn(turn({ scene: { type: 'social', location: "Tusk's Locksmith Shop", setting: 'town', changed: false }, scene_card: { place: 'the front room of the shop, one lamp', people: { 'Olwen Tusk': 'behind the counter' }, spots: { 'Olwen Tusk': 'across' } } }));
    assert.equal(w.sceneCard.people.Hob, undefined, 'the new card replaced the old');
    assert.ok(w.sketch.positions['Olwen Tusk']);
    assert.equal(w.sketch.positions.Hob, undefined);
});

test('v0.71: round 1 opens with whoever beat the player; the player\'s reach; the fight\'s end card', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    await playerSays('((a fight breaks out with Hob and Scald))', [turn({ narration: 'Hob draws a club.', scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, start_combat: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d6+2' }, { name: 'Scald', ac: 11, hp: 9, dex: 2 }] }, player_roll: { kind: 'initiative', skill: 'Initiative', advantage: 'advantage', reason: 'roll initiative' } })]);
    assert.equal(c.meta.pendingRoll.kind, 'initiative');
    assert.equal(c.meta.pendingRoll.advantage, 'none', 'initiative is a plain roll unless the reason says why');
    // Hob beat the player, Scald and Judy did not (the dice are set by hand so the test can see it).
    for (const o of w.combat.order) o.init = o.name === 'Hob' ? 25 : 2;
    w.combat.order.sort((a, b) => b.init - a.init);
    await playerSays('15', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Hob comes at you first.', npc_rolls: [{ who: 'Hob', what: 'club swing at Amber', notation: '1d20+4', kind: 'attack', target: 'Amber', damage: '1d6+2', on_success: 'the club lands', on_fail: 'it whistles past' }] })]);
    assert.match(llm.calls.at(-1).user, /ROUND 1 OPENS: Hob beat Amber's 19 and act now/);
    assert.doesNotMatch(llm.calls.at(-1).user, /Scald beat/);
    assert.equal(c.meta.openingRound, undefined, 'the opening of the round is done with');
    assert.ok(cards('roll').some(t => /\*\*Hob\*\* · club swing/.test(t)), 'Hob acted before the player');
    // The player swings at Scald from the far corner: a move's worth closer, still out of reach, no roll, both sides told.
    w.combat.positions.Scald = 'a9';
    w.combat.positions.Amber = 'l1';
    await playerSays('*Amber stabs Scald.*', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'You lunge.', player_roll: { kind: 'attack', skill: 'Short sword', target: 'Scald', dc: 11, reason: 'the stab at Scald' } })]);
    assert.equal(c.meta.pendingRoll, null, 'no roll asked');
    assert.ok(c.meta.turnProblems.some(p => /out of reach/.test(p)), 'the DM is told');
    assert.ok(cards('note').some(t => /out of reach/.test(t)), 'the player is told');
    // Next round the move is back: the swing walks her up and is asked.
    await playerSays('*Amber goes for Scald.*', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'You close the distance.', player_roll: { kind: 'attack', skill: 'Short sword', target: 'Scald', dc: 11, reason: 'the stab at Scald' } })]);
    assert.equal(c.meta.pendingRoll?.kind, 'attack');
    const dist = (a, b) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a.slice(1)) - Number(b.slice(1))));
    assert.ok(dist(w.combat.positions.Amber, 'a9') <= 1, `walked up (${w.combat.positions.Amber})`);
    await playerSays('((they run))', [turn({ narration: 'They bolt.', end_combat: true, positions: { Hob: 'gone', Scald: 'gone' }, scene_card: { people: { Hob: '', Scald: '' } } })]);
    assert.equal(w.combat, null);
    assert.ok(cards('roll').some(t => /⚔️ \*\*The fight is over\.\*\* Amber \d+\/\d+/.test(t)), 'an end card');
});

test('v0.71: coin in NPC chatter still reaches the books: the trade is the DM\'s', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"banter","engaged":2,"stalled":false,"speakers":["Hob"],"addressed":"Hob"}');
    await playerSays('*Amber sets coins on the bar.* "Stew for two, and a room for the night. Name the price and I\'ll pay it."', [turn({ narration: 'Three silver, and the room at the top of the stairs.', state_changes: { gold: -0.3 }, directions: [{ speaker: 'Hob', direction: 'Take the coin and point at the stairs.', length: 'short' }] })]);
    H.settings().useHelper = false;
    assert.match(llm.calls.at(-1).user, /Coin is changing hands/);
    assert.equal(c.docs.world.gold, 39.7);
});

test('v0.72: a grab with no roll is told off; a companion task with no result is told off', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    await playerSays('((a watchman corners Amber in the yard and tries to grab him))', [turn({ narration: 'He comes off the gate, reaching for your arm.' })]);
    assert.match(llm.calls.at(-1).user, /That is a CONTEST/);
    assert.ok(c.meta.turnProblems.some(p => /a contest is dice/.test(p)), 'the DM is told');
    assert.ok(cards('note').some(t => /grab without the contested roll/.test(t)), 'the player is told');
    await playerSays('*Amber tries to twist out of his reach.*', [turn({ narration: 'His hand snaps out.', player_roll: { kind: 'check', skill: 'Acrobatics', dc: 13, reason: 'slipping the grab' } })]);
    assert.equal(c.meta.pendingRoll?.kind, 'check');
    assert.ok(!c.meta.turnProblems.some(p => /a contest is dice/.test(p)), 'asked this time');
    H.settings().useHelper = true;
    llm.local.push('{"category":"action","engaged":2,"stalled":false,"speakers":[],"addressed":"Judy Hopps","task":{"who":"Judy Hopps","what":"check the lane","dm":true}}');
    fake.lines.push('"Someone is moving in the shop," Judy says.');
    await playerSays('Judy, go check the lane.', [turn({ directions: [{ speaker: 'Judy Hopps', direction: 'Report what you saw.', length: 'short' }] })]);
    H.settings().useHelper = false;
    assert.ok(c.meta.turnProblems.some(p => /no result for it/.test(p)), 'a brief alone is told off');
});

test('v0.73: the fight ends by itself when the last enemy drops, and the downed leave the sketch', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    await playerSays('((Hob comes at Amber with his club))', [turn({ narration: 'Hob swings the club up.', scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, start_combat: { enemies: [{ name: 'Hob', ac: 12, hp: 5, dex: 1, damage: '1d6+2' }] }, player_roll: { kind: 'initiative', skill: 'Initiative', reason: 'roll initiative' } })]);
    assert.ok(w.combat && w.combat.enemies.Hob, 'a fight with Hob alone');
    await playerSays('15', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'You go first.', player_roll: { kind: 'attack', skill: 'Short sword', target: 'Hob', dc: 12, damage: '1d6+4', reason: 'the stab at Hob' } })]);
    assert.equal(c.meta.pendingRoll?.kind, 'attack');
    await playerSays('18', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'The blade comes round.' })]);
    assert.equal(c.meta.pendingRoll?.kind, 'damage');
    await playerSays('7', [turn({ narration: 'Hob folds and drops the club.' })]);
    assert.equal(w.combat, null, 'the last enemy down: the code ended the fight');
    assert.ok(cards('roll').some(t => /⚔️ \*\*The fight is over\.\*\* Amber \d+\/\d+/.test(t)), 'the end card');
    assert.match(llm.calls.at(-1).user, /code has ended the fight/, 'the DM is told it is over');
    assert.equal(w.sketch.positions.Hob, undefined, 'the downed leave the sketch instead of standing on a new square');
    assert.equal(w.sceneCard.people.Hob, undefined);
    assert.ok(w.sketch.positions.Amber && w.sketch.positions['Judy Hopps'], 'the party is drawn again from the card');
    assert.ok(c.meta.pacing.calmUntil > c.meta.turn, 'the story breathes');
});

test('v0.73: an enemy whose turn it was and who got no roll and no move is told off; one moved or rolled is not', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    await playerSays('((a fight breaks out with Hob and Scald))', [turn({ narration: 'Hob draws a club.', scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, start_combat: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d6+2' }, { name: 'Scald', ac: 11, hp: 9, dex: 2 }] }, player_roll: { kind: 'initiative', skill: 'Initiative', reason: 'roll initiative' } })]);
    await playerSays('15', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'You have the jump on them.' })]);
    assert.ok(!cards('note').some(t => /took no turn/.test(t)), 'a reply to the player\'s own roll runs nobody');
    await playerSays('*Amber steps back along the wall.*', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Hob comes at you; Scald is already moving.', positions: { Amber: 'e4' }, npc_rolls: [{ who: 'Hob', what: 'club swing at Amber', notation: '1d20+4', kind: 'attack', target: 'Amber', damage: '1d6+2', on_success: 'the club lands', on_fail: 'it whistles past' }] })]);
    assert.ok(c.meta.turnProblems.some(p => /^Scald \(9\/9 HP at [a-l]\d+\) took no turn this round/.test(p)), c.meta.turnProblems.join(' | '));
    assert.ok(cards('note').some(t => /⚠️ Scald took no turn this round/.test(t)), 'the player sees it');
    const notes = cards('note').length;
    await playerSays('*Amber holds her ground.*', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Scald circles; Hob swings again.', positions: { Scald: w.combat.positions.Scald }, npc_rolls: [{ who: 'Hob', what: 'club swing at Amber', notation: '1d20+4', kind: 'attack', target: 'Amber', damage: '1d6+2', on_success: 'the club lands', on_fail: 'it whistles past' }] })]);
    assert.equal(cards('note').filter(t => /took no turn/.test(t)).length, notes === 0 ? 0 : cards('note').slice(0, notes).filter(t => /took no turn/.test(t)).length, 'a "positions" entry at his square counts as his turn');
});

test('v0.74: a night slept through is a long rest even when the DM sent only the clock; an enemy rolls its own dice; the ledger lands once', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    // The ledger: taken once, restated the next turn.
    await playerSays('*Amber tries to pry the box open and take the ledger.*', [turn({ narration: 'The lid gives. The ledger is yours.', state_changes: { items_add: { Amber: ['Customs ledger'] } } })]);
    await playerSays('*Amber tries to read the ledger by the lamp.*', [turn({ narration: 'Names and sums, page after page.', state_changes: { items_add: { Amber: ['Customs ledger'] } } })]);
    assert.deepEqual(w.inventory.Amber.filter(i => /ledger/i.test(i)), ['Customs ledger'], 'one ledger');
    assert.equal(cards('roll').filter(t => /\+ Customs ledger/.test(t)).length, 1, 'one card for it');
    assert.ok(c.meta.turnProblems.some(x => /already carries it/.test(x)), 'the DM is told');
    // The night: a clock skip to dawn with no "rest" is a long rest all the same.
    w.party.Amber.hp = 10;
    await playerSays('((we sleep till morning))', [turn({ ooc: 'Sleeping till morning: I\'ll skip the clock to dawn.', narration: 'Grey light at the shutters.', clock: { set: 'dawn' } })]);
    assert.equal(w.party.Amber.hp, w.party.Amber.hp_max, 'a night\'s sleep is a long rest: HP back');
    assert.ok(cards('roll').some(t => /📜 Long rest: Amber: HP 10 → 24/.test(t)), cards('roll').filter(t => /rest/i.test(t)).join(' | '));
    assert.ok(cards('roll').some(t => /🕰️ Time passes until dawn/.test(t)));
    assert.ok(c.meta.turnProblems.some(x => /that is a long rest, and the code took it/.test(x)));
    // An hour's nap at noon is not.
    w.party.Amber.hp = 10;
    await playerSays('((an hour passes while Amber dozes on the bench))', [turn({ narration: 'You doze.', clock: { advance: '1 hour' } })]);
    assert.equal(w.party.Amber.hp, 10, 'an hour is no long rest');
    // The enemy's dice are the roster's, whatever the DM wrote for the swing.
    await playerSays('((Hob comes at Amber with his club))', [turn({ narration: 'Hob swings the club up.', scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, start_combat: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d8+2' }] }, player_roll: { kind: 'initiative', skill: 'Initiative', reason: 'roll initiative' } })]);
    await playerSays('1', [turn({ scene: { type: 'combat', location: 'Marrow Ford', setting: 'town', changed: false }, narration: 'Hob is quicker.', npc_rolls: [{ who: 'Hob', what: 'club swing at Amber', notation: '1d20+9', kind: 'attack', target: 'Amber', damage: '1d4+3', on_success: 'the club lands', on_fail: 'it whistles past' }] })]);
    const swing = cards('roll').find(t => /\*\*Hob\*\* · club swing/.test(t));
    assert.ok(swing, 'Hob swung');
    const dmg = Number(/\*\*(\d+)\*\* damage/.exec(swing)?.[1] || 0);
    if (dmg) assert.ok(dmg >= 3 && dmg <= 10, `within the roster's 1d8+2, not the DM's 1d4+3: ${swing}`);
    assert.ok(c.meta.turnProblems.some(x => /replaced by their stat block's 1d8\+2/.test(x)), c.meta.turnProblems.join(' | '));
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
