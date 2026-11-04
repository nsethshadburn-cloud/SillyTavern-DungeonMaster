// The smoke test: the whole turn loop under node, with SillyTavern faked (tests/harness). A scripted
// referee and a scripted storyteller answer; the test reads the books, the sketch, the fight and the
// cards the player would see, in the order the player sees them: rule, then roll, then tell.
// This is the safety net the st layer never had: a slip in applyRuling or applyStory fails here, not in play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const H = await import('./harness/world.js');
const { freshCampaign, playerSays, dmTurn, cards, fake, llm, status, mapCalls, orchestrator, normalizeDmTurn, ruling, story } = H;

const opening = () => normalizeDmTurn({
    narration: 'Marrow Ford at dusk. The Drowned Eel\'s lamps are lit across the lane; two men watch its door.',
    scene: { type: 'exploration', location: 'Marrow Ford', setting: 'town', changed: true },
    standing_direction: 'Dusk; the inn across the lane; two bruisers at its door.',
    scene_card: { place: 'Eel Street at dusk, lamplight from the inn', people: { 'Judy Hopps': 'at your shoulder', Hob: 'at the inn door, arms folded', Scald: 'beside Hob' }, spots: { 'Judy Hopps': 'beside', Hob: 'door', Scald: 'door' }, objects: { 'the inn sign': 'a painted eel, swinging', 'a hand cart': 'empty, by the wall' } },
    new_npcs: [{ name: 'Hob', role: 'bruiser, Tusk\'s man', description: 'a big man with a raven tattoo', gender: 'male', attitude: 'hostile', stats: 'AC 12, HP 11, +4 to hit, 1d6+2' }, { name: 'Scald', role: 'bruiser, Tusk\'s man', description: 'wiry, a scar', gender: 'male', attitude: 'hostile' }, { name: 'The Drowned Eel', role: 'the inn', description: 'a riverside inn', gender: 'any', attitude: 'neutral' }],
    state_changes: { gold: 40, items_add: { Amber: ["thieves' tools"] } },
    tension: 3, world_next: 3,
});

const fightScene = { type: 'combat' };
const calls = () => ({ referee: llm.calls.filter(x => /^referee/.test(x.label)).length, story: llm.calls.filter(x => /^storyteller/.test(x.label)).length });

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

test('rule, roll, tell: the referee asks a roll and the storyteller waits for it; the result is ruled, then told', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const before = calls();
    await playerSays('*Amber slips round to the back of the shop and tries to pick the lock.*', [ruling({ rolls: [{ who: 'Amber', kind: 'check', skill: "Thieves' Tools", ability: 'DEX', dc: 15, why: 'the back room lock is old but stiff' }] })]);
    assert.deepEqual(calls(), { referee: before.referee + 1, story: before.story }, 'one referee call, and no storyteller: nothing is settled yet');
    assert.ok(c.meta.pendingRoll, 'a roll is pending');
    assert.equal(c.meta.pendingRoll.skill, "Thieves' Tools");
    assert.equal(c.meta.pendingRoll.dc, 15, 'the DC is the referee\'s');
    const ask = cards('roll').find(t => /roll a \*\*d20\*\*/.test(t));
    assert.ok(ask, 'the 🎲 request card');
    assert.match(ask, /the back room lock is old but stiff/, 'the card carries the referee\'s why');
    assert.equal(cards('narration').length, 1, 'no narration before the dice');
    assert.match(llm.lastReferee.system, /You are the REFEREE/);
    assert.match(llm.lastReferee.system, /Amber \(Rogue 5\): AC 14, HP max 24/, 'the party\'s numbers are in the referee\'s stable prompt');
    assert.match(llm.lastReferee.user, /The player attempts something with an uncertain outcome/);
    await playerSays('17', [ruling({ fact: 'The lock gives.' }), story({ narration: 'The lock gives with a click.', happened: 'The back door of the shop is open.' })]);
    assert.deepEqual(calls(), { referee: before.referee + 2, story: before.story + 1 }, 'the result: the referee rules it, the storyteller tells it');
    assert.match(llm.lastReferee.user, /ROLL RESULT: Amber rolled 17 on the d20 \+10 \(Thieves' Tools\) = 27 vs hidden DC 15: SUCCESS/);
    assert.match(llm.lastStory.user, /THE TABLE'S RULING/);
    assert.match(llm.lastStory.user, /- Ruling: The lock gives\./);
    assert.match(llm.lastStory.user, /Thieves' Tools: d20 \(17\) \+10 = 27 ✔ vs DC 15/, 'the storyteller sees the dice card');
    assert.match(llm.lastStory.system, /You are the Dungeon Master's voice: the STORYTELLER/);
    assert.equal(c.meta.pendingRoll, null);
    assert.equal(c.docs.rolls_log.at(-1).total, 27);
    assert.equal(c.meta.timeline.at(-1).text, 'The back door of the shop is open.');
    assert.match(cards('narration').at(-1), /lock gives/);
    const idx = t => fake.chat.findIndex(m => m.mes === t);
    assert.ok(idx(cards('roll').find(t => /= \*\*27\*\*/.test(t))) < idx(cards('narration').at(-1)), 'the dice come before the story');
});

test('buying something: the referee books the coin and the gear; one 📜 card; the storyteller tells the price', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"risky_action","engaged":2,"speakers":[],"addressed":"the shopkeeper"}');
    await playerSays('"I\'ll take a hooded lantern, if you have one. How much?"', [ruling({ fact: 'Five silver for the hooded lantern; Amber pays.', changes: { gold: -0.5, items_add: { Amber: ['hooded lantern'] } }, scene: { objects: { 'hooded lantern': '' } } }), story({ narration: 'Five silver, says the shopkeeper, and hands it over.' })]);
    H.settings().useHelper = false;
    assert.match(llm.lastReferee.user, /Coin is changing hands/);
    assert.equal(c.docs.world.gold, 39.5);
    assert.deepEqual(c.docs.world.inventory.Amber, ["thieves' tools", 'hooded lantern']);
    assert.equal(cards('roll').filter(t => /📜.*Gold -0\.5.*hooded lantern/.test(t)).length, 1, 'one 📜 card for the purchase, and no bookkeeper after it');
    assert.match(llm.lastStory.user, /📜 Gold -0\.5/, 'the storyteller sees the books');
    assert.equal(llm.localCalls.length, 1, 'the helper read the line; nothing read the narration after');
});

test('a companion task: the helper reads it, the referee rolls for her, the companion moves on the sketch and reports', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"action","engaged":2,"stalled":false,"speakers":[],"addressed":"Judy Hopps","task":{"who":"Judy Hopps","what":"check the lane","dm":true}}');
    fake.lines.push('"Two of them, still at the door. They haven\'t moved," Judy says.');
    await playerSays('Judy, go check the lane and tell me if Tusk\'s people are still about.', [
        ruling({ rolls: [{ who: 'Judy Hopps', kind: 'check', skill: 'Perception', dc: 10, why: 'the lane', on_success: 'she sees Hob and Scald still at the door', on_fail: 'she sees nothing useful' }], scene: { spots: { 'Judy Hopps': 'near' } } }),
        story({ directions: [{ speaker: 'Judy Hopps', direction: 'You looked down the lane: Hob and Scald are still at the inn door. Tell Amber.', length: 'short' }] }),
    ]);
    H.settings().useHelper = false;
    assert.match(llm.lastReferee.user, /COMPANION TASK: the player told Judy Hopps to check the lane/);
    const judy = cards('roll').find(t => /\*\*Judy Hopps\*\* · Perception/.test(t));
    assert.ok(judy, 'her roll is on a card');
    assert.match(judy, /\(\d+\) \+ ?4 =/, 'with her sheet\'s Perception');
    assert.equal(c.docs.world.sketch.zones['Judy Hopps'], 'near');
    assert.equal(fake.generated.length, 1, 'Judy spoke once');
    assert.match(fake.chat.at(-1).mes, /still at the door/);
    assert.match(llm.lastStory.user, /Judy Hopps · Perception/, 'the storyteller saw her roll before briefing her');
});

test('a fight on the sketch: the referee starts it, the code holds everyone for initiative, the attack, the damage, a round, the end', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    const sketchBefore = JSON.stringify(w.sketch.map);
    H.settings().useHelper = true;
    llm.local.push('{"category":"combat_action","engaged":3,"speakers":[],"addressed":"Hob"}');
    await playerSays('*Amber draws his short sword and stabs Hob.*', [
        ruling({ fight: { start: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d6+2' }, { name: 'Scald', ac: 11, hp: 9, dex: 2 }] } }, rolls: [{ who: 'Amber', kind: 'initiative', why: 'the fight is on' }] }),
        story({ narration: 'Hob sees the blade and roars.', scene: fightScene }),
    ]);
    H.settings().useHelper = false;
    assert.ok(w.combat, 'a fight is on');
    assert.equal(w.combat.onSketch, true, 'fought on the sketch');
    assert.equal(JSON.stringify(w.combat.map), sketchBefore, 'the sketch is the battle map');
    assert.equal(w.combat.positions.Amber, 'g4', 'everyone keeps their square');
    assert.ok(w.combat.positions.Hob && w.combat.positions.Scald);
    assert.ok(cards('roll').some(t => /⚔️ \*\*Initiative\*\*/.test(t)));
    assert.equal(c.meta.pendingRoll.kind, 'initiative');
    assert.ok(mapCalls.includes('open'));
    assert.match(llm.lastStory.user, /⚔️ Initiative/, 'the storyteller sees the fight start');
    // The player's initiative; Hob beat them (set by hand so the test can see it); the referee runs Hob and asks the attack that started it.
    for (const o of w.combat.order) o.init = o.name === 'Hob' ? 25 : 2;
    w.combat.order.sort((a, b) => b.init - a.init);
    await playerSays('15', [
        ruling({ acts: { Hob: { do: 'attack', target: 'Amber', weapon: 'club', to_hit: 4 } }, rolls: [{ who: 'Amber', kind: 'attack', skill: 'Short sword', target: 'Hob', dc: 99, damage: '1d6+4', why: 'the stab at Hob' }] }),
        story({ narration: 'Hob comes at you first; then the blade is yours.', scene: fightScene }),
    ]);
    assert.ok(w.combat.order.some(o => o.name === 'Amber' && o.init === 19), 'initiative 15 + 4');
    assert.match(llm.lastReferee.user, /ROUND 1 OPENS: Hob beat Amber's 19/);
    assert.match(llm.lastReferee.user, /WHO MUST ACT NOW \(an entry in "acts" for each, by this exact name; nobody else\): Hob\./);
    assert.ok(cards('roll').some(t => /\*\*Hob\*\* · club at Amber/.test(t)), 'Hob acted before the player, with the roster\'s dice');
    assert.equal(c.meta.pendingRoll.kind, 'attack');
    assert.equal(c.meta.pendingRoll.dc, 12, 'the attack is against Hob\'s real AC, not the number the referee sent');
    assert.ok(c.meta.turnProblems.some(p => /replaced by their AC 12/.test(p)));
    await playerSays('18', [ruling({ fact: 'The blade bites: the code asks for damage.' }), story({ narration: 'The blade bites.', scene: fightScene })]);
    assert.equal(c.meta.pendingRoll.kind, 'damage', 'a hit asks for damage by itself');
    assert.equal(c.meta.pendingRoll.target, 'Hob');
    assert.match(llm.lastReferee.user, /The code has already asked Amber to roll damage/);
    await playerSays('7', [ruling({ fact: 'Hob is cut.' }), story({ narration: 'Hob staggers back, blood on his shirt.', scene: fightScene })]);
    assert.equal(w.combat.enemies.Hob.hp, 4, 'the code took the damage off');
    assert.ok(cards('roll').some(t => /💥 \*\*Hob\*\* takes \*\*7\*\*/.test(t)));
    assert.match(llm.lastReferee.user, /already took it off Hob/);
    assert.match(llm.lastStory.user, /Hob takes 7 damage/);
    // The next round: Hob swings (from two squares off he walks up first), Scald holds; Amber moves within her speed.
    const round = w.combat.round;
    await playerSays('*Amber steps back along the wall.*', [
        ruling({ moves: { Amber: 'e4' }, acts: { Hob: { do: 'attack', target: 'Amber', weapon: 'club', to_hit: 4, damage: '1d6+2' }, Scald: { do: 'hold', why: 'keeps the door' } } }),
        story({ narration: 'Hob comes at you; Scald keeps the door.', scene: fightScene }),
    ]);
    assert.match(llm.lastReferee.user, /WHO MUST ACT NOW[^\n]*: Hob, Scald\./);
    assert.equal(w.combat.round, round + 1, 'a new round');
    assert.equal(w.combat.positions.Amber, 'e4');
    const hobCard = cards('roll').filter(t => /\*\*Hob\*\* · club at Amber/.test(t)).at(-1);
    assert.ok(hobCard, 'Hob\'s swing is on a card');
    const dist = (a, b) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a.slice(1)) - Number(b.slice(1))));
    assert.ok(dist(w.combat.positions.Hob, w.combat.positions.Amber) <= 1, `Hob walked up to reach (${w.combat.positions.Hob} vs ${w.combat.positions.Amber})`);
    assert.match(llm.lastStory.user, /- Scald holds this turn: keeps the door/);
    assert.ok(!cards('note').some(t => /took no turn/.test(t)), 'nobody is told off: the referee answered for every name');
    // Over: the party keeps the squares the fight left them on; the story breathes.
    await playerSays('((Hob and Scald run))', [ruling({ fight: { end: true }, moves: { Hob: 'gone', Scald: 'gone' }, scene: { people: { Hob: '', Scald: '' } }, ooc: 'They break and run.' }), story({ narration: 'They bolt down the lane.' })]);
    assert.equal(w.combat, null);
    assert.equal(w.sketch.positions.Amber, 'g4', 'the sketch is drawn again from the card: the player at home');
    assert.equal(w.sketch.positions.Hob, undefined, 'gone from the card, gone from the sketch');
    assert.ok(c.meta.pacing.calmUntil > c.meta.turn);
    assert.ok(cards('ooc').some(t => /They break and run/.test(t)), 'the referee\'s aside is posted');
});

test('a rest moves the clock and the books; a new place needs a card, and gets its own sketch', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    w.party.Amber.hp = 10;
    const minutes = w.clock.minutes;
    await playerSays('((we take a short rest))', [ruling({ rest: 'short', fact: 'An hour on the cart.' }), story({ narration: 'You sit on the cart and bind the cut.' })]);
    assert.ok(cards('roll').some(t => /📜 Short rest/.test(t)));
    assert.equal(w.clock.minutes - minutes, 60, 'an hour for the rest (an out-of-character line ticks no turn)');
    assert.match(llm.lastStory.user, /📜 Short rest/);
    // Into the shop with no card: the referee is told; with a card: a new sketch, indoors.
    const key = w.sketch.key;
    await playerSays('*Amber goes into the locksmith\'s shop.*', [ruling({ scene: { moved: true, location: "Tusk's Locksmith Shop", setting: 'town' }, fact: 'Amber is inside the shop.' }), story({ narration: 'Brass and oil. Tusk looks up from the counter.' })]);
    assert.ok(c.meta.turnProblems.some(p => /sent no card for it/.test(p)), 'the referee is told to send the card');
    await dmTurn([ruling({ scene: { moved: false, location: "Tusk's Locksmith Shop", place: 'the front room of the locksmith\'s shop, one lamp', people: { 'Olwen Tusk': 'behind the counter' }, spots: { 'Olwen Tusk': 'across' }, objects: { 'the counter': 'scarred oak', 'a rack of keys': 'on the wall' } } }), story({ new_npcs: [{ name: 'Olwen Tusk', role: 'locksmith and fence', description: 'grey, sharp', gender: 'female', attitude: 'wary' }] })]);
    assert.notEqual(w.sketch.key, key, 'a new picture');
    assert.equal(w.sketch.map.theme, 'house', 'a shop is a room');
    assert.ok(w.sketch.map.rows.join('').includes('#'), 'walls');
    assert.ok(w.sketch.positions['Olwen Tusk']);
    assert.equal(w.sketch.positions.Hob, undefined, 'the bruisers stayed outside');
    assert.ok(w.sketch.map.props.some(p => p.type === 'counter'));
    assert.ok(c.docs.npcs.some(n => n.name === 'Olwen Tusk'), 'the storyteller registered her');
});

test('v0.71: a reworded place keeps the card; a move with no card keeps it too until the card comes', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    assert.ok(w.sketch.positions.Hob, 'Hob on the opening sketch');
    // The referee shortens the name: the same place, nobody vanishes, nothing owed.
    await dmTurn([ruling({ scene: { moved: false, location: 'Marrow Ford, Eel Street' } }), story({ narration: 'Rain on the lane.' })]);
    assert.equal(w.location, 'Marrow Ford, Eel Street');
    assert.ok(w.sketch.positions.Hob, 'Hob is still there');
    assert.equal(w.sceneCard.people.Hob !== undefined, true);
    assert.ok(!c.meta.turnProblems.some(p => /sent no card/.test(p)));
    // A real move with no card: the old card stays (the referee is told), and the card that follows replaces it whole.
    await dmTurn([ruling({ scene: { moved: true, location: "Tusk's Locksmith Shop" } }), story({ narration: 'Inside, brass and oil.' })]);
    assert.ok(c.meta.turnProblems.some(p => /sent no card/.test(p)));
    assert.ok(w.sceneCard.people.Hob !== undefined, 'not wiped to an empty picture');
    await dmTurn([ruling({ scene: { location: "Tusk's Locksmith Shop", place: 'the front room of the shop, one lamp', people: { 'Olwen Tusk': 'behind the counter' }, spots: { 'Olwen Tusk': 'across' } } }), story({})]);
    assert.equal(w.sceneCard.people.Hob, undefined, 'the new card replaced the old');
    assert.ok(w.sketch.positions['Olwen Tusk']);
    assert.equal(w.sketch.positions.Hob, undefined);
});

test('v0.71: the player\'s reach; the fight\'s end card; an enemy the referee skips is asked for once, then holds', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    await playerSays('((a fight breaks out with Hob and Scald))', [ruling({ fight: { start: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d6+2' }, { name: 'Scald', ac: 11, hp: 9, dex: 2 }] } }, rolls: [{ who: 'Amber', kind: 'initiative', advantage: 'advantage', why: 'roll initiative' }] }), story({ narration: 'Hob draws a club.', scene: fightScene })]);
    assert.equal(c.meta.pendingRoll.kind, 'initiative');
    assert.equal(c.meta.pendingRoll.advantage, 'none', 'initiative is a plain roll unless the reason says why');
    // Nobody beat the player (set by hand): round 1 is theirs.
    for (const o of w.combat.order) o.init = 2;
    await playerSays('15', [ruling({ fact: 'Amber is first.' }), story({ narration: 'You have the jump on them.', scene: fightScene })]);
    assert.match(llm.lastReferee.user, /Amber has the highest initiative/);
    assert.doesNotMatch(llm.lastReferee.user, /WHO MUST ACT NOW \(an entry/, 'a roll\'s result runs nobody');
    assert.equal(c.meta.openingRound, undefined, 'the opening of the round is done with');
    // The player swings at Scald from the far corner: a move's worth closer, still out of reach, no roll, both sides told.
    // The round runs for the enemies too; the referee leaves Scald out, is asked once more, and still leaves him out: he holds.
    w.combat.positions.Scald = 'a9';
    w.combat.positions.Amber = 'l1';
    const before = calls();
    await playerSays('*Amber stabs Scald.*', [
        ruling({ rolls: [{ who: 'Amber', kind: 'attack', skill: 'Short sword', target: 'Scald', dc: 11, why: 'the stab at Scald' }], acts: { Hob: { do: 'hold', why: 'hangs back' } } }),
        ruling({ rolls: [{ who: 'Amber', kind: 'attack', skill: 'Short sword', target: 'Scald', dc: 11, why: 'the stab at Scald' }], acts: { Hob: { do: 'hold', why: 'hangs back' } } }),
        story({ narration: 'You lunge.', scene: fightScene }),
    ]);
    assert.equal(calls().referee, before.referee + 2, 'the referee was asked once more for Scald');
    assert.match(llm.calls.filter(x => /^referee/.test(x.label)).at(-1).user, /YOUR LAST REPLY LEFT OUT Scald/);
    assert.match(llm.lastStory.user, /Scald holds this turn: holds \(the referee gave no action\)/);
    assert.equal(c.meta.pendingRoll, null, 'no roll asked');
    assert.ok(c.meta.turnProblems.some(p => /out of reach/.test(p)), 'the referee is told');
    assert.ok(cards('note').some(t => /out of reach/.test(t)), 'the player is told');
    // Next round the move is back: the swing walks her up and is asked.
    await playerSays('*Amber goes for Scald.*', [ruling({ rolls: [{ who: 'Amber', kind: 'attack', skill: 'Short sword', target: 'Scald', dc: 11, why: 'the stab at Scald' }], acts: { Hob: { do: 'hold', why: 'hangs back' }, Scald: { do: 'hold', why: 'braces' } } }), story({ narration: 'You close the distance.', scene: fightScene })]);
    assert.equal(c.meta.pendingRoll?.kind, 'attack');
    const dist = (a, b) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a.slice(1)) - Number(b.slice(1))));
    assert.ok(dist(w.combat.positions.Amber, 'a9') <= 1, `walked up (${w.combat.positions.Amber})`);
    await playerSays('((they run))', [ruling({ fight: { end: true }, moves: { Hob: 'gone', Scald: 'gone' }, scene: { people: { Hob: '', Scald: '' } } }), story({ narration: 'They bolt.' })]);
    assert.equal(w.combat, null);
    assert.ok(cards('roll').some(t => /⚔️ \*\*The fight is over\.\*\* Amber \d+\/\d+/.test(t)), 'an end card');
});

test('v0.71: coin in NPC chatter still reaches the books: the trade is the referee\'s', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    H.settings().useHelper = true;
    llm.local.push('{"category":"banter","engaged":2,"stalled":false,"speakers":["Hob"],"addressed":"Hob"}');
    fake.lines.push('"Three silver," Hob says, and points at the stairs.');
    await playerSays('*Amber sets coins on the bar.* "Stew for two, and a room for the night. Name the price and I\'ll pay it."', [ruling({ fact: 'Three silver for stew and the room; Amber pays.', changes: { gold: -0.3 } }), story({ directions: [{ speaker: 'Hob', direction: 'Take the coin and point at the stairs.', length: 'short' }] })]);
    H.settings().useHelper = false;
    assert.match(llm.lastReferee.user, /Coin is changing hands/);
    assert.equal(c.docs.world.gold, 39.7);
});

test('v0.80: a grab is a contest the code rolls: the other side first, in the open, then the player\'s own dice', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const before = calls();
    await playerSays('((a watchman corners Amber in the yard and tries to grab him))', [ruling({ rolls: [{ who: 'Amber', kind: 'contest', skill: 'Acrobatics', vs: { who: 'the watchman', skill: 'Athletics', bonus: 3 }, why: 'his hand snaps out for your collar' }] })]);
    assert.match(llm.lastReferee.user, /That is a CONTEST/);
    assert.equal(calls().story, before.story, 'nothing is settled: no story yet');
    const other = cards('roll').find(t => /\*\*the watchman\*\* · Athletics \(contest\)/.test(t));
    assert.ok(other, 'the watchman\'s side is rolled first, on a card');
    const total = Number(/= \*\*(\d+)\*\*/.exec(other)[1]);
    assert.equal(c.meta.pendingRoll?.kind, 'check');
    assert.equal(c.meta.pendingRoll.skill, 'Acrobatics');
    assert.equal(c.meta.pendingRoll.dc, total, 'his total is the number to beat');
    assert.ok(!c.docs.world.party.Amber.conditions.length, 'nothing holds anyone until the dice say');
    await playerSays('2', [ruling({ fact: 'The watchman has Amber by the collar.', changes: { conditions_add: { Amber: ['grappled (held by the watchman)'] } } }), story({ narration: 'His hand closes on your collar.' })]);
    assert.ok(c.docs.world.party.Amber.conditions.some(x => /grappled/.test(x)), 'the hold exists once the dice said so');
    assert.match(llm.lastStory.user, /Ruling: The watchman has Amber by the collar/);
});

test('v0.73: the fight ends by itself when the last enemy drops, and the downed leave the sketch', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    await playerSays('((Hob comes at Amber with his club))', [ruling({ fight: { start: { enemies: [{ name: 'Hob', ac: 12, hp: 5, dex: 1, damage: '1d6+2' }] } }, rolls: [{ who: 'Amber', kind: 'initiative', why: 'roll initiative' }] }), story({ narration: 'Hob swings the club up.', scene: fightScene })]);
    assert.ok(w.combat && w.combat.enemies.Hob, 'a fight with Hob alone');
    for (const o of w.combat.order) o.init = 2;
    await playerSays('15', [ruling({ rolls: [{ who: 'Amber', kind: 'attack', skill: 'Short sword', target: 'Hob', damage: '1d6+4', why: 'the stab at Hob' }] }), story({ narration: 'You go first.', scene: fightScene })]);
    assert.equal(c.meta.pendingRoll?.kind, 'attack');
    await playerSays('18', [ruling({ fact: 'The blade comes round and bites.' }), story({ narration: 'The blade comes round.', scene: fightScene })]);
    assert.equal(c.meta.pendingRoll?.kind, 'damage');
    await playerSays('7', [ruling({ fact: 'Hob is dead.' }), story({ narration: 'Hob folds and drops the club.' })]);
    assert.equal(w.combat, null, 'the last enemy down: the code ended the fight');
    assert.ok(cards('roll').some(t => /⚔️ \*\*The fight is over\.\*\* Amber \d+\/\d+/.test(t)), 'the end card');
    assert.match(llm.lastReferee.user, /code has ended the fight/, 'the referee is told it is over');
    assert.match(llm.lastStory.user, /The fight is over/, 'and the storyteller tells the aftermath');
    assert.equal(w.sketch.positions.Hob, undefined, 'the downed leave the sketch instead of standing on a new square');
    assert.equal(w.sceneCard.people.Hob, undefined);
    assert.ok(w.sketch.positions.Amber && w.sketch.positions['Judy Hopps'], 'the party is drawn again from the card');
    assert.ok(c.meta.pacing.calmUntil > c.meta.turn, 'the story breathes');
});

test('v0.74: a night slept through is a long rest even when the referee sent only the clock; an enemy rolls its own dice; the ledger lands once', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    // The ledger: taken once, restated the next turn.
    await playerSays('*Amber tries to pry the box open and take the ledger.*', [ruling({ fact: 'The lid gives; the ledger is Amber\'s.', changes: { items_add: { Amber: ['Customs ledger'] } } }), story({ narration: 'The lid gives. The ledger is yours.' })]);
    await playerSays('*Amber tries to read the ledger by the lamp.*', [ruling({ fact: 'Names and sums.', changes: { items_add: { Amber: ['Customs ledger'] } } }), story({ narration: 'Names and sums, page after page.' })]);
    assert.deepEqual(w.inventory.Amber.filter(i => /ledger/i.test(i)), ['Customs ledger'], 'one ledger');
    assert.equal(cards('roll').filter(t => /\+ Customs ledger/.test(t)).length, 1, 'one card for it');
    assert.ok(c.meta.turnProblems.some(x => /already carries it/.test(x)), 'the referee is told');
    // The night: a clock skip to dawn with no "rest" is a long rest all the same.
    w.party.Amber.hp = 10;
    await playerSays('((we sleep till morning))', [ruling({ ooc: 'Sleeping till morning: the clock skips to dawn.', clock: { set: 'dawn' } }), story({ narration: 'Grey light at the shutters.' })]);
    assert.equal(w.party.Amber.hp, w.party.Amber.hp_max, 'a night\'s sleep is a long rest: HP back');
    assert.ok(cards('roll').some(t => /📜 Long rest: Amber: HP 10 → 24/.test(t)), cards('roll').filter(t => /rest/i.test(t)).join(' | '));
    assert.ok(cards('roll').some(t => /🕰️ Time passes until dawn/.test(t)));
    assert.ok(c.meta.turnProblems.some(x => /that is a long rest, and the code took it/.test(x)));
    // An hour's nap at noon is not.
    w.party.Amber.hp = 10;
    await playerSays('((an hour passes while Amber dozes on the bench))', [ruling({ clock: { advance: '1 hour' } }), story({ narration: 'You doze.' })]);
    assert.equal(w.party.Amber.hp, 10, 'an hour is no long rest');
    // The enemy's dice are the roster's, whatever the referee wrote for the swing.
    await playerSays('((Hob comes at Amber with his club))', [ruling({ fight: { start: { enemies: [{ name: 'Hob', ac: 12, hp: 11, dex: 1, damage: '1d8+2' }] } }, rolls: [{ who: 'Amber', kind: 'initiative', why: 'roll initiative' }] }), story({ narration: 'Hob swings the club up.', scene: fightScene })]);
    for (const o of w.combat.order) o.init = o.name === 'Hob' ? 25 : 2;
    w.combat.order.sort((a, b) => b.init - a.init);
    await playerSays('1', [ruling({ acts: { Hob: { do: 'attack', target: 'Amber', weapon: 'club', to_hit: 9, damage: '1d4+3' } } }), story({ narration: 'Hob is quicker.', scene: fightScene })]);
    const swing = cards('roll').find(t => /\*\*Hob\*\* · club at Amber/.test(t));
    assert.ok(swing, 'Hob swung');
    const dmg = Number(/\*\*(\d+)\*\* damage/.exec(swing)?.[1] || 0);
    if (dmg) assert.ok(dmg >= 3 && dmg <= 10, `within the roster's 1d8+2, not the referee's 1d4+3: ${swing}`);
    assert.ok(c.meta.turnProblems.some(x => /replaced by their stat block's 1d8\+2/.test(x)), c.meta.turnProblems.join(' | '));
});

test('a roll for a companion is rolled by the code, whoever the referee named', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    await playerSays('*Amber climbs the drainpipe to the shop\'s upper window.*', [ruling({ rolls: [{ who: 'Amber', kind: 'check', skill: 'Athletics', dc: 12, why: 'the climb' }] })]);
    await playerSays('3', [ruling({ fact: 'Amber drops into the mud.', changes: { conditions_add: { Amber: ['prone'] } }, rolls: [{ who: 'Amber', kind: 'check', skill: 'Stealth', dc: 12, why: "Judy's climb" }] }), story({ narration: 'Your boot slips and you drop into the mud.' })]);
    assert.ok(c.docs.world.party.Amber.conditions.includes('prone'));
    assert.equal(c.meta.pendingRoll, null, 'the roll "for Judy" is Judy\'s: rolled by the code, not asked of the player');
    assert.ok(cards('roll').some(t => /\*\*Judy Hopps\*\* · Judy's climb/.test(t)));
    assert.ok(c.meta.turnProblems.some(p => /the code rolled it for Judy Hopps instead/.test(p)));
    assert.ok(status.notes.some(n => /Amber: \+prone/.test(n)) || cards('roll').some(t => /Amber: \+prone/.test(t)));
});

test('v0.80: the storyteller\'s hands stay off the books: a wound, a roll and a move it sends are dropped and it is told; what arrives goes on the card', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    const hp = w.party.Amber.hp;
    await dmTurn([ruling({}), story({ narration: 'A patrol rounds the bend, lanterns swinging.', state_changes: { hp: { Amber: -5 } }, player_roll: { kind: 'check', skill: 'Stealth' }, positions: { Amber: 'a1' }, scene_card: { people: { 'the watch patrol': 'three lanterns, coming up the lane' }, spots: { 'the watch patrol': 'across' } }, new_npcs: [{ name: 'Sergeant Pell', role: 'leads the watch patrol', description: 'a thickset woman with a lantern', gender: 'female', attitude: 'wary' }] })]);
    assert.equal(w.party.Amber.hp, hp, 'no wound from the storyteller');
    assert.equal(c.meta.pendingRoll, null, 'no roll from the storyteller');
    assert.ok(c.meta.storyProblems.some(p => p.startsWith('your reply carried "player_roll", "state_changes", "positions": dropped')), c.meta.storyProblems.join(' | '));
    assert.equal(w.sceneCard.people['the watch patrol'], 'three lanterns, coming up the lane', 'who arrives is on the card');
    assert.equal(w.sceneCard.spots['the watch patrol'], 'across');
    assert.ok(w.sketch.positions['the watch patrol'], 'and on the sketch');
    assert.ok(c.docs.npcs.some(n => n.name === 'Sergeant Pell'));
    // Next turn the storyteller is told what it tried.
    await dmTurn([ruling({}), story({ narration: 'The lanterns stop.' })]);
    assert.match(llm.lastStory.user, /WHAT DIDN'T TAKE LAST TURN[\s\S]*your reply carried "player_roll", "state_changes", "positions": dropped/);
});

test('v0.80: when the storyteller fails, the ruling stands: the dice are on the table and the roll is still asked', async () => {
    const c = await freshCampaign();
    await orchestrator.runOpening(opening());
    const w = c.docs.world;
    // The referee rules a save with damage for Judy and asks the player a save; the storyteller's queue is empty, so it fails.
    await playerSays('*Amber tries to kick the brazier over.*', [ruling({ fact: 'Coals scatter across the floor.', rolls: [{ who: 'Judy Hopps', kind: 'save', skill: 'DEX', ability: 'DEX', dc: 12, damage: '1d6', why: 'the coals' }, { who: 'Amber', kind: 'save', skill: 'DEX save', ability: 'DEX', dc: 12, damage: '1d6', why: 'the coals at your feet' }] })]);
    assert.ok(cards('roll').some(t => /\*\*Judy Hopps\*\* · DEX/.test(t)), 'Judy\'s save was rolled');
    assert.equal(c.meta.pendingRoll?.kind, 'save', 'the player\'s save is asked');
    assert.equal(c.meta.pendingRoll.damage, '1d6');
    assert.ok(llm.calls.some(x => /^storyteller/.test(x.label)), 'the storyteller was called (something was settled)');
    assert.equal(cards('narration').length, 1, 'and failed: no narration, no crash');
    assert.ok(w.party['Judy Hopps'].hp <= 27);
});
