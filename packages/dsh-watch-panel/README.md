# dsh-watch-panel

一起看番的控制台，挂在 DSH 界面的 `shell.overlay` 插槽里。

## 样子

右上角（可换四角）一个「看番」药丸，五个小圆点是五个服务的健康状态。
点开就是完整控制台：

- **服务**：眼 / 脑 / 手 / 脸 / Chrome，各自启停，或一键全启全停
- **看番**：挂起待机 · 播放 · 暂停 · 体检 · 收工
- **让她说话**：输入一句，走脸说出（带气泡和表情）

面板里有四个小字切换位置：右下 / 左下 / 右上 / 左上，选中后记在
localStorage 里，下次打开还在原处。

## 为什么是 overlay 而不是塞进聊天栏

看番时用户在看视频，聊天栏在旁边。控制台要是占掉聊天宽度，等于把对话挤没了。
`shell.overlay` 是根作用域的附加层，欢迎页上也在，且不挤占任何布局。

## 它只是壳

每个按钮都 shell out 到现有 CLI（`eyes.mjs` / `ears.mjs` / `companion.mjs` /
`face.mjs` / `browser.mjs`），所以面板和命令行永远一致。

## 客户端必须是 module loader 形式

DSH 的客户端半身不是普通 script，而是：

    window.__ModuleLoader__.load({
      id: '<plugin-name>',
      factory: (require) => { ... exports.apply / exports.inject ... },
    })

由 `package.json` 的 `dsh.client` 声明才会被加载：

    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
    }

**自己往 DOM 里塞 <script> 是没用的** —— 早先那版的教训。

## 路由前缀为什么不是 /api

`/api` 被 `@deepseek-ai/dsh-client-connection` 独占：它先跑 `connection.admit()`，
没有会话 cookie 的请求一律 401，而且匹配优先最长前缀，挂在 `/api/<名字>` 下的
插件永远轮不到。独立前缀 `/dsh-watch` 绕开那层握手。

## 安装

    dsh plugin --profile desktop add dsh-watch-panel

装完重启 DSH。
