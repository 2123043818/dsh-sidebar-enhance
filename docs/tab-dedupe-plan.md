# dsh-sidebar-enhance：侧栏浏览器"一次点击冒出多个 tab"修复方案

> 目标读者：负责 dsh-sidebar-enhance 插件的 AI / 工程师。
> 本文只描述改法与验收标准，**不包含已改好的代码**；改动方在 `dsh-sidebar-enhance/lib/client.js` 内完成。
> 行号基于提交 `lib/client.js` 共 2529 行的那一版，改动前请先按函数名定位。

---

## 1. 问题现象（真实复现，非推测）

用户截图显示侧栏浏览器分栏里同时存在 **4 个 tab**：

```
[Cordis 插件框架 - 搜…] [介绍 | Co ×] | [介绍 | Cordi] | [介绍 | Cordi]
```

其中 **3 个是同一次会话中反复出现的同一个 Cordis 文档页**。

复现路径（Agent 视角）：

| 轮次 | 调用序列 | navigate 回执 |
|---|---|---|
| 第 2 轮 | `browser_navigate`(Bing) → `find` → **1 次 act click** → `read` → `reveal(browser, url=落地页)` | 已在现有 tab 原地跳转 |
| 第 3 轮 | `browser_navigate`(Bing) → `find`×2 → **1 次 act click** → `read` | ⚠️ 已**新开**浏览器 tab |

关键事实：**第 2 轮只点了一次，却出现了 3 个同页 tab**。所以 tab 增殖不来自"点多下"，而来自下面若干条路径的叠加。

---

## 2. 根因分析（按代码可证程度排序）

### S1 事实：navigate 的兜底分支会开新 tab，且它被触发得很随意

`opNavigate`（`lib/client.js:1299`）逻辑是"优先原地跳转"：

- `lib/client.js:1305-1334`：`pickBrowserFrame()` 拿到 webview 且 `typeof frame.loadURL === 'function'` → `loadURL()`，**不开新 tab**；
- `lib/client.js:1337-1359`：否则回落 `sidebar.openTab(BROWSER_KIND, { params: { url: url } })` → **开新 tab**。

问题在于回落条件太容易命中：只要 `findBrowserFrames()`（`:856`）那套 **递归 shadow-root 遍历**在一次调用里没查到 `[data-sidebar-browser-frame]`（tab 正在挂载、分栏折叠、webview 被卸载等瞬时状态），就整条走回落到 openTab。

实测第 3 轮 navigate 就命中了回落，回执文案正是 `:1357` 的 `'已新开浏览器 tab，接着用 browser_read 读内容'`。

**判定：确定的 tab 增殖源之一。**

### S2 事实：act 的 click 是 `el.click()`，会继承链接的 `target`，没人拦

`buildBrowserSource` 的 click 分支（`lib/client.js:1259`）：

```js
if(type==="click"){var el=__wb_find(sel);if(!el)throw new Error("找不到元素: "+sel);
  el.scrollIntoView({block:"center"});el.click();results.push({...})}
```

原生的 `HTMLElement.click()` 会完整走默认行为：如果 `<a target="_blank">`，或页面监听里 `window.open()`，**webview 就会开新 tab**。插件这一侧：

- 没有在点击前改 `target`；
- 没有拦 `window.open`；
- 回执里也不告诉调用方"这次点击开了新 tab"（`results` 只有 `{type, selector, ok}`）。

而且**连判断依据都拿不到**：`__wb_desc`（`lib/client.js:1220`）返回的 `attrs` 只有 `id/name/type/href/value/placeholder/aria`，**没有 `target`**。所以模型在 `browser_find` 之后完全无法知道自己要点的那条是不是新窗口链接——这不是模型的疏忽，是工具没给数据。

**判定：确定的 tab 增殖源之一；Bing 结果页正是杂牌链接密集处。**

### S3 高嫌疑：reveal 的 12 次重试循环，每次重试都会再调一次 openTab

`requestReveal`（`lib/client.js:660-713`）在 `applied === null` 时最多重试 **12 次**（`MAX_ATTEMPTS = 12`，间隔 `RETRY_MS = 150`）：

```js
// :691
applied = openPanel({ sessionId, turn, data, config, source })
...
// :700
if (applied !== null) { ...记住 sessionId:turn...; return }
attempts += 1
if (attempts < MAX_ATTEMPTS) { setTimeout(step, RETRY_MS); return }   // :708
```

而 `applyReveal` 的 browser 分支（`lib/client.js:631-644`）：

```js
var opened = false
try {
  if (target.params) sidebar.openTab(kind, { params: target.params })   // :633  ← 副作用在这里
  else sidebar.openTab(kind)
  opened = true
} catch (error) { dwbLog('openTab("' + kind + '") 失败：' + ...) }      // :636-640
if (!opened) return null                                                // :642
```

**只要宿主端 `openTab` 已经把 tab 建出来、却在它内部的后续步骤抛了异常**（store 更新、面板激活、layout 重排都算），插件就会把这次调用判成"没成功" → 返回 `null` → 重试 → **再建一个 tab**。3 次重试 = 3 个同页 tab，与截图完全吻合。

**重要限定**：`openTab` 的真实实现打包在桌面端 `app.asar` 里（`<dsh 安装目录>\resources\app.asar\dsh\` 当前不可读），所以"S3 是否就是那 3 个 tab 的成因"**必须由改动方在真实桌面端用日志证伪或证实**，见 §5 的判别实验。方案对 S3 的处理是"无论是不是它，都该堵上"。

### S4 事实：去重只到"轮次"，没到"URL"

`lib/client.js:702` 写的是 `remember(sessionId + ':' + turn)`，`remember`（`:1895`）也只是防同一轮重复展开。于是：

- **跨轮的同一目标地址 → 每次都 openTab 一次**；
- **同一轮里 Agent 先 click 跳到 X、再 `reveal(browser, X)`**（本次事故正是这个形状）→ 两次都开；

README `:22` / `:125` 宣称的"同分栏去重"只在**分栏（pane）粒度**成立，**分栏内部的浏览器 tab 不去重**。这条建议直接写进 README，避免后续再误判。

### S5 事实：navigate 的"原地"判定用的是 URL 字符串比较，慢网下会误报

`lib/client.js:1314-1332` 用 `frame.getURL() !== before` 判断导航是否发生（`NAVIGATE_WAIT_MS = 1400`，最多等 4 倍）。同 URL 的 reload、或 SPA 内 hash 变化不会被识别；超时后走 `:1327` 的"已发起导航"文案。这条不产生额外 tab，但它让"到底走没走原地分支"这件事在回执里难以分辨——**建议顺手把走了哪条分支明写进回执**（见改动 F）。

---

## 3. 修复方案

按**风险从低到高**排列。A/B 是纯客户端脚本层，最容易验；C/D 在 reveal 链路上，务必配单测。

### 改动 A（低风险）：把 `target` 暴露给调用方

`lib/client.js:1220` 的 `__wb_desc`，`attrs` 里补两个字段：

```js
attrs:{
  id:..., name:..., type:..., href:..., value:...,
  target: el.getAttribute("target")||"",
  rel:    el.getAttribute("rel")||"",
  ...
}
```

同时 `read` 分支（`lib/client.js:1233`）收集链接时也带上 `target`：

```js
links.push({text:at,href:a.href,target:a.getAttribute("target")||""})
```

**验收**：`browser_find` 在含 `target="_blank"` 的链接上返回 `attrs.target === "_blank"`。

### 改动 B（低风险，收益最大）：点击默认原地，只有显式要求才新开

改 `lib/client.js:1259` 的 click 分支，**默认把新窗口链接拉回当前 tab**：

```js
if(type==="click"){
  var el=__wb_find(sel); if(!el) throw new Error("找不到元素: "+sel);
  el.scrollIntoView({block:"center"});
  var beforeUrl = location.href;
  var keepNew = a.newTab === true;                   // 默认 false
  var oldTarget = null;
  if(!keepNew && el.tagName === "A" && el.getAttribute("target")){
    oldTarget = el.getAttribute("target");
    el.setAttribute("target","_self");               // 关键：拉回本 tab
  }
  el.click();
  results.push({type:type, selector:sel, ok:true,
                url:location.href, newTab: (oldTarget !== null) ? false : undefined});
}
```

要求：

1. **不改用户的操作语义默认值**：Agent 想新开时必须显式传 `{"type":"click","selector":"...","newTab":true}`，并在 `browser_act` 的工具描述里写明这一点。
2. 把 `newTab` 行为写进回执（`results[i].newTab`），让 Agent 能记录"我开了新 tab"。
3. **可选加固**：一次性替换 `window.open`（在当前页面会话内 hook，act 结束即还原），把 `window.open(url)` 变成 `location.href = url`。若改动方判断 hook 风险高（站点可能依赖 window.open 语义），**可以只做 `<a target>` 部分**——这一条能覆盖本次 4 个 tab 中的至少 2 个，收益已经足够。

**验收**：在 Bing 结果页用 `find` 拿到一条 `target="_blank"` 的链接，`act` 点击后：`browser_read` 的 URL 变了，**且侧栏 tab 数 +0**。

### 改动 C（中风险，堵 S3）：openTab 记账，重试不重复开

在 `applyReveal`（`lib/client.js:569`）里引入"本次展开是否已经对宿主发起过 openTab"的记账，并让 `requestReveal` 的重试尊重它：

```js
// 模块级
var revealLedger = new Map()   // key: sessionId:turn  → {openedKind, url, ts}

function applyReveal(target){
  ...
  var key = target.sessionId ? (target.sessionId + ':' + target.turn) : null
  var prior = key ? revealLedger.get(key) : null

  // 这一轮已经成功发起过一次同类展开 → 不再重复 openTab，只补展开态与探针
  if (prior && prior.kind === kind && prior.url === (params && params.url)) {
    ensureExpanded(sidebar)
    dwbLog('重复展开被去重：' + describe(key) + ' 已是 ' + describe(kind))
    return kind          // ← 返回非 null，重试循环会就此收敛
  }

  var opened = false
  try {
    if (target.params) sidebar.openTab(kind, { params: target.params })
    else sidebar.openTab(kind)
    opened = true
  } catch (error) {
    // ★ 关键：无论 openTab 是否抛错，都记成"已发起"。
    //   否则宿主"先建 tab 再抛错"会让重试再建一个。
    if (key) revealLedger.set(key, { kind: kind, url: params && params.url, ts: Date.now() })
    dwbLog('openTab("' + kind + '") 失败：' + describe(error))
    ensureExpanded(sidebar)
    probeBrowserFrame('openTab 抛错后')
    return kind          // ← 已发起过，就不要让上层重试了
  }
  if (key) revealLedger.set(key, { kind: kind, url: params && params.url, ts: Date.now() })
  ...
}
```

> 设计要点：**把 `openTab` 的调用变成"最多一次"**。副作用已经发出去之后，重试的正确动作是"复查 + 补展开"，而不是"再调一次 openTab"。这条改动无论 S3 是否成立都能消除"重试 → 多 tab"这一类风险。
>
> `revealLedger` 需要**有界**：按 `ts` 清理超过 `INTENT_MAX_AGE_MS`（`:111`，30s）的条目，或超过 32 条时丢最旧的，避免长会话内存增长。

**验收**：新增单测（见 §4 的 T3/T4），断言"宿主 openTab 每次抛错时，`requestReveal` 只调用 openTab 一次"。

### 改动 D（中风险，堵 S4）：URL 级去重 —— 已经在看这个页面就别再开

在 `applyReveal` 的 browser 分支进入 `openTab` 之前加一道**当前 tab 地址比对**：

```js
if (kind === KIND_BROWSER && params && params.url) {
  var frame = pickBrowserFrame()
  var current = null
  try { current = frame && typeof frame.getURL === 'function' ? frame.getURL() : null } catch (e) { current = null }
  if (current && samePage(current, params.url)) {
    ensureExpanded(sidebar)
    probeBrowserFrame('目标地址已在当前 tab')
    dwbLog('浏览器 tab 已是目标地址，跳过 openTab：' + describe(current))
    return KIND_BROWSER
  }
}
```

`samePage(a, b)` 建议**先严格相等、再退化到"忽略 hash"**；不要做"同域即同页"的宽判（会把不同文档误判成同一个）。

这一条正好覆盖本次事故的形状：**先 click 跳到 X，再 `reveal(browser, X)`** —— 第二次变成零 tab。

**验收**：单测 T5。

### 改动 E（可选，防抖）：同一会话的展开做 single-flight

`requestReveal` 在 200ms 内被同一 session 重复触发时，合并为一次 `step()`（保存最后一次的 `data`，只跑一次 openPanel）。这条是加固，不是必需项；如果 D 已生效，E 的边际收益有限。

### 改动 F（低风险，可观测性）：回执里明说走了哪条分支

- `opNavigate` 三条路径的回执 note 各自区分：`原地跳转(loadURL)` / `回落 openTab(未找到 webview)` / `已发起导航(等待超时)`；
- `requestReveal` 成功时日志补一句**当前浏览器 tab 数量**：

```js
var n = findBrowserFrames().length
dwbLog('意图展开 turn=... → 打开 ' + applied + '（当前浏览器元素 ' + n + ' 个）')
```

- 诊断面板（`Diagnostics`，`lib/client.js:2139`）里显示 `findBrowserFrames().length`，并提供一个"关掉重复的浏览器 tab"按钮：若能拿到 `sidebar.active()` / tab 列表，就保留活动那个、`sidebar.close(id)` 关掉其余 browser tab（`sidebar.close` 的用法见 `closeBrowserTab`，`lib/client.js:1206`）。

**验收**：日志里能一眼看出这次展开是"复用"还是"新开"。

---

## 4. 测试计划

沿用 `tests/reveal.test.mjs` 的既有风格（自制 `check()`、假 `window`/`document`/`sidebar`、`node tests/reveal.test.mjs` 运行）。**每个改动至少配一条断言，改完必须整套跑过。**

建议新增：

- **T1（改动 A）**：构造 `document.querySelectorAll('a[href]')` 返回带 `target="_blank"` 的假元素，调 `handleCommand({op:'find'})`，断言注入脚本包含 `target` 收集逻辑，且返回结果里该字段非空。
- **T2（改动 B）**：断言 act 生成的脚本里出现 `setAttribute("target","_self")`；并断言当 `newTab:true` 时不出现该调用。
- **T3（改动 C·核心）**：假 sidebar 的 `openTab` **抛错**，投递一次带 url 的 reveal intent，等待所有重试窗口过去，断言 `openTab` 的调用次数 **=== 1**（现状会是 >1，测试先红后绿）。
- **T4（改动 C·收敛）**：`openTab` 抛错后，`requestReveal` 的重试路径**不再调用 openTab**，而是调用 `probeBrowserFrame` / `ensureExpanded`（用假 `getBoundingClientRect` 保证探针能跑）。
- **T5（改动 D）**：假 frame 的 `getURL()` 返回 `https://x/a`，投递 `intent.url = 'https://x/a'` 的 reveal，断言 `openTab` 调用次数 === 0 且返回 `browser`。
- **T6（回归·改动 D 不能过度去重）**：`getURL()` 返回 `https://x/a`、`intent.url = 'https://x/b'`，断言 `openTab` **仍然被调用一次**。
- **T7（回归·navigate 原地优先不变）**：保留现有 `:394-417` 那条断言必须继续绿，防止改动 D/F 破坏 `loadURL` 优先。

另外把现有 `:389-391`（"navigate 调用官方 openTab"）更新为**只在无 webview 时才允许 openTab**，否则那条断言会把 S1 的回归锁死。

---

## 5. 判别实验：先确证 S3，再动手

在真实桌面端做一次只读判别，**不改任何代码**：

1. 打开诊断日志，清空；
2. 用一次 `sidebar_reveal(mode=browser, url=<与当前 tab 不同的地址>)` 触发展开；
3. 看日志里 `openTab("browser") 失败：…` 出现的次数：
   - **出现 ≥2 次** → S3 成立，宿主 `openTab` 存在"建了 tab 再抛错"的行为，改动 C 是必修项；
   - **出现 0 次** → S3 不成立，重心放在 A/B/D（点击与 URL 去重），C 仍建议实施但降级为加固。

同时数一下分栏内 tab 数：`1 → 2` 说明 openTab 每次都新增；`停在 1` 说明宿主侧已有分栏内去重，那么"3 个 tab"就只可能来自 S2 的点击（改动 B 的优先级升到第一）。

---

## 6. 手操回归清单（改动完成后，由 Agent 在真实桌面端跑）

每一步都记录**侧栏 tab 数**（截图或诊断面板数字）：

| # | 操作 | 期望 |
|---|---|---|
| 1 | `browser_navigate` 到 Bing | tab 数 +1 或 0（原地），不得 +2 |
| 2 | `find` 取一条 `target="_blank"` 的链接 | 能看到 `target` 字段 |
| 3 | `act` 点它一次 | tab 数 **+0**，`read` 的 URL 已变 |
| 4 | 紧接着 `reveal(browser, 刚落地地址)` | tab 数 **+0** |
| 5 | `act` 点一条普通链接 + 再 `read` | 内容正确，无锁死 |
| 6 | 同一序列连做 3 轮 | tab 总数不超过 2（搜索页 + 当前页） |
| 7 | 全程无 150s 超时、无"读取被锁住" | 通道不静默死亡 |

第 4 步和第 6 步是本次事故的**核心判据**。

---

## 7. 明确不做的事（避免把 dsh 写崩）

1. **不要动短轮询机制**（`POLL_INTERVAL_MS` 等，`lib/client.js:997`）。README `:63-72` 记录了长轮询导致整条通道静默死亡的事故与修复，"150s 超时"是那类故障的形状，不是本次 tab 问题的成因。
2. **不要改授权语义**：`closeBrowserTab`（`:1189`）"拒绝即关掉 AI 用的那个 tab"是用户明确要求的，任何去重逻辑都不许顺手关用户的 tab。
3. **不要为了去重而绕过 `openTab`**：宿主侧没有别的公开导航 API，自造 `frame.loadURL` 之外的路径会踩到未定义行为。
4. **不要动 `NAVIGATE_WAIT_MS` / `MAX_ATTEMPTS` 这类常量来"缓解"症状**——超时不是根因，调小只会把问题从"多 tab"变成"导航报错"。
5. **改动必须由插件侧 owner 完成并跑 `node tests/reveal.test.mjs`**；本文档作者只在 DSH 侧做只读验证，不直接编辑 `lib/client.js`。

---

## 8. 建议的落地顺序

```
① 改动 A（暴露 target）        —— 10 行内，无副作用，先合
② 改动 F-lite（回执区分分支）   —— 纯文案/日志，帮后面几步取证
③ §5 判别实验                  —— 决定 C 的优先级
④ 改动 B（点击默认原地）        —— 收益最大，需 T1/T2 护航
⑤ 改动 D（URL 级去重）          —— 需 T5/T6 护航
⑥ 改动 C（openTab 记账）        —— 需 T3/T4 护航
⑦ 改动 F-full（诊断面板 tab 计数 + 清理按钮）
⑧ 更新 README `:22`/`:74-77`：把"同分栏去重"改成
   "分栏去重 + 分栏内 tab 级去重（改动 D）"，并写明点击默认原地（改动 B）
```

每一步单独提交、单独跑测试；④~⑥ 之间不要合并成一次提交，否则回归定位不到根因。
