# 使用体验问题与改进建议（Issue 汇总）

> 来源：实际使用 autobrowser 访问瑞数 6 站点（`https://pmos.ah.sgcc.com.cn/`）的实操体验 + 代码检查。
> 日期：2026-08-20
>
> 后续批次：[`usage-issues-2026-10-31.md`](usage-issues-2026-10-31.md)（抓取 HLS 视频流场景）。
>
> 归档说明：本文的「实际表现」「根因分析」「复现步骤」保留当时观察，不代表当前版本仍有相同行为。各 Issue 的「处理状态」与文末后续说明用于记录演进；现行使用方式以 README 和内置 skill 为准。

## 一、已确认的问题（Bug）

### Issue 1: HAR 导出配额报错，`--har-unlimited` 未真正生效

**处理状态**: 部分处理（已修 stop checkpoint 状态顺序，并在 quota/storage 导出失败时返回 `suggestedAction`；CDP body 配额兜底抓取仍待设计）

- **严重程度**: 高（影响 HAR 采集核心能力）
- **环境**: Windows / Chrome 151 / autobrowser 当前 main

**复现步骤**

1. `autobrowser network har start --har-unlimited`
2. 加载含大体积 JS 的页面（如瑞数 6 动态 JS，241KB）
3. `autobrowser network har stop`

**实际表现**

- `network har stop` 报 `Resource::kQuotaBytes quota exceeded`（`EXTENSION_COMMAND_ERROR`），HAR 无法导出。
- `network har status` 状态不一致：内存 `requestCount: 154` vs checkpoint `requestCount: 11`；`recording: false` 但 checkpoint 内 `recording: true`。

**根因分析**

- `harMaxBodyBytes = null` 只放宽了扩展侧阈值，CDP `Network.getResponseBody` 自身配额仍受限（`extension/background/network.ts:1070`）。
- stop 时内存态已复位为默认值，但 checkpoint 由 `writeHarCheckpoint` 写入，两者不同步。

**期望行为**

- `--har-unlimited` 应真正关闭 body 配额（如改用 fetch 兜底抓 body），或在超限时给出明确恢复路径。
- 内存态与 checkpoint 态保持一致。

---

### Issue 2: `eval` 命令行传参易触发语法错误，且无引导提示

**处理状态**: 已处理（CLI help 与页面 eval 语法错误会提示改用 `--file <path>` / `--stdin`）

- **严重程度**: 中（高频踩坑，已有 `--file` 规避方案）
- **环境**: 所有平台

**复现步骤**

1. 命令行直接执行含引号/逗号的 JS：
   ```
   autobrowser eval "JSON.stringify({a: 1, b: document.title})"
   ```

**实际表现**

- 报 `page evaluation failed: SyntaxError: Unexpected token ','`，未提示改用 `--file`/`--stdin`。

**期望行为**

- 语法错误时在 `suggestedAction` 中提示：改用 `--file <path>` 或 `--stdin` 传入复杂/多行源码，避免命令行转义干扰。

---

### Issue 3: SPA（hash 路由）页面 reload 等待语义不完整

**处理状态**: 已处理（`Page.navigatedWithinDocument` 会推进 pageEpoch，same-document/hash 导航可判定 committed；同时支持 `reload --wait-for url <pattern>` / `reload --wait-for selector <sel>`）

- **严重程度**: 中
- **环境**: 所有平台

**复现步骤**

1. 打开 hash 路由 SPA（如 `https://pmos.ah.sgcc.com.cn/#/outNet`）
2. `autobrowser reload --wait-until domcontentloaded`

**实际表现**

- 返回 `outcome: "partial"`、`settleReason: "navigation never committed"`。
- 对 hash 路由变更（`#/xxx`）不判定为 committed；对瑞数类"验证后重定向"页面，`--wait-until networkidle` 同样不可靠。

**期望行为**

- 增加面向结果的等待手段，如 `--wait-for url <pattern>`、`--wait-for selector <sel>`；
- reload 对 hash 路由能正确返回 committed。

---

### Issue 4: `network requests` 默认返回空，缺少引导

**处理状态**: 已处理（默认查询为空且未启用 `--all-tabs`/`--all-epochs` 时返回 `meta.suggestedAction`）

- **严重程度**: 低
- **环境**: 所有平台

**复现步骤**

1. 页面加载完成后执行 `autobrowser network requests --include-details`

**实际表现**

- 返回 `total: 0`（默认仅查当前 tab 当前 epoch），需显式 `--all-tabs --all-epochs` 才有数据；对新用户无任何提示。

**期望行为**

- `total: 0` 时在 meta 中提示历史请求可用 `--all-tabs --all-epochs` 查看。

---

### Issue 5: `cookies` 子命令命名不一致

**处理状态**: 已处理（CLI/MCP/扩展路由支持 `list` 作为 `get` 别名，help 已同步）

- **严重程度**: 低

**实际表现**

- 原 help 输出子命令为 `<get|set|clear|delete>`，但 `get` 的描述是 "List cookies"；执行 `cookies list` 会被拒。
- 现已支持 `cookies list` 作为 `cookies get` 别名，help 输出为 `<list|get|set|clear|delete>`。

**期望行为**

- 已将 `list` 作为 `get` 的别名，CLI/MCP/扩展路由统一映射到 cookies get 行为。

---

### Issue 6: Windows 下 `command-line.test.js` 存在 flaky 测试

**处理状态**: 已处理（`waitForServerStatus` 支持 abort，connect 竞争失败分支会被取消；本地多轮 command-line 测试已验证稳定）

- **严重程度**: 中（影响 CI 稳定性）

**实际表现**

- 同一文件 3 次运行失败项各不相同：connect 后台进程 / 临时目录截图 / snapshot role / regex 查询。
- 涉及后台进程启动、临时目录、端口占用等环境时序相关测试。

**期望行为**

- 定位并修复时序问题，或在 CI 上对已知 flaky 测试做 retry 标记。

## 二、后续状态说明

- Issue 1 仍按上方的「部分处理」记录：`--har-unlimited` 只取消 autobrowser 自身的 body 存储限额，不能绕过 CDP 配额；HAR 在 body 获取失败时仍导出，并在对应 entry 的 `response.content.comment` 中记录原因。checkpoint 状态顺序和错误建议已处理。
- Issue 2–6 均已有处理结论，不再把旧的改进清单作为现行待办。
- Page Epoch 与 stale reference 机器可读错误已经实现，包括 `STALE_ELEMENT_REF` / `STALE_FRAME_REF` 和重新 snapshot 的建议，不再是长期缺口。
- 其余持续事项以 `TODO.md` 为准，包括扩大显式目标协议覆盖、统一响应与错误码、补全 JSDoc 和框架组件示例。
