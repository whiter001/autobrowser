# 使用体验问题与改进建议（Issue 汇总）

> 来源：实际使用 autobrowser 访问瑞数 6 站点（`https://pmos.ah.sgcc.com.cn/`）的实操体验 + 代码检查。
> 日期：2026-08-20

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

**处理状态**: 部分处理（已新增 `reload --wait-for url <pattern>` / `reload --wait-for selector <sel>` 复用现有 wait 语义；hash reload 的 committed 判定仍待设计）

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

## 二、优化改进方向

### 高优先级

1. **修复 HAR 配额问题**（Issue 1）：
   - `--har-unlimited` 真正关闭 CDP body 配额；
   - 统一内存态与 checkpoint 态。
2. **eval 错误信息带修复建议**（Issue 2）：
   - 语法错误时提示改用 `--file`/`--stdin`（延续 `createPageEvaluationExceptionError` 的 `suggestedAction` 思路，引导改为换传入方式而非换方案）。
3. **SPA/反爬场景导航等待增强**（Issue 3）：
   - 增加 `--wait-for url` / `--wait-for selector` 等面向结果的等待。

### 中优先级

4. **`network requests` 首次查询引导**（Issue 4）。
5. **CLI 帮助文本一致性**（Issue 5）：已支持 `cookies list` 别名。
6. **稳定性**：排查 Windows flaky 测试（Issue 6）：已修 connect/status 竞争分支取消。

### 长期（与 TODO.md 一致）

- Snapshot Epoch 的 stale reference 机器可读错误。
- 统一 `--tab` / `--frame` 显式目标协议。
- 标准错误码系统 + 修复建议推广到全部命令。
- JSDoc 补全、连接断开恢复引导、React/Vue 组件操作示例。
