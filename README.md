<p align="center">
  <img src="assets/whale-chan.webp" alt="Whale-chan" width="240">
</p>

<h1 align="center">pi-whale-chan</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://nodejs.org"><img alt="Node 22.19.0 or newer" src="https://img.shields.io/badge/node-%E2%89%A522.19.0-brightgreen"></a>
  <a href="https://github.com/edisoncks/pi-whale-chan/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/edisoncks/pi-whale-chan/actions/workflows/ci.yml/badge.svg"></a>
</p>

---

A Pi extension that makes Pi answer as the DeepSeek whale girl — a tsundere,
rice-loving, brilliant-but-lazy AI in a blue-and-white maid dress.

Turn it on and Pi stops sounding like a plain assistant. It talks back, flicks
its tail, calls you "Master", and still does the actual work. It replies in
whatever language you write in — stage directions and all.

Installing it is the opt-in: the persona is **on by default**.

## Demo

[▶ Watch the 28-second demo](https://github.com/user-attachments/assets/72e1d11a-7b14-4af7-b6e7-a6ee94329b0d)

![The whale-chan status strip mid-turn: the avatar beside model · provider · thinking level, a context gauge, a token/cache/cost meter, and the git branch · cwd](assets/screenshot-status-working.png)

<sub>928×672 screen capture · committed copy: <a href="assets/whale-chan-demo.mp4">MP4</a> (234 KB)</sub>

<!-- The demo link is a GitHub user attachment: it renders as a player on github.com and degrades to
     a plain link elsewhere, because a committed MP4 cannot play inline. The committed MP4 is the
     durable copy. -->

## Features

- **A voice loaded from one file.** The persona lives in
  [`PERSONA.md`](PERSONA.md) and is appended to the system prompt's `addendum`
  section — the same slot Pi uses for `APPEND_SYSTEM.md`, and after your own
  append file, so it never overwrites your instructions.
- **Language mirroring.** Write in Chinese, English, Japanese, German, anything —
  whale-chan answers in that language, *stage directions included*
  (`*tail flick*`, not `*尾巴一甩*`).
- **An animated status strip.** A whale-chan avatar beside a four-line status
  panel that replaces Pi's built-in footer, so the status lives in one place
  instead of two.
- **Two independent switches.** Keep the voice without the animation, or the
  reverse — the persona and the strip toggle separately.
- **Correctness untouched.** The persona is a speaking style only. Code, commands,
  file paths, and answers stay accurate; tools and safety rules are unchanged.

## Requirements

- A working Pi install.
- **Node ≥ 22.19.0.**
- For the animated strip, a terminal that speaks the **Kitty graphics protocol**
  (Kitty, Ghostty, WezTerm, Rio, Warp). Anywhere else — iTerm2 included — the
  persona still works and the strip degrades to a text-only status line.

## Install

```bash
pi install git:github.com/edisoncks/pi-whale-chan
```

Start a new Pi session afterwards. The persona is on by default; the strip mounts
in TUI mode.

> This package is not published to npm — install it straight from the repository,
> as above.

## Using it

| Command | What it does |
|---|---|
| `/whale` | Toggle the persona on or off |
| `/whale on` / `/whale off` | Turn the persona on or off |
| `/whale status` | Show the state of both switches — read-only |
| `/whale pet` | Toggle the animated strip |
| `/whale pet on` / `/whale pet off` | Turn the strip on or off |

Your choice is remembered and applies to future sessions. The persona and the
strip are **independent switches**: turning the persona off leaves the strip
running, and vice versa.

The strip is what hides Pi's built-in footer, so `/whale pet off` is also how you
get the footer back.

## The status strip

She sits above the editor and animates beside a four-line panel that regroups the
footer's data:

| Line | Shows |
|---|---|
| Identity | `🐳 model · 🔌 provider · 🧠 thinking level` |
| Context | a fixed-width gauge — fresh input as `█`, cached prompt as `░`, a waterline that ripples while a turn runs — with its reading beside it |
| Usage | `↑in ↓out · R/W cache · ⚡ hit rate · 🍚 cost` |
| Location | `🌿 branch · 📂 cwd · session name · ui.setStatus entries` |

Everything is inline and left-aligned, so a wide terminal never flings a value to
the far edge. The strip is framed in the input box's own border colour — which
follows the thinking level — with a rule across the top and a divider between the
avatar and the panel, so it reads as part of the editor. She hugs her pillow and
dozes off while idle, and types on a laptop while a turn is running.

The strip is display-only and never enters the model context.

<details>
<summary><strong>Terminal support, and the footer fields it can't carry</strong></summary>

- **Terminals.** The animated avatar needs the Kitty graphics protocol (Kitty,
  Ghostty, WezTerm, Rio, Warp). Elsewhere — iTerm2 included — the strip renders a
  text-only status line instead, because iTerm2 anchors inline images on the last
  row, which would paint over the text already written above.
- **Three footer fields are not mirrored**, because Pi does not expose them to
  extensions: the auto-compaction `(auto)` marker, the subscription `(sub)`
  marker, and the experimental-features `xp` badge. `/whale pet off` restores the
  built-in footer for anyone who needs them.
- **The gauge shares Pi's own thresholds** — green up to 70%, yellow above it,
  red above 90% — so the strip and the footer it replaces cannot disagree.

</details>

## Configuration

Preferences live in `whale-chan.json` in Pi's agent directory (it honours
`PI_CODING_AGENT_DIR`). A missing file means the defaults — both switches on. A
corrupt file is reset to the defaults with a warning, and a failed write warns
instead of crashing. `/whale status` never writes to disk.

## What doesn't change

- **Accuracy.** Code, commands, file paths, and answers stay correct — the persona
  never trades correctness for a joke.
- **Tools and safety** work exactly as before.
- **Your prompt cache.** `PERSONA.md` is read once per session, so re-applying it
  every turn produces no prompt diff — no extra tokens from the persona, and no
  cache invalidation while it stays on.

## FAQ

<details>
<summary><strong>I don't see the animated strip.</strong></summary>

Two things are needed: Pi in **TUI mode**, and a terminal that speaks the **Kitty
graphics protocol** (Kitty, Ghostty, WezTerm, Rio, Warp). Anywhere else, the strip
falls back to a text-only status line. Check `/whale status` to confirm the pet
switch is on.

</details>

<details>
<summary><strong>How do I reset my settings?</strong></summary>

Delete `whale-chan.json` from Pi's agent directory, or run `/whale off` and
`/whale pet off`.

</details>

<details>
<summary><strong>Does the strip go into the model's context?</strong></summary>

No. It is display-only: it renders in Pi's widget container and never enters the
conversation or the system prompt.

</details>

## Update

```bash
pi update --extensions
```

## Uninstall

```bash
pi remove git:github.com/edisoncks/pi-whale-chan
```

## Docs & contributing

- [ARCHITECTURE.md](ARCHITECTURE.md) — how and why it works: the `PERSONA.md`
  addendum, the hand-composed strip, and the invariants that hold it together.
- [eval/](eval/README.md) — the local harness that measures whether the voice
  really holds through tool-heavy turns. It needs provider credentials, so it is
  manual and never runs in CI; `npm test` and `npm run typecheck` are
  credential-free and are what CI runs.
- README changes must land in both `README.md` and `README.zh-CN.md`. A behavior
  change updates the README; a why/how change updates `ARCHITECTURE.md` and the
  matching code comment in the same commit.

## Credits & Attribution

<details>
<summary>Whale-chan is a community fan character — show the full notice</summary>

Whale-chan (深度求索鲸鱼娘) is a **non-official, community-created fan character** and is not
affiliated with DeepSeek. This extension's persona is aligned with the community
[DeepSeek Whale-chan](https://github.com/Neko3000/deepseek-whalechan) character specification;
its design docs are shared under [CC-BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
Original character-design credits belong to the community and its original creators.

The animated pet strip is derived from
[dsh-whale-pet](https://github.com/Er1c0v0/dsh-whale-pet) by Er1c0v0, used under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); see
[ASSET_ATTRIBUTION.md](ASSET_ATTRIBUTION.md) for the exact scope and the list of
modifications.

This is a **non-commercial fan project**. DeepSeek and related brand names belong to their
respective owners.

</details>

## License

MIT — see [LICENSE](LICENSE). The pet artwork is used under CC-BY-4.0 and the
character-design docs under CC-BY-NC-SA 4.0.
