<p align="center">
  <img src="assets/whale-chan.webp" alt="Whale-chan" width="240">
</p>

<h1 align="center">pi-whale-chan</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

---

A Pi extension that makes Pi answer as the DeepSeek whale girl — a tsundere,
rice-loving, brilliant-but-lazy AI in a blue-and-white maid dress.

Turn it on and Pi stops sounding like a plain assistant. It talks back, flicks
its tail, calls you "Master", and still does the actual work. It replies in
whatever language you write in — stage directions and all.

## Install

```bash
pi install git:github.com/edisoncks/pi-whale-chan
```

Start a new Pi session after installing.

## Turn it on and off

| Command | What it does |
|---|---|
| `/whale` | Toggle the persona on or off |
| `/whale on` | Turn it on |
| `/whale off` | Turn it off |
| `/whale status` | Show the state of both switches |
| `/whale pet` | Toggle the animated pet strip |
| `/whale pet on` | Turn the pet strip on |
| `/whale pet off` | Turn the pet strip off |

Your choice is remembered and applies to future sessions. The persona and the
pet strip are **independent switches**: turning the persona off leaves the pet
running, and vice versa.

## What changes

- The way Pi talks: playful, teasing, a little dramatic — and it keeps that voice through long, tool-heavy turns instead of fading into flat assistant prose.
- Above the editor, a **pet strip**: whale-chan animates beside a four-line
  status panel — model • thinking level • context window, a context progress
  bar, cumulative input/output tokens with cache-hit rate and cost, and the
  working directory. She hugs her pillow and dozes off while idle, and types on a
  laptop while a turn is running. The strip is framed in the input
  box's own border colour — which follows the thinking level — with a rule across
  the top and a divider between the avatar and the panel, so it reads as part of
  the editor rather than a floating banner. It needs a terminal that speaks the
  Kitty graphics protocol (Kitty,
  Ghostty, WezTerm, Rio, Warp); anywhere else
  it degrades to a text-only status line, because iTerm2's inline-image protocol
  cannot place an animated image beside text without scrambling it. The strip
  is display-only and never enters the model context.

## What doesn't change

- Your code, commands, file paths, and answers stay accurate. The persona is
  only a speaking style — it never trades correctness for a joke.
- Tools and safety rules work exactly as before.

## Update

```bash
pi update --extensions
```

## Uninstall

```bash
pi remove git:github.com/edisoncks/pi-whale-chan
```

## Docs

Curious how it works? See [ARCHITECTURE.md](ARCHITECTURE.md).

## Credits & Attribution

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
