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
   - **Dungeon Master models:** the **Main DM model** is Claude Sonnet 5.5. **Hybrid models** is on by default: every job has its own model dropdown (Setup, Story direction, Combat, Everyday play, Housekeeping, Dice). Recommended, and the default: Sonnet for campaign design, pitches, the opening, your PDF sheet, party sheets, story direction (steering back to the plot, stuck scenes, check-ins) and all combat including the first swing; Haiku 5.5 for everyday play (rulings, roll results, travel, events, new NPCs, questions) and housekeeping. With **"Let cheaper models hand a big story moment up"** on, Haiku passes a real story moment (major reveal, plot beat, a fight breaking out, a new chapter) to the main model. **Reset to recommended** puts it all back. Turn **Hybrid models** off and the main model does everything.
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
- **Risky things** (sneaking, lying, climbing, attacking), **travel**, **talking to someone new**, or a **random event** → the **DM (Claude)** steps in. Routine DM turns on Haiku cost a fraction of a cent; big moments on Sonnet about 1.5–5¢ (the low end with caching on).
- Every ~10 local turns the DM does a quick **check-in** to keep pacing on track.

**What the bot sees.** The DM's narration is for you only; the bot never reads it (that's what made it chase random details and drive the plot). Instead, when Claude handles a turn it gives each companion a short private **brief**: only what they need to know and want, never their words. Every reply also gets a short **scene note** (where you are, who's here, the goal, and a 3-4 sentence length target). You can read and edit all of this in **Settings → What the bot is told**, with **Reset to default** on each part and a **Preview** of exactly what the bot gets in the current chat.

**Combat.** Claude runs fights: it decides what companions and enemies do, rolls for them and narrates; companions only get a quick line. A **battle map** pops up (also in the wand menu, or `/dmmap`): chess-style squares (a1 is bottom-left), portraits, terrain, HP. Tap a square to move and an enemy to target, then **Add to message** and say what you do. On phones it's a sheet across the bottom of the screen.

**NPCs are real characters.** The first time an NPC speaks, the plugin makes a SillyTavern character card for them (tagged "D&D NPC: <campaign>") and adds them to the group chat, so their replies use your normal formatting and thinking, and you can swipe them. After 10 turns without speaking they leave the group; their card stays, so they come back the same when needed. Delete the tagged cards once a campaign is over if you like.

**Companions know their story.** At the start, Claude writes each companion a private "what you know" summary (how they got here, what they're accused of, who they know), and it goes with every reply they give. The DM updates it now and then when something big changes. Older campaigns get one on the next DM turn.

**The DM speaks only when it should.** It posts only to describe the result of an action or roll, a new place or time skip, something new arriving, what a check reveals, or to ask for a roll. The rest (directing Judy and NPCs, state changes) happens silently. Dice cards always show. It never turns what you say into something you do, and when you keep refusing something, the other character changes approach instead of asking again.

**The DM is thinking.** While Claude works, a "The Dungeon Master is thinking…" bubble shows at the bottom of the chat.

**Textured maps.** Maps are painted, not flat squares: stone slabs with cracks and moss, wood grain, grass tufts, cobbles, water with ripples, glowing lava, plus furniture and items (chests, barrels, tables, braziers, altars, coffins, bones, webs, campfires and more). Every tile is drawn with its own variation, so nothing visibly repeats, and dark places like crypts and caves are lit by their torches and braziers. Each map has a theme (crypt, cave, tavern, forest, castle...). Hover or tap a square to see what's there.

**Maps outside fights.** In places where exact squares matter (a dungeon room, a trapped corridor, sneaking past guards) the DM can open a tile map, used sparingly; it closes when you leave. If a fight breaks out there, the room becomes the battle map.

**Whole places you explore.** When the story moves somewhere it will stay for a long time (the mansion you're held captive in, a dungeon, a castle), Claude plans every room on every floor once, and the map is built and kept for the rest of the campaign. It asks you first ("Build Blackmoor Manor?", about $0.15–0.30), and a little map assembles itself in the chat while it works. Towns and villages are smaller maps: streets, roofed houses, hanging shop signs (an anvil for the smithy, a mug for the tavern), and each building's inside is built the first time you walk in. Nothing is ever built twice: going back to a place reopens its stored map with every door, trap and footprint as you left it.

- **Exploring:** tap a square and the party walks there (as far as you like outside a fight). Doors open as you go; locked ones need a key or a plan (tell the DM). Stairs take you to the next floor, and the floor picker shows the floors you've seen. The map follows you; scroll it to look around, and the 🎯 button follows you again.
- **Companions choose:** when you walk out of a room, your local model decides whether your companion comes along right now. They stand still until it has decided, then walk after you or stay. If they stay, they wait where they are (and can't hear you) until you come back into their room. Tap them for **Ask to follow** or **Ask to wait here**.
- **Little animated figures:** everyone on the map is a small pixel figure standing on a colored ring (gold = you, green = companions, red = enemies, blue = others). They breathe and blink, walk when they move, swing their weapon when they attack, flash red when hit and lie down at 0 HP. Your persona and companions get their own figure, described once by Claude from their card and picture (about 1-2 cents each, kept for every campaign). Men and women are easy to tell apart: men get a heavier brow, a nose, a square jaw, broader shoulders and sometimes stubble, a mustache or a beard.
- **Hiding:** tap a wardrobe, barrel, chest, bed, table, bookshelf, statue... and choose Hide: you walk over and hide in it, under it or behind it (a short duck-in animation; then only your eyes peek out, or a faint crouch behind it). The DM asks for Stealth when it matters. Walk anywhere, or tap yourself and choose Come out, to leave. Companions who say they're hiding somewhere do the same.
- **Maps fit the place:** a kept-up place (a lived-in mansion, a working prison, a castle) is organized like a real building, with a main hallway on each floor and rooms off it in rows, and tidy (furniture, no bones and rubble). Only ruins and old dungeons are mazes full of mess and decay.
- **Telling a companion to do something:** "Judy, go check that crate" -- the local helper spots that it is a task. Judy walks to the crate on the map, and when what she finds is not known yet (searching, opening, scouting, listening, sneaking) the DM decides it, rolls for her and tells her the result before she answers, so she no longer makes things up. Simple things (wait here, follow me) stay local.
- **Companions find their own way:** when Judy follows you she isn't stepping in your footprints any more: every step she takes her own shortest way to a free square next to you (more room when it's crowded), so she cuts corners and walks beside you. Her own way can lead her onto a hidden trap you missed.
- **Warn your companions:** tell Judy about a trap ("Judy, watch out for the tripwire by the door") and she knows about it: she walks around it when there's another way, and only crosses it when there isn't. She also knows the ones she found herself, the ones she saw go off, and ones set in plain sight. Traps you found but didn't mention, she doesn't know about.
- **Traps the DM sets are real:** ask the DM to trap a room and the traps it sets go off when anyone steps on them (hidden ones too, until a search finds them). Trap tiles the DM put down before this version become real traps the next time the place loads.
- **Traps catch everyone:** a companion who walks onto a hidden trap (going to search something, going to hide) sets it off too, stops there, and the DM rolls their save. A sprung pit stays an open pit: walk into it again and you fall again. Walks take the shortest way, so crossing a trap you already know about sets it off too.
- **Run into the dark:** tap a black (unexplored) square and you go: the walk follows the real way there, with no warning about what's in it. A wall or locked door in the dark stops you right next to it; a trap on the way springs.
- **Hidden traps:** traps stay hidden until someone searches the room (a Perception or Investigation roll that beats the trap; tap yourself and choose Search for traps) or steps on one. Pressure plates, tripwires, pits, glyphs, needles, blades... Decay hazards like rotten boards only appear in ruins.
- **More NPC figures:** cooks, smiths, jailers, farmers, laborers, sailors, miners, scholars, bards, healers, beggars, elders, executioners and plain townsfolk join the library. NPCs never get their own drawn figure: only you and your companions do.
- **Jails look like jails:** cells sit in rows along a cell-block hallway, behind iron bars with barred cell doors (locked until someone deals with them). You can see through bars, so from your cell you see the hallway and the cells across it. If the story has you locked up, you start in your cell, together.
- **Companions act on what they say:** a companion who says they'll go somewhere ("I'll hide in the hay", "I'll check the next room") walks there on the map and stays. Companions also get a note about the room they're in on the map (its description, what's in it, the ways out), so they talk about what's really there.
- **Tied up, cuffed, caged:** restraints show on the map. Tied up: rope around the chest, arms and ankles, and the figure squirms. Cuffed: hands together in front in iron cuffs. Caged: iron bars around them. Tied up, grappled, shackled or caged, you can't move yourself (tap your own figure for ways to get free: struggle, slip free, pick the lock), but others can still drag or carry you. Cuffs bind the hands only: you can still walk. Works for companions and NPCs too.
- **Fights limit movement:** in a fight you move up to your speed each round (30 ft = 6 squares; the squares you can reach light up), one move per turn, not while the DM is working. If the DM rolls an attack without starting the fight, the fight starts by itself. Outside fights you walk freely.
- **Map figures window** (wand menu → *Map figures*, the *Map figures* button on the DM screen, or `/dmfigures`): watch your persona's and companions' figures animate (idle, walk, attack, hurt, down) and change them: type what you want ("give her a red cloak and a bow", "he's a fox, not a wolf") and press *Redraw*. Your instructions are kept for later redraws; *Back to the card* drops them. From the chat: `/dmfigure Judy give her a red cloak`. NPCs, guards and monsters (guards, nobles, servants, cultists, elves, dwarves, orcs, goblins, beastfolk, skeletons, zombies, ghosts, wolves, hounds, rats, spiders, horses, bears...) come from a built-in library in different colors. Turn them off in the settings to get round portraits back.
- **Furniture and windows:** tap a piece of furniture for **Search, Smash, Push**. Smashing takes a roll; on a success it becomes broken pieces you can walk over. Light things (chairs, crates, barrels) shove one square at a tap; heavy ones (bookshelves, wardrobes, beds) take a roll. Shove something into a doorway and the door is barricaded. Tap a window to **break** it (it's loud) and then **climb out**: out of a town building you land on the street beside it. Barred windows can only be pried at (a hard roll).
- **People on the map:** guards (red ring) and everyone else who belongs there (blue ring: a cook, a prisoner, the shopkeeper inside a shop). Tap someone for **Talk, Look, Attack, Sneak past, Steal**.
- **Fog of war:** you only see the room you're standing in (or the corridor). The next room stays dark until you step inside, even if it's lit, and walls and closed doors block your view. Lit rooms show whole; dark ones only around you and near torches. Places you've been stay on the map, dimmed.
- **Fights inside a place** use the floor as the battle map, fog and all. Everyone moves at their speed (30 ft = 6 squares; rubble and shallow water cost double): the map only lets you pick squares you can reach this round, and Claude's moves for your companions are held to the same limit (double when they Dash).
- **Traps and guards:** a hidden trap on your path is either spotted (passive Perception) or sprung, and the DM steps in. Guards patrol on their own, and the DM is called when one comes into view.
- **Commands:** `/dmbuild big Blackmoor Manor` or `/dmbuild small Hollowbrook village` builds one yourself.

**NPCs stay around.** NPCs stay in the group chat until they die or go 100 turns without being spoken to or speaking; they can always be added back.

**Every roll is shown.** Dice cards always say who rolled, for what, and the number. If a companion sneaks or steals near you, they roll against your passive Perception; you're never asked to roll in your sleep.

**Judy's own attempts get rulings.** When Judy tries something risky on her own (slipping a key, sneaking off, lying to a guard), the helper notices and the DM rules on it with a roll for her, just like your actions.

**After updating:** if the plugin notices your browser is still running an older cached copy, it pops up a warning to press Ctrl+Shift+R.

**Companions act like players.** In turns the DM is already handling, it can have Judy use her own abilities (Misty Step, Help, her own Perception), and her rolls show as dice cards. When a check applies to everyone (all climbing, all sneaking), the DM rolls for her too, and each of you succeeds or fails on your own roll.

**Levels.** Ask the DM out of character, e.g. `((level Judy to 5))`, or type `/dmlevel Judy 5`. Claude rewrites her sheet for that level by 5e rules and her HP follows.

**Fix a mismatch.** Deleted or edited messages? DM Screen → **Fix mismatch** (or the wand menu, or `/dmresync`). Claude re-reads the chat as it is now and corrects what it has logged: HP, items, location, plot beats, notes, story so far, NPCs met, what companions know.

**Companions talk when it makes sense.** Judy (and any other companion) only replies when she's with you and would naturally react; she can stay quiet. If Amber splits off, the DM marks her as away (and where she is), she can't hear or speak until you regroup, and your scenes alone are answered by the DM instead.

**How the bot's note is added.** The note goes inside your latest message for that one reply (your saved chat isn't changed), so the prompt keeps exactly the turns your own format and SillyTavern build. Thinking models like Gemma 4 need their `<|think|>` setup to stay the only system turn; an extra system message from the plugin right before the reply made them skip thinking. The old way is still available in settings ("How the note is added").

**The world doesn't wait.** Every few turns the DM steps in on its own to move the scene a step: guards keep processing you, a march goes on, time passes, someone shows up. Its normal pace is every 5 turns (Settings → "World pace"); it goes faster, every turn or two, when people are actively doing something to you, and slower in genuinely quiet moments. While you're really talking (not just "ok"), the clock runs at half speed so conversations get room to breathe. It works around your conversation instead of cutting it off.

**Pacing.** The DM keeps the story moving: every narration changes something, boring stretches (long walks, waits) get skipped to the next interesting moment, and when you arrive somewhere new it describes the place (name, look, sounds, who's around). Real conversation is never rushed, even while traveling. If your last few messages are short filler ("ok", "lets go", "*nods*") with no questions or plans, it treats the scene as stalled and moves things along.

**Staying on the plot.** Wander off as much as you like. The longer you go without reaching the next plot beat, the harder the world pushes back, one step at a time: hints and rumors, then pursuers, then direct threats, and finally a fair but overwhelming turn of events that puts the story back on track. It holds off while you're in a real conversation, and the moment you reach the beat's goal (even in a way the plot didn't plan) the pressure resets. The DM Screen shows the current pressure and the next beat.

**Random events** only happen when they fit: when the dice say "maybe", Claude looks at a few candidates and the situation, and picks one, invents a better-fitting one, or skips it.

**Surprises.** Settings → **Surprises**: toggles for traps, hazards, puzzles and locks, secret doors, hidden treasure and ambushes, plus how often.

**Voices.** In D&D chats the plugin voices everyone (DM, NPCs, and Judy with the voice from SillyTavern's TTS panel) one at a time, in chat order. SillyTavern's own TTS is switched off while a D&D chat is open and back on when you leave.

| You want to… | Do this |
|---|---|
| Roll when the DM asks | Use SillyTavern's dice (they're read automatically, including advantage and damage dice), or roll real dice and type the number (`14`, `nat 20`, `rolled 12 total 17`) |
| Ask the DM something out of character | Start with `((`… or `DM,`… e.g. `((how far is the city?))` or type `/dm how far is the city?` |
| Make the DM step in right now | Wand menu → **DM: step in now**, or `/dm` |
| See everything at a glance | Wand menu → **DM Screen**, or `/dmscreen` |
| Roll dice for anything | `/dmroll 2d6+3` |
| Pause D&D mode (chat acts normal) | DM Screen → **Pause** |
| Edit the plot, bible, or DM notes | DM Screen → **Files** |
| Get a recap after a break | Click the "Welcome back" popup (after 6+ hours away), or DM Screen → **Recap** |

**The status bar** above the chat box shows each step live (helper → DM → who's responding) with time and estimated cost. Click the arrow to expand it, and the ✕ to hide it.

**Dice cards** (🎲) show every roll and, in plain words, what happened, e.g. `🎲 Bandit 1 · Crossbow at Judy: 1d20 (18) + 4 = 22 ✔ vs AC 15 · 5 damage → The bolt grazes Judy's arm.` They're hidden from the local model; the character it affects gets the result in their brief.

## Deleting a campaign

Delete the campaign's chat and you'll be asked whether to delete the campaign too: its story, notes and plot files, every map it built, and the NPC character cards made for it.

## Deleting, editing and swiping messages

- **Deleting or editing messages** works like normal SillyTavern: the chat changes, and the DM reads the chat as it is now on its next turn. But **the campaign's bookkeeping does not rewind**: HP, gold and items, ticked plot beats, NPCs met, DM notes, the event and roll logs, and pacing counters stay as they were. If you delete something that changed those, fix it in the **DM Screen** (Files) or just tell the DM: `((I deleted that last scene, ignore it))`.
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

Run the logic tests (for developers): `node --test tests/core.test.mjs` in this folder.
