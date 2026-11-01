# dsh-watch-hands 对外接口

给**别的程序**用的接口。不是给我们自己的插件用的——那个走内部路由，没有仪式。

```
版本      1
基址      http://127.0.0.1:37717/api/v1
发现      GET /api/v1          （返回这个文件的内容，不用读源码）
端到端    同机不需要 token；跨机必须带 X-DSH-Hands-Token
```

## 为什么要分两套

| | 内部路由 | /api/v1 |
|---|---|---|
| 调用方 | 本机插件 | 别的程序 |
| 稳定性 | 可以随手重构 | 改就是破坏契约 |
| 鉴权 | 无（loopback） | 非 loopback 必须带 token |
| 描述 | 源码 | `GET /api/v1` 自描述 |

变了版本号别人能拒绝；没有版本号只会静默坏掉。

## 鉴权

```
loopback（127.0.0.1 / ::1）    默认免 token
非 loopback                     必须 X-DSH-Hands-Token
config.api.requireTokenForLoopback=true 时本机也要
```

token 在第一次启动时生成，存在 `~/.dsh-watch-hands/config.json` 的 `api.token`。
**所有拒绝都回同一句话**，不说"token 错"还是"没带"——说了就等于承认 token 存在，足够让人接着试。

## 坐标系（唯一容易错的地方）

**所有进出的坐标都是物理屏幕像素**，包含虚拟桌面原点（副屏可能是负数）。

`/shot` 会**同时**返回图和映射：

```json
{
  "path": "...jpg",
  "width": 900, "height": 253,
  "physical": { "x": 0, "y": 0, "w": 5120, "h": 1440 },
  "toScreen": "screenX = physical.x + round(imageX * physical.w / width)"
}
```

截图是物理矩形的**缩放副本**，图上的像素不是屏幕坐标。
让调用方自己算，就一定会在 150% 缩放或副屏上算错。

SDK 里的 `imageToScreen(shot, x, y)` 就是干这个的。

## 端点

```
GET /api/v1                 自描述（版本、端点、错误形状）
GET /api/v1/health          daemon + worker 状态、动作数、最近错误
GET /api/v1/displays        显示器与虚拟桌面边界
GET /api/v1/apps            顶层窗口
GET /api/v1/find            hint, name, limit — 按无障碍名字找控件
GET /api/v1/read            hint, max — 读窗口正在显示的字
GET /api/v1/shot            hint, width — 截图 + 坐标映射
GET /api/v1/focus           hint, hwnd — 提到前台
GET /api/v1/window          op, hint, hwnd, rect — minimise/maximise/restore/close/move
GET /api/v1/click           name, hint — 按名字点
GET /api/v1/clickat         x, y, hint — 按坐标点（被遮住会拒）
GET /api/v1/type            text, hint — 打字（中文直输，不过输入法）
GET /api/v1/key             combo, hint — 组合键
GET /api/v1/wait            name, hint, timeout, gone — 等控件出现/消失
GET /api/v1/batch           actions, finish — 多步一次调用
GET /api/v1/run             target — 启动程序
GET /api/v1/history         最近做过什么
```

## 状态码

```
200  成功
403  策略拒绝（不许操作这个窗口 / token 不对）
409  被遮挡（那个坐标上实际是别的窗口，点了会点错）
500  动作失败
```

**403 和 409 是决定，不是故障。** 调用方应该显示给用户，不该重试。

## 两种用法

### 导入 SDK（同机，Node 18+）

```js
import { Hands, imageToScreen } from 'dsh-watch-hands/lib/sdk.mjs'
const hands = new Hands()
await hands.ready()

await hands.focus({ hint: '记事本' })
await hands.type({ text: '你好', hint: '记事本' })
console.log((await hands.read({ hint: '记事本' })).text)

// 多步一次走完（这是省时间的关键：一步一个回合太贵）
await hands.batch([
  { action: 'focus', hint: '记事本' },
  { action: 'type', text: 'hello' },
  { action: 'key', combo: 'ctrl+s' },
  { action: 'wait', name: '保存', timeout: 3000 },
])

// 看一眼屏幕（170ms，比问视觉模型 3-6s 便宜得多）
const shot = await hands.shot({ hint: '记事本', width: 900 })
const p = imageToScreen(shot, 120, 40)
```

### 直接 HTTP（任何语言）

```bash
curl "http://127.0.0.1:37717/api/v1/apps"
curl -X GET "http://127.0.0.1:37717/api/v1/click?name=%E4%BF%9D%E5%AD%98&hint=%E8%AE%B0%E4%BA%8B%E6%9C%AC"
# 跨机
curl -H "X-DSH-Hands-Token: $TOKEN" "http://192.168.1.9:37717/api/v1/apps"
```

## 别的程序能依赖什么、不能依赖什么

**能依赖**
- `/api/v1` 下端点的名字、参数、状态码。改了就是版本 2，旧的继续能跑。
- 坐标永远是物理屏幕像素。
- 403/409 一定是策略决定，不是故障。

**不能依赖**
- 内部路由（`/apps` `/click` ...）——那是给我们自己的，随时会变。
- `history` 的内容格式：给人看的，不是给程序解析的。
- 动作的耗时。

## 为什么不让别的程序自己驱动

程序可以自己调 SendInput。那它就要自己处理：DPI 缩放、副屏原点、焦点被拒、
置顶窗口吃点击、INPUT 结构布局、中文输入、UIA 缓存……这里每一条都是踩过的坑。
**让一个进程负责，别人的程序都当客户端**，这些坑只踩一次。
