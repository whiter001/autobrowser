# reload 超时及扩展短暂断连后观测状态丢失（实测记录）

> 状态：本地 issue 记录，未提交到 GitHub Issues。记录日期：2026-11-06。
> 本文仅记录这次使用中的可见结果；未确认运行中的 CLI／扩展版本与本地仓库 `main` 的提交一致，也未独立验证根因。
>
> 归档说明：本文「实际表现」「待调查」保留当时的观察，不代表当前版本仍有相同行为；各现象的「处理状态」记录演进，现行使用方式以 README 和内置 skill 为准。

## 环境

- Windows 11、PowerShell 7、Microsoft Edge、autobrowser 默认 relay（`127.0.0.1:57978`）及浏览器扩展。
- 本地源码仓库：`whiter001/autobrowser`，调查时 `main` 的 HEAD 为 `b19cf89`；**这不是运行中程序的版本证明**。
- 操作目标为需要登录的业务页面。为避免泄露登录态或业务数据，下述复现命令省略真实页面地址和观测脚本内容。

## 现象一：reload 报等待超时，页面实际上已刷新

**处理状态**: 已处理（结构性防护，未在相同运行版本上回归验证）

- `reload` / `back` / `forward` 现在都会先 `Page.enable` 再发导航指令：导航 commit 只能由 `Page.frameNavigated` / `Page.navigatedWithinDocument` 推进 epoch 观测，而 Page 域此前只有 `goto` / `open` 会打开，落在这两类命令上会一直等不到 commit。
- 导航链路加入硬超时护栏（分发 5s、readyState 探测、页内稳定探测）：导航销毁 renderer 后 CDP 回调可能永不返回，此前会把扩展侧挂到 relay 的 30s 预算，返回 `COMMAND_TIMEOUT` 并丢掉所有页面信息。现在最坏情况是在命令预算内返回结构化 `partial`。
- 结果字段扩展：`reload` 的所有分支都回显 `waitUntil` / `baselineEpoch` / `observedEpoch` / `observedUrl` / `observedTitle`，并新增 `committed`（是否已提交导航）与 `dispatchTimedOut`（指令发出但无 CDP 回执），可直接区分「指令没执行」「已提交但没稳定」「已完成」。
- relay 侧的 `COMMAND_TIMEOUT` 对 `reload/goto/open/back/forward` 改为提示「可能已经导航，先核对页面再决定是否重发」，不再给通用重试指引。

### 操作与实际结果

1. 在已连接的目标标签页执行 `autobrowser --tab <目标标签页> reload --wait-until domcontentloaded`。
2. 约 30 秒后命令返回 `COMMAND_TIMEOUT`。
3. 后续检查显示页面 epoch 已推进至 `pageEpoch: 2`，网络记录中出现本次页面的 Document GET 200；即导航/刷新至少已发生，不能将该超时解释为"页面完全未刷新"。

### 期望

明确区分"导航指令未执行""导航已发出但等待 DOMContentLoaded 超时"和"页面已完成刷新"。超时结果若可获得导航阶段信息，应回显已观测到的进度和可继续验证的建议，避免调用方盲目重发 `reload`。

## 现象二：扩展短暂断连后脚本注册与标签页状态不明

**处理状态**: 已处理（响应语义 + `initScripts` 跨 service worker 重启持久化 + 句柄解析兜底）

- `script add` 现在返回 `registration`：`appliesTo: 'next-document-load'`（只注册到之后的文档加载，当前页面不会立刻注入）、`attachedTabs`、逐 tab 的注册失败明细 `failures`，以及 `warnings`——没有任何已附加标签页时明确说明"只保存了配置，没有注册到任何标签页"，注册失败时不再被 `Promise.allSettled` 静默吞掉。
- `initScripts` 落 `chrome.storage.local`（键 `autobrowser.initScripts`，带 version）：service worker 被回收、扩展被重载后，`script list` / `replayForTab` 会先从存储还原清单，重新 attach 时把脚本注册到新的 CDP 会话。identifier 属于旧会话，还原时刻意丢弃，所以恢复后 `registeredTabs` 先为空、attach 后重建——这与实际可注入范围一致。最初用的是 `storage.session`，实测 `chrome.runtime.reload()` 会连带清空 session 区（重载扩展正是最常见的恢复手段），而 payload 全部是配置、不含会话数据，因此改用 local；脚本会跨浏览器会话保留，清理入口是 `script remove --all`。
- `STALE_TAB_HANDLE` 的瞬时窗口已消除：句柄 `tN` 本身就是由 Chrome tabId 单向派生的，映射表只是缓存。映射缺失（SW 刚被回收、`state` 还没发布）时 `resolveTabHandle` 按 `tN → N` 兜底，标签是否存在交给 `tabsGet` 校验——活着的标签页立刻可用，真关闭的标签页仍返回 `STALE_TAB_HANDLE`，且不可能命中别的标签页（tabId 在同一浏览器会话内不复用）。
- 仍为纯内存的运行态：`attachedTabs`、page epoch、选中 frame。它们都是当前 CDP 会话的产物，重建成本低；副作用是重连后旧元素引用（`@eN#pX`）会被判成过期，需要重新 `snapshot`——这是"宁可重拍也不误用旧引用"的保守选择。

### 操作与实际结果

1. 执行 `autobrowser script add ...`，命令返回 `ok: true`，但同时返回 `registeredTabs: []`。因此**不能认定脚本已在目标标签页注册或注入**。
2. 随后的 `autobrowser wait time 4000` 返回 `COMMAND_EXECUTION_UNKNOWN: extension disconnected; command execution result is unknown`。
3. 断连后，之前可用的同一标签页句柄短暂返回 `STALE_TAB_HANDLE`；连接恢复后可继续访问该标签页。
4. 恢复后 `script list` 为空，页面内预期的观测变量未定义。此处仅证明恢复后的可见状态；不能据此断言脚本曾成功注册后又被清除。

### 期望

- `script add` 在 `registeredTabs: []` 时清楚说明"仅保存注册配置"还是"未附加到任何标签页"，并区分命令成功与脚本已注入。
- 断连重连后明确脚本注册、目标标签页句柄和在途命令各自的恢复语义；对执行结果未知的命令提供安全的状态检查指引，不建议无条件重试可能有副作用的命令。

## 待调查

- ~~`reload` 的超时发生在哪个阶段？~~ 已按阶段建模：`phase: dispatch|commit|settle` + `committed` + `dispatchTimedOut` 可直接读出停在哪一步；仍未在相同运行版本上取 trace 复现原始 30s 超时。
- ~~`script add` 的空 `registeredTabs` 是否与没有已附加标签页有关？~~ 已确认：只对 `attachedTabs` 注册，且注册失败此前被静默吞掉。
- 短暂断连导致的句柄失效与脚本列表为空是否共享同一恢复路径？目前只有时间上的关联，**未证实因果关系**；两者的表现都与 service worker 重启后内存态清空一致。两侧都已按"SW 重启"建模：脚本清单落 `storage.session`，句柄改为从 `tN` 反推 tabId 后再校验存在性。

## 范围说明

本次另遇到 `network requests --limit 30` 参数误用（应使用 `--page-size`），以及未显式指定 tab 时选中了扩展管理页的目标选择问题。这两项不作为已确认的 autobrowser 缺陷记录。本文也不包含凭据、cookie、token 或真实业务数据。
