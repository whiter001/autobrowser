# TODO

## 多 AI Workspace 与标签页归属（设计）

目标：多个 AI 不需要知道彼此存在，也能共享当前浏览器、profile 和登录态，安全地新建或复用各自的目标页面；调用方绑定一次上下文后，后续命令无需反复携带 `--tab`。

### 设计约定

- **Workspace 是轻量调用方上下文，不是现有命名 session 的替代品。** 它隔离默认 tab、tab 归属和操作权限，但共享浏览器 profile、cookie 与登录态；现有 `--session` 继续负责完整环境隔离。
- **不再让 workspace 命令读写全局 `targetTabId`。** 每个 workspace 可以拥有多个 tab，但只维护自己的默认目标；未绑定目标时返回 `WORKSPACE_TARGET_REQUIRED`，不从现有标签中猜测。
- **复用已有页面必须显式且原子地附加。** `tab attach <tN>` 将未认领标签绑定到当前 workspace，保留登录、表单、筛选和滚动状态；已被其他 workspace 认领时返回 `TAB_BUSY`，不得静默接管。
- **租约只管理归属，不管理页面生命周期。** 释放、过期或调用方异常退出时只解除绑定，不刷新、关闭或重置页面；tab 关闭或浏览器重启后清理失效映射。
- **进程 ID 不能单独作为身份。** CLI 自身及直接父 shell 都可能是临时进程；自动身份必须结合稳定祖先进程的 PID、启动时间和终端/客户端 ID，并允许显式覆盖。无法可靠识别时应报错，不退回共享目标。
- **Workspace 不是跨用户安全认证机制。** 它用于本机多 Agent 的误操作隔离；全局扩展重载、relay 停止等管理命令仍可能影响所有 workspace。

### 命令与响应契约

- Workspace 身份优先级：`--workspace` > `AUTOBROWSER_WORKSPACE` > MCP 客户端连接上下文 > 自动调用方识别。
- 新增 `workspace current|list|release`，用于查看当前身份、诊断归属和显式回收；自动模式下首次使用时创建 workspace。
- 新增 `tab attach <tN> [--readonly]` / `tab detach [tN]`；`tab select` 只能选择当前 workspace 已拥有的标签。
- Workspace 无目标时，`open` 可以创建并绑定新 tab，`goto` 必须提示先 `tab attach` 或 `tab new`，避免意外改写已有页面。
- `tab list` 的 concise 结果增加 `workspace`、`attachment` 和 `attachable`；detailed 结果补充 `lastActiveAt` / `leaseExpiresAt`。未认领标签使用 `workspace:null`，不伪造归属。
- 所有响应继续回显实际 `tabHandle`，并增加实际 `workspace`；`TAB_BUSY` 的 details 至少包含 tab handle、占用方 workspace、附加模式和租约到期时间。
- 显式 `--tab` 不能绕过归属检查；readonly 附加只允许明确的只读命令。batch 子步骤、eval/run/CDP、media/network 和队列等待都必须继承同一 workspace，不能形成旁路。

### 实施计划

- [x] **P0：固化协议与兼容边界**
  - [x] 定义 Workspace、Attachment、调用方身份和错误码的 TypeScript 类型及 JSON schema。
  - [x] 在命令规格中补齐只读/写入/全局控制分类，确定哪些命令可在 readonly 模式下执行。
  - [x] 明确旧行为兼容策略：未启用 workspace 模式时维持现有目标选择；启用后禁止回退到全局 current tab。
  - [x] 设计 relay 重启后的 workspace/attachment 持久化，以及 Chrome tabId 失效后的清理规则。

- [x] **P1：实现 workspace 上下文与独立默认目标**
  - [x] 在 relay/扩展命令路由之间传递 workspace，并在 `extension/background/command-router.ts` 统一解析，禁止各命令自行读取共享目标。
  - [x] 实现 workspace 创建、查询、释放、目标绑定和多 tab 管理。
  - [x] 在命令入队时固定 workspace 与 tab，在执行时再次校验归属，覆盖 batch 和同 tab FIFO 队列。
  - [x] 审计 `close all`、`target clear`、`command reset` 等命令的作用域，避免清理或关闭其他 workspace 的资源。

- [x] **P2：实现已有标签复用与租约**
  - [x] 实现原子的 `tab attach` / `tab detach`，并发认领同一 tab 时只允许一个 workspace 成功。
  - [x] 实现 owned/readonly 权限、默认目标切换和 `TAB_BUSY` / `WORKSPACE_TARGET_REQUIRED` 恢复建议。
  - [x] 实现可配置租约与续约：CLI 命令和 MCP 活跃连接续约，长命令运行期间不得被其他调用方回收。
  - [x] 异常回收只解除 attachment；relay 重启、扩展重连、tab 关闭和浏览器重启后保持或清理映射的规则必须有测试。

- [x] **P3：接入无参数调用方识别**
  - [x] 实现显式参数和环境变量覆盖，并提供 `workspace current` 展示实际解析结果。
  - [x] MCP 按客户端连接绑定 workspace；重连时通过稳定客户端上下文恢复，不依赖临时进程 PID。
  - [x] CLI 自动识别组合稳定祖先 PID、进程启动时间和终端 ID，处理 PID 复用、临时 shell、后台任务及识别失败。
  - [x] 评估自动模式的默认启用时机；在迁移完成前保留显式配置和旧模式，避免静默改变单 Agent 用户的目标语义。

- [x] **P4：文档与端到端验收**
  - [x] 更新 CLI help、README、SKILL.md 和安装/升级说明，提供两个 AI 复用已有标签的完整示例。
  - [x] 模拟两个互不知情的调用方分别 attach 两个已有 tab，后续不携带 `--tab` 并行执行 snapshot、输入和导航，验证互不串台。
  - [x] 验证两个调用方同时 attach 同一 tab、readonly 写入拒绝、租约过期、异常退出和 relay 重启后的行为。
  - [x] 验证旧模式回归，以及 `bun run typecheck`、`bun run lint`、`bun test`、`bun run build:cli` 和 `bun run build:chrome` 全部通过。

### 非目标

- 不支持多个 workspace 对同一 tab 并发写入；需要协同时通过只读附加或显式释放后移交。
- 不在本期实现跨浏览器、跨机器的 workspace 同步。
- 不承诺隔离 `extension reload/reconnect`、`server stop` 等浏览器或 relay 级管理操作。

## 核心协议与 Agent 增强 (Agent-First Design)

- [x] **统一目标定位协议**
  - [ ] 确保所有命令都能显式接受 --tab 和 --frame 参数，减少对隐式“当前目标”的依赖。
  - [x] 在命令响应中稳定回显实际操作的标签页句柄 (Tab Handle) 和 Frame 引用。

- [x] **增强语义定位能力 (Semantic Locators)**
  - [x] 扩展 find 命令：支持候选列表、Top-N 结果排序。
  - [x] 增加更多定位策略：placeholder, alt text, title, test-id, exact-name。
  - [x] 支持位置/次序选择：first, last, nth。

- [x] **引用过期模型 (Snapshot Epoch)**
  - [x] 引入 Page Epoch 或 Snapshot ID，让 Agent 能感知 DOM 状态是否发生了质变。
  - [x] 当使用过期的元素/Frame 引用（如 @e1）时，返回清晰的机器可读错误（Stale Reference Error）。

- [x] **优化 Agent I/O 协议**
  - [ ] 统一各命令的 JSON 响应格式，确保输出的一致性。
  - [x] 在响应中包含更多上下文元数据（如当前 URL、页面标题、Epoch）。
  - [ ] 建立标准化的错误码系统，并提供针对性的修复建议 (Remediation Hints)。

- [x] **降低交互延迟**
  - [x] 增强 batch 命令的能力，支持简单的条件分支或基于结果的跳过。

- [x] **MCP 服务器接入 (Model Context Protocol)**：通过 `autobrowser mcp` 在 stdio 上暴露核心命令为 MCP tools（含 `tab` / `frame` 参数注入），供 Claude Desktop 等 MCP 客户端直接调用。

## 工程化与体验

- [x] **JSDoc 文档补全**：为 src/core 和 extension/ 下的核心 API 添加完整注释（导出函数已 100% 覆盖）。
- [ ] **错误处理优化**：改进连接断开时的用户提示，提供更明确的恢复引导。
- [ ] **示例代码**：增加针对常用框架（如 React, Vue）复杂组件的自动化操作示例。
