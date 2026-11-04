# 🎲 Dungeon Master for SillyTavern

> [!WARNING]
> **BETA: experimental and unstable.** This is an early test build made for one person's setup. It can break, change without notice, behave strangely, or misbehave alongside other extensions. It spends real money on the Claude API (there's a budget cap, but costs are estimates). It creates group chats, lorebooks and files in your SillyTavern data. **Use it at your own risk, back up your SillyTavern data first, and please don't expect support.** No warranty of any kind.

Claude runs your campaign as the Dungeon Master. Your local model (Orion, or whatever you load) plays Judy and every NPC. Dice, events and bookkeeping are handled by code.

For how it works under the hood, see [DESIGN.md](DESIGN.md).

---

## Installing

1. In SillyTavern, open **Extensions** (the stacked-blocks icon) → **Install extension**.
2. Paste `https://github.com/nsethshadburn-cloud/SillyTavern-DungeonMaster` and choose **Install just for me**.
3. Updating later: Extensions → **Manage extensions** → the update (⟳) button next to Dungeon Master.

Settings, character sheets and campaigns are stored per SillyTavern install, so a new machine starts fresh: set your DM voice and budget again and re-upload your persona sheet there.

## First-time setup (5 minutes)

1. **Reload SillyTavern** (F5). The extension loads automatically once it's installed for your SillyTavern user.
2. Open **Extensions** (the stacked-blocks icon) and find **🎲 Dungeon Master**. Check:
   - **DM profile:** "Auto" uses your saved **Claude** profile and key. That's fine.
   - **Dungeon Master models:** the **Main DM model** is Claude Sonnet 5.5. **Hybrid models** is on by default: every job has its own model dropdown (Setup, Story direction, Combat, Everyday play, Housekeeping, Dice). Recommended, and the default: Sonnet only for the one-off setup the story builds on (campaign design, pitches, the opening, your PDF sheet, party sheets, and maps when Claude plans every room); Haiku 5.5 for everything during play: rulings, roll results, travel, events, check-ins, companion tasks, new NPCs, questions, combat rounds, story direction (steering back to the plot, stuck scenes, deadlocks) and housekeeping. (v0.24 and v0.25.2 moved those jobs from Sonnet to Haiku in saved settings too, unless you had picked another model for them.) With **"Let cheaper models hand a big story moment up"** on, Haiku passes only the biggest moments (a major reveal, completing a plot beat, a new chapter) to the main model; fights, new places and everything else it handles itself. **Reset to recommended** puts it all back. Turn **Hybrid models** off and the main model does everything.
   - **Actors / Helper:** leave them on "current connection" unless you want a different server.
   - **Budget:** $20/month is set. The nightly soft cap ($0.65) makes the DM check in less often once it's reached.
   - **Voices:** pick a **DM voice** and press **Test DM voice**. Open **NPC voice pool** to switch voices on or off and fix any wrong genders.
3. **Your character sheet:** open the **Persona** panel and click the new **📜 scroll** button. Pick your 5e sheet in any form: a PDF (fillable or scanned), a photo or screenshot of a paper sheet, a Word document, or a text file. Claude converts it once (about 1-3¢; pictures cost a little more) and then it's locked.
4. **Thinking models (Gemma 4 / Orion):** nothing to do. In group chats SillyTavern starts each reply with "Name:", which makes these models skip thinking and garble words. In campaign chats the extension removes that one prefix automatically (other chats are untouched).
5. Optional: lower your **Response length** to about 2048 in the left sliders panel, so the story has room in the context.
6. **Recommended, saves the most money:** turn on Claude prompt caching. In SillyTavern's `config.yaml` (on the machine running SillyTavern), find the `claude:` section and set:
   ```yaml
   claude:
     enableSystemPromptCache: true
     cachingAtDepth: 2
   ```
   Restart SillyTavern, then tick **"I turned on Claude prompt caching"** in the extension settings. The DM's rules, character sheets, plot and notes are then reused from Claude's cache between turns at a tenth of the price or less, instead of being paid for in full every call. The cache lasts 5 minutes after each DM call; if you often go longer between DM turns, also set `extendedTTL: true` there and pick **1 hour** under **Cache lifetime** (writing to the cache costs a bit more, reading it stays cheap). These settings only affect Claude.

## Starting a campaign

Use the **magic wand menu → Start D&D campaign**, or type `/dmstart`.

1. Pick your persona and party members. Characters without 📜 get a sheet written by Claude.
2. Write your plot idea, or choose **Surprise me** → pick a tone and intensity → **Pitch me 3 ideas** → choose one.
3. Set the options (campaign feel, combat, rules, events) and click **Build campaign**.

A new group chat opens with the opening scene. Takes about 30–40 seconds and roughly 3–6¢.

## Playing

Just roleplay. Behind the scenes, each message goes through:

- **The helper** (your local model, under a second) reads your move.
- **Talking and roleplay** → your companions answer on the local model, playing freely. **Free.**
- **Risky things** (sneaking, lying, climbing, attacking), **travel and going in or out of a place**, **talking to someone new**, or a **random event** → the **DM (Claude)** steps in. Routine DM turns on Haiku cost a fraction of a cent; big moments on Sonnet about 1.5–5¢ (the low end with caching on).
- Every few local turns the DM does a quick **check-in** to keep pacing on track.

**One truth.** Outside a fight, the story is the truth: what the DM narrates is what happened, and the code keeps the books that go with it (HP, conditions, gold, items, spell slots, the clock, the dice). There is no second world the story has to be matched to. In a fight the grid is the truth: initiative, movement, reach and damage run on a battle map. (Versions up to 0.69 built every room of every place and tracked doors, traps, guards and who-holds-whom in code; that half of the extension is gone. It never kept up with what a story can say, and each new kind of campaign found a new way for the map and the story to disagree. The old build is kept on the `sim` branch.)

**What the bot sees.** The DM's narration is for you only; the bot never reads it (that's what made it chase random details and drive the plot). Instead, when Claude handles a turn it gives each companion a short private **brief**: only what they need to know and want, never their words. Every reply also gets a short **scene note** (where you are, who's here, the goal, and a 3-4 sentence length target) and the **scene card** (where everyone is and what they hold, kept true by the DM). You can read and edit all of this in **Settings → What the bot is told**, with **Reset to default** on each part and a **Preview** of exactly what the bot gets in the current chat.

**The sketch.** The map panel (wand menu → **Map**, or `/dmmap`) shows a small picture of the scene, drawn from the DM's scene card every turn: a room with a door, or open ground; you in the middle; everyone the DM says is there, where the DM puts them (beside you, a few paces off, across the room, at the door); the things that matter as furniture. It is a picture, not a game board: it never decides whether you can go somewhere or what you can reach. Tap someone for a word with them (**Talk to**, **Wait here**, **Come along**, **Attack** for a stranger); tap a thing to go over to it, search it or take it; tap an empty square and your figure walks there. Going into a building or out into the street is just saying so: the DM describes where you are and the sketch is drawn again. Turn the map off in the settings and the whole campaign stays in the chat.

**Combat.** Claude runs fights: it decides what companions and enemies do, rolls for them and narrates; companions only get a quick line. When a fight starts the sketch becomes the **battle map** (everyone keeps the square they stand on), or the DM draws one that fits the place: chess-style squares (a1 is bottom-left), figures, terrain, HP. Tap a square to move and an enemy to target, then **Add to message** and say what you do. The map lights the squares you can reach this round (30 ft = 6 squares), the DM's moves for everyone else are held to their speed too, and nobody hits from more than a square off unless the attack is ranged: you included. A swing at someone across the room walks you up as far as your move allows first, and if they're still out of reach the roll isn't asked and a ⚠️ says so. Round 1 opens with whoever beat your initiative, then it's your turn; after that, everyone's rolls go in initiative order whatever order the DM wrote them in. Every living enemy acts on their turn, every round; one the DM leaves standing idle gets a ⚠️ and the DM is told. The turn strip shows the round, whose turn it is and your movement left. The fight ends when the DM says so or the moment the last enemy drops: a ⚔️ card says so, the downed leave the picture, and the sketch comes back.

**Rolls follow your choices.** The DM asks for a roll only for something you do, and only when failure is possible and interesting. Being seen is decided by dice, never by the DM's say-so. A grab, a trip, a tackle, slipping a hold, hiding from someone looking: all contests, rolled before anything is narrated as done. When a line has a grab in it (yours, or an aside asking for one) and the DM narrates a hold with no roll, a ⚠️ says so and the DM is told: nothing holds you until the dice say. The code adds your bonus from your sheet, and an attack is always against the target's real AC (the DM's number is replaced).

**Hits always hurt.** An attack that hits takes HP off right away: yours from the damage roll the code asks you for, theirs from the dice the code rolls. Damage from a failed save (a trap, a Fireball, poison) is applied the same way, half on a success when the effect says so. 0 HP is death for an enemy; for a party member it's unconscious and death saves, rolled by the code (yours asked of you).

**The books.** A 📜 card at the opening says what you start with (the premise's coin and gear). Every change the story makes goes on a 📜 card the same turn: HP, conditions (poisoned, prone, cuffed, grappled, restrained...), items gained, lost, bought or handed over (tracked by who carries them), gold paid or received, spell slots and abilities spent. Buying, selling, paying or asking a price always goes to the DM ("How much?", "Five silver it is", coin counted out), so a price a shopkeeper names is a price you pay on the books. A short rest spends hit dice only for anyone under three-quarters of their HP, and the card has a line for everyone: healed, not hurt enough, no dice left, or unhurt. Conditions with a duration wear off by themselves; rests restore what a rest restores and move the clock. After each turn the **bookkeeper** (your local helper, off by setting) reads the DM's narration next to the books and fills in what the story said and nobody wrote down, on its own 📜 card; it sees the gold and never books coin the DM booked that turn; out cold, dead and asleep stay the dice's and the DM's.

**Restraints.** Tied up, cuffed, caged or held, your figure shows it and can't walk; tap yourself for the ways to get free (slip the cuffs, pick the lock, struggle free). Cuffed hands can't fight or pick locks and roll at disadvantage to slip free; getting up from under someone is DC 15. Nothing holds anyone that the books don't show: a hold the DM narrates without the condition isn't one, and the DM is told.

**The clock.** The map's corner shows the time of day, the hour, the day and the weather. Time passes by itself, about ten minutes a turn (a setting), a minute a round in a fight, an hour for a short rest and the night for a long one; the DM can only skip ahead when the story does, with a 🕰️ card. The weather drifts with the climate, and a 🌦️ card tells you when it turns.

**NPCs are real characters.** The first time an NPC speaks, the plugin makes a SillyTavern character card for them (tagged "D&D NPC: <campaign>") and adds them to the group chat, so their replies use your normal formatting and thinking, and you can swipe them. After a long while without speaking they leave the group; their card stays, so they come back the same when needed. Delete the tagged cards once a campaign is over if you like. A shop, a street or a ledger the DM calls an NPC is refused with a ⚠️: only people and creatures get a voice and a figure.

**Companions have a mind of their own.** Each companion has a private inner state that only the Dungeon Master keeps: their mood, a goal of their own (not the party's), how they feel about particular people, and a worry they haven't said out loud. It's set when the campaign is designed, updated only when something changes it, and every brief Judy gets is written from it, so she stays the same person from one turn to the next: she holds a grudge, keeps pushing the plan she wanted, warms up or cools off, and every few turns speaks up or does something nobody asked for. Your local model never sees it (that's on purpose: it only ever gets the brief). The DM Screen shows each companion's mind; **Fix mismatch** corrects it too.

**Companions know their story.** At the start, Claude writes each companion a private "what you know" summary (how they got here, what they're accused of, who they know), and it goes with every reply they give. The DM updates it now and then when something big changes.

**Telling a companion to do something.** "Judy, go check the lane" or "search that crate": the helper spots that it's a task, and if what she finds isn't known yet the DM rules on it (a roll for her, shown on a card), moves her spot in the scene, and briefs her with the result so she tells you in her own words. Simple things (wait here, come along) she just does in her reply.

**Judy's own attempts get rulings.** When Judy tries something risky on her own (slipping a key, sneaking off, lying to a guard), the helper notices and the DM rules on it with a roll for her, just like your actions.

**The DM speaks only when it should.** It posts only to describe the result of an action or roll, a new place or time skip, something new arriving, what a check reveals, or to ask for a roll. The rest (directing Judy and NPCs, state changes) happens silently. Dice cards always show. It never turns what you say into something you do, and when you keep refusing something, the other character changes approach instead of asking again.

**When the DM asks for something the code can't do** (HP for a name nobody has, an attack from across the map, a roll the code already asked for, a place named as a person), the code drops it, shows you a ⚠️ line with what it was, and tells the DM next turn so it can't claim in the story what the books don't show.

**The story breathes.** After a fight or a capture, a few calm turns: nobody new arrives, nothing attacks, no random events.

**Little animated figures.** Everyone on the map is a small pixel figure standing on a colored ring (gold = you, green = companions, red = enemies, blue = everyone else), walking when they move, swinging on an attack, flinching when hurt, lying down when prone or out cold, with cuffs or rope drawn on when they're bound. Your persona's and companions' figures are drawn once by Claude from their card and picture (about 1-2 cents each); NPCs come from a built-in library. **Map figures** (wand menu, the DM screen, or `/dmfigures`) shows them and lets you redraw one in your own words (`/dmfigure Judy give her a red cloak`). Turn figures off in the settings to get round portraits back; the cloud button on the map turns the weather particles off.

**The DM is thinking.** While Claude works, a "The Dungeon Master is thinking…" bubble shows at the bottom of the chat, and the map says so and takes no taps until it's done.

**NPCs stay around.** NPCs stay in the group chat until they die or go 100 turns without being spoken to or speaking; they can always be added back.

**Every roll is shown.** Dice cards always say who rolled, for what, and the number. If a companion sneaks or steals near you, they roll against your passive Perception; you're never asked to roll in your sleep.

**After updating:** if the plugin notices your browser is still running an older cached copy, it pops up a warning to press Ctrl+Shift+R.

**Companions act like players.** In turns the DM is already handling, it can have Judy use her own abilities (Misty Step, Help, her own Perception), and her rolls show as dice cards. When a check applies to everyone (all climbing, all sneaking), the DM rolls for her too, and each of you succeeds or fails on your own roll.

**Levels.** Ask the DM out of character, e.g. `((level Judy to 5))`, or type `/dmlevel Judy 5`. Claude rewrites her sheet for that level by 5e rules and her HP follows.

**Fix a mismatch.** Deleted or edited messages? DM Screen → **Fix mismatch** (or the wand menu, or `/dmresync`). Claude re-reads the chat as it is now and corrects what it has logged: HP, items, location, plot beats, notes, story so far, NPCs met, what companions know, the scene card.

**Companions talk when it makes sense.** Judy (and any other companion) only replies when she's with you and would naturally react; she can stay quiet. If Amber splits off, the DM marks her as away (and where she is), she can't hear or speak until you regroup, and your scenes alone are answered by the DM instead. While you're walking, searching or working a lock and not talking to them, companions mostly say nothing.

**The note is sized to your context.** Settings → "Max tokens the bot's note may add" (600 by default) caps what the plugin adds to a local prompt, and it never takes more than a sixth of the context your model has left after its response. When the note has to shrink, the repeated-phrases line goes first, then what the companion knows, the scene card; the DM's brief and "just happened" always arrive whole.

**How the bot's note is added.** The note goes inside your latest message for that one reply (your saved chat isn't changed), so the prompt keeps exactly the turns your own format and SillyTavern build. Thinking models like Gemma 4 need their `<|think|>` setup to stay the only system turn; an extra system message from the plugin right before the reply made them skip thinking. The old way is still available in settings ("How the note is added").

**The world doesn't wait.** Every few turns the DM steps in on its own to move the scene a step: guards keep processing you, a march goes on, time passes, someone shows up. Its normal pace is every 5 turns (Settings → "World pace"); it goes faster, every turn or two, when people are actively doing something to you, and slower in genuinely quiet moments. While you're really talking (not just "ok"), the clock runs at half speed so conversations get room to breathe. It works around your conversation instead of cutting it off.

**Pacing.** The DM keeps the story moving: every narration changes something, boring stretches (long walks, waits) get skipped to the next interesting moment, and when you arrive somewhere new it describes the place (name, look, sounds, who's around). Real conversation is never rushed, even while traveling. If your last few messages are short filler ("ok", "lets go", "*nods*") with no questions or plans, it treats the scene as stalled and moves things along.

**Staying on the plot.** Wander off as much as you like. The longer you go without reaching the next plot beat, the harder the world pushes back, one step at a time: hints and rumors, then pursuers, then direct threats, and finally a fair but overwhelming turn of events that puts the story back on track. It holds off while you're in a real conversation, and the moment you reach the beat's goal (even in a way the plot didn't plan) the pressure resets. The DM Screen shows the current pressure and the next beat.

**Random events** only happen when they fit: when the dice say "maybe", Claude looks at a few candidates and the situation, and picks one, invents a better-fitting one, or skips it.

**Surprises.** Settings → **Surprises**: toggles for traps, hazards, puzzles and locks, secret doors, hidden treasure and ambushes, plus how often. They happen in the story, ruled by the DM with rolls.

**Voices.** In D&D chats the plugin voices everyone (DM, NPCs, and Judy with the voice from SillyTavern's TTS panel) one at a time, in chat order. SillyTavern's own TTS is switched off while a D&D chat is open and back on when you leave.

**Sound (experimental, off by default):** turn it on under *Experimental* in the settings: short effects for dice, swings and hits, and a quiet ambient bed for where you are, all made in the browser.

| You want to… | Do this |
|---|---|
| Roll when the DM asks | Use SillyTavern's dice (they're read automatically, including advantage and damage dice), or roll real dice and type the number (`14`, `nat 20`, `rolled 12 total 17`) |
| Ask the DM something out of character | Start with `((`… or `DM,`… e.g. `((how far is the city?))` or type `/dm how far is the city?` |
| Make the DM step in right now | Wand menu → **DM: step in now**, or `/dm` |
| See everything at a glance | Wand menu → **DM Screen**, or `/dmscreen` |
| See the sketch or the battle map | Wand menu → **Map**, or `/dmmap` |
| Roll dice for anything | `/dmroll 2d6+3` |
| Pause D&D mode (chat acts normal) | DM Screen → **Pause** |
| Edit the plot, bible, or DM notes | DM Screen → **Files** |
| Get a recap after a break | Click the "Welcome back" popup (after 6+ hours away), or DM Screen → **Recap** |

**The status bar** above the chat box shows each step live (helper → DM → who's responding) with time and estimated cost. Click the arrow to expand it, and the ✕ to hide it.

**Dice cards** (🎲) show every roll and, in plain words, what happened, e.g. `🎲 Bandit 1 · Crossbow at Judy: 1d20 (18) + 4 = 22 ✔ vs AC 15 · 5 damage → The bolt grazes Judy's arm.` They're hidden from the local model; the character it affects gets the result in their brief.

## Deleting a campaign

Delete the campaign's chat and you'll be asked whether to delete the campaign too: its story, notes and plot files, any maps an older version built, and the NPC character cards made for it.

## Deleting, editing and swiping messages

- **Deleting the DM's last turn undoes it:** delete a turn's DM narration (or every message a turn wrote) and HP, conditions, items, gold, the fight, who's away, the scene card and the sketch, and any roll the DM was waiting for go back to how they were before that turn. It works for the latest turns, newest first (up to six back, this session); deleting an older turn while newer ones stand leaves the state alone and tells you. Ticked plot beats, NPCs met, DM notes and the logs don't rewind: fix those in the **DM Screen** (Files) or tell the DM: `((I deleted that last scene, ignore it))`.
- **Editing messages** works like normal SillyTavern: the DM reads the chat as it is now on its next turn.
- **Deleting a 🎲 roll request** doesn't cancel it. Use **DM Screen → Cancel** next to "Waiting for your roll".
- **Swiping a party member's reply** (e.g. Judy) works: she gets the same brief from the DM as the first time (or none, if it was free roleplay).
- **Don't swipe Dungeon Master or NPC messages.** They aren't characters, so SillyTavern can't regenerate them. Delete the message and use **DM: step in now** instead.

## Where your stuff lives

- **Campaign files:** `data/<your-user>/user/files/dm_<id>_*` (bible, plot, notes, story, world state, NPCs, event/roll logs, costs). Plain text and JSON; you can read and edit them.
- **Character sheets:** `data/<your-user>/user/files/dmsheet_*.md`
- **Random event deck:** `extensions/SillyTavern-DungeonMaster/data/events.json` (301 events). Edit it freely: add events, set `weight: 0` to disable one, use `requires: ["night"]` for night-only events.
- **Memories:** each campaign gets a "DnD Memories - …" lorebook for MemoryBooks, and the DM reads it.

## Good to know

- **Costs are estimates.** SillyTavern doesn't pass Claude's real token counts back to extensions. Your Anthropic console shows the true spend. In testing, a DM turn was about 2¢ and a campaign build about 3–5¢.
- **Your settings are never changed** apart from SillyTavern's TTS on/off switch, which the plugin turns off in D&D chats (so voices don't overlap) and back on when you leave. The extension uses whatever instruct, system prompt and samplers you have selected.
- **NPCs get voices** from the NPC voice pool, matched by gender, and keep them for the whole campaign.
- **Pick "Current connection" for Actors** unless you really need a different server: a connection profile there switches your whole setup (including formatting) for every companion reply.
- **Claude won't write explicit sexual content.** The DM will cut away or steer if a scene heads there.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Claude call failed" | Check the SillyTavern server window for the real error (key, model name, network). |
| A character's reply hangs | Look for a popup from another extension waiting for an answer. |
| Wrong pronouns or voice for an NPC | Edit their `gender` / `voice` in `dm_<id>_npcs.json`. Your Orion prompt says "she" a lot, so NPC prompts state pronouns explicitly. |
| Nothing happens after I send | The chat must be a campaign chat (made by the wizard) and not paused. Check the DM Screen. |
| Budget reached | The party keeps playing locally. Raise the monthly cap in settings to bring the DM back. |
| The sketch has someone in the wrong spot | It's drawn from the DM's scene card. Tell the DM out of character where they are (`((Hob is at the door, not beside me))`) and the next turn redraws it. |
| A campaign from before 0.70 | It keeps playing: its old maps are ignored, the sketch takes over, and whoever held you in the old custody system is now just a condition on the books (cuffed, grappled). |

Run the tests (for developers): `npm test` in this folder: the core modules under node, and a smoke test that plays a scripted campaign through the whole turn loop with SillyTavern faked (`tests/harness`).
