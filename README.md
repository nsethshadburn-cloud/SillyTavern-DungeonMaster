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
3. **Your character sheet:** open the **Persona** panel and click the new **📜 scroll** button. Pick your 5e PDF; Claude converts it once (about 1¢) and then it's locked.
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
