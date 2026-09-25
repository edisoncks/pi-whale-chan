# pi-whale-chan

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
