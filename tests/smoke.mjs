/**
 * dsh-sidebar-enhance 冒烟测试。
 *
 * 用假的 __ModuleLoader__ + 假 React 真跑一遍客户端 factory，然后：
 *   1. 模块必须向 loader 注册 entry 且导出 apply / inject；
 *   2. 模块体不许污染全局 console（这是上一版把 dsh 卡死在 Loading 的元凶：
 *      console.log → debugLog → console.log 无限递归 → RangeError）；
 *   3. 模块不许 require 出平台种子词以外的东西（浏览器半侧拿不到 fs 之类）；
 *   4. apply() 能注册 fold 与两个 slot 而不抛错。
 *
 * 用法：
 *   node _backup/smoke.mjs                          # 默认测 ../lib/client.js
 *   node _backup/smoke.mjs <path/to/client.js>      # 测指定文件
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? resolve(here, '..', 'lib', 'client.js'))

const entries = []
globalThis.window = {
  __ModuleLoader__: { load: (entry) => entries.push(entry) },
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { href: 'dsh-app://app/', origin: 'dsh-app://app', hostname: 'app' },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

// dsh 平台种子词（packages/client/web/src/seed.ts），其余一律 throw
const PLATFORM_SEEDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const required = []
const STUB = {}
const fakeRequire = (spec) => {
  required.push(spec)
  // 平台种子词在真实运行时一定拿得到，这里给个够用的桩；
  // 种子词以外的一律 throw，和 ClientModuleLoader 的同步 require 行为一致。
  if (PLATFORM_SEEDS.has(spec)) return spec === 'react' ? React : STUB
  throw new Error(`require("${spec}") missed the module table`)
}

const pristine = { ...console }
const say = pristine.log.bind(pristine)
const failures = []

await import(pathToFileURL(target).href)

if (entries.length === 0) failures.push('模块没有向 __ModuleLoader__ 注册任何 entry')
const entry = entries[0]

const mod = entry.factory(fakeRequire)

// 必须在 factory 跑完之后比对：污染发生在模块体里。
const leaked = Object.entries(pristine).filter(([key, fn]) => console[key] !== fn).map(([key]) => 'console.' + key)
if (leaked.length) failures.push('模块体污染了全局 console: ' + leaked.join(', '))

const foreign = required.filter((spec) => !PLATFORM_SEEDS.has(spec))
if (foreign.length) failures.push('require 了平台种子词以外的东西: ' + foreign.join(', '))

if (typeof mod.apply !== 'function') failures.push('没有导出 apply 函数')
if (!Array.isArray(mod.inject)) failures.push('没有导出 inject 数组')

const registered = []
const fakeCtx = {
  locale: { bind: () => (key) => key, register: () => () => {} },
  effect: (fn) => { fn() },
  inject: (_deps, fn) => fn({ effect: () => {}, shortcuts: { register: () => () => {} } }),
  slots: {
    inject: (_name, fn) => fn(),
    register: (definition, Component) => {
      registered.push({ slot: definition.name, id: definition.id, component: typeof Component === 'function' })
      return () => {}
    },
  },
  sidebarRight: {
    isExpanded: () => false,
    toggleExpanded: () => {},
    openTab: () => {},
    openResource: () => {},
    mounted: { getSnapshot: () => undefined },
  },
  layout: { openRightbar: () => {} },
  uiConversation: { events: { register: (definition) => { registered.push({ fold: definition.kind }); return () => {} } } },
}

try {
  mod.apply(fakeCtx)
} catch (error) {
  failures.push('apply() 抛错: ' + error.message)
}

say('target   =', target)
say('entry.id =', entry.id)
say('inject   =', JSON.stringify(mod.inject))
say('require  =', JSON.stringify(required))
say('注册     =', JSON.stringify(registered))

if (failures.length) {
  say('')
  say('SMOKE FAILED:')
  for (const failure of failures) say('  - ' + failure)
  process.exit(1)
}
say('')
say('SMOKE OK')
