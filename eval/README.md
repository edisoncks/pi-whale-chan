# eval — whale-chan voice-drift measurement

Measures whether the persona mechanisms actually keep Pi in whale-chan's voice
through long, tool-heavy turns — the failure mode the extension exists to fix.
The unit tests prove the *mechanism* (the anchors get injected); this proves the
*effect* (the model's behavior changes).

## LOCAL ONLY — do not wire into CI

Everything that creates a session calls a real model and needs provider
credentials from the agent dir's `auth.json`. CI has none of that. The rules:

- `npm test` (unit tests + [`test/scorer.test.mjs`](../test/scorer.test.mjs))
  stays credential-free and is the only thing CI should run. `npm run typecheck`
  covers `eval/**/*.ts` too and needs no credentials.
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
(`WhaleMechanisms`), so each mechanism's contribution is isolated:

| condition | persona (tail) | head rule | tail anchor |
|---|:---:|:---:|:---:|
| `none` | – | – | – |
| `persona` | ✅ | – | – |
| `bookend` | ✅ | ✅ | – |
| `full` | ✅ | ✅ | ✅ |

Read the delta between rungs: `bookend` − `persona` isolates the head rule,
`full` − `bookend` isolates the tail anchor.

A clean `bookend,full` run at n=30/arm (en-6+zh-6) gives the tail anchor a
measurable edge: 77% → 87% in-character, 80% → 90% language match, 75% → 79%
stage-language, mean voice 5.40 → 5.87. One model, no confidence intervals —
indicative, not precise. Earlier stored runs did not isolate this cleanly (their
n=30 compared `bookend+B` vs `full`; the clean pair was only n=8).

A second mechanism — a throttled tool-result anchor ("A") — was evaluated here
and **removed**: across n=30 per arm it showed no measurable effect
(in-character 29/30 with and without it; language and stage-language deltas
within one or two samples). See [the merged implementation PR](https://github.com/edisoncks/pi-whale-chan/pull/1)
and the [pinned experiment notes](https://github.com/edisoncks/pi-whale-chan/blob/9a0108185ad72977d5685911256cd24f3abba403/eval/README.md#L52-L58).

## Run it

```bash
# cheap smoke: one condition, one scenario
npm run eval -- --scenarios en-6 --conditions full

# full ladder
npm run eval -- --conditions none,persona,bookend,full \
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
- **Model-specific.** Anchor channels are discounted differently per model; run
  the ladder per model before generalizing.
