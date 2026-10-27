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
