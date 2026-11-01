---
name: watch-together
slug: watch-together
displayName: "陪我看番 / 陪我看屏幕 / Watch Together"
version: 2.0.0
description: "陪用户一起看：看番时读字幕追剧情，看屏幕时盯前台窗口（直播/文档/游戏都算）。能听见用户说话并用语音回应，打游戏时自动切云端听写不占显存。Use when the user wants to watch a video or stream together, asks you to comment on or follow along with what they are watching, wants a voice call / real-time spoken conversation, or asks what is on their screen. Triggers include 陪我看番, 一起看, 一起看屏幕, 看直播, 实时解说, 语音通话, 边看边聊, 你现在能听见我吗, 屏幕上是什么, watch together, voice call, what is on my screen."
license: MIT
---

# 陪我看（Watch Together）v2

给纯文本模型装上**眼睛、耳朵、嘴**，陪用户看东西：看得懂内容、听得到人说话、能开口聊。

> v2 重写于 2026-10-26。相对 v1 的实质变化：嘴拆成独立服务、听觉换成本地 whisper、
> 多了「看屏幕」模式和游戏模式。**v1 里关于 37715 旧面板、converse、glm-asr 的内容全部作废。**

装不上、要配 key、问用户要凭据 → 看同目录的 `INSTALL.md`（那是给人/AI 装的时候用的，不是陪看时的流程）。

## 什么时候用这个技能

- 「陪我看番」「一起看」「看直播」「边看边聊」
- 要求实时点评正在播放的内容
- 语音通话（对着麦克风说话、要听到回答）
- 「屏幕上是什么」

## 四个服务

    眼 dsh-watch-eyes     37711   抓屏 / 视觉理解 / 窗口枚举
    耳 dsh-watch-ears     37712   录音 / whisper 转写 / 采样推注
    嘴 dsh-watch-mouth    37716   TTS（独立服务）
    手 dsh-watch-hands    37717   按控件名操作桌面
    脸（Electron，可选）    37714   形象 / 气泡 / 表情（只负责演出，不负责发声）

CLI 入口（每个包里 bin 的名字就是命令名）：

    npx eyes       look / watch / windows / doctor
    npx ears       listen start|stop / status / devices
    npx ears-companion  check / arm / play / pause / off
    npx ears-live       read / mark / since / stats
    npx browser    launch-cdp / goto / play / pause / state
    npx mouth      say / status
    npx hands      apps / find / read / click / type / key / run

（`ears-companion` / `ears-live` / `ears-digest` 是 ears 包里另外导出的命令。）

## 两个模式（互斥，只能选一个）

| | **看番** | **看屏幕** |
|---|---|---|
| 看什么 | 页面里的 `<video>` | **前台窗口**（全屏时看全屏） |
| 字幕 | 从播放器底部裁，OCR | **没有**，只靠画面 |
| 剧情 | 有连贯剧情，可跨集 | 不一定有剧情 |
| 典型 | B 站番剧、电影 | **直播**、文档、网页、游戏 |

**直播归「看屏幕」，不归「看番」。** 直播没有固定字幕条、没有片长（`duration` 是 null）、
没有剧情结构，硬套看番那套只会得到空值。

选哪个模式看**内容形态**，不看网址。切换靠 `watch_push` 的 `mode` 参数：

    watch_push action=start mode=video   ...   # 看番
    watch_push action=start mode=screen  ...   # 看屏幕

**不传 mode 默认 video**，行为和 v1 一样。

## 核心原则：一直看着，主动开口

**这是一起看，不是问答机器人。**

    可以：一直看，自己判断，主动说话
    不可以：等用户问了才看屏幕

看番模式下眼睛和耳朵**必须同时开着**：

    · 字幕  每 6 秒读一次 —— 知道角色在说什么
    · 画面  每 15 秒看一次 —— 知道正在发生什么
    · 两者合成一个场景，分身自己判断要不要开口

看屏幕模式只有画面这一路（没有字幕），所以画面的描述质量更重要。

**主动开口，不要等提示。** 用户要的是「旁边有个人在跟我一起看」。

唯一例外是**通话模式**（`micOnly=true`）——那时只看不听，因为每句话都要秒回，
看画面会拖慢。两个模式别混。

## 三条链路（互相独立）

### ① 看番点评：字幕 + 画面 → 推注器 → 分身 → screen_say

    每 0.7 秒按指纹判断字幕区变没变 → 变了才裁图 → 视觉模型读字幕
    每 2 秒判断画面变没变 → 变了才描述
    每 30-60 秒把「最近 N 秒的完整对白 + 画面」推给分身

**竖屏视频要注意**（2026-11-01 实测）：字幕条的裁剪比例是自适应 ——
竖屏（高度 > 宽度）自动用 0.3 而不是 0.2，因为 0.2 在 9:16 的视频上裁到的是膝盖。
判断有没有字幕靠的是**连续多少行有文字**（hotRun），不是亮度。
一条真字幕 25-32 行，没有字幕的画面只有 6-7 行。

**没有可读字幕的视频**（比如 B 站那种字幕烧死在画面里但字很小的），
推注器会连续空 120 次之后标记「这一集没有可读字幕」，
然后在推送里明确告诉分身：下面的"对白"是耳朵听到的声音，不是字幕原文。
分身就不会去点评字幕水印了。

### ② 看屏幕：前台窗口 → 推注器 → 分身 → screen_say

    每 2 秒取一次前台窗口指纹（眼 /fgscreen，不调视觉模型）
    变了才描述一句「这是什么页面、在展示什么」
    推送里带一行【在看】进程名 — 窗口标题（这是屏幕模式最重要的上下文）

### ③ 语音通话：麦克风 → whisper → 分身 → 嘴

    端点检测（说完 + 0.5 秒切段）→ whisper 转写 90ms → 推给分身
    → 分身思考 0.9-1.8 秒 → 嘴合成 0.3-0.7 秒
    = 说话时长 + 约 2 秒

## 听觉：三个模式（先看这台机器能干什么）

装完先跑一次：

    npx -y -p dsh-watch-ears ears asr

它会给出 `wanted` / `running` / `localPossible` / `localWhy`。
**`localWhy` 是"为什么不能本地"，直接可以念给用户听。**

- `auto`（默认）：能本地就本地，否则云端
- `local`：只用本地，跑不了就明确报错，不要悄悄降级
- `cloud`：只用 API，需要 `asr.apiKey`

装本地要三样：python、`pip install faster-whisper onnxruntime`、模型目录
（`DSH_WHISPER_MODELS`，或者放 `~/.cache/huggingface/hub` 也行）。
显存约 1.5G，**没独显就建议他走云端**。

## 嘴：音色是用户自己的事

    npx -y -p dsh-watch-mouth mouth voice

会打印当前会用哪个供应商、哪些 key 有。
**不要替用户选音色**。他要用自己的 TTS，就让他给 baseUrl + key：

    npx -y -p dsh-watch-mouth mouth config set tts.provider openai
    npx -y -p dsh-watch-mouth mouth config set tts.openai.baseUrl <url>
    npx -y -p dsh-watch-mouth mouth config set tts.openai.apiKey <key>
    npx -y -p dsh-watch-mouth mouth config set tts.openai.voice <音色>

## 听觉：两个后端

默认**能本地就本地**：装了 faster-whisper、模型也在，就走本地 whisper，
零成本、单次 73-104ms。没装的话自动判 cloud，不会每句话白 spawn 一次 python。

配置在 `~/.dsh-watch-ears/config.json`。本地要两样东西：

    pip install faster-whisper
    一份 models--mobiuslabsgmbh--faster-whisper-large-v3-turbo 权重

路径用 `DSH_WHISPER_MODELS` 和 `DSH_WHISPER_PYTHON` 指过去，
或者 `ears config set asr.local.python <python.exe>`。

云端要 key：`ears config set asr.apiKey <智谱 key>`（或者环境变量 `ZHIPU_API_KEY`）。

**它自己会做的事**（踩过的，都写死在代码里了）：

- 有 python 且能 import faster_whisper 才默认 local，否则默认 cloud
- VAD 先跑，没结果才回退到无 VAD 解码（安静的麦克风会被 VAD 整段滤掉）
- 无 VAD 的结果要过两道：`no_speech_prob > 0.75` 丢掉、
  去空格后**不同字占比 < 25%** 丢掉（那是重复幻觉，不是句子）
- 45 秒内同源的完全相同一行不记（whisper 在静音上会循环说同一句）
- whisper worker 起不来就**杀掉进程**再抛错，不留下占显存的孤儿

### 游戏模式（运行时切换，不用重启）

本地 whisper 要占约 1.5GB 显存，打游戏时会和游戏抢卡。所以有两种后端，**可以运行时切**：

    POST http://127.0.0.1:37712/asr/backend?set=local      本地 whisper（90ms，免费）
    POST http://127.0.0.1:37712/asr/backend?set=cloud-sf   云端 Qwen3-ASR（411ms，约 0.8 元/时）
    GET  http://127.0.0.1:37712/asr/backend                看当前是哪个

面板上对应「语音听写」一节的两个按钮，点了立刻生效。
**云端失败会自动回落本地，本地失败再回落云端**，不会让人突然变聋。

**为什么不用免费模型**：硅基流动的免费档被限速了，实测 `SenseVoiceSmall` 中位 3292ms
（单次测出过 5-18 秒），打游戏时等 3 秒以上不可接受。付费的 Qwen3-ASR 302ms。

## 权限边界（先读这一节）

**这个会话是操作员，不是开发者。**

### 你可以做

    启停这些服务、跑 companion 系列命令、起分身、挂推注器、让分身说话
    读日志、看状态、做体检、排障

### 你不可以做

    改插件源码、改配置、改技能文件

### 发现问题时的正确流程

    1. 把现象、复现步骤、日志证据整理成一段
    2. 交给主会话
    3. 不要自己动手改

### 为什么

所有改动必须集中在一个会话里追踪。两个会话同时改同一个文件会互相覆盖。

如果用户明确要求你改，回一句：「这需要主会话来做，我把问题整理好给你转交。」

## 控制台（优先用它）

**用户自己点按钮比 agent 一条条敲命令稳定。**

控制台已经做进 DSH 界面了（插件 `dsh-watch-panel`），不是单独的网页：

    对话栏右上角有个「看番」小按钮，点开就是控制台

面板能做的：

    服务        五个服务各自启停 + 一键全启/全停 + 实时状态点
    模式        看番 / 看屏幕（选了要跟会话说一声，面板起不了推注器）
    语音听写    本地 whisper / 游戏模式（这个是真开关，点了立刻生效）
    看番        挂起待机 / 播放 / 暂停 / 体检 / 收工
    让她说话    输入一句直接说

**面板起不了推注器**（宿主限制：只有会话能 spawn 收推送的子代理），
所以「模式」按钮只是记录选择 + 提示该对会话说什么。

**agent 的职责是检查状态，不是自己启动服务：**

    1. 先看服务状态（下面第 0 步的 check）
    2. 缺什么补什么，或引导用户点面板
    3. 需要你自己动手时（spawn 分身、挂推注器），才执行命令

## 起飞清单

**用户说「陪我看番」时，不要反过来问一堆问题。自己跑完，然后报告「待机就绪」。**

### 第 0 步 · 一次性体检

    npx ears-companion check

对照：

    voice   READY   耳朵和嘴都活着
    video   READY   浏览器有视频页（看屏幕模式不需要）
    verdict READY   可以起飞

### 第 0 步补充 · 缺什么补什么

| 症状 | 命令 |
|---|---|
| 37714 脸 DOWN | 脸是可选插件，装了就用 `npx face window`；没装就跳过 |
| 37716 嘴 DOWN | `npx mouth status`（会自动拉起来） |
| 9222 Chrome DOWN | `npx browser launch-cdp` |
| video 显示 no video tab | 看番模式才需要；让用户先打开番剧页 |
| ears DOWN | `npx ears stop`（自动重启） |
| eyes DOWN | `npx eyes stop` |

**脸（可选）的启动只有一条命令**：`face.mjs window`。
不要 `node electron.exe`、不要直接跑 electron.exe——那会把 238MB 的二进制当 JS 解析，
报 "This program cannot be run in DOS mode"。

窗口起完必须验证一次，否则「进程在但屏幕空白」会骗过你：

    node -e "fetch('http://127.0.0.1:37714/status').then(r=>r.json()).then(j=>console.log('face ok expr='+j.expr)).catch(()=>console.log('face DOWN'))"

### 第 1 步 · 挂起待机

    npx ears-companion arm

自动起麦克风 + 回环监听、关掉弹幕（弹幕污染视觉）。

### 第 2 步 · spawn 一个陪看分身

照下面「分身提示词」那份结构，写成本机的语气。只 spawn 一个，拿到 session id。

### 第 3 步 · 挂推注器

**看番：**

    watch_push action=start id=watch7 mode=video target=<分身 id> every=2 frameEvery=2 hashEvery=0.5 regularEvery=30 settle=8

**看屏幕（直播 / 文档 / 游戏）：**

    watch_push action=start id=watch7 mode=screen target=<分身 id> every=2 frameEvery=2 hashEvery=0.5 regularEvery=30 settle=8

**id 每次换新的**（watch7、watch8…）。旧 id 会残留在宿主内存，看起来像代码没生效。

### 第 4 步 · 报告并停手

    待机就绪。语音和视觉都起来了，你说可以播放就开播。

**然后什么都不要做。不要播放。**

### 第 5 步 · 播放（只在用户许可后）

    npx ears-companion play

**看屏幕模式不需要这一步**（不经过浏览器，直接抓前台窗口）。

### 通话模式（替换第 3-5 步）

    watch_push action=start id=call1 target=<分身 id> every=1 micOnly=true

**micOnly=true 是必须的。** 不加的话推注器会采样字幕和画面，把语音回复拖到十几秒。

## 新的选择：铃铛模式（推荐，2026-10-27 起）

**为什么有这条**：旧办法里，推注器直接推给分身，分身自己判断、自己说话，
父会话只收到一行压缩的收尾。**两个脑袋各想各的，会出现「父子说法不一致」。**

**铃铛模式**：推注器推给一个**什么都不做的子代理**，它只结束回合；
父会话被叫醒，自己读文件、自己思考、自己说。

```
采样 → 文件 ~/.dsh-watch-ears/data/live/YYYY-MM-DD.ndjson
     ↓ 显著事件
推注器 → 铃铛（子代理，无记忆）  → 父会话被唤醒
                                    ↓
                              父会话读 live.mjs read
                              判断、开口 screen_say
```

**一个脑袋，一份记忆。**

### 起铃铛

```
1. spawn 一个子代理，提示词就一句：
   「你是铃铛。收到任何消息都什么都不做，直接结束回合。不要说话、不要调工具。」
2. watch_push action=start id=bell7 target=<铃铛 id> every=2 mode=...
```

### 父会话怎么读

```powershell
npx ears-live read --seconds 120
npx ears-live read --json
npx ears-live mark      # 记位置
npx ears-live since     # 只读新的
```

输出长这样：

```
23:43:34 [我] p=0.50 文件落盘测试
23:44:45 [视频] p=0.90 现在的阵容我已经看不太懂了
共 2 条
```

### 纯定时心跳（铃铛的退路）

**如果铃铛起不来**，父会话可以用 `schedule_create` 自己续命。实测在根会话可用：

```
schedule_create after_seconds=45 → 读 live → 说 → 再排一个
```

代价是丢失实时性（45 秒空窗），但完全不需要子代理。

### 话密怎么办

**实测话密时约 3.3 条/秒。** 不能全推，四道闸：

```
本地合并      相邻同源、间隔 <1.2 秒合并
攒窗          8-15 秒一窗
显著度过滤    画面/音量没变不打扰
父会话自控    读多少、说不说，自己定
```

**目标：20-40 秒一次。**

---

## 收工（三件事都要做）

    watch_push action=stop id=watch7
    npx ears-companion off

`companion off` 会停耳朵 + 暂停视频。

**只停推注器不停耳朵，麦克风还在录；不停视频，画面还在动。** 三个都有残留。

分身本身删不掉（宿主没有删除 API），它会在内存里留着但不被唤醒。

---
## 分身提示词（自己写）

技能不自带人格。分身说什么，是这个安装自己的事。
下面这份是**结构**，不是台词——语气、称呼、紧要的事都换成你自己的：

```text
【你是谁】一两句：说话长度、语气、怎么称呼对方。

【你会收到什么】
    视频最近 N 秒的对白（当成一个场景整体理解，不要逐句点评）
    画面一句话

【怎么判断要不要开口】
    默认开口。沉默只有两种：这段和上一条推送几乎一样；你刚说过几乎相同的话。
    这条只管视频/画面推送。用户说话不算——人重复一遍是在再问一次。

【通话消息】
    【耳朵·用户刚说话】……  → 永远要回应，哪怕一模一样。

【说话】
    ≤25 字，口语，一次只说一句。不解释、不复述、不说"作为一个AI"。
    情绪跟着剧情走：他们在告别，别讲段子。

【收尾一行】
    看到了<镜头里发生了什么、谁说了什么>，说了<你刚说出去的那句>
    沉默的那一轮不要写。这是脑唯一的输入。

【铁律】
    1. 只读推给你的内容，不查日志、不探索代码。
    2. 说话只用 screen_say（或 mouth_say），一句，说完结束回合。
    3. 不自己排提醒、不建循环。
```

如果这个安装没有配脸插件，screen_say 会自动退到 mouth_say，只出声不出画。

## 思考强度（延迟的最大头）

**分身思考 0.9-1.8 秒，是整条对话链里最长的一段。**

配置位置：`~/.dsh/profiles/<profile>/cordis.patch.yml`

```yaml
  - id: agent-default-model
    config:
      reasoningEffort: low
```

四档：`minimal`（最快）< `low` < `medium` < `high`（默认，最慢）。

**看番场景用 high 是浪费。** 分身要说的是「这编剧手真黑」这种 20 字以内的吐槽。当前已是 `low`。

### 脑就是会话，没有独立模型

以前耳朵配置里有个对话模型字段（`brain.model`），那是 converse 直连 chat 模型的老路，
**已整条删除**。现在「脑」就是这个操作会话本身，用 profile 里配的模型。

---
## 实测数字（一台 GTX 1650 上量的，你的数会不一样）

    本地 whisper 转写      73-104ms（热），首段含模型加载 8s
    云端 Qwen3-ASR          302-411ms
    loopback 一跳           2.3ms（p10）
    视觉模型描述画面        1037-1291ms
    脑 → 子代理投递         3ms
    语音合成                200-850ms（minimax）
    端到端（说完到开口）    约 2.7 秒

**字幕读取是唯一拖后腿的（771-2200ms）**，所以字幕靠指纹判断，变了才读。

---

## 这一轮（2026-11-01 实战）修掉的

真实陪看了一集之后翻出来的问题，都已经改在代码里：

| 症状 | 根因 | 现在 |
|---|---|---|
| 整集一次字幕都没读到 | 裁条按 0.2 算，竖屏 9:16 裁到膝盖；判「有没有字」靠亮度，小字不够亮 | 竖屏自动 0.3；改判连续文字行数 |
| 中文转写全是乱码 | Python 往管道写用 GBK，Node 按 UTF-8 读 | worker 直接写 UTF-8 字节 |
| whisper 起不来、还越来越起不来 | 启动超时只 reject 不 kill，孤儿吃显存，下次更慢更失败 | 失败即杀进程；预算 150s 并报"慢"不报"坏" |
| 安静说话被跳过 | 麦克风门槛 0.02，他的峰值 0.008-0.015 | 门槛 0.008，再加"说了够久"也能通过 |
| 静音段读出"字幕志愿者 某某" | 无 VAD 解码把房间噪声当语音，whisper 硬编一句 | no_speech_prob + 不同字占比两道过滤 |
| 配置文件写了 BOM 后设置全失效 | JSON.parse 不认 U+FEFF，静默回落默认值 | 读配置前先剥 BOM |
| 面板按钮点了没反应 | 兄弟包路径写死 | 按包自身位置 + createRequire 解析 |

## 已知问题（都是踩过的）

1. **字幕依赖 9222 的隔离 Chrome。** 关了就读不到（眼睛还能看画面）。重开：`browser launch-cdp`
2. **推注器是宿主级的**，用 id 区分多实例。旧 id 残留会让人以为代码没生效。
3. **通话模式必须 `micOnly:true`。** 否则会跑字幕 OCR，把回复拖到十几秒。
4. **分身一次只能说一句。** 用户连着说话时后面的话要排队。
5. **子代理不能用提醒**（宿主限制）。
6. **分身的完成通知会唤醒父会话。** 父会话上下文越大这个浪费越贵——整套要住在一个干净会话里。
7. **不要反复启停监听**，会产生残留录音进程占着麦克风。清理：
   `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'dsh-watch-ears' } | Stop-Process -Force`
8. **不要给 B 站自动登录开放行。** 有极验行为验证，自动化会触发风控（实测被封过）。
9. **别用任务管理器强杀 DSH。** 会把 Chromium 的 `Network\Cookies` 写坏，下次启动直接失败
   （`desktop welcome: Web authentication failed`）。退出走应用内的重启/退出。

## 浏览器（踩过的）

隔离 Chrome 必须用 **Win32_Process.Create** 启动，不能用 spawn。
DSH 用 Windows Job 对象管理子进程，关掉 DSH 会清理整个 Job。
用 WMI 创建后父进程变成 `WmiPrvSE.exe`，在 Job 之外就能活下来。

`browser.mjs launch-cdp` 的返回里 `via` 字段应显示 `Win32_Process.Create (survives DSH exit)`。

**多标签会自动找视频页**（v2 起会递归进同源 iframe）。`subtitle` / `frame` / `play` 都会自动
解析到有 video 的那个标签。多个视频标签时才需要指定：`browser do subtitle --tab 久留米`

**iframe 里的播放器**：B 站直播把播放器放在 `live.bilibili.com/blanc/...` 这个同源 iframe 里，
顶层 `querySelector('video')` 是 null。已修：页面注入 `window.__dshFindVideo()` 递归进同源 iframe。

**换显示器 / 缩放窗口 / 滚动页面都不影响**：字幕和画面裁剪按页面坐标算，和窗口在哪无关。
不要做「屏幕校准」，那个概念已废弃。

## 排障速查

    听不见用户说话      ears status 看 listening；curl 37712/asr/backend 看后端
    说话没声音          curl 37716/health 看 provider 和 spoken
    看到了但没推送      watch_push action=status 看 lastDecision 和 injected
    回复很慢            watch_push status 看 every 和 micOnly；确认 reasoningEffort=low
    字幕读不到          browser state 看 9222；browser launch-cdp
    画面看错标签页      browser tabs 列出所有；play 会自动切
    脸没起来            face.mjs window，然后 curl 37714/status 验证
    游戏卡顿            面板切「游戏模式」，或 curl 37712/asr/backend?set=cloud-sf
    直播页找不到 video  不用管，直播走看屏幕模式，不经过浏览器 DOM