/**
 * dsh-sidebar-enhance —— 浏览器桥（**宿主半侧**）。
 *
 * 目的：让模型能用上侧栏自带那个「浏览器」tab —— 读页面、找元素、点击输入、导航。
 *
 * ## 为什么需要一条通道
 *
 * 工具跑在宿主（Electron 主进程 spawn 出来的 node 子进程），而 DOM 动作只能发生在
 * 渲染进程（侧栏那个浏览器 tab 是真的 Electron `<webview>`）。宿主**拿不到 Electron API**，
 * 所以两边必须通信。方向只有一个：**客户端能连宿主的 HTTP 路由**（日志通道已经在用），
 * 宿主连不到客户端。因此做成**客户端每秒短轮询拉命令、POST 回结果**：
 *
 * ```
 * 工具 execute ──enqueue──▶ 队列 ──GET /command（立即返回）──▶ client 执行 DOM 动作
 *      ▲                                                          │
 *      └──────────── POST /result {id, ok, data} ─────────────────┘
 * ```
 *
 * ## 授权（用户要求的模型）
 *
 * 导航（打开 tab）不需要授权——那是用户看得见的事；**读页面 / 交互需要用户明确同意**。
 * 需要授权时命令里带 `needsConsent`，客户端弹三按钮拦截页：
 *
 * | 用户选 | 效果 |
 * |---|---|
 * | 允许此次访问 | `once`：本会话在 `ONCE_TTL_MS` 内免问 |
 * | 始终允许访问 | `session`：本会话**一直**免问，进程重启即失效 |
 * | 不允许此次访问 | 客户端关掉那个浏览器 tab，工具回执说明被拒 |
 *
 * 授权按 **SessionId** 绑（`exec.agent.id`），所以**不会影响其它会话**。
 * 另有全局策略 `browserPolicy`（客户端设置项里持久化，随 `/state` 报上来）：
 * `ask`（默认，每次问）/ `allow`（始终允许，完全不问）。
 */

/** 工具整体预算：客户端拿到命令后最多等这么久（含等用户授权）。 */
const COMMAND_TIMEOUT_MS = 150_000;

/** 「允许此次访问」的有效期。 */
const ONCE_TTL_MS = 10 * 60 * 1000;

const OPS = { read: true, find: true, act: true, navigate: true };

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param env - 宿主侧依赖（由 lib/index.js 注入）
 * @param env.log - 写日志（会落到同一个 sidebar-enhance.log）
 * @param env.isLoopback - 请求来源是否本机
 * @param env.readBody - 读请求体
 * @param env.API_PREFIX - 路由前缀
 */
export function createBrowserBridge(env) {
  const { log, isLoopback, readBody, API_PREFIX } = env;

  /** 已派发但还没回结果的命令：id → { resolve, timer, sessionId, op } */
  const pending = new Map();
  /** 尚未被短轮询取走的命令，先到先得。 */
  const queue = [];

  /** 授权：once 是「本次访问」，session 是「本会话内始终允许」。 */
  const grants = { once: new Map(), session: new Set() };

  /** 客户端报上来的状态：当前会话 / 回合 / 设置。 */
  let clientState = { sessionId: null, turn: null, config: {} };

  let seq = 0;
  let dispatched = 0;
  let denied = 0;

  function writeJson(res, status, value) {
    try {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    } catch {
      // 连接已断。
    }
  }

  function parseJson(text) {
    try {
      const value = JSON.parse(text);
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** 结果里不属于通道控制的字段——旧客户端把结果摊平回传时，靠它把内容捞回来。 */
  function collectData(body) {
    const rest = {};
    let found = false;
    for (const key of Object.keys(body)) {
      if (key === "id" || key === "ok" || key === "denied" || key === "error") continue;
      rest[key] = body[key];
      found = true;
    }
    return found ? rest : null;
  }

  /** 结果摘要：只给字段与体积，不要把整页正文倒进日志。 */
  function summarize(value) {
    if (value === null || value === undefined) return "data=null";
    const keys = Object.keys(value);
    let size = -1;
    try {
      size = JSON.stringify(value).length;
    } catch {
      // 不可序列化，忽略。
    }
    return `data{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}} ${size}B`;
  }

  // ---------------------------------------------------------------- 授权

  function policy() {
    const value = clientState.config && clientState.config.browserPolicy;
    return value === "allow" ? "allow" : "ask";
  }

  /** 这个会话现在能不能直接用浏览器。 */
  function isGranted(sessionId) {
    if (policy() === "allow") return true;
    if (sessionId && grants.session.has(sessionId)) return true;
    const until = sessionId ? grants.once.get(sessionId) : undefined;
    return typeof until === "number" && until > Date.now();
  }

  function grant(sessionId, scope) {
    if (!sessionId) return;
    if (scope === "session") {
      grants.session.add(sessionId);
      grants.once.delete(sessionId);
      log(`授权: 会话 ${sessionId} 已「始终允许」（仅本进程有效）`);
      return;
    }
    grants.once.set(sessionId, Date.now() + ONCE_TTL_MS);
    log(`授权: 会话 ${sessionId} 「允许此次访问」，有效期 ${Math.round(ONCE_TTL_MS / 60000)} 分钟`);
  }

  /** 诊断用的一行摘要（不发密钥，只发计数）。 */
  function grantsSummary() {
    return `策略=${policy()} 本会话授权=${grants.session.size} 临时授权=${grants.once.size}`;
  }

  // ---------------------------------------------------------------- 通道

  /**
   * 派一条命令给客户端并等结果。
   * @returns 客户端回的结果对象，或 `{ timeout: true }` / `{ aborted: true }`
   */
  function enqueue(command, signal) {
    return new Promise((resolve) => {
      seq += 1;
      const id = `cmd-${seq}`;
      const payload = Object.assign({ id }, command);
      dispatched += 1;

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        const entry = pending.get(id);
        if (entry) clearTimeout(entry.timer);
        pending.delete(id);
        resolve(value);
      };

      const timer = setTimeout(() => {
        log(`超时: ${command.op} id=${id}（客户端 ${COMMAND_TIMEOUT_MS / 1000}s 内没回结果）`);
        finish({ timeout: true });
      }, COMMAND_TIMEOUT_MS);

      pending.set(id, { resolve: finish, timer, sessionId: command.sessionId, op: command.op });

      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => {
          log(`取消: ${command.op} id=${id}`);
          finish({ aborted: true });
        }, { once: true });
      }

      log(`→ client ${command.op} id=${id}${command.needsConsent ? " 需授权" : ""} ${JSON.stringify(command.args || {}).slice(0, 160)}`);

      // 短轮询下不需要「唤醒」谁：命令进队列，客户端一秒内自取。
      queue.push(payload);
    });
  }

  /**
   * 拉命令：**立即返回**，有命令给命令，没命令回 `{}`。
   *
   * ★ 最早这里是长轮询（没命令就挂 20s）。真实事故：客户端执行成功、POST 结果，
   *   宿主却收不到，之后整个通道静默死亡——唯一让请求「挂起不结束」的就是长轮询，
   *   自定义协议（dsh-app://app）对挂起响应流的处理是我们控制不了的黑盒。
   *   换成客户端每秒短轮询后，每个请求都是毫秒级完成，这一类问题整个消失，
   *   代价只是命令分发最多晚 1 秒——浏览器操作本身就要好几秒，无所谓。
   */
  function pollRoute() {
    return {
      kind: "exact",
      path: `${API_PREFIX}/command`,
      handler(req, res) {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: "loopback-only" });
          return;
        }
        if (req.method !== "GET") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        const ready = queue.shift();
        writeJson(res, 200, ready === undefined ? {} : ready);
      },
    };
  }

  /** 客户端回结果。 */
  function resultRoute() {
    return {
      kind: "exact",
      path: `${API_PREFIX}/result`,
      async handler(req, res) {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: "loopback-only" });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        const body = parseJson(await readBody(req));
        if (!body || typeof body.id !== "string") {
          writeJson(res, 400, { error: "bad payload" });
          return;
        }
        const entry = pending.get(body.id);
        if (!entry) {
          // 命令已超时/被取消后才收到结果。必须留痕——「结果丢了但宿主不知道」
          // 正是那次通道事故里最难查的部分。
          log(`⚠ 收到迟到结果 ${String(body.id).slice(0, 24)}（对应命令已超时或取消），已丢弃`);
          writeJson(res, 200, { ok: true, stale: true });
          return;
        }
        if (body.denied) denied += 1;
        // data 是约定的结果载体。客户端若把结果摊平回传（没有 data 字段），
        // 这里兜住：把除控制字段以外的部分收成 data，别让它退化成 null
        // ——那次事故就是这么发生的：一切日志都写着「成功」，模型拿到字符串 "null"。
        const data = body.data !== undefined ? body.data : collectData(body);
        log(`← client ${entry.op} id=${body.id} `
          + (body.denied ? "被拒绝" : body.ok ? `成功 ${summarize(data)}` : `失败: ${String(body.error || "").slice(0, 200)}`));
        if (body.ok && (data === null || data === undefined)) {
          log(`⚠ ${entry.op} id=${body.id} 成功但没有 data（客户端没把结果放进 data 字段），模型会拿到空结果`);
        }
        entry.resolve({
          ok: Boolean(body.ok),
          denied: Boolean(body.denied),
          data: data === undefined ? null : data,
          // ★ 这里原来是 `body.error === undefined ? null : String(body.error)`，
          //   而客户端会把「失败但没有原因」回成 JSON null —— String(null) 变成字符串 "null"，
          //   最后模型收到的是「浏览器操作失败: null」。null 必须原样留着，不能字符串化。
          error: body.error === undefined || body.error === null ? null : String(body.error),
        });
        writeJson(res, 200, { ok: true });
      },
    };
  }

  /** 客户端报授权决定。 */
  function consentRoute() {
    return {
      kind: "exact",
      path: `${API_PREFIX}/consent`,
      async handler(req, res) {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: "loopback-only" });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        const body = parseJson(await readBody(req));
        if (!body || typeof body.id !== "string") {
          writeJson(res, 400, { error: "bad payload" });
          return;
        }
        const entry = pending.get(body.id);
        const sessionId = typeof body.sessionId === "string" && body.sessionId !== ""
          ? body.sessionId
          : (entry && entry.sessionId) || null;
        grant(sessionId, body.scope === "session" ? "session" : "once");
        writeJson(res, 200, { ok: true, sessionId, summary: grantsSummary() });
      },
    };
  }

  /** 客户端报状态（当前会话 / 回合 / 设置）。 */
  function stateRoute() {
    return {
      kind: "exact",
      path: `${API_PREFIX}/state`,
      async handler(req, res) {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: "loopback-only" });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method not allowed" });
          return;
        }
        const body = parseJson(await readBody(req));
        if (body) {
          clientState = {
            sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
            turn: typeof body.turn === "number" ? body.turn : null,
            config: isPlainObject(body.config) ? body.config : {},
          };
        }
        writeJson(res, 200, { ok: true });
      },
    };
  }

  function routes() {
    return [pollRoute(), resultRoute(), consentRoute(), stateRoute()];
  }

  // ---------------------------------------------------------------- 回执

  function text(value) {
    return { text: value };
  }

  function stringify(value, limit = 12_000) {
    try {
      const text_ = JSON.stringify(value, null, 2);
      return text_.length > limit ? text_.slice(0, limit) + "\n…（已截断）" : text_;
    } catch {
      return String(value);
    }
  }

  function receipt(op, result) {
    if (!result || result.aborted) {
      return text("已取消：这一轮被中止了，浏览器操作没有执行。");
    }
    if (result.timeout) {
      return text(
        "浏览器端没有响应（等待超过 " + Math.round(COMMAND_TIMEOUT_MS / 1000) + " 秒）。"
        + "可能原因：桌面端侧栏的浏览器桥没加载（需要完全退出并重启桌面端，刷新页面不够），"
        + "或者用户一直没处理授权弹窗。不要立刻重试。"
      );
    }
    if (result.denied) {
      return text(
        "用户拒绝了对侧栏浏览器的访问（那个浏览器 tab 已被关闭）。"
        + "不要重复调用：改为在回复里说明你需要访问页面，请用户在插件设置里放开或再点一次授权。"
      );
    }
    if (!result.ok) {
      // 兜底：失败回执永远要带得出可诊断的原因，绝不再出现「失败: null」这种零线索文案。
      // 另外把 data 明细一并带上——act 的失败原因可能在 results[i] 里，
      // 只看顶层 !ok 就 return 会把「找不到元素」这类关键信息整包丢掉。
      const reason = String(
        result.error || "未知错误（客户端没有上报原因；看插件诊断日志里带 ⚠ 的那一行）"
      );
      const detail = result.data === null || result.data === undefined
        ? ""
        : "\n明细: " + stringify(result.data, 1500);
      return text("浏览器操作失败: " + reason + detail);
    }
    if (result.data === null || result.data === undefined) {
      // 以前这里会 stringify(null) 得到字符串 "null"——模型看到一个 null 却没有任何线索，
      // 会误判成「页面没读到」。宁可说清楚，也不要给一个假的空值。
      return text(
        "浏览器操作执行成功，但没有拿到内容（结果为空）。"
        + "先调 browser_navigate 打开页面，再调本工具；若仍为空，看插件诊断日志里带 ⚠ 的那一行。"
      );
    }
    return text(stringify(result.data));
  }

  // ---------------------------------------------------------------- 工具

  function runTool(op, args, exec) {
    const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null;
    const needsConsent = !isGranted(sessionId);
    return enqueue({ op, args: args || {}, sessionId, needsConsent }, exec && exec.signal)
      .then((result) => receipt(op, result));
  }

  const output = {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    render: (_args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
  };

  const CONSENT_NOTE =
    "注意：侧栏浏览器受用户授权保护。用户还没同意时，第一次调用会在他那边弹出授权按钮，"
    + "本工具会一直等到他点（最长约 2 分钟）再返回结果——所以调用后不要重复调用同一个工具，"
    + "耐心等结果。如果返回「用户拒绝」，不要说「我再看一下」然后重试；"
    + "改为在回复里说明你需要访问页面、请用户授权。";

  function definitions() {
    return [
      {
        name: "browser_read",
        description:
          "读取侧栏浏览器当前页面：标题、URL、正文文本、链接列表和可交互控件。"
          + "要基于网页内容回答问题、或确认某次点击/输入之后页面变成了什么样，都用它。"
          + "页面还没打开时先调 browser_navigate。"
          + "注意：链接列表里的 href 是解析后的绝对地址，不能直接拿去拼 CSS 选择器，"
          + "要点击请用 browser_find 拿 path。" + CONSENT_NOTE,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxChars: {
              type: "number",
              description: "正文最多返回多少字符（默认 6000，上限 20000）。内容很长时用 browser_find 精确定位。",
            },
          },
        },
        execute: (args, exec) => runTool("read", args, exec),
      },
      {
        name: "browser_find",
        description:
          "在侧栏浏览器当前页面里找元素。给 selector（CSS 选择器）或 query（页面上可见的文字），"
          + "返回匹配元素的 CSS 路径、文字、关键属性和几何位置——它的 path 可以直接拿去 browser_act 用。"
          + "比 browser_read 精确定位、也更省上下文。"
          + "【★ 用 path，别拿 href 反查】返回的 attrs.href 是**解析后的绝对地址**（DOM 的 el.href），"
          + "而页面源码里常写相对路径（如 /），所以拿它拼 a[href=\"…\"] 大概率匹配不到。"
          + "要点击某个元素就用它返回的 path。" + CONSENT_NOTE,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string", description: "CSS 选择器，例如 button[type=submit] 或 #login。与 query 二选一。" },
            query: { type: "string", description: "页面上看得见的文字，例如「登录」。与 selector 二选一。" },
            limit: { type: "number", description: "最多返回几个匹配（默认 8，上限 20）。" },
          },
        },
        execute: (args, exec) => runTool("find", args, exec),
      },
      {
        name: "browser_act",
        description:
          "在侧栏浏览器当前页面里操作：点击、输入、选择、按键、滚动、等待。按顺序执行 actions 数组，"
          + "返回每个动作的成功/失败，以及结束时的 URL 和标题（需要确认结果就接着调 browser_read）。"
          + "selector 用 browser_find 拿到的 path 最稳。"
          + "【点击默认原地跳转】click 不会开新 tab（链接的 target=_blank 会被拉回本 tab）；"
          + "要新开必须显式传 newTab:true。"
          + "【不要重复点击】点击后本工具会等页面跳转发生再返回（最多约 1.2 秒）；"
          + "若返回「页面正在跳转」，不要以为失败而再点一次——改用 browser_read 看当前页面是哪里。"
          + CONSENT_NOTE,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            actions: {
              type: "array",
              description: "按顺序执行的动作列表。",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: {
                    type: "string",
                    description: "click / type / fill / select / press / scroll / wait。"
                      + "fill = 覆盖输入框（推荐）；type = 追加输入；press = 发一次按键。"
                      + "注意 press 发的是合成键盘事件，浏览器不一定会执行默认动作"
                      + "（例如 Enter 提交表单可能不触发）——能点按钮就点按钮。",
                  },
                  newTab: {
                    type: "boolean",
                    description:
                      "仅 click 有效，默认 false。默认**在当前 tab 原地跳转**：目标链接的 "
                      + "target=_blank 会被临时改回 _self，不会冒出新 tab。"
                      + "只有确实需要新开一个 tab 时才传 true。",
                  },
                  selector: { type: "string", description: "目标元素的 CSS 选择器（press 可省略，默认当前聚焦元素）。" },
                  text: { type: "string", description: "type / fill 要写入的文本。" },
                  value: { type: "string", description: "select 要选中的值。" },
                  key: { type: "string", description: "press 的键名，默认 Enter。" },
                  y: { type: "number", description: "scroll 的纵向像素，正数向下（默认 600）。" },
                  ms: { type: "number", description: "wait 的毫秒数（默认 500，上限 5000）。" },
                  replace: { type: "boolean", description: "type 时是否先清空（等同 fill）。" },
                },
                required: ["type"],
              },
            },
          },
          required: ["actions"],
        },
        execute: (args, exec) => runTool("act", args, exec),
      },
      {
        name: "browser_navigate",
        description:
          "把侧栏浏览器导航到一个地址（已有浏览器 tab 时在**原 tab 原地跳转**，没有才新开）。"
          + "【用途：你自己要用这个网页】查资料、验证刚写的页面渲染得对不对、前端 debug、"
          + "点一下看交互结果——打开之后用 browser_read 把内容读回来，你拿得到页面内容。"
          + "【不是交付工具】要把做好的网页展示给用户看，用 sidebar_reveal(mode=browser)："
          + "那个把页面摆到用户眼前就够了，本工具不会把内容交给用户。"
          + "两者不冲突：先用这里调试验证，收尾再用 reveal 展示。" + CONSENT_NOTE,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: {
              type: "string",
              description: "必须 http:// 或 https:// 开头，例如 https://www.bing.com/search?q=dsh。",
            },
          },
          required: ["url"],
        },
        execute: (args, exec) => runTool("navigate", args, exec),
      },
    ].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output,
      timeoutMs: COMMAND_TIMEOUT_MS + 30_000,
      execute: definition.execute,
    }));
  }

  /** 给系统提示词用的一段说明（含授权流程，避免模型乱重试）。 */
  const guidance =
    "本机还装了 sidebar-enhance 的浏览器桥：侧栏自带一个浏览器 tab，你可以通过 "
    + "browser_navigate / browser_read / browser_find / browser_act 四个工具真正地使用它——"
    + "打开网址、读页面内容、点击和输入。"
    + "【★ 这是「你自己要用」的那套，不是交付工具】页面内容会返回给你，"
    + "所以它的典型用途是：查资料、验证你刚写的网页渲染得对不对、前端 debug、"
    + "点一下看交互结果、确认自己的改动在页面上真的生效了。"
    + "要把做好的网页**展示给用户看**，用 sidebar_reveal(mode=browser)——"
    + "那个只负责把页面摆到用户眼前，不返回内容，你也不必读它。"
    + "【什么时候用】需要查资料、需要看某个网页的实际内容、需要确认自己的操作在页面上生效时用它，"
    + "不要凭记忆猜网页内容。【顺序】先 browser_navigate 打开，再 browser_read 读，"
    + "要在页面上操作就先 browser_find 拿元素路径再 browser_act。【授权】"
    + "这套工具受用户授权保护：用户还没同意时会弹授权按钮，工具会等他点完再返回（最长约 2 分钟），"
    + "所以调用后耐心等、不要重复调用同一个工具；如果返回「用户拒绝」，"
    + "不要重试，改为在回复里说明你需要访问页面。";

  return {
    routes,
    definitions,
    guidance,
    isGranted,
    grantsSummary,
    stats: () => ({ dispatched, denied, pending: pending.size, queued: queue.length }),
  };
}
