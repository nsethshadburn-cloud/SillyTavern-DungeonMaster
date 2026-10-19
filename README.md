# 🎲 Dungeon Master for SillyTavern

Claude runs your campaign as the Dungeon Master. Your local model (Orion, or whatever you load) plays Judy and every NPC. Dice, events and bookkeeping are handled by code.

For how it works under the hood, see [DESIGN.md](DESIGN.md).

---

## First-time setup (5 minutes)

1. **Reload SillyTavern** (F5). The extension loads automatically once it's installed for your SillyTavern user.
2. Open **Extensions** (the stacked-blocks icon) and find **🎲 Dungeon Master**. Check:
   - **DM profile:** "Auto" uses your saved **Claude** profile and key. That's fine.
   - **DM model:** Claude Sonnet 5.5 (the default).
   - **Actors / Helper:** leave them on "current connection" unless you want a different server.
   - **Budget:** $20/month is set. The nightly soft cap ($0.65) makes the DM check in less often once it's reached.
   - **Voices:** pick a **DM voice** and press **Test DM voice**. Open **NPC voice pool** to switch voices on or off and fix any wrong genders.
3. **Your character sheet:** open the **Persona** panel and click the new **📜 scroll** button. Pick your 5e PDF; Claude converts it once (about 1¢) and then it's locked.
4. Optional: lower your **Response length** to about 2048 in the left sliders panel, so the story has room in the context.
5. Optional, saves money: in SillyTavern's `config.yaml`, set `claude: enableSystemPromptCache: true`, restart SillyTavern, then tick **"I turned on Claude prompt caching"** in the extension settings.

## Starting a campaign

Use the **magic wand menu → Start D&D campaign**, or type `/dmstart`.

1. Pick your persona and party members. Characters without 📜 get a sheet written by Claude.
2. Write your plot idea, or choose **Surprise me** → pick a tone and intensity → **Pitch me 3 ideas** → choose one.
3. Set the options (campaign feel, combat, rules, events) and click **Build campaign**.

A new group chat opens with the opening scene. Takes about 30–40 seconds and roughly 3–6¢.

## Playing

Just roleplay. Behind the scenes, each message goes through:

- **The helper** (your local model, under a second) reads your move.
- **Talking and roleplay** → your companions answer on the local model. **Free.**
- **Risky things** (sneaking, lying, climbing, attacking), **travel**, **talking to someone new**, or a **random event** → the **DM (Claude)** steps in. About 2¢ per call.
- Every ~10 local turns the DM does a quick **check-in** to keep pacing on track.

| You want to… | Do this |
|---|---|
| Roll when the DM asks | Roll your real dice and type the number (`14`, `nat 20`, `rolled 12 total 17`) |
| Ask the DM something out of character | Start with `((`… or `DM,`… e.g. `((how far is the city?))` or type `/dm how far is the city?` |
| Make the DM step in right now | Wand menu → **DM: step in now**, or `/dm` |
| See everything at a glance | Wand menu → **DM Screen**, or `/dmscreen` |
| Roll dice for anything | `/dmroll 2d6+3` |
| Pause D&D mode (chat acts normal) | DM Screen → **Pause** |
| Edit the plot, bible, or DM notes | DM Screen → **Files** |
| Get a recap after a break | Click the "Welcome back" popup (after 6+ hours away), or DM Screen → **Recap** |

**The status bar** above the chat box shows each step live (helper → DM → who's responding) with time and estimated cost. Click the arrow to expand it, and the ✕ to hide it.

**Dice cards** (🎲) are visible to you but hidden from the local model. The DM narrates the results.

## Where your stuff lives

- **Campaign files:** `data/<your-user>/user/files/dm_<id>_*` (bible, plot, notes, story, world state, NPCs, event/roll logs, costs). Plain text and JSON; you can read and edit them.
- **Character sheets:** `data/<your-user>/user/files/dmsheet_*.md`
- **Random event deck:** `extensions/SillyTavern-DungeonMaster/data/events.json` (301 events). Edit it freely: add events, set `weight: 0` to disable one, use `requires: ["night"]` for night-only events.
- **Memories:** each campaign gets a "DnD Memories - …" lorebook for MemoryBooks, and the DM reads it.

## Good to know

- **Costs are estimates.** SillyTavern doesn't pass Claude's real token counts back to extensions. Your Anthropic console shows the true spend. In testing, a DM turn was about 2¢ and a campaign build about 3–5¢.
- **Your settings are never changed.** The extension uses whatever instruct, system prompt and samplers you have selected. The one exception: while a party member replies right after DM narration, it pauses TTS's "speak while streaming" for that reply only (otherwise TTS errors on the DM's name), then restores it.
- **NPCs get voices** from the NPC voice pool, matched by gender, and keep them for the whole campaign.
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
