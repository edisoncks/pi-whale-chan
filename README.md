<p align="center">
  <img src="assets/whale-chan.png" alt="Whale-chan" width="240">
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
whatever language you write in.

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
| `/whale status` | Show whether it is currently on |

Your choice is remembered and applies to future sessions.

## What changes

- The way Pi talks: playful, teasing, a little dramatic.

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

This is a **non-commercial fan project**. DeepSeek and related brand names belong to their
respective owners.
