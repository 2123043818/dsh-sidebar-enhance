# dsh-sidebar-enhance 端到端冒烟清单（E2E smoke）

> 用途：每次改完 `lib/*.js` 并重启桌面端后，用这 5 步确认**整条链路**还活着。
> 每步都写清了「怎么判成功」，不靠感觉。

---

## 前置：判定运行时是新代码（见 changelog-and-sync-rules.md §1.4）

```bash
grep -n "PROTOCOL = " lib/client.js lib/index.js          # 源码版本
grep "协议 v" logs/sidebar-enhance.log | tail -4          # 运行时版本
Get-ChildItem lib/*.js | Select LastWriteTime             # mtime vs 最后一次 host apply
```

两行协议版本必须**相同**，且 `lib/*.js` 的 mtime **早于** 最后一次 `host apply`。
不一致 → 先完全退出（含托盘）重启，**别在旧代码上分析现象**。

---

## 5 步冒烟

| # | 动作 | 判成功的依据 |
|---|---|---|
| 1 | `sidebar_reveal(mode=file, path=…)` | 侧栏切到文件 tab；日志出现 `意图展开 turn=N mode=file → 打开 file` |
| 2 | `browser_navigate(url)` | 回执带 `[原地跳转 loadURL]` 或 `[回落 openTab]`；日志 `浏览器桥 navigate → 成功` |
| 3 | `browser_read()` | 返回 `url/title/text/links/controls`；**links 里带 `target` 字段** |
| 4 | `browser_find(selector)` 拿 `path` → `browser_act(click)` | 回执含动作明细 `{ok:true, navigated, newTab}`；**不卡住、不返回 null** |
| 5 | `browser_read()` 复核 | URL 已变成目标页；`target="_blank"` 的链接**没有**开出新 tab（`newTab:false`） |

**失败要能说清原因**（v8.1 的底线）：

```
浏览器操作失败: 动作 click (#x) 失败: 找不到元素: #x
明细: { …, "failedIndex": 0 }
```

只出现「失败了但没有给出原因」而**没有**上面这种明细 → v8.1 的 `hoistActionFailure`
或宿主 `receipt` 的 `data` 明细被改掉了，回滚去看 changelog §4「别覆盖这些」。

---

## 授权三态（只有改过授权相关代码才需要重跑）

判定**只能靠日志**——工具返回值分不清「弹框后用户点了通过」和「压根没弹框直接放行」。

```
grep "授权: 请求用户确认" logs/sidebar-enhance.log
```

| 选项 | 期望 |
|---|---|
| 允许此次访问（once） | `ONCE_TTL_MS` 10 分钟后（`lib/browser.js:39`）**重新弹框** |
| 始终允许访问（session） | 进程内**不**随超时过期；**完全重启后重置** |
| 不允许（deny） | 当次被拒；无活动 tab 时走「没有活动 tab，无需关闭」而不是报错 |

---

## 本轮实测（2026-10-01 18:0x）

- 第 1 步：本文件本身
- 第 2~5 步：`browser_navigate` → GitHub → `find` 取 path → `act` 点击 → `read` 复核
- 结论：5 步全绿，无卡住、无 `null`、无多余 tab
