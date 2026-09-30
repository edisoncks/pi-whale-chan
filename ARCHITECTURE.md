# Architecture

Contributor guide for `pi-whale-chan`. The README is the user contract; this
file explains why and how. Code `why` comments remain the source of truth.

## Mental model

```text
PERSONA.md ──lazy read (once)──► personaText (cached)
whale-chan.json ──session_start──► enabled (in-memory)
                                        │
                          before_agent_start (every turn)
                                        │
                    options.appendSystemPrompt = base + "\n\n" + persona  (on)
                    options.appendSystemPrompt = base                      (off)
                                        │
                     Pi renders the `addendum` section → transcript delta patch
```

The extension only ever changes the `appendSystemPrompt` option, which Pi
renders as the `addendum` section — the same slot as `APPEND_SYSTEM.md`. Pi
compares the desired sections against the ones the model already has and sends a
patch (see `diffSystemPromptSections` in `dist/core/system-prompt.js`).

## Code map

| File | Responsibility |
|---|---|
| `index.ts` | Config load/save, `PERSONA.md` load + `appendSystemPrompt` injection, pet strip lifecycle, `/whale` command |
| `PERSONA.md` | The persona text itself; loaded once and appended to the system prompt |
| `pet.ts` | Frame tables and `WhalePetWidget` — the animated strip above the editor |

## Design decisions

### Why `appendSystemPrompt`, not `systemPrompt` or a custom section

Returning `systemPrompt` (or setting `forceSystemPrompt`) replaces the whole
prompt for that run. Pi's docs call this out: prefer changing prompt sections
"so Pi can append a transcript delta". A full replacement can make providers
fall back to a complete transcript checkpoint, which invalidates the cached
prefix. Mutating `event.systemPromptOptions.appendSystemPrompt` keeps us on the
patch path.

We deliberately use Pi's own append channel rather than a custom section:

- `appendSystemPrompt` renders as the `addendum` section, the exact slot Pi
  already uses for `APPEND_SYSTEM.md`. The persona therefore sits where it would
  if you pasted it into `APPEND_SYSTEM.md`, and the mechanism is the one Pi
  documents.
- Pi joins multiple append sources with a blank line, so appending to the base
  value puts the persona *after* the user's own `APPEND_SYSTEM.md` content
  instead of overwriting it.
- The section order is fixed by `buildSystemPromptSections`:
  `preamble → tools → rules → docs → addendum → project_context → skills → cwd`.
  The persona is no longer a custom section rendered after `cwd`.

### Why the persona is read once and cached

`PERSONA.md` is read lazily on first use (`loadPersonaText` in `index.ts`) and
cached, mirroring how Pi reads `APPEND_SYSTEM.md` at resource load. Reading the
file every turn would change the section as soon as the file is edited, emit a
patch, and invalidate the prompt cache. Caching keeps the rendered `<addendum>`
section byte-stable across turns, so re-applying it produces **no diff** — zero
extra tokens and zero invalidation while the persona is on.

The read is lazy rather than at factory time on purpose: some invocations load
extensions without starting a session, and the factory must stay IO-free.
`before_agent_start` is the read point for headless sessions (e.g. the eval
harness) that never emit `session_start`; `session_start` calls the same helper
only to warn when the file is missing.

### Why injection is idempotent and reversible

`agent-session.js` re-passes the same `_baseSystemPromptOptions` every turn, but
`emitBeforeAgentStart` (`dist/core/extensions/runner.js`) normalizes it into a
fresh clone before invoking handlers, so each turn's handler mutates a private
object and the base is never touched. `withPersona`/`withoutPersona` are
defensive: they strip a prior trailing `"\n\n" + persona` before re-appending, so
a hypothetical shared object could neither accumulate copies nor keep the
persona after `off`. `test/persona.test.mjs` pins both paths — the real
clone-per-turn path (base append content stays clean) and the defensive
shared-object path (one copy, and `off` restores the base).

That test also reads Pi's internal `dist/core/system-prompt.js` to assert the
rendered `<addendum>` section. The access is **optional**: the test probes a few
likely locations, validates the exports, and skips the render case with an
explicit reason if the internals move — so a Pi upgrade cannot hard-fail the
suite on a package reshuffle.

### Why the persona is no longer bookended

The previous implementation bookended the persona: the full body sat in a custom
tail section and a short voice rule was merged into the early `rules` section,
with a transient user-role anchor appended after tool output. That machinery was
removed in favour of the single `appendSystemPrompt` addendum. The tradeoff is
explicit: an `addendum` sits after `docs` but *before* `project_context`,
`skills`, and `cwd`, and it cannot be re-anchored after a tool result. So the
persona is farther from the generation point during a long, tool-heavy turn than
the old bookend-plus-anchor design, and voice drift in that position is a known
risk rather than a measured guarantee. The `eval/` ladder still measures
`full` − `none` so the effect can be tracked; see `eval/README.md`.

### Why the pet strip is hand-composed

`ctx.ui.setWidget()` keeps the strip in its original spot *above the editor*, so
its position never moves. To make it *replace* Pi's built-in footer rather than
sit above a second status panel, `ctx.ui.setFooter()` mounts an *empty*
component (the pattern from Pi's `border-status-editor.ts` example), and
`setFooter(undefined)` restores the real footer when the pet is switched off.
The footer factory is also the only place Pi hands over the footer data provider
— git branch, `ui.setStatus` entries, provider count — so the factory captures
it for the widget above to read; Pi invokes that factory synchronously, so the
capture is in place before the widget factory runs. Three pi-tui properties
decide the rendering strategy, and each one is a trap that a naive
`HStack(Image, Text)` walks straight into:

- **The image reports zero visible width.** A Kitty escape sequence measures
zero cells once stripped, so `HStack` believes the avatar is zero columns wide
and would draw the panel text *on top of* the artwork. The strip emits its own
one-line-per-row escapes (`buildBandEscapes`) and computes the avatar's cell box
itself (`fitCells`, mirroring pi-tui's unexported `calculateImageCellSize`), then
reserves the column by hand.
- **Reserving the column with spaces would repaint the artwork.** Printing N
spaces to advance the cursor also paints N cells, and the image's anchor row sits
exactly there. The strip uses CSI cursor-forward (`ESC[nC`) instead, which moves
the cursor without painting anything.
- **iTerm2 anchors its inline images on the last row.** pi-tui emits
`moveUp + sequence` there, so the image would be painted over text already
written on the preceding rows. Rather than ship a scrambled strip, the widget
renders a text-only status line unless `getCapabilities().images === "kitty"`.
- **A multi-row image is only safe in the regular renderer, not fullscreen.**
pi-tui's main-screen renderer reserves an image's full height and redraws it as
one block only when the lines after the escape are empty. Its fullscreen
(alt-screen) renderer clears each row individually instead; a clear over a
covered row detaches the image's lower cells (WezTerm erases them), so a
multi-row avatar lost its lower rows. The avatar is therefore emitted as one
**single-row** image per strip line — see "Why every strip line is its own
single-row image".
- **The strip must read as part of the input box, not as a floating banner.**
A separator is drawn above it using the editor's own glyph (`─`) and its
thinking-level colour. pi-tui's editor paints `"─".repeat(width)` with
`borderColor`, and Pi recolours that border on *every* thinking-level change, so
the widget re-derives the colour on each render and `index.ts` feeds it the new
level from `thinking_level_select`. A colour captured at mount time would drift
and leave the two rules visibly disagreeing.
- **A vertical divider closes the framing, and every frame is centred behind it.**
A `│` in the same border colour sits at `AVATAR_SLOT_COLUMNS`, separating the
avatar from the panel text. Frames are *centred* inside that slot, and the slot
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
**Why the status panel looks the way it does, and what it cannot carry.** The
four lines beside the avatar group the session into identity / gauge / meter /
location. Everything is inline and left-aligned, so a wide terminal never
flings a value to the far edge: identity (`🐳 model · 🔌 provider · 🧠 level`);
a fixed-width context gauge whose eighth-block waterline ripples with a foam
glyph while a turn runs, wearing eighth-block end walls (`▏`/`▕`) only where the
fill leaves an edge bare (both when empty, the right one when partial, none when
full); a usage meter (`↑in ↓out · R… W… · ⚡hit% · 🍚 cost`);
and a location row (`🌿 branch · 📂 cwd · session · statuses`). The panel grew
out of [pi-emote](https://github.com/cgxeiji/pi-emote)'s info panel, redesigned
to carry the footer's data rather than mirror it field-for-field.

The gauge is coloured by Pi's **own footer thresholds** — green up to 70%, yellow
above it, red above 90% — so the strip and the footer it replaces cannot
disagree; a cold cache that actually has data is red too, and an empty gauge
stays green rather than falling back to the terminal's default white.

Panel glyphs must stay within the emoji ranges the legacy terminal width tables
know (`U+1F300–U+1F64F`, `U+1F900–U+1F9FF`). xterm.js, which backs the browser
code-server client, still ships the Unicode 6 table; a Unicode 12+ pictograph
like the old `🪾` (U+1FABE) measures one cell there while the font paints two, so
the glyph overdraws the space after it. Native terminals use current width
tables and look correct, so only an in-range codepoint is portable.

`index.ts` builds one snapshot (`petStats`) from `ctx` and refreshes it on
`agent_start`, every `message_end`, `agent_settled`, `session_info_changed`, and
on `thinking_level_select`/`model_select`; the branch and statuses come from the
`footerData` the footer factory receives, and the branch subscription redraws on
checkout. The provider is rendered as its display name
(`ctx.modelRegistry.getProviderDisplayName`), not the raw id. A missing snapshot
is not an error: the panel falls back to the identity line alone, which is what
the text-only path renders.

Three footer fields are deliberately absent because the extension API does not
expose them: the auto-compaction `(auto)` marker
(`AgentSession.autoCompactionEnabled` has no `ctx` equivalent and no change
event), the subscription `(sub)` marker (`ModelRuntime.isUsingSubscription` is
not on `ctx.modelRegistry`), and the experimental-features `xp` badge
(`areExperimentalFeaturesEnabled` is not exported, and the package's `exports`
map blocks a deep import). Reaching them would mean reading Pi private state;
the strip stays on the public API instead, and `/whale pet off` restores the
built-in footer for anyone who needs them.

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

**Why every strip line is its own single-row image.** The avatar used to be a
single multi-row Kitty image anchored on the strip's first line, with the panel
drawn inside that line by relative cursor movement. That survives Pi's regular
(main-screen) renderer, which reserves a multi-row image as one atomic block, but
not its fullscreen (alt-screen) renderer: the alt-screen clears each row
individually before drawing it, and a clear over a covered row detaches the
image's lower cells — WezTerm erases them outright, leaving only the avatar's
head. Over SSH the strip is four rows tall, so the trailing panel rows were the
ones being cleared and the whole strip collapsed to its first line.

The avatar is now cut into `AVATAR_MAX_ROWS` **single-row** images, one per strip
line, each a source-cropped slice of the frame (`y`/`h` on the Kitty command; the
first line uploads the frame and the later lines are placement-only `a=p`
commands with a distinct placement id, so the payload ships once per frame). A
one-row image can only ever cover its own row, so no neighbouring row's clear can
erase it. Every row shares one image id per frame asset, so the terminal replaces
the frame's pixels in place instead of accumulating one image per animation tick.
`buildBandEscapes` and `bandRows` are exported so `test/pet.test.mjs` can pin the
tiling and the single-row escape shape.

**Why each avatar row reaches its own divider with cursor-forward.** Every strip
line still reserves the text column by hand, because a stripped Kitty escape has
a visible width of zero and `HStack` would lay the panel over the artwork. The
divider is reached with `ESC[nC` (cursor-forward), never spaces: forward moves
the cursor without painting, so the image cell cannot be repainted by the column
reservation. The centring inset is printed before the escape, which occupies
cells the image does not cover. `test/pet.test.mjs` drives the real `TuiAltScreen`
with `TERM_PROGRAM` unset (the SSH shape that reproduced the bug) and asserts
every panel row survives the per-row clears, then does the same against
`TuiMainScreen` so regular mode cannot regress.

**Why the pet has its own switch.** The persona is a prompt and style concern;
the strip is a display preference. Coupling them would mean you could not keep
the voice while dropping the animation (or the reverse), so `whale-chan.json`
carries an independent `pet` key, `/whale pet [on|off|toggle]` drives it live,
and the strip mounts regardless of whether the persona is on. Frame data is
copied from the upstream source rather than fetched at runtime, so the strip
works offline and never adds a network call to startup.

### Why the persona text lives in PERSONA.md

The persona text is content, not mechanism, so it lives in a plain Markdown file
rather than a TypeScript string constant. That keeps the voice editable without
touching code and makes the mechanism — one `appendSystemPrompt` append —
trivial to audit. `PERSONA.md` is read verbatim (trimmed). Keep it static: any
per-turn interpolation or dynamic content would re-introduce the cache churn the
caching decision above exists to prevent.

### Why default is ON

Installing the extension is the opt-in. A persona extension that does nothing
until you find the command would be confusing. `notify-beep` follows the same
default-on convention.

### Why `session_start` reads config

The factory must not do IO — some invocations load extensions without starting
a session. `session_start` is the single read point for **config**; the
in-memory `enabled` flag drives `before_agent_start` from then on. (The persona
text is read separately and lazily — see above.)

### Why persistence looks the way it does

`getAgentDir()` respects a custom agent dir and `PI_CODING_AGENT_DIR` (the
`${APP_NAME}_CODING_AGENT_DIR` env var, `APP_NAME = "pi"`). Saves are
atomic (tmp + rename) so a crash never leaves a half-written file. Reads fail
open (missing = on) and heal corruption with a warning: each key is validated
independently against its default (`{enabled: true, pet: true}`), so one bad
value cannot discard a good sibling. A failed persist warns instead of
crashing, and the in-memory switch is applied regardless, so the change takes
effect for the rest of the session — it just is not remembered across restarts.

## Invariants

1. `PERSONA.md` is read once and cached; injection never interpolates
   per-session values. The rendered `addendum` section is byte-identical across
   turns.
2. Never return `systemPrompt`; never set `forceSystemPrompt`.
3. The persona is appended after any user `APPEND_SYSTEM.md` content, never in
   place of it, and injection is idempotent/reversible.
4. `/whale status` never writes to disk.
5. Persistence failures never crash the agent.
6. The factory performs no IO: the `PERSONA.md` read happens lazily on first use.
7. The pet strip is display-only: it is mounted above the editor via
   `ctx.ui.setWidget`, and Pi's built-in footer is replaced by an empty
   `ctx.ui.setFooter` component so the status lives in one place. It is updated
   only by lifecycle events and never calls `sendMessage`/`appendEntry`. Its
   frame timer is `unref()`'d, its `footerData.onBranchChange` subscription and
   timer are cleared in `dispose()`, and unmounting clears the widget and
   restores the built-in footer. Frame data is copied from the upstream source;
   the strip performs no IO beyond reading its own committed assets.
8. The strip's separator mirrors the editor's border: same glyph (`─`), same
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

Edit `PERSONA.md` only. Keep it static: no per-session interpolation, or the
injected section changes every turn and the prompt cache never holds (see
Invariants).

### Add a `/whale` subcommand

Add the word to the `options` array in `getArgumentCompletions`, then handle it
in the `handler` before the unknown-argument branch. If it changes state,
persist it with `saveConfig` (and apply the live change even if the write fails).

## Docs rule

- `README.md` = user contract (what it does, how to use it).
- `ARCHITECTURE.md` = contributor guide (mental model, decisions, invariants).
- Code `why` comments = source of truth. Docs summarize and point at code.
- A behavior change updates the README; a why/how change updates this file and
  the matching code comment in the same commit.
