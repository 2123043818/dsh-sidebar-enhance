# DSH Plugin Hub 收录提交材料

> **状态：已提交（2026-10-03 20:2x）**
> Issue：[dshplugin/dsh-plugin-hub#85](https://github.com/dshplugin/dsh-plugin-hub/issues/85)
>
> 提交入口：https://github.com/dshplugin/dsh-plugin-hub/issues/new
> 收录要求原文：https://dsh-plugin.org/zh/submit

---

## 提交前自查（4 项已全部满足）

- [x] 仓库已公开 —— https://github.com/2123043818/dsh-sidebar-enhance
- [x] 已添加 GitHub topic：`dsh-plugin`（已通过 API 设置，另含 deepseek-harness / dsh / sidebar / browser-automation / ai-agent）
- [x] README 包含安装命令（`dsh plugin --profile desktop add github:2123043818/dsh-sidebar-enhance`）
- [x] 插件导出 `apply(ctx)` 模块（`lib/index.js:217`，符合 DSH Plugin 规范）

其他检查清单项：
- 一句话价值 ✅ ｜ 可复制安装命令 ✅ ｜ 截图 4 张 ✅
- 权限与风险声明 ✅ ｜ 能力分类 ✅ ｜ 许可证 MIT ✅

---

## Issue 标题

```
[插件提交] 2123043818/dsh-sidebar-enhance — 让 AI 自主用 DSH 侧栏展示成果并操作浏览器
```

## Issue 正文（可直接复制）

```markdown
### 仓库地址
https://github.com/2123043818/dsh-sidebar-enhance

### 一句话价值
安装后，AI 能在交付时主动展开 DSH 自带侧栏把成果摆到你眼前（文件 / 本轮 diff / 文件树 / 终端 / 网页），
并且能直接使用侧栏那个浏览器 tab 读页面、找元素、点击输入、导航来查资料 —— 全程由你在三按钮授权页上放行。

### 能力分类
工具与能力

### 安装命令
dsh plugin --profile desktop add github:2123043818/dsh-sidebar-enhance

### 兼容与运行要求
- **DSH 桌面端 0.2.0-rc2（官方）**：完整支持，开发与实测环境（Windows）
- **0.1.7-rc2 底（社区 Linux 套壳）**：侧栏展示功能实测可用；浏览器桥依赖 Electron `<webview>`，取决于壳的实现
- **dsh web（网页端）**：侧栏展示可用，浏览器桥不可用（无 `<webview>`）
- 只要 DSH 有侧栏，展示功能即可用；浏览器桥额外要求侧栏浏览器 tab 是 Electron `<webview>`
- 无外部服务依赖、无网络请求、不收集任何数据；插件只在本地运行

### 许可证
MIT
### 截图 / 演示
仓库 README 内含 4 张截图：侧栏自动展示成果、三按钮授权页、AI 用侧栏浏览器打开 GitHub、
点击链接后原 tab 原地跳转落地页。
https://github.com/2123043818/dsh-sidebar-enhance#readme

### 补充说明
**权限模型**（这是本插件最需要用户知情的地方）：
- 导航不需要授权（只是打开一个用户看得见的页面）；**读页面 / 交互需要授权**
- 授权页三按钮：允许此次（本会话 10 分钟内免问）/ 始终允许本会话（按 SessionId 绑，进程重启即失效）/ 不允许（立刻关掉 AI 正在用的那个 tab）
- 设置里另有全局策略 browserPolicy：ask（默认）/ allow
- 所有 HTTP 路由只接受本机回环来源请求
- 点击默认在原 tab 跳转（`target="_blank"` 会被临时拉回 `_self`），不会凭空开出一堆新 tab

**已知限制**：
- 只支持「已经在侧栏打开的那一页」，不能凭空控制任意窗口
- 没有截图工具（官方 AI 侧拿不到附件通道），观察走结构化 DOM
- 侧栏浏览器的内容对 AI 可见 —— README 里有明确的风险提示

**开发说明**：无构建步骤、无依赖、纯 ESM；`lib/client.js` 是手写 bundle。
仓库自带 124 条测试断言（`npm test`，不需要启动 dsh 即可跑）。
```

---

## 提交方式（二选一）

**A. 我代发** —— 用已授权的 GitHub 凭证直接创建 Issue（需要你点头）

**B. 你自己发** —— 打开下面链接，模板已预填，把上面正文粘进去：
https://github.com/dshplugin/dsh-plugin-hub/issues/new

---

## ✅ 已提交

2026-10-03 20:2x 经用户确认后由 AI 代发：**issue #85**
https://github.com/dshplugin/dsh-plugin-hub/issues/85

Issue 里的「兼容与运行要求」已包含三档版本信息（0.2.0-rc2 官方桌面端 / 0.1.7-rc2 社区
Linux 套壳 / dsh web），这是人工核实兼容性时最有用的依据。

---

## 收录之后

1. 插件会先显示 `unconfirmed`（已自动发现、待人工核实），社区核实后转 `verified`
2. README 里的收录徽章链接已按 `2123043818/dsh-sidebar-enhance` 写好，收录后自动生效
3. 元数据（Star / 更新时间 / README）自动同步，以后更新不用重复提交
