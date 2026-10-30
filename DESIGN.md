# Dungeon Master: Design

*A SillyTavern extension that turns a chat into a tabletop-style campaign, with Claude as the Dungeon Master and your local model playing the characters.*

Status: **built (phases 0–6), in user testing**, 2026-10-18. This document is the single source of truth. If a decision changes, update it here first. See §19 for what changed during the build, and README.md for the user guide.

---

## 1. What it is, in one paragraph

When you start a new chat you can turn on **D&D mode**. A setup wizard asks for your persona, which characters join the party (e.g. Judy Hopps), and a plot idea, or it pitches some for you. From then on, a **Dungeon Master** runs the story. It narrates, asks you for dice rolls, rolls for everyone else, throws in random events, keeps notes and a plot checklist, and paces things like a good human DM: no rushing, room to goof off, then a nudge back to the story. Claude is the DM's brain, but it's called **only when it matters**. Your local model does the everyday work of playing Judy and the NPCs, and plain code handles dice, event picking and bookkeeping for free.

---

## 2. Ground rules (never break these)

1. **Extension only.** Everything lives in this folder. SillyTavern's own code is never modified. Anything we need from SillyTavern goes through its public extension hooks.
2. **Nothing hardcoded.** Context size, response length, instruct format, system prompt, samplers and connections are always read live from whatever you have selected. Swap Orion for another model and the extension follows.
3. **Your settings stay universal.** D&D mode never swaps your system prompt or presets. The only thing it adds to the local model's prompt is a small, temporary block of DM directions, sized against your actual context.
4. **Every connection is assignable.** Each job (DM, actors, helper) is pointed at one of your saved **Connection Profiles** from a dropdown, so any IP or API you've saved works.
5. **Budget first.** Claude is the expensive part. The design keeps Claude calls rare, short and cached, and shows the real cost of every call.
6. **Never act for {{user}}.** Nothing in the system speaks, decides or rolls for your character. Your dice are your dice.

---

## 3. The cast: who does what

| Role | Default connection | Job | Cost |
|---|---|---|---|
| **Dungeon Master** | A Claude profile: Sonnet for big moments, Haiku for routine turns (both pickers in settings, chosen per turn) | Story, pacing, rulings, consequences, deciding when events happen, writing hidden stage directions, keeping the campaign files | Paid, so used sparingly |
| **Actors** | *Your current connection* (whatever is selected in SillyTavern) | Playing Judy, other party members and NPCs, following the DM's stage directions | Free |
| **Helper** | *Same as actors* (or any saved profile, e.g. your "Memory manager" or "phi") | Fast small decisions: "is this banter?", "who speaks next?", "did the player just do something risky?" | Free |
| **Rulebook** | Plain code | Dice, event selection, cooldowns, counters, pacing meters, spend tracking | Free, instant |

**Claude is the director, not the actor.** It rarely writes a character's lines. It tells the actors what's happening, what they know and what they want, and lets them perform.

### Connections settings screen

- **DM connection:** dropdown of saved Chat Completion profiles. **Model:** dropdown, defaulting to the newest Sonnet your SillyTavern lists. Your current "Claude" profile is set to Haiku; the extension's model picker overrides that only for DM calls.
- **Actor connection:** "Use current connection" (default) or any saved profile.
- **Helper connection:** "Same as actors" (default) or any saved profile.
- A note on profiles: a saved profile brings its **own** saved instruct/context format when used. Several of your existing profiles still carry Mistral V7-Tekken formats from before the Orion switch, so update them before assigning them here.

### About Orion's thinking

Orion only thinks because your system prompt starts with `<|think|>`.
- **Actor turns** use your normal prompt, so characters think as usual. The extension only reads the final reply.
- **Helper calls** send their own short prompt (still in your selected instruct format) **without** `<|think|>`, so Orion answers instantly.
- Your KoboldCpp handles **one request at a time**, so the extension queues its own requests and never fires two at once.

---

## 4. Starting a campaign (the setup wizard)

Triggered by a **"Start D&D campaign"** button in the extension menu, or by turning on D&D mode in a new chat.

1. **Persona:** pick one of your personas. Shows whether a character sheet is on file (see §9).
2. **Party:** pick which of your characters join (Judy, Tulin, Jewel…). The extension builds a SillyTavern **group chat** with them. Characters with no sheet yet get one generated (one Claude call each, first time only).
3. **Story:**
   - **Write my own:** a text box for your plot idea, as rough as you like.
   - **Surprise me:** choose a tone (adventure / mystery / horror / political / survival…) and an **intensity** slider. Claude returns **3 short pitches** and you pick one, or ask for 3 more.
4. **Options:** campaign length feel (*short arc / long campaign / let it breathe*), combat frequency (rare / normal / frequent), how strict the rules are (*loose* is the default), and how often random events happen.
5. **Build:** one Claude call writes the **campaign bible** and the **plot outline** (§10), then opens the scene with a narration message.

Each campaign is tied to its chat. Close SillyTavern, come back three days later, open the chat, and it picks up where you left off. After a long break the DM offers a short **"Previously on…"** recap.

---

## 5. A turn of play

```
You send a message
   │
   ▼
① Triage ── code rules first, then the Helper if needed
   │   • Dice result for a pending roll?          → DM
   │   • Out-of-character, e.g. "((DM, can I…))"   → DM
   │   • Risky / uncertain action?                 → DM
   │   • Scene move (travel, rest, leave, attack)? → DM
   │   • Just talking / roleplay?                  → stays local
   ▼
② Should the DM step in anyway?
   │   • A random event is due (§7)
   │   • The drift budget has run out (§6)
   │   • Regular check-in (every ~8–12 local turns: a cheap, short "director's glance")
   │   • The scene has stalled (helper notices going in circles)
   ▼
③ DM turn (Claude), only if ① or ② said so. Returns a structured plan:
   │   • narration to show (optional, can be none)
   │   • rolls it wants from you  → roll request card
   │   • rolls for others        → code rolls them → roll cards
   │   • hidden stage directions for each character who should react
   │   • who speaks next, in what order
   │   • file updates: plot checkboxes, notes, world state, event use
   ▼
④ Actors (local model) reply in order, each with its stage direction
   injected for that one generation only
   ▼
⑤ Bookkeeping (code): update counters, meters, logs, spend
```

When the DM is **not** called, the actors still get a tiny **standing direction** (current scene, current goal, last DM note) so they stay on track without any Claude cost.

### Stage directions, not scripts

A stage direction says what's true and what a character knows or wants, never their lines. Example:

> *[DM → Judy: The merchant is lying about the caravan; Judy noticed the fresh mud on his boots. She's suspicious but doesn't want to start a fight in public. Keep it short.]*

So **Judy can still disagree with you**, push back, or make her own choices, within her personality. The DM never forces her to agree.

### NPCs

Random NPCs (innkeepers, bandits, traders) are created by the DM with an **invented, setting-appropriate name** (never a real person), a one-line description, a voice (§11) and a stat block if they might fight. They're voiced by the local model through one shared **"NPC" stand-in member** in the group. The extension renames each of its messages to the actual NPC's name, so the chat, the voice map and the memory all see "Innkeeper Brannoc", not "NPC". *(To be prototyped in Phase 1. Alternatives are noted there.)*

---

## 6. Pacing

Pacing is a **system**, not just a sentence in a prompt.

- **Scene types:** social, exploration, tension, combat, downtime. The DM is shown the recent mix and steers toward variety, so you don't get combat after combat or three shopping trips in a row.
- **Tension meter (0–10):** rises with danger and reveals and falls in downtime. Climaxes need high tension *and* completed setup beats. A lull after a big moment is deliberate.
- **Beat pacing:** the plot is acts → beats. The DM may complete **at most one major beat per scene**, and mysteries can't be solved the same session they're introduced unless you genuinely earned it.
- **Fun detector:** the helper watches for engagement (long messages, banter streaks, you starting things yourself). While it's high, the DM **holds off on new plot** and lets the moment run.
- **Drift budget:** when you wander off-plot, the DM:
  1. **leans in** and plays along fully, maybe even weaving the tangent into the story;
  2. then plants **soft hooks** (a rumour, a familiar face, a sound in the distance);
  3. then **firmer hooks** (a messenger, a threat arriving, a clock ticking).
  It never blocks you. If you ignore the hooks, the world moves on without you, and that has consequences.
- **Session awareness:** the extension knows how long tonight's session has run, so the DM can aim for a satisfying stopping point (a cliffhanger or a campfire) around your usual 1–2 hours.

---

## 7. Random events (the 300 deck)

- **The deck:** `events.json`, about 300 entries written at build time (not generated during play). Each entry has:
  - a title and a short seed ("A desperate trader offers a too-good deal")
  - tags: setting (road / town / wild / dungeon / sea / any), type (combat / social / loot / weird / weather / moral), danger 1–5
  - weight, cooldown, one-time flag, and simple prerequisites (e.g. *party has money*, *at night*)
  - You can edit it or add your own events.
- **When:** at "eligible moments" (a scene change, or every N non-combat turns), the chance of an event grows the longer things have been quiet. It's suppressed during combat, climaxes and high-fun banter.
- **Which:** code filters the deck to events that fit the current setting, danger level and prerequisites and aren't on cooldown, then picks one weighted at random.
- **How:** the pick goes to the DM, which decides how to weave it in, may reshape it to fit the story, or **delays** it (up to 2 times) if the timing would ruin a moment. Everything is recorded in the event log.

---

## 8. Dice and rules

- **5e as the backbone, played loose.** If it's cool and roughly possible, the DM allows it, maybe with a harder roll. It only says no to things your sheet or the world genuinely makes impossible, and it explains why out of character.
- **Your rolls:** the DM posts a **roll request card**, e.g. *🎲 Roll Perception (WIS)*. You roll real dice and type the number. The extension adds your modifier from your sheet and the DM resolves it. DCs are hidden until after the roll.
- **Everyone else's rolls:** done by code with a proper random number generator, and shown as **roll cards** in chat, e.g.
  `Judy — Stealth: d20 (14) + 5 = 19 ✔ vs DC 15`
- **Combat:** light. Code rolls initiative, the extension tracks HP and conditions in the world state, and the DM narrates. No grid or miniatures.

---

## 9. Character sheets

### Your persona's sheet (PDF)

- **Uploaded from the Persona menu.** The extension adds an **"Upload character sheet (PDF)"** button there.
- **Converted once:** the extension reads the PDF, including the filled-in form fields that official 5e sheets use, and Claude turns it into a clean text sheet.
- **Then locked.** The DM and the extension can **never** edit it. The only way to change it is for you to upload a new PDF yourself (e.g. after leveling up), with a confirmation.
- **One sheet per persona**, reused across every campaign that persona plays.
- Things that change during play (current HP, spell slots used, gold, items gained) live in the **campaign's world state**, not the sheet.

### Party members' sheets (Judy, etc.)

- The first time a character joins any campaign, Claude reads their character card and writes a **best-guess 5e sheet**, reused across campaigns.
- Also locked from the DM. You can view it, and **Regenerate** it or replace it yourself.

### NPC stat blocks

- Made by the DM as needed and stored in the campaign's NPC roster.

---

## 10. Campaign memory: the files

Each campaign keeps plain files in your SillyTavern files folder (`data/<your-user>/user/files/`), named `dm_<campaign>_<file>`. You can open and edit them anytime.

| File | What it holds | Who writes it |
|---|---|---|
| `bible.md` | Premise, tone, world, factions, cast, secrets | DM at setup; rarely after |
| `plot.md` | Acts → beats as a checklist, with what's done | DM ticks off beats |
| `dm_notes.md` | DM's private notebook: foreshadowing, NPC motives, ideas | DM |
| `world_state.json` | Location, time, weather, party HP and conditions, gold, inventory, quest flags | Extension and DM |
| `story_so_far.md` | Rolling chapter summaries for long campaigns | DM at scene ends |
| `npcs.json` | Every NPC met: name, description, attitude, voice, stat block | DM and extension |
| `events_log.json` | Which events fired and when (drives cooldowns) | Extension |
| `rolls_log.json` | Every roll made | Extension |
| `costs.json` | Every Claude call: tokens, cost, reason | Extension |

- **The DM requests files with tools** when it needs them, instead of everything being stuffed into every call.
- **The local model never sees these files directly.** Its context is reserved for the scene itself.
- **MemoryBooks stays.** The DM can read MemoryBooks entries linked to the chat, so both memory systems agree.

---

## 11. Voices (Chatterbox through SillyTavern's TTS)

- **DM voice:** pick any voice from your TTS provider in settings. DM narration is read in that voice.
- **Party members** keep whatever voice your voice map already gives them.
- **Random NPCs** get a random voice from an **NPC voice pool**:
  - The pool is a checklist in settings. By default it includes only **plain-name voices** (Abigail, Adrian, Henry, Olivia…) and leaves out joke and celebrity voices (Trump, Shrek, Indian Scammer, Morgan Freeman clone…) and any voice already used by one of your characters.
  - Each voice is tagged **male / female / any** once, so a gruff dwarf doesn't get a soprano.
  - Once an NPC gets a voice, it keeps it for the whole campaign (saved in `npcs.json` and added to the voice map under the NPC's name).

---

## 12. Live status message

While the extension works, a single status message in chat updates step by step:

> ⚙️ Triage (helper) ✓ 0.6s → 🎭 DM is thinking (Claude) ✓ 3.2s, $0.011 → 🎲 Rolling for the bandit ✓ → 💬 Judy is responding…

When the turn is done, it collapses to a one-line summary you can expand. It is **never sent to any model**.

---

## 13. The DM Screen (side panel)

- Current scene, location and time
- Plot checklist (acts and beats)
- Tension meter, scene-type history and drift budget
- Party: HP, conditions, key items
- Event log and roll log
- **Spend:** tonight, this month, and against your budget
- Buttons: **Ask the DM** (out of character), **Force a DM turn**, **Skip/delay event**, **Pause D&D mode**

---

## 14. Cost control

- **Budget setting:** monthly cap (default **$20**) and an optional nightly soft cap (~$0.65 a night fits $20 a month). Your Anthropic console limit stays as a hard backstop.
- **Estimates:** SillyTavern's Claude proxy doesn't return token usage, so each call is priced from its text length with per-model prices (editable). The Anthropic console has the real numbers.
- **Per-job models:** core/models.js lists every job Claude does (TASKS: campaign design, pitches, opening, PDF sheet, party sheets, each DM call reason, recap, note condensing). Settings hold a model per job (`taskModels`), a main model (`dmModel`), a `hybridModels` switch (off = main model for everything), an optional model for turns with a natural 1/20 (`criticalModel`), and `handUp`. A DM turn with several reasons takes the most capable of their models (ranked by input price). Default: Sonnet for setup, story direction and combat; Haiku (about a twentieth of the price) for everyday play and housekeeping. When the turn's model isn't the main model and hand-up is on, it gets one extra instruction: for a big story moment reply only `{"escalate": true}`; the turn is then rerun once on the main model ("handed up" in the status bar and cost log).
- **Throttling:** at 80% of budget, check-ins become rarer. At 100%, the DM switches to **local-only mode** (the helper does basic orchestration) and tells you, so you're never surprised by the bill.
- **Prompt caching:** each DM call is sent in layers, most stable first: the system prompt (rules, bible, sheets), then a user message with the plot and NPC roster, then one with notes, story so far and MemoryBooks entries (each followed by a fixed "Noted." reply so roles alternate), then the per-call part (state, pacing, recent chat, why it's called). With `claude.enableSystemPromptCache: true` and `claude.cachingAtDepth: 2` in `config.yaml`, SillyTavern puts cache breakpoints on exactly those three layers, so a change to the notes only rewrites the notes layer. Both layers are always sent (with "(none yet)" when empty) so the positions never shift. These are config switches, not code changes; the user turns them on.
- **Small calls:** the DM returns compact structured plans, not prose essays, and only requests the files it needs.

---

## 15. Content note

Claude handles intense material well as a DM: violence, horror, peril, dark moral choices, grief, high stakes. It will not write explicit sexual content. Your local model still does what it always does in your normal chats, but the DM won't steer the story there.

---

## 16. SillyTavern pieces we'll use (technical appendix)

All of these are public extension features. None of them require changing SillyTavern's code.

| Need | SillyTavern feature |
|---|---|
| Calling any saved connection (Claude, Kobold, other IPs) | `ConnectionManagerRequestService.sendRequest(profileId, …)`, which includes model override and tool support |
| Claude tools / structured JSON | SillyTavern's Claude backend supports `tools` and `json_schema` |
| Quick local calls in the selected format | `generateRaw` / `generateQuietPrompt` (uses your selected instruct template) |
| Injecting stage directions | `setExtensionPrompt` (depth/role-based, cleared after each generation) |
| Reacting to messages | `eventSource` events: `MESSAGE_SENT`, `MESSAGE_RECEIVED`, `GENERATION_STARTED/ENDED`, `CHAT_CHANGED`, `GROUP_MEMBER_DRAFTED`, `PERSONA_CHANGED` |
| Making a specific character speak | group chats plus `/trigger`; NPC messages via `/sendas` |
| Reading context size / response length live | `getContext()` and the current settings |
| Saving campaign files | `/api/files/upload` (stores in `data/<user>/user/files/`) |
| Reading PDFs | SillyTavern's built-in pdf.js (`extractTextFromPDF`), plus form-field reading for fillable 5e sheets |
| Voices | the TTS extension's per-name voice map (Chatterbox provider) |
| Per-chat campaign link | chat metadata |
| Popups and wizard | SillyTavern's popup API |

---

## 17. Build plan

Each phase ends with something you can actually test in SillyTavern.

| Phase | What gets built | What you can test |
|---|---|---|
| **0. Skeleton** | Settings panel (connections, model, budget, voices), the status message, request queue, cost meter | Settings save; a test Claude call shows its real cost |
| **1. First playable** | Setup wizard, campaign files, DM narration through Claude, Judy following stage directions, NPC stand-in prototype | Start a campaign and play a scene |
| **2. The money saver** | Triage, helper, check-ins, standing directions, budget throttling, DM Screen v1 | A long scene where Claude is called only when it should be |
| **3. Dice and sheets** | Roll cards, roll requests, persona PDF upload and lock, generated party sheets, light combat | Upload your PDF; have a fight |
| **4. Pacing and events** | Scene types, tension meter, drift budget, fun detector, the 300-event deck | Wander off and get gently pulled back; random encounters |
| **5. NPCs and voices** | NPC roster, DM voice, NPC voice pool | NPCs keep names and voices |
| **6. Long campaigns** | Story-so-far summaries, "Previously on…", MemoryBooks reading, deploy to the AI server | Resume a week-old campaign |

---

## 18. Known risks and open items

- **Your Orion prompt says "she" and assumes one-on-one.** Per your decision it stays as is. DM stage directions name who's speaking and their pronouns to compensate. Watch for male NPCs drifting to "she" in Phase 1.
- **One request at a time on KoboldCpp:** helper calls wait behind actor replies. Fine at Orion's speed, but it will be measured.
- **Group-chat behavior** is the riskiest SillyTavern area (who speaks when). Phase 1 prototypes it before anything is built on top.
- **Testing from this PC** reaches Kobold and Chatterbox over a private network (Tailscale). On the server they'll be localhost. All addresses come from your profiles, none are hardcoded.
- **Testing costs real Claude money.** Phase 0 adds the cost meter first so testing spend is visible.
- **SillyTavern updates** could change extension hooks. We stick to documented, widely used ones.
- **Context:** you're moving to about 22K. The extension's prompt additions stay small and are measured with your tokenizer against your live settings.

---

## 19. Build notes (what changed from the plan, and why)

- **Code layout:** `src/core/` is pure logic (dice, deck, pacing, triage, protocol, world, budget, text) with Node tests in `tests/`. `src/st/` talks to SillyTavern; `src/st/st.js` is the only file that imports SillyTavern internals. `src/ui/` holds the wizard, DM Screen, settings, persona button and status bar.
- **Claude calls** go through SillyTavern's own `/api/backends/chat-completions/generate` (your saved key). That proxy rejects forced tool use on Claude 5 models and returns no token usage, so: the DM answers in plain JSON (parsed forgivingly, with one retry), "file requests" use a `need_files` round trip instead of tools, and **costs are estimates** from text length (prices are editable in settings).
- **Hidden DCs and code-rolled dice:** the DM supplies `on_success` / `on_fail` for rolls it can't know in advance; code rolls, posts the card, then posts the outcome.
- **Voices:** SillyTavern's TTS only voices real characters, so DM/NPC lines are sent straight to Chatterbox using the TTS panel's endpoint and settings. To stop TTS erroring on the DM's name, TTS "speak while streaming" is paused only while a party member replies right after a DM/NPC message.
- **Status bar** is page UI above the chat box (not a chat message), so it never ends up in prompts or saved chats.
- **Group chats** are created with Manual replies, so the extension decides who speaks. The chat file is pre-created so card greetings don't appear.
- **MemoryBooks:** each campaign gets its own "DnD Memories - …" lorebook bound to the chat. Without it, MemoryBooks blocks generation with a "Memory Lorebook Missing" popup at its auto-summary point.
- **Talking to strangers:** the helper also reports who you're addressing. A known NPC answers locally; someone new brings in the DM, who registers them (and gives them a voice).
- **Actor framing:** a scene note is injected into every local reply in a campaign chat ("Dungeon Master" = narrator, who's present, never decide outcomes, current situation). NPC prompts state pronouns, because the Orion prompt defaults to "she".
- **Garbled text and no thinking in group chats (v0.2.1):** in group chats SillyTavern starts the requested reply with "Name:" (instruct "names: force/always"). With Orion that both skips thinking and garbles words ("you'm", "doesns't", "thes", then loops). Bisected on the exact captured request from the user's broken chat: with the prefix, 2–3 of 6 replies were mangled, even with ALL extension text removed; without that one prefix, 0 of 6. Fix: in campaign chats only, the extension removes the final "Name:" from the prompt (GENERATE_AFTER_COMBINE_PROMPTS); names on earlier messages stay. Verified through real SillyTavern swipes: thinking on every reply, no mangled words. An echoed "Name:" at the start of any party reply (swipes included) is removed on render. (The v0.1 "keep thinking short" line and the v0.2 "Start Reply With" warning were removed.)
- **Companions steering the plot (v0.2):** the Orion prompt's INITIATIVE section makes companions drive scenes. The scene note now says "companion, not storyteller" (no inventing clues, places, people or events), the DM sets a short `objective` that companions see, local-only turns get a light "react, don't add plot" direction, and the DM is told to overrule companion inventions that don't fit.
- **Swipes (v0.2.1):** each party reply stores the direction it was written with (`extra.dm_direction`); swiping that reply re-injects exactly that direction. (v0.2 re-used the character's latest direction, which could be stale.)
- **Deleting messages:** chat changes are picked up by the DM, but campaign bookkeeping (HP, items, plot ticks, logs) doesn't rewind. Documented in the README.

### v0.3 changes (from real play on the server)
- **The bot never sees the DM's narration.** A SillyTavern generation interceptor (`generate_interceptor` in manifest.json) removes narration/OOC/dice/note messages from the per-generation copy of the chat; the visible chat is untouched. NPC prompts skip them too. Reason: the local model latched onto random narration details and drove the plot.
- **Briefs replace stage directions.** Claude writes only what that companion needs to know and wants, never their words, plus a length (short/normal/long). Plain roleplay turns get no brief at all.
- **One note per reply**, built from four user-editable templates (scene, brief, combat, NPC) with reset-to-default, configurable position (depth) and role (system/user), and a preview. Default length target: 3-4 sentences, mostly dialogue. (Previously two separate system messages: a scene note 3 messages back and a direction at depth 0.)
- **Voices:** one queue for everyone in chat order; audio prefetches but plays in order. SillyTavern's TTS is switched off in campaign chats via its own UI switch (and back on, with its Refresh, when leaving) so the two players can't overlap.
- **Combat:** Claude runs it (companions get a "short" brief). Battle map: Claude sends text rows of terrain characters and chess-style positions; never images. Map panel is anchored from the top because some themes put a transform on `<html>`, which breaks bottom-anchored fixed panels.
- **Events:** code decides "maybe now"; Claude gets up to 3 candidates and picks one, invents a fitting one, or declines.
- **Surprises:** six toggles + frequency, added to the DM's stable prompt.
- **DM style:** plain simple English, usually 1-3 sentences of narration.
- Tested offline against fake KoboldCpp/Chatterbox servers that log every request: narration absent from the bot's prompt, brief present only on DM turns, voices requested by the plugin only and in chat order, battle map on desktop and phone sizes.

### v0.40.3 (a trap is not a person)
- A sprung trap got a character card: the DM named the trap ("Covered Pit") as a speaker / new NPC and the code registered it. `looksLikeThing` now knows trap words; `notAPerson(place, name)` also matches the traps, items and props on the current map. New NPCs that aren't people are dropped (status note), a brief to one is skipped, and `makeSpeak` never auto-registers one.

### v0.40.2 (a choice on the map is never "busy")
- The busy guard sat in front of the "pick one on the map" prompt (`chooseOnMap` runs inside the turn, so `running` is true): taps were refused and the choice buttons greyed out. A pending choice now takes the tap first, and `dm-map-choosing` hides the busy banner and re-enables the buttons.

### v0.40 (a fight keeps count: whose turn, squares moved)
- `world.combat` carries `speed` (squares per fighter, set at start_combat), `moved` (squares used this round) and `dash` (who dashed, which round). `moveBudget/spendMove/markDash/newRound` in core/world.js. The DM's positions for the party are clamped to what's LEFT this round (not a fresh speed per message, which let the player's "Not yet" turn move 14 squares) and the cost is spent; the round resets `moved`. The COMBAT line tells the DM used/allowed per fighter.
- The map's reach (lit squares) and the tap check use what's left; the actions text says squares left or "no movement left (say you Dash)".
- `free_move` (DM field, v0.40.1): names whose move this turn isn't walking (Misty Step, Dimension Door, shoved, thrown, carried, dragged): the clamp is skipped and nothing is spent; they land where "positions" says.
- A turn strip under the map's header in a fight: round, YOUR TURN (green, pulsing) or "The DM runs X, Y" / "The DM is resolving your action" / "Roll your initiative first", Move used/allowed and feet left, and the initiative order as chips (you in yellow when it's your turn, foes red, friends green). `setMapBusy` refreshes it.

### v0.39 (the chase is the code's)
- A guard who sees the player loose (a sure sighting, or the player walking right up to him) is set on them: `noticeParty` returns `seize`, `watch.js` sets `g.seize = {target, attempts, asked}` and intent `follow` (hunters bring him after the player). After the DM's turn narrates his words, `seizerAsking` + `askGiveIn` (turn prompts) ask the player: go quietly → `takeToCell` (their own cell, the DM-named one, or the nearest cell): positions, the guard at the door, the cell doors locked, standing prisoner, every chaser stands down, a 🔒 card, and the DM is called to narrate it. Not → the chase.
- `grabAttempts` (each player step on a walk, and each hunters' turn): a seizing guard beside the player rolls Athletics (1d20+3) and the player gets a code-made `pendingRoll` (Acrobatics, dc = his roll, `grab: {guard, attempt}`); the walk stops without a DM call. `settleGrab` on the result: a miss → `takeToCell` with cuffs (the "cuffed" condition shows on the figure for a moment, comes off after the door locks); a slip → the chase goes on; the third slip (`GRAB_TRIES`) → `g.fedUp`, intent attack, and the DM is told to start_combat. A DM `player_roll` while a grab roll is pending waits. Starting a fight clears `seize` on the enemies in it.
- `escortToCell` (the typed "fine, I'll go" path) shares `takeToCell` and `cellFor`. Protocol: the code runs the chase; the DM narrates what it reports and never resolves grabs itself.

### v0.38 (guards keep order: "!", seize and escort)
- "!": `noticeParty` sets `g.alertAt = turn` (and `state = 'alert'`) on a watcher who sees the party trespassing or out of their cell, or is walked up to again; a successful "spot" roll (`noticed`) does the same. The map's `figureFx` emits an `alert` marker for anyone with `alertAt` within 2 turns or an attack/follow intent; `effects.js` draws a pulsing yellow "!". A fellow prisoner (`lineRole === 'prisoner'`) raises no trespass event and gets no mark (still a sighting).
- Hunters who are guards (`wasHostile === false`) reaching the party: the event says he moves to seize them, not attack, and tells the DM the three outcomes (give in → escort; talk/run/resist → a contested Athletics roll; start_combat only if they fight back). Born enemies still attack.
- `escort` (DM field, `atlas.escortToCell`): the player is walked to a cell and the door locked, standing prisoner of that cell. Cautious: only the player; only when the player's own latest message gives in (`access.givesIn`, with refusals like "never", "make me" winning); only a guard of the place within earshot (named, or the nearest); only into a cell zone room or the player's own cell. Anything else is dropped with a status note. The guard ends up at the door, no intent, not hostile.
- Protocol: guards keep order and don't swing first; the escort rule; fellow prisoners don't raise the alarm.
- The map shows when the DM is working (`setMapBusy` from the orchestrator's `setRunning`, which wraps every place that set `running`): a banner with an hourglass, the board dims a little, the action buttons are off, and a tap on a square only says to wait.

### v0.37 (the player's turn is theirs; reactions; who can be heard)
- Turn prompts (`turnPrompts`, on by default; `st/prompts.js`): in a fight, the player's message is their turn and the DM resolves only that (reason `player_turn`, `world.combat.phase = 'player'`; nobody else acts). When the action is resolved and no roll is pending, a popup asks "Done with your turn?": End → `runTurn({ force: 'end_turn' })` (phase `others`: those after the player act, then the next round down to the player; the round number advances there); Not yet → the next message is more of the same turn. The COMBAT line tells the DM the phase.
- Reactions: when an enemy's attack hits the player, before the damage is applied a popup offers Take the hit / Half damage (Uncanny Dodge and the like, applied by the code) / React another way (text; the damage waits and the DM is called with reason `reaction` and a REACTION line to rule on it). The DM's narration of the blow has already been posted by then: the ruling comes as a follow-up.
- Who can be given a line: `atlas.withinEarshot` (not on the map at all: yes; on the map: seen before, on the player's floor, within `EARSHOT`, not out cold). The direction loop, the DM's valid-speakers list and `npcsInReach` all use it: a prisoner 18 squares down the block no longer answers the player.
- A watcher the party can't see (in the dark, out of their sight) more than a square away doesn't get a free sighting: the event asks the DM to roll his Perception against the party's passive Stealth ("spot"), and nothing is recorded as seen until the dice say so. A sighting event now ends with "narrate what he does and STOP: the player decides"; the protocol says rolls follow the player's own choices (no Deception the player didn't go for).
- Bubbles type faster (22 ms a character, 7 s at most).

### v0.36 (what the party has seen; people move in turn)
- A guard who already reported a trespasser (once per `SETTLE_TURNS`) did nothing more when they walked right up to him and circled him: now, once a turn, being right beside someone who has already seen you trespassing is an event ("he acts now, or you say why he doesn't"). Running past a guard in the open always gets a reaction; only a Stealth roll the party asked for keeps them unnoticed.
- Canned lines only from watchers the party can see (`ctx.canSee` from the party's `look`): a jailer saying "Still here, I see" through the wall before the player had seen him was a voice from nowhere. Sightings are still recorded.
- The party's `look` marks everyone in sight `met`. An NPC on the map can be given a brief only once met (`npcsInReach`, the DM's valid-speakers list, and the direction loop drop the rest with a status note); someone arriving by "goto" counts as met. Protocol: an unseen voice is the DM's to narrate.
- People move more (patrol chance 0.75, `PATROL_STEPS` 3) and their moves play out one after another: `tickGuards` and `moveHunters` leave `g.trail` (the squares stepped this tick, from where they stood), `atlas.playMoves` walks each mover along it a square at a time (140 ms, 70 ms when there's a lot) after the tick and the hunters' turn, then drops the trails. People never in the player's sight are skipped. The player's own walk is a touch slower (125 ms a square); companions walk along as before.
- Whoever the player's message is about holds still for the turn (`peopleMentioned`: by name or by what they are, "the turnkey"), so "I attack the jailer" doesn't see the jailer stroll off on patrol before the DM has ruled and rolled initiative.
- The map is never closed or minimized by the code while there is something to show: the end of a fight inside a place, or the DM closing a scene map, now just redraws (the place's own map stays up); the phone no longer minimizes the map after "Add to message" or a tap-menu action. It closes only when there is no map at all (left the place, no fight) or the chat changes, and comes back by itself when a map appears.
- Bubbles: curly and straight quotes are one kind of quote, paired in order, so a reply mixing them no longer puts the *action* between two lines in the bubble; an unclosed last quote still counts as spoken; *actions* inside quotes are dropped.

### v0.35.3 (v0.35.2 didn't load)
- v0.35.2 declared `active` twice in `atlas.walkTo`: a syntax error in a SillyTavern-side file, which no node test loads, so the suite was green and the extension silently failed to load in the browser (enabled in Manage extensions, no panel, no wand entries). Renamed to `quarry`. `npm test` now runs `tests/check-syntax.mjs` first: every file under `index.js` and `src/**` is parsed with `node --check`, and every named import from our own modules must exist.

### v0.35.2 (a companion locked up where the player hasn't been is not "the party"; a fight that ends, ends)
- A companion the setup put somewhere else in the place (locked in a cell the player hasn't found) is on the map, held and waiting, so `partyOnMap` listed her as party everywhere: the DM's "Party now" line, the map-sync prompt (so "the rabbit" became her and a jailer was sent after her into her cell), hunters' nearest-target choice, and the noticing pass (guards talking to her in the chat). `atlas.partyActive` leaves out anyone held and away; map sync, hunters and noticing use it. `placeView` takes `{ away }` and lists such companions on a "NOT with the player" line (never narrate them as present or acted on); with the player at her cell she is party again, marked "LOCKED UP here". The map already drew her only when her square is in sight.
- `g.wasHostile` (was this person an enemy before the fight) is now recorded by `setIntent('attack')`, not only by start_combat: by the time a fight starts, the attack intent (from the map sync, a hunter, or the DM's "attacking") had already made the guard hostile, so `end_combat` kept him hostile with the intent still on, the hunters put him on the player again next turn, and the DM started another fight (a jailer attacking a prisoner he had just locked in). Now a guard who was only doing his job goes back to "fought, not an enemy" when the fight ends; a monster stays a monster.
- The companion and NPC notes say "plain English only" (a local model drifting into another language mid-line), and the NPC note says never to narrate the result of an action (a blow landing, a wound): the game master decides. The roll result handed to an NPC's model says it was already told. Migration `englishV35` moves untouched old defaults (`OLD_DEFAULTS.sceneV31`, `npcV31`).
- Protocol: when the player says in words where they go during a fight ("I step back into my cell"), the DM puts them there with "positions" instead of asking which square, so the map and the story don't drift apart in combat (the map sync doesn't run in fights).

### v0.35.1 (the minimized map on a phone)
- Minimized on a phone, the map bar vanished: it was anchored with `bottom`, but SillyTavern's mobile styles make `<body>` position: fixed and `<html>` carries a transform, so a fixed panel's `bottom` measures from a zero-height root box at the top of the screen. The bar is now placed by its top edge from where the message box starts (`--dm-form-top` from `getBoundingClientRect`, `translateY(-100%)`).

### v0.35 (a third pass: what the companions, the books and undo were missing)
- Companions are told who is right there with them (`roomBrief.here` / the room note's `{{here}}`: party members and the place's people in the same room, with distance and state; "nobody else" when alone), and "Also here" lists only roster NPCs in reach (`actors.npcsInReach`: same floor, within earshot, awake). The note's "Where" carries the hour and the weather. Settings migration `roomV35` (untouched room template only; `OLD_DEFAULTS.roomV33`).
- The bookkeeper's names include the people on the map near the party, so "the turnkey slumps, out cold" in the narration puts `unconscious` on him (`world.others`) and `syncDownFromConditions` takes him out of it on the map (`g.down`, `g.downBy = 'conditions'`); the DM's own `conditions_add` on map people does the same, and removing the condition brings them back.
- `pacing.inCombat` follows the real fight: a scene the DM labels "combat" without `start_combat` no longer freezes patrols, noticing and the clock (reset at the top of each turn when `world.combat` is null).
- Undo (deleting a turn's narration) also puts back the turn count, the timeline, "happened", the companions' knowledge and minds, standing and objective, pacing, table rules, the event history, and the notes, story, plot and NPC roster; the base note is rebuilt after.
- Timeline labels: a night entry remembered by day is "Last night", not "Earlier tonight".

### v0.34 (the clock and the weather)
- `core/clock.js`: `world.clock = {day, minutes}`; `world.time` (the word) and `world.day` are kept in step for everything that reads them (night, sleep, the deck, the timeline). Time passes by turn (`settings.minutesPerTurn`, default 10; a minute a round in a fight), two minutes when the party walks a dozen squares, an hour for a short rest and eight for a long one. The DM no longer sets the time: `scene.time` is ignored (a note when it disagrees), and it skips ahead only on purpose with `"clock": {"advance": "3 hours"}` or `{"set": "dawn" | "06:30" | "tomorrow morning" | "day 3 noon"}` (forward only). `world.weather` (clear | overcast | rain | storm | fog | snow | wind) drifts with a 15% chance per hour crossed by a Markov table per climate (`climateOf` from the setting and the map theme); the DM turns it with `"weather"`. Both are in WHERE THINGS STAND with the rule that the DM narrates the time and weather it's given, and both are flags for the event deck (`weatherFlags`: the kind, wet, bad_weather; and dawn/morning/afternoon/evening).
- On the map: `syncSky` (was `syncNight`) also sets `place.state.weather` and the outdoor floors' ambience (rain, snow, mist, leaves). Fog outdoors: nobody sees past `FOG_SIGHT` 4 squares (`computeVisible`); a storm outdoors halves earshot in the place view. The DM's place view says the weather where it matters (outdoors).
- Second pass (state that drifted apart): conditions written in hours or minutes ("poisoned (1 hour)") now end by the world's clock, not by a count of turns, so a night's sleep or a "clock" skip ages them (`upkeep.noteUntil` stores `rec.minute`; `expireConditions` reads the clock; no clock: turns as before); a time skip or a rest expires them at once. A roster NPC who is on the map is a local speaker only from within reach (same floor, within EARSHOT, awake or merely tied up): the warden two floors up doesn't answer when you say his name (`actors.speakerCandidates`). Rain, snow and storms outdoors damp fires down and stop them spreading (`fire.dampen`, `fireTurn`).
- The clock chip in the map header (`clockChip`): time-of-day icon, hh:mm, the day, the weather icon; hover for words. Cards: 🕰️ for a skip, 🌦️ when the weather turns, and a rest card says the new time.

### v0.33 (night, sleep, keys, bodies, and the things people see)
- A review for absurdities that only show once they happen (like guards attacking a prisoner in her own cell), fixed at the root:
- Night (`world.time` → `atlas.syncNight` → `place.state.night` / `late`): from evening on, `litMask` fills nothing outdoors or in a lived-in house; a room is lit only with someone awake in it (a candle) or a light prop, or `litNight` (the DM's rooms:{lit:true} at night). At night residents and keepers in places that aren't up late (`NIGHTLIFE`) go to sleep (`g.down = 'asleep'`, `g.sleeper`, on a bed if their room has one), shops' and homes' doors in town lock (`door.nightLocked`), night guards carry lanterns (`g.nightLantern`). Morning undoes all of it. `lanternGlow` also lights the squares around a party member carrying a torch or lantern (`place.state.lights` from the inventory in `look`). The map dims (`.dm-map-night`) and says 🌙 night.
- Out of it: `g.down` = asleep | unconscious | bound, set by place_changes.guards ("asleep", "unconscious", "tied up", "awake", "free"), by a condition the DM puts on them (`notice.outBy`), by night, or by a fight (someone at 0 HP who isn't in npcs_dead is unconscious, not dead). `isOut(g)`: no watching (`noticeParty`), no patrol (`tickGuards`), no hunting (`moveHunters`), no hearing a fight. The dead stay dead: no state wakes a corpse (only "alive"); "dead" leaves a body.
- Bodies (`clearBodies`): cleared only after the party has been out of sight of them for 3 turns and someone of the place (awake, not an enemy) is on that floor to do it; in a fight a downed enemy stays on the board.
- Stealth honored: a watcher who has `unaware` of someone (a roll went the party's way) doesn't see them, until the two are beside each other (a "roll again" event). A watcher escorting (intent follow) or chasing doesn't re-report a trespasser; trespass is reported once per person per 6 turns. Someone found unconscious or tied up is an event. `world.aware` is pruned of a place's people when the party leaves it.
- Captured: when the DM sets a party member's access to "prisoner"/"none" that turn, its `positions` may move them (they were taken), and a prisoner's cell becomes the room they're put in.
- Keys and doors: `hasKeys(g)` (the place's guards, keepers, residents) lets `findPath` through locked doors (`walkable` with keys); `passDoor` / `closeBehind`: someone of the place shuts the door behind them and locks again what was locked (patrols, wanderers, arrivals; not a chase). Hunters, patrols and arrivals walk around the place's traps and any fire (`dangerSquares`).
- Lines: `core/lines.js` has day and night pools, and a turnkey's lines to a prisoner in their cell; `noticeParty` says nothing to someone asleep and nothing from someone mid-conversation (`spokeLately`); a line is posted in the chat as that person's own (`postNpc`) and kept in `place.state.said` for the DM.
- Seen doing it: a lock picked or a door unlocked in sight of someone awake who belongs there (`watchersSeeing`) is a DM event. A fight's start lists who can hear it (`place.state.fight.hears`, within 2×EARSHOT, in placeView) until it ends.
- After a fight: an enemy who wasn't hostile before it (`g.wasHostile === false`) is non-hostile again, alert, `g.fought` (shown to the DM) until an intent says otherwise.
- Town: a home named for a party member is theirs (residents). A newcomer the DM has speaking this turn has arrived (no more walking in from the far door while talking).
- `core/notice.js` holds the noticing logic (pure, tested); `st/watch.js` posts. Tests: `tests/night.test.mjs`.

### v0.32 (who may be where; people who keep to their place)
- From play: jail guards attacked the player in her own cell. Guards from the architect were `hostile: true`, so every sighting was an enemy coming into view; nothing knew where the party was supposed to be. Now:
- `core/access.js`: every room has a zone (`zoneOf`: a lockup is cells and staff-only rooms; a public building has public rooms in front and staff-only or private rooms behind; a house, mansion, castle or tower is private; dungeons, caves and the wilds are nobody's; a town's streets are public). Each party member has a standing in the place (`place.state.access`): prisoner (own cell only), intruder (nowhere), guest (public rooms, plus the hall and parlor of a house), resident or free (everywhere). `inferStanding` reads it from how the party arrives (locked in a cell; sneaking, breaking in, robbing; invited; a tavern); `requestBuild` sets it for the place and its grounds, `enterBuilding` for a town building (a guest of a shop, an intruder in a home), `placeHeld` makes a caged companion a prisoner of her cell. `trespassOf` = standing where you aren't allowed (an escaped prisoner out of the cell). The DM changes a standing with `place_changes.access` ("public" | "all" | "none" | "prisoner" | rooms | {allow, deny}; "*" the party). The DM sees ACCESS in the place view and TRESPASSING on Party now; the companion's room note says when she isn't supposed to be there; the map shows a pulsing ⚠ TRESPASSING / ESCAPED badge and a red inner border.
- Staffing: architect guards are no longer hostile (`role: 'guard'`) unless the place is a monster's (dungeon, crypt, cave) or the brief's creatures are; a jail gets a turnkey on every cell block and someone on the door; residents and the story's people carry `role` (resident, prisoner, keeper, hostile). normalizePlan and generatePlace carry `role`; guards in a dark place carry a lantern.
- Movement (`tickGuards`): PATROL_STEPS 2 (slow rounds). A posted guard paces his room a square at a time (never into doorways); a resident potters about the room and now and then (12%) goes next door through an unlocked door into a room of the same zone, then wanders there.
- Noticing (`st/watch.js`, `explore.guardSees`, `lanternGlow`): each turn and each step of a walk, every guard and resident on the party's floor checks who they can see from where they stand (lit squares in line of sight within GUARD_SIGHT 8, their lantern's glow LANTERN_RADIUS 3, two squares in the dark; the same `computeVisible` the party uses, from their side; lantern glow also lets the party see the guard's light). A trespasser or escaped prisoner in view: a DM event ("X can see Amber in the Warden's Office, where she is not allowed; he is a guard: he challenges..."), the walk stops. Someone allowed: marked seen (AWARE) and, half the time, a vague canned line in the watcher's speech bubble (`core/lines.js`: guard / keeper / prisoner / people, hurt variants under half HP), no model called. Hidden party members: a DM roll only when trespassing. A watcher doesn't react again to the same person in the same room for 6 turns.
- Fights (`explore.matchPerson`): an enemy the DM names loosely ("Watchman") is the one person on the map it fits (synonyms: watchman, sentry, turnkey, jailer = guard), preferring those in sight: they fight from where they stand (`combat.aliases`) and are the same person when the fight ends (a body, not a vanished guard and a new one). The map sync's "gone" no longer removes someone down or dead (bodies stay until cleared).
- Signs: a public building hangs a "No entry" sign (icon `nope`) on the wall beside every door from a public room into the back (`placeNoEntrySigns`). Guards wear an orange ring on the map (enemies red, others blue).
- Mobile: the minimized map sits just above the message box (`--dm-form-h` from `#form_sheld`), not over it.

### v0.31 (speech bubbles on the map)
- When a companion or NPC speaks, a bubble over their figure shows what they said (`core/speech.js` `dialogueOf`: the parts in quotation marks, joined; with no quotes, the reply without its *actions*), the words appearing one by one. `ui/bubbles.js`: with the plugin's voices on, the bubble waits for that line's audio to start (`voices.onSpeech` events: start with the audio's duration, end, skip when there's no voice for them, the server failed or voices are off, stop on a swipe or chat change) and types in time with it; a line that won't be voiced appears as it's generated; 30 s without a voice shows it anyway. It stays `LINGER_MS` (5 s) after the voice ends (or after the last word, unvoiced), then fades. Pop-in and fade-out animations, a blinking caret while typing. The map renders a `.dm-map-stage` over the canvas and tells the bubbles where each figure is on every render and zoom (`mountBubbles`); closing the map removes them. Setting `mapBubbles`.
- The scene and NPC templates ask for everything said aloud in "double quotation marks" (untouched old defaults migrate: `quotesV31`).

### v0.30 (from "The Leash and the Lantern")
- Bookkeeper: it read companions' and NPCs' lines as facts ("open the latch" took Judy's `caged` off three times) and guessed who an unnamed "watchman" was from its list of people here (Odo Grist, two rooms away, became unconscious; Turnkey Wren, "half asleep" in narration, became `asleep` right after spotting the player). Now it reads only the DM's narration, tracks only the party, and `parseBookkeeping` applies a change only to someone the text names (`story`).
- Damage with nothing to roll: a `player_roll` of kind damage with no dice left the card saying "for your hit" and the dice reader with nothing to collect. `world.attackDamage` fills it from the sheet (the attack the reason names, else the first; dice doubled after a natural 20). Initiative requests drop any DC ("vs DC 0").
- Following: `applyMapSync` walked a companion with `companionGoTo`'s default `stay: true`, so every "Judy walks over to X" the sync saw marked her as staying behind (then "you're staying here" lines and "comes along again" notes). A sync move keeps her following; only hide and pose stay. The stance classifier's "stay" counts only when the reply really says so (`STAY_WORDS`: wait here, I'll stay, go on without me...), not "she stays near the door, watching".
- Companions inventing the place: the room note gains `{{known}}` (rooms the party has been in; plus the floor's room names when the companion's knowledge says they know the place) and a line forbidding any room, door, passage, route or item not listed. Old untouched room templates migrate (`roomV30`). DM rule: overrule invented rooms.
- First meeting with a held companion: `walkTo` used to hand it to the local `companionsSeeYou` with "tell them anything that would help (who has the key, how the lock works)", which invented a latch. The first time (`place.state.greeted`) it's an explore DM turn ("first meeting") so Claude writes her first words from her mind and knowledge.
- Map sync: "gone" needs the story to name them (Turnkey Nikolai was marked gone when the watchman fell); map people may be sent to any room on the floor (the sync could only pick visited rooms, so Wren "went to Cell 14" instead of the stairs).
- Quiet exploring: the helper is told companions usually say nothing while the player just moves, searches or works a lock; the DM rules say the same and ask for "short"; `applyDmTurn` gets `quiet` (an action/risky/scene-move turn with no speakers, or an explore event other than a first meeting) and makes every direction "short". The one-in-three curiosity stays as it was.
- Room descriptions never contain people (`cleanDescription` drops sentences with people words: "a lone guard sits" invented a guard). The DM narrates distances in paces or feet. Room descriptions are read aloud by the DM voice.

### v0.29.2 (who is in a fight)
- From play: Amber broke out of her cell and attacked a guard; Judy, caged elsewhere in the jail and not yet found, was teleported to Amber's side (still "caged") the moment initiative was rolled. `startCombat` rolled initiative for every party member on the roster, `combat.positions` took every party square on the floor, and `placeNear` put anyone without a square next to the player; the end of the fight wrote that square back to the map.
- `explore.inTheFight(place, player, name)`: a companion is in a fight that breaks out only if not held elsewhere, on the player's floor, and in sight or within FIGHT_REACH (10) squares. `orchestrator.fighters(c)` adds "not away" (and is the whole rule off the map). start_combat rolls initiative and takes squares for those only (`combat.party`); the status bar says who was left out; the speed clamp and placeNear use the fight's party. `joinLateFighters` each combat round: a companion who now qualifies (freed, arrived) gets a code-rolled initiative, her square and a ⚔️ card. Rule added for the DM.

### v0.29.1 (four map mismatches)
- A companion held somewhere in the place (caged in a cell you hadn't found) counted as one of the party's viewers: `look` revealed her cell on your map and, seeing her own square, drew her. `viewersOf` (atlas) and `placeView` leave held companions out of the party's eyes; the DM still knows where she is.
- Patrols teleported: `tickGuards` put a guard straight into a random square of the next patrol room, so the guard you were watching in the hallway was suddenly in the kitchen. Now a guard sets off for the next room (`g.walk`) and walks there up to PATROL_STEPS (6) squares a turn along a real path, through doors and around people; stuck three turns, they give up until next time.
- The DM's `positions` could snap the player or a free companion to a square outside a fight (Haiku echoing stale squares). Outside combat a party member's position from the DM is applied only when they can't move on their own (`lockedReason`: restrained, caught, unconscious); otherwise it's noted as ignored. Rule added.
- NPC presence was an exact match of `npc.lastSeen` against `world.location`, and the DM set `scene.location` to room names inside a place, so every NPC not briefed that very turn stopped being "here" (speaker candidates, the scene note's "Also here", the bookkeeper, the DM's "NPCs here"), and the scene card's objects and NPC entries were wiped as for a new place. Now: entering any place sets `world.location` to the place's name; while inside, a different `scene.location` from the DM is kept as the place (status note; leave_place / enter_place / build_place still change it); `world.sameLocation` / `isHere` match loosely (one name inside the other). Rule added. Tests in mapfix.

### v0.29 (companions with a mind of their own)
- Why: companion intent was written fresh by Claude every DM turn from the chat window and a static "what you know" text, so Judy was consistent within a turn and random across turns (no grudge carried, no plan of her own, no initiative). The local model (Artemis, a Gemma 4 roleplay tune) echoes and derails if given more rope, so agency stays Claude-owned.
- `core/minds.js`: `meta.minds[name] = {mood, goal, feelings: {person: how}, worry}`; `normalizeMind` (clipped, "" clears), `mergeMind` (only the fields sent change; feelings matched loosely by name, the fuller name kept), `renderMinds` (MISSING marker). Written by the campaign design ("minds"), updated by the DM ("mind_update", partial), corrected by resync ("minds"), shown to the DM every call under COMPANIONS' MINDS in the cached notes layer, and on the DM Screen. Rules: briefs are written FROM the mind; every few turns a companion acts on it unprompted; the check-in reason says a quiet moment is when that happens. The local model never sees it.

### v0.28.1 (a dropped message; the note sized to the context)
- A player message sent while a companion side flow held the turn (`companionCuriosity`, `companionsSeeYou`: a companion looking at something on their own, or reacting to the player coming and going) was never run: `runTurn` saw `running`, set `rerunRequested`, and those flows never looked at it when they finished (only the opening did). `runQueuedTurn` now runs the queued turn after every holder of the flag.
- The bot's note is sized at last (ground rule 3 promised it): `core/notes.js` `noteBudget` = the "Max tokens the bot's note may add" setting (`injectionMaxTokens`, default 600, which was in the panel but read by nothing) capped at a sixth of the live context left after the response length, never under 150; `fitNote` shortens parts in SHRINK_ORDER (repeated phrases, knowledge, room, state, scene), dropping a part rather than leaving a stub, and never touches the brief, "happened" or the combat line. Tested in notes-grid.

### v0.28 (maps built around the objective)
- The brief has `objective` (an item, a person, a room, escape) and `objective_near` (the story pins it close); build_place and the campaign's start_place carry `objective` too.
- architect: the start is decided before the challenge (a locked-up start takes the deepest free cell). `distances` (rooms walked through; stairs 2, secret doors 3) and `pathBetween`. Escape (locked up, or an objective like "escape"): the way out moves to the ground-floor EXIT_TYPES room furthest from the start, never one the cells open onto. An objective item moves to the furthest fitting room if it's in the nearer half (or is created there); a room objective is re-hung off a room at 60%+ of the way (its old neighbours stay joined). Dungeons (maze): a route through about 60% of the rooms (cells never on it), the rest as side branches, few shortcuts; stairs from one level's route end to the next level's start; with no objective, the far end gets the prize. A gate: the route's link about 60% along is locked, its key in a pocket reachable without it (a dead end first). Traps take route rooms first; a guardian stands in the room before the goal.
- Big places: the filler opens a new floor when every floor has 18 rooms (upstairs for buildings, deeper for dungeons). rules: a hallway holding the way out isn't made a cell block, and a cell block is never the way out. layout: a layout that leaves a cell without its one door is rejected like an unreachable room (the next attempt).

### v0.27 (picking locks from the map)
- `core/locks.js`: `lockDc` (PLACE_DC by kind, ROOM_DC by what the door guards, +2 for a cell door, -1 ruined, ±2 from a hash of the seed and door id; stored as door.lockDc, also shown to the DM as the pick DC), `lockWords`, `pickModifier` (Thieves' Tools when listed and better, else Sleight of Hand), `notePickFailure` (per picker; alarm after 2 or 3 in a row, decided per door, or a natural 1), `keyFor`.
- atlas `pickLock` / `unlockWithKey` / `lockedDoorInfo`: approach the door, roll in code (logged), open on success; on an alarm, runTurn explore with who is within EARSHOT of the door. map.js: `thingAt` returns locked doors; their menu has Unlock (with the key) and Pick the lock.

### v0.26.1 (the map before the opening; companions notice you)
- Campaign design returns `start_place` and `party_start`. The wizard marks companions who aren't with the player as away, builds the start place first (`requestBuild` with `ask`: always asks; `quiet`: no room narration; `req.context` reaches the brief, which also sees the bible when there's no story yet), `placeHeld` puts them in their rooms, then the DM writes the opening with reason 'opening' (main model) on the map, from the design's draft; without a map, the draft is used as before.
- walkTo collects `greet`: waiting companions you reach (free: they rejoin quietly, 'back' with the rooms you went through since `leftAt`; locked: they're no longer away so they can talk, 'held') and ones you walk away from ('left' / 'left-held': away again, held text kept). `companionsSeeYou` (orchestrator, local only): the companion decides in character whether to speak at all, then speaks a short line from a brief.

### v0.26 (undo, durations, rests, resources, death saves, a stricter map sync)
- `st/undo.js`: `snapshotTurn` before each runTurn (world, the current place, pendingRoll, stance), `sealTurn` after (the messages it wrote, its narration); on MESSAGE_DELETED, `onMessagesDeleted` restores the newest turns whose narration (or every message) is gone, newest first, up to six, in memory; an older turn deleted with newer ones standing only warns. `replacePlace` (atlas) swaps the cached place in place. CHAT_CHANGED clears it.
- `core/upkeep.js`: `parseCondition` / `untilFrom` (brackets are a duration only when they say one), `defaultUntil` (BRIEF: the fight or 3 turns; LINGERING: a long rest or 24 turns), `noteUntil` / `expireConditions` / `untilWords` (world.condUntil). applyStateChanges records them; upkeepTurn expires by turn each player turn, applyDmTurn by round, at end_combat and on rests.
- Resources: `classInfo` (hit die, caster type), `maxSlots` (the 5e table; half and third casters; warlock pact slots), world.resources {slots used, hit dice used, abilities used: short|long}; `spend` (state_changes.spend), `resourcesLine` (DM view), `takeRest` (DM field "rest").
- Dying: changeHp → `hurtWhileDown` (a failed save, two on a critical; massive damage kills), `clearDeath` on healing; `deathSaves` (orchestrator) once a round / turn: companions rolled in the open, the player asked (pendingRoll.death; resolvePlayerRoll uses the bare d20). DM view shows DYING counts.
- Map sync: `parseMapSync(text, known, { story })` drops spawns and moves of anyone the story doesn't mention, merges a plain description into the one person it matches (SAME synonyms: hound = dog, sentry = guard), never a numbered or "another" one; prompt rules for plans and sounds. Items: take / found / drop (place.items; the inventory stays the bookkeeper's).

### v0.25.2 (more on Haiku)
- drift, stalled, deadlock and resync default to the light model (LIGHT_V25, migrated like v0.24 for saved settings still on the main model). Because a turn with several reasons takes the most capable model, any turn that also had a drift reason used to go to Sonnet. Only one-off setup the story builds on stays on the main model (campaign design, pitches, opening, sheets, Claude-planned maps).
- ESCALATE_INSTRUCTION: hand up only for a major reveal, completing a plot beat, or a new chapter (no longer fights breaking out, new locations or "changes where the story is going"): each hand-up paid for both models.

### v0.25.1 (companions taken away stay on the map)
- party_away only recorded text, and partyOnMap drops away companions, so a companion "caged somewhere in the dungeon" vanished from the map. Now `heldRoom` (explore.js) reads the words: a room they name, else (held here: cell, cage, locked up, captive, somewhere in, deeper...) the likeliest captive's room the party hasn't visited, farthest from the player; elsewhere (town, camp, the road) stays off the map. `placeHeld` (atlas, after applyPresence each DM turn) puts them there, `waiting`, `held` (caged if the words say so), and adds the room to their away line for the DM. Held companions are drawn only when seen; reaching them brings them along only once they can move; party_back clears waiting and held.

### v0.25 (the map algorithm and common-sense rules)
- `core/architect.js`: `normalizeBrief` (a model's brief made safe; normalizing twice changes nothing) and `planFromBrief(brief, seed)` → a plan in Claude's plan shape. BLUEPRINTS per kind (match on the kind first, then the name): rooms as [type, level, [min,max], chance, opts] (repeating types scale with size: medium x1.5, big x2.5), sizes per kind (big jails/castles/mansions/dungeons 36–55 rooms; a small house 1–3), filler on the emptiest level, styles spine / wings / hub / stack / maze, parents (pantry off the kitchen), loops between public rooms, stairs between levels from each level's hub (a back stair in big places), locks with keys in keyholder rooms, the brief's rooms / people / locks / secrets, guards (named now and then, patrols near home), residents, traps by condition and kind (magic ones in temples, crypts, towers), loot, marks, a start (outside → a courtyard; locked up → a cell, made if needed), and twists (TWISTS) whose hidden rooms join by secret doors after the layout. Name pools with {fam} {given} {color} {saint} {adj} {wing}; each name once per place. `townFromBrief`, `wildsFromBrief`, `interiorPlan` (town buildings).
- `core/rules.js`: RULES (cells, locked_in, strongrooms, private, kitchens, baths, stairs, secrets, keys, way_out, fittings, patrols), idempotent, run in normalizePlan with connectRooms until nothing changes (normalizePlan returns `fixes`). Cells: at most 8 to a block; blocks named for jails. `checkPlace`: wall gaps and cell doors after the build.
- Geometry: `sealCells` walls up any extra door in a cell's walls (found by position), then the solver runs again; the solver joins cut-off non-cells first, never punches into a cell, a cut-off cell gets a cell door; tunnels never end in a cell or the room they started from; repair door ids are unique (`freshDoorId`); link `state` reaches the door.
- `core/describe.js`: `describePrompt` / `cleanDescription` for the local model on first entry (atlas `writeDescription`), `describeRoom` from pieces without one. Rooms carry a `hint` (the planner's notes) until described.
- Build flow (`requestBuild`): settings `mapBuilder` ('algorithm' | 'claude') and `mapBrief` ('local' | 'haiku'); `askPlaceBrief` (dm.js) with PLACE_BRIEF_INSTRUCTIONS; task `map_brief` (light).
- Also: `placePerson` refuses thing-like names (`looksLikeThing`), loadPlace clears old ones; `arrive` puts DM newcomers at the nearest door / stairs out of sight (`arrivalSpot`) with a `goto` goal walked by `moveHunters`; conditions that wore off aren't re-added within CONDITION_SETTLE turns outside fights (QUICK_CONDITIONS exempt); no carpets, plants or armor in rough places' hallways.

### v0.24 (the map and the story in step)
- Why they drifted apart: the DM's prose could add a creature or move someone without the matching place_changes, and nothing caught it; "the kennel" was matched by a helper picking an id from a list deduplicated by name (one kennel shown, the rest invisible), and nothing at all pinned down which bookshelf the player meant.
- Which thing: the triage helper returns `thing` (the player's words for what is acted on). `core/targets.js` matches it against the furniture, doors, windows and people on the floor that have been seen (own name counts double, other words once; "north", "nearest", "other" understood; the last one acted on is remembered per actor). One match: `approachSpot` (in-turn walk) or the companion's task walk goes there, and the DM gets a TARGET line with the id. Several in reach: `chooseOnMap` rings and numbers them, the turn waits (stop/close = none).
- Map sync (`core/mapsync.js`, `atlas.applyMapSync`): after each turn, queued like the bookkeeper and awaited at the start of the next turn. Local helper by default (`mapSync` setting: local / claude = Haiku task `map_sync` / off). Ops: spawn, move, hide, pose, door, thing, gone, intent; every id and name checked against `syncContext`; party members walk.
- Intents on people (`setIntent`, `moveHunters`): attack / follow / flee / stay / wander. Hunters step with each walking step and a turn's worth (6) each turn; reaching someone stops the walk and calls the DM once per turn (`engaged`, cleared each player turn). The DM can set intents through place_changes.guards.
- Moved turns: 12 squares walked without a chat turn → `runTurn({ moved: true })`: fire, patrols, hunters, the world clock; the DM only for events or a due check-in.
- Awareness: `spot` {seer, seen} on npc_rolls and player_roll, `noticed` for the obvious; kept in world.aware, shown to the DM (AWARE) and companions.
- Initiative: while the player has no initiative in the order, npc_rolls are held back and initiative is asked for; `combatSummary` names who acts before and after the player.
- Attacks: a missing target, AC or damage is filled in (`attackTarget`, `armorOf`, `attackDice`; enemies can carry `damage` from start_combat).
- Bodies: `killPerson` / `clearBodies` (3 turns); downed enemies stay on the battle board 3 rounds; bodies never block, hunt, patrol or "come into view".
- Companions' people line marks enemies, the dead and who has spotted the party.
- Traps: `trapTile` (doorways, in front of TRAP_GUARDS things, along hallways; by the trap's own words; 15% anywhere) and `wildTrap` (trails into a clearing, by its altar or graves).
- Models: everyday jobs (check-ins, combat, risky actions, roll results, travel, events, companion tasks and attempts, figures) default to Haiku; the `lightV24` migration moves saved ones still on the main model.

### v0.23.1 (building maps works again)
- Since v0.20, `requestBuild` declared a `const plan` in the same block where it first reads its own `plan` option (the ready-plan argument), so reading the option hit the temporal dead zone and every place build but towns failed with "Cannot access 'plan' before initialization". The normalized plan is now `placePlan`. A scan of all the code for other uses before a const/let found none.

### v0.23 (towns with variety, walls; wild places; water)
- Towns: `houseShape` / `buildHouse` give each building a shape on its plot (L, front gable, turret, bay, porch, sometimes a plain block), mapped for whichever side of the road it's on, with per-part roofs (hip or gable) in `ROOF_HUES` and `townLook` colours. `walled` (plan, or a walls feature) → `wallTown`: the town padded by TOWN_WALL_PAD, a 2-thick curtain wall with battlements, round corner towers, gatehouses with towers where roads leave, roads to the edge, woods outside; walled towns always have their square. Crowded towns shrink the widest buildings (never below 4) and tighten gaps instead of dropping buildings. Carts never stand in front of a door. Ponds (`addWater` pond) when asked or 40% of the time where there's room. Ordinary standalone buildings default to L/gable shapes with porch/bay fronts (SHAPES gains gable, FRONTS porch).
- Wild places (WILD_KINDS: jungle, forest, swamp, camp, riverbank, oasis...) → `generateWilds`: spots as clearings (size by room size) spread out, trails carved between them (bridges over water), a river or pond (by words and theme), pools in a swamp, dressing by spot name (camp, shrine, waterfall pool, graves, den), traps, items and people in their spots, a dry start; `growWilds` grows the land by smooth noise (thickets, great trees, palms by water, undergrowth by theme, reeds on banks, lily pads). Areas give a darker floor under the trees and sunny glades (areas can carry `floorC`). Grounds use `growWilds` outside and sometimes get a garden pond.
- Art: jungle theme; `tree` by theme (round, pine, broadleaf, palm, willow, snowy pine) drawn after all the ground so canopies overlap; grass with `fieldNoise` patches and clover; new props bigtree (2x2), palm, fern, tallgrass, reeds, lilypad (hideable, burnable); `paintWater`: depth-from-shore colour field (per theme), soft mask, damp bank, caustics, ripples, glints, foam, bridge decks drawn after; `paintTrails`: soft dirt paths outdoors.

### v0.22 (architecture)
- The plan's `exterior` {shape: plain|L|U|H|E|T|tower|castle, front: flat|bay|rotunda|portico, towers 0-4, wall, moat}; `exteriorOf` fills what's missing from the kind (grand houses U/H/E/L with a rotunda, portico or bays and maybe towers; castles castle; temples T with a portico; towers tower). `footprint` makes the house from blocks (main, wings, an E pavilion, T transepts, each with its own hipped roof, the front row left showing where it faces out) and rounds (`roundTiles`: towers under cones; a rotunda or bays as half rounds under half-domes, the door in the rotunda's curve). Porticos are pillars and a pale roof over the door. Grand houses are wide and shallow (width at least 1.8 x depth). `castleGrounds`: a bailey inside a 2-thick curtain wall (battlement roofs), round corner towers, a gatehouse across the front wall with the way in through it, an optional moat with a bridge, the keep (battlement roof, corner turrets) facing the gate, braziers, a well, the yards in the bailey.
- New roof shapes in tiles.js: `hipRoof` (four faces, short ridge), `coneRoof` (round, and half for apses), `battlementRoof` (flagstone walk, merlons), `porticoRoof`. Both planning instructions describe the exterior vocabulary.

### v0.21.4 (rebuild a map)
- `/dmrebuild [name]` → `rebuildPlace` (atlas.js): the map the party is on, or the named one, with its whole family (the top place, everything with it as parent, every key--child), is removed from the atlas, the cache and the user files (`deleteFile`), after a confirm; then `requestBuild` plans it again (same name and size, the inside's kind for a building, the scene card's place as where they start if they were on it). Fixed `/dmbuild`, whose pattern had lost a backslash and matched nothing.

### v0.21.3 (a mansion is always a mansion)
- The bug: a mansion built as a "small" map came back from Claude as only its yard (the party was arriving to rob it); every room was outdoors, so nothing was split off and the yard was built as a tiny hedge-walled place, with no house and no door.
- A building is now recognised by its kind or its name ("Ashworth Manor", whatever the kind). `addUsualRooms` gives a building with too few rooms inside (grand kinds: under 6; others: under 2) the usual rooms for its kind (the town interior recipes, plus a library, master bedroom, guest room, servants' quarters, wine cellar and upstairs hall for a manor), on their floors, joined to the entrance hall (stairs between floors), with the front door. Grand kinds (GRAND_KINDS) get the full planning rules and about 12 rooms even as a "small" map. Both planning instructions say a building is always planned inside, in full, even when the party starts outside; the DM rules count robbing a mansion or any heist as a big site.
- `generateGrounds` lays the outside out properly: the house set back from the edge with a drive to its front door; each outdoor area (by its name: gate, garden, courtyard, stable yard, graveyard, orchard) in its own spot (beside the house, behind it, or the gate at the end of the drive) and laid out for what it is (flower beds in rows, a cobbled courtyard with a fountain and statues, a dirt stable yard with hay and a trough, rows of graves, rows of trees); a fence (a hedge for a grand house) around the grounds with lamps at the gate; trees thick outside it. A grand house is bigger, with flowers along the drive, a fountain on the lawn and a hedge along its front.

### v0.21.1 (hurt and out cold look it)
- Palette gains blood (BLD, BLDD). `injured` = the hand-on-side pose run through `hunched` (knees bent, body dropped two pixels and leaning forward, more at the head) and `bloodied` (stains on the middle of the body). `down` = the lying frame with `pooled` (a blood pool on the ground around it) and stains.

### v0.21 (map tiers, companions through the chat, traps that grab)
- `settings.mapTier`: off / some / always. `dmRules(tier)` (protocol.js): "always" swaps the no-map line for a build-every-new-place rule; "off" drops the Places and maps section and every map-only rule and reply field (MAP_ONLY) and says so. Off also makes `currentPlace` null, `activeBoard` null, blanks the map fields of DM turns (no battle map), and the map button says maps are off.
- Tapping a person shows an info card only (HP, conditions, hiding, resting, caught, staying). Companions' moves come from their replies: `companionActionPrompt` asks `stance` (close / follow / stay) in both companion checks; `setStance` keeps it in `meta.stance` and sets waiting. A companion with close or follow comes along without the per-walk follow question.
- `companionCuriosity` (orchestrator, after a walk into a new room, 1 in 3): a free companion (not close, waiting, held or hurt) may pick something in the room (local helper), walks there without staying (`companionGoTo` stay:false), rolls Investigation (code), reveals traps by searchForTraps and hidden items in the room on 12+, and speaks a short local line about it. No Claude call.
- Traps: `stepOn` puts the victim in `place.state.caught` ({trap, look, at}); `trapLook` maps the trap's name to snare / net / pit / darts / blades / gas / fire / crush / jaws / alarm; `caughtNow` only while they're on its square. `lockedReason` holds them; a successful save (player_roll or npc_rolls) frees them (`freeFromTrap`); the DM frees them with `place_changes.free`. `src/ui/trap-art.js` draws each look over the figure, with a flash and a "!" when it goes off.

### v0.20.1 (the bookkeeper)
- `src/core/bookkeeper.js` (pure): `bookkeeperPrompt` (tracked status + what was said this turn) and `parseBookkeeping` (conditions mapped onto a fixed list by `conditionWord`, names matched to the party and NPCs here, items only for the party, adds skipped when already tracked unless handed over this turn, removes only of what they have). `runTurn` queues `bookkeep` after each turn (not awaited, one at a time): the chat since the turn started minus cards and notes, one local call, `applyStateChanges`, a "📜 Bookkeeping" card. Setting `bookkeeper` (default on; needs the helper).

### v0.20 (buildings as two maps, furniture, injuries, bookkeeping)
- `normalizePlan`: a building kind (BUILDING_KINDS) moves its outdoor rooms (courtyard, graveyard, garden/yard/porch... by type or name) to `plan.outside` (with their people in `outsideGuards`); rooms that opened onto them get the front door; `startOutside` if the party started out there. Exits are only forced for buildings and interiors (their front door); other places have one only where Claude marked it. Fog is off for a building that isn't ruined when most rooms are lit. Hedge-walled rooms never get windows. Fixed the room-name regex ("the X").
- `generateGrounds(plan, inside)`: the outside map (kind "grounds", no fog, no exits): the building as a walled, roofed block sized from the ground floor, windows and the front door (D1, enter B1), a path, each outdoor room as a named area with its props (graveyard, courtyard, garden, stable, orchard), trees and nature by setting. `requestBuild` stores the grounds under the place's key and the interior under key--b1 with `parent`, and starts outside when arriving. Entering a building puts you just inside its front door; leaving through it returns you outside. The DM sees both sides' rooms. Walking out of a place for good (no parent) asks first; cancelling steps you back.
- Furniture: `SEATS` (grid.js), `restOn` / `poseNow` / `standUp` (explore.js), `place.state.pose`; checked against where they stand like hiding. Map: Sit / Lie down / Sleep on seats and beds, Get up on yourself; companions get `pose` from the companion check; the DM uses `place_changes.pose` and sees it in Party now. Sprites: `injured`, `sit` (body drops, thighs forward), `lie`/`sleep` (lying frame), `abed`/`asleep` (upright, drawn in a bed from above under a blanket). Figure particles: Z's over sleepers, drops from the badly hurt (25% HP).
- Conditions: `restraintOf` locks for being too hurt (can't walk, incapacitated, dying, unconscious...) with `hurt: true` (no struggle options; "someone can carry them"). `changeHp` adds "unconscious" at 0 HP for the party and removes it when healed. Items: `items_add`/`items_remove` accept {owner: [items]} (`world.inventory`), a plain list is the shared pack; removing finds the item on whoever has it. The DM rules have a Bookkeeping paragraph.
- Mobile: the map header's title shrinks (and its sub-title hides) so the buttons, the close X included, always fit.

### v0.19.1 (save damage)
- npc_rolls and player_roll of kind "save" take `damage` (dice, words allowed: "2d4 piercing") and `half`. The code applies it to the roller: all on a failure, half on a success when `half` (`saveDamage`, `damageDice` in dice.js); for npc_rolls with no `damage`, dice written in `on_fail` count. The DM is told it can't apply save damage itself (it doesn't know the roll). Trap events ask for the save with the trap's damage dice.

### v0.19 (fire, spell effects, ambience)
- `src/core/fire.js` (pure): state lives on the map object (`map.fire` {"x,y": {heat 1-3, fuel}}, `map.burnt`, `map.burntProps`, `map.effects`, `map.flashes`, `map.ambience`), so places, battle maps and scene maps all work. `burnRating` = the square's floor/wall/door material (from its area or theme; same names as the art) plus the props on it: [catch 0-1, fuel turns]. `tickFire`: from squares at heat 2+, each burnable neighbor catches with chance catch x heat/3 (x0.6 diagonal, never diagonally between two walls); every burning square spends a turn of fuel, heats up while there's plenty, cools at the end, then burns out: charred, flammable props replaced by an `ash` prop, doors become open doorways, trees become stumps. `ignite` (radius, heat, fuel for oil), `extinguish`, `addEffect`/`tickEffects`/`clearEffects`, `fireSummary` for the DM, `mergeBurn` puts a battle copy's burning back onto the floor when a fight in a place ends.
- `src/st/fire-turn.js`: `activeBoard` (the map in play), `applyMapEffects` (the DM's `map_effects`), `fireTurn` once per player message (not rolls, not forced turns, not walking): ticks fire and effects, burnt doors become broken, anyone on a burning square takes FIRE_DAMAGE[heat] (party and enemies with HP applied via changeHp, others reported for the DM to roll), and a FIRE event calls the DM when someone burned. The DM sees a FIRE line every call. Fire lights the fog of war (litMask) and companions route around it.
- `src/ui/effects.js`: drawn every frame over the painted map only while something moves (otherwise the old figures-only redraw). Fire light is summed in a 1/8-resolution buffer (so big fires don't wash out to white), flames are a pre-drawn 8-frame sheet per heat with per-square offset, size and flip, plus embers and smoke. Effects: tinted areas, drifting clouds, sparkles, bubbles; one-off bursts. Ambience (setting `mapAmbience`, map button): weather across the visible part of the canvas, natural glints/flicker/lava; capped particle counts per kind. Charred floors and walls are painted into the base map (tiles.js), and the base map uses fire only to cut darkness (the moving layer does the glow).

### v0.18.7 (hiding, live for the DM)
- `hiddenNow(place, name)` (explore.js) is the one answer to "is X hiding": the hidden record only counts if they still stand on the thing (in/under) or beside it (behind), so it can't go stale. The map, the self menu and the DM all use it. `placeView` adds "Party now": each party member's square, room, and HIDING in/under/behind what (id), or out in the open, marked as the truth over earlier messages. `place_changes.hide` {name: prop id or what it is | "out"} lets the DM hide someone or bring them out (`hideIn`, shared with the map's Hide). Followers who walk come out of hiding.

### v0.18.6 (companions find their own way; warning them about traps)
- Following: `followSteps(place, floor, from, leader, {taken, steps, avoid})` (explore.js) is a BFS to the nearest free square within 1 (then 2, 3) of the leader, avoiding stairs. Each step of the player's walk every follower (nearest first) takes 1 step, 2 when more than 3 behind; after the walk they catch up. No more trail of the player's squares. Each follower's step goes through stepOn (their own traps). A follower who can't get closer stops for that walk (no whole-map searches every step).
- Trap knowledge: `trap.knownBy` (names, or "*"). The finder (searchForTraps) learns it; sprung traps are known to all; traps set in plain sight (add_traps not hidden, old trap pictures) and traps the DM marks found are "*". `trapsKnownTo` gives a companion's known live traps: followSteps and companionGoTo route around them at each distance before crossing. The helper triage returns `warned` (the companion the player warns about a trap): `tellTraps` teaches them every found trap.

### v0.18.4 (traps the DM sets)
- `place_changes.add_traps` [{at, kind, dc, save, effect, hidden}] → `addTrap` puts a real trap in place.traps with its linked prop. `add_props` with type "trap" is treated the same (that was how the DM drew traps before: a picture with no trap behind it, so nothing went off). `adoptTrapProps` on load turns old unlinked trap pictures into visible traps.

### v0.18.3 (traps catch everyone)
- `stepOn(place, name, floor, x, y)` (explore.js) is the one rule for stepping on a trap square: hidden springs and shows, found goes off unless crossed carefully, a sprung pit/hole/trapdoor stays open. The player's walk and a companion's own walk (companionGoTo) both use it; the companion stops on the trap. A trap set off during a turn is queued (takeTrapEvents): a companion task's walk finishes before the DM is asked, so the trap goes into that call instead of the search; one set off after the DM ruled starts an explore turn right after. Walks take the shortest way: crossing a known trap sets it off (v0.18.5; v0.18.3 routed around them, which also blocked one-square hallways).

### v0.18.2 (companion tasks go through the DM)
- The helper triage also gets the companions with the player and the things and rooms around them (goTargets) and returns `task: {who, what, go, dm}` when the player tells a companion to do something. `go`: the companion walks there right away (companionGoTo, in the background while the DM thinks; the reply waits for the walk). `dm`: the result is not known yet, so a new reason `companion_task` calls the DM, who rolls for them (npc_rolls) and briefs them with what they actually find. The free-reply companion check skips moving someone who already walked.

### v0.18.1 (run into the dark)
- Tapping an unexplored square walks there anyway: `findPath(..., { toward: true })` uses the real map, not what's explored, and when the square can't be reached (a wall, a locked door) returns the way to the closest square it can reach. No "can't go there" or locked-door hints for squares you haven't seen. In a fight in the dark, a solid black square picks the reachable square nearest it.

### v0.18 (hiding, places that fit their kind, hidden traps, NPC variety)
- A plan has a `condition`: kept, worn or ruined (Claude sets it; otherwise ruined if the name or reason says abandoned/ruined/derelict..., kept for buildings people look after: mansions, castles, temples, prisons, taverns...). Kept: the floor's main hallway (or gallery/foyer) with 3+ links becomes a spine, placed first with its rooms in two rows along it (the same code as the cell block); furnishing skips mess (bones, blood, webs, debris...); no grime; decay traps become pressure plates. Ruined keeps the organic growth and gets extra grime.
- Traps: no free noticing. A hidden trap shows only when someone searches the room: a Perception or Investigation roll (the player's, or a companion's in npc_rolls) reveals every hidden trap in their room with DC at or under the roll (`searchForTraps`), and the DM is told what was found. Stepping on one springs it (and shows it). Tap yourself: "Search for traps". New art for glyphs and tripwires.
- Hiding (`HIDE` in grid.js: in / under / behind per furniture type). `hideAt` puts someone in or under a thing (onto its square) or crouched behind it; `place.state.hidden[name]`. Walking, or the DM moving them, brings them out; tap yourself: "Come out". The map draws a half-second duck-in, then peeking eyes (in/under) or a faint crouched figure (behind). The companion check also asks "hide": a companion who hides somewhere walks there and hides.
- NPC figures: `presetFor` matches whole words only (stranger isn't a ranger, drowsy isn't a drow, speaking isn't a king, orchard isn't an orc) and returns null when nothing fits; `lookForNpc` then picks one of several ordinary looks by name. 14 new library figures. The DM's instructions no longer show a copyable "sprite": "human_merchant" example (Claude was giving everyone the merchant's hat and vest).

### v0.17 (jails, companions on the map, fixes)
- Jails: `organizeCells` (in normalizePlan) hangs every cell on a floor (2 or more) off one cell-block hallway (the hallway linked to most cells, or a new "Cell block"), through "cell" links; whatever the cells were linked to links to the hallway. `buildFloor` places the block first: the hallway (2 wide) with 3x3 cells in two rows along it, sharing walls. The cells' shared wall with the hallway becomes iron bars (`I`), with a barred cell door in the middle (`J` locked, `j` shut, `/` open; kind "cell", locked at the start). Bars and cell doors are see-through: rooms joined by bars see into each other (`barLinks` in explore.js).
- The start: the planner gets the scene card ("WHERE THE PARTY IS RIGHT NOW") and the DM's `build_place.start`; "start" may name a room by id or name. Companions start in the player's room (the same cell), not just the nearest free squares.
- Companions: a "room" note template ({{room}} {{things}} {{exits}}) tells the speaker about the room they're in on the map. The local model's companion check also asks whether they go somewhere now (a thing in their room or a room next door); if so they walk there (`companionGoTo`) and stay (waiting). Checked after free replies and after replies the DM directed; never in a fight or when they can't move.
- Furniture never cuts a room in two: stairs count as places to reach, not squares to walk through (stepping on stairs changes floor); walking routes don't cross stairs either.
- Hazards: a spotted trap is drawn as what it is (a pit, cracked/sunken floor, spikes, a net, a pressure plate) with a red warning corner. Stepping onto one you know about sets it off (the DM asks for the roll). Claude is told trap kinds must fit the floor.
- The DM must put anyone it narrates as present or on their way on the map, and move them as they come ("People now" says those are the only ones on the map).
- The building animation froze after about two seconds: a door's flash ring got a negative size before landing, which threw and stopped the loop. Fixed; it also re-attaches itself if SillyTavern re-renders the message. Shoved furniture keeps its look again (a broken \d in the seed regex).

### v0.16 (restraints, and fights that always limit movement)
- `src/core/restraints.js` reads the DM's condition words. Locks moving yourself: restrained/tied/bound/rope, grappled/held/pinned, caged, shackled/chained, paralyzed, stunned, unconscious, petrified, entangled/webbed. Cuffs/manacles bind the hands only (the player chose this: like D&D manacles). The figure shows `bound` ('rope' or 'cuffs'; someone can be tied up inside a cage) and the map draws bars over anyone `caged`.
- Conditions now work for anyone: party and enemies as before, and any other NPC in `world.others` (shown to the DM as "Others' conditions"). `conditionsOf(world, name)` finds them.
- Locked: walking, approaching, climbing out and shoving are refused with a line saying why; restrained companions don't follow; on a battle map no squares light up. Being moved by others is allowed: the DM's "positions" still move them (in a fight, capped at a normal move per round).
- Tapping yourself while restrained or cuffed opens a menu of ways to get free (Struggle free, Slip free, Pick the lock, Force the bars); it sends that as the player's action and the DM asks for the roll and removes the condition on a success.
- Sprites: `look.bound` builds a separate sheet. Tied: arms pinned, legs together, no weapon, two coils of rope around chest and arms and one at the ankles, idle is a squirm, walk (dragged) keeps the legs together. Cuffed: hands together in front of the belly, iron cuffs with a highlight and a short chain, no weapon.
- Fights: an attack roll (npc_rolls kind "attack", or a player attack roll) outside a fight starts one (`combatFromAttacks`): enemies are whoever attacks the party and whoever the party attacks, with AC/HP from the NPC's stats line when given. On the battle map you can't pick a move while the DM is working, so it's one move per turn.

### v0.15.5 (the DM can put people on the map)
- Inside a place, the map draws the party and the place's people (`place.guards`). The DM's "positions" for anyone else used to be stored with the party's positions, which the DM's own text map showed but the screen never drew. Now "positions" puts anyone on the floor (`placePerson`: an NPC the DM introduced keeps their description, attitude and gender), `place_changes.guards` takes a square ("ab14"), a room id or a room name for new and existing people, and a blocked or taken square becomes the nearest open one (places and battle maps alike). An exact room id wins over the same text read as a square. Older chats' stuck entries become people when the place loads (`adoptStrays`).
- Fights inside a place: the people the party can see (and any named as enemies) stay on the board where they stand; enemies without a square arrive a few steps from the party (`placeNear`) instead of on the far edge of the floor. After the fight the fallen are gone and enemies still standing stay on the map as hostile people.
- Entering a place, anyone standing on a party member's square steps aside.

### v0.15.1 (your own figure instructions, men and women)
- `src/ui/figures-window.js`: a popup with each party figure animating on a 96px canvas (All cycles the animations), a box for the player's instructions, Redraw and Back to the card. The instructions go to Sonnet with the current look ("THE PLAYER'S INSTRUCTIONS ... they win over the card and picture") and are kept per avatar in settings (`figureWishes`), so later redraws follow them; '' clears them. `/dmfigure Name instructions` does the same from the chat, `/dmfigures` opens the window.
- A look has `female` and `facialHair` (none, stubble, mustache, beard). Men are drawn with a brow line over small eyes, a nose, a set mouth, a square jaw and shoulders a pixel wider each side; women and children (`young`) keep the soft face. NPCs: the DM's gender, else the first name, else words in the description (`sexFromText`); library figures marked 'some' alternate by variant, so crowds are mixed. Figures saved before this (no `facialHair`) re-check man/woman from the name and card instead of trusting the old flag.

### v0.15 (little animated map figures)
- Claude describes, code draws (`src/core/sprites.js`). A look is a short description: species (human, elf, dwarf, halfling, orc, goblin, tiefling, rabbit, cat, fox, wolf, mouse, lizard, skeleton, zombie, ghost) or a four-legged beast (wolf, hound, rat, spider, horse, bear, boar, big cat), build, skin/fur, hair style and color, eyes, outfit (tunic, vest, robe, dress, leather, armor, rags, none), headwear, weapon (sword, dagger, axe, mace, club, spear, staff, bow, claws). A humanoid rig and a beast rig draw 24x24 frames from those parts with an automatic 1-pixel outline: idle (4: breathing, blink), walk (4), attack (3: wind-up, strike, follow-through; bows draw and loose), hurt (1), down (lying on its side). Same parts every frame, so nothing jitters.
- Party figures: on loading a campaign, Sonnet ("sprite" job) gets each persona's and companion's card text, their sheet's main weapon and their picture, and answers with a look (`SPRITE_INSTRUCTIONS`: describe what the character is, generically; no copies of copyrighted designs). Kept in the extension settings per avatar (`figures`), so one figure serves every campaign; `/dmfigure name` redraws. Without Claude (or before it answers) a library figure matched from the card text stands in.
- The library: 39 figures (humans in a dozen roles, the other peoples, beastfolk, undead, beasts), each with color variants; an NPC's variant is fixed by a hash of their name, so several guards on one map differ. The DM picks one with "sprite" on new NPCs, enemies, guards and people; otherwise `presetFor` matches the name and description.
- Drawing (`src/ui/sprite-render.js`): each look is painted once into a small sprite sheet (plus a red copy for the hurt flash), cached (80 max), drawn at whole-pixel scale with smoothing off, flipped for facing left. The map keeps a static layer (map, fog, labels, reach) and redraws only the figures' squares at ~9 frames a second, only while the map is open, shown and the page visible (12 figures: ~0.15 ms a tick on a desktop). Facing and walking come from position changes; attacks are triggered from attack dice cards; HP drops flash red; 0 HP lies down. Setting `mapFigures` (on by default) switches back to round portraits.

### v0.14 (things you can do to the map)
- Doorways: the squares in front of every door, the way out included (it was added after the clear-squares list was made, which let a bookshelf wall you in), every staircase and every window are kept clear by the generator, and `clearDoorways` removes anything blocking one when a place loads (older maps get fixed). Only things put there on purpose (`obstacle`: a barricade, the DM's `add_props`) may block a door.
- Orientation: furniture with a back and front (`ORIENTED`: bed, sofa, chair, piano, wardrobe, desk, pew, kennel...) is drawn with its back at the top and rotated so its back is against the wall it stands by (`prop.side`); chairs around a table face it. Things keep their look when moved (seeded by id).
- Ids: props get p1, p2...; windows are listed in `place.windows` (W1...: intact, broken, barred; map chars | U H).
- Tap menus for things: furniture → Search / Smash (DM roll → `props: {"p12": "broken"}` → debris, walkable) / Push (light things move one square for free via `moveProp`; heavy ones go to the DM for a roll → `props: {"p12": {"move": "w"}}`); shoving into a doorway barricades it (blocks the door until moved or smashed). Windows → Break (DM → `windows: {"W3": "broken"}`) / Climb out (a broken window: out of a town building onto the street on that side; out of a big place = leaving it, and the DM is told) / Pry the bars (a hard roll). What the player picked reaches the DM's next turn as a PLACE EVENT naming the id (`setMapAction` / `takeMapAction`), so it rules on exactly that thing.
- The DM edits the map: `props` (broken, removed, moved), `add_props` (on purpose, may block a door), `windows` (by id, by room, or "all": "barred"), `doors` "walled". Plans can bar windows (`barred_windows`, or "windows": "barred" per room).
- `walkable` checks for something solid on a door square first (a barricade blocks an open doorway).

### v0.13 (exploring, round two)
- Combat movement: `reachable` / `clampMove` (grid.js) find the squares within a speed (sheet `speed` / 5, default 6) around walls, without corner cutting, rubble and shallow water costing 2, people passable but not stopped on. The map tints and only accepts reachable squares; party moves from Claude are clamped (double for names in the new `dashing` list), with a status note. Outside combat, walking is free.
- Following: leaving a room asks the local helper model, per companion, whether they come along now (JSON {follows, why}; companions normally follow, only a clear reason in the recent chat keeps them). They stand still until it answers (v0.13.1); on a yes they walk after the player along the same path, two squares per step, until they catch up; on a no they stay, are marked waiting (`place.state.waiting`) and away (no briefs, can't hear), and a note goes in the chat. Coming back into their room (or right up to them in a corridor) brings them back, never on the same walk they refused. The tap menu has Ask to follow / Ask to wait here.
- People: plans have "people" (not hostile) besides "guards"; town buildings have a "keeper" who is inside when the party enters; the DM can put someone new on the map with `place_changes.guards: {"Name": {"room", "description", "hostile"}}`. Only hostile people coming into view call the DM. Tapping someone opens Talk (walks up, prefills the message box), Look (their description), Attack / Steal (walk up, send the action), Sneak past (send). A phone gets the menu as a bar of big buttons.
- Vision by room: from inside a room you see only that room (its floor, walls and doors); from a corridor, only the corridor. Another room stays dark until you step in, lit or not; line of sight still applies within your own space. Fights inside a place keep the fog, seen from the fighters' squares.
- Camera: follows the player until they scroll the map themselves (detected by position, ignoring scroll events from replaced views); a follow button re-centers; walking turns following back on.

### v0.12 (places: maps you explore)
Claude plans, code builds. Claude would get geometry wrong (doors that don't line up, stairs to nowhere), so it never draws a big map: it writes a plan (rooms with types, sizes, floors, descriptions, props, marks, traps, items; links between rooms by door, arch, locked + key, secret, stairs; guards with patrols; the start) and `src/core/layout.js` builds the floors.
- Three kinds: big sites (every room up front, Sonnet, asks first, ~$0.15-0.30), small maps (towns; building insides generated by code on first entry, free), no map. `build_place` / `enter_place` / `leave_place` in a DM turn; `/dmbuild big|small name`.
- The atlas (`dm_<id>_atlas.json`) lists every place; each place is its own file (`dm_<id>_place_<key>.json`) holding floors (map rows, props, room areas, roofs), rooms, doors, stairs, traps, items, guards, exits and state (positions, explored squares per floor, rooms visited). A place in the atlas is never rebuilt.
- Layout: per floor, rooms grow outward from the entrance along the links, sharing walls where linked rooms touch (a door in the middle of the shared wall) and joined by carved corridors otherwise (multi-source search). Stairs are placed in linked rooms on both floors; exit rooms get a door in an outside wall; lit rooms above ground get windows. Rooms are furnished from recipes by type (`src/core/rooms.js`, ~45 types: kennel, torture chamber, library, dining room...) plus Claude's own props and marks; blocking furniture never cuts off a doorway. A layout is thrown away and retried (with smaller rooms after a few tries) if a floor passes 64 squares, a room can't be reached, or an exit room has no outside door. Solvability: reachability from the start with keys collected along the way; a key behind its own lock is moved; a cut-off room gets a door. 200 seeds of the 40-room test manor: all solvable, <40 ms each.
- Towns: a main road (or a crossroads), buildings on both sides with doors on the road, each with its own wall material and color, roofs (shingle, thatch, slate) with chimneys, hanging signs whose icon comes from the trade (`signIcon`), a square with a fountain, well and market stalls, lampposts, a pond, a graveyard, trees at the edges. The road's ends lead out of town.
- Exploring (`src/core/explore.js`, `src/st/atlas.js`): click-to-move along explored squares (8-way, no corner cutting); closed doors open as you walk through; locked doors stop you; stairs switch floors; a building's door generates and enters its inside; an exit leaves. Fog of war: lit squares (outdoors, lit rooms, light sources) in line of sight, plus anything within 2 squares; walls, closed doors and pillars block sight; windows don't. Explored-but-not-seen squares are dimmed. Hidden traps on the path are spotted by the party's best passive Perception or sprung; a sprung trap, a guard coming into view, or walking out calls the DM ("explore" job, Haiku by default) with a PLACE EVENT. Patrols move on each player turn.
- The DM sees the whole place with its secrets in the cached plot layer (`placeSummary`) and the current room, doors, guards and a text crop of the map each turn (`placeView`). It changes the place with `place_changes` (doors open/unlocked/broken/found, traps found/disarmed/sprung, items taken/found, guards moved/alert/gone, rooms lit, rooms revealed). Entering a room for the first time posts its description and sets the scene card's place, so companions know where they are. A fight inside a place uses the floor as the battle map; positions go back to the place when it ends.
- Coordinates past column z are two letters (aa, ab...); Claude-drawn maps stay at 16x16, generated floors go to 64x64.
- The building animation: a hidden chat message where a small floor plan assembles block by block (floors drop in, walls rise, doors flash, torches flicker) with the real steps as captions; it becomes a one-line summary when done.
- Deleting a campaign's chat asks to delete its campaign files, every map and its NPC cards (an index of campaign id -> chat in the extension settings, since the chat's metadata is gone by then).
- Tiles: new mansion and cabin themes; rooms have their own floors (parquet, carpet with a border, checkered tiles, marble) and walls (wallpaper over wainscot, wood panels, logs, castle stone); interior walls are raised blocks (a beveled top, a shaded front face where floor lies below, cast shadows on the floor), while town house fronts stay flat; props can cover several squares (long tables with chairs, beds, rugs and runners, bookshelf walls, pews, counters, market stalls); ~45 new props (wardrobe, fireplace, chandelier, piano, grandfather clock, paintings, mirrors, armor, rack, wall shackles, iron maiden, stocks, slab, meat hooks, kennel, pet bed, bowls, forge, lamppost, fence, flowers, hay, trough, gravestone, signs) and floor marks (blood, scratches, papers, stains); grass spills over road edges; trees and doors stand on the ground around them.

### v0.11 (state, from "The Lantern and the Glass")
Companions and NPCs never see the DM's narration, and all they had of the scene was the 35-word standing line plus the last "happened" sentence. So they made up the rest: cuffs moved from behind the back to the lap, a door shut twice, a brass lamp got "glass", the meat pie moved to "last week".
- Scene card (`world.sceneCard`, `src/core/state.js`): the place and its light, where each person is and their body (restraints and how, posture, what they hold), and the objects that matter. The DM sends `scene_card` changes in the same turn something physical changes ("" removes an entry) and a full card on arrival somewhere new. Moving to a new location drops the old place, objects and NPC entries; the party's own entries carry over. The DM sees the card in WHERE THINGS STAND and fixes anything stale.
- Timeline (`meta.timeline`): each "happened" line is kept with day, time and place (last 8) and shown to companions with relative labels ("Last night, vault corridor: ..."). NPCs don't get it, because it can hold things only the party knows. Knowledge texts are written with plain time anchors.
- People met, with a short `role` per NPC (new in `new_npcs`, falls back to the description's first sentence), so "Captain Dray" and "the commander" are one person.
- Table rules (`meta.tableRules`): things the player settled out of character ("Amber and Judy always stay together"). The opening derives 0-5 from the premise; the DM adds or removes them with `table_rules_add` / `table_rules_remove`. They're in the DM's cached plot layer and in every companion and NPC note.
- All of the above go in one new editable template, "state" (`{{scenecard}} {{people}} {{timeline}} {{rules}}`). A list after a label starts on its own line.
- NPCs only remember their current scene: the first message of a new scene is flagged (`extra.dm_scene_start`), and an NPC's prompt drops everything before the latest flag. A magistrate can't quote what was said in a cell.
- Repeated phrases: the note lists phrases a character used in 2+ (4-7 words) or 3+ (2-3 words) of their last 8 replies, names excluded ("avoid" template). Catches "presses her back against the wall" and "the same".
- Out-of-character questions asked with /dm or the DM Screen are posted in the chat (hidden from the bot) before the DM's answer; the DM transcript labels them as the player's.
- Dice: sheets have a `tools` map (Thieves' Tools with expertise), matched loosely ("Thieves Tools"). For older sheets the DM can set `player_roll.bonus` from the sheet; a number the sheet's skills or tools have always wins.
- DM rules: never quote anyone in narration who speaks this turn; briefs say what narration just did that the speaker must not redo; NPC orders worded so they can't be misread and never against the table rules; never interrupt between a setup and its payoff ("I have a question…").

### v0.10.1 (code sweep)
- Saves: a campaign file save queued just before switching chats is now written (it was dropped), and queued saves are flushed before the next chat's files load.
- Voices: stopping playback (swipe, chat change) could leave the old play loop running beside the new one, so two lines played at once. Only the newest loop runs now.
- Dice auto-read: deleting messages while a roll was pending stopped SillyTavern's dice from being read until the chat grew past its old length.
- Maps: `"scene_map": null` (Claude's "no change") closed the room map; only `"close"` closes it now.
- Combat: the round counter never moved past 1. Each DM combat turn is a new round (a roll result finishes the round it was asked in).
- The opening's `world_next` from the campaign design is used (it was dropped, so the world always started at the default pace).
- NPC rolls with advantage written as 2d20kh1 now have a natural die, so their crits and natural 1s count.
- An NPC whose first name matches a companion's ("Nick the barkeep" vs "Nick Wilde") is no longer voiced as the companion; dead NPCs given a brief are skipped instead of rejoining the group.
- DM replies that never parse still go into the campaign's cost log; the opening scene blocks a concurrent turn like any other turn.

### v0.10 (from "Chains of Tessaly")
- DM silence: narration is empty by default and only written for an action/roll result, a new scene or time skip, something new arriving, what a check reveals, or setting up a roll; 2-4 sentences, a paragraph only for a new place, time skip or big reveal; no recaps of unchanged details. World turns act through briefs and narrate only on arrivals, place changes or time skips.
- Never play the player: what the player SAYS is never turned into what they DO; actions on the player are narrated as attempts or resolved with contested rolls.
- "happened": one past-tense sentence per DM turn of what visibly changed, kept in meta.happened and added to every companion/NPC note (new "happened" template) until the next DM turn, so companions don't redo resolved actions (the bolt pulled twice). Briefs say "already done, react only" when narration or a roll showed the action.
- Deadlocks: the helper flags "refusing" (the player resisting what a character wants, even calmly); two in a row call the DM ("deadlock", main model), which must switch tactic (bargain, firmer push, contested roll, call for help, or drop it) and update the objective. Rules forbid repeating a refused demand.

### v0.9.1
- Character sheets from any file (st/sheetfile.js): PDFs (text and form fields; scanned PDFs have their first 4 pages rendered to images), images (downscaled to 1600px JPEG and sent to Claude as image_url parts, which SillyTavern converts to Claude image blocks), .docx/.odt (zip read with the browser's DecompressionStream, XML to text), HTML/RTF/anything text-like; binary files get a clear message. callClaude takes "images"; cost estimates add about 1600 tokens per image.

### v0.9 (textured maps)
- Map format: "theme" (18 themes), richer terrain (planks, flagstones, grass, dirt, shallow/deep water, lava, open/locked doors, stairs, bridge) and "props" [{at, type, label}] from a fixed list; blocking props (furniture, statues, boulders) make squares unwalkable. Old maps stay valid (default theme dungeon).
- ui/tiles.js paints everything on a canvas with a seeded RNG per square (map.seed + x,y), so floors vary tile by tile but a map always looks the same: per-slab tones, cracks, moss, grain, tufts, pebbles, ripples, wall faces where walls meet floor, floor shadows under walls, foam at water edges. Named floors keep their material colors in any theme. Props are vector-drawn. Lighting: the theme's darkness with holes cut around light props (torch, brazier, campfire, candles, lava) plus a warm glow. The base layer is cached per map; tokens (portraits, rings, HP bars), reach and selection are drawn on top each render.
- map.js renders the canvas; taps map to squares; hover line shows square, occupant, prop and ground. Claude still only reads and writes text (theme, rows, props).
- DM rules: how to build a room worth looking at (enclosing walls and exits, floor patches, 4-10 story props, light in dark places, cover/chokepoints, one standout feature), with a full example.

### v0.8
- "The Dungeon Master is thinking…" bubble (ui/thinking.js): display-only DOM element in #chat while a DM call, companion ruling, resync or recap runs.
- Scene maps: DM field "scene_map" ({title,width,height,rows} or "close"), stored as world.sceneMap {title,map,positions}; grid.activeMap() picks the battle map in combat, else the scene map; "positions" apply to it outside combat; a fight starting in a mapped room reuses that map, and the room comes back after the fight. Rules ask for it only where exact squares matter.
- NPCs: NPC_IDLE_TURNS 100 (speaking or being addressed counts); DM field "npcs_dead" marks them dead (never picked again) and removes them from the group.

### v0.7 (from "The Hare and the Hollow")
- That session ran cached pre-0.6 code although the server had 0.6 (Hobb posted the old way, no companion knowledge). index.js now carries LOADED_VERSION (a test keeps it equal to manifest.json) and compares it with the server's manifest on load; a mismatch shows a persistent "press Ctrl+Shift+R" warning.
- No secret rolls: "hidden" removed from npc_rolls; every card shows who, what and the number.
- Rules: the DM never writes a companion's words or chosen actions (nor NPC dialogue in narration); one roll per check, no re-rolls, results must matter; covert actions near the player are rolled by the actor against the player's PASSIVE Perception (-5 asleep), rolled before deciding.
- Companion attempts: after free (non-DM) party replies, the helper classifies the reply (companionActionPrompt); an attempt triggers one DM call ("companion_action", main model) with the reply, which rules with npc_rolls. Directed replies are not re-checked (no loops).
- NPC replies are "short" unless the DM asks for long (then "normal"); NPC template asks for one or two lines and at most one brief action. "long" length is "4-6 sentences at most". Untouched saved defaults migrate (defaultsV7).
- Risky actions, roll results, travel/rests and events moved to the main model (Haiku made poor calls there: asking a sleeping player for an active roll, asking OOC which city).

### v0.6
- **NPCs as group members** (st/npccards.js): first time an NPC speaks, a character card is created through SillyTavern's /api/characters/create (tagged "D&D NPC: <title>" via /tag-add), added to the group (editGroup), and the reply is generated with Generate(force_chid) exactly like a party member, with the NPC template as their note. Swipes work; GROUP_MEMBER_DRAFTED injects the NPC note (and the reply's saved brief). NPCs with 10 player turns since they last spoke leave the group after each turn (cards stay). The old side path (callLocal + postNpc) is gone; it was the source of leaked thinking (it bypassed SillyTavern's reasoning parsing).
- **Companion knowledge**: meta.knowledge[name], written by the campaign design ("knowledge"), updated by the DM ("knowledge_update", full text, rarely), shown to the DM as WHAT COMPANIONS KNOW (MISSING entries get written on the next DM turn), and added to that companion's note through the new "knowledge" template.
- **Companions as players / group checks**: rules only (no extra calls): companions use their own sheet abilities through npc_rolls + their brief; group checks roll for every companion alongside the player's roll.
- **Levels**: "level_change" from the DM (when the player asks OOC) or /dmlevel; LEVEL_SHEET_INSTRUCTIONS rewrites the sheet (new file, record updated), HP max follows, stable prompt cache reset.
- **Resync** ("Fix mismatch", /dmresync, wand menu): Claude (main model, job "resync") compares the logged state with the last 80 chat messages and returns corrected world/plot ticks/notes/story/objective/knowledge/NPCs-forget/pending roll; applied directly.
- **World clock** runs at half speed on non-filler banter/questions.
- Verified offline (fake model): NPC card created, tagged, joined the group, reply generated by SillyTavern with the NPC note inside the player's turn and one system turn; Judy's prompt carries her knowledge; idle NPC left the group after 10 turns.

### v0.5.3
- World pace default 5 (was 3). The pacing report now states the player's pace ("WORLD PACE: every N turns"), and the rules tell the DM to use it as the normal world_next, so the setting controls the DM's pace rather than only the fallback. Saved 10 (pre-0.5.2) or 3 (0.5.2) move to 5 once (worldPaceV5).

### v0.5.2 (the world keeps moving)
- From a real session: nine turns of conversation at the prison gate with one DM call; the guards stood frozen and intake never happened. Causes: talking never called the DM, the check-in came every 10 local turns and was told "usually no narration, keep it SHORT", and the v0.5 rule "don't interrupt conversation with plot" froze the world.
- **World clock:** every DM turn returns "world_next" (1-10 player turns until the world acts on its own; 1-2 when people are actively doing things to the party). pacing.worldClock counts down per player turn; at 0 the DM is called with "checkin", now "the world moves on": NPCs act on their jobs, anything underway takes its next step, time passes, woven around ongoing conversation. Default pace when unset: settings.checkinEvery = 3 (old saved default 10 migrated). The opening sets it too. Check-ins use the main model by default ("The world moving on between your actions").
- **Rules:** the world doesn't freeze while people talk; processes (intake, march, search) advance a clear step each narration; narration length is "as long as the moment needs" with an explicit no-fluff rule.
- Verified with real Sonnet on that chat: one call processed the intake (search, belongings, prison clothes, rules, cell assignment), ticked the beat, moved the location and objective, briefed Judy, set world_next 3. About 2¢.

### v0.5.1 (thinking models, companions who can stay quiet)
- **No turns of our own.** SillyTavern builds the text-completion prompt as: its copy of the chat (hidden cards dropped) → extension interceptors → depth injections → the post-history instruction appended as a user turn → instruct formatting (one turn per message). The scene note used to be a depth-0 system injection, which put a second system turn between the player's message and SillyTavern's post-history turn. Gemma 4 wants <|think|> and all system instructions in one system turn (ai.google.dev prompt-formatting-gemma4), and Artemis answered with empty thought channels in campaign chats only. Now the interceptor appends the note to the player's last message in SillyTavern's per-generation copy (fresh objects, so the saved chat is untouched), or adds it as a plain user turn when someone else spoke last (with names "force", SillyTavern never prefixes the player's own turns). NPC prompts do the same instead of ending on a system message. Verified by capturing the final prompt from a group generation with Gemma 4 sequences: one system turn from the plugin's side (the only other one is the character card's own depth note), the note inside the player's turn, narration hidden. Setting noteMode: 'message' (default) | 'separate' (old behavior with noteDepth/noteRole).
- **Companions may stay silent.** The helper may choose no speaker; the random fallback speaker is gone when the helper ran. The DM tracks who split off (party_away with where, party_back) in world.away; away companions are excluded from candidates, their briefs are skipped, and the DM sees them listed as away. When nobody would answer locally (alone, or nobody nearby would reply), the DM is called with reason "solo" (its own job in the per-job model list; Haiku by default).

### v0.5 (pacing, from a 600-message session)
- **DM rules:** forward motion every narration, 2-5 sentences (a paragraph for arrivals and big moments), arrivals must be named and described and set scene.location, compress uneventful travel unless the player is really talking, don't narrate companions about to reply, don't echo the player's action, rolls only when failure is possible and interesting. Removed "never rush" and "one beat per scene"; story_add on arrivals, captures, escapes, reveals.
- **Plot pressure ladder** (core/pacing.js PRESSURE_STAGES): lean in → hints → pursuit → pressure → force, one stage per turn at most, thresholds by campaign feel (breathe: 12/20/28/36 turns without a beat). Holds while engagement is high. The DM is called at each new stage and every 4 turns at stages 3-4 until a beat lands; a beat resets everything (including lastDriftStageCalled, which previously never reset).
- **NEXT BEAT** (first unticked plot line) is in every pacing report, with "tick it as soon as its goal is reached, even differently". The old session sat at 98 turns since a beat although the capture had happened.
- **Stalls:** code counts filler player messages (core/pacing.js isFillerMessage: very short, or short acknowledgements/passive actions, never anything with a question); 3 in a row calls the DM with "stalled".
- **Typed roll numbers no longer count as story turns** for pacing.
- **DM chat window:** the 24 messages are story messages; dice results ride along without counting; SillyTavern's own system messages, answered roll requests and typed roll numbers are left out.
- **Dice auto-read** (st/dicewatch.js, core/rollmsg.js): SillyTavern's dice extension posts "Name rolls a d20. The result is: 17 (17)" as a system message with no event, so a MutationObserver on #chat reads those after a roll request (advantage/disadvantage take two d20s; damage collects the formula's dice and adds its flat bonuses). The result waits in meta.pendingRoll.autoResult and the turn runs as a roll result. A number typed afterwards within 3 minutes is ignored. Setting: autoReadDice.
- **Each player message is handled once** (meta.lastHandledPlayer), so a re-triggered turn can't narrate the same action twice. Attack roll cards say AC instead of DC.
- Tested offline (stubbed Claude, test copy of SillyTavern): roll request → SillyTavern system dice message → automatic resolution and DM call; retyped number ignored; transcript contents; duplicate trigger handled once. 20/20 unit tests.

### v0.4.2
- A model dropdown per job instead of a two-model checklist, plus a Hybrid on/off switch, a natural-1/20 option, a hand-up switch and "Reset to recommended". v0.4.x settings carry over (untouched v0.4.0 defaults become the recommended set; customized choices are kept). Tested offline with Claude stubbed: dropdowns save, hybrid off routes everything to the main model, reset, per-job calls (PDF → Sonnet, recap → Haiku), hand-up on and off.

### v0.4.1
- New defaults: Sonnet for setup, story direction and all combat (including the first swing); Haiku for everything else, with a one-time hand-up to Sonnet for big story moments. Natural 1s/20s no longer force Sonnet by default (Haiku can hand those up). Tested offline with Claude stubbed: hand-up reruns the turn on Sonnet once, only Haiku sees the instruction.

### v0.4 changes (cost: about $1.50 per session was too much)
- **Per-turn model choice:** Haiku 5.5 for routine DM turns, Sonnet 5.5 for big moments (see Cost control). The status bar and cost log name the model used. Note condensing uses Haiku; campaign setup, sheets and recaps use Sonnet.
- **Layered prompt for caching** (see Cost control). Checked against SillyTavern's own `convertClaudeMessages` + `cachingAtDepthForClaude`: breakpoints land on the system prompt and both context layers, nothing else. Note condensing no longer appends its instructions to the system prompt, so it reuses the same cache.
- **Per-model prices** (Sonnet 5.5 $2/$10, cache read $0.10; Haiku 5.5 $0.10/$0.50, cache read $0.01 per million tokens), cache writes priced at 1.25× input (2× for the 1-hour cache). The estimate tracks which layers were sent in the last 5 minutes (or hour) per model.
- How often the DM is called is unchanged on purpose.
- Tested offline (test copy of SillyTavern with Claude stubbed): settings panel, model per tier, message layers, cost estimates for cold/warm cache, and a full `askDm` round with an in-memory campaign.

### Verified in a live test (isolated copy of SillyTavern, port 8011)
Wizard → campaign build (Judy's sheet + bible/plot/opening) → group chat with no greetings → banter turn (local only, helper 0.7 s) → risky action (DM asks Stealth, hidden DC) → typed roll resolves → DM narrates → Judy follows her direction → new NPC registered with a voice and voiced locally → random event woven in → combat (initiative, attack, damage, HP) → persona PDF form fields read and converted → DM Screen. About $0.20 of Claude estimated for all testing.

### Not yet verified
- Long campaigns over many sessions (story summaries, note condensing, "Previously on…" recap).
- Actor connection profile switching (`/profile` swap), which wasn't exercised because your saved profiles point at `127.0.0.1` addresses that only exist on the laptop/server.
- Real prompt-caching savings and Haiku's DM quality in real play (needs the `config.yaml` switches and a session; check the Anthropic console's cache-read numbers).
- Running on the AI server itself.
