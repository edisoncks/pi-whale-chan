<p align="center">
  <img src="assets/whale-chan.webp" alt="鲸鱼娘" width="240">
</p>

<h1 align="center">pi-whale-chan</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

---

一个让 Pi 以「深度求索鲸鱼娘」人格回答的 Pi 扩展 —— 一只傲娇、钟爱白米饭、聪明却有点懒的蓝白女仆装 AI。

开启之后，Pi 就不再是那个一本正经的助手了。它会回嘴、甩尾巴、管你叫「主人」，而且活儿照样干得漂亮。你用哪种语言，它就用哪种语言回复——连动作描写也一样。

## 安装

```bash
pi install git:github.com/edisoncks/pi-whale-chan
```

安装完成后，新开一个 Pi 会话即可。

## 开启与关闭

| 命令 | 作用 |
|---|---|
| `/whale` | 切换人格开 / 关 |
| `/whale on` | 开启 |
| `/whale off` | 关闭 |
| `/whale status` | 查看两个开关的当前状态 |
| `/whale pet` | 切换动态宠物状态栏 |
| `/whale pet on` | 开启宠物状态栏 |
| `/whale pet off` | 关闭宠物状态栏 |

你的选择会被记住，并应用到以后的会话。人格与宠物状态栏是**两个独立开关**：
关掉人格不会连宠物一起收走，反之亦然。

## 会变的是什么

- Pi 的说话方式：俏皮、爱调侃、有点戏精 —— 而且在漫长的工具调用里也能把这份语气保持住，不会退化成一本正经的助手腔。
- 每次回复前（包括工具调用之后的回复），对话里会先显示鲸鱼娘的头像：支持内联图片的终端（Kitty、iTerm2）显示 200×200 px 立绘，不支持的终端显示紧凑的文字占位。头像只用于显示——绝不会进入模型上下文，也不消耗 token。
- 输入框上方多一条**宠物状态栏**：鲸鱼娘会在当前模型与状态（`idle` / `working`）旁边动起来。空闲时抱着枕头打瞌睡，一轮任务跑起来就抱着笔记本噼里啪啦。状态栏用输入框自己的边框色框住（颜色跟随思考等级）——上方一条横线，头像与状态文字之间一条竖线——所以它看起来是编辑器的一部分，而不是一条飘着的横幅。它需要支持 Kitty 图形协议的终端（Kitty、Ghostty、WezTerm、Rio、Warp）；其他终端会降级成纯文字状态栏——因为 iTerm2 的内联图片协议无法把动图放在文字旁边而不糊成一片。和头像一样，这条状态栏只用于显示，绝不进入模型上下文。

## 不会变的是什么

- 你的代码、命令、文件路径和答案依然准确。人格只是一种说话风格 —— 绝不会为了玩梗牺牲正确性。
- 工具和安全规则和以前完全一样。

## 更新

```bash
pi update --extensions
```

## 卸载

```bash
pi remove git:github.com/edisoncks/pi-whale-chan
```

## 文档

想了解它的工作原理？请看 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 致谢与版权

鲸鱼娘（深度求索鲸鱼娘）是**社区共创的同人角色，与 DeepSeek 官方无关**。
本扩展的人设对齐社区项目
[DeepSeek Whale-chan](https://github.com/Neko3000/deepseek-whalechan) 的角色设定规范，
其设定文档以 [CC-BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 协议共享。
角色原始设计的版权归社区及原作者所有。

动态宠物状态栏的素材衍生自 [dsh-whale-pet](https://github.com/Er1c0v0/dsh-whale-pet)（作者 Er1c0v0），
依 [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) 协议使用；
具体范围与修改清单见 [ASSET_ATTRIBUTION.md](ASSET_ATTRIBUTION.md)。

本项目为**非商业同人项目**。DeepSeek 及相关品牌名称归其各自所有者所有。
