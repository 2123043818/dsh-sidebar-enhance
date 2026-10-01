# act「卡住不返回」诊断与修复（v8）

> 现场：`browser_act` 点一下链接后长时间没有回执，用户只能手动中断；另一次同样的动作回的是
> `浏览器操作失败: null`。**同一个动作、同一份代码，两次表现不同** —— 这是时序相关的信号，
> 不是随机故障。

---

## 1. 现象

| 次 | 动作 | 结果 |
|---|---|---|
| A | `browser_act` 点 Bing 结果里的 `target="_blank"` 链接 | 长时间无回执 → 用户中断 |
| B | 同上（隔了一会儿） | `浏览器操作失败: null` |
| C | 同上（再隔一会儿） | `navigated:true` +「页面正在跳转，不要重复点击」 |

三次是同一个动作。B 和 C 的差别只可能来自**时序**。

---

## 2. 根因

### R1（主因）页内等导航 = 自毁

改动前的 click 分支（`lib/client.js`，`buildBrowserSource` 内）：

```js
el.click();var w=0;while(location.href===u0&&w<1200){await delay(100);w+=100}
```

`location.href` 一旦变化，导航就已经发生，**页面的 JS 上下文被销毁**：

- 后面的 `return __wb_out(...)` 永远执行不到；
- `executeJavaScript` 返回的 promise **既不 resolve 也不 reject，永远挂起**
  （这正是代码里 v7 注释记录过的现象）。

于是整条命令链只能靠 `PAGE_SCRIPT_TIMEOUT_MS = 30000` 兜底 ——
**从用户视角就是「点一下卡住」**，而这一次点击其实早就成功了。

> 加这个等待的初衷是对的（防止模型等不到页面变化而重复点击，多点一次就多一个 tab），
> 但**用页内等待去等"导航"这件事，恰好因为导航会杀死等待者**。
> 等待的对象和等待的方式互斥。

### R2 `null` 被一路字符串化，失败回执变成零线索

四步叠加，任何一环不修都会漏出 `浏览器操作失败: null`：

| # | 位置 | 行为 |
|---|---|---|
| 1 | `client.js` `describe()` | `describe(null)` 返回**字符串** `'null'` |
| 2 | `client.js` `payloadFor()` | 失败但没原因时发 `error: null`（JSON null） |
| 3 | `browser.js:263` `resultRoute` | `body.error === undefined ? null : String(body.error)` → `String(null)` = **字符串 `"null"`** |
| 4 | `browser.js:366` `receipt` | `String(result.error \|\| "未知错误")` 拿到真值字符串 `"null"` → 输出 `浏览器操作失败: null` |

第 4 步的 `|| "未知错误"` 本来是想兜底，**恰恰因为第 3 步把 null 变成了 truthy 的字符串而失效**。
最终模型看到的失败既没有步骤、也没有原因、也没有下一步动作。

---

## 3. 修复（5 处，已落地）

### 改动 1 —— 页内不再等导航（`client.js:1333-1336`）

```diff
-  // ★ 点击后等导航真正发生（最多 1200ms）再返回……
-  + 'el.click();var w=0;while(location.href===u0&&w<1200){await delay(100);w+=100}'
+  // ★ 点击后**不在页内等导航**：等待期间导航一旦发生，页面上下文连同返回值一起被销毁……
+  //   「到底跳没跳」交给宿主侧轮询 webview 的 getURL 判定（见 watchFrameNavigation）。
+  + 'el.click();await delay(100);'
```

保留一拍（100ms）让"不跳转的点击"仍能正常返回结果，等导航的职责整体搬走。

### 改动 2 —— 新增地址探测器（`client.js:1544-1585`）

```js
var ACT_NAV_WATCH_MS = 2500

function readFrameUrl(frame) { … }              // 拿不到就 null，不抛

function watchFrameNavigation(frame, before, capMs) {
  // 地址相对 before 一变就立刻 resolve；一直不变则**永不 resolve**，
  // 由竞速里的脚本本身或总超时负责收尾。
}
```

**关键点**：地址变化是在 **webview 层面**发生的，不受页面上下文销毁影响。
在页面里等会死，在外面等不会 —— 这是整个修复的核心。

### 改动 3 —— act 让「脚本返回」和「地址变化」赛跑（`client.js:1497-1520`）

```js
var beforeUrl = command.op === 'act' ? readFrameUrl(frame) : null
var raced = beforeUrl
  ? Promise.race([running, watchFrameNavigation(frame, beforeUrl, ACT_NAV_WATCH_MS).then(url => ({ __navigatedTo: url }))])
  : running
// 命中 __navigatedTo → 立刻回 ok:true + 新地址 +「不要重复点击」
```

「点一下跳走」现在约 200ms 就有明确回执，**不再干等 30s 超时**；而且回执里带上了跳转后的 URL。

### 改动 4 —— 客户端不再上报 `error: null`（`client.js:1635-1645`）

```js
error: (function () {
  if (result.error != null) return String(result.error)
  if (result.ok === false) return '操作失败但没有给出原因（客户端未上报 error）'
  return null
})(),
```

### 改动 5 —— 宿主不再把 `null` 字符串化（`browser.js:263`、`browser.js:366`）

```diff
- error: body.error === undefined ? null : String(body.error),
+ error: body.error === undefined || body.error === null ? null : String(body.error),

- return text("浏览器操作失败: " + String(result.error || "未知错误"));
+ return text("浏览器操作失败: " + String(result.error || "未知错误（客户端没有上报原因；看插件诊断日志里带 ⚠ 的那一行）"));
```

修好 3 之后，第 4 步的 `|| "未知错误"` 才能重新生效。

---

## 4. 测试

`tests/reveal.test.mjs`：

- **改写 1 条旧断言** —— `click 后等地址变化再返回` 断言的正是被删掉的页内等待，
  现改为两条：
  - `click 不在页内死等导航（页内等待会把返回值一起销毁）`
  - `click 仍让出一拍，给不跳转的点击留出返回机会`
- **新增 2 条** —— 用一个"地址在 60ms 后变化、脚本永挂"的假 frame 驱动新路径：
  - `地址一变就立刻回执「点击已跳转」，不等脚本超时`（断言 < 2000ms，且 `pageScriptTimeout` 故意留 30s）
  - `回执里带上跳转后的地址，并劝模型别重复点击`
- 新用例结束时**必须把假 frame 换回去**，否则永挂的 frame 会污染后面的用例
  （第一版就踩了这个坑，表现为测试进程挂在 `c2e`）。

三套件结果：

```
node tests/reveal.test.mjs   → REVEAL TEST OK
node tests/host.test.mjs     → HOST TEST OK
node tests/smoke.mjs         → SMOKE OK
```

> 注意测试文件名是 `tests/smoke.mjs`（不带 `.test`）。

---

## 5. 验证现状与遗留

### v8 已通过真机验证 ✅

桌面端**完全退出重启后**（刷新页面不够，README 第 63–72 行对同类问题的说法一致），
真机复测结果：

| 验证 | 结果 |
|---|---|
| 点 Bing 结果里的 `target="_blank"` 链接 | 回执**立刻**返回完整动作明细 `{type:"click", ok:true, navigated:false}`，不再卡住 |
| 页面最终位置 | `browser_read` 显示已原地跳到掘金文章页 —— 跳转确实发生了 |
| 新代码是否加载 | 用一条**只存在于新代码**的文案反向确认（见 §7），确认新 bundle 已生效 |
| `read` / `find` | 正常 |

**结论：v8 的「卡住」已解决。**

### 还没做的

1. `ACT_NAV_WATCH_MS = 2500` 是拍的常量，可按 op 分配预算（act 短、wait 长）。
2. 「已跳转」时若能在宿主侧再等 300–500ms 让新页面 `readyState` 到 `complete`，
   回执会更可靠 —— 但**必须做在宿主侧**，别搬回页内。
3. 这条改动只覆盖 navigate / act。`read` / `find` 若在跳转途中被调用，仍会走
   30s 超时；可考虑同样加地址竞速。
4. `describe()` 把 `null`、`undefined` 压成字符串这个行为本身没错，
   但**调用方不能把它的返回值当"有没有错误"的判据** —— 建议在 `describe` 注释里写明。
5. `browser_find` 回传的 `attrs.href` 是**解析后的属性值**（`el.href`），
   不是 DOM 属性原文。拿它拼 `a[href="..."]` 选择器**可能匹配不到**（SPA 常常写的是相对路径 `/`）。
   建议在 `read`/`find` 的说明里明确：**优先用返回的 `path`**，别拿 `href` 反查。见 §7。

---

## 7. v8.1：失败原因被整包丢掉（真机复测时暴露的第二个缺陷）

### 现象

v8 生效后，我用 `a[href="https://juejin.cn/"]` 点掘金的「首页」链接，回执是：

```
浏览器操作失败: 操作失败但没有给出原因（客户端未上报 error）
```

这句文案**本身就是 v8 的修复产物**（改动 4）——问题被如实报了出来，
但**真正的原因没有传出来**：既不知道是哪个动作失败，也不知道为什么。

### 根因：原因藏在 `results[i].error`，而宿主只看顶层 `ok`

页面脚本的执行结果长这样（动作级失败）：

```json
{
  "ok": false,
  "url": "https://juejin.cn/…",
  "results": [{ "type": "click", "selector": "a[href=\"https://juejin.cn/\"]",
                "ok": false, "error": "找不到元素: a[href=\"https://juejin.cn/\"]" }]
}
```

`runBrowserOp` → `parseOpResult` 把**整个对象原样返回**，`ok:false` 但顶层**没有 `error`**。
宿主 `receipt`（`browser.js:362`）看到 `!result.ok` 就 `return`，**`data` 连同里面的失败原因一起被丢掉**。

于是同一条链路上有两个"看不见"的坑，叠加成一个**零线索的失败**：

1. 客户端不把动作级的原因提到顶层；
2. 宿主失败时只输出 `error`，不输出 `data`。

**代价是真实的**：这一次我完全无法判断是"选择器写错了"还是"页面拒绝了点击"，
只能再花一个来回。而真相恰恰是选择器问题 ——
`__wb_desc` 回传的 `href` 是 `el.href`（解析后的绝对地址），
而 HTML 属性原文是相对路径 `/`，`a[href="https://juejin.cn/"]` 自然匹配不到（见 §5 遗留第 5 条）。

### 修复（v8.1，2 处）

**改动 6 —— 客户端把动作级失败提到顶层**（`lib/client.js`，新增 `hoistActionFailure`）：

```js
function hoistActionFailure(parsed) {
  if (!parsed || parsed.ok !== false || parsed.error) return parsed
  var list = parsed.results
  if (!Array.isArray(list)) return parsed
  for (var i = 0; i < list.length; i += 1) {
    var item = list[i]
    if (item && item.ok === false) {
      parsed.error = '动作 ' + describe(item.type)
        + (item.selector ? ' (' + item.selector + ')' : '')
        + ' 失败: ' + describe(item.error || '页面没有给出原因')
      parsed.failedIndex = i
      break
    }
  }
  return parsed
}
```

在 `parseOpResult` 里改为 `return hoistActionFailure(parsed)`。

**改动 7 —— 宿主失败回执带上明细**（`lib/browser.js` `receipt`）：

```js
if (!result.ok) {
  const reason = String(result.error || "未知错误（…）");
  const detail = result.data === null || result.data === undefined
    ? ""
    : "\n明细: " + stringify(result.data, 1500);
  return text("浏览器操作失败: " + reason + detail);
}
```

两道防线各自独立：即便哪天客户端又不提原因，宿主也不会把 `data` 丢掉。

### 测试（新增 2 条断言）

- `动作失败的原因被提到顶层 error（不再只说「失败了但没有原因」）`
- `失败明细仍随 data 一起回传，没有整包丢掉`

结果：

```
node tests/reveal.test.mjs   → REVEAL TEST OK
node tests/host.test.mjs     → HOST TEST OK
```

### v8.1 的真机验证步骤（需要**再重启一次**桌面端）

1. 随便打开一个页面，用 `browser_act` 点一个**不存在的选择器**（例如 `#no-such-element`）；
2. 期望回执是 **`浏览器操作失败: 动作 click (#no-such-element) 失败: 找不到元素: #no-such-element`**
   ——而不是「失败但没有给出原因」；
3. 再点一次正常链接，确认没有回归。

---

## 6. 回滚

改动前的原文件已备份在工作区根目录（仓库的 `_backup` 目录当前不可写）：

```
<本地插件根目录>\client.js.bak-20261001-154801
<本地插件根目录>\browser.js.bak-20261001-154801
```

覆盖回 `dsh-sidebar-enhance/lib/` 下同名文件即可。
