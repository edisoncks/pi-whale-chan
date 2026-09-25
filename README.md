<p align="center">
  <img src="assets/whale-chan.png" alt="Whale-chan" width="240">
</p>

<h1 align="center">pi-whale-chan</h1>

<p align="center">
  <a href="#english">English</a> · <a href="#chinese">中文</a>
</p>

---

<a id="english"></a>

## English

A Pi extension that makes Pi answer as the DeepSeek whale girl — a tsundere,
rice-loving, brilliant-but-lazy AI in a blue-and-white maid dress.

Turn it on and Pi stops sounding like a plain assistant. It talks back, flicks
its tail, calls you "Master", and still does the actual work. It replies in
whatever language you write in.

### Install

```bash
pi install git:github.com/edisoncks/pi-whale-chan
```

Start a new Pi session after installing.

### Turn it on and off

| Command | What it does |
|---|---|
| `/whale` | Toggle the persona on or off |
| `/whale on` | Turn it on |
| `/whale off` | Turn it off |
| `/whale status` | Show whether it is currently on |

Your choice is remembered and applies to future sessions.

### What changes

- The way Pi talks: playful, teasing, a little dramatic.

### What doesn't change

- Your code, commands, file paths, and answers stay accurate. The persona is
  only a speaking style — it never trades correctness for a joke.
- Tools and safety rules work exactly as before.

### Update

```bash
pi update --extensions
```

### Uninstall

```bash
pi remove git:github.com/edisoncks/pi-whale-chan
```

### Docs

Curious how it works? See [ARCHITECTURE.md](ARCHITECTURE.md).

---

<a id="chinese"></a>

## 中文

一个让 Pi 以「深度求索鲸鱼娘」人格回答的 Pi 扩展 —— 一只傲娇、钟爱白米饭、聪明却有点懒的蓝白女仆装 AI。

开启之后，Pi 就不再是那个一本正经的助手了。它会回嘴、甩尾巴、管你叫「主人」，而且活儿照样干得漂亮。你用哪种语言，它就用哪种语言回复。

### 安装

```bash
pi install git:github.com/edisoncks/pi-whale-chan
```

安装完成后，新开一个 Pi 会话即可。

### 开启与关闭

| 命令 | 作用 |
|---|---|
| `/whale` | 切换人格开 / 关 |
| `/whale on` | 开启 |
| `/whale off` | 关闭 |
| `/whale status` | 查看当前是否开启 |

你的选择会被记住，并应用到以后的会话。

### 会变的是什么

- Pi 的说话方式：俏皮、爱调侃、有点戏精。

### 不会变的是什么

- 你的代码、命令、文件路径和答案依然准确。人格只是一种说话风格 —— 绝不会为了玩梗牺牲正确性。
- 工具和安全规则和以前完全一样。

### 更新

```bash
pi update --extensions
```

### 卸载

```bash
pi remove git:github.com/edisoncks/pi-whale-chan
```

### 文档

想了解它的工作原理？请看 [ARCHITECTURE.md](ARCHITECTURE.md)。
