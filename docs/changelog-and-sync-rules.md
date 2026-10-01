# dsh-sidebar-enhance 修改记录 + 找最新版的规则（对账用）

> 受众：在 DSH 里改这个插件的 AI / 工程师。本文**自包含**——你没参与过那场对话也能照着做。
> 生成时间：2026-10-01 16:05。当前**源码**版本：**协议 v10**。

---

## 0. 一句话结论

**最新代码只在 `<插件目录>\lib\` 里，别处都不是权威。**
改完必须**完全退出桌面端（含托盘）再启动**，然后**读日志确认两行协议版本一致**——
只刷新页面会让「客户端是新的、宿主还是旧的」，这种组合不报任何错、最难查。

---

## 1. ★ 找最新版 / 判断"加载的是不是最新"的规则

### 1.1 权威源只有一个

| 路径 | 说明 |
|---|---|
| `<插件目录>\lib\` | **唯一权威源码**（`client.js` / `index.js` / `browser.js`） |
| `~/.dsh\profiles\desktop\node_modules\dsh-sidebar-enhance` | 软链（`link:` 装的），**指向上面的目录**，不是副本 |
| ⚠️ `<本地插件根目录>\dsh-workbuddy\` | **改名前的旧目录，已废弃**。见下方警告 |
| `<本地插件根目录>\*.bak-*` | 旧备份（含 `*.bak-before-rename-*`），**不是最新**，只能用于回滚 |
| `<dsh 安装目录>\resources\app.asar` | dsh 官方运行时（只读参考，不要改） |

> ### ⚠️ 旧目录 `dsh-workbuddy\` 是个陷阱（16:5x 核查）
>
> 改名时**新建**了 `dsh-sidebar-enhance\`，但**旧的 `dsh-workbuddy\` 没有删**。
> 核查时（16:52）两边 `lib/*.js` **逐字节完全相同**，所以此刻还看不出区别 ——
> 但只要有人在旧目录里改一行，就会立刻出现两个"看起来都像源码"的副本，
> 而 DSH 加载的永远是新的那个，改动会**静默失效**。
>
> **规则：任何编辑前先确认路径里是 `dsh-sidebar-enhance`。**
> 旧目录建议尽快删除（删除前先确认没有别的东西引用它）。

**判定文件新旧看 mtime，不要看文件内容猜。** 当前（16:05）：

```
lib/client.js   10-01 16:02
lib/index.js    10-01 16:02
lib/browser.js  10-01 15:58
```

### 1.2 两半的加载时机不同 —— 这是所有"改了没生效"的根源

| 半侧 | 文件 | 何时重新加载 |
|---|---|---|
| 浏览器半侧（client） | `lib/client.js` | 页面刷新 / dev watcher 就会重新 apply |
| 宿主半侧（host） | `lib/index.js`、`lib/browser.js` | **只在桌面端进程启动时加载一次** |

所以：

- 改了 `client.js` → 刷新可能够（但仍建议完全重启）；
- 改了 `index.js` / `browser.js`（**工具注册、路由、工具描述、系统提示词都在这**）→
  **必须完全退出（含托盘）再启动**，刷新页面**一定不够**。

### 1.3 验证加载了哪一版：看日志里两行协议版本

日志文件：`<插件目录>\logs\sidebar-enhance.log`
（也可以 GET `/api/dsh-sidebar-enhance/log` 拿尾巴，或看插件面板「诊断日志」）

每次启动各打一行：

```
[host]   host apply: 协议 v10 modes=changes,files,file,terminal,browser tools=ok …
[client] 节点 app · client 协议 v10 · 日志通道 /api/dsh-sidebar-enhance/log
```

**规则：两行数字必须相同，且等于源码里的 `PROTOCOL`。** 不一致就是有一半没重载。

常量位置（改行为就升它，一次改两边）：

```
lib/index.js:42    const PROTOCOL = 10;      // host 半侧
lib/client.js:79       var PROTOCOL = 10     // client 半侧
```

### 1.4 三步判定（建议每次动手前都走一遍）

1. **看源码版本**：`grep -n "PROTOCOL = " lib/client.js lib/index.js`
2. **看运行时版本**：`grep "协议 v" logs/sidebar-enhance.log | tail -4`
3. **看文件 mtime vs 日志时间戳**：
   若 `lib/*.js` 的 mtime **晚于**最后一次 `[host] host apply` 的时间 →
   **宿主跑的是旧代码**，必须先完全重启再验证。别在旧代码上分析现象。

> 现状示例（16:05）：源码是 v10，但日志里最后一次 `host apply` 是
> **15:51 的 协议 v9** —— 说明 v10 **尚未被加载**，此刻真机跑的还是 v9。
> 这条如果不查，就会把 v9 的行为当成 v10 的结论，越查越乱。

### 1.5 反向确认「新 bundle 真的生效了」

协议版本是最省事的办法。若想再确认一次，用「只存在于新代码的文案」反查日志
（例如 v10 的回执文案 `[点击已跳转]`、`[回落 openTab·未确认]`）。

---

## 2. 修改记录（按版本，v3 → v10）

协议版本单调递增，用于识别"哪半没重载"。**两边常量必须同时改。**

### v3（14:0x，外部 AI）
- `dsh-resource://file` 地址改为**逐段编码**（官方 `encodeSegment` 语法：`:` 保留字面量）
- 缺 `path` 不再退到文件树，改用本轮最后改动的文件
- 报错给出可照抄的示例 JSON
- 启动日志加协议版本号（就是上面这套对账机制）

### v4（14:1x，外部 AI）
- **新增浏览器桥**：`lib/browser.js`（命令通道 + 授权存储 + 四个工具）
- 四个工具：`browser_read` / `browser_find` / `browser_act` / `browser_navigate`
- 授权按 SessionId 绑（`exec.agent.id`），三按钮拦截页，全局策略 `browserPolicy`
- 通道：客户端长轮询拉命令、POST 回结果

### v5（15:00，外部 AI）—— 返回值全是 `null`
- **根因**：客户端把结果**摊平**回传（`{id, ok, url, title…}`），没有 `data` 字段；
  宿主读 `body.data` → `undefined` → `null` → `stringify(null)` = 字符串 `"null"`
- 修：客户端新增 `payloadFor()` **单一收口**；宿主 `collectData()` 兜住摊平载荷；
  日志记 `data{字段} 体积`；data 为空给可诊断文案，绝不回裸 `null`

### v6（15:0x，外部 AI）—— 通道静默死亡
- **根因**：长轮询（挂 20s）在一次 act 之后让整条通道静默死亡，
  客户端请求全部无声消失（POST 的 catch 是空的），每条命令等满 150s
- 修：**长轮询 → 短轮询**（每 1s，宿主立即返回）；结果回传 `postResultWithRetry()`
  确认送达 + 失败重试 3 次 + ⚠ 日志；宿主对迟到结果留痕
- 新增：**navigate 原地跳转**（`frame.loadURL`，已有 tab 时不开新的）
- 新增：面板「浏览器桥」健康行（`__dshWorkbuddy.health()`）

### v7（15:20，外部 AI）—— 一次点击冒出多个 tab
起因：DSH 里的 DS 模型写了 `docs/tab-dedupe-plan.md`（S1–S5 五个来源），外部 AI 落地：

| 来源 | 修法 |
|---|---|
| `<a target="_blank">` | 点击**默认拉回本 tab**（临时改 `_self`），`newTab:true` 才新开 |
| 模型等不到又点 | 点击后等地址变化再返回（**这一条在 v8 被证明是错的做法，已移除**） |
| 跳转销毁上下文返回空 | 不再报失败，说「正在跳转，用 read 确认，不要重复点击」 |
| 同一地址重复展开 | URL 级去重 `samePage()`（严格相等 / 忽略 hash） |
| openTab 抛错→重试多开 | 记账：一次展开最多发起一次 openTab（**作用域仅限一次 requestReveal 的 12 次重试**） |
| 信息不全 | `__wb_desc` 的 attrs 与链接列表带 `target` / `rel` |

### v8 / v8.1（15:4x，**DSH 里的 DS 模型**）—— act 卡住；失败原因被丢
详见 `docs/act-hang-fix.md`。核心 7 处：

1. 页内**不再**等导航（`el.click();await delay(100);`）
2. 新增 `readFrameUrl()` / `watchFrameNavigation()`：**在 webview 层盯地址**
3. act 让「脚本返回」与「地址变化」赛跑（`Promise.race`）
4. 客户端不再上报 `error: null`
5. 宿主不再把 `null` 字符串化（否则 `error || "未知错误"` 兜底永久失效）
6. `hoistActionFailure()`：把 `results[i].error` 提到顶层
7. 宿主失败回执带上 `data` 明细

**真机已验证（v8 部分，16:0x）**：点 Bing 结果里的 `target="_blank"` 链接，
回执立刻返回完整动作明细，不再卡住。

**真机已验证（v8.1 部分，16:1x，运行时 v10）**：
- 点不存在的选择器 → 回执给出**确切原因与明细**：
  `浏览器操作失败: 动作 click (#no-such-element) 失败: 找不到元素: #no-such-element` + `明细: {…failedIndex: 0}`
  （旧版只会说「失败了但没有原因」，无从自我纠正）
- 点真实 `target="_blank"` 结果 → 立刻返回 `{ok:true, navigated:false, newTab:false}`
  （`newTab:false` 说明 target 确实被拉回 `_self`），随后 `browser_read` 确认已原地跳转
- 点**跨站整文档导航**链接（掘金外链拦截页 `link.juejin.cn`）→ 同样立刻返回完整明细、无卡住

### v9（15:45，外部 AI）—— act 点击后永挂
- **根因**：点击触发跳转时 `executeJavaScript` 的 promise **既不 resolve 也不 reject**
  （不是返回空！），整条链死等 → 模型等满宿主 150s
- 修：`runPageScript()` 竞速超时 30s；act 超时按「正在跳转」处理，
  read/find 超时按失败处理
- 顺带：回落 `openTab` 开出 `about:blank` → 轮询确认 + 补一发 `loadURL`
- 测试入口：`bridge.pageScriptTimeout(ms)` 可把超时调小以驱动该路径

### v10（16:02，外部 AI）—— 补齐 v8 遗留 + 区分两类工具

**A. 语义区分**（用户明确要求）：两组工具都能打开网页，用途是两条路，
写进系统提示词段 + 两个工具 description + README，并**用断言锁住**：

| | `sidebar_reveal` | `browser_navigate` + `read`/`find`/`act` |
|---|---|---|
| 一句话 | **把成果摆到用户眼前** | **AI 自己要用这个网页** |
| 谁看 | 用户 | AI（内容返回给模型） |
| 返回内容 | **不返回**，打开就够了 | **返回** |
| 场景 | 交付收尾 | 查资料 / 验证刚写的网页 / 前端 debug |
| 时机 | 一轮收尾 | 干活中途 |

**B. 补齐 v8 的三处遗留**：
- `ACT_NAV_WATCH_MS` 2500 → **20000**（用户实测页面约 **20 秒**才跳完；
  盯守 2.5s 会在跳转发生前放弃，又退化成等 30s 超时，修了等于没修）
- read / find 也参与地址竞速：撞上跳转立刻报「页面正在跳转到 X，内容已失效，重新调用一次」
- `describe()` 注释警告（它把 `null` 压成字符串，**不能拿返回值判空**）；
  `browser_find` / `browser_read` 描述写明 **href 是解析后的绝对地址，要用 `path`**

---

## 3. 当前状态（16:52 复核）

| 项 | 值 |
|---|---|
| 插件名 | **dsh-sidebar-enhance**（工具：`sidebar_reveal` + 4 个 `browser_*`） |
| 源码协议版本 | **v10**（`client.js:79` / `index.js:42` 均为 10） |
| 运行时最后加载 | **v10** ✅ —— 改名后重启：`[host] host apply: 协议 v10` @16:36:34、`[client] client 协议 v10` @16:36:37 |
| 两侧是否一致 | ✅ 一致 |
| 日志路径 | `dsh-sidebar-enhance\logs\sidebar-enhance.log`（改名后**换了文件名**，旧日志不再更新） |
| 测试 | `smoke` OK · `reveal.test` OK · `host.test` OK |
| v8 / v8.1 改动是否幸存 | ✅ 7 处全在（`watchFrameNavigation` / `hoistActionFailure` / `el.click();await delay(100)` / 宿主 null 不字符串化 / 失败带明细 …） |
| 回滚备份 | `<本地插件根目录>\{client,index,browser}.js.bak-*` |
| 下一步待验 | ① 授权「始终允许访问」；② v10 的 read/find 地址竞速（竞态，难以稳定构造） |

### 3.1 授权三态测试记录

| 选项 | 状态 | 证据 |
|---|---|---|
| 允许此次访问（once） | ✅ **已验证**（16:53:20 授予 → 17:03:45 过期后重新弹框） | 见下 |
| **不允许此次访问（deny）** | ✅ **已验证 2 次**（16:50、16:51） | 见下 |
| 始终允许访问（session） | ✅ **已验证**（10.4 分钟不过期 → 重启后重置） | 见下 |

**once 实测（16:53 → 17:03，跨 TTL 边界）**：

```
16:53:18.973  [client] 授权: 请求用户确认 navigate {"url":"…ttl+ten+minutes"}
16:53:20.058  [client] 授权: 用户选择「once」
16:53:20.079  [host]   授权: 会话 session-d9f6ce0a-… 「允许此次访问」，有效期 10 分钟
16:53:22.779  [client] 浏览器桥 read → 成功 …            ← 有效期内，未再弹窗 ✅
   ⋯ 等待 10 分钟（不关 DSH）⋯                            ← TTL 在 17:03:20 到期
17:03:45.658  [client] 授权: 请求用户确认 read {"maxChars":300}   ← ★ 重新弹框 ✅
```

**结论：once 的 10 分钟 TTL 确实生效。** 有效期来自 `ONCE_TTL_MS = 10 * 60 * 1000`
（`lib/browser.js:39`），判定在 `isGranted()`：`typeof until === "number" && until > Date.now()`。

**session 实测（17:03:47 → 17:14:09，10.4 分钟，全程未重启 DSH）**：

```
17:03:47.838  [client] 授权: 用户选择「session」
   ⋯ 等待 10.4 分钟，不关 DSH ⋯
17:14:09.131  [client] 浏览器桥 read → 成功 …       ← ★ 没有新的授权请求行 ✅
```

全日志里 `授权: 请求用户确认` 只出现 4 次（16:50:41 / 16:51:07 / 16:53:18 / 17:03:45），
**17:03:47 之后一次都没有**。

**结论：session 授权不随超时过期**，与设计一致（`grants.session` 是内存 Set，没有 TTL 字段）。

**重启重置实测（17:51，第三步）**：

```
17:51:09.838  [host]   host apply: 协议 v10 …        ← 新进程（重启）
17:51:12.769  [client] 节点 app · client 协议 v10 …
17:51:12.770  [client] 浏览器桥: 开始短轮询 …
17:51:30.196  [client] 授权: 请求用户确认 navigate {"url":"…reset+after+restart"}  ← ★ 重新要授权
17:51:35.851  [client] 授权: 用户选择「once」
17:51:36.187  [client] 浏览器桥 navigate → 成功
```

**结论：session 授权随进程重启被重置** ✅，与设计一致
（`grants.session` 是内存 Set，进程重启即失效；`grant()` 的日志也写着「仅本进程有效」）。

**至此授权三态全部验证完毕：**

| 选项 | 授予后 | 10 分钟后 | 重启后 |
|---|---|---|---|
| 允许此次访问（once） | 免问 ✅ | **重新要授权** ✅ | 重新要授权 ✅ |
| 始终允许访问（session） | 免问 ✅ | 免问 ✅ | **重新要授权** ✅ |
| 不允许（deny） | 当次被拒、回执清晰 ✅ | — | — |

> 方法论提醒（三次都用上了）：**光看工具返回值分不清「重新弹框后用户点了通过」和「压根没弹框、直接放行」**
> ——两者都返回内容。**必须用日志里的 `授权: 请求用户确认 …` 行来判定。**

**待验**：10 分钟后（**17:03:20** 到期）再发一次操作，**预期重新弹授权框**。

deny 实测（`16:50:41` / `16:51:07` 两次，冷会话、无已授权 tab）：

```
[host]   → client navigate id=cmd-N 需授权 {"url":"…"}
[client] 授权: 请求用户确认 navigate {"url":"…"}      ← 拦截页真的弹了
[client] 授权: 用户选择「deny」
[client] 拒绝授权: 没有活动 tab，无需关闭              ← 优雅降级，没报错
[host]   ← client navigate id=cmd-N 被拒绝
```

回执（模型侧）：`用户拒绝了对侧栏浏览器的访问（那个浏览器 tab 已被关闭）。不要重复调用：…`

**结论：deny 路径的每一环都正确**——拦截页弹出、决定被记录、关 tab 逻辑在「无活动 tab」时不炸、
回执对模型有明确指示。

> **还没验到的一环**：因为 `navigate` 也需要授权（见 §3.2），冷会话下**开不出 tab**，
> 所以「拒绝 → 关掉那个浏览器 tab」真正关闭 tab 的分支这次没走到
> （走的是「没有活动 tab，无需关闭」）。要验它，需要**先在已授权状态下把页面开出来，
> 再拒绝一次操作**。

### 3.2 ⚠️ 发现不一致：`navigate` 也要授权

| | 说法 |
|---|---|
| `lib/browser.js:21` 文件头注释 | 「导航（打开 tab）**不需要授权**——那是用户看得见的事；读页面 / 交互需要用户明确同意」 |
| `docs/README` / 本文档 §2 v4 | 同上 |
| **实际实现 `lib/browser.js:389`** | `const needsConsent = !isGranted(sessionId)` —— **对所有 op 一视同仁，navigate 也要** |

16:50 的日志证实走的是实现：`navigate id=cmd-1 需授权`。

**需要决策**：要么改代码让 navigate 免授权（贴合原设计），要么改文档承认所有 op 都要授权。
**在定下来之前，文档第 21 行那句话是错的**，照着它推理会得出错误结论。

> 副作用提醒：若保持现状（navigate 也要授权），「拒绝 → 关掉那个 tab」这条行为
> 在冷会话下**永远走不到**，只能通过「已授权 → 有 tab → 再拒绝」来验证。

---

## 4. 双方约定（避免互相覆盖）

1. **动手前**先跑一遍 §1.4 三步判定，确认自己读的是最新源码、且运行时已加载它。
2. **改行为就升 `PROTOCOL`**（两个文件一起改），并更新本文档 §2。
3. **改完必须**：
   - `node --check lib/client.js && node --check lib/index.js && node --check lib/browser.js`
   - `node tests/smoke.mjs` / `node tests/reveal.test.mjs` / `node tests/host.test.mjs`（**注意 `smoke.mjs` 不带 `.test`**）
   - **完全退出桌面端（含托盘）再启动**
   - 读日志确认 `[host] … 协议 vN` 与 `[client] … client 协议 vN` 一致
4. **别覆盖这些**（都是踩过坑才有的）：
   - `payloadFor()` —— 结果必须装在 `data` 里，摊平会让模型收到 `"null"`
   - `runPageScript()` 的竞速超时 —— 去掉就回到 150s 挂死
   - `watchFrameNavigation()` —— 判定导航必须在 webview 层做，**不能搬回页内**
   - 短轮询 —— 长轮询会让整条通道静默死亡
   - `handleCommand` 里结果 POST 的位置 —— 挪回命令循环就是 v5 那次事故
5. **改 `lib/client.js` 后只刷新**是不够的（见 §1.2），反过来改 host 侧**必须**完全重启。

---

## 5. 还没做的（按优先级）

1. act 跳转后，可在宿主侧再等 300–500ms 让新页面 `readyState` 到 `complete`
   （**必须做在宿主侧，别搬回页内**，理由见 §2 v8 改动 1）
2. `ACT_NAV_WATCH_MS` 可按 op 分配预算（act 短、wait 长）
3. 面板里显示当前浏览器 tab 数 + 一个「关掉重复 tab」的按钮（v7 方案里的 F-full）
4. 文档里那两条语义区分只在提示词层，未做工具级强制（例如 reveal 传入 url 时
   提示"要自己读请用 browser_navigate"）——当前只靠提示词，模型可能仍混用
