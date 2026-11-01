# dsh-watch-hands

给 DSH 装上一双手：**像人一样操作整台 Windows**，不只浏览器。

```
37717  手    UI Automation + 真实鼠标键盘 + 读窗口文字
```

## 为什么不是坐标点击

坐标点击在三种情况下必错：窗口挪了、DPI 变了、面板滚了。人不是这么找按钮的
——人找到写着「保存」的那个按钮。所以这只手默认走 **UI Automation 的无障碍树**：
它知道界面上有哪些控件、叫什么名字、在哪、能不能点。这也正是屏幕阅读器走的那棵树。

```
  动作                     走什么
  apps / windows            EnumWindows（Win32，毫秒级）
  find / read / click       UI Automation，缓存枚举
  type / key                SendInput（unicode 直输，中文不过输入法）
  run                       ShellExecute（等于在资源管理器里双击）
```

## 路由

```
GET /health                   worker 状态 / 动作计数 / 最近错误
GET /apps                     屏幕上开着的窗口
GET /windows?hint=            按进程或标题过滤
GET /displays                 显示器与虚拟桌面边界（坐标换算用）
GET /focus?hint=|hwnd=        提到前台
GET /window?op=&rect=&hint=   minimise / maximise / restore / close / move
GET /find?hint=&name=&limit=  列控件（name 是过滤词）
GET /read?hint=&max=          读窗口文字（文档正文 / 可见标签）
GET /menu?hint=               菜单栏
GET /click?hint=&name=        按名字点（真点击）
GET /clickat?x=&y=            按坐标点（逃生口）
GET /type?text=&hint=         打字
GET /key?combo=ctrl+s&hint=   组合键
GET /run?target=              启动程序
GET /history                  最近做过什么
```

## CLI

```powershell
npx hands apps --text
npx hands find --hint 计算器 --text
npx hands read 计算器 --text
npx hands click 等于 --hint 计算器
npx hands type "中文也行" --hint 记事本
npx hands key "ctrl+s" --hint 记事本
npx hands run notepad
```

## 实测（都在这台机器上跑过）

```
列窗口            72-208ms（11 个窗口）
列控件            408-645ms（100 个控件）
读窗口文字        378ms（含中文会话列表）
按名字点击        invoke 模式，7 + 3 = 10
键盘输入          计算器 0 -> 56
组合运算          123 × 7 = 861（键盘 + 鼠标混合）
```

## 踩过的坑（都会静默失败）

1. **INPUT 结构必须是联合体。** 鼠标和键盘两半写成两个并列字段，x64 下就从 40 字节
   变成 56 字节，`SendInput` 返回 0，**每次按键都无声消失**，而调用本身还"成功"。
   症状：`typed: 48` 但记事本一个字没变。worker 启动时会播报 `SIZES|input=40` 自证。

2. **PowerShell 5.1 按 GBK 读无 BOM 的脚本。** 这个 worker 里**一个中文都不能有**，
   否则整个脚本语法错误。角色词表改由 daemon 在启动时用 base64 JSON 下发（`ROLES|`）。

3. **stdin 也按 ANSI 读。** 中文目标名必须 base64 进管道，否则匹配到的是乱码。

4. **`AutomationElement.RootElement.FindAll` 遇到 UWP 窗口会卡 30 秒以上。**
   列窗口改用 `EnumWindows`（Win32），只对选中的那个窗口做 UIA。

5. **闲枚举属性是跨进程 COM 调用。** 一个控件要读 5 个属性就是 5 次往返。
   用 `CacheRequest` 一次拿全，是"列控件 400ms"和"超时"的区别。

6. **`CacheRequest.Activate()` 返回的才是可 Dispose 的对象**，`CacheRequest` 本身没有 `Dispose`。

7. **`SetForegroundWindow` 会被拒。** 后台进程抢焦点时 Windows 不点头。
   修法：`AllowSetForegroundWindow` + 清 `SPI_SETFOREGROUNDLOCKTIMEOUT` + `AttachThreadInput`。

8. **比较 `IntPtr` 不能用 `-eq`。** PowerShell 按引用比较，成功了也返回 false，
   会把诊断带到错误方向。转成 Int64 再比。

9. **副屏窗口的焦点要单独处理。** 实测 x<0 的窗口即使用上面全部手段也可能被拒，
   输出里会直接说明「挪到主屏」而不是含糊的 `focused: false`。

10. **`cmd /c start "" "notepad"` 的引号会让 `start` 把目标当窗口标题**，
    结果是打开一个空控制台并报成功。改用 `ProcessStartInfo` + `UseShellExecute`。

## 安全边界

- 只绑 loopback。
- 每个动作都记进 `history`（时间、动作、窗口），事后可审计"它到底动过什么"。
- `config.allow.destructiveKeys` / `allow.run` 可以关掉危险动作。
- **不碰自己的窗口**：这条还没做，见下面"已知不足"。

## 已知不足

- **没有按应用授权**：现在任何窗口都能操作。参考实现
  `dsh-computer-use` 用 `request_access` + 原生审批，那是更好的默认。
- **没有"不操作自己"的闸门**：DSH 自己的窗口也能被点。
- **没有暂停键**：人按 Esc 应该能让手停下来。
- 没有截图动作——截图归眼（37711），手只管输入，两个东西不该互相复制。
## 速度：慢在哪，怎么快起来

实测（同一台机器，同一时刻）：

```
hands /shot（本地截图）      171-183ms
eyes  /look（视觉模型）      3195-5902ms
hands /batch 单步           249-403ms
hands /apps                 46-72ms
hands /find 120 个控件      102ms
hands /read 1000 字         111ms
```

**结论：慢的不是动作，是往返。** 手本身一次几十到几百毫秒，可以忽略。
真正的成本是「每一步都要一次模型回合」——截图、看图、决定、再截图。
旧的三步流程实测 **~12 秒**，同样的事走 batch+本地截图是 **~0.6 秒**。

三个提效手段（都学自 `copylee711/dsh-computer-use`）：

### 1. `/batch` —— 多步一次调用

```powershell
# 旧：三步 = 三个回合 = 三次截图 + 三次看图
# 新：一次
node hands.mjs ... # 见 hands_batch 工具
```

```json
[{"action":"focus","hint":"记事本"},
 {"action":"type","text":"hello"},
 {"action":"key","combo":"ctrl+s"},
 {"action":"wait","name":"保存","timeout":3000}]
```

遇到第一个失败就停：失败后继续执行是不可接受的行为。

### 2. `wait` —— 等条件，不等时间

`/wait?name=保存&timeout=3000`：控件一出现就继续，超时才报错。
固定的 `sleep 2` 要么太短（漏），要么太长（每一步都慢一点，累积成"整个操作很慢"）。

### 3. `/shot` —— 本地截图 + 坐标映射

**视觉模型一次 3-6 秒，本地截图 170ms。** 需要"看一眼现在什么样"时，
不要调 `screen_look`，调 `/shot`：

```
screenshot 900x253 -> data/hands/shot-xxxx.jpg
physical 2500x1250 at 0,0  (scale 0.36)
read a pixel off the image, then: screenX = physical.x + round(imageX * physical.w / width)
```

**映射必须一起给。** 截图是物理矩形的缩放副本，图上的像素不是屏幕坐标；
让调用方自己算缩放，就会在 150% 缩放或副屏上算错。
## 与"一起看番"共存

手和看番是两套东西，但会互相踩。实测过的三个冲突点，现在都有防护：

### 1. 点击被置顶窗口吃掉（已修）

脸窗口是 `alwaysOnTop`。手按坐标点的时候，如果脸刚好浮在那儿，**点击是点在脸上的**，
目标应用什么都没收到——而调用方只会看到"没反应"。

现在 `clickAt` 在**点之前**先问 `WindowFromPoint`：实际会收到点击的是哪个窗口。
不是调用方指定的那个就**拒点**（409），并说明挡住了什么：

```json
{"blocked":{"wanted":"Safari","actually":"大肥鱼","hint":"something is covering that point..."}}
```

### 2. 画面变化不等于剧情变化（已确认不冲突）

推注器取的是 `<video>` 元素的像素，不是整个桌面。手去操作别的窗口，
视频画面本身没动，不会误判成剧情推进。

但**看屏幕模式（screen）会**：它抓的是前台窗口。用手切窗口时，
那一帧的变化会被当成"画面变了"。这是看屏幕模式本身的特性，不是手的 bug——
真要在看屏幕模式下用手，先 `watch_push action=stop`。

### 3. 焦点被抢（已确认不打断）

手的 focus/type 会短暂抢前台，实测耳朵的监听循环不受影响（errors 不增加）。
但如果手在别的窗口打字时你正好在跟它说话，麦克风收到的是你，不是它——
这条没问题。

---

**一句话**：看番时别用手去动前台窗口；需要动，就先停看屏幕模式的推注器。
看番模式（video）不受影响，视频取的是元素像素，不是桌面。
## 给别的程序用

这只手是独立插件，别的程序可以直接调：

```
内部路由   /apps /click /type ...   本机插件，无仪式
对外接口   /api/v1/*                别的程序，有版本、有 token、自描述
```

```js
import { Hands, imageToScreen } from 'dsh-watch-hands/lib/sdk.mjs'
const hands = new Hands()
await hands.ready()
await hands.focus({ hint: '记事本' })
await hands.type({ text: '你好', hint: '记事本' })
```

- `GET /api/v1` 自描述，客户端不用读源码。
- 非 loopback 必须带 `X-DSH-Hands-Token`（首次启动生成，存在 config）。
- 403/409 是策略决定（拒绝 / 被遮挡），SDK 抛 `refused`，不是故障。

完整契约见 [docs/API.md](docs/API.md)，或 `node bin/hands.mjs api --text`。

**为什么不让每个程序自己驱动**：那就每个程序都要自己处理 DPI 缩放、副屏原点、
焦点被拒、置顶窗口吃点击、INPUT 结构布局、中文输入、UIA 缓存。
让一个进程负责，别人的程序都当客户端，这些坑只踩一次。
