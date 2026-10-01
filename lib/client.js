/**
 * dsh-sidebar-enhance —— 浏览器半侧。
 *
 * 目标：AI 完成一轮（turn）后，自动展开 dsh 自带的右侧栏，把这一轮的
 * 成果顺手放到眼前；同时把桌面右上角侧栏菜单的三个选项做成一个常驻面板。
 *
 * 只做两件事，都不碰模型：
 * 1. 折会话事件流 —— 用自己的 Conversation Event fold（kind: sidebar-enhance）
 *    在每个 Turn 的位置上记下三类产出：
 *      - changes：本轮 workspace/changes 事件的 seq（打开 changes-review 的坐标）
 *      - files：write / edit / str_replace_editor / apply_patch 与 present 写出的路径
 *      - urls：任意 tool 参数里出现的 http(s) 链接
 * 2. 驱动自带侧栏 —— 用 ctx.sidebarRight.openResource / openTab 把自带 tab 打开：
 *      - changes-review（本轮 diff，由 ui-deliverables 注册）
 *      - files / terminal / browser（dsh 三个自带 tab）
 *    右侧栏轨道由 ctx.layout.openRightbar 报告。
 *
 * 不新建侧栏，不复制任何侧栏 UI。changes-review 未注册（ui-deliverables
 * 被禁用）时自动回退到 files，不抛错。
 *
 * 手工维护的 __ModuleLoader__.load bundle，不含 JSX；改完 `node --check` 过一遍。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-enhance',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    // react-dom 是平台种子词（seed.ts 里就有），用来把面板 portal 到 body，
    // 避免它被 composer 所在的列裁剪。
    var ReactDOM = require('react-dom')

    // ============================================================
    // 常量
    // ============================================================

    var ENTRY_ID = 'sidebar-enhance'
    var NS = 'sidebar-enhance'
    var FOLD_KEY = 'sidebar-enhance'
    var STORE_KEY = 'dsh.sidebar-enhance.v1'
    var STYLE_ID = 'dsh-sidebar-enhance-style'
    var BRIDGE = '__dshSidebarEnhance'

    // 文案函数：apply 时由 locale service 绑定后写入。
    // slots 若按 register 的 locale 字段注入 props.t 就用注入的，否则回退到它，
    // 再兜底成返回 key 本身——任何情况下都不让渲染抛错。
    var LOCALE_T = null

    function fallbackT(key) {
      return key
    }

    function translator(props) {
      var t = props && props.t
      if (typeof t === 'function') return t
      return typeof LOCALE_T === 'function' ? LOCALE_T : fallbackT
    }

    var KIND_FILES = 'files'
    var KIND_FILE = 'file'
    var KIND_TERMINAL = 'terminal'
    var KIND_BROWSER = 'browser'
    var KIND_CHANGES = 'changes'
    // 资源地址前缀。changes-review 由 ui-deliverables 注册；
    // file 由 sidebar 的文件预览注册，地址里带授权 session 与路径
    // （官方约定：dsh-resource://file/session/<sessionId>/<path>）。
    var REVIEW_PREFIX = 'dsh-resource://changes-review/session/'
    // 官方 grammar：dsh-resource://file/session/<sessionId>/<path>
    // （@deepseek-ai/dsh-util-workspace-path 的 FILE_ADDRESS_PREFIX + 'session/'）
    var FILE_PREFIX = 'dsh-resource://file/'

    var MODES = [KIND_CHANGES, 'auto', KIND_FILES, KIND_FILE, KIND_TERMINAL, KIND_BROWSER]

    // 宿主半侧与浏览器半侧的**协议版本**。两半的加载时机不同：client 会随页面
    // 刷新热更，host 只在桌面端进程启动时加载一次。所以「改了 lib/index.js 但没
    // 完全重启」= 旧的 host 照着旧的 mode 表校验，新的 client 已经支持新 mode——
    // 表现为工具报一个 mode 清单里没有新项的错，而客户端一切正常（本次事故）。
    // 两边启动时各打一行，对不上就是没重启。
    var PROTOCOL = 10

    // 手动入口（徽章 / dock 按钮）只能选不需要额外参数的 mode——
    // 'file' 要 path，面板给不了，只在 Agent 主动调用时用。
    var MANUAL_MODES = MODES.filter(function (mode) {
      return mode !== KIND_FILE
    })

    var DEFAULTS = {
      revealOnIntent: true,   // Agent 主动调 sidebar_reveal 时展开
      mode: 'auto',           // 手动入口（徽章/dock 按钮）默认打开什么
      urlList: '',            // 每行一个 URL，browser 模式没有给 url 时用
      showBadge: true,        // 轮次尾部显示产出徽章
      // AI 使用侧栏浏览器的权限：ask = 每次弹授权（默认）；allow = 始终允许、不再询问。
      browserPolicy: 'ask'
    }

    // 会写文件的工具；用于汇总本轮产物路径（present 单独由事件处理）。
    var FILE_TOOLS = {
      write: true,
      edit: true,
      apply_patch: true,
      str_replace_editor: true,
      'multi_tool_use.parallel': true
    }

    // 最多展示/携带的条目数，避免一轮里刷屏。
    var MAX_FILES = 12
    var MAX_URLS = 6

    // 只认「刚发生」的 Agent 意图：fold 挂载时会把历史事件重放一遍，
    // 那些旧 intent 不该在启动时替你弹侧栏。event.time 是 Unix 毫秒。
    var INTENT_MAX_AGE_MS = 30000

    // 已经处理过的 tool call id，防止 fold 重算导致同一个调用被展开多次。
    var seenCalls = new Set()

    // ============================================================
    // 配置存储（localStorage + 订阅）
    // ============================================================

    /**
     * 旧存储键（插件从 dsh-workbuddy 改名而来）。
     * 改名会让存储键跟着变——**不做迁移的话用户已经配好的设置会静默回到默认值**。
     * 这里读一次旧键并搬到新键，之后就只认新键。
     */
    var LEGACY_STORE_KEYS = ['dsh.workbuddy.v1']

    function readConfig() {
      try {
        var raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) {
          for (var i = 0; i < LEGACY_STORE_KEYS.length; i += 1) {
            var legacy = window.localStorage.getItem(LEGACY_STORE_KEYS[i])
            if (!legacy) continue
            try {
              var old = JSON.parse(legacy)
              if (old && typeof old === 'object') {
                // 搬过去并落盘，下次直接读新键。
                window.localStorage.setItem(STORE_KEY, legacy)
                window.localStorage.removeItem(LEGACY_STORE_KEYS[i])
                dseLog('已从旧存储键迁移设置: ' + LEGACY_STORE_KEYS[i])
                return Object.assign({}, DEFAULTS, old)
              }
            } catch (error) {
              // 旧值坏了就当没有。
            }
          }
          return Object.assign({}, DEFAULTS)
        }
        var parsed = JSON.parse(raw)
        return Object.assign({}, DEFAULTS, typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch (error) {
        return Object.assign({}, DEFAULTS)
      }
    }

    var listeners = new Set()
    var config = readConfig()

    function getConfig() {
      return config
    }

    function writeConfig(patch) {
      var next = Object.assign({}, config, patch)
      config = next
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch (error) {
        // 存储不可用时仍保留内存态，界面不崩。
      }
      publish(next)
      // 宿主也要知道策略（授权判定在宿主侧），改完立刻上报。
      reportState()
    }

    function publish(next) {
      listeners.forEach(function (listener) {
        try {
          listener(next)
        } catch (error) {
          // 单个订阅者失败不影响其它。
        }
      })
    }

    function onChange(listener) {
      listeners.add(listener)
      return function () {
        listeners.delete(listener)
      }
    }

    function useConfig() {
      var state = React.useState(function () {
        return getConfig()
      })
      var cfg = state[0]
      var setCfg = state[1]
      React.useEffect(function () {
        return onChange(setCfg)
      }, [])
      return cfg
    }

    // ============================================================
    // 事件折：每个 Turn 的产出
    // ============================================================

    function firstHttp(text) {
      // 不锚定开头：URL 通常嵌在长字符串或路径描述中间。
      var match = /https?:\/\/[^\s"'<>()\[\]]+/i.exec(text)
      if (!match) return null
      return match[0].replace(/[.,;:)\]]+$/, '')
    }

    function scanUrls(value, out, depth) {
      if (out.length >= MAX_URLS || depth > 4) return
      if (typeof value === 'string') {
        var url = firstHttp(value)
        if (url && out.indexOf(url) < 0) out.push(url)
        return
      }
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) scanUrls(value[i], out, depth + 1)
        return
      }
      if (value && typeof value === 'object') {
        var keys = Object.keys(value)
        for (var k = 0; k < keys.length; k++) scanUrls(value[keys[k]], out, depth + 1)
      }
    }

    function pushOnce(list, value, max) {
      if (typeof value !== 'string' || !value) return list
      if (list.indexOf(value) >= 0) return list
      var next = list.concat([value])
      return next.length > max ? next.slice(-max) : next
    }

    function collectUrls(state, source) {
      var found = []
      scanUrls(source, found, 0)
      var current = state
      found.forEach(function (url) {
        current = Object.assign({}, current, { urls: pushOnce(current.urls, url, MAX_URLS) })
      })
      return current
    }

    /**
     * 解析 `tool/call` 事件的参数。
     *
     * ★ session 事件类型里写得很明确：
     *   'tool/call': { turn, step, callId, name, arguments: string }
     *   —— `arguments` 是**模型产出的原始 JSON 字符串，未解析**。
     * 所以 `typeof data.arguments === 'object'` 永远是 false，
     * 直接按对象用会把每一次 tool/call 都静默丢掉（上一版就是这样，
     * 导致「过程中展开」从来没触发过，写文件工具的路径也一个都没采到）。
     *
     * 这里同时容忍已解析的对象形态，两边都不吃亏。
     * @param raw - match.event.data.arguments
     * @returns 解析后的对象，或 null
     */
    function parseToolArguments(raw) {
      if (raw === null || raw === undefined || raw === '') return null
      if (typeof raw === 'object') return raw
      if (typeof raw !== 'string') return null
      try {
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        dseLog('tool 参数不是合法 JSON: ' + raw.slice(0, 160))
        return null
      }
    }

    function pathsOf(toolName, rawArgs) {
      var out = []
      var args = parseToolArguments(rawArgs)
      if (!args) return out
      var direct = args.path || args.file_path || args.target_file
      if (typeof direct === 'string') out.push(direct)
      if (Array.isArray(args.files)) {
        args.files.forEach(function (file) {
          if (file && typeof file.path === 'string') out.push(file.path)
        })
      }
      // multi_tool_use.parallel 的参数是工具数组（内层 arguments 同样是字符串）。
      var inner = args.tools
      if (Array.isArray(inner)) {
        inner.forEach(function (call) {
          if (call && FILE_TOOLS[call.name] === true) {
            pathsOf(call.name, call.arguments).forEach(function (path) {
              if (out.indexOf(path) < 0) out.push(path)
            })
          }
        })
      }
      return out
    }

    /**
     * Conversation Event fold：turn/start 开始一个 Turn 的桶，
     * workspace/changes、present 与各写文件工具往里累加。
     * buildLocationData 把桶写到 Turn 位置，供 turnTail 读取。
     */
    var sidebarDefinition = {
      kind: FOLD_KEY,
      match: function (event) {
        var data = event && event.data
        if (!data || typeof data.turn !== 'number') return null
        var id = String(data.turn)
        if (event.type === 'turn/start') return { id: id, role: 'start' }
        if (event.type === 'workspace/changes') return { id: id, role: 'update' }
        if (event.type === 'deliverables/presented') return { id: id, role: 'update' }
        if (event.type === 'tool/call') return { id: id, role: 'update' }
        // assistant 正文里的链接（回复里贴的、让我打开的）
        if (event.type === 'assistant/message') return { id: id, role: 'update' }
        return null
      },
      start: function (_context, match) {
        return {
          turn: match.event.data.turn,
          changes: null,
          files: [],
          urls: [],
          intent: null
        }
      },
      update: function (context, match) {
        var state = context.state
        var type = match.event.type
        var data = match.event.data

        if (type === 'workspace/changes') {
          return Object.assign({}, state, { changes: { seq: match.event.seq, turn: data.turn } })
        }

        if (type === 'deliverables/presented') {
          var next = state
          if (Array.isArray(data.files)) {
            data.files.forEach(function (file) {
              if (file && typeof file.path === 'string') next = Object.assign({}, next, { files: pushOnce(next.files, file.path, MAX_FILES) })
            })
          }
          return next
        }

        // 回复正文里的链接：扫 durable 消息的 content blocks（不扫 live-chunk，避免流式刷屏）。
        if (type === 'assistant/message') {
          return collectUrls(state, data.message && data.message.content)
        }

        if (type !== 'tool/call') return state

        // ★ data.name 是工具名；data.arguments 是**未解析的 JSON 字符串**（见
        // parseToolArguments 的说明），一律先解析再当对象用。
        var named = data.name
        var args = parseToolArguments(data.arguments)

        // Agent 主动指定的展示意图：host 侧 sidebar_reveal 工具不做任何事，
        // 意图靠这条 tool/call 事件传下来。后调用覆盖先调用，以最后一次为准。
        if (named === 'sidebar_reveal') {
          var callId = data.callId === undefined || data.callId === null ? null : String(data.callId)

          // ① 同一个 tool call 只认一次：fold 会为同一个事件被重算若干次
          //    （前台/后台会话、store 更新都会重跑），日志里能看到 2–4 条重复。
          //    去重放在日志之前——否则每重算一次就多刷一行，真正的信号被埋掉。
          if (callId !== null) {
            if (seenCalls.has(callId)) return state
            if (seenCalls.size > 400) seenCalls.clear()
            seenCalls.add(callId)
          }

          var age = typeof match.event.time === 'number' ? Date.now() - match.event.time : 0
          // 这条和 host 侧的 `[host] tool sidebar_reveal: …` 配对使用：
          // 只有 host 那条 = fold 根本没拿到这个事件；两条都有 = 事件到了。
          dseLog('fold 收到 sidebar_reveal, callId=' + describe(callId) + ' age=' + age + 'ms arguments=' + describe(data.arguments).slice(0, 160))

          if (!args) return state
          var mode = typeof args.mode === 'string' ? args.mode : ''
          var intentMode = mode === 'changes' || mode === 'files' || mode === 'file' || mode === 'terminal' || mode === 'browser' ? mode : null
          if (!intentMode) {
            dseLog('sidebar_reveal 的 mode 不认识: ' + describe(mode))
            return state
          }
          var newState = Object.assign({}, state, {
            intent: {
              mode: intentMode,
              url: typeof args.url === 'string' && args.url ? args.url : null,
              path: typeof args.path === 'string' && args.path ? args.path : null,
              index: typeof args.index === 'number' && args.index >= 0 ? Math.floor(args.index) : 0
            }
          })

          // ② 挂载时会把该会话的历史事件从头重放一遍（日志里那批旧 URL 就是这么来的），
          //    那些 intent 已经过时，不该在启动时替你弹一次侧栏。
          //    event.time 是 Unix 毫秒，客户端与宿主同机同时钟，直接比年龄即可。
          if (age <= INTENT_MAX_AGE_MS) {
            // 立即展开侧栏，不等 turn 收尾——SidebarTail 在生成期间根本没挂载。
            //
            // 这里可以直接调用 sidebarRight：openTab / openResource 是命令式的
            // store 动作（openContent 的第一步就是 planSetExpanded(state, true)），
            // 不依赖 React 渲染周期，也不需要先 setState 或 flushSync。
            //
            // 注意 turn 取 state.turn（start 时记下的），不要用 event.turn——
            // update 的签名是 (context, match)，作用域里没有 event 这个名字。
            // fold 里抛异常会打断事件分发（本项目最早的崩法就是这个），
            // 所以 state 取不到时降级成 null turn，而不是直接读属性炸掉。
            requestReveal(newState, state ? state.turn : null, 'intent')
          } else {
            dseLog('意图展开跳过：历史事件 age=' + age + 'ms')
          }

          return newState
        }

        // 写文件类工具：从参数里收路径（同样要先解析）。
        var current = state
        if (FILE_TOOLS[named] === true && args) {
          pathsOf(named, args).forEach(function (path) {
            current = Object.assign({}, current, { files: pushOnce(current.files, path, MAX_FILES) })
          })
        }
        return args ? collectUrls(current, args) : current
      },
      buildLocationData: function (context, scope, previous) {
        if (scope !== 'turn' || !context.state) return null
        var state = context.state
        var same = previous &&
          previous.kind === 'turn' &&
          previous.turn === state.turn &&
          previous.key === FOLD_KEY &&
          previous.value.files === state.files &&
          previous.value.urls === state.urls &&
          previous.value.changes === state.changes &&
          previous.value.intent === state.intent
        if (same) return previous
        return {
          kind: 'turn',
          turn: state.turn,
          key: FOLD_KEY,
          value: {
            files: state.files,
            urls: state.urls,
            changes: state.changes,
            intent: state.intent
          }
        }
      }
    }

    function splitUrls(list) {
      // 兼容历史桶里的 join 字符串与现在的数组两种形状。
      if (!list) return []
      var values = Array.isArray(list) ? list : String(list).split('\u0001')
      return values
        .filter(function (value) {
          return typeof value === 'string' && value.length > 0
        })
        .slice(0, MAX_URLS)
    }

    // ============================================================
    // 侧栏驱动
    // ============================================================

    function reviewAddress(sessionId, seq, turn) {
      return REVIEW_PREFIX + encodeURIComponent(sessionId) + '/' + seq + '/' + turn
    }

    /**
     * 打开某个真实文件的资源地址。
     *
     * 官方约定（sidebar-right 文档）：`session/<sessionId>/<path>` 地址里，
     * path 可以是相对工作区的，也可以是绝对路径——开头的斜杠会被保留，
     * 例如 `dsh-resource://file/session/s//etc/hosts`。
     * 所以这里只把 Windows 反斜杠换成斜杠，其余原样拼。
     */
    /**
     * 逐段编码，照抄官方 `encodeSegment`：`:` 保持字面量（Windows 盘符要能被
     * `isDriveSegment` 认出来），其余走 encodeURIComponent。
     *
     * 为什么必须逐段编码（而不是整串 replace）：Host 侧用 `parseFileAddress` 解析，
     * 而它是 `segments.map(decodeURIComponent).join('/')`。
     * 路径里出现 `%` 会因为 decodeURIComponent 抛 URIError 而让整个地址变成
     * 「unsupported address」；出现 `#` / `?` 更糟——parseFileAddress 用
     * `address.search(/[?#]/)` 截断，后半段会被直接丢掉。
     */
    function encodeSegment(segment) {
      try {
        return encodeURIComponent(segment).replace(/%3A/gi, ':')
      } catch (error) {
        // 落单的代理项等非法码点。
        return segment.replace(/[\\/]/g, '_')
      }
    }

    function encodePath(path) {
      return path.split('/').map(encodeSegment).join('/')
    }

    /** 构造 `dsh-resource://file/session/<sessionId>/<path>`（对齐官方 fileAddressFor）。 */
    function fileAddress(sessionId, path) {
      var normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return FILE_PREFIX + 'session/' + encodeSegment(String(sessionId)) + '/' + encodePath(normalized)
    }

    /**
     * file 模式要打开的路径。
     *
     * Agent 忘了给 path 时（实测发生过：它传了 mode=file 却带了个不相干的 url），
     * 用**本轮最后一个改过的文件**兜底——那通常正是它想展示的东西；
     * 退到整个工作区文件树反而是最没用的结果。
     */
    function intentPathOf(intent, data) {
      if (intent && intent.path) return intent.path
      var files = data && data.files
      if (Array.isArray(files) && files.length) return files[files.length - 1]
      return null
    }

    function resolveKind(mode, data, config) {
      var intent = data && data.intent
      // Agent 通过 sidebar_reveal 显式指定的意图优先于任何用户配置。
      // 有前置条件不满足的自动回退：changes 没改动 → files；file 没路径也没本轮文件 → files。
      if (intent && intent.mode) {
        if (intent.mode === KIND_CHANGES && !data.changes) return KIND_FILES
        if (intent.mode === KIND_FILE && !intentPathOf(intent, data)) return KIND_FILES
        if (MODES.indexOf(intent.mode) >= 0) return intent.mode
      }
      if (mode === 'auto') {
        if (data && data.changes) return KIND_CHANGES
        return KIND_FILES
      }
      if (mode === KIND_FILE) return KIND_FILES // 手动入口没有路径可给
      if (MODES.indexOf(mode) >= 0 && mode !== 'auto') return mode
      return KIND_FILES
    }

    function sidebarOf() {
      var bridge = window[BRIDGE]
      return bridge ? bridge.sidebar : null
    }

    function layoutOf() {
      var bridge = window[BRIDGE]
      return bridge ? bridge.layout : null
    }

    function isExpanded() {
      var sidebar = sidebarOf()
      if (!sidebar || typeof sidebar.isExpanded !== 'function') return false
      try {
        return Boolean(sidebar.isExpanded())
      } catch (error) {
        return false
      }
    }

    /**
     * 报告右栏轨道占用。
     *
     * 侧栏席位自己会在 effect 里调 `ctx.layout.openRightbar(...)`，这里再报一次
     * 只是冗余的保险：openTab / openResource 只改侧栏 store，而列宽由席位上报，
     * 中间有一帧空档，先报一次能少闪一下。layout 缺席或接口变了都只是少层保险，
     * 不影响开 tab 本身。
     */
    function reportTrack() {
      var layout = layoutOf()
      if (!layout || typeof layout.openRightbar !== 'function') return
      try {
        layout.openRightbar(true, false)
      } catch (error) {
        // 布局未就绪时忽略。
      }
    }

    function ensureExpanded(sidebar) {
      if (!sidebar || typeof sidebar.isExpanded !== 'function') return
      try {
        if (!sidebar.isExpanded() && typeof sidebar.toggleExpanded === 'function') sidebar.toggleExpanded()
      } catch (error) {
        // 展开失败不影响已打开的 tab。
      }
    }

    /**
     * 打开一个 tab。kind 为 'changes' 时走 changes-review 资源地址；
     * 该 tab 类型未注册时回退到 files，保证动作永远落得下去。
     * @param target {sessionId, turn, data, config, kind?, params?}
     * @returns 实际打开的 kind
     */
    function applyReveal(target) {
      var sidebar = sidebarOf()
      if (!sidebar) return null

      var config = target.config || DEFAULTS
      var data = target.data || { changes: null, files: [], urls: [] }
      var kind = target.kind || resolveKind(config.mode, data, config)

      // 先报轨道。openContent 会把 store 的 expanded 置为 true，席位据此上报列宽，
      // 但那是下一帧的事；这里先报一次让会话区不用等。
      reportTrack()

      if (kind === KIND_CHANGES) {
        var seq = data.changes && data.changes.seq
        var index = data.intent && typeof data.intent.index === 'number' ? data.intent.index : 0
        if (target.sessionId && seq != null && target.turn != null) {
          try {
            sidebar.openResource(reviewAddress(target.sessionId, seq, target.turn), {
              params: { index: index }
            })
            return KIND_CHANGES
          } catch (error) {
            // changes-review 未注册，回退到工作区文件。
          }
        }
        kind = KIND_FILES
      }

      if (kind === KIND_FILE) {
        // 打开一个真实文件。比 changes（本轮的 diff 摘要）更持久：
        // 文件在磁盘上，Host 随时能解析；而 diff 摘要在 DSH 重启后就没了。
        var explicit = data.intent && data.intent.path
        var filePath = intentPathOf(data.intent, data)
        if (target.sessionId && filePath) {
          var address = fileAddress(target.sessionId, filePath)
          try {
            sidebar.openResource(address)
            ensureExpanded(sidebar)
            if (explicit) {
              dseLog('打开文件 ' + describe(filePath))
            } else {
              dseLog('file 模式未给 path，改用本轮最后一个改动文件: ' + describe(filePath))
            }
            return KIND_FILE
          } catch (error) {
            dseLog('打开文件失败（回退 files）: ' + describe(filePath)
              + ' · address=' + describe(address)
              + ' · ' + (error && error.message ? error.message : error))
          }
        } else {
          dseLog('file 模式既没有 path、本轮也没有改动文件，回退 files')
        }
        kind = KIND_FILES
      }

      if (kind === KIND_BROWSER && typeof window.setTimeout === 'function') {
        // 浏览器 tab 挂载后探一次：这是最可能拿到侧栏 <webview> 元素的时机。
        window.setTimeout(function () {
          probeBrowserFrame('打开浏览器 tab 之后')
        }, 1500)
      }

      var wantedUrl = target.params && target.params.url ? String(target.params.url) : null
      // 记账只在**一次 requestReveal 的重试循环内**生效（target.ledger 由调用方建），
      // 不做全局跨调用去重：不同轮次、不同意图本来就该各开一次。
      var ledger = target.ledger || null

      // 改动 D：已经在看这个页面了就别再开一个 tab。
      // 事故形状正是「先 act 点击跳到 X，再 reveal(browser, X)」——两回都开了。
      if (kind === KIND_BROWSER && wantedUrl) {
        var currentUrl = currentFrameUrl()
        if (currentUrl && samePage(currentUrl, wantedUrl)) {
          ensureExpanded(sidebar)
          dseLog('浏览器 tab 已是目标地址，跳过 openTab：' + describe(currentUrl))
          if (ledger) ledger.kind = kind, ledger.url = wantedUrl
          return kind
        }
      }

      // 改动 C：本次重试循环里已经对宿主发起过一次同类展开 → 不再重复 openTab。
      // 宿主存在「建了 tab 再抛错」的可能，那时返回 null 会让 requestReveal 重试，
      // 每重试一次就多一个 tab（截图里 3 个同页 tab 就是这么来的）。
      if (ledger && ledger.kind === kind && ledger.url === wantedUrl) {
        ensureExpanded(sidebar)
        dseLog('重复展开已去重：本轮已发起过 ' + describe(kind) + '，不再重复 openTab')
        return kind
      }

      var opened = false
      try {
        if (target.params) sidebar.openTab(kind, { params: target.params })
        else sidebar.openTab(kind)
        opened = true
      } catch (error) {
        // 该 kind 未注册（插件被禁用），或还没有屏幕上的 session surface
        // （sidebarRight.require() 会以 "no session surface is mounted" 抛错）。
        // ★ 无论是否抛错都记成「已发起」：副作用可能已经落到宿主那边了，
        //   再重试只会再开一个 tab。
        dseLog('openTab("' + kind + '") 失败：' + (error && error.message ? error.message : error))
      }
      // 已发起过就不让上层重试了：正确动作是「复查 + 补展开」，不是「再调一次 openTab」。
      if (ledger) ledger.kind = kind, ledger.url = wantedUrl
      if (!opened) {
        ensureExpanded(sidebar)
        return kind
      }
      ensureExpanded(sidebar)
      dseLog('意图展开 ' + describe(kind) + (wantedUrl ? ' → ' + describe(wantedUrl) : '')
        + '（当前浏览器元素 ' + findBrowserFrames().length + ' 个）')
      return kind
    }

    /** 当前浏览器 tab 的地址（拿不到就 null）。 */
    function currentFrameUrl() {
      var frame = pickBrowserFrame()
      if (!frame || typeof frame.getURL !== 'function') return null
      try {
        var url = frame.getURL()
        return url ? String(url) : null
      } catch (error) {
        return null
      }
    }

    /**
     * 两个地址算不算「同一个页面」。**只做严格相等和忽略 hash**，
     * 不做「同域即同页」——那会把不同文档误判成同一个，反过来导致该跳的不跳。
     */
    function samePage(a, b) {
      var left = String(a || '')
      var right = String(b || '')
      if (left === right) return true
      var strip = function (value) {
        var hash = value.indexOf('#')
        return hash >= 0 ? value.slice(0, hash) : value
      }
      var l = strip(left)
      var r = strip(right)
      return l.length > 0 && l === r
    }

    /**
     * Agent 主动要求展示：fold 收到 `sidebar_reveal` 的 tool/call 时立刻走，
     * 不等 turn 收尾（SidebarTail 在生成期间根本没挂载，收尾那条路到不了）。
     *
     * `sidebarRight.openTab/openResource` 需要「屏幕上已 adopted 的 session」，
     * 会话刚建好或刚切换时这个前置条件可能还没满足，因此带一次有限重试
     * （而不是上一版那种常驻 setInterval 轮询）。
     *
     * @param data - fold 折叠出的本轮状态（含 intent）
     * @param turn - 当前 turn 号
     * @param source - 诊断用来源标记
     */
    function requestReveal(data, turn, source) {
      var attempts = 0
      var MAX_ATTEMPTS = 12
      var RETRY_MS = 150
      // 本次调用内「已经对宿主发起过哪次 openTab」的记账。
      // 只活在这 12 次重试里：openTab 的副作用一旦发出去，重试就该「复查」而不是「再开」。
      var ledger = { kind: null, url: null }

      function step() {
        var bridge = window[BRIDGE]
        if (!bridge || !bridge.sidebar || typeof bridge.currentSessionId !== 'function') {
          attempts += 1
          if (attempts < MAX_ATTEMPTS) {
            setTimeout(step, RETRY_MS)
            return
          }
          dseLog('意图展开放弃：sidebarRight 尚未就绪')
          return
        }

        var config = getConfig()
        // Agent 的主动请求走 revealOnIntent —— 它和 autoReveal（每轮结束后自动展开）
        // 是两件事。早先这里错误地拿 autoReveal 把关，用户一关掉自动展开，
        // Agent 就再也弹不出侧栏了（日志里的「意图展开跳过：autoReveal 已关闭」）。
        if (!config.revealOnIntent) {
          dseLog('意图展开跳过：revealOnIntent 已关闭')
          return
        }

        var sessionId = bridge.currentSessionId()
        var applied = null
        if (sessionId) {
          // 必须走 openPanel 而不是直接 applyReveal：openPanel 负责把
          // intent.url / 本轮扫到的链接 / 配置里的默认网址 折算成 browser tab 的
          // params。绕过它的话 mode=browser 会开出一个**空地址栏**的浏览器 tab。
          applied = openPanel({
            sessionId: sessionId,
            turn: turn,
            data: data,
            config: config,
            source: source,
            ledger: ledger
          })
        }

        if (applied !== null) {
          // 记过账，收尾的自动展开不再对同一轮重复开 tab。
          if (sessionId && turn !== undefined && turn !== null) remember(sessionId + ':' + turn)
          dseLog('意图展开 turn=' + describe(turn) + ' mode=' + describe(data.intent && data.intent.mode) + ' → 打开 ' + applied)
          return
        }

        attempts += 1
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(step, RETRY_MS)
          return
        }
        dseLog('意图展开放弃：侧栏未就绪（session=' + describe(sessionId) + '）')
      }

      // 放到队列尾，离开 fold 的事件分发调用栈。
      setTimeout(step, 0)
    }

    /** 面板/徽章的手动入口：按当前配置展开。 */
    function openPanel(target) {
      var config = target.config || getConfig()
      var data = target.data || {}
      var kind = target.kind || resolveKind(config.mode, data, config)

      var params = null
      if (kind === KIND_BROWSER) {
        // Agent 的 intent.url 优先，其次是本轮扫到的链接，最后是配置的默认网址。
        var urls = data.intent && data.intent.url ? [data.intent.url] : splitUrls(data.urls)
        if (!urls.length && config.urlList) {
          urls = config.urlList.split('\n').map(function (line) {
            return line.trim()
          }).filter(function (line) {
            return line && /^https?:\/\//.test(line)
          }).slice(0, MAX_URLS)
        }
        if (urls.length) params = { url: urls[0] }
      }

      return applyReveal(Object.assign({}, target, { kind: kind, params: params, data: data }))
    }

    // ============================================================
    // 诊断日志
    // ============================================================
    //
    // 浏览器半侧拿不到 fs —— `require('fs')` 会命中「模块表未命中」并 throw
    // （平台种子词只有 react / react/jsx-runtime / react-dom / react-dom/client /
    // @deepseek-ai/cordis / dsh-client-ui-slots / dsh-client-ui-primitives）。
    // 所以「在这一侧写文件」做不到，上一版正是这么写崩的：
    // require('fs') throw → 落到「回退 console.log」分支 → 紧接着又把
    // console.log 换成调用 debugLog 的函数 → debugLog 调 console.log →
    // 无限互相递归 → RangeError，而且 console.error 也被换掉，
    // 报错都打不出来，整个应用卡在 Loading plugins...。
    //
    // 现在的做法：
    //   1. 内存环形缓冲 → 由 dock 面板的「诊断日志」区渲染；
    //   2. 同一批行 POST 到宿主半侧注册的 /api/dsh-sidebar-enhance/log，
    //      由宿主写进 <插件>/logs/sidebar-enhance.log —— 这才是真正落盘的那份。

    var LOG_MAX = 120
    var LOG_ENDPOINT = '/api/dsh-sidebar-enhance/log'
    var logLines = []
    var logListeners = new Set()

    // 攒一小批再发，避免每条日志一次请求。发送失败一律吞掉：
    // 日志通道坏了绝不能影响插件功能，更不能反过来调 dseLog（会自激）。
    var logQueue = []
    var logTimer = null

    function flushLogs() {
      logTimer = null
      if (!logQueue.length) return
      var payload = logQueue.join('\n')
      logQueue = []
      try {
        var request = window.fetch(LOG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: payload,
          keepalive: true
        })
        if (request && typeof request.catch === 'function') request.catch(function () {})
      } catch (error) {
        // 忽略。
      }
    }

    function logNow() {
      var d = new Date()
      function pad(n, w) {
        var s = String(n)
        while (s.length < (w || 2)) s = '0' + s
        return s
      }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
    }

    function dseLog(message) {
      var line = logNow() + '  [client] ' + String(message)
      logLines = logLines.concat([line])
      if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX)
      logListeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          // 单个订阅者失败不影响其它。
        }
      })
      logQueue.push(line)
      if (logTimer === null && typeof window.setTimeout === 'function') {
        logTimer = window.setTimeout(flushLogs, 120)
      }
    }

    function subscribeLogs(listener) {
      logListeners.add(listener)
      return function () {
        logListeners.delete(listener)
      }
    }

    function logsSnapshot() {
      return logLines
    }

    function clearLogs() {
      logLines = []
      logListeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          // 单个订阅者失败不影响其它。
        }
      })
    }

    function useLogs() {
      return React.useSyncExternalStore(subscribeLogs, logsSnapshot, logsSnapshot)
    }

    // ============================================================
    // 侧栏浏览器探针（**只读**，不点不填不导航）
    // ============================================================
    //
    // 桌面端的侧栏浏览器是真的 Electron `<webview>`：官方 desktop 实现里
    // `document.createElement("webview")` + `data-sidebar-browser-frame="webview"`，
    // guest 租约由主进程批准（`did-attach-webview` + lease）。
    //
    // 但官方**只给了导航这一项 API**（`ctx.sidebarRight.openTab('browser', …)`），
    // 没有任何读页面 / 交互的入口，包自己也声明「不向被访问内容注入 Electron 或
    // Node 能力」。所以「AI 能不能用上这个浏览器」取决于一个事实：
    // webview 的**元素方法**（executeJavaScript / capturePage / getURL）在插件所在的
    // 渲染进程里到底能不能调。这个方法就是把答案测出来写进日志，而不是靠猜。

    /** 找侧栏浏览器元素。可能在 shadow root 里，所以递归找。**返回全部**。 */
    function findBrowserFrames() {
      var out = []
      function search(root) {
        var direct = null
        try {
          direct = root.querySelectorAll('[data-sidebar-browser-frame]')
        } catch (error) {
          return
        }
        for (var i = 0; i < direct.length; i += 1) out.push(direct[i])
        var all = null
        try {
          all = root.querySelectorAll('*')
        } catch (error) {
          return
        }
        for (var j = 0; j < all.length; j += 1) {
          var shadow = all[j].shadowRoot
          if (shadow) search(shadow)
        }
      }
      if (typeof document === 'undefined') return out
      search(document)
      return out
    }

    /**
     * 挑一个浏览器元素来用。多分栏 / 折叠时可能有多个，
     * 优先挑屏幕上真的看得见的那个，都不行就取最后一个。
     */
    function pickBrowserFrame() {
      var frames = findBrowserFrames()
      if (!frames.length) return null
      for (var i = frames.length - 1; i >= 0; i -= 1) {
        try {
          var rect = frames[i].getBoundingClientRect()
          if (rect && rect.width > 0 && rect.height > 0) return frames[i]
        } catch (error) {
          // 忽略，继续找。
        }
      }
      return frames[frames.length - 1]
    }

    function findBrowserFrame() {
      return pickBrowserFrame()
    }

    var probeSeq = 0

    function probeBrowserFrame(reason) {
      probeSeq += 1
      var tag = '浏览器探针#' + probeSeq + '(' + reason + ')'

      var frame = null
      try {
        frame = findBrowserFrame()
      } catch (error) {
        dseLog(tag + ' 查找异常: ' + describe(error))
        return
      }
      if (!frame) {
        dseLog(tag + ' 没找到侧栏浏览器元素（<webview> 未挂载）')
        return
      }

      var wanted = ['getURL', 'loadURL', 'executeJavaScript', 'capturePage', 'reload', 'goBack', 'openDevTools']
      var present = wanted.filter(function (name) {
        return typeof frame[name] === 'function'
      })
      dseLog(tag + ' 元素 <' + String(frame.tagName || '?').toLowerCase() + '>'
        + ' name=' + describe(frame.getAttribute ? frame.getAttribute('name') : null)
        + ' 可用方法: ' + (present.length ? present.join(',') : '无'))

      if (typeof frame.getURL === 'function') {
        try {
          dseLog(tag + ' getURL() = ' + describe(frame.getURL()))
        } catch (error) {
          dseLog(tag + ' getURL() 抛错: ' + describe(error))
        }
      }

      if (typeof frame.executeJavaScript === 'function') {
        var source = 'JSON.stringify({title:document.title,url:String(location.href),'
          + 'text:(document.body?document.body.innerText:"").slice(0,120),'
          + 'nodes:document.querySelectorAll("*").length})'
        Promise.resolve()
          .then(function () {
            return frame.executeJavaScript(source)
          })
          .then(function (value) {
            dseLog(tag + ' executeJavaScript 往返成功: ' + describe(value).slice(0, 240))
          })
          .catch(function (error) {
            dseLog(tag + ' executeJavaScript 失败: ' + describe(error))
          })
      }

      if (typeof frame.capturePage === 'function') {
        Promise.resolve()
          .then(function () {
            return frame.capturePage()
          })
          .then(function (image) {
            var data = image && typeof image.toDataURL === 'function' ? image.toDataURL() : ''
            dseLog(tag + ' capturePage 成功: dataURL 长度=' + String(data.length))
          })
          .catch(function (error) {
            dseLog(tag + ' capturePage 失败: ' + describe(error))
          })
      }
    }

    // ============================================================
    // 浏览器桥（客户端半侧）：短轮询拉命令 → 在侧栏 <webview> 里干活 → 回结果
    // ============================================================
    //
    // 宿主拿不到 Electron API，DOM 动作只能在这里做，所以由这一侧主动连宿主：
    // 命令走 `GET  /command`（短轮询，立即返回），结果走 `POST /result`，授权决定走 `POST /consent`。
    //
    // 授权：**导航不需要，读页面 / 交互需要**。需要时弹拦截页，三个按钮
    // （允许此次 / 始终允许本会话 / 不允许）；「不允许」直接关掉这个浏览器 tab。

    var COMMAND_ENDPOINT = '/api/dsh-sidebar-enhance/command'
    var RESULT_ENDPOINT = '/api/dsh-sidebar-enhance/result'
    var CONSENT_ENDPOINT = '/api/dsh-sidebar-enhance/consent'
    var STATE_ENDPOINT = '/api/dsh-sidebar-enhance/state'

    var BROWSER_KIND = 'browser'
    var OPS = { read: true, find: true, act: true, navigate: true }

    /** 等用户授权的上限。宿主的命令超时更长（150s），所以这里先到先得。 */
    var CONSENT_TIMEOUT_MS = 120000
    /** 导航后等页面挂载/加载的时间。 */
    var NAVIGATE_WAIT_MS = 1400
    /**
     * 短轮询间隔。★ 最早是长轮询（挂 20s 等命令），真实事故：一次 act 之后整个通道
     * 静默死亡——客户端的请求全部无声消失，连错误日志都没有。唯一让请求「挂起不结束」
     * 的就是长轮询，dsh-app:// 自定义协议对挂起响应流的处理是黑盒。换成每秒短轮询后
     * 每个请求都是毫秒级完成，这一类故障整个消失；代价是命令分发最多晚 1 秒，无所谓。
     */
    var POLL_INTERVAL_MS = 1000
    var POLL_ERROR_MS = 3000

    function postJson(url, value) {
      try {
        var request = window.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(value)
        })
        if (request && typeof request.catch === 'function') request.catch(function () {})
        return request
      } catch (error) {
        return null
      }
    }

    /**
     * 结果回传：**必须确认送达**，失败重试。
     *
     * ★ 结果丢了模型就收到 150s 超时，而 postJson 是发完就忘，丢了连个日志都没有——
     *   那次事故里 cmd-14 就这么无声消失的。这里 await 到响应为止，失败重试
     *   RESULT_RETRIES 次（总耗时约 3s，远在宿主 150s 预算内），仍失败就大声报警。
     */
    var RESULT_RETRIES = 3
    var RESULT_RETRY_MS = 1000

    function postResultWithRetry(payload, attempts, tag) {
      var request = null
      try {
        request = window.fetch(RESULT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload)
        })
      } catch (error) {
        request = null
      }
      var failure = function (why) {
        if (attempts > 0) {
          window.setTimeout(function () {
            postResultWithRetry(payload, attempts - 1, tag)
          }, RESULT_RETRY_MS)
          return
        }
        bridgeHealth.resultFailures += 1
        dseLog('⚠ ' + tag + ' 结果回传失败（重试 ' + RESULT_RETRIES + ' 次后放弃），宿主将对这条命令超时: ' + why)
      }
      if (!request || typeof request.then !== 'function') {
        failure('fetch 不可用')
        return
      }
      request.then(function (response) {
        if (response && response.status === 200) return
        failure('HTTP ' + (response && response.status))
      }).catch(function (error) {
        failure(describe(error))
      })
    }

    // ---------------------------------------------------------------- 授权拦截页

    var consentListeners = new Set()
    var consentRequest = null

    function consentSnapshot() {
      return consentRequest
    }

    function subscribeConsent(listener) {
      consentListeners.add(listener)
      return function () {
        consentListeners.delete(listener)
      }
    }

    function notifyConsent() {
      consentListeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          // 单个订阅者失败不影响其它。
        }
      })
    }

    function useConsent() {
      return React.useSyncExternalStore(subscribeConsent, consentSnapshot, consentSnapshot)
    }

    /** 弹拦截页，等用户点。返回 'once' | 'session' | 'deny'。 */
    function askConsent(command) {
      return new Promise(function (resolve) {
        var settled = false
        var timer = null
        function finish(decision, why) {
          if (settled) return
          settled = true
          if (timer !== null) window.clearTimeout(timer)
          consentRequest = null
          notifyConsent()
          dseLog('授权: 用户选择「' + decision + '」' + (why ? '（' + why + '）' : ''))
          resolve(decision)
        }
        timer = window.setTimeout(function () {
          finish('deny', '超时未处理')
        }, CONSENT_TIMEOUT_MS)
        consentRequest = {
          id: command.id,
          op: command.op,
          args: command.args || {},
          decide: finish
        }
        notifyConsent()
      })
    }

    function opLabel(t, op) {
      return t('op.' + op)
    }

    /** 拦截页正文里要说清楚「AI 想干什么、对哪个页面」。 */
    function consentTarget(request) {
      var args = request.args || {}
      if (typeof args.url === 'string' && args.url) return args.url
      var frame = pickBrowserFrame()
      if (frame && typeof frame.getURL === 'function') {
        try {
          var current = frame.getURL()
          if (current) return String(current)
        } catch (error) {
          // 忽略。
        }
      }
      if (typeof args.selector === 'string' && args.selector) return args.selector
      if (typeof args.query === 'string' && args.query) return args.query
      return ''
    }

    function ConsentPrompt(props) {
      var request = useConsent()
      var t = props.t

      React.useEffect(function () {
        if (!request) return undefined
        function onKey(event) {
          if (event.key === 'Escape') request.decide('deny', 'Escape')
        }
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('keydown', onKey)
        }
      }, [request])

      if (!request || typeof document === 'undefined') return null

      var target = consentTarget(request)
      function button(label, decide, primary) {
        return React.createElement('button', {
          key: label,
          type: 'button',
          'data-primary': primary ? '1' : undefined,
          onClick: function () {
            request.decide(decide)
          },
          children: label
        })
      }

      return ReactDOM.createPortal(
        React.createElement('div', { className: 'dse-consent' }, [
          React.createElement('div', { className: 'dse-consent__card', key: 'card' }, [
            React.createElement('div', { className: 'dse-consent__title', key: 'title', children: t('consent.title') }),
            React.createElement('div', { className: 'dse-consent__body', key: 'body' }, [
              React.createElement('div', { key: 'a', children: t('consent.ask') + ' ' + opLabel(t, request.op) }),
              target
                ? React.createElement('div', { className: 'dse-consent__target', key: 'b', children: target })
                : null
            ]),
            React.createElement('div', { className: 'dse-consent__actions', key: 'actions' }, [
              button(t('consent.once'), 'once', true),
              button(t('consent.session'), 'session'),
              button(t('consent.deny'), 'deny')
            ]),
            React.createElement('div', { className: 'dse-consent__hint', key: 'hint', children: t('consent.hint') })
          ])
        ]),
        document.body
      )
    }

    /** 「不允许」= 直接关掉 AI 正在用的那个浏览器 tab（用户要求的语义）。 */
    function closeBrowserTab() {
      var sidebar = sidebarOf()
      if (!sidebar || typeof sidebar.active !== 'function') return
      try {
        var active = sidebar.active()
        if (!active) {
          dseLog('拒绝授权: 没有活动 tab，无需关闭')
          return
        }
        if (active.kind !== BROWSER_KIND) {
          dseLog('拒绝授权: 活动 tab 不是浏览器（' + describe(active.kind) + '），不关闭')
          return
        }
        if (typeof sidebar.close !== 'function') {
          dseLog('拒绝授权: sidebarRight.close 不可用，没关闭浏览器 tab')
          return
        }
        sidebar.close(active.id)
        dseLog('拒绝授权: 已关闭浏览器 tab ' + describe(active.id))
      } catch (error) {
        dseLog('拒绝授权: 关闭浏览器 tab 失败 ' + describe(error))
      }
    }

    // ---------------------------------------------------------------- 页面脚本

    /** 注入到网页里的工具函数。注意这里的 `\\s` 到了页面上才是 `\s`。 */
    var WB_HELPERS = [
      'function __wb_out(o){return JSON.stringify(o)}',
      'function __wb_find(sel){try{return sel?document.querySelector(sel):null}catch(e){return null}}',
      'function __wb_path(el){try{var parts=[];var cur=el;while(cur&&cur.nodeType===1&&parts.length<6){var sel=cur.tagName.toLowerCase();if(cur.id){sel+="#"+cur.id;parts.unshift(sel);break}var p=cur.parentElement;if(p){var sib=[];for(var i=0;i<p.children.length;i++){if(p.children[i].tagName===cur.tagName)sib.push(p.children[i])}if(sib.length>1)sel+=":nth-of-type("+(sib.indexOf(cur)+1)+")"}parts.unshift(sel);cur=cur.parentElement}return parts.join(" > ")}catch(e){return ""}}',
      'function __wb_desc(el){try{var r=el.getBoundingClientRect();var st=getComputedStyle(el);var v=el.value===undefined?"":String(el.value);if(String(el.getAttribute("type")||"")==="password")v="[已隐藏]";return{tag:el.tagName.toLowerCase(),path:__wb_path(el),text:String(el.innerText||"").trim().replace(/\\s+/g," ").slice(0,200),attrs:{id:el.id||"",name:el.getAttribute("name")||"",type:el.getAttribute("type")||"",href:el.href||"",value:v.slice(0,80),placeholder:el.getAttribute("placeholder")||"",aria:el.getAttribute("aria-label")||"",target:el.getAttribute("target")||"",rel:el.getAttribute("rel")||""},rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},visible:!!(r.width&&r.height)&&st.visibility!=="hidden"&&st.display!=="none"}}catch(e){return{tag:"?",path:"",error:String(e&&e.message||e)}}}',
      'function __wb_value(el,value){var proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype);var d=null;try{d=Object.getOwnPropertyDescriptor(proto,"value")}catch(e){}if(d&&d.set)d.set.call(el,value);else el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))}'
    ].join('\n')

    /** 按操作拼出要注入页面的脚本；返回 null 表示参数不完整。 */
    function buildBrowserSource(op, args) {
      var body = null
      var isAsync = false

      if (op === 'read') {
        var chars = Math.max(500, Math.min(20000, Number(args.maxChars) || 6000))
        body = 'var text=document.body?document.body.innerText:"";'
          + 'var links=[],as=document.querySelectorAll("a[href]");'
          + 'for(var i=0;i<as.length&&links.length<40;i++){var a=as[i];var at=String(a.innerText||"").trim().replace(/\\s+/g," ").slice(0,70);if(!at)continue;links.push({text:at,href:a.href,target:a.getAttribute("target")||""})}'
          + 'var controls=[],fs=document.querySelectorAll("input,select,textarea,button");'
          + 'for(var j=0;j<fs.length&&controls.length<30;j++){var f=fs[j];controls.push({tag:f.tagName.toLowerCase(),type:f.type||"",name:f.name||"",id:f.id||"",placeholder:f.placeholder||"",label:String(f.innerText||f.value||"").trim().slice(0,40)})}'
          + 'return __wb_out({ok:true,url:location.href,title:document.title,ready:document.readyState,text:text.replace(/\\n{3,}/g,"\\n\\n").slice(0,' + chars + '),textLength:text.length,links:links,controls:controls})'
      } else if (op === 'find') {
        var limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
        body = 'var selector=' + JSON.stringify(args.selector == null ? '' : String(args.selector)) + ';'
          + 'var query=' + JSON.stringify(args.query == null ? '' : String(args.query)) + ';'
          + 'var limit=' + limit + ';var out=[];'
          + 'if(selector){var list=document.querySelectorAll(selector);for(var i=0;i<list.length&&out.length<limit;i++)out.push(__wb_desc(list[i]));return __wb_out({ok:true,mode:"selector",selector:selector,count:list.length,matches:out})}'
          + 'if(!query)return __wb_out({ok:false,error:"selector 和 query 至少要给一个"});'
          + 'var all=document.querySelectorAll("body *");var hits=[];var scanned=0;'
          + 'for(var k=0;k<all.length&&hits.length<limit&&scanned<6000;k++){var el=all[k];var txt=String(el.innerText||el.textContent||"");scanned++;'
          + 'if(txt.indexOf(query)<0)continue;var deeper=false;'
          + 'for(var c=0;c<el.children.length;c++){if(String(el.children[c].innerText||el.children[c].textContent||"").indexOf(query)>=0){deeper=true;break}}'
          + 'if(deeper)continue;hits.push(__wb_desc(el))}'
          + 'return __wb_out({ok:true,mode:"text",query:query,scanned:scanned,count:hits.length,matches:hits})'
      } else if (op === 'act') {
        var actions = Array.isArray(args.actions) ? args.actions.slice(0, 20) : []
        isAsync = true
        body = 'var actions=' + JSON.stringify(actions) + ';'
          + 'if(!actions.length)return __wb_out({ok:false,error:"actions 不能为空"});'
          + 'function delay(ms){return new Promise(function(r){setTimeout(r,ms)})}'
          + 'var results=[];'
          + 'for(var i=0;i<actions.length;i++){var a=actions[i]||{};var type=String(a.type||"");var sel=String(a.selector||"");'
          + 'try{'
          // ★ 点击默认**原地跳转**：把 target=_blank 之类的新窗口链接拉回本 tab（改动 B）。
          //   模型没有"别开新窗口"的自觉，而 <a target="_blank"> 在 Bing/搜索结果页到处都是——
          //   一次点击冒出多个 tab 就是从这儿来的。要新开必须显式 newTab:true。
          // ★ 点击后**不在页内等导航**：等待期间导航一旦发生，页面上下文连同返回值一起被销毁，
          //   executeJavaScript 的 promise 便永远不 settle —— 这就是 act「卡住不返回」的根源。
          //   页内只让出一拍（给不跳转的点击留出返回机会）；
          //   「到底跳没跳」交给宿主侧轮询 webview 的 getURL 判定（见 watchFrameNavigation）。
          + 'if(type==="click"){var el=__wb_find(sel);if(!el)throw new Error("找不到元素: "+sel);el.scrollIntoView({block:"center"});'
          + 'var u0=location.href;var keepNew=a.newTab===true;var oldTarget=null;'
          + 'if(!keepNew&&el.tagName==="A"&&el.getAttribute("target")){oldTarget=el.getAttribute("target");el.setAttribute("target","_self")}'
          + 'el.click();await delay(100);'
          + 'results.push({type:type,selector:sel,ok:true,url:location.href,navigated:location.href!==u0,newTab:oldTarget===null?undefined:false})}'
          + 'else if(type==="type"||type==="fill"){var t=__wb_find(sel);if(!t)throw new Error("找不到元素: "+sel);t.focus();var next=String(a.text==null?"":a.text);var base=(type==="type"&&!a.replace)?String(t.value||""):"";__wb_value(t,base+next);results.push({type:type,selector:sel,ok:true,value:String(t.value).slice(0,80)})}'
          + 'else if(type==="select"){var s=__wb_find(sel);if(!s)throw new Error("找不到元素: "+sel);__wb_value(s,String(a.value==null?"":a.value));results.push({type:type,selector:sel,ok:true,value:String(s.value).slice(0,80)})}'
          + 'else if(type==="press"){var target=sel?__wb_find(sel):document.activeElement;if(!target)throw new Error("没有可按键的元素");var key=String(a.key||"Enter");'
          + '["keydown","keypress","keyup"].forEach(function(k){target.dispatchEvent(new KeyboardEvent(k,{key:key,bubbles:true,cancelable:true}))});results.push({type:type,selector:sel,key:key,ok:true})}'
          + 'else if(type==="scroll"){window.scrollBy(0,Number(a.y||600));results.push({type:type,ok:true})}'
          + 'else if(type==="wait"){var ms=Math.max(0,Math.min(5000,Number(a.ms||500)));await delay(ms);results.push({type:type,ms:ms,ok:true})}'
          + 'else{throw new Error("不认识的 action type: "+type)}'
          + '}catch(e){results.push({type:type,selector:sel,ok:false,error:String(e&&e.message||e)})}'
          + 'if(a.afterWaitMs)await delay(Math.max(0,Math.min(5000,Number(a.afterWaitMs))))}'
          + 'return __wb_out({ok:results.every(function(r){return r.ok}),url:location.href,title:document.title,results:results})'
      }

      if (body === null) return null
      return '(' + (isAsync ? 'async ' : '') + 'function(){try{\n' + WB_HELPERS + '\n' + body
        + '\n}catch(e){return __wb_out({ok:false,error:String(e&&e.message||e)})}})()'
    }

    /** 页面回的是 JSON 字符串；解析不了就原样带回去，别丢信息。 */
    function parseOpResult(raw, op) {
      if (typeof raw === 'string') {
        try {
          var parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') return hoistActionFailure(parsed)
        } catch (error) {
          // 落到下面按原文返回。
        }
        return { ok: true, data: { raw: raw.slice(0, 2000) } }
      }
      if (raw && typeof raw === 'object') return raw
      // ★ 点击触发跳转时，页面上下文会被导航销毁，executeJavaScript 拿不到返回值。
      //   这不是失败。以前这里返回 ok:false，模型看到「失败」会再点一次 → 又多一个 tab。
      //   所以 act 的空返回要说成「已执行，去 read 确认」，别诱导重试。
      if (op === 'act') {
        return {
          ok: true,
          navigated: true,
          note: '点击已执行，页面正在跳转（脚本上下文已被导航销毁，拿不到动作明细）。'
            + '用 browser_read 确认当前页面是哪里，不要重复点击同一个元素。'
        }
      }
      return { ok: false, error: '页面脚本没有返回结果: ' + describe(raw) }
    }

    /**
     * 页面脚本正常返回、但其中某个动作失败时，真正的原因藏在 `results[i].error` 里。
     * 必须把它提到顶层 `error`：宿主 receipt 只看顶层 `!ok` 就返回，
     * 否则「找不到元素: xxx」这种关键信息会被整包丢掉，
     * 模型只看到「失败了但没有原因」，完全无法自我纠正。
     */
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

    /**
     * 导航：**优先原地跳转**（用户要求：AI 的导航复用同一个浏览器 tab，别每次开新的）。
     *
     * 已有浏览器 tab 且 webview 活着 → 直接 `loadURL`，页面就在用户看着的那个 tab 里变；
     * 拿不到 webview（tab 没开过 / 被关了）→ 才退回 `openTab` 开一个（官方 API，同分栏去重）。
     * loadURL 在探针的可用方法清单里，实测可调。
     */
    function opNavigate(args) {
      var url = String(args.url == null ? '' : args.url)
      if (!/^https?:\/\//i.test(url)) {
        return Promise.resolve({ ok: false, error: 'url 必须以 http:// 或 https:// 开头（got: ' + url + '）' })
      }

      var frame = pickBrowserFrame()
      if (frame && typeof frame.loadURL === 'function') {
        var before = null
        try { before = frame.getURL() } catch (error) { before = null }
        try {
          frame.loadURL(url)
        } catch (error) {
          // loadURL 失败（webview 刚好被卸载等）→ 落回 openTab。
        }
        if (typeof frame.getURL === 'function') {
          return new Promise(function (resolve) {
            var started = Date.now()
            function check() {
              var current = null
              try { current = frame.getURL() } catch (error) { current = null }
              if (current && current !== before) {
                resolve({ ok: true, url: current, note: '[原地跳转 loadURL] 已在现有浏览器 tab 里跳转，接着用 browser_read 读内容' })
                return
              }
              if (Date.now() - started > NAVIGATE_WAIT_MS * 4) {
                // loadURL 是异步导航，慢网下 6s 内 getURL 可能还没变。导航已经发起，
                // 不要报错——让 browser_read 去确认页面到底加载好没有。
                resolve({ ok: true, url: url, note: '[原地跳转 loadURL·未确认] 已发起导航（6s 内地址未变化，页面可能仍在加载），接着用 browser_read 确认' })
                return
              }
              window.setTimeout(check, 300)
            }
            check()
          })
        }
      }

      var sidebar = sidebarOf()
      if (!sidebar || typeof sidebar.openTab !== 'function') {
        return Promise.resolve({ ok: false, error: '侧栏服务不可用（sidebarRight 缺失）' })
      }
      try {
        sidebar.openTab(BROWSER_KIND, { params: { url: url } })
      } catch (error) {
        return Promise.resolve({ ok: false, error: '打开浏览器 tab 失败: ' + describe(error) })
      }
      // ★ 回落分支要盯住 webview 真正挂载并导航到位。真实截图：tab 开出来了，
      //   地址却是 about:blank——官方 openTab 的 params 在 tab 尚未挂载时可能没生效。
      //   轮询确认：挂载后如果还在 about:blank，补一发 loadURL。
      return new Promise(function (resolve) {
        var started = Date.now()
        var nudged = false
        function check() {
          var opened = pickBrowserFrame()
          var current = null
          if (opened && typeof opened.getURL === 'function') {
            try {
              current = opened.getURL()
            } catch (error) {
              current = null
            }
          }
          if (current && current !== 'about:blank') {
            resolve({ ok: true, url: current, note: '[回落 openTab] 已新开浏览器 tab 并导航到位，接着用 browser_read 读内容' })
            return
          }
          if (current === 'about:blank' && !nudged && opened && typeof opened.loadURL === 'function') {
            nudged = true
            try {
              opened.loadURL(url)
            } catch (error) {
              // 补刀失败就算了，超时后如实回执。
            }
          }
          if (Date.now() - started > NAVIGATE_WAIT_MS * 5) {
            resolve({ ok: true, url: current || url, note: '[回落 openTab·未确认] 已新开 tab，但 ' + Math.round((Date.now() - started) / 1000) + 's 内没确认到导航，接着用 browser_read 确认' })
            return
          }
          window.setTimeout(check, 300)
        }
        check()
      })
    }

    /** 执行一条浏览器命令。navigate 不需要页面元素，其余都要。 */
    function runBrowserOp(command) {
      var args = command.args || {}
      if (command.op === 'navigate') return opNavigate(args)

      var frame = pickBrowserFrame()
      if (!frame) {
        return Promise.resolve({
          ok: false,
          error: '侧栏里没有浏览器 tab。先调用 browser_navigate 打开一个页面。'
        })
      }
      if (typeof frame.executeJavaScript !== 'function') {
        return Promise.resolve({
          ok: false,
          error: '拿不到侧栏浏览器的脚本能力（executeJavaScript 不可用），无法读写页面。'
        })
      }
      var source = buildBrowserSource(command.op, args)
      if (source === null) return Promise.resolve({ ok: false, error: '参数不完整: ' + describe(args) })

      // ★ act：先记下点击前的地址，然后让「页面脚本返回」与「地址真的变了」赛跑。
      //   点击触发跳转时脚本 promise 可能永远不 settle（上下文被销毁），
      //   但地址变化是在 **webview 层面**发生的，宿主侧轮询就能立刻看到——
      //   于是「点一下跳走」能在 ~200ms 内拿到明确回执，而不是干等 30s 超时。
      // read / find 也一起盯：它们撞上跳转时同样会干等 30s（文档列为遗留）。
      var beforeUrl = readFrameUrl(frame)
      var running = runPageScript(frame, source)
      var raced = beforeUrl
        ? Promise.race([running, watchFrameNavigation(frame, beforeUrl, ACT_NAV_WATCH_MS).then(function (url) {
          return { __navigatedTo: url }
        })])
        : running

      return raced
        .then(function (raw) {
          if (raw && raw.__navigatedTo) {
            // act：跳转是它要的结果，算成功（并劝阻重复点击）。
            if (command.op === 'act') {
              return {
                ok: true,
                navigated: true,
                url: raw.__navigatedTo,
                note: '[点击已跳转] 页面已跳到 ' + raw.__navigatedTo
                  + '（脚本上下文被导航销毁，拿不到动作明细）。'
                  + '用 browser_read 读新页面的内容，不要重复点击同一个元素。'
              }
            }
            // read / find：跳转让这次读到的内容作废，如实报失败并指明新地址——
            // 比返回旧页面的内容骗模型，或干等 30s 超时都好。
            return {
              ok: false,
              error: '页面正在跳转到 ' + raw.__navigatedTo
                + '，本次读取的内容已失效。等页面加载完再重新调用一次。'
            }
          }
          if (raw && raw.__pageError) {
            // 脚本被拒绝/抛错。act 的特殊：点击触发的跳转也会走这里（旧上下文被销毁），
            // 不能报失败——报失败模型会再点一次，又一个 tab。
            if (command.op === 'act') {
              return {
                ok: true,
                navigated: true,
                note: '点击已执行，页面正在跳转（脚本被导航中断）。'
                  + '用 browser_read 确认当前页面是哪里，不要重复点击同一个元素。'
              }
            }
            return { ok: false, error: '页面脚本执行失败: ' + raw.__pageError }
          }
          return parseOpResult(raw, command.op)
        })
    }

    /**
     * ★ 在 webview 里执行页面脚本，**必须带超时兜底**。
     *
     * 真实事故（v7）：点击触发跳转时，页面上下文被销毁，`executeJavaScript`
     * 的 promise **既不 resolve 也不 reject，永远挂起**（不是返回 undefined！）。
     * 之前只处理了「返回空」的情况，永挂直接让整条命令链死掉，模型等满宿主 150s。
     * 这里用竞速：脚本正常完成就取结果；被导航打断/永挂则超时返回 undefined，
     * 由调用方按「正在跳转」处理。ACT 上限远大于页面内 wait 的总和，正常操作碰不到。
     */
    var PAGE_SCRIPT_TIMEOUT_MS = 30000

    /**
     * 点击后最多盯多久地址变化；超时就交给脚本自身或上面的总超时兜底。
     *
     * ★ 取 20s 而不是 2.5s：用户实测「act 点击后页面**约 20 秒**才完成跳转」。
     *   盯守太短（2.5s）时，慢网/重页面的跳转会在盯守结束之后才发生，
     *   于是又退化成「等满 30s 脚本超时」——修了等于没修。
     *   放大盯守窗口没有副作用：不跳转时脚本几百毫秒就返回，竞速由脚本赢，
     *   盯守只是空跑到超时为止。
     */
    var ACT_NAV_WATCH_MS = 20000

    /** 读 webview 当前地址；拿不到就返回 null（不抛）。 */
    function readFrameUrl(frame) {
      try {
        return frame && typeof frame.getURL === 'function' ? frame.getURL() : null
      } catch (error) {
        return null
      }
    }

    /**
     * 盯住 webview 的地址：一旦相对 before 变了就立刻 resolve 新地址；
     * 一直不变则**永远不 resolve**（由竞速里的脚本本身或总超时负责收尾）。
     *
     * 为什么不在页面里等：页内 `while(location.href===u0)` 这种等待，
     * 恰恰因为"导航真的发生了"才会把上下文连同返回值一起销毁——
     * 于是等待成了自毁，act 永远回不了结果。地址变化在 webview 层面可见，
     * 拿到这里判就完全不受上下文销毁影响。
     */
    function watchFrameNavigation(frame, before, capMs) {
      return new Promise(function (resolve) {
        if (!before) return
        var started = Date.now()
        function check() {
          var now = readFrameUrl(frame)
          if (now && now !== before) {
            resolve(now)
            return
          }
          if (Date.now() - started > capMs) return
          window.setTimeout(check, 120)
        }
        window.setTimeout(check, 120)
      })
    }

    function runPageScript(frame, source) {
      return new Promise(function (resolve) {
        var settled = false
        var finish = function (value) {
          if (settled) return
          settled = true
          resolve(value)
        }
        try {
          var running = frame.executeJavaScript(source)
          if (running && typeof running.then === 'function') {
            running.then(finish, function (error) {
              finish({ __pageError: describe(error) })
            })
          } else {
            finish(undefined)
          }
        } catch (error) {
          finish({ __pageError: describe(error) })
        }
        // 测试里 setTimeout 长延时挂起，所以这条定时器不会干扰测试；测试通过
        // bridge.pageScriptTimeout(ms) 把它调小来驱动这条路径。
        window.setTimeout(function () {
          finish(undefined)
        }, PAGE_SCRIPT_TIMEOUT_MS)
      })
    }

    /** 把操作结果归一成通道约定的形状 `{ ok, denied, error, data }`。
     *
     * ★ 这里踩过一次：runBrowserOp 返回的是**摊平**的 `{ok, url, title, text…}`，
     *   直接 POST 回去的话宿主读 `body.data` 读不到（undefined → null），
     *   于是工具返回给模型的就是字符串 "null" —— 桥通着、页面也真读到了，
     *   但模型什么都拿不到。所以 payload 的组装必须在这里收口，别让调用方自己拼。
     */
    function payloadFor(commandId, result) {
      if (!result || typeof result !== 'object') {
        return { id: commandId, ok: false, error: '浏览器操作没有返回结果' }
      }
      if (result.denied) return { id: commandId, ok: false, denied: true }

      var data = {}
      var hasData = false
      Object.keys(result).forEach(function (key) {
        if (key === 'ok' || key === 'denied' || key === 'error') return
        data[key] = result[key]
        hasData = true
      })
      return {
        id: commandId,
        ok: result.ok !== false,
        denied: false,
        // ★ 绝不发 error:null。宿主侧对 JSON null 会 String(null) 成字符串 "null"，
        //   最终模型看到的是「浏览器操作失败: null」——一个零线索的回执，
        //   既看不出是哪一步失败，也没有任何可执行信息。
        error: (function () {
          if (result.error != null) return String(result.error)
          if (result.ok === false) return '操作失败但没有给出原因（客户端未上报 error）'
          return null
        })(),
        data: hasData ? data : null
      }
    }

    /** 结果摘要：只给形状和尺寸，不把整页正文倒进日志。 */
    function summarizeData(data) {
      if (data === null || data === undefined) return 'data=null'
      var keys = Object.keys(data)
      var size = 0
      try {
        size = JSON.stringify(data).length
      } catch (error) {
        size = -1
      }
      return 'data{' + keys.slice(0, 8).join(',') + (keys.length > 8 ? ',…' : '') + '} ' + size + 'B'
    }

    /** 一条命令的完整流程：授权 → 执行 → 回结果。 */
    function handleCommand(command) {
      if (!command || typeof command.id !== 'string' || typeof command.op !== 'string') {
        return Promise.resolve({ ok: false, error: '未知命令' })
      }
      if (OPS[command.op] !== true) {
        return Promise.resolve({ ok: false, error: '不支持的操作: ' + command.op })
      }

      return Promise.resolve()
        .then(function () {
          if (!command.needsConsent) return 'allow'
          dseLog('授权: 请求用户确认 ' + command.op + ' ' + describe(command.args).slice(0, 120))
          return askConsent(command)
        })
        .then(function (decision) {
          if (decision === 'deny') {
            closeBrowserTab()
            return { denied: true }
          }
          if (decision === 'once' || decision === 'session') {
            postJson(CONSENT_ENDPOINT, {
              id: command.id,
              scope: decision,
              sessionId: currentSessionId()
            })
          }
          return runBrowserOp(command)
        })
        .then(function (result) {
          var payload = payloadFor(typeof command.id === 'string' ? command.id : '', result)
          dseLog('浏览器桥 ' + command.op + ' → '
            + (payload.denied ? '被用户拒绝' : payload.ok ? '成功 ' + summarizeData(payload.data) : '失败: ' + String(payload.error)))
          // 上面这条日志只说成败，看不出内容有没有跟着回来——这次事故就是这么被盖住的。
          // 所以再补一行：成功却没有 data 是要立刻发现的异常，不是正常情况。
          if (payload.ok && (payload.data === null || payload.data === undefined)) {
            dseLog('浏览器桥 ' + command.op + ' ⚠ 成功但没有 data，模型会收到空结果: ' + describe(result).slice(0, 200))
          }
          postResultWithRetry(payload, RESULT_RETRIES, command.op + ' id=' + payload.id)
          return payload
        })
        .catch(function (error) {
          var failed = payloadFor(typeof command.id === 'string' ? command.id : '', { ok: false, error: describe(error) })
          dseLog('浏览器桥 ' + command.op + ' → 异常: ' + describe(error))
          postResultWithRetry(failed, RESULT_RETRIES, command.op + ' id=' + failed.id)
          return failed
        })
    }

    // ---------------------------------------------------------------- 状态上报 + 命令循环

    /**
     * 通道健康度。★ 上一次事故里通道是**静默死亡**的：客户端所有请求无声消失，
     * 唯一的外部表现是模型等满 150s 超时——那时候只能翻日志猜。
     * 现在把「最近一次成功轮询的时间」直接摆到面板上：通道一断，这行立刻不动了，
     * 不用等、不用猜。
     */
    var bridgeHealth = {
      started: false,
      lastPollAt: 0,     // 最近一次成功拿到响应
      failures: 0,       // 连续轮询失败
      commands: 0,       // 已处理的命令数
      lastOp: '',
      resultFailures: 0  // 结果回传重试后仍失败的次数
    }

    var lastReportedState = ''
    var loopStarted = false
    var loopTimer = null
    var pollInFlight = false

    function reportState() {
      var state = {
        sessionId: currentSessionId(),
        config: { browserPolicy: getConfig().browserPolicy }
      }
      var fingerprint = JSON.stringify(state)
      if (fingerprint === lastReportedState) return
      var request = postJson(STATE_ENDPOINT, state)
      if (request && typeof request.then === 'function') {
        request.then(function () {
          lastReportedState = fingerprint
        }).catch(function () {})
      } else {
        lastReportedState = fingerprint
      }
    }

    /**
     * 短轮询命令循环：每 POLL_INTERVAL_MS 问一次宿主「有命令吗」，请求立即返回。
     *
     * ★ 最早是长轮询（没命令就挂 20s），真实事故里整个通道静默死亡且无任何错误痕迹。
     *   短轮询的每个请求都是毫秒级完成，不依赖挂起的响应流。防御三件套：
     *   ① pollInFlight：上一个请求没回来就不发下一个（防堆积）；
     *   ② 拿到命令后等 handleCommand 落地再问下一次（处理期间不空转）；
     *   ③ 只在 `window.fetch` 可用时启动（测试环境不给 fetch，循环就不跑，
     *      否则一个永不失败的定时器会把测试进程挂住）。
     */
    function startCommandLoop() {
      if (loopStarted) return
      if (typeof window.fetch !== 'function') {
        dseLog('浏览器桥: 没有 fetch，命令循环不启动')
        return
      }
      loopStarted = true
      bridgeHealth.started = true
      dseLog('浏览器桥: 开始短轮询 ' + COMMAND_ENDPOINT + '（每 ' + POLL_INTERVAL_MS + 'ms）')
      step()

      function schedule(delay) {
        if (loopTimer !== null) window.clearTimeout(loopTimer)
        loopTimer = window.setTimeout(step, delay)
      }

      function step() {
        if (pollInFlight) return
        pollInFlight = true
        reportState()

        var request = null
        try {
          request = window.fetch(COMMAND_ENDPOINT, { method: 'GET', cache: 'no-store' })
        } catch (error) {
          request = null
        }
        if (!request || typeof request.then !== 'function') {
          pollInFlight = false
          schedule(POLL_ERROR_MS)
          return
        }

        request
          .then(function (response) {
            if (!response || typeof response.json !== 'function') {
              throw new Error('命令通道响应不可解析')
            }
            return response.json()
          })
          .then(function (command) {
            pollInFlight = false
            bridgeHealth.lastPollAt = Date.now()
            bridgeHealth.failures = 0
            if (!command || typeof command.id !== 'string') {
              schedule(POLL_INTERVAL_MS)
              return null
            }
            bridgeHealth.commands += 1
            bridgeHealth.lastOp = String(command.op || '')
            // 结果由 handleCommand 自己 POST（带确认重试），这里等它落地再问下一条。
            return handleCommand(command).then(function () {
              schedule(POLL_INTERVAL_MS)
            })
          })
          .catch(function (error) {
            pollInFlight = false
            bridgeHealth.failures += 1
            if (loopStarted && error) {
              dseLog('浏览器桥: 轮询失败（连续 ' + bridgeHealth.failures + ' 次）' + describe(error))
            }
            schedule(POLL_ERROR_MS)
          })
      }
    }

    /**
     * 把任意值压成一行可读文本，供日志与错误回执使用。
     *
     * ⚠️ 它把 `null` / `undefined` 也压成**字符串** `'null'` / `'undefined'`。
     *   所以**绝不能拿它的返回值判断"有没有错误"**——`describe(null)` 是 truthy 的
     *   字符串，会让 `error || '未知错误'` 这类兜底永久失效（真实事故：
     *   模型收到过一条零线索的「浏览器操作失败: null」）。
     *   判空请用原值，只在确定要展示时才过这一层。
     */
    function describe(value) {
      if (value === null) return 'null'
      if (value === undefined) return 'undefined'
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch (error) {
        return String(value)
      }
    }

    // ============================================================
    // 样式
    // ============================================================

    var CSS = [
      '.dse-badge{display:inline-flex;align-items:center;gap:6px;margin:6px 0 2px;padding:3px 9px;border:1px solid rgba(128,128,128,.3);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;max-width:100%;}',
      '.dse-badge:hover{background:rgba(128,128,128,.13);border-color:rgba(128,128,128,.46);}',
      '.dse-badge--pending{opacity:.62;}',
      '.dse-badge__icon{flex:0 0 auto;opacity:.72;}',
      '.dse-badge__text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dse-badge__cta{flex:0 0 auto;margin-left:2px;padding-left:6px;border-left:1px solid rgba(128,128,128,.32);opacity:.72;font-size:10.5px;}',
      '.dse-dock{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;opacity:.68;cursor:pointer;}',
      '.dse-dock:hover{background:rgba(128,128,128,.15);opacity:1;}',
      '.dse-dock--on{opacity:1;}',
      '.dse-dock--on .dse-dock__icon{color:#4a7df0;}',
      // 面板本体由 .dse-panel-host 用 fixed 定位（portal 到 body），
      // 所以这里不再自己 absolute 挂到 composer 上。
      '.dse-panel{width:100%;padding:10px;border:1px solid rgba(128,128,128,.3);border-radius:12px;background:canvas;color:canvastext;box-shadow:0 12px 32px rgba(0,0,0,.22);font-size:12.5px;line-height:1.45;box-sizing:border-box;}',
      '.dse-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:600;}',
      '.dse-panel__close{border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:15px;line-height:1;padding:0 4px;}',
      '.dse-panel__close:hover{opacity:1;}',
      '.dse-panel__caption{margin:8px 0 5px;font-size:10.5px;letter-spacing:.05em;opacity:.6;text-transform:uppercase;}',
      '.dse-panel__row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:7px;cursor:pointer;}',
      '.dse-panel__row:hover{background:rgba(128,128,128,.13);}',
      '.dse-panel__row svg{flex:0 0 auto;opacity:.8;}',
      '.dse-panel__row span:first-of-type{flex:1 1 auto;}',
      '.dse-panel__row.kbd{opacity:.5;font-size:11px;cursor:default;}',
      '.dse-panel__row.kbd:hover{background:transparent;}',
      '.dse-panel__divider{height:1px;margin:8px 0;background:rgba(128,128,128,.22);}',
      '.dse-panel__check{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:12px;cursor:pointer;}',
      '.dse-panel__check input{flex:0 0 auto;}',
      '.dse-panel__field{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:12px;}',
      '.dse-panel__field label{flex:1 1 auto;}',
      '.dse-panel__field select,.dse-panel__field input{flex:0 0 auto;background:transparent;border:1px solid rgba(128,128,128,.32);border-radius:6px;color:inherit;font:inherit;font-size:11.5px;padding:2px 5px;}',
      '.dse-panel__field input{width:62px;text-align:right;}',
      '.dse-panel__textarea{flex:1 1 auto;min-width:0;min-height:42px;resize:vertical;background:transparent;border:1px solid rgba(128,128,128,.32);border-radius:6px;color:inherit;font:inherit;font-size:11.5px;padding:3px 6px;line-height:1.4;}',
      '.dse-panel__hint{margin-top:7px;font-size:10.5px;opacity:.55;line-height:1.4;}',
      '.dse-panel__caption .dse-panel__close{float:right;font-size:11px;}',
      '.dse-panel__logs{margin-top:6px;max-height:132px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.5;opacity:.78;}',
      '.dse-panel__logline{white-space:pre-wrap;word-break:break-all;}',
      '.dse-bridge--ok{color:#1a7f37;}',
      '.dse-bridge--stalled{color:#d1242f;font-weight:600;}',
      // 授权拦截页：盖住整个窗口，三按钮。用 canvas/canvastext 跟随主题。
      '.dse-consent{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.4);}',
      '.dse-consent__card{width:396px;max-width:92vw;padding:14px 16px;border:1px solid rgba(128,128,128,.34);border-radius:14px;background:canvas;color:canvastext;box-shadow:0 18px 48px rgba(0,0,0,.34);font-size:12.5px;line-height:1.5;}',
      '.dse-consent__title{font-weight:600;font-size:13.5px;margin-bottom:6px;}',
      '.dse-consent__body{margin-bottom:11px;}',
      '.dse-consent__target{margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;opacity:.72;word-break:break-all;}',
      '.dse-consent__actions{display:flex;flex-wrap:wrap;gap:6px;}',
      '.dse-consent__actions button{flex:1 1 auto;padding:6px 10px;border-radius:9px;border:1px solid rgba(128,128,128,.42);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;}',
      '.dse-consent__actions button:hover{background:rgba(128,128,128,.14);}',
      '.dse-consent__actions button[data-primary]{border-color:#4a7df0;color:#4a7df0;}',
      '.dse-consent__hint{margin-top:10px;font-size:10.5px;opacity:.6;line-height:1.45;}'
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ============================================================
    // 图标
    // ============================================================

    function svg(children, size) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16',
        width: size || 14,
        height: size || 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      }, children)
    }

    function IconWorkbench(props) {
      var extra = props || {}
      return svg([
        React.createElement('rect', { x: 1.7, y: 2.3, width: 12.6, height: 11.4, rx: 1.8 }),
        React.createElement('path', { d: 'M10.2 2.3v11.4' }),
        React.createElement('path', { d: 'M3.4 5.2h5M3.4 7.6h5' })
      ], 15)
    }

    function IconFiles() {
      return svg([
        React.createElement('path', { d: 'M3.2 1.8h4.2l2.6 2.6v9.8H3.2z' }),
        React.createElement('path', { d: 'M7.4 1.8v2.6h2.6' }),
        React.createElement('path', { d: 'M4.8 8.4h4.8M4.8 10.6h3.4' })
      ], 14)
    }

    function IconTerminal() {
      return svg([
        React.createElement('rect', { x: 1.7, y: 2.6, width: 12.6, height: 10.8, rx: 1.6 }),
        React.createElement('path', { d: 'M4.2 6.2l2.4 2-2.4 2' }),
        React.createElement('path', { d: 'M8.6 10.4h3.2' })
      ], 14)
    }

    function IconBrowser() {
      return svg([
        React.createElement('circle', { cx: 8, cy: 8, r: 6.2 }),
        React.createElement('path', { d: 'M1.8 8h12.4' }),
        React.createElement('path', { d: 'M8 1.8c2 1.9 2 10.5 0 12.4M8 1.8c-2 1.9-2 10.5 0 12.4' })
      ], 14)
    }

    function IconDiff() {
      return svg([
        React.createElement('path', { d: 'M2.6 4.4h10.8' }),
        React.createElement('path', { d: 'M2.6 11.6h10.8' }),
        React.createElement('path', { d: 'M11.4 1.9v2.5h-2.5' }),
        React.createElement('path', { d: 'M4.6 14.1V11.6h2.5' }),
        React.createElement('path', { d: 'M11.4 4.4L2.6 11.6' })
      ], 14)
    }

    // ============================================================
    // 文案
    // ============================================================

    var zh = {
      'dock.label': '工作伙伴面板：文件 / 终端 / 浏览器',
      'dock.title': '工作伙伴面板',
      'dock.quick': '快捷打开',
      'dock.keys': '快捷键',
      'dock.settings': '设置',
      'set.revealOnIntent': 'AI 主动要求展示时展开侧栏',
      'set.mode': '手动打开时默认看',
      'set.badge': '轮次尾部显示产出徽章',
      'set.urlList': '默认网址',
      'set.urlList.placeholder': '每行一个 https://…',
      'set.browserPolicy': 'AI 使用侧栏浏览器',
      'policy.ask': '每次询问',
      'policy.allow': '始终允许（不再询问）',
      'op.read': '读取页面',
      'op.find': '查找页面元素',
      'op.act': '操作页面',
      'op.navigate': '打开网址',
      'consent.title': '需要你授权',
      'consent.ask': 'AI 想使用侧栏浏览器：',
      'consent.once': '允许此次访问',
      'consent.session': '始终允许（本会话）',
      'consent.deny': '不允许',
      'consent.hint': '「不允许」会直接关掉这个浏览器 tab。授权只对当前会话生效，不影响其它会话；想一直放开可以在插件面板里把权限改成「始终允许」。',
      'quick.files': '工作区文件',
      'quick.terminal': '新建终端',
      'quick.browser': '浏览器',
      'quick.changes': '本轮改动',
      'mode.auto': '自动：有改动看 diff，否则看文件',
      'mode.changes': '本轮改动 diff',
      'mode.files': '工作区文件',
      'mode.file': '指定文件',
      'mode.terminal': '终端',
      'mode.browser': '浏览器',
      'hint.changeReview': '本轮 diff 需要交付面板插件提供；未启用时自动回到工作区文件。',
      'dock.diagnostics': '诊断日志',
      'dock.logs.empty': '暂无记录',
      'dock.logs.clear': '清空',
      'dock.probe': '探测侧栏浏览器',
      'dock.bridge': '浏览器桥',
      'dock.bridge.online': '在线',
      'dock.bridge.stalled': '中断（请求发不出去）',
      'dock.bridge.off': '未启动',
      'dock.bridge.poll': '最近轮询',
      'dock.bridge.cmds': '已处理命令',
      'dock.bridge.failures': '轮询失败',
      'dock.bridge.resultFailures': '结果回传失败',
      'badge.label': '本轮产出',
      'badge.title': '本轮产出 · 点击在侧栏打开',
      'badge.changes': '已改动',
      'badge.files': '{count} 个文件',
      'badge.urls': '{count} 个链接',
      'badge.cta': '侧栏',
      'shortcut.reveal': '打开工作伙伴侧栏',
      'shortcut.toggleAuto': '切换 AI 主动展示',
      'shortcut.noSession': '请先选择一个会话'
    }

    var en = {
      'dock.label': 'SidebarEnhance panel: files / terminal / browser',
      'dock.title': 'SidebarEnhance panel',
      'dock.quick': 'Quick open',
      'dock.keys': 'Shortcuts',
      'dock.settings': 'Settings',
      'set.revealOnIntent': 'Reveal when the agent asks for it',
      'set.mode': 'What the manual buttons open',
      'set.badge': 'Show the turn-tail badge',
      'set.urlList': 'Default URLs',
      'set.urlList.placeholder': 'One https://… per line',
      'set.browserPolicy': 'Agent use of the sidebar browser',
      'policy.ask': 'Ask every time',
      'policy.allow': 'Always allow (never ask)',
      'op.read': 'read the page',
      'op.find': 'find elements',
      'op.act': 'interact with the page',
      'op.navigate': 'open a URL',
      'consent.title': 'Your permission is needed',
      'consent.ask': 'The agent wants to use the sidebar browser:',
      'consent.once': 'Allow this once',
      'consent.session': 'Always allow in this session',
      'consent.deny': 'Deny',
      'consent.hint': 'Deny closes that browser tab. The grant applies to this session only; switch the policy to "Always allow" in the plugin panel to stop being asked.',
      'quick.files': 'Workspace files',
      'quick.terminal': 'New terminal',
      'quick.browser': 'Browser',
      'quick.changes': 'Turn diff',
      'mode.auto': 'Auto: turn diff when changed, otherwise files',
      'mode.changes': 'Turn diff',
      'mode.files': 'Workspace files',
      'mode.file': 'A specific file',
      'mode.terminal': 'Terminal',
      'mode.browser': 'Browser',
      'hint.changeReview': 'The turn diff needs the deliverables plugin; it falls back to workspace files otherwise.',
      'dock.diagnostics': 'Diagnostics',
      'dock.logs.empty': 'No entries yet',
      'dock.logs.clear': 'Clear',
      'dock.probe': 'Probe browser tab',
      'dock.bridge': 'Browser bridge',
      'dock.bridge.online': 'online',
      'dock.bridge.stalled': 'STALLED (requests not going out)',
      'dock.bridge.off': 'not started',
      'dock.bridge.poll': 'last poll',
      'dock.bridge.cmds': 'commands',
      'dock.bridge.failures': 'poll failures',
      'dock.bridge.resultFailures': 'result send failures',
      'badge.label': 'Turn output',
      'badge.title': 'Turn output · click to open in the sidebar',
      'badge.changes': 'changed',
      'badge.files': '{count} files',
      'badge.urls': '{count} links',
      'badge.cta': 'sidebar',
      'shortcut.reveal': 'Open the sidebar-enhance sidebar',
      'shortcut.toggleAuto': 'Toggle agent-driven reveal',
      'shortcut.noSession': 'Select a session first'
    }

    // ============================================================
    // Turn 位置工具
    // ============================================================

    function turnNoOf(turn) {
      if (typeof turn === 'number') return turn
      if (turn && typeof turn === 'object') {
        if (typeof turn.turn === 'number') return turn.turn
        if (typeof turn.id === 'number') return turn.id
      }
      return undefined
    }

    function turnDataOf(turn, key) {
      if (!turn || typeof turn !== 'object') return undefined
      var bag = turn.data
      if (!bag) return undefined
      if (typeof bag.get === 'function') return bag.get(key)
      return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined
    }

    function shapeData(data) {
      var out = { changes: null, files: [], urls: [], intent: null }
      if (!data || typeof data !== 'object') return out
      if (data.changes && typeof data.changes === 'object') out.changes = data.changes
      if (Array.isArray(data.files)) out.files = data.files.slice(0, MAX_FILES)
      out.urls = splitUrls(data.urls)
      if (data.intent && typeof data.intent === 'object' && typeof data.intent.mode === 'string') out.intent = data.intent
      return out
    }

    var handled = new Set()

    // 最近一次渲染过的 Turn 产出。turnTail 按 Turn 顺序渲染，后渲染的覆盖先渲染的，
    // 因此这里始终指向最新一轮——dock 面板没有 Turn 上下文时用它复用本轮成果。
    var latest = { sessionId: null, turn: null, data: null }

    function remember(key) {
      if (handled.size > 400) handled.clear()
      handled.add(key)
    }

    function currentSessionId() {
      var sidebar = sidebarOf()
      if (!sidebar || !sidebar.mounted) return undefined
      try {
        if (typeof sidebar.mounted.getSnapshot === 'function') return sidebar.mounted.getSnapshot()
        return sidebar.mounted
      } catch (error) {
        return undefined
      }
    }

    // ============================================================
    // 轮次尾部徽章
    // ============================================================

    function basename(path) {
      var clean = String(path).replace(/\\/g, '/')
      var parts = clean.split('/')
      return parts[parts.length - 1] || clean
    }

    function TurnBadge(props) {
      var data = props.data
      var running = props.running
      var t = translator(props)
      var onOpen = props.onOpen

      var files = data.files
      var urls = data.urls
      var parts = []
      if (data.changes) parts.push(t('badge.changes'))
      if (files.length) parts.push(t('badge.files', { count: files.length }))
      if (urls.length) parts.push(t('badge.urls', { count: urls.length }))
      if (!parts.length) return null

      var label = t('badge.changes') + (files.length ? ' · ' + files.map(basename).slice(0, 2).join(', ') : '')
      return React.createElement('button', {
        type: 'button',
        className: 'dse-badge' + (running ? ' dse-badge--pending' : ''),
        title: t('badge.title'),
        'aria-label': label,
        onClick: onOpen,
        children: [
          React.createElement(IconDiff, null),
          React.createElement('span', { className: 'dse-badge__text', children: parts.join(' · ') }),
          React.createElement('span', { className: 'dse-badge__cta', children: t('badge.cta') })
        ]
      })
    }

    // ============================================================
    // turnTail 入口：自动展开 + 徽章
    // ============================================================

    function SidebarTail(props) {
      var turnNo = turnNoOf(props.turn)
      var sessionId = props.sessionId
      var cfg = useConfig()

      var running = typeof props.useSession === 'function'
        ? Boolean(props.useSession(function (snapshot) {
            return snapshot && snapshot.running
          }))
        : false

      var data = shapeData(turnDataOf(props.turn, FOLD_KEY))

      // 记录最新一轮产出，供没有 Turn 上下文的 dock 面板复用。
      if (sessionId !== undefined && turnNo !== undefined) {
        latest = { sessionId: sessionId, turn: turnNo, data: data }
      }

      // 这里【不再】自动展开侧栏。
      // 展示一律由 Agent 调 sidebar_reveal 驱动（见 requestReveal）——
      // 收尾自动弹既打扰用户，又和「用户已经手动关掉侧栏」的意图打架。
      // TurnBadge 仍然存在，用户想自己点开随时可以。

      if (turnNo === undefined || !sessionId) return null

      if (!cfg.showBadge) return null
      if (!data.changes && !data.files.length && !data.urls.length) return null

      return React.createElement(TurnBadge, {
        data: data,
        running: running,
        t: props.t,
        onOpen: function () {
          var bridge = window[BRIDGE]
          if (!bridge || !bridge.open) return
          try {
            bridge.open({
              sessionId: sessionId,
              turn: turnNo,
              data: data,
              config: getConfig(),
              source: 'badge'
            })
          } catch (error) {
            // 忽略。
          }
        }
      })
    }

    // ============================================================
    // composer 面板：快捷打开 + 设置 + 诊断日志
    // ============================================================

    function Panel(props) {
      var cfg = props.cfg
      var t = translator(props)
      var onOpen = props.onOpen
      var onPatch = props.onPatch

      var kinds = [
        [KIND_CHANGES, IconDiff, t('quick.changes')],
        [KIND_FILES, IconFiles, t('quick.files')],
        [KIND_TERMINAL, IconTerminal, t('quick.terminal')],
        [KIND_BROWSER, IconBrowser, t('quick.browser')]
      ]

      return React.createElement('div', {
        className: 'dse-panel',
        role: 'dialog',
        'aria-label': t('dock.title'),
        children: [
          React.createElement('div', { className: 'dse-panel__head' }, [
            React.createElement('span', null, t('dock.title')),
            React.createElement('button', {
              type: 'button',
              className: 'dse-panel__close',
              title: 'Esc',
              onClick: props.onClose,
              children: '\u00D7'
            })
          ]),

          React.createElement('div', { className: 'dse-panel__caption', children: t('dock.quick') }),
          React.createElement('div', {
            children: kinds.map(function (item) {
              var Icon = item[1]
              return React.createElement('div', {
                key: item[0],
                className: 'dse-panel__row',
                role: 'button',
                tabIndex: 0,
                onClick: function () {
                  onOpen(item[0])
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpen(item[0])
                  }
                },
                children: [
                  React.createElement(Icon, null),
                  React.createElement('span', null, item[2])
                ]
              })
            })
          }),

          React.createElement('div', { className: 'dse-panel__divider' }),

          React.createElement('div', { className: 'dse-panel__caption', children: t('dock.settings') }),
          React.createElement('label', { className: 'dse-panel__check' }, [
            React.createElement('input', {
              type: 'checkbox',
              checked: cfg.revealOnIntent !== false,
              onChange: function (event) {
                onPatch({ revealOnIntent: event.target.checked })
              }
            }),
            React.createElement('span', null, t('set.revealOnIntent'))
          ]),
          React.createElement('div', { className: 'dse-panel__field' }, [
            React.createElement('label', { htmlFor: 'dse-mode', children: t('set.mode') }),
            React.createElement('select', {
              id: 'dse-mode',
              value: cfg.mode,
              onChange: function (event) {
                onPatch({ mode: event.target.value })
              },
              children: MANUAL_MODES.map(function (mode) {
                return React.createElement('option', { key: mode, value: mode, children: t('mode.' + mode) })
              })
            })
          ]),
          React.createElement('div', { className: 'dse-panel__field' }, [
            React.createElement('label', { htmlFor: 'dse-browser', children: t('set.browserPolicy') }),
            React.createElement('select', {
              id: 'dse-browser',
              value: cfg.browserPolicy === 'allow' ? 'allow' : 'ask',
              onChange: function (event) {
                onPatch({ browserPolicy: event.target.value })
              },
              children: [
                React.createElement('option', { key: 'ask', value: 'ask', children: t('policy.ask') }),
                React.createElement('option', { key: 'allow', value: 'allow', children: t('policy.allow') })
              ]
            })
          ]),
          React.createElement('label', { className: 'dse-panel__check' }, [
            React.createElement('input', {
              type: 'checkbox',
              checked: cfg.showBadge,
              onChange: function (event) {
                onPatch({ showBadge: event.target.checked })
              }
            }),
            React.createElement('span', null, t('set.badge'))
          ]),
          React.createElement('div', { className: 'dse-panel__field' }, [
            React.createElement('label', { htmlFor: 'dse-urls', children: t('set.urlList') }),
            React.createElement('textarea', {
              id: 'dse-urls',
              className: 'dse-panel__textarea',
              rows: 2,
              placeholder: t('set.urlList.placeholder'),
              value: cfg.urlList || '',
              onChange: function (event) {
                onPatch({ urlList: event.target.value })
              }
            })
          ]),

          React.createElement('div', { className: 'dse-panel__hint', children: t('hint.changeReview') }),

          React.createElement(Diagnostics, { t: t })
        ]
      })
    }

    /**
     * 诊断日志：浏览器半侧读不了文件、也常常开不了 DevTools，
     * 所以把最近的事件直接摆在面板里。Agent 说「已展开」但侧栏没动时，
     * 打开这个面板看最后几行就知道卡在哪一步。
     */
    function Diagnostics(props) {
      var t = props.t
      var lines = useLogs()
      // 每秒重算一次「最近轮询 x 秒前」：面板打开时才跑，关了就没这个定时器。
      var tick = React.useState(0)
      React.useEffect(function () {
        if (typeof window.setInterval !== 'function') return undefined
        var timer = window.setInterval(function () {
          tick[1](function (value) {
            return value + 1
          })
        }, 1000)
        return function () {
          window.clearInterval(timer)
        }
      }, [])

      var health = bridgeHealth
      var bridgeLine = null
      if (health.started) {
        var age = health.lastPollAt ? Math.round((Date.now() - health.lastPollAt) / 1000) : -1
        // 短轮询间隔 1s：超过 10 秒没成功轮询，就可以认定通道断了。
        var stalled = age < 0 || age > 10
        bridgeLine = React.createElement('div', {
          key: 'bridge',
          className: 'dse-panel__hint' + (stalled ? ' dse-bridge--stalled' : ' dse-bridge--ok')
        }, t('dock.bridge') + '：' + (stalled ? t('dock.bridge.stalled') : t('dock.bridge.online'))
          + ' · ' + t('dock.bridge.poll') + ' ' + (age < 0 ? '—' : age + 's')
          + ' · ' + t('dock.bridge.cmds') + ' ' + health.commands
          + (health.lastOp ? '（' + health.lastOp + '）' : '')
          + (health.failures ? ' · ' + t('dock.bridge.failures') + ' ' + health.failures : '')
          + (health.resultFailures ? ' · ⚠ ' + t('dock.bridge.resultFailures') + ' ' + health.resultFailures : ''))
      } else {
        bridgeLine = React.createElement('div', {
          key: 'bridge',
          className: 'dse-panel__hint'
        }, t('dock.bridge') + '：' + t('dock.bridge.off'))
      }

      return React.createElement('div', null, [
        React.createElement('div', { className: 'dse-panel__divider', key: 'd' }),
        React.createElement('div', { className: 'dse-panel__caption', key: 'c' }, [
          React.createElement('span', null, t('dock.diagnostics')),
          React.createElement('button', {
            type: 'button',
            className: 'dse-panel__close',
            onClick: function () {
              probeBrowserFrame('手动')
            },
            children: t('dock.probe')
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dse-panel__close',
            onClick: clearLogs,
            children: t('dock.logs.clear')
          })
        ]),
        bridgeLine,
        lines.length === 0
          ? React.createElement('div', { className: 'dse-panel__hint', key: 'e', children: t('dock.logs.empty') })
          : React.createElement('div', {
              key: 'l',
              className: 'dse-panel__logs',
              ref: function (node) {
                if (node) node.scrollTop = node.scrollHeight
              }
            }, lines.slice(-24).map(function (line, index) {
              return React.createElement('div', { key: index, className: 'dse-panel__logline', children: line })
            }))
      ])
    }

    function SidebarDock(props) {
      var cfg = useConfig()
      var t = translator(props)
      var sessionId = props.sessionId
      var bridgeRef = React.useRef(null)
      var panelRef = React.useRef(null)
      var [open, setOpen] = React.useState(false)
      var [pos, setPos] = React.useState(null)

      // 面板改成 fixed + portal 之后，位置要自己算：贴着 dock 图标上方，
      // 并且横向夹在视口里，这样右侧栏展开时也不会被裁掉。
      React.useEffect(function () {
        if (!open) {
          setPos(null)
          return undefined
        }
        var measure = function () {
          var node = bridgeRef.current
          if (!node || typeof window === 'undefined') return
          var rect = node.getBoundingClientRect()
          var width = Math.min(320, Math.max(240, window.innerWidth - 16))
          var gap = 8
          var left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap))
          var bottom = Math.max(gap, window.innerHeight - rect.top + gap)
          setPos({ left: left, bottom: bottom, width: width })
        }
        measure()
        window.addEventListener('resize', measure)
        return function () {
          window.removeEventListener('resize', measure)
        }
      }, [open])

      React.useEffect(function () {
        if (!open) return undefined
        var onDown = function (event) {
          var anchor = bridgeRef.current
          var panel = panelRef.current
          // 面板在 portal 里，不在 anchor 子树内，两边都要判。
          if (anchor && anchor.contains(event.target)) return
          if (panel && panel.contains(event.target)) return
          setOpen(false)
        }
        var onKey = function (event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      var fire = function (kind) {
        var bridge = window[BRIDGE]
        if (!bridge || !bridge.open) return
        // dock 面板没有 Turn 上下文，复用最新一轮的产出，
        // 这样「浏览器」按钮能带本轮扫到的链接、而不是空地址栏。
        var held = latest && latest.sessionId === sessionId ? latest : null
        try {
          bridge.open({
            sessionId: sessionId,
            turn: held ? held.turn : null,
            kind: kind,
            data: held ? held.data : { changes: null, files: [], urls: [], intent: null },
            config: getConfig(),
            source: 'dock'
          })
        } catch (error) {
          // 忽略。
        }
        setOpen(false)
      }

      return React.createElement('div', {
        ref: bridgeRef,
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
        children: [
          React.createElement('button', {
            type: 'button',
            className: 'dse-dock' + (cfg.revealOnIntent !== false ? ' dse-dock--on' : ''),
            title: t('dock.title'),
            'aria-label': t('dock.label'),
            'aria-expanded': open,
            onClick: function () {
              setOpen(function (value) {
                return !value
              })
            },
            children: [
              React.createElement('span', { className: 'dse-dock__icon' }, React.createElement(IconWorkbench, null))
            ]
          }),
          // 授权拦截页：常驻在这里（自己 portal 到 body），跟面板开没开无关。
          React.createElement(ConsentPrompt, { key: 'consent', t: t }),
          // 面板走 portal + fixed 定位：它原来 absolute 挂在 composer 里，
          // 右侧栏一开就被主列裁掉一半（用户报的「设置页被侧栏挡住」）。
          open && pos
            ? ReactDOM.createPortal(
                React.createElement('div', {
                  ref: panelRef,
                  className: 'dse-panel-host',
                  style: {
                    position: 'fixed',
                    left: pos.left + 'px',
                    bottom: pos.bottom + 'px',
                    width: pos.width + 'px',
                    zIndex: 2147483000
                  }
                }, React.createElement(Panel, {
                  cfg: cfg,
                  t: t,
                  onClose: function () {
                    setOpen(false)
                  },
                  onOpen: fire,
                  onPatch: writeConfig
                })),
                document.body)
            : null
        ]
      })
    }

    // ============================================================
    // 插件主体
    // ============================================================

    var INJECT = [
      'slots',
      'locale',
      'uiConversation',
      'sidebarRight',
      'layout'
    ]

    function apply(ctx) {
      var t = ctx.locale.bind(NS)
      LOCALE_T = t
      ensureStyle()

      window[BRIDGE] = {
        sidebar: ctx.sidebarRight,
        layout: ctx.layout,
        getConfig: getConfig,
        setConfig: writeConfig,
        isExpanded: isExpanded,
        currentSessionId: currentSessionId,
        resolveKind: resolveKind,
        open: openPanel,
        reveal: openPanel,
        logs: logsSnapshot,
        probe: probeBrowserFrame,
        // 给测试与手动排查用的入口
        handleCommand: handleCommand,
        runBrowserOp: runBrowserOp,
        consentState: function () {
          return consentRequest
        },
        // 通道健康度：通道一断，「最近轮询」就停住不动了，不用等 150s 超时才知道
        health: function () {
          return bridgeHealth
        },
        // 测试用：把页面脚本超时调小，才能在测试里驱动「脚本被导航打断」的路径
        pageScriptTimeout: function (ms) {
          if (Number(ms) > 0) PAGE_SCRIPT_TIMEOUT_MS = Number(ms)
        }
      }
      dseLog('plugin apply: sidebarRight=' + (ctx.sidebarRight ? 'ok' : '缺失') + ' layout=' + (ctx.layout ? 'ok' : '缺失'))
      // 让宿主侧确认文件日志通道是否活着（这条会经 POST 落到 sidebar-enhance.log）。
      dseLog('节点 ' + (window.location && window.location.hostname)
        + ' · client 协议 v' + PROTOCOL + ' · 日志通道 ' + LOG_ENDPOINT)

      // 启动后自动探一次侧栏浏览器（只读）。侧栏的浏览器 tab 是 keepMounted 的，
      // 上次开过的话这会儿就已经在 DOM 里；没开过就等用户开（面板里有手动按钮）。
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(function () {
          probeBrowserFrame('启动')
        }, 5000)
      }

      // 告诉宿主「我是谁、策略是什么」，然后开始拉命令。
      reportState()
      startCommandLoop()

      // 文案
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-sidebar-enhance: locale')

      // 折会话事件
      ctx.effect(function () {
        return ctx.uiConversation.events.register(sidebarDefinition)
      }, 'dsh-sidebar-enhance: conversation definition')

      // 轮次尾部：自动展开 + 产出徽章
      ctx.effect(function () {
        return ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: ENTRY_ID,
              order: 40,
              locale: NS,
              label: function () {
                return t('badge.label')
              }
            },
            SidebarTail
          )
        })
      }, 'dsh-sidebar-enhance: turn-tail entry')

      // composer 下方：常驻面板
      ctx.effect(function () {
        return ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: ENTRY_ID,
              order: 20,
              locale: NS,
              label: function () {
                return t('dock.title')
              }
            },
            SidebarDock
          )
        })
      }, 'dsh-sidebar-enhance: composer dock entry')

      // 快捷键：打开侧栏 / 切换自动展开
      ctx.inject(['shortcuts'], function (scope) {
        scope.effect(function () {
          return scope.shortcuts.register({
            id: 'sidebar-enhance.reveal',
            label: function () {
              return t('shortcut.reveal')
            },
            aliases: ['sidebar-enhance', 'sidebar', 'files', 'terminal'],
            defaults: {
              'desktop:macos': { code: 'KeyP', modifiers: ['primary', 'shift'] },
              'desktop:windows': { code: 'KeyP', modifiers: ['primary', 'shift'] },
              'desktop:linux': { code: 'KeyP', modifiers: ['primary', 'shift'] },
              'web:macos': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt'] },
              'web:windows': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt'] }
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: function (context) {
              var element = context && context.target
              var sidebar = ctx.sidebarRight
              var target = sidebar && typeof sidebar.commandTarget === 'function' ? sidebar.commandTarget(element) : undefined
              if (target === undefined) {
                return { status: 'blocked', reason: t('shortcut.noSession') }
              }
              return {
                status: 'handled',
                run: function () {
                  var config = getConfig()
                  if (typeof sidebar.openTabFromTarget === 'function') {
                    try {
                      sidebar.openTabFromTarget(resolveKind(config.mode, { changes: null, urls: [] }, config), target)
                      return
                    } catch (error) {
                      // 落到 openPanel。
                    }
                  }
                  // 兜底带最新一轮产出，browser 才能带上链接而不是空地址栏。
                  var held = latest && latest.sessionId === currentSessionId() ? latest : null
                  try {
                    openPanel({
                      sessionId: held ? held.sessionId : currentSessionId(),
                      turn: held ? held.turn : null,
                      kind: resolveKind(config.mode, { changes: null, urls: [] }, config),
                      config: config,
                      data: held ? held.data : { changes: null, files: [], urls: [], intent: null }
                    })
                  } catch (error) {
                    // 忽略。
                  }
                }
              }
            }
          })
        }, 'dsh-sidebar-enhance: reveal shortcut')

        scope.effect(function () {
          return scope.shortcuts.register({
            id: 'sidebar-enhance.toggle-auto',
            label: function () {
              return t('shortcut.toggleAuto')
            },
            aliases: ['sidebar-enhance auto', 'auto reveal'],
            defaults: {
              'desktop:macos': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt'] },
              'desktop:windows': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt'] },
              'desktop:linux': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt'] },
              'web:macos': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt', 'ctrl'] },
              'web:windows': { code: 'KeyP', modifiers: ['primary', 'shift', 'alt', 'ctrl'] }
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: function () {
              return {
                status: 'handled',
                run: function () {
                  writeConfig({ revealOnIntent: getConfig().revealOnIntent === false })
                }
              }
            }
          })
        }, 'dsh-sidebar-enhance: toggle shortcut')
      })
    }

    exports.apply = apply
    exports.inject = INJECT
    return module.exports
  }
})
