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
| `index.ts` | Config load/save, `before_agent_start` section injection, `/whale` command |
| `persona.ts` | The frozen persona string (`WHALE_PERSONA`) |

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

`getAgentDir()` respects a custom agent dir and `PI_AGENT_DIR`. Saves are
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

## Recipes

### Change the persona text

Edit `persona.ts` only. Keep it a plain template literal (no backticks or
`${` inside the text).

### Add a `/whale` subcommand

Add the word to the `options` array in `getArgumentCompletions`, then handle it
in the `handler` before the unknown-argument branch. If it changes state,
persist it with `saveEnabled`.

### Rename the section

Change `SECTION_NAME` in `index.ts`. It is used for both injection and removal,
so a rename is a one-line change.

## Docs rule

- `README.md` = user contract (what it does, how to use it).
- `ARCHITECTURE.md` = contributor guide (mental model, decisions, invariants).
- Code `why` comments = source of truth. Docs summarize and point at code.
- A behavior change updates the README; a why/how change updates this file and
  the matching code comment in the same commit.
