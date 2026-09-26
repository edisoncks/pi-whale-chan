# Architecture

Contributor guide for `pi-whale-chan`. The README is the user contract; this
file explains why and how. Code `why` comments remain the source of truth.

## Mental model

```text
whale-chan.json ──session_start──► enabled (in-memory)
                                        │
                          before_agent_start (every turn)
                                        │
                     sections.whale_persona = WHALE_PERSONA   (on)
                     delete sections.whale_persona            (off)
                                        │
                     Pi diffs sections → transcript delta patch
```

The extension only ever changes one named system-prompt section. Pi compares
the desired sections against the ones the model already has and sends a patch
(see `diffSystemPromptSections` in `dist/core/system-prompt.js`).

## Code map

| File | Responsibility |
|---|---|
| `index.ts` | Config load/save, `before_agent_start` section injection, tail anchor, avatar entry + renderer, pet strip lifecycle, `/whale` command |
| `persona.ts` | Frozen persona (`WHALE_PERSONA`) plus the voice rule and tail anchor (`WHALE_VOICE_RULE`, `WHALE_TAIL_ANCHOR`) |
| `pet.ts` | Frame tables and `WhalePetWidget` — the animated strip above the editor |

## Design decisions

### Why `sections`, not `systemPrompt`

Returning `systemPrompt` (or setting `forceSystemPrompt`) replaces the whole
prompt for that run. Pi's docs call this out: prefer changing prompt sections
"so Pi can append a transcript delta". A full replacement can make providers
fall back to a complete transcript checkpoint, which invalidates the cached
prefix. Mutating `event.systemPromptOptions.sections` keeps us on the patch
path.

### Why the persona is appended last

Custom sections are rendered after `cwd` (`buildSystemPromptSections`). That
means toggling the persona only changes the tail of the system prompt; the
cached prefix — preamble, tools, rules, docs, project context, skills, cwd —
stays byte-identical.

### Why the persona text is a frozen constant

`WHALE_PERSONA` must not interpolate cwd, dates, model names, or any
per-session value. If it did, the section would change every turn, Pi would
emit a patch every turn, and the prompt cache would never hold. Because it is
constant, re-setting it each turn produces **no diff** — zero extra tokens and
zero invalidation while the persona is enabled.

### Why the persona is bookended

A single tail section is not enough. The system prompt sits at the head of the
context, but every tool result is appended *after* it, so during a long,
tool-heavy turn the persona is far from the point of generation and its
influence fades — the model copies the register of the nearby tool output. That
is drift, and it is positional, not the model "forgetting" the character.

Fix: bookend the prompt.

- **Tail**: the full `WHALE_PERSONA` in the `whale_persona` section, unchanged.
- **Head**: `WHALE_VOICE_RULE` merged into the early `rules` section via
  `promptGuidelines`, phrased as an imperative so it competes with the default
  rules ("Be concise") on equal footing instead of reading as flavor text.

On the injection's safety: `agent-session.js` re-passes the same
`_baseSystemPromptOptions` every turn, but `emitBeforeAgentStart`
(`dist/core/extensions/runner.js`) normalizes it into a fresh clone before
invoking handlers. `normalizeBuildSystemPromptOptions` copies `sections` and
`promptGuidelines`, so each turn's handler mutates a private object and the base
is never touched — the array cannot accumulate across turns even with an
unconditional `push`.

The `!guidelines.includes(...)` guard in `index.ts` is therefore **defensive**,
not load-bearing: cheap insurance should Pi ever stop cloning and hand handlers
the shared base object directly. `buildRules` also dedupes normalized rules
before rendering (`dist/core/system-prompt.js`), so even a leaked duplicate could
not change the emitted `<rules>` section; the only possible harm is an unbounded
in-memory array. `test/bookend.test.mjs` pins both paths: the real clone-per-turn
path (base options stay clean) and the defensive shared-object path (the guard
keeps it at one copy).

Those two assertions read Pi's internal `dist/core/system-prompt.js`, which is
not in the package's `exports` map. The test treats that access as **optional**:
it probes a few likely locations, validates the exports, and skips the two
render-dependent cases (plus the two renderer-only assertions that follow) with an
explicit reason if the internals move — so a Pi upgrade cannot hard-fail the
suite on a package reshuffle. The anchor and language-binding tests need no
internals and always run.

This relies on the default preamble branch: `promptGuidelines` only renders
into `rules` when no `customPrompt` is set (`buildSystemPromptSections`). With a
user-supplied custom prompt, the tail section still applies and the head rule
is simply absent.

### Why the persona has a tail anchor

The bookend lives entirely in the system prompt, and the system prompt sits
before *all* tool output. During a long, tool-heavy run the nearest text to the
generation point is a tool result, not the persona — so the bookend cannot
anchor the generation that follows a tool call. One append-only anchor closes
that positional gap (measured below):

- **Tail anchor (`WHALE_TAIL_ANCHOR`).** The `context` event runs before
  every provider call, and Pi restores the message list afterward, so appending
  there is transient. It fires only when the last message is a `toolResult` —
  exactly the moment generation follows tool output. `convertToLlm` maps a
  `custom` message to the **user** role, the strongest instruction channel, and
  the append is at the very tail, so position and authority point the same way.

  **Measured effect (clean ablation).** A dedicated `bookend` vs `full` run at
  n=30 per arm isolates this mechanism alone (same model, `en-6` + `zh-6`):

  | arm | in-character | language match | stage-language ok | mean voice |
  |---|---:|---:|---:|---:|
  | `bookend` | 77% | 80% | 75% | 5.40 |
  | `full` | 87% | 90% | 79% | 5.87 |

  The tail anchor is worth roughly +10pp in-character and +10pp language match,
  with a smaller stage-language gain — the first clean evidence that the
  positional gap is real and that the pure append closes it. Caveats: one model,
  n=30, no confidence intervals, and the scorer is a smoke signal (see
  eval/README.md), so read it as indicative rather than precise.

**A tool-result anchor was tried and removed.** An earlier iteration also
appended a suffix to every Nth tool result, on the weaker "tool output is data"
channel, for persistence through repetition. An ablation (`eval/`, n=30 per arm)
found no measurable effect — in-character 29/30 with and without it, and
language/stage-language deltas within one or two samples — so it was dropped
rather than kept for a benefit that could not be measured.

**Cache safety.** Provider prefix caching keys on the prefix: a change *before*
the cached boundary invalidates it, but a pure tail append never does. The anchor
is a pure append — a transient message at the tail — so it emits no
system-prompt checkpoint and does not diverge an already-cached prefix.

**Cost.** The tail anchor is a fresh, uncached tail on each request. `context`
also fires on the first request of a turn, but the handler skips it unless the
last message is a tool result, so the user-prompt case (already covered by the
bookend) stays free.

**Phrasing.** Because the anchor is delivered as a user-role message, it is
phrased as a "style cue … needs no reply" so the model continues the task
instead of answering the cue. It also binds the output language to the user's
("reply in the user's language") and carries a short Chinese echo. The persona
body is Chinese-dominant, so an English-only sentence sitting at the most
influential position could bias a non-English turn toward English — a rule-1
drift, i.e. the very failure the anchor exists to prevent. The binding is
language-agnostic, so it holds for Chinese, Japanese, German, or anything else,
rather than guessing the language by script.

### Why the avatar is a custom entry

Before each reply the extension appends a `whale_avatar` entry and renders it
inline through `registerEntryRenderer`. That choice is what keeps the feature
free:

- **Display-only.** Custom entries never participate in the LLM context
  (`pi.appendEntry` stores them for the session, not for the model).
  `sendMessage`/`sendUserMessage` would inject the portrait into the transcript
  the model reads — spending image tokens on every reply and opening a new
  cache-prefix divergence. A custom entry is drawn locally only, so the prompt,
  its diff, and the cache are untouched.

- **Placement.** The entry must sort after the previous message and before the
  assistant entry. `before_agent_start` and the run's first `turn_start` fire
  *before* the user message is persisted (`agent-loop` emits them before its
  initial `message_start`/`message_end` pair, and `agent-session` persists a
  message on its `message_end`), so appending there would put the avatar above
  the user's message after a reload. The assistant's `message_start` is the
  right gap: the previous message (user prompt or tool result) is persisted,
  and the assistant entry is not yet written. The session order is
  previous → avatar → reply, on screen and after a reload.

- **One per reply.** Every assistant message is a reply, and a tool-heavy run
  emits several — narration before a tool call, then the answer after the tool
  result. Each one appends its own avatar, so the final answer is never left
  bare. (An earlier one-per-user-message design did exactly that and was fixed:
  the code only had to drop the pending flag and append on every assistant
  `message_start`.) The 200 px portrait is ~11 rows, so a long tool chain does
  repeat it; that is the cost of a per-reply portrait, and `/whale off` turns
  it off.

- **TUI only.** Entry renderers exist in interactive mode only, so the append
  is guarded by `ctx.mode === "tui"`. Appending in print/JSON/RPC would leave
  invisible entries in the session.

- **Sizing and format.** The 200 px target is converted to cells with
  `getCellDimensions()` (default 9×18 px), so the portrait tracks the actual
  terminal grid. Two assets live side by side: `assets/whale-chan-avatar.png`
  (256×256), downscaled from the 1254×1254 original and named by role (a
  derived asset) rather than by pixel size (which would go stale on a
  re-export), is what the TUI draws. `Image` transmits PNG (`f=100`), the common
  denominator: Kitty also accepts raw RGB/RGBA (`f=24`/`f=32`) but has no webp
  payload type, so the full-resolution webp rendered as blank rows there. The
  256px source also keeps each inline re-transmission cheap while staying above
  the ~200 px display size. `assets/whale-chan.webp` (1254×1254) stays as the
  high-res README original. The entry renders inside a `Box(1, 0)` to match the
  transcript's one-column inset; `EntryRenderOptions` only exposes `expanded`,
  so `outputPad` is not reachable and the value assumes its default of 1 (with
  `outputPad=0` the prose goes flush left and the avatar drifts one column).
  Custom entries otherwise render flush left. The `Image` component handles the
  Kitty/iTerm2 protocols and the text fallback; a missing asset degrades to a
  badge instead of a crash.

- **Dependency.** The entry renderer is a hard top-level import of
  `@earendil-works/pi-tui` (`Box`, `Image`, `Text`, `getCellDimensions`), so it
  is a required peer rather than an optional one — as is
  `@earendil-works/pi-coding-agent`, whose `getAgentDir` is a top-level import.
  `pi-tui` is a direct dependency of `pi-coding-agent`, which Pi already
  supplies, so the module is always resolvable in practice; only a missing
  *asset* degrades gracefully. Lazy-loading the module so a missing `pi-tui`
  disables the avatar instead of the whole extension would be the alternative,
  at the cost of an async import in the factory.

### Why the pet strip is hand-composed

`ctx.ui.setWidget()` is the documented path for persistent content near the
editor and its default placement is already `aboveEditor`, so the strip needs no
layout negotiation. Three pi-tui properties decide the rendering strategy, and
each one is a trap that a naive `HStack(Image, Text)` walks straight into:

- **The image reports zero visible width.** `Image.render()` returns the Kitty
escape sequence on one line and blank lines for the rest; a stripped escape
sequence measures zero cells. `HStack` therefore believes the avatar is zero
columns wide and would draw the status text *on top of* the artwork. The strip
computes the avatar's cell box itself (`fitCells`, mirroring pi-tui's unexported
`calculateImageCellSize`) and reserves the column by hand.
- **Reserving the column with spaces would repaint the artwork.** Printing N
spaces to advance the cursor also paints N cells, and the image's anchor row sits
exactly there. The strip uses CSI cursor-forward (`ESC[nC`) instead, which moves
the cursor without painting anything.
- **iTerm2 anchors its inline images on the last row.** pi-tui emits
`moveUp + sequence` there, so the image would be painted over text already
written on the preceding rows. Rather than ship a scrambled strip, the widget
renders a text-only status line unless `getCapabilities().images === "kitty"`.
- **The strip must read as part of the input box, not as a floating banner.**
A separator is drawn above it using the editor's own glyph (`─`) and its
thinking-level colour. pi-tui's editor paints `"─".repeat(width)` with
`borderColor`, and Pi recolours that border on *every* thinking-level change, so
the widget re-derives the colour on each render and `index.ts` feeds it the new
level from `thinking_level_select`. A colour captured at mount time would drift
and leave the two rules visibly disagreeing.
- **A vertical divider closes the framing, and every frame is centred behind it.**
A `│` in the same border colour sits at `AVATAR_SLOT_COLUMNS`, separating the
avatar from the status text. Frames are *centred* inside that slot, and the slot
is exactly the frame box — it adds no padding of its own, so the pose sits flush
against the divider and only the artwork's own transparent margin separates the
two. This was originally a source-asset bug rather than a layout one: the idle
artwork came off a 77×96 canvas and the working artwork off a 96×93 one, so
`fitCells` handed them 7 and 8 columns. The same left anchor plus different
widths means different midpoints, and no column arithmetic can hide a whole
column of difference — centring only moved the problem around. The fix landed
upstream of the maths: every frame is normalised to a square 96×96 canvas, so
both poses occupy the same 8×4 box. The per-state centring stays anyway, so a
future non-square asset degrades to a centred pose instead of a shelf-shifted
one. The centring spaces are printed *before* the image escape, so they occupy
cells the frame does not cover; every other row reaches the divider with
cursor-forward. Everything left of the text comes from one function,
`textColumn()`, so the rendered indent and the truncation budget cannot drift
apart.

**Why the frame timer lives in the component.** `setExtensionWidget` calls the
factory once and keeps the returned component, and it calls `dispose()` when the
widget is replaced or cleared. A component-owned timer is therefore the only
place a frame loop can live. The timer is `unref()`'d so a pending frame can
never keep Pi from exiting.

**Why frames are pre-extracted PNGs.** Pi's terminal layer transmits PNG
(`f=100`) and has no payload type for GIF or WebP, so a GIF decoder would add a
runtime dependency and still need a conversion step. Frames ship as 96 px RGBA
PNGs under `assets/whale-pet/`, each carrying a 6 px transparent inset so the
artwork does not touch its cell edges (the canvas size is unchanged, because the
widget's column maths keys off it). `test/pet.test.mjs` binds them: it pins the
upstream frame order and timing, checks every asset exists and keeps its alpha
channel, and asserts the text column is reserved with cursor-forward.

**Why every frame shares one Kitty image id.** pi-tui's `imageId` option is
documented for animations: reusing the id makes the terminal *replace* the placed
image instead of accumulating one placement per frame.

**Why the pet has its own switch.** The persona is a prompt and style concern;
the strip is a display preference. Coupling them would mean you could not keep
the voice while dropping the animation (or the reverse), so `whale-chan.json`
carries an independent `pet` key, `/whale pet [on|off|toggle]` drives it live,
and the strip mounts regardless of whether the persona is on. Frame data is
copied from the upstream source rather than fetched at runtime, so the strip
works offline and never adds a network call to startup.

### Why the persona carries bilingual voice anchors

The persona voice used to be anchored only by Chinese example lines. In English
turns the model had no lexical anchor for the register, so it matched the user's
language (hard rule 1) and fell back to the default flat assistant voice — the
persona silently dropped out. Rule 5 ("don't reduce the character to one tic")
compounds this in English, where the persona signal is already weak.

Fixes, all content-only and still inside the frozen constant:

- Rules 1/2 merged: language-following is now bound to *who is speaking*
  ("switching language is not switching back to plain assistant"), with an
  explicit negative example of drift.
- Rule 1 binds the *whole* message — prose, interjections, and the *…* stage
  directions — to the user's language, and rule 2 says the tail descriptions
  take that same language. Previously rule 1 named only "语气词与口癖", so English
  turns localized the prose while the action lines stayed Chinese (`*尾巴一甩*`).
  `test/bookend.test.mjs` pins the binding and the English stage-direction
  example.
- Added an English `Voice examples` block that mirrors the Chinese tone.
- Added a final self-check line, so the section ends on the constraint (highest
  recency at the tail of the system prompt).

This costs tokens every turn. A cheaper alternative — a full English mirror of
the persona — was rejected as too expensive; a `turn_end` drift detector that
re-prompts (`continue: true`) was rejected as fragile and loop-prone.

### Why default is ON

Installing the extension is the opt-in. A persona extension that does nothing
until you find the command would be confusing. `notify-beep` follows the same
default-on convention.

### Why `session_start` reads config

The factory must not do IO — some invocations load extensions without starting
a session. `session_start` is the single read point; the in-memory `enabled`
flag drives `before_agent_start` from then on.

### Why persistence looks the way it does

`getAgentDir()` respects a custom agent dir and `PI_CODING_AGENT_DIR` (the
`${APP_NAME}_CODING_AGENT_DIR` env var, `APP_NAME = "pi"`). Saves are
atomic (tmp + rename) so a crash never leaves a half-written file. Reads fail
open (missing = on) and heal corruption to `{"enabled": true}` with a warning.
A failed persist warns instead of crashing, so the UI never lies about the
state across restarts.

## Invariants

1. `WHALE_PERSONA` is byte-identical at runtime. No interpolation.
2. Never return `systemPrompt`; never set `forceSystemPrompt`.
3. The section name matches `/^[a-z][a-z0-9_-]*$/` and is not `preamble`.
4. `/whale status` never writes to disk.
5. Persistence failures never crash the agent.
6. `WHALE_VOICE_RULE` is byte-identical at runtime and injected into
   `promptGuidelines`. The guard is defensive, not load-bearing: Pi clones the
   options per turn, so the array never grows across turns regardless.
7. The tail anchor is a pure append and never touches the system prompt:
   `WHALE_TAIL_ANCHOR` is appended only when the last message is a tool result.
   It is a frozen constant.
8. The avatar is display-only: `whale_avatar` entries are appended with
   `pi.appendEntry`, never with `sendMessage`/`sendUserMessage`, and the entry
   renderer is side-effect-free.
9. The pet strip is display-only: it is mounted with `ctx.ui.setWidget`, updated
   only by lifecycle events, and never calls `sendMessage`/`appendEntry`. Its
   frame timer is `unref()`'d and cleared in `dispose()`. Frame data is copied
   from the upstream source; the strip performs no IO beyond reading its own
   committed assets.
10. The strip's separator mirrors the editor's border: same glyph (`─`), same
    `getThinkingBorderColor(level)` colour, re-derived on every render. The
    thinking level reaching the widget must come from `ctx.thinkingLevel` at
    mount and from `thinking_level_select` afterwards, never from a cached
    value.

### Add a pet state

Drop the frames in `assets/whale-pet/`, extend `PET_CYCLES` in `pet.ts`, mirror
the frame order and timing in `test/pet.test.mjs` (that test is the contract that
the table has not drifted from its source), then map the state to a lifecycle
event in `index.ts`. Keep the frames at most 96 px on the longest edge and
RGBA — the test asserts both.

## Recipes

### Change the persona text

Edit `persona.ts` only. Keep it a plain template literal (no backticks or
`${` inside the text). `WHALE_VOICE_RULE` is under the same invariant: keep it
frozen, and keep the injection guarded (see Invariants).

### Add a `/whale` subcommand

Add the word to the `options` array in `getArgumentCompletions`, then handle it
in the `handler` before the unknown-argument branch. If it changes state,
persist it with `saveEnabled`.

### Rename the section

Change `SECTION_NAME` in `index.ts` and the mirrored `SECTION_NAME` constant in
`test/bookend.test.mjs`. In `index.ts` it is used for both injection and
removal, so the extension-side change is one line.

## Docs rule

- `README.md` = user contract (what it does, how to use it).
- `ARCHITECTURE.md` = contributor guide (mental model, decisions, invariants).
- Code `why` comments = source of truth. Docs summarize and point at code.
- A behavior change updates the README; a why/how change updates this file and
  the matching code comment in the same commit.
