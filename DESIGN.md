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
| **Dungeon Master** | A Claude profile (Sonnet; model picker in settings) | Story, pacing, rulings, consequences, deciding when events happen, writing hidden stage directions, keeping the campaign files | Paid, so used sparingly |
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
- **Real numbers:** each Claude call's actual token usage is read from the response and priced, so the meter reflects what you really spend.
- **Throttling:** at 80% of budget, check-ins become rarer. At 100%, the DM switches to **local-only mode** (the helper does basic orchestration) and tells you, so you're never surprised by the bill.
- **Prompt caching:** the stable part of every DM call (rules, bible, sheets) is arranged to be cached, which makes repeat calls much cheaper. **This needs a setting in SillyTavern's `config.yaml`:** `claude.enableSystemPromptCache: true` (and possibly `cachingAtDepth`). It's a settings switch, not a code change, and you decide whether to turn it on.
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
- **Orion over-thinking:** stage directions end with "keep any thinking short: one plan, no redrafts", because a rich direction made Orion redraft the same line for ~30 s.

### Verified in a live test (isolated copy of SillyTavern, port 8011)
Wizard → campaign build (Judy's sheet + bible/plot/opening) → group chat with no greetings → banter turn (local only, helper 0.7 s) → risky action (DM asks Stealth, hidden DC) → typed roll resolves → DM narrates → Judy follows her direction → new NPC registered with a voice and voiced locally → random event woven in → combat (initiative, attack, damage, HP) → persona PDF form fields read and converted → DM Screen. About $0.20 of Claude estimated for all testing.

### Not yet verified
- Long campaigns over many sessions (story summaries, note condensing, "Previously on…" recap).
- Actor connection profile switching (`/profile` swap), which wasn't exercised because your saved profiles point at `127.0.0.1` addresses that only exist on the laptop/server.
- Prompt caching savings (needs the `config.yaml` switch).
- Running on the AI server itself.
