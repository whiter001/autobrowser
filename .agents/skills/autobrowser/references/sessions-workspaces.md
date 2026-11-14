# 命名会话、Workspace 与标签归属

## 命名会话与清理边界

- 默认会话继续使用原有 home、端口和真实浏览器登录态。隔离任务用 `session create <name>` 和 `session attach <name>`，后续命令把 `--session <name>` 放在命令名前；每个命名会话的 home、profile、端口、token 和 tab target 独立，不要跨会话复用连接信息。
- `session list` 查看运行状态和目标 tab；`session detach <name>` 只停止 relay，保留浏览器 profile；`session close-all <name>` 关闭该会话标签页；`kill-all` 只停止登记的 autobrowser relay，不承诺终止所有浏览器进程。
- `session delete-data <name>` 先停止对应 relay 再删除命名会话目录，重复执行返回已清理，默认会话禁止删除。遇到 `SESSION_DATA_LOCKED` 先关闭占用该 profile 的浏览器再重试，不要强删或改删其他目录。

## 多 AI Workspace 与标签归属

- Workspace 在 Chromium 下默认启用：共享当前浏览器/profile/登录态，但隔离默认 tab 与操作权限；需要独立浏览器环境时仍用 `--session`。解析优先级为显式 `--workspace` > 非 `off` 的 `AUTOBROWSER_WORKSPACE` > 默认 auto，空环境变量等同未设置。
- 关闭隔离用全局 `--no-workspace` 或 `AUTOBROWSER_WORKSPACE=off`（大小写不敏感），回到无 workspace 的共享目标模式；显式 `--workspace` 仍覆盖 off，但 `--no-workspace` 与 `--workspace` 同用会在发请求前报 `CLI_INVALID_ARGUMENT`。默认 auto 只用于 Chromium：`--engine firefox|webkit` 且没有显式 workspace 配置时保持无 workspace，显式配置仍按原行为报 Chromium-only 错误。
- auto 组合可信祖先进程 PID、启动时间与终端标识；AI 宿主可用 `AUTOBROWSER_CALLER_ID` 注入稳定身份。它不是安全认证机制；MCP 服务实例的独立 workspace 语义不变。
- 先用 `tab list` 查看 `workspace` / `attachment` / `attachable`，再 `tab attach <tN>` 原子复用未占用页面，保留登录、表单、筛选等现有状态。已被其他 workspace 占用时返回 `TAB_BUSY`，不要强制接管；`--readonly` 只允许观察命令，click/eval/run 等会返回 `WORKSPACE_READONLY`。
- Workspace 没有目标时默认自动原子认领一个未绑定标签页：active 优先，其余按 tabId 升序；`TAB_BUSY` 时尝试下一空闲页，不能抢占。不要限制为 HTTP(S)，localhost 等可调试页面均可用；首次认领的 `result.meta.autoAttached:true` 会给出实际目标。没有空闲页时 `open <url>` 创建并绑定新 tab，其他命令返回 `WORKSPACE_TARGET_REQUIRED`。需要严格指定页面时使用全局 `--no-auto-attach`，batch 子步骤也会继承该关闭行为；它只关闭自动认领，不等于 `--no-workspace`。
- `tab detach [tN]`、`workspace release [id]` 和租约过期只解除归属，不关闭、刷新或重置页面。默认租约 1 小时，命令会续约，归属保存到 `chrome.storage.local`；detailed tab list 可查看租约时间。
- Workspace 可以拥有多个 tab，但默认目标彼此独立；自动认领一次后目标保持稳定，不会每条命令换页。显式 `--tab` 也不能绕过归属；batch 子步骤继承外层 workspace 和 `--no-auto-attach`，run 会先向扩展校验归属。
- Workspace 模式下 `close all` 只关闭当前 workspace 的 owned tabs；`extension reload/reconnect`、`server stop` 等全局管理操作仍影响所有调用方。
- `workspace groups [on|off|status]` 是**整个 profile 的标签组展示开关**，默认关闭，省略参数等同 `status`；它不是 workspace 动作，`--no-workspace workspace groups off` 也能执行。`status` 返回 `enabled`、`available`、`groups` 和 `lastError`。
- 开启后一个 workspace 对应一个 Chromium 标签组，组标题是截断的短 workspace id，颜色按 workspace 稳定生成；`tab attach`、自动认领、`tab new` 以及开启时已有归属会同步进组。
- `tab detach`、`workspace release`、租约过期和 `groups off` 会把仍在管理组里的页面恢复到进入前的组（原本未分组则取消分组）；用户手动移到别组的页面保持不动。
- groupId 只是可失效的缓存，不承担归属身份；分组失败只记录 `lastError`，不影响归属、页面命令或 attach/detach/release。`close all` 仍按 owned tabs 关闭，不按标签组关闭。
- 每个 MCP 服务实例自动获得独立 workspace，可用 `workspace`、`tab_attach`、`tab_detach` 工具管理和复用页面。
