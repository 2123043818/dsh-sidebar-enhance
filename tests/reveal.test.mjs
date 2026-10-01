/**
 * dsh-sidebar-enhance 展开链路回归测试。
 *
 * 用假的 __ModuleLoader__ + 假 React + 假 ctx 把 fold 跑起来，然后按**真实的事件形状**
 * 投递 `tool/call`，断言侧栏被驱动。
 *
 * 历史上这里翻过四次车，每种都留了断言：
 *   1. `arguments` 是**未解析的 JSON 字符串**（官方 session 类型就是这么标的），
 *      按对象判断会把事件静默丢掉；
 *   2. fold 的 update 里不能引用作用域外的名字（曾经写了 `event.turn`）；
 *   3. 模块体不能劫持全局 console；
 *   4. **Agent 的主动请求不能拿 autoReveal 把关** —— 用户一关掉「每轮结束后自动展开」，
 *      Agent 就再也弹不出侧栏（真实事故，日志里的「意图展开跳过：autoReveal 已关闭」）。
 *
 * 用法：node tests/reveal.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? resolve(here, '..', 'lib', 'client.js'))

const failures = []
const say = (...args) => console.log(...args)
function check(label, condition, detail) {
  if (condition) say('  ok   ' + label)
  else { say('  FAIL ' + label + (detail === undefined ? '' : '  → ' + detail)); failures.push(label) }
}

const storage = new Map()
const entries = []
const shipped = []
globalThis.window = {
  __ModuleLoader__: { load: (entry) => entries.push(entry) },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  location: { href: 'dsh-app://app/', origin: 'dsh-app://app', hostname: 'app' },
  // 短延时归零让测试跑得快；**长延时挂起**——否则授权弹窗的 120s 超时会瞬间触发，
  // 弹窗还没被断言就已经自己超时关掉了。
  setTimeout: (fn, ms) => (ms >= 5000 ? { parked: true } : setTimeout(fn, 0)),
  clearTimeout: (handle) => clearTimeout(handle),
  // 命令轮询**永不 resolve**：这样循环挂一次就不再排下一次（pollInFlight 卡住），
  // 定时器不会把测试进程一直拖着（测试直接调 handleCommand 驱动）。
  fetch: (url, init) => {
    shipped.push({ url, body: init && init.body, method: (init && init.method) || 'GET' })
    if (url === '/api/dsh-sidebar-enhance/command') return new Promise(() => {})
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  },
}

const React = {
  createElement: () => ({}),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const SEEDS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'])
const require = (spec) => {
  if (!SEEDS.has(spec)) throw new Error(`require("${spec}") missed the module table`)
  return spec === 'react' ? React : {}
}

const pristine = { ...console }
await import(pathToFileURL(target).href)
const mod = entries[0].factory(require)

const polluted = Object.entries(pristine).filter(([key, fn]) => console[key] !== fn).map(([key]) => 'console.' + key)
if (polluted.length) failures.push('污染了 ' + polluted.join(', '))

let fold
const opened = []
/** 侧栏当前活动 tab，用来验证「拒绝授权 → 关掉浏览器 tab」。 */
let activeTab = { id: 'tab-browser-1', kind: 'browser' }
const fakeCtx = {
  locale: { bind: () => (key) => key, register: () => () => {} },
  effect: (fn) => { fn() },
  inject: (_deps, fn) => fn({ effect: () => {}, shortcuts: { register: () => () => {} } }),
  slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  sidebarRight: {
    isExpanded: () => false,
    toggleExpanded: () => opened.push('toggleExpanded'),
    openTab: (kind, options) => opened.push('openTab:' + kind + (options && options.params ? '?' + JSON.stringify(options.params) : '')),
    openResource: (address, options) => opened.push('openResource:' + address + '?' + JSON.stringify(options && options.params)),
    active: () => activeTab,
    close: (id) => opened.push('close:' + id),
    mounted: { getSnapshot: () => 'sess-1' },
  },
  layout: { openRightbar: () => {} },
  uiConversation: { events: { register: (definition) => { fold = definition; return () => {} } } },
}
mod.apply(fakeCtx)

const settle = () => new Promise((done) => setTimeout(done, 40))
let callSeq = 0

/** 按真实形状投递一条 tool/call：arguments 默认是 **JSON 字符串**。 */
function callTool(name, args, { asString = true, callId, time } = {}) {
  opened.length = 0
  callSeq += 1
  return fold.update(
    { state: fold.start({}, { event: { data: { turn: 7 } } }) },
    {
      event: {
        type: 'tool/call',
        seq: callSeq,
        time: time === undefined ? Date.now() : time,
        data: {
          turn: 7, step: 0, callId: callId === undefined ? 'call-' + callSeq : callId,
          name, arguments: asString ? JSON.stringify(args) : args,
        },
      },
    },
  )
}

/** 通过插件自己的 bridge 改配置（模块加载时只读一次存储，改存储不生效）。 */
function setConfig(patch) {
  const bridge = globalThis.window.__dshSidebarEnhance
  if (bridge && typeof bridge.setConfig === 'function') bridge.setConfig(patch)
}

/** 造一条 tool/call 事件（arguments 是 JSON 字符串，和真实事件一致）。 */
function toolEvent(name, args, callId) {
  callSeq += 1
  return {
    type: 'tool/call',
    time: Date.now(),
    data: { turn: 8, step: 0, callId: callId === undefined ? 'call-' + callSeq : callId, name, arguments: JSON.stringify(args) },
  }
}

/**
 * 在**同一个 Turn** 里依次投递多个事件，保留 state（`callTool` 每次都新起 state，
 * 拿不到「本轮已改过哪些文件」）。
 */
function foldSession(events) {
  let state = fold.start({}, { event: { data: { turn: 8 } } })
  for (const item of events) {
    callSeq += 1
    state = fold.update({ state }, { event: { seq: callSeq, time: item.time, type: item.type, data: item.data } })
  }
  return state
}

/** 最近一次 openResource 打开的资源地址。 */
function lastResourceAddress() {
  const hit = opened.filter((x) => x.indexOf('openResource:') === 0).pop()
  return hit === undefined ? '' : hit.slice('openResource:'.length).split('?')[0]
}

/**
 * 照官方 `parseFileAddress` 复刻的逆解析（@deepseek-ai/dsh-util-workspace-path）：
 * 先按 `/[?#]/` 截断，再 `split('/')`，逐段 decodeURIComponent。
 * 用它做往返校验——编码方式只要和官方不一致，这里就解不回来。
 */
function parseFileAddress(address) {
  const PREFIX = 'dsh-resource://file/'
  if (!address.startsWith(PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? undefined : end).split('/')
  if (scope !== 'session') return undefined
  const [id, ...segments] = rest
  if (id === undefined || id === '' || segments.length === 0) return undefined
  try {
    return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
  } catch (error) {
    return undefined
  }
}

say('target =', target)
say('')

say('① arguments 是 JSON 字符串（真实形状）')
const next = callTool('sidebar_reveal', { mode: 'browser', url: 'https://www.bilibili.com/' })
check('update 不抛错且记下 intent', Boolean(next && next.intent && next.intent.mode === 'browser'),
  JSON.stringify(next && next.intent))
await settle()
check('侧栏被驱动到 browser', opened.some((x) => x.indexOf('openTab:browser') >= 0), JSON.stringify(opened))
check('browser 带上了 url', opened.some((x) => x.indexOf('www.bilibili.com') >= 0), JSON.stringify(opened))

say('')
say('② 其余 mode')
callTool('sidebar_reveal', { mode: 'files' }); await settle()
check('files', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))
callTool('sidebar_reveal', { mode: 'terminal' }); await settle()
check('terminal', opened.indexOf('openTab:terminal') >= 0, JSON.stringify(opened))
callTool('sidebar_reveal', { mode: 'changes' }); await settle()
check('changes 无 seq 时回退 files', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))

say('')
say('②b file 地址语法（官方 grammar：逐段 encodeURIComponent，`:` 例外）')
callTool('sidebar_reveal', { mode: 'file', path: 'E:\\tmp\\demo.ts' }); await settle()
check('走 openResource 且前缀是 dsh-resource://file/session/<sid>/',
  lastResourceAddress().startsWith('dsh-resource://file/session/sess-1/'), lastResourceAddress())
check('反斜杠归一成斜杠', lastResourceAddress().endsWith('E:/tmp/demo.ts'), lastResourceAddress())
check('盘符的 `:` 保持字面量（否则 Host 的 isDriveSegment 认不出来）',
  lastResourceAddress().includes('/E:/tmp/demo.ts'), lastResourceAddress())
const roundTrip = parseFileAddress(lastResourceAddress())
check('地址能被官方式解析回原路径（绝对路径）',
  Boolean(roundTrip) && roundTrip.sessionId === 'sess-1' && roundTrip.path === 'E:/tmp/demo.ts',
  JSON.stringify(roundTrip))

// 真实事故：Agent 调了 {mode:"file", url:"https://example.com"} —— 忘了 path。
// 退到整个工作区文件树最没用；用它本轮最后改过的那个文件兜底才接近它的意图。
opened.length = 0
foldSession([
  toolEvent('write', { path: 'F:/proj/docs/readme.md' }, 'call-w1'),
  toolEvent('sidebar_reveal', { mode: 'file', url: 'https://example.com' }, 'call-no-path'),
])
await settle()
check('缺 path 时用本轮最后一个改动文件兜底',
  lastResourceAddress().includes('readme.md'), JSON.stringify(opened))
check('而不是退到整个工作区文件树', opened.indexOf('openTab:files') < 0, JSON.stringify(opened))

// 一个文件都没改过时，才退到文件树。
callTool('sidebar_reveal', { mode: 'file' }); await settle()
check('既无 path 又无本轮文件 → 退到 files', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))

// 路径里的特殊字符必须逐段编码：Host 用 decodeURIComponent 逆解析，
// 且 parseFileAddress 会用 /[?#]/ 截断——`#` 不编码会把后半段整个丢掉。
callTool('sidebar_reveal', { mode: 'file', path: './docs/a b#c%d.ts' }); await settle()
check('前导 ./ 被去掉、特殊字符逐段编码',
  lastResourceAddress().endsWith('/docs/a%20b%23c%25d.ts'), lastResourceAddress())
check('地址里不残留裸 # （否则会被当成 fragment 截断）',
  lastResourceAddress().indexOf('#') < 0, lastResourceAddress())
const tricky = parseFileAddress(lastResourceAddress())
check('地址能被官方式解析回原路径（含空格 / # / %）',
  Boolean(tricky) && tricky.path === 'docs/a b#c%d.ts', JSON.stringify(tricky))

say('')
say('③ 开关语义（回归：Agent 主动请求不该被别的开关连坐）')
// autoReveal 已从设置里移除；老配置里残留的键不能让主动展示失效（真实事故的回归保护）。
setConfig({ autoReveal: false, revealOnIntent: true })
callTool('sidebar_reveal', { mode: 'files' })
await settle()
check('老配置里 autoReveal=false 时 Agent 仍能展开', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))

setConfig({ autoReveal: true, revealOnIntent: false })
callTool('sidebar_reveal', { mode: 'files' })
await settle()
check('revealOnIntent=false 时不展开', opened.length === 0, JSON.stringify(opened))

setConfig({ autoReveal: true, revealOnIntent: true })
callTool('sidebar_reveal', { mode: 'files' })
await settle()
check('恢复后又能展开', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))

// 已移除的设置项残留在存储里也不该炸
setConfig({ autoReveal: false, delayMs: 320, onlyWhenCollapsed: true, revealUrls: true, revealOnIntent: true })
callTool('sidebar_reveal', { mode: 'files' })
await settle()
check('残留的已移除设置项不影响工作', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))

say('')
say('④ 去重与历史重放')
callTool('sidebar_reveal', { mode: 'files' }, { callId: 'dup-1' }); await settle()
check('第一次处理', opened.indexOf('openTab:files') >= 0, JSON.stringify(opened))
callTool('sidebar_reveal', { mode: 'files' }, { callId: 'dup-1' }); await settle()
check('同一个 callId 不重复展开', opened.length === 0, JSON.stringify(opened))
callTool('sidebar_reveal', { mode: 'files' }, { callId: 'old-1', time: Date.now() - 10 * 60 * 1000 })
await settle()
check('10 分钟前的历史事件不展开', opened.length === 0, JSON.stringify(opened))

say('')
say('⑤ 容错')
callTool('sidebar_reveal', '{ 不是合法 JSON', { asString: false }); await settle()
check('arguments 不是合法 JSON 时不抛错、不展开', opened.length === 0, JSON.stringify(opened))
callTool('sidebar_reveal', { mode: 'nonsense' }); await settle()
check('未知 mode 不展开', opened.length === 0, JSON.stringify(opened))
const withPath = callTool('write', { path: 'E:/tmp/demo.ts' })
check('写文件工具的参数被解析出 path',
  Boolean(withPath && withPath.files && withPath.files.indexOf('E:/tmp/demo.ts') >= 0),
  JSON.stringify(withPath && withPath.files))

say('')
say('⑥ 日志通道')
// 自动探针在测试里被挂起（5000ms 属长延时），这里手动触发一次，
// 验证「没有侧栏浏览器时探针只记一行、不抛错」。
globalThis.window.__dshSidebarEnhance.probe('无 document 环境')
await new Promise((done) => setTimeout(done, 200))
const logText = shipped.map((entry) => entry.body).join('\n')
const logPosts = shipped.filter((entry) => entry.url === '/api/dsh-sidebar-enhance/log')
check('POST 到 /api/dsh-sidebar-enhance/log',
  logPosts.length > 0, JSON.stringify(shipped.map((entry) => entry.url)))
check('日志里有「意图展开」', logText.indexOf('意图展开') >= 0)
check('日志里有「打开 browser」', logText.indexOf('打开 browser') >= 0)
check('日志里有 client 协议版本', logText.indexOf('client 协议 v10') >= 0, logText.slice(0, 200))
check('日志里有「打开文件」', logText.indexOf('打开文件') >= 0)
check('日志里说明了缺 path 的兜底', logText.indexOf('未给 path') >= 0)
check('探针在没有侧栏浏览器时只记一行、不抛错',
  logText.indexOf('浏览器探针') >= 0 && logText.indexOf('没找到侧栏浏览器元素') >= 0,
  logText.slice(-300))

say('')
say('⑦ 侧栏浏览器探针（测「AI 能不能用上侧栏那个浏览器」这件事）')
// 桌面端的侧栏浏览器是真的 Electron <webview>（data-sidebar-browser-frame="webview"）。
// 官方只给了导航 API，所以唯一的问题是：webview 的元素方法在插件所在的渲染进程里
// 能不能调。这里用假元素把探针整条路径跑通——真机上跑出来的结论就照这个格式看。
const fakeFrame = {
  tagName: 'WEBVIEW',
  getAttribute: () => 'lease-abc',
  getURL: () => 'http://localhost:3000/',
  executeJavaScript: () => Promise.resolve(JSON.stringify({ title: 'demo', url: 'http://localhost:3000/', text: 'hello', nodes: 12 })),
  capturePage: () => Promise.resolve({ toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(120) }),
}
globalThis.document = {
  querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [fakeFrame] : []),
}
globalThis.window.__dshSidebarEnhance.probe('单测')
await new Promise((done) => setTimeout(done, 160))
const probeText = shipped.map((entry) => entry.body).join('\n')
check('探针列出了元素与可用方法',
  probeText.indexOf('<webview>') >= 0 && probeText.indexOf('executeJavaScript') >= 0,
  probeText.slice(-300))
check('探针读到了页面 URL', probeText.indexOf('http://localhost:3000/') >= 0)
check('executeJavaScript 往返成功（能读 DOM 的前提）',
  probeText.indexOf('executeJavaScript 往返成功') >= 0, probeText.slice(-300))
check('capturePage 成功（能截图的前提）', probeText.indexOf('capturePage 成功') >= 0)
delete globalThis.document

say('')
say('⑧ 浏览器桥（客户端半侧）')
// 假一个侧栏 <webview>：官方 desktop 实现就是 document.createElement('webview')
// + data-sidebar-browser-frame="webview"。元素方法（executeJavaScript 等）是
// Electron 给 embedder 的能力，dsh 的 API 面里不提供——所以整条链路都是靠它撑的。
let executed = []
function makeFrame(url) {
  return {
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-1',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => url,
    executeJavaScript: (source) => {
      executed.push(source)
      return Promise.resolve(JSON.stringify({ ok: true, url, title: 'demo', text: 'hello', nodes: 42 }))
    },
  }
}
globalThis.document = {
  querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []),
}

const bridge = globalThis.window.__dshSidebarEnhance
check('桥暴露了 handleCommand（测试与手动排查入口）', typeof bridge.handleCommand === 'function')
const health = bridge.health()
check('桥暴露了健康度（通道断没断一眼可见）',
  typeof bridge.health === 'function' && typeof health.lastPollAt === 'number' && typeof health.commands === 'number',
  JSON.stringify(health))

// ① 不需要授权 → 直接执行
const auto = await bridge.handleCommand({ id: 'c1', op: 'read', args: {}, needsConsent: false })
check('read 直接执行并回页面结果',
  auto.ok === true && auto.data && auto.data.url === 'http://localhost:3000/', JSON.stringify(auto))
// 这次事故的回归保护：结果必须装在 data 里。以前它是摊平的（{ok,url,title,…}），
// 宿主读 body.data 读不到 → 退化成 null → 模型收到字符串 "null"，
// 而所有日志都写着「成功」。丢内容这种事，必须有一条断言盯着。
check('结果装在 data 字段里（摊平会退化成 null）',
  auto.data && auto.data.title === 'demo' && auto.data.text === 'hello' && auto.data.nodes === 42,
  JSON.stringify(auto.data))
const resultPosted = () => shipped
  .filter((entry) => entry.url === '/api/dsh-sidebar-enhance/result')
  .map((entry) => entry.body)
  .join('\n')
check('回传给宿主的 payload 带 data', resultPosted().indexOf('"data":{') >= 0, resultPosted().slice(0, 200))
check('注入的脚本带页面工具函数',
  executed.length === 1 && executed[0].indexOf('__wb_out') >= 0 && executed[0].indexOf('__wb_desc') >= 0,
  executed[0] && executed[0].slice(0, 80))

executed = []
await bridge.handleCommand({ id: 'c1b', op: 'find', args: { query: '登录' }, needsConsent: false })
check('find 把 query 拼进脚本', executed[0].indexOf('登录') >= 0, executed[0] && executed[0].slice(-160))

executed = []
await bridge.handleCommand({ id: 'c1c', op: 'act', args: { actions: [{ type: 'click', selector: '#go' }] }, needsConsent: false })
check('act 用 async IIFE（要 await 页面动作）',
  executed[0].indexOf('(async function(){') === 0, executed[0] && executed[0].slice(0, 40))
check('act 把动作数组拼进脚本', executed[0].indexOf('#go') >= 0)

// ② navigate 走官方 openTab
opened.length = 0
const nav = await bridge.handleCommand({ id: 'c2', op: 'navigate', args: { url: 'https://example.com/' }, needsConsent: false })
check('navigate 调用官方 openTab("browser")',
  opened.some((x) => x.indexOf('openTab:browser') === 0), JSON.stringify(opened))
check('navigate 带上 url', opened.some((x) => x.indexOf('example.com') >= 0), JSON.stringify(opened))
check('navigate 回报结果', nav.ok === true, JSON.stringify(nav))

// ②b 原地跳转：webview 已挂载且支持 loadURL 时，不开新 tab，就在原 tab 里导航
// （用户要求：AI 的导航复用同一个浏览器 tab；openTab 只留作 tab 不存在时的兜底）。
executed.length = 0
let liveUrl = 'https://www.bing.com/'
const liveFrame = {
  tagName: 'WEBVIEW',
  getAttribute: () => 'lease-2',
  getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
  getURL: () => liveUrl,
  loadURL: (next) => { liveUrl = next },
  executeJavaScript: (source) => {
    executed.push(source)
    return Promise.resolve(JSON.stringify({ ok: true, url: liveUrl, title: 'demo', text: 'hello', nodes: 42 }))
  },
}
globalThis.document = {
  querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [liveFrame] : []),
}
opened.length = 0
const inPlace = await bridge.handleCommand({ id: 'c2c', op: 'navigate', args: { url: 'https://example.com/page' }, needsConsent: false })
check('已有浏览器 tab 时 loadURL 原地跳转，不再开新 tab',
  inPlace.ok === true && opened.length === 0 && liveUrl === 'https://example.com/page', JSON.stringify(inPlace))
check('原地跳转的回执说明复用了现有 tab',
  inPlace.data && String(inPlace.data.note).indexOf('原地跳转') >= 0, JSON.stringify(inPlace.data))
globalThis.document = { querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []) }
const badNav = await bridge.handleCommand({ id: 'c2b', op: 'navigate', args: { url: 'ftp://x' }, needsConsent: false })
check('非 http(s) 的 url 被拒', badNav.ok === false && badNav.error.includes('http'), JSON.stringify(badNav))

// ②c 点击默认原地：target=_blank 的链接必须被拉回本 tab（改动 B）
// 事故：一次点击冒出 4 个 tab——<a target="_blank"> 在搜索结果页到处都是，
// 而模型没有「别开新窗口」的自觉。默认拉回 _self，要新开必须显式 newTab:true。
executed.length = 0
await bridge.handleCommand({ id: 'c2d', op: 'act', args: { actions: [{ type: 'click', selector: 'a.result' }] }, needsConsent: false })
check('click 默认把 target 拉回 _self（不开新 tab）',
  executed[0].indexOf('setAttribute("target","_self")') >= 0, executed[0] && executed[0].slice(-320))
// ★ v8 真实事故：改成"页内等导航"之后，act 点一下就卡住不返回。
//   页内等待是自毁的——导航一发生，上下文连同返回值一起被销毁，
//   executeJavaScript 的 promise 永远不 settle。等待必须挪到宿主侧去判地址。
check('click 不在页内死等导航（页内等待会把返回值一起销毁）',
  executed[0].indexOf('while(location.href===u0') < 0,
  executed[0] && executed[0].slice(-260))
check('click 仍让出一拍，给不跳转的点击留出返回机会',
  executed[0].indexOf('el.click();await delay(100)') >= 0,
  executed[0] && executed[0].slice(-260))

// ②c-2 ★ 地址变化在 webview 层面可见：点击后地址一变就立刻回执，不等脚本超时。
//   这条是上一条的对偶——证明"不等"换来了"更快更准"，不是把信息丢了。
let navUrl = 'https://from/'
globalThis.document = {
  querySelectorAll: () => [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-nav',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => navUrl,
    executeJavaScript: () => new Promise(() => {}), // 上下文被导航销毁：永挂
  }],
}
bridge.pageScriptTimeout(30000) // 故意留长：快慢必须由地址探测决定，而不是靠超时
const navStart = Date.now()
setTimeout(() => { navUrl = 'https://to/' }, 60) // 模拟点击后地址发生变化
const jumped = await bridge.handleCommand({ id: 'c2nav', op: 'act', args: { actions: [{ type: 'click', selector: 'a' }] }, needsConsent: false })
check('地址一变就立刻回执「点击已跳转」，不等脚本超时',
  jumped.ok === true && Date.now() - navStart < 2000
  && String(jumped.data && jumped.data.note).indexOf('点击已跳转') >= 0,
  JSON.stringify(jumped))
check('回执里带上跳转后的地址，并劝模型别重复点击',
  String(jumped.data && jumped.data.url) === 'https://to/'
  && String(jumped.data && jumped.data.note).indexOf('不要重复点击') >= 0,
  JSON.stringify(jumped.data))
// 恢复成「脚本能正常返回」的假 frame，别把永挂的 frame 留给后面的用例。
globalThis.document = { querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []) }

// ②c-3 ★ 动作失败时，真正的原因藏在 results[i].error 里。
//   必须提到顶层 error：宿主 receipt 只看顶层 !ok 就返回，
//   否则「找不到元素: xxx」被整包丢掉，模型只看到「失败了但没有原因」，无法自我纠正。
globalThis.document = {
  querySelectorAll: () => [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-fail',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => 'https://x/',
    executeJavaScript: () => Promise.resolve(JSON.stringify({
      ok: false,
      url: 'https://x/',
      title: 't',
      results: [{ type: 'click', selector: '#nope', ok: false, error: '找不到元素: #nope' }],
    })),
  }],
}
const actFail = await bridge.handleCommand({ id: 'c2fail', op: 'act', args: { actions: [{ type: 'click', selector: '#nope' }] }, needsConsent: false })
check('动作失败的原因被提到顶层 error（不再只说「失败了但没有原因」）',
  actFail.ok === false && String(actFail.error).indexOf('找不到元素') >= 0, JSON.stringify(actFail))
check('失败明细仍随 data 一起回传，没有整包丢掉',
  Boolean(actFail.data) && Array.isArray(actFail.data.results) && actFail.data.results[0].ok === false,
  JSON.stringify(actFail.data))
globalThis.document = { querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []) }
executed.length = 0
await bridge.handleCommand({ id: 'c2e', op: 'act', args: { actions: [{ type: 'click', selector: 'a.result', newTab: true }] }, needsConsent: false })
check('显式 newTab:true 时不改 target（尊重调用方意图）',
  executed[0].indexOf('keepNew=a.newTab===true') >= 0, executed[0] && executed[0].slice(-200))

// ②d 点击触发跳转会销毁页面上下文 → executeJavaScript 拿不到返回值。
//    这时绝不能报「失败」：模型看到失败会再点一次，又多一个 tab。
globalThis.document = {
  querySelectorAll: () => [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-vanish',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => 'https://x/',
    executeJavaScript: () => Promise.resolve(undefined), // 导航销毁了上下文
  }],
}
const vanished = await bridge.handleCommand({ id: 'c2f', op: 'act', args: { actions: [{ type: 'click', selector: 'a' }] }, needsConsent: false })
check('act 拿不到返回值时说「正在跳转」而不是报错',
  vanished.ok === true && String(vanished.data && vanished.data.note).indexOf('正在跳转') >= 0,
  JSON.stringify(vanished))
check('并明确叫模型别重复点击、改用 read 确认',
  String(vanished.data && vanished.data.note).indexOf('不要重复点击') >= 0
  && String(vanished.data && vanished.data.note).indexOf('browser_read') >= 0,
  JSON.stringify(vanished.data))

// ②e ★ v7 真实事故：点击跳转时 executeJavaScript **永挂**（不是返回空！）
//    ——页面上下文被销毁，回调永远不来，命令链挂死，模型等满宿主 150s。
//    修法是竞速超时；这里把超时调到 60ms 来驱动这条路径。
globalThis.document = {
  querySelectorAll: () => [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-hang',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => 'https://x/',
    executeJavaScript: () => new Promise(() => {}), // 永挂：导航销毁了上下文
  }],
}
bridge.pageScriptTimeout(60)
const hungStart = Date.now()
const hung = await bridge.handleCommand({ id: 'c2g', op: 'act', args: { actions: [{ type: 'click', selector: 'a' }] }, needsConsent: false })
check('脚本永挂时在超时后返回而不是挂死',
  hung.ok === true && Date.now() - hungStart < 5000, JSON.stringify(hung))
check('永挂场景的回执同样说「正在跳转」并劝阻重复点击',
  String(hung.data && hung.data.note).indexOf('正在跳转') >= 0
  && String(hung.data && hung.data.note).indexOf('不要重复点击') >= 0,
  JSON.stringify(hung.data))
// read/find 的永挂不该说「正在跳转」，要报错——模型需要知道读失败了
const hungRead = await bridge.handleCommand({ id: 'c2h', op: 'read', args: {}, needsConsent: false })
check('read 永挂时按失败处理（不能谎报成功）',
  hungRead.ok === false && String(hungRead.error).indexOf('页面脚本') >= 0, JSON.stringify(hungRead))

// read 撞上跳转：地址一变就该立刻说「内容已失效」，别把旧页面的内容当结果返回，
// 也别干等 30s 脚本超时（v8 遗留：地址盯守原本只对 act 生效）。
// 地址盯守要和真实的 30s 脚本超时赛跑才有意义（前面用例把它调到了 60ms）。
bridge.pageScriptTimeout(30000)
const readNavStart = Date.now()
globalThis.document = {
  querySelectorAll: () => [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-read-nav',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => (Date.now() - readNavStart > 80 ? 'https://x/after' : 'https://x/before'),
    executeJavaScript: () => new Promise(() => {}),
  }],
}
const readDuringNav = await bridge.handleCommand({ id: 'c2i', op: 'read', args: {}, needsConsent: false })
check("read 撞上跳转时立刻报「内容已失效」而不是干等超时",
  readDuringNav.ok === false && String(readDuringNav.error).indexOf('正在跳转') >= 0
  && Date.now() - readNavStart < 5000, JSON.stringify(readDuringNav))
check('并指明跳到了哪里、让模型重读一次',
  String(readDuringNav.error).indexOf('https://x/after') >= 0
  && String(readDuringNav.error).indexOf('重新调用') >= 0, JSON.stringify(readDuringNav.error))
bridge.pageScriptTimeout(30000)
globalThis.document = { querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []) }
globalThis.document = { querySelectorAll: (selector) => (selector === '[data-sidebar-browser-frame]' ? [makeFrame('http://localhost:3000/')] : []) }

// ③ 需要授权 → 弹拦截页；拒绝 → 关掉浏览器 tab
opened.length = 0
const waiting = bridge.handleCommand({ id: 'c3', op: 'act', args: { actions: [{ type: 'click', selector: '#go' }] }, needsConsent: true })
await new Promise((done) => setTimeout(done, 10))
const request = bridge.consentState()
check('未授权时弹出拦截页，并带上操作名',
  Boolean(request) && request.op === 'act', JSON.stringify(request))
request.decide('deny')
const denied = await waiting
check('拒绝 → 结果标记 denied', denied.denied === true, JSON.stringify(denied))
check('拒绝 → 关掉那个浏览器 tab',
  opened.indexOf('close:tab-browser-1') >= 0, JSON.stringify(opened))

// ④ 同意「始终允许本会话」 → 执行并把决定上报宿主
const waiting2 = bridge.handleCommand({ id: 'c4', op: 'find', args: { query: 'x' }, needsConsent: true })
await new Promise((done) => setTimeout(done, 10))
bridge.consentState().decide('session')
const allowed = await waiting2
check('同意后照常执行', allowed.ok === true, JSON.stringify(allowed))
await new Promise((done) => setTimeout(done, 40))
const consentPosted = shipped.filter((entry) => entry.url === '/api/dsh-sidebar-enhance/consent').map((entry) => entry.body).join('\n')
check('授权决定上报宿主（带 scope 与 sessionId）',
  consentPosted.indexOf('"scope":"session"') >= 0 && consentPosted.indexOf('sess-1') >= 0, consentPosted)

// ⑤ 没有浏览器 tab 时给可执行的建议
globalThis.document = { querySelectorAll: () => [] }
const noFrame = await bridge.handleCommand({ id: 'c5', op: 'read', args: {}, needsConsent: false })
check('没有浏览器 tab 时提示先 navigate',
  noFrame.ok === false && noFrame.error.includes('browser_navigate'), JSON.stringify(noFrame))

// ⑥ 一次点击冒出多个 tab 的回归保护（改动 C / D）
say('')
say('⑨ 去重：别让同一次操作开出多个 tab')

/** 假一个 webview，地址可指定。 */
function frameAt(url) {
  return [{
    tagName: 'WEBVIEW',
    getAttribute: () => 'lease-dedupe',
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getURL: () => url,
    executeJavaScript: () => Promise.resolve(JSON.stringify({ ok: true, url, title: 't', text: 'x' })),
  }]
}

// D：已经在看这个页面 → 一个 tab 都不开（事故形状：先点击跳到 X，再 reveal(browser, X)）
globalThis.document = { querySelectorAll: () => frameAt('https://x/a') }
let openTabCalls = 0
const realOpenTab = fakeCtx.sidebarRight.openTab
fakeCtx.sidebarRight.openTab = function (kind, options) {
  openTabCalls += 1
  return realOpenTab(kind, options)
}
openTabCalls = 0
callTool('sidebar_reveal', { mode: 'browser', url: 'https://x/a' })
await settle()
check('目标地址已在当前 tab → 不再 openTab',
  openTabCalls === 0, 'openTab 调用 ' + openTabCalls + ' 次 · ' + JSON.stringify(opened))

// T6 回归：不同地址仍要正常开，不能过度去重
openTabCalls = 0
callTool('sidebar_reveal', { mode: 'browser', url: 'https://x/b' })
await settle()
check('不同地址仍然照常打开（别把该跳的也去重掉）',
  openTabCalls === 1, 'openTab 调用 ' + openTabCalls + ' 次 · ' + JSON.stringify(opened))

// C：宿主 openTab「建了 tab 再抛错」时，重试不能再开一个
globalThis.document = { querySelectorAll: () => frameAt('https://x/z') }
openTabCalls = 0
fakeCtx.sidebarRight.openTab = function () {
  openTabCalls += 1
  throw new Error('no session surface is mounted')
}
callTool('sidebar_reveal', { mode: 'browser', url: 'https://x/c' })
await settle()
await settle()
check('openTab 抛错时只调用一次（重试不再重复开 tab）',
  openTabCalls === 1, 'openTab 调用 ' + openTabCalls + ' 次')
fakeCtx.sidebarRight.openTab = realOpenTab
delete globalThis.document

say('')
if (failures.length) {
  say('REVEAL TEST FAILED (' + failures.length + ')')
  for (const failure of failures) say('  - ' + failure)
  process.exit(1)
}
say('REVEAL TEST OK')
