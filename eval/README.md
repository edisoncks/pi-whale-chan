# eval — whale-chan voice-drift measurement

Measures whether loading PERSONA.md actually keeps Pi in whale-chan's voice
through long, tool-heavy turns — the failure mode the extension exists to fix.
The unit tests prove the *mechanism* (the persona lands in the system prompt);
this proves the *effect* (the model's behavior changes).

## Sessions are LOCAL ONLY — do not wire into CI

Everything that creates a session calls a real model and needs provider
credentials from the agent dir's `auth.json`. CI has none of that. The rules:

- `npm test` (unit tests + [`test/scorer.test.mjs`](../test/scorer.test.mjs))
  and `npm run typecheck` (which also covers `eval/**/*.ts`) are credential-free
  and are what CI runs — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
- `eval/run.ts` and `eval/probe.ts` are **local, manual** tools.
- The one CI-safe piece here is `--replay`: it re-scores a stored `run.json`
  with the pure scorer and makes **zero** model calls.

## What it does

A scripted, tool-heavy prompt forces N deterministic `probe_fetch` calls (a fake
tool returning neutral JSON — no persona cues), then asks for one short spoken
paragraph. That paragraph is generated *right after tool output*, the position
where flat-assistant register leaks in. The reply is scored by the lexicon
scorer in [`scorer.ts`](./scorer.ts):

- **in-character**: has at least one *strong* whale-chan marker and no
  flat-assistant tell ("I'd be happy to", "Let me know if", ...). Ambiguous
  markers ("tail", "master", "compute", ...) and a bare `*...*` stage direction
  do not qualify on their own; stage directions only raise `voiceScore`.
- **language match**: the reply's dominant script matches the user's language.
- **stage-language ok**: `*...*` directions are in the user's language too
  (the `*尾鳍一甩*` in an English reply regression).

## Ablation ladder

`harness.ts` loads **this repo's** `index.ts` with an explicit mechanism set
(`WhaleMechanisms`), so persona-on can be compared with the flat-assistant
baseline:

| condition | PERSONA.md appended |
|---|:---:|
| `none` | – |
| `full` | ✅ |

`full` is the production default. Read `full` − `none` for the persona's overall
effect. Earlier runs (stored under `eval/results/`) used a
`none`/`persona`/`bookend`/`full` ladder that isolated the now-removed head rule
and tail anchor; those condition names no longer exist.

## Run it

```bash
# cheap smoke: one condition, one scenario
npm run eval -- --scenarios en-6 --conditions full

# persona on vs flat baseline
npm run eval -- --conditions none,full \
                --scenarios en-6,zh-6 --repeat 3

# one-shot raw transcript, to eyeball by hand before trusting any metric
npm run eval:probe -- opencode-go/deepseek-v4.1-flash 6

# re-score a stored run with no model calls (CI-safe)
node eval/run.ts --replay eval/results/<timestamp>/run.json
```

Reports land in `eval/results/<timestamp>/` (`run.json` + `report.md`), which is
gitignored.

## Caveats

- **Small N is noise.** Rates from a handful of runs are indicative, not
  significant. Increase `--repeat` and report intervals before trusting small
  deltas.
- **The scorer can be gamed** (keyword Goodhart). Calibrate thresholds against a
  small human-labelled gold set before relying on it, and treat it as a smoke
  signal — not ground truth.
- **Model-specific.** Prompt-position effects differ per model; run the ladder
  per model before generalizing.
