/**
 * dsh-sidebar-enhance —— Host 半侧。
 *
 * 两件事：
 *
 * 1. 注册 `sidebar_reveal` 工具。这个工具本身不做任何事：Agent 调用它时，
 *    dsh 会往 session 事件流写一条 `tool/call`，参数就是 { mode, url, index }。
 *    桌面端 lib/client.js 的 Conversation Event fold 监听 `tool/call`，
 *    看到 name === "sidebar_reveal" 就立刻驱动右侧栏打开对应的自带 tab
 *    （changes-review / files / terminal / browser）。
 *    Host→Client 不需要额外通道——tool/call 本身就是 session event。
 *
 * 2. **写文件日志**。浏览器半侧拿不到 fs（`require('fs')` 会命中模块表未命中并 throw，
 *    平台种子词只有 react / react-dom / cordis / ui-slots / ui-primitives），
 *    所以日志必须由这一侧落盘：客户端把行 POST 到 `${API_PREFIX}/log`。
 *    默认写 <插件目录>/logs/sidebar-enhance.log，可用环境变量 DSH_SIDEBAR_ENHANCE_LOG 覆盖。
 *    直接读文件：GET ${API_PREFIX}/log 返回尾巴。
 *
 * 3. **浏览器桥**（见 lib/browser.js）。宿主拿不到 Electron API，DOM 动作只能在渲染进程做，
 *    所以由客户端每秒短轮询 `${API_PREFIX}/command` 拉命令、POST `${API_PREFIX}/result` 回结果。
 *    授权按 SessionId 绑（`exec.agent.id`），读页面/交互前要用户点同意。
 *
 * 依赖：ctx.tools（注册工具）、ctx.webServer（注册路由）、ctx.systemPrompt（引导模型）。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserBridge } from "./browser.js";

export const inject = ["tools", "webServer", "systemPrompt"];

const MODES = { changes: true, files: true, file: true, terminal: true, browser: true };

/**
 * 协议版本，**必须与 lib/client.js 的 PROTOCOL 一致**。
 *
 * 两半的加载时机不同：client 随页面刷新热更，host 只在桌面端进程启动时加载。
 * 「改了 index.js 却没完全重启桌面端」就会出现旧的 host 校验、新的 client 执行：
 * 工具报 mode 清单里缺新项，而客户端侧一切正常。两半启动各打一行，
 * 对不上就是没重启（这是本项目已经踩过两次的坑）。
 */
const PROTOCOL = 10;

/** 路由前缀：客户端 POST 到 `${API_PREFIX}/log`。 */
const API_PREFIX = "/api/dsh-sidebar-enhance";

/** 单文件上限；超了就截断只留尾巴，避免日志无限长。 */
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;

/** 日志文件位置：插件目录下的 logs/，可用 DSH_SIDEBAR_ENHANCE_LOG 覆盖。 */
function resolveLogPath() {
  const override = process.env.DSH_SIDEBAR_ENHANCE_LOG;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // <插件>/lib
    return join(here, "..", "logs", "sidebar-enhance.log");
  } catch {
    return join(process.cwd(), "sidebar-enhance.log");
  }
}

const LOG_PATH = resolveLogPath();

/** 本地时间戳，方便和用户看到的时钟对齐。 */
function stamp() {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 落盘一行。任何失败都必须吞掉——日志坏了不能拖垮插件。 */
function appendLog(line) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    try {
      if (statSync(LOG_PATH).size > LOG_MAX_BYTES) {
        writeFileSync(LOG_PATH, "…[已截断]\n" + readFileSync(LOG_PATH, "utf8").slice(-LOG_KEEP_BYTES));
      }
    } catch {
      // 文件还不存在，跳过轮转。
    }
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // 忽略。
  }
}

/** 带时间戳的 host 侧日志。 */
function log(message) {
  appendLog(`${stamp()}  [host] ${message}`);
}

function writeText(res, status, body) {
  try {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  } catch {
    // 连接已断。
  }
}

/** 只允许本机写日志——这个口子不该暴露给局域网或隧道。 */
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * 日志路由。
 *   POST {API_PREFIX}/log   body 为若干行纯文本，逐行落盘
 *   GET  {API_PREFIX}/log   回读文件尾巴（不开 DevTools 也能用 curl 看）
 */
function logRoute() {
  return {
    kind: "exact",
    path: `${API_PREFIX}/log`,
    async handler(req, res) {
      if (!isLoopback(req)) {
        writeText(res, 403, "forbidden: loopback-only");
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        try {
          writeText(res, 200, readFileSync(LOG_PATH, "utf8").slice(-LOG_KEEP_BYTES));
        } catch {
          writeText(res, 200, "(no log yet)");
        }
        return;
      }
      if (req.method !== "POST") {
        writeText(res, 405, "method not allowed");
        return;
      }
      const body = await readBody(req);
      for (const line of body.split("\n")) {
        if (line.trim() !== "") appendLog(line);
      }
      writeText(res, 200, "ok");
    },
  };
}

const DESCRIPTION =
  "主动展开 dsh 桌面端右侧栏，把成果展示给用户看。在你希望用户「现在就看见」某个东西时调用。" +
  "侧栏会在你调用的当下就打开，不需要等这一轮结束，所以一轮里可以在多个节点重复调用。" +
  "【硬性要求】交付成果（改完文件、跑起服务、配好网站、生成关键产出）后必须调用它，" +
  "不要只在正文里让用户自己去点侧栏；除非用户明确说他不想看到侧栏弹出来。" +
  "mode：changes = 本轮文件改动 diff（本轮没有 workspace 改动时回退到 files）；" +
  "file = 打开一个具体文件，【必须同时给 path】，例 {\"mode\":\"file\",\"path\":\"src/index.ts\"}；" +
  "files = 工作区文件树；terminal = 新建终端；" +
  "browser = 打开网页，需要 url，例 {\"mode\":\"browser\",\"url\":\"http://localhost:3000\"}。" +
  "改了文件时优先用 file 指向最值得看的那个文件；本轮改了多个文件想看总览才用 changes。" +
  "【★ 本工具是「给用户看」，不是「你自己读」】它不返回文件内容或页面内容：" +
  "把成果摆到用户眼前就够了，你不需要再读一遍。" +
  "要自己读页面内容（查资料、验证刚写的网页、前端 debug、点一下看交互），" +
  "改用 browser_navigate + browser_read 那套，它们会把内容返回给你。" +
  "调用时机：在你要展示的东西已经存在之后再调用；不要在本轮一开始就调用。";

/** 系统提示词段在 tool-guidance 带里的排序位，取自 dsh-ssh 的同款用法。 */
const GUIDANCE_ORDER = 150;
const GUIDANCE_NAME = "plugin:dsh-sidebar-enhance";

/**
 * 面向模型的强制说明。
 *
 * 这比只写工具 description 强得多：description 只在模型考虑调工具时被读到，
 * 而这一段每轮都在系统提示词里。用户的诉求就是「别让我自己去点侧栏」，
 * 所以这里把「收尾必须调用」写成硬要求，并把唯一的例外讲清楚。
 */
const GUIDANCE =
  "本机已安装 dsh-sidebar-enhance 插件：它提供一个 sidebar_reveal 工具，可以驱动桌面端右侧栏。" +
  "【硬性要求】每当你要交付成果时——写完/改完文件、跑起服务、配好一个网站或应用、" +
  "生成本轮的关键产出——在结束这一轮之前【必须】调用 sidebar_reveal 把结果展示出来，" +
  "不要只在正文里说「你可以点开侧栏看」，用户要的是你主动打开。" +
  "【参数】只有 mode 是必填，但每个 mode 需要各自的配套参数，写错不会生效：" +
  "file【必须】同时给 path（例：{\"mode\":\"file\",\"path\":\"src/index.ts\"}）；" +
  "browser【必须】同时给 url（例：{\"mode\":\"browser\",\"url\":\"http://localhost:3000\"}）；" +
  "files / terminal / changes 不需要额外参数（例：{\"mode\":\"changes\"}）。" +
  "不要给 file 传 url、也不要给 browser 传 path——不匹配的参数会被忽略。" +
  "path 可以写工作区相对路径（src/index.ts）或绝对路径（F:/proj/src/index.ts）。" +
  "【怎么选 mode】改了文件 → 优先用 file 指向本次改动里最值得看的那个文件（用户能直接在侧栏看到内容）；" +
  "本轮改了多个文件、想看整体差异 → 用 changes（本轮 diff）；" +
  "要看整个工作区 → files；跑起了命令 / 服务 → terminal；做的是网页 → browser。" +
  "【★ 两条「打开网页」的路，别混用】本插件有两组都能打开网页的工具，用途完全不同：" +
  "① sidebar_reveal(mode=browser)＝**把页面摆到用户眼前**，是交付动作——" +
  "做完一个网页/应用、让用户自己看效果时用；它不返回页面内容，你**不需要**再读它，也不必等它加载。" +
  "② browser_navigate / browser_read / browser_find / browser_act＝**你自己要用这个网页**——" +
  "查资料、验证你刚写的页面渲染对不对、前端 debug、点一下看交互结果；" +
  "这套工具会把页面内容返回给你，所以打开之后要接着 browser_read。" +
  "同一个地址想两件事都做：先用 browser_* 自己调试验证，收尾再用 sidebar_reveal 展示给用户。" +
  "别用 reveal 去查资料（拿不到内容），也别用 browser_* 交付成果（用户不知道你在读什么）。" +
  "时机：在产物已经存在之后再调用（不要在本轮刚开头就调），并且一轮里可以在关键节点多次调用。" +
  "【唯一例外】用户明确表示不想看到侧栏自动弹出时，不要调用本工具。" +
  "另外：changes 模式的改动对比由 Host 提供，DSH 重启后那份摘要就不复存在（上游限制），" +
  "所以如果你希望用户之后还能回看，优先用 file 打开真实文件。";

export function apply(ctx) {
  log(`host apply: 协议 v${PROTOCOL} modes=${Object.keys(MODES).join(",")} tools=${ctx.tools ? "ok" : "缺失"} webServer=${ctx.webServer ? "ok" : "缺失"} systemPrompt=${ctx.systemPrompt ? "ok" : "缺失"} log=${LOG_PATH}`);

  const disposers = [];
  const browser = createBrowserBridge({ log, isLoopback, readBody, API_PREFIX });

  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    try {
      disposers.push(ctx.webServer.register(logRoute()));
      log(`已注册日志路由 ${API_PREFIX}/log`);
    } catch (error) {
      log(`注册日志路由失败: ${error && error.message ? error.message : error}`);
    }
    for (const route of browser.routes()) {
      try {
        disposers.push(ctx.webServer.register(route));
        log(`已注册路由 ${route.path}`);
      } catch (error) {
        log(`注册路由 ${route.path} 失败: ${error && error.message ? error.message : error}`);
      }
    }
  } else {
    log("webServer 不可用：文件日志与浏览器桥通道关闭（界面内的诊断日志仍在）");
  }

  // 让模型知道「收尾必须展示」——只靠工具 description 不够。
  let disposeGuidance;
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
    try {
      disposeGuidance = ctx.systemPrompt.section({
        name: GUIDANCE_NAME,
        order: GUIDANCE_ORDER,
        text: GUIDANCE + browser.guidance,
      });
      disposers.push(disposeGuidance);
      log("已注册系统提示词段 plugin:dsh-sidebar-enhance");
    } catch (error) {
      log(`注册系统提示词段失败: ${error && error.message ? error.message : error}`);
    }
  } else {
    log("systemPrompt 不可用：只能靠工具 description 引导模型");
  }

  if (disposers.length > 0 && typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 关闭期间路由 fiber 已经没了。
        }
      }
    }, "dsh-sidebar-enhance: log route");
  }

  if (!ctx.tools) {
    log("tools 不可用：sidebar_reveal 未注册");
    return;
  }

  ctx.tools.register({
    name: "sidebar_reveal",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          description:
            "要展示的内容。changes = 本轮的文件改动 diff（本轮没有 workspace 改动时会回退到 files）；" +
            "file = 打开一个具体文件（【必须】配合 path，缺了直接报错）；" +
            "files = 工作区文件树；" +
            "terminal = 新建终端；" +
            "browser = 在侧栏打开网页（配合 url）——这是**展示给用户看**的交付动作，"
            + "不返回页面内容；你自己要读页面内容（查资料 / 验证网页 / 前端 debug）请用 browser_navigate。"
        },
        path: {
          type: "string",
          description:
            "mode=file 时要打开的文件路径，【必填】，绝对或相对工作区均可，" +
            "例如 F:/dsh-plugins/demo/README.md 或 src/index.ts。" +
            "其他 mode 会忽略它；反过来，file 模式下只给 url 不给 path 是无效的。"
        },
        url: {
          type: "string",
          description:
            "mode=browser 时的起始地址，形如 https://example.com 或 http://localhost:3000。" +
            "未提供时浏览器 tab 以空地址栏打开。"
        },
        index: {
          type: "number",
          description:
            "mode=changes 时定位到第几个改动，从 0 开始，默认 0。改动较多时用它跳到最关键的那个。"
        }
      },
      required: ["mode"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } }
      },
      render: (_args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }]
    },
    async execute(args) {
      const mode = args && args.mode;
      // 关键诊断：这条能证明「模型确实调了工具、参数是解析好的对象」。
      // 客户端接着会打一条「意图展开 … → 打开 X」或「放弃」，两边对齐就能定位断点。
      log(`tool sidebar_reveal: ${JSON.stringify(args)}`);
      if (!MODES[mode]) {
        return { text: "错误: mode must be one of: " + Object.keys(MODES).join(", ") + " (got: " + mode + ")" };
      }
      const url = args.url == null ? null : String(args.url);
      if (mode === "browser" && url != null && !/^https?:\/\//i.test(url)) {
        return { text: "错误: url must start with http:// or https:// (got: " + url + ")" };
      }
      const filePath = args.path == null ? null : String(args.path);
      if (mode === "file" && (filePath == null || filePath.trim() === "")) {
        return {
          text: "错误: mode=file 必须同时给 path（要打开的那个文件），例如 "
            + '{"mode":"file","path":"src/index.ts"}。'
            + "只想让用户看整个工作区文件树，请改用 mode=\"files\"；"
            + "想看本轮多个文件的差异，请改用 mode=\"changes\"。"
        };
      }
      const index = args.index == null ? 0 : args.index;
      if (!Number.isFinite(index) || index < 0) {
        return { text: "错误: index must be a non-negative number (got: " + args.index + ")" };
      }
      // 真正的展开由 client 半侧的 fold 完成；这里只回执。
      // 回执不保证侧栏真的开了（那由桌面端决定），所以措辞用「已请求」。
      return {
        text: "已请求展开: mode=" + mode
          + (filePath == null ? "" : ", path=" + filePath)
          + ", url=" + (url == null ? "none" : url)
          + ", index=" + index
      };
    }
  });

  log("已注册工具 sidebar_reveal");

  // 浏览器桥的四个工具。它们都走 lib/browser.js 里的命令通道，
  // 真正干活的是渲染进程（侧栏那个 <webview>）。
  const browserTools = browser.definitions();
  const names = [];
  for (const definition of browserTools) {
    try {
      ctx.tools.register(definition);
      names.push(definition.name);
    } catch (error) {
      log(`注册工具 ${definition.name} 失败: ${error && error.message ? error.message : error}`);
    }
  }
  log(`已注册浏览器工具 ${names.length}/${browserTools.length}: ${names.join(", ")}`);
}
