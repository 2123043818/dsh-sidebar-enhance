# dsh-sidebar-enhance

像workbuddy里ai即将完成回复时自动打开文件或网页为用户展示那样，对dsh官方客户端（0.2.0-rc2客户端）本体侧栏进行部分增强，现在AI可以主动触发侧栏的展开，并利用侧栏为你展示成果。

同时侧栏中的浏览器由之前只能用户使用的状态，转为AI可以使用并借此查询、跳转、读取网页信息（具体设计参考了部分[dsh-browser-bridge](https://github.com/ycp424c/dsh-browser-bridge "最好的markdown教程")的设计思路）。

给 **DeepSeek Harness（DSH）桌面端**自带的右侧栏加两个功能：

1. **Agent 交付成果时主动把侧栏拉出来** —— 写完了文件、跑起了服务、做好了网页，
   侧栏会自己打开给你看，而不是让你自己去点。
2. **侧栏浏览器 tab 真的交给 Agent 用** —— 读页面、找元素、点击输入、导航，
   **每一次读写都要你点头**。

> 只做两件事：驱动官方 API 展开侧栏、把侧栏的 `<webview>` 变成 Agent 可操作的浏览器。
> 不新建侧栏、不复制侧栏 UI、不碰模型、不上传任何数据。

---

## 功能展示

### 1. 展示成果（工具 `sidebar_reveal`）

宿主侧注册系统提示词段，要求 Agent 在收尾时调用它。支持：

| mode | 展示什么 | 额外参数 |
|---|---|---|
| `file` | 打开一个具体文件 | `path` |
| `changes` | 本轮改动 diff | — |
| `files` | 工作区文件树 | — |
| `terminal` | 终端 | — |
| `browser` | 网页 | `url` |

插件**不搞「每轮结束自动弹」** —— 那既打扰用户，也会和你刚关掉侧栏的意图打架。

### 2. 浏览器桥（工具 `browser_*`）

侧栏的「浏览器」tab 在桌面端是**真的 Electron `<webview>`**。官方只暴露导航 API，
但 webview 的**元素方法**（`executeJavaScript` / `getURL` / `capturePage`）是 Electron
给 embedder 的能力，插件所在的渲染进程能调到 —— 本插件就是靠这条路把页面交给模型的
（先用只读探针实测确认，再写功能）。

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 导航到某个网址（**已有 tab 时原地跳转**，不会开一堆 tab） |
| `browser_read` | 读当前页面：标题 / URL / 正文 / 链接 / 可交互控件 |
| `browser_find` | 按 CSS 选择器或可见文字找元素，返回可直接喂给 `browser_act` 的路径 |
| `browser_act` | 点击 / 输入 / 选择 / 按键 / 滚动 / 等待 |

**没有截图工具**：官方 AI 侧拿不到附件通道，而且纯文本模型看不了图 ——
观察靠结构化 DOM 更划算。

### ★ 两组工具都能打开网页 —— 但它们是两条路

| | `sidebar_reveal`（展示） | `browser_navigate` + `read`/`find`/`act`（自己用） |
|---|---|---|
| **一句话** | **把成果摆到用户眼前** | **AI 自己要用这个网页** |
| 谁看 | 用户 | AI（内容返回给模型） |
| 返回内容吗 | **不返回**，打开就够了 | **返回** |
| 典型场景 | 交付：写完了、跑起来了、做好了，让用户自己看 | 查资料、验证刚写的网页渲染得对不对、前端 debug |
| 时机 | 一轮收尾 | 干活中途 |

两者不冲突：先用 `browser_*` 自己调试验证，收尾再用 `sidebar_reveal` 展示。

---

## 安装

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-sidebar-enhance
```

然后**完全退出桌面端（含托盘）再启动** —— 刷新页面不够。

> 插件分两半：
> - `lib/client.js`（浏览器半侧）：刷新页面 / dev watcher 就会重新加载；
> - `lib/index.js`、`lib/browser.js`（**宿主半侧**）：**只在桌面端进程启动时加载一次**。
>
> 改了宿主半侧只刷新页面，会得到「新 client + 旧 host」且**不报任何异常**。
> 这是本插件最容易踩的坑。

### 卸载

```bash
dsh plugin --profile desktop remove dsh-sidebar-enhance
```

---

## 授权模型（重要）

**导航不需要授权**（那只是打开一个你看得见的页面）；**读页面 / 交互需要**。
需要时插件弹出拦截页，三个按钮：

| 用户选择 | 效果 |
|---|---|
| 允许此次访问 | 本会话 10 分钟内免问 |
| 始终允许（本会话） | 本会话一直免问，**按 SessionId 绑、不影响其它会话、进程重启即失效** |
| 不允许 | 立刻关掉 AI 正在用的那个浏览器 tab |

设置里还有全局策略 `browserPolicy`：`ask`（默认，每次问）/ `allow`（始终允许）。

安全默认值：

- 所有 HTTP 路由**只接受本机回环**来源的请求；
- 授权**不超过进程生命周期** —— 重启即失效，不存在"一次授权永久有效"；
- AI 只能操作**你已经在侧栏打开的那一个页面**；
- 点击默认**在原 tab 跳转**，`target="_blank"` 会被临时拉回 `_self`，
  要新开必须显式 `newTab: true`。

### ⚠️ 使用风险请知悉

把浏览器交给 AI 意味着它能**读到你在那个页面里看到的一切** —— 包括已登录的后台、
私人信息、未发布内容。请仅在你愿意让 AI 看到当前页时授权，
用完关掉那个 tab，或保持设置为 `ask`。

---

## 日志与排障

日志写到 `<插件目录>/logs/sidebar-enhance.log`，也可以在插件面板的「诊断日志」里直接看
（面板还有一行「浏览器桥：在线 · 最近轮询 Ns 前」，通道断没断一眼可见）。

每次启动两半各打一行协议版本，用来确认「加载的是不是最新版」：

```
[host]   host apply: 协议 v10 …
[client] 节点 app · client 协议 v10 …
```

**两行数字必须一致**；不一致就是有一半没重载（通常是没完全退出桌面端）。

---

## 开发

```bash
npm run check   # 语法检查
npm test        # 三套测试（不用起 dsh，在 Node 里造假 window/React 真跑一遍）
```

结构：

```
lib/index.js      宿主半侧：工具注册、HTTP 路由、系统提示词段
lib/browser.js    宿主半侧：浏览器桥（命令队列、授权存储、四个工具）
lib/client.js     浏览器半侧：UI（徽章 / dock / 拦截页）+ 命令循环 + DOM 操作
cordis.patch.yml  bundle 插入
tests/            smoke / reveal / host 三套
docs/             设计记录与排障文档（含几次真实事故的复盘）
```

`lib/client.js` 是 `__ModuleLoader__.load` 手写 bundle，无构建产物、无 JSX。

---

## 许可证

MIT（见 `LICENSE`）。
