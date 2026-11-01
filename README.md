# dsh-watch-stack

**给纯文本模型装上眼睛、耳朵和嘴。** 看番、看屏幕、语音通话——它看得见、听得见、说得出。

Windows · DeepSeek Harness 插件 · MIT

> ⚠️ **这个包里没有任何 API key。** 装完要自己填：视觉（必须）、语音（可选）、听觉（可选）。

一套六个包，装一个全有：

| 包 | 端口 | 干什么 |
|---|---|---|
| `dsh-watch-eyes` | 37711 | 抓屏 + 视觉理解 + 窗口枚举 |
| `dsh-watch-ears` | 37712 | 录音 / 转写 / 采样推注 |
| `dsh-watch-mouth` | 37716 | TTS 合成与播放 |
| `dsh-watch-browser` | 37713 | CDP 驱动真实 Edge/Chromium |
| `dsh-watch-hands` | 37717 | 按控件名操作任何 Windows 程序 |
| `dsh-watch-panel` | — | DSH 界面里的控制台 |

**为什么是六个包而不是一个**：任何一个 daemon 挂了，另外五个照样跑。
合成一个的话，一次崩溃就是整套失明。

> 让 agent 帮你装？把 [AGENT-INSTALL.md](./AGENT-INSTALL.md) 丢给它，那边写了前置要求、怎么问你要 key、怎么自检。

## 安装

```powershell
# 从 npm 装：一条命令搞定六个
dsh plugin --profile desktop add dsh-watch-stack

# 或者分开装，只要某几样
dsh plugin --profile desktop add dsh-watch-eyes dsh-watch-mouth
```

本地 tgz / 源码目录**不要装 meta 包**（它的依赖是 `workspace:*`，只在发布时
会被改写成版本号）。本地就把六个包一个个装：细节见
[AGENT-INSTALL.md](./AGENT-INSTALL.md)。

装完重启 DSH。控制台按钮在对话栏右上角。

## 需要自己准备的东西

**这个包里没有任何 API key** —— 作者的 key 不会被打包，也没有默认值。
三个能力各有各的 key，都填在你自己机器的 `~/.dsh-watch-*/config.json`：

| 能力 | 必须吗 | 要什么 |
|---|---|---|
| 视觉 | **是**（否则看不见） | 智谱 BigModel key |
| 语音 | 否 | 默认 Edge 免费音色；想换就自备 OpenAI 兼容服务 |
| 听觉 | 否 | 云端要 key；或者自装本地 whisper（免费） |

**没填也能跑，只是对应的能力不可用。**

### 视觉（必须，否则眼睛是瞎的）

智谱 BigModel 的 key，用 `glm-4.6v` 读画面：

```powershell
eyes config set provider.apiKey <key>
```

也可以走环境变量：`ZHIPU_API_KEY`（或 `GLM_API_KEY` / `DSH_VISION_API_KEY`），
首次启动会自动写进配置。

> 没有 key 的表现是 `/status` 里 `probe.status: 401`，日志写"令牌已过期"。
> 这不是网络问题。

### 语音合成（要它开口就得有）

按顺序试：MiniMax → OpenAI 兼容 → Azure → Edge（免费兜底）。
Edge 那条不需要 key，但音色是微软的那几个。

```powershell
mouth config set tts.minimax.apiKey <key>
mouth config set tts.minimax.groupId <id>
# 或
mouth config set tts.openai.apiKey <key>
```

环境变量：`MINIMAX_API_KEY` / `MINIMAX_GROUP_ID` / `SILICONFLOW_API_KEY` / `AZURE_SPEECH_KEY`。

### 听觉（可选）

默认走云端转写（智谱）。**不填 key 就只有本地 whisper 这一条路**，
而本地 whisper 要自己装：

```powershell
pip install faster-whisper
```

然后把模型目录和 python 指过去：

```powershell
ears config set asr.backend local
ears config set asr.local.python C:\Python312\python.exe
```

```powershell
$env:DSH_WHISPER_MODELS = 'C:\Users\me\models\hub'
```

模型要的是 `models--mobiuslabsgmbh--faster-whisper-large-v3-turbo`，
显存约 1.5G。显卡不够就切云端：`curl "http://127.0.0.1:37712/asr/backend?set=cloud-sf"`。

## 配置在哪

`~/.dsh-watch-eyes/`、`~/.dsh-watch-ears/`、`~/.dsh-watch-mouth/`、
`~/.dsh-watch-browser/`、`~/.dsh-watch-hands/`。

每个目录里 `config.json` 是设置，`daemon.log` 是日志（超过 2MB 自动轮转一次），
`data/` 是截图、录音、帧这些跑出来的东西——想清理直接删，它自己会重建。

数据目录想搬走的话，设环境变量就行：
`DSH_EYES_DATA` / `DSH_EARS_DATA` / `DSH_MOUTH_DATA` / `DSH_BROWSER_DATA` / `DSH_HANDS_DATA`。

## 脸（可选，不在 npm 里）

37714 那个形象窗口（Live2D + 表情 + 气泡）是个 Electron 应用，383MB，
所以**不塞进 npm 包**。没有它整套照样能用，只是没有画面上的角色，
声音改由嘴直接出。

## 技能

搭配 `watch-together` 技能用（从 SkillHub 装）。
技能里写着怎么起分身、怎么挂推注器、怎么收工；插件只负责感官。

## 平台

Windows。整套重度依赖 PowerShell、NAudio、UI Automation、WASAPI 回环，
没有做跨平台——硬要上 Linux 等于重写耳朵和手。

## 已知问题

1. **字幕依赖隔离 Chrome（9222）**，关了就读不到字幕；画面还能看。
2. **推注器是宿主级的**，靠 id 区分多实例；换一次 id 才干净。
3. **通话模式必须 `micOnly:true`**，不然每句话都要等一次 OCR。
4. **分身一次只说一句**，连着说话会排队。
5. **别用任务管理器强杀 DSH**，会把 Chromium 的 `Network/Cookies` 写坏。

## License

MIT。
