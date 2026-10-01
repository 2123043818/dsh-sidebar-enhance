/**
 * dsh-sidebar-enhance 宿主半侧测试：路由注册 + 真的落盘 + 工具注册。
 *
 * 用假的 ctx / req / res 跑一遍，日志文件写到临时目录（DSH_SIDEBAR_ENHANCE_LOG 覆盖）。
 * 用法：node _backup/host.test.mjs
 */
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..')
// 测试日志写系统临时目录，别把仓库搞脏。
const logPath = join(tmpdir(), 'dsh-sidebar-enhance-host.test.log')
const say = console.log.bind(console)
const failures = []

function check(label, condition, detail) {
  if (condition) say('  ok   ' + label)
  else { say('  FAIL ' + label + (detail === undefined ? '' : '  → ' + detail)); failures.push(label) }
}

try { rmSync(logPath) } catch {}
process.env.DSH_SIDEBAR_ENHANCE_LOG = logPath

const mod = await import(pathToFileURL(join(plugin, 'lib', 'index.js')).href)

say('target =', join(plugin, 'lib', 'index.js'))
say('')
say('① 模块契约')
check('inject 声明了 tools / webServer / systemPrompt',
  Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('webServer') && mod.inject.includes('systemPrompt'),
  JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')

const routes = []
const tools = []
const effects = []
const sections = []
const fakeCtx = {
  tools: { register: (definition) => tools.push(definition) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
  effect: (fn, label) => { effects.push(label); fn() },
}

mod.apply(fakeCtx)

say('')
say('② 注册结果')
check('注册了 5 条路由（日志 + 浏览器桥 4 条）', routes.length === 5, JSON.stringify(routes.map((r) => r.path)))
const paths = routes.map((r) => r.path)
for (const expected of ['/log', '/command', '/result', '/consent', '/state']) {
  check(`有路由 ${expected}`, paths.some((p) => p.endsWith(expected)), JSON.stringify(paths))
}
check('注册了 sidebar_reveal 工具', tools.some((t) => t.name === 'sidebar_reveal'),
  JSON.stringify(tools.map((t) => t.name)))
check('注册了 4 个浏览器工具',
  ['browser_read', 'browser_find', 'browser_act', 'browser_navigate'].every((n) => tools.some((t) => t.name === n)),
  JSON.stringify(tools.map((t) => t.name)))
check('注册了系统提示词段', sections.length === 1 && sections[0].name === 'plugin:dsh-sidebar-enhance',
  JSON.stringify(sections.map((s) => s.name)))
check('提示词段里写了「必须调用」的硬要求',
  sections.length === 1 && sections[0].text.includes('必须') && sections[0].text.includes('sidebar_reveal'),
  sections[0] && sections[0].text.slice(0, 60))
check('提示词段里讲了例外（用户不想看时不调）',
  sections.length === 1 && sections[0].text.includes('例外'))
check('提示词段里讲了浏览器桥与授权等待',
  sections.length === 1 && sections[0].text.includes('browser_navigate') && sections[0].text.includes('授权'),
  sections[0] && sections[0].text.slice(-160))
// ★ 两组工具都能打开网页，语义却是两条路：reveal=摆给用户看（不读），
//   browser_*=自己要用（读回来）。模型混用会「用 reveal 查资料」「用 browser 交付」，
//   所以这段区分必须写进系统提示词，并且被断言锁住。
const guidanceText = sections.length === 1 ? sections[0].text : ''
check('提示词段区分了「展示给用户」与「自己读页面」两条路',
  guidanceText.includes('摆到用户眼前') && guidanceText.includes('不返回页面内容')
  && guidanceText.includes('browser_read'),
  guidanceText.slice(0, 120))
check('提示词段点明了 browser_* 是给 AI 自己用的（查资料/验证/debug）',
  guidanceText.includes('查资料') && (guidanceText.includes('debug') || guidanceText.includes('调试'))
  && guidanceText.includes('前端'),
  guidanceText.slice(0, 120))
const revealTool = tools.find((t) => t.name === 'sidebar_reveal')
check('reveal 的 description 说了它不返回内容、自己读请用 browser_navigate',
  revealTool.description.includes('不返回文件内容或页面内容')
  && revealTool.description.includes('browser_navigate'),
  revealTool.description.slice(-160))
const navTool = tools.find((t) => t.name === 'browser_navigate')
check('browser_navigate 的 description 说了它是「自己要用」、不是交付工具',
  navTool.description.includes('你自己要用这个网页') && navTool.description.includes('不是交付工具')
  && navTool.description.includes('sidebar_reveal'),
  navTool.description.slice(0, 160))
check('工具 parameters 里有 path', Boolean(tools.find((t) => t.name === 'sidebar_reveal').parameters.properties.path))
check('注册了清理 effect', effects.length >= 1, JSON.stringify(effects))

say('')
say('③ 路由真的落盘')

/** 造一个够用的 IncomingMessage。 */
function fakeRequest({ method = 'POST', body = '', address = '127.0.0.1' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress: address }
  req.destroy = () => {}
  setTimeout(() => {
    if (body !== '') req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  }, 0)
  return req
}

function fakeResponse() {
  const res = { status: 0, body: '', headers: null }
  let release = () => {}
  // 以前长轮询会「先返回、后写响应」需要等信号；现在全部同步写响应，
  // settled 保留着以防将来又出现异步路径。
  res.settled = new Promise((resolve) => { release = resolve })
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body; release() }
  return res
}

const route = routes.find((r) => r.path.endsWith('/log'))
const res = fakeResponse()
await route.handler(fakeRequest({ body: '12:00:01.000  [client] 意图展开 turn=7 mode=browser → 打开 browser\n\n12:00:02.000  [client] 第二行' }), res)

check('POST 返回 200', res.status === 200, String(res.status))

let written = ''
try { written = readFileSync(logPath, 'utf8') } catch (error) { written = '(读不到: ' + error.message + ')' }
check('文件里有客户端那行', written.includes('意图展开 turn=7 mode=browser'), JSON.stringify(written.slice(0, 200)))
check('第二行也写进去了', written.includes('第二行'))
check('空行被跳过', !written.includes('\n\n'), JSON.stringify(written))

say('')
say('④ 只允许本机')
const denied = fakeResponse()
await route.handler(fakeRequest({ address: '192.168.1.50' }), denied)
check('非回环来源 403', denied.status === 403, String(denied.status))

say('')
say('⑤ GET 回读')
const readBack = fakeResponse()
await route.handler(fakeRequest({ method: 'GET' }), readBack)
check('GET 200 且含内容', readBack.status === 200 && readBack.body.includes('意图展开'), JSON.stringify(readBack.body.slice(0, 120)))

say('')
say('⑥ sidebar_reveal 的 execute')
const reveal = tools.find((t) => t.name === 'sidebar_reveal')
const receipt = await reveal.execute({ mode: 'browser', url: 'https://www.bilibili.com/' })
check('正常参数返回回执', typeof receipt.text === 'string' && receipt.text.indexOf('已请求展开') === 0, receipt.text)
const rejected = await reveal.execute({ mode: 'browser', url: 'ftp://x' })
check('非法 url 被拒', rejected.text.indexOf('错误') === 0, rejected.text)
const badMode = await reveal.execute({ mode: 'nope' })
check('非法 mode 被拒', badMode.text.indexOf('错误') === 0, badMode.text)
// 回归保护：真实事故里「client 已支持 file、host 还跑旧 bundle」，host 的 mode 清单
// 里没有 file，于是工具报「mode must be one of: changes, files, terminal, browser」。
// 这条断言保证清单里始终有 file——漏了就是漏了，不会再靠人去比对。
check('mode 清单里有 file', badMode.text.includes('file'), badMode.text)
const noPath = await reveal.execute({ mode: 'file' })
check('file 模式缺 path 被拒', noPath.text.indexOf('错误') === 0, noPath.text)
check('缺 path 的报错给出可直接照抄的示例与替代 mode',
  noPath.text.includes('"mode":"file"') && noPath.text.includes('files') && noPath.text.includes('changes'),
  noPath.text)
const withPath = await reveal.execute({ mode: 'file', path: 'E:/tmp/demo.ts' })
check('file 模式带 path 通过', withPath.text.indexOf('已请求展开') === 0 && withPath.text.includes('demo.ts'), withPath.text)
check('file 回执里回显 path', withPath.text.includes('path=E:/tmp/demo.ts'), withPath.text)

const hostLog = readFileSync(logPath, 'utf8')
check('host 侧记下了工具调用', hostLog.includes('[host] tool sidebar_reveal'), JSON.stringify(hostLog.slice(-300)))
// 协议版本 + mode 清单：两半各自的加载时机不同（client 热更、host 只在启动时加载），
// 启动日志里这两行对不上，就是「改了代码没完全重启」。
check('apply 日志带协议版本',
  hostLog.includes('协议 v10'), JSON.stringify(hostLog.slice(0, 200)))
check('apply 日志带完整 mode 清单',
  hostLog.includes('modes=changes,files,file,terminal,browser'), JSON.stringify(hostLog.slice(0, 200)))

// ---------------------------------------------------------------- 浏览器桥

const pollRoute = routes.find((r) => r.path.endsWith('/command'))
const resultRoute = routes.find((r) => r.path.endsWith('/result'))
const consentRoute = routes.find((r) => r.path.endsWith('/consent'))
const stateRoute = routes.find((r) => r.path.endsWith('/state'))

/** 造一个 Agent stub：exec.agent.id 就是 SessionId，授权按它绑。 */
function execAs(sessionId) {
  return { agent: { id: sessionId }, signal: new AbortController().signal }
}

/** 把一次轮询当成客户端：拿到命令就回结果。 */
async function clientRoundTrip({ deny = false, ok = true, data = null } = {}) {
  const polled = fakeResponse()
  await pollRoute.handler(fakeRequest({ method: 'GET' }), polled)
  await polled.settled
  const command = JSON.parse(polled.body || '{}')
  if (command.id === undefined) return { command: null }
  const ack = fakeResponse()
  await resultRoute.handler(fakeRequest({
    body: JSON.stringify({ id: command.id, ok, denied: deny, data, error: ok ? null : 'boom' }),
  }), ack)
  return { command }
}

say('')
say('⑦ 命令通道：工具 → 短轮询 → 结果')
const readTool = tools.find((t) => t.name === 'browser_read')

// 没命令时立即回空对象（不再有挂起的响应）。
const idle = fakeResponse()
await pollRoute.handler(fakeRequest({ method: 'GET' }), idle)
await idle.settled
check('空闲时轮询回空对象', idle.body === '{}', idle.body)

// 未授权：命令必须带 needsConsent，并且工具要一直等到结果回来。
const pendingRead = readTool.execute({ maxChars: 100 }, execAs('sess-A'))
await new Promise((done) => setTimeout(done, 5))
const first = await clientRoundTrip({ ok: true, data: { title: 'demo' } })
check('命令送达客户端', Boolean(first.command) && first.command.op === 'read', JSON.stringify(first.command))
check('未授权时命令带 needsConsent', first.command.needsConsent === true, JSON.stringify(first.command))
check('命令带上 SessionId（授权按会话绑）', first.command.sessionId === 'sess-A', JSON.stringify(first.command))
const readReceipt = await pendingRead
check('工具回执带回落在页面上的数据',
  readReceipt.text.includes('demo'), readReceipt.text)

// 真实事故：客户端把结果**摊平**回传（{id, ok, url, title, text…}，没有 data 字段），
// 宿主读 body.data 得到 undefined → null → 模型收到字符串 "null"，
// 而每一步日志都写着「成功」，排查时极具误导性。两面都要挡住：
//   ① 宿主兜住摊平的 payload，内容不能丢；
//   ② 真没内容时给出可诊断的文案，绝不回一个裸 "null"。
const legacyCall = readTool.execute({}, execAs('sess-A'))
await new Promise((done) => setTimeout(done, 5))
const legacyPoll = fakeResponse()
await pollRoute.handler(fakeRequest({ method: 'GET' }), legacyPoll)
await legacyPoll.settled
const legacyCmd = JSON.parse(legacyPoll.body || '{}')
await resultRoute.handler(fakeRequest({
  body: JSON.stringify({ id: legacyCmd.id, ok: true, url: 'https://x/', title: '摊平的结果', text: '正文' }),
}), fakeResponse())
const legacyReceipt = await legacyCall
check('摊平回传（无 data 字段）时内容仍被捞回来',
  legacyReceipt.text.includes('摊平的结果') && legacyReceipt.text.includes('正文'), legacyReceipt.text)

const emptyCall = readTool.execute({}, execAs('sess-A'))
await new Promise((done) => setTimeout(done, 5))
await clientRoundTrip({ ok: true, data: null })
const emptyReceipt = await emptyCall
check('成功却没内容时不回裸 null，而是给可诊断的文案',
  emptyReceipt.text !== 'null' && emptyReceipt.text.includes('没有拿到内容'), emptyReceipt.text)

say('')
say('⑧ 授权：按会话、按范围')
const consentAck = fakeResponse()
await consentRoute.handler(fakeRequest({
  body: JSON.stringify({ id: first.command.id, scope: 'session', sessionId: 'sess-A' }),
}), consentAck)
check('授权回执带会话与摘要',
  consentAck.status === 200 && consentAck.body.includes('sess-A'), consentAck.body)

const secondRead = readTool.execute({}, execAs('sess-A'))
await new Promise((done) => setTimeout(done, 5))
const second = await clientRoundTrip({ ok: true, data: { title: 'again' } })
check('同一会话内「始终允许」之后不再要求授权',
  second.command.needsConsent === false, JSON.stringify(second.command))
await secondRead

const otherSession = readTool.execute({}, execAs('sess-B'))
await new Promise((done) => setTimeout(done, 5))
const third = await clientRoundTrip({ ok: true, data: {} })
check('另一个会话不受影响，仍然要授权',
  third.command.needsConsent === true, JSON.stringify(third.command))
await otherSession

// 全局策略：/state 报上来的 browserPolicy=allow 应当完全不问。
const stateAck = fakeResponse()
await stateRoute.handler(fakeRequest({
  body: JSON.stringify({ sessionId: 'sess-C', turn: 3, config: { browserPolicy: 'allow' } }),
}), stateAck)
check('/state 接受客户端状态', stateAck.status === 200, stateAck.body)

const autoRead = readTool.execute({}, execAs('sess-C'))
await new Promise((done) => setTimeout(done, 5))
const fourth = await clientRoundTrip({ ok: true, data: {} })
check('browserPolicy=allow 时完全不问', fourth.command.needsConsent === false, JSON.stringify(fourth.command))
await autoRead

say('')
say('⑨ 拒绝与超时')
const deniedTool = tools.find((t) => t.name === 'browser_navigate')
const pendingNav = deniedTool.execute({ url: 'https://example.com' }, execAs('sess-D'))
await new Promise((done) => setTimeout(done, 5))
await clientRoundTrip({ deny: true })
const deniedReceipt = await pendingNav
check('拒绝时回执说明被拒且不要重试',
  deniedReceipt.text.includes('拒绝') && deniedReceipt.text.includes('不要'), deniedReceipt.text)

const failRead = readTool.execute({}, execAs('sess-E'))
await new Promise((done) => setTimeout(done, 5))
await clientRoundTrip({ ok: false })
const failReceipt = await failRead
check('失败时回执带错误原文', failReceipt.text.includes('boom'), failReceipt.text)

check('非回环来源访问 /command 被拒', (await (async () => {
  const denied = fakeResponse()
  await pollRoute.handler(fakeRequest({ method: 'GET', address: '10.0.0.9' }), denied)
  return denied.status
})()) === 403)

say('')
if (failures.length) {
  say('HOST TEST FAILED (' + failures.length + ')')
  for (const failure of failures) say('  - ' + failure)
  process.exit(1)
}
say('HOST TEST OK')
say('日志文件：' + logPath)
