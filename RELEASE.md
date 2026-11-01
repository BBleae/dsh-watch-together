# 发布清单

这个目录是**可发布的副本**。正在用的插件在 `D:\Yachiyo\plugins\`，
**从来没被动过**，也不该被这份覆盖。

两份备份，用途不同：

| 位置 | 是什么 |
|---|---|
| `backup\watch-together-release-20261031\` | 改造**之前**的原始插件 |
| `backup\release-snapshots\watch-together-20261101-1715-final\` | 改造**之后**的可发布副本 + 七个 tgz |

改坏了从后面那份恢复，别从 live 恢复。

## 给别人装的时候，降档空间在哪

| 能力 | 有 key / 有显卡 | 没有的时候 | 怎么切 |
|---|---|---|---|
| 视觉（**必须**） | 智谱 key，1-5s 一帧 | **没有就没有眼睛**，doctor 会明说 | 只能填 key |
| 听觉 | 本地 whisper（免费，约 1.5G 显存）/ 云端 API（按量） | `auto` 自动判，`localWhy` 写清缺什么 | `ears config set asr.backend auto\|local\|cloud` |
| 语音 | 自备 OpenAI 兼容服务 / MiniMax / Azure | Edge 免费音色（微软端点可能拒握手） | `mouth config set tts.provider ...` |

**三种 ASR 模式**，跑 `ears asr` 一眼看清这台机器能走哪条：

    auto   能本地就本地，否则云端（默认）
    local  只用本地；跑不了就明确报错，不偷偷降级
    cloud  只用 API；没 key 时状态里直接说 "asr.apiKey is EMPTY"

**音色不预设**：`tts.provider = auto` 按成本顺序试；用户可以用任意说
`/v1/audio/speech` 的服务，baseUrl / key / model / voice 四项全开放。
`mouth voice` 打印当前会用哪个、哪个 key 有。

**包里零 key**：所有 `apiKey` 默认是空字符串，作者的凭据不会被打包。
用户第一次跑 `ears asr` / `mouth voice` 就能看到"哪个 key 是空的"。

## 改了什么（相对原始）

| 项 | 原来 | 现在 |
|---|---|---|
| 包名 | dsh-ears / dsh-screen-eyes / dsh-mouth / dsh-browser / dsh-hands | dsh-watch-ears / dsh-watch-eyes / dsh-watch-mouth / dsh-watch-browser / dsh-watch-hands |
| 数据目录 | 硬编码 `<插件根>/../workspace/dsh-see-screen/data` | `~/.dsh-watch-*/data`，可用 `DSH_*_DATA` 覆盖 |
| 状态目录 | `~/.dsh-ears` 等 | `~/.dsh-watch-ears` 等（和旧版并存不冲突） |
| whisper python | 写死 FineSub 的 D:/E: 路径 | `DSH_WHISPER_PYTHON` → PATH 上的 python |
| whisper 模型 | 写死 FineSub hub | 只用 `DSH_WHISPER_MODELS` |
| NAudio | 嘴去借耳朵的 DLL | 嘴自带一份 `lib/net/` |
| panel CLI 路径 | 写死 `D:\Yachiyo\plugins` | 从包自身位置 + `createRequire` 解析兄弟包 |
| face | 绑在 workspace 里，383MB | 不发布；`DSH_FACE_CLI` 指向才启用 |
| key | 只从 modlens 一次性 seed | 环境变量优先（ZHIPU/GLM/DSH_VISION、MINIMAX、SILICONFLOW、AZURE） |
| 人格 | 技能里写死雅秋 + 川谷 | 抽成通用结构模板 |
| 技能路径 | 一堆 D:\Yachiyo 绝对路径 | `npx eyes / ears / ears-companion / ears-live ...` |
| ASR 默认 | 永远 local（没装就每句白 spawn 一次） | 探测到有 whisper 才 local，否则 cloud |

## 目录结构

    dsh-watch-stack/          ← meta 包根（也发布）
      package.json               依赖六个包，写的是 workspace:*
      lib/index.js               空的：六个兄弟各自挂载自己
      cordis.patch.yml           空的：理由同上
      AGENT-INSTALL.md           ★ 给 agent 看的安装/配置/自检指南
      skills/watch-together/     ★ 通用版技能（已去人格）
      install.ps1 / install.sh   link 或 npm 两种装法
      pnpm-workspace.yaml        packages/*，让 checkout 里能一把 install
      packages/                  六个服务包

## 包名和命令名

    dsh-watch-eyes        eyes
    dsh-watch-ears        ears / ears-companion / ears-live / ears-digest
    dsh-watch-mouth       mouth
    dsh-watch-browser     browser
    dsh-watch-hands       hands
    dsh-watch-panel       （无 CLI，只有 UI）

多命令的包不能用 `npx <包名>`，要 `npx -y -p <包名> <命令>`。

## 发之前还要做的三件事

1. **拿 npm token**。`.npmrc` 现在只有镜像源，没有认证。
   `npm login` 或往 repo secrets 里塞 `NPM_TOKEN`。
2. **建 GitHub 仓库** `Eli-Mao/dsh-watch-stack`，
   把 worktree 里的 `packages/` 和根目录 push 上去（`package.json` 里已经写好这个 URL）。
3. **打 tag 触发发布**：`.github/workflows/publish.yml` 监听 `v*`。
   `git tag v0.1.0 && git push --tags` → 六个包 + meta 包按顺序发。

## 发布顺序（重要）

    dsh-watch-eyes    无依赖
    dsh-watch-ears    无依赖
    dsh-watch-mouth   msedge-tts
    dsh-watch-browser playwright-core
    dsh-watch-hands   无依赖
    dsh-watch-panel   无依赖
    dsh-watch-stack 依赖上面六个 ← 必须最后

## 发完怎么验

    npx -y dsh-watch-eyes doctor
    npx -y dsh-watch-mouth status
    npx -y dsh-watch-ears status

三个都能过就是装成功了。

## 一个必须提前说的坑

**新旧不能同时装**：端口（37711/37712/37713/37716/37717）和工具名
（screen_look / screen_say / hear_now / mouth_say / hands_act）都会撞。
要试新版就先卸旧的，或者把旧的 profile 停掉。
状态目录是分开的（`~/.dsh-ears` vs `~/.dsh-watch-ears`），配置不会互相覆盖，
但**同一分钟起两个 daemon 会抢端口**。

## 打包产物（release/dist/）

    dsh-watch-eyes-0.1.0.tgz        25 KB
    dsh-watch-ears-0.1.0.tgz       253 KB
    dsh-watch-mouth-0.1.0.tgz      135 KB
    dsh-watch-browser-0.1.0.tgz     20 KB
    dsh-watch-hands-0.1.0.tgz       44 KB
    dsh-watch-panel-0.1.0.tgz       16 KB
    dsh-watch-stack-0.1.0.tgz    21 KB   ← workspace:* 已经换成 0.1.0

打包命令是 pnpm（不是 npm）：`pnpm pack` 会把 workspace 协议改写成版本号，
`npm pack` 不会，meta 包会带一个装卸不上的 `workspace:*` 出去。

## 本机验证记录（2026-10-31）

隔离端口 + 隔离 HOME 跑过：

    37811 eyes      look 成功，GLM 返回一句话，1.8-2.2s
    37812 ears      status OK，无 whisper 时自动判 cloud
    37813 browser   status OK
    37816 mouth     say 成功，edge 兜底出声 1.9s
    37817 hands     status OK

另外做了三组安装验证：

    tarball 装六个           pnpm add 成功，六个 bin 都出现在 .bin
    无关目录 import panel     name/inject 正常，兄弟包全部解析到
    monorepo pnpm install    workspace 协议生效，六个包硬链接进同一棵树

**没验证的**：真挂进 DSH profile 后工具是否注册（那要重启宿主，
会打断当前会话，留给用户在真机上做）。
