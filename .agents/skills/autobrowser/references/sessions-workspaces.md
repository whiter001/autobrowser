# 命名会话、Workspace 与标签归属

## 命名会话与清理边界

- 默认会话继续使用原有 home、端口和真实浏览器登录态。隔离任务用 `session create <name>` 和 `session attach <name>`，后续命令把 `--session <name>` 放在命令名前；每个命名会话的 home、profile、端口、token 和 tab target 独立，不要跨会话复用连接信息。
- `session list` 查看运行状态和目标 tab；`session detach <name>` 只停止 relay，保留浏览器 profile；`session close-all <name>` 关闭该会话标签页；`kill-all` 只停止登记的 autobrowser relay，不承诺终止所有浏览器进程。
- `session delete-data <name>` 先停止对应 relay 再删除命名会话目录，重复执行返回已清理，默认会话禁止删除。遇到 `SESSION_DATA_LOCKED` 先关闭占用该 profile 的浏览器再重试，不要强删或改删其他目录。

## 多 AI Workspace 与标签归属

- Workspace 在 Chromium 下默认启用：共享当前浏览器/profile/登录态，但隔离默认 tab 与操作权限；需要独立浏览器环境时仍用 `--session`。解析优先级为显式 `--workspace` > 非 `off` 的 `AUTOBROWSER_WORKSPACE` > 默认 auto，空环境变量等同未设置。
- 关闭隔离用全局 `--no-workspace` 或 `AUTOBROWSER_WORKSPACE=off`（大小写不敏感），回到无 workspace 的共享目标模式；显式 `--workspace` 仍覆盖 off，但 `--no-workspace` 与 `--workspace` 同用会在发请求前报 `CLI_INVALID_ARGUMENT`。默认 auto 只用于 Chromium：`--engine firefox|webkit` 且没有显式 workspace 配置时保持无 workspace，显式配置仍按原行为报 Chromium-only 错误。
- auto 组合可信祖先进程 PID、启动时间与终端标识；这些信号会随宿主启动方式、终端复用或进程重启漂移，因此 AI 宿主应在会话开始时按“启动工作区根目录 + AI 会话 ID”生成一次固定 `AUTOBROWSER_CALLER_ID`，整个会话复用。同一 AI 固定、不同 AI 不同；不要只按当前目录，也不要每条命令随 cwd 重算，否则同一工作流会分裂成多个 workspace、丢失默认目标或反复 `TAB_BUSY`。显式 `AUTOBROWSER_WORKSPACE` 优先，设置它时无需另设 caller id。它不是安全认证机制。
- auto 身份不由 shell 决定：它向上遍历进程树，跳过 shell 与 autobrowser 自身，取最近的可信非 shell 祖先哈希。因此新开的 Bash/PowerShell、嵌套 PowerShell、从脚本或 Node 子进程里再调一次，**通常仍会落到同一个 workspace**；只有当调用链跨到不同的可信祖先（换了 IDE/终端窗口、父进程重启或被替换、脱离原会话运行）时身份才会漂移，同一工作流被拆成多个 workspace，进而互相 `TAB_BUSY`、丢失默认目标。这是条件性风险而非每条命令都必然分裂，但跨 shell 仍建议显式继承同一个 `AUTOBROWSER_WORKSPACE` 或 `AUTOBROWSER_CALLER_ID`，不要把稳定性寄托在进程树上。显式 `--workspace <id>` 是全局选项，放在命令名之前（`autobrowser --workspace <id> tab attach <tN>`）；放在子命令之后可能被该子命令的局部解析器拒绝，此时改用环境变量最稳。
- `tab new` 返回的 `tN` 句柄要立即记下来，后续命令同时显式带 `--workspace <id>` 和 `--tab <tN>`。只给 `--tab` 不够：workspace 未固定时命令会重新推导 auto 身份，可能拒收该句柄或认领一个无关标签。收到 `TAB_BUSY` 等回执里的 owning workspace 时先判断标签归属：确认它是本工作流自己建的（句柄、URL、上下文都能对上），才用该 workspace 加显式 `--tab <tN>` 找回；若它属于其他 AI 或调用方，不要复用其 workspace，也不要强接管，改用自己的空闲标签或 `tab new` 新建。
- 多个 AI 不共用同一个 workspace，也不能靠重试或改参数绕过 `TAB_BUSY`；需要并发时各自 attach 不同标签。
- 优先保留现场：先 `tab list` 查看 `workspace` / `attachment` / `origin` / `keep` / `attachable`，对合适的 `attachable:true` 现有标签用 `tab attach <tN>` 复用，保留手动登录、已填表单、筛选条件和正在排查的页面。只有没有可用的空闲标签，或任务确实需要独立环境（隔离 cookie、稳定导航、长时间独占）时才 `tab new` / `open` / `session`；新任务不等于必须新开标签。已被其他 workspace 占用时返回 `TAB_BUSY`，不要强制接管；`--readonly` 只允许观察命令，click/eval/run 等会返回 `WORKSPACE_READONLY`。
- 点击打开新标签页（`target=_blank`、`window.open`）时，`click` 的结果里会出现 `newTabId` 和 `newTabHandle`（新标签的 `tN` 句柄）。默认**只报告**：workspace 的当前目标仍然是原来那个标签页，归属和租约都不变。只有确实要在新标签继续操作时才加 `--follow-new-tab`，它内部复用 `tab attach`，把当前目标切到新标签并返回 `followedTab` 与跟随后的 `meta`。不是所有弹窗都该接管——广告弹窗、下载页、登录回跳这类新标签通常应该留在原页面继续。
- Workspace 没有目标时默认自动原子认领一个未绑定标签页：active 优先，其余按 tabId 升序；`TAB_BUSY` 时尝试下一空闲页，不能抢占。显式 `--tab <tN>` 指向未绑定标签时同样直接认领并设为当前目标，无需先单独执行 `tab attach`。不要限制为 HTTP(S)，localhost 等可调试页面均可用；首次认领的 `result.meta.autoAttached:true` 会给出实际目标。没有空闲页时 `open <url>` 创建并绑定新 tab，其他命令返回 `WORKSPACE_TARGET_REQUIRED`。需要关闭自动认领时使用全局 `--no-auto-attach`，batch 子步骤也会继承；此时显式未绑定标签仍需先 `tab attach`。它只关闭自动认领，不等于 `--no-workspace`，也不能绕过其他 workspace 的归属。
- `tab detach [tN]`、`workspace release [id]` 和租约过期只解除归属，不关闭、刷新或重置页面。默认租约 1 小时，命令会续约，归属保存到 `chrome.storage.local`；detailed tab list 可查看租约时间。任务结束时释放自己的标签，把页面留给后续复用；不要关闭其他 AI 仍在使用的页面。
- `tab list` 的 `origin` 记录页面来源：只有 workspace 内 `tab new`/`open` 创建的页面是 `created`，`tab attach`、自动认领、`click --follow-new-tab`、`window new` 都是 `attached`；`keep` 只由 `tab mark` 写入。重新 attach 会保留既有 `origin`/`keep`，旧版本持久化数据缺字段时按 `attached` + `null` 恢复（保守不可关）。
- `tab mark <tN> deliverable|handoff` 与 `tab unmark <tN>` 只操作本 workspace 的 owned 标签：其他 workspace 持有返回 `TAB_BUSY`（details 带 `origin`/`keep`），`--readonly` 返回 `WORKSPACE_READONLY`，未附着返回 `TAB_NOT_ATTACHED`。标记不关闭页面、不 detach、也不改当前目标；`deliverable` 表示任务产物，`handoff` 表示交给后续调用方继续。
- `workspace finish` 是**显式收尾、绝不自动执行**：只关闭本 workspace 中 `origin=created`、没有 `keep`、且不是浏览器当前活动/前台标签的普通临时页。借用页（`attached`）、`deliverable`、`handoff` 和前台标签全部保留并 detach，同时恢复进入前的标签组；关闭成功的页面删除 attachment。工作区本身保留，`targetTabId` 置空，后续任务可继续使用。
- `workspace finish` 的结果字段：`success`、`closed`、`closedTabIds`、`releasedTabIds`、`preserved`（每项含 `tabId`/`handle`/`reason`，reason 为 deliverable/handoff/borrowed/foreground）、`missingTabIds`、`failedTabs`、`remainingTabIds`。已不存在的页面记 `missingTabIds`，不算失败；关闭失败的页面保留 attachment 供重试，此时 `success=false`，不能当成全部收尾完成。展示层（标签组）失败只记 `lastError`，不会改变关闭/保留的决定。
- Workspace 可以拥有多个 tab，但默认目标彼此独立；自动认领一次后目标保持稳定，不会每条命令换页。显式 `--tab` 也不能绕过归属；batch 子步骤继承外层 workspace 和 `--no-auto-attach`，run 会先向扩展校验归属。
- 同一标签的命令按 FIFO 串行执行，不要在一个 tab 上并发堆积多个长等待；等待条件已变化时先结束或取消上一个等待。写入、点击、提交前用 `get url` / `snapshot` 核对当前页面和元素，避免在多 AI 共用的标签上误操作。
- Workspace 模式下 `close all` 只关闭当前 workspace 的 owned tabs；`extension reload/reconnect`、`server stop/restart` 是全局操作，会影响所有调用方，执行前先确认其他 workspace 是否正在使用。后台标签页的定时器可能因浏览器节流延迟当前页面任务，多 AI 切换活动页会间接放大；依赖可见性或定时器结果的验证可 `tab select` 保持前台，或使用独立 `--session`，`set focus on` 不能保证消除后台定时器节流。
- `workspace groups [on|off|status]` 是**整个 profile 的标签组展示开关**，默认关闭，省略参数等同 `status`；它不是 workspace 动作，`--no-workspace workspace groups off` 也能执行。`status` 返回 `enabled`、`available`、`groups` 和 `lastError`。
- 开启后一个 workspace 对应一个 Chromium 标签组，组标题是截断的短 workspace id，颜色按 workspace 稳定生成；`tab attach`、自动认领、`tab new` 以及开启时已有归属会同步进组。
- `tab detach`、`workspace release`、`workspace finish`（保留的标签）、租约过期和 `groups off` 会把仍在管理组里的页面恢复到进入前的组（原本未分组则取消分组）；用户手动移到别组的页面保持不动。
- groupId 只是可失效的缓存，不承担归属身份；分组失败只记录 `lastError`，不影响归属、页面命令或 attach/detach/release。`close all` 仍按 owned tabs 关闭，不按标签组关闭。
