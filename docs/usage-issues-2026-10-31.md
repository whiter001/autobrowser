# 使用体验问题与改进建议（2026-10-31）

> 来源：用 autobrowser 抓取 X（Twitter）推文视频（`https://x.com/Morris_LT/status/1819943765697781900`）的实操过程。
> 场景：受限网络环境下抓取 HLS 视频流（60+ 个 `.m4s` 分片），需要把浏览器里的网络响应取回本地。
> 日期：2026-10-31
>
> 说明：本文「实测」结论均在本机复现过；标注「推测」的为代码分析结论、未经运行验证。与 [`usage-issues.md`](usage-issues.md)（2026-08-20）中的历史问题不重复，仅在 Issue 1 处交叉引用。

## 一、已确认的问题（Bug）

### Issue 1: `network har start` 静默抓错标签页，导出空 HAR 却返回 `ok: true`

**处理状态**: 已处理（start/stop/recover 回显原 capture tab；CLI 保留路径输出并增加 `meta.har`，空结果输出可见警告和 `--tab` 建议）

- **严重程度**: 高（HAR 是唯一的响应体导出通道，失败时无任何提示）
- **环境**: macOS / Chrome 156 / autobrowser v0.1.2（main `b280c36`）

**复现步骤**

```bash
autobrowser tab new "https://example.com/"          # 制造第二个 tab，使其成为 target
autobrowser network har start --har-unlimited
autobrowser --tab t13 eval 'fetch("https://video.twimg.com/.../playlist.m3u8").then(r=>r.text())'
autobrowser network har stop out.har
```

**实际表现**

- `out.har` 的 `log.entries` 为空数组。
- 全程没有任何 error / warning，`har stop` 返回 `ok: true`，`har status` 的 `requestCount` 仍有 150+。

**对照组（证明机制本身可用）**

```bash
autobrowser --tab t13 network har start --har-unlimited   # 显式指定 tab
autobrowser --tab t13 eval 'fetch(...)'
autobrowser network har stop out.har
# → entries: 1，response.content.text 拿到完整 body（8440 字节）
```

本轮再次复现：不带 `--tab` → `entries: 0`；带上 `--tab` → `entries: 1` 且 body 无损（48,355 字节的 `.m4s` 解码后与真实字节逐字节一致）。**同一份代码、同一台机器，唯一变量就是 `--tab`。**

**根因分析**

- `captureRequests()`（`extension/background/network.ts:795-804`）要求同时满足：tab 相同 **且** `record.harCaptureId === session.id`。
- `harCaptureId` 只在 `Network.requestWillBeSent` 时打标（`network.ts:1270-1275`），且 tab 不匹配时写死为 `''`；过滤器里 `harCaptureId === undefined` 的兜底分支是**死代码**（该字段永远只可能是字符串）。
- 于是「不是 capture 那个 tab 的请求」「start 之前发出的请求」「stop 之后发出的请求」全部被**静默丢弃**：无 error、无计数、无 `suggestedAction`。
- capture 绑定哪个 tab 由扩展在 `har start` 时解析（`extension/background-main.ts:186-230` → `loadTargetTab`），target 失效时回落到 `pickLastNonActiveTab`（`src/core/tab-selection.ts:6-22`）——该函数**优先选非激活页**，与直觉相反。
- CLI 侧 `network har stop` 把扩展返回的 `requestCount` / `checkpoint` 全部丢弃，只回文件路径（`src/cli/commands/state.ts:552-575`），用户无从判断「其实一条都没抓到」。

**期望行为**

- capture 绑定 tab 时，start / stop 的返回值都回显实际捕获的 tab。
- `entries` 为 0 时 `har stop` 必须返回非 0 退出码 + `suggestedAction`（提示「capture 绑定在 tab X，请先 `tab.select` 到目标页再 start」），而不是交出 `ok: true` 的空 HAR。
- 过滤器命中为 0 时给出**分类计数**（otherTab / beforeStart / afterStop / otherCapture），便于 agent 判断该换哪个 tab 重试。

---

### Issue 2: `network har start --har-max-requests N` 会静默截断全局请求历史（跨 tab）

**处理状态**: 已处理（HAR 限额只收敛当前 capture 的导出窗口，全局请求历史仅受全局硬上限约束）

- **严重程度**: 中高（一个 HAR 专用开关 destroys 了与 HAR 无关的全局历史）
- **环境**: 同上

**复现步骤**

```bash
autobrowser network requests --all-tabs --all-epochs   # total: 150
autobrowser network har start --har-max-requests 10
autobrowser --tab t13 eval 'fetch("https://video.twimg.com/...?probe=1")'   # 仅 1 个请求
autobrowser network requests --all-tabs --all-epochs   # total: 10  ← 全局历史被砍掉 140 条
autobrowser network har stop out.har
autobrowser network requests --all-tabs --all-epochs   # total: 10  ← stop 不恢复
```

**实际表现**

- 所有 tab 的历史请求被一起截断到 10 条，且 `har stop` 之后仍然只有 10 条（被裁掉的记录无法找回）。
- 注意时序：裁剪发生在**下一个请求到来时**（upsert 时），不是设置即刻生效，因此很容易在无关操作后才发现历史没了。

**根因分析**

- `upsertNetworkRequest` 把 HAR 的 `harLimit` 直接用作**全局共享缓冲** `state.network.requests` 的上限（`extension/background/network.ts:330-333`）：
  ```ts
  const harLimit = getHarMaxRequests(state)
  const effectiveLimit = harLimit === null ? GLOBAL_REQUEST_HARD_CAP : Math.min(harLimit, GLOBAL_REQUEST_HARD_CAP)
  ```
- `stopHar` 只把 `harMaxRequests` 复位回 1000（`network.ts:1530`），不会把已裁掉的记录补回来。

**期望行为**

- `harMaxRequests` 只约束 capture 窗口内的记录，不应改变全局缓冲容量；两者解耦。
- 若确实要限制全局缓冲，应是独立参数（如 `--network-max-requests`），并在裁剪发生时提示。

---

### Issue 3: `network requests` 默认返回**最旧**的一页，`total` 藏在另一个字段

**处理状态**: 已处理（保留 oldest 默认兼容性，新增 `network requests --sort newest`；文档补充分页语义）

- **严重程度**: 中（影响调试效率，也容易让人误读成"记录被挤掉了"）
- **环境**: 同上

**实际表现**

```
total(匹配条数): 150
pagination: {"currentPage":0,"totalPages":3,"hasNextPage":true,"startIndex":0,"endIndex":50}
本页条数: 50
```

- 默认第 0 页给的是**最旧的 50 条**（`state.network.requests` 按插入顺序），而调试时通常想要最近的。
- CLI 输出把 `total` 与 `pagination` 埋在 JSON 里，容易被读成"总共只有 50 条"。**本轮排查中我因此连续两次误判**：先以为"别的标签页把我的记录挤掉了"，后又用 `--page-size 1` 取 id 时拿到了**最旧**那条旧记录（而我想要的是刚抓的那条），导致一次结论完全跑偏。

**根因分析**

- `listRequests`（`extension/background/network.ts:1452-1479`）→ `paginateList`（`extension/background/pagination.ts:34-54`），`DEFAULT_PAGE_SIZE = 50` / `MAX_PAGE_SIZE = 200`（`pagination.ts:18-19`）。
- `--page` / `--page-size` 已存在，但 `docs`/SKILL.md 里没有说明这个分页语义。

**期望行为**

- 默认按最新优先排序，或提供 `--sort`。
- CLI 摘要（`--raw`）里直接显示 `total` / `totalPages` / `currentPage`。

---

### Issue 4: `status.lastError` 只增不消，且跨 relay 重启保留

**处理状态**: 已处理（保留历史 `lastError`，新增并持久化 `lastSuccessAt`，可比较两者时间判断错误是否早于最近成功）

- **严重程度**: 低中（误导排障：一条历史失败会被当成当前故障）

**实际表现**

- 00:15 的一次 `Page.setDownloadBehavior` 失败，到 00:31 仍出现在 `status.lastError` 中，其间执行了大量成功命令。
- 该字段被持久化到 `state.json`，relay 重启后照样恢复。

**根因分析**

- 写入：`src/core/runtime.ts:458-464` `setError()`（只覆盖写，不清除）；调用点 `src/server.ts:405-411`（任何命令失败都写）、`runtime.ts:580`。
- 恢复：`src/core/runtime.ts:331` 从持久化状态里读回。
- 扩展侧还有一个同名不同源的字段 `state.connection.lastCommandError`（`extension/background/connection.ts:612-618`），同样只覆盖不清除，排障时容易混淆。

**期望行为**

- 成功命令后清除 `lastError`，或明确区分「当前错误」与「历史最后一次错误」（加 `lastErrorAt` + `sinceLastSuccess` 之类的语义）。

---

### Issue 5: 命令超时后，同 tab 的后续命令会**全部卡满 30s**

**处理状态**: 已处理 eval 场景（relay/显式取消运行中的 eval 时会定向调用 `Runtime.terminateExecution`；其他 CDP 操作仍为 best-effort cancel）

- **严重程度**: 高（一次超时会持续污染该 tab 后续所有命令，明显拖慢 agent 循环）

**实际表现**

- 一次 `eval` 超时后，紧接着两个 `eval` 各自卡满 30s——其中一个只是对 256KB 数组做一次 `btoa`，本该瞬时完成。
- 之后同一个页面上的 `eval` 又恢复正常。

**根因分析**

- relay 超时只是「放弃等待 + 发 cancel」（`src/core/runtime.ts:776-797`），**无法中断已经在浏览器里跑的 CDP 操作**。
- 扩展侧 `cancel` 只把运行项从队列摘掉，底层 CDP 继续跑（`extension/background/command-queue.ts:183-200`，文件头注释 `:49-52` 已写明「运行项无法中断底层 CDP，但会与队列脱钩」）。
- 该 tab 的 renderer 主线程被旧操作占住，后续 CDP 调用在**浏览器侧**排队，每个都耗尽自己的 30s 预算 → 表现为「每个都卡满 30s」，而不是扩展队列在排队。
- 补充：`Runtime.evaluate` 的 `timeout: 25000` 同样依赖 renderer 主线程才能触发（`extension/background-main.ts:59`、`:484`），主线程被占时它也不生效。

**期望行为**

- 超时后具备真正的中断能力（`Runtime.terminateExecution` / `Page.stopLoading`），让同 tab 的后续命令快速失败或快速成功，而不是等满预算。
- relay 超时文案区分「排队中被取消」与「运行中无法中断」，当前统一写成 `cancelled the queued command`（`runtime.ts:786-789`）有误导性。
- 扩展在 cancel 运行项时把「该 tab 处于脏状态」暴露给 CLI（目前 `command list` 只能看到历史条目）。

---

### Issue 6: `eval` 没有返回值体积上限，也没有截断标记；>256KB 静默切换到 upload 通道并与 30s 预算共享

**处理状态**: 已处理（新增可选 `eval --max-result-bytes <n>`，超限返回 `EVAL_RESULT_TOO_LARGE` 和实际字节数；默认不截断，文档说明 upload 与 deadline）

- **严重程度**: 中

**实际表现**

- 实测 2MB 与 256KB 两种规模的 `eval` 都以超时收场，没有拿到任何「结果太大」类的明确错误（受 Issue 5 放大，无法单独归因）。
- 作为数据通道用 `eval` 回传二进制时，失败方式是「超时」而不是「超出上限」，agent 无法据此调整策略。

**根因分析**

- 链路上**没有** eval 返回值的截断逻辑（`extension/background/page-input.ts:613-657`、`extension/background-main.ts:472-547`）；对比 console 消息有 500 字符裁剪、HAR body 有 `maxBodyBytes` 裁剪，eval 没有。
- 超过 256KB 会切到 64KB 分块或 HTTP upload（`src/core/response-transfer.ts:2-5`、`extension/background/response-upload.ts:205-228`），而 upload 的 POST + SHA-256 校验 + 落盘**都算在同一个 30s deadline 内**。

**期望行为**

- eval 结果超过阈值时返回 `{ truncated: true, bytes: N }`，而不是硬扛到超时。
- 文档化「>256KB 的 eval 结果会自动切到 upload 通道并占用同一 deadline」。

---

### Issue 7: `cdp` 无法设置下载目录（Chromium 侧限制，非 autobrowser 校验误伤）

**处理状态**: 受阻（live Chrome 验证：`chrome.debugger.getTargets` 不暴露 browser target；tab session 的 `Target.getTargets` 返回 `Not allowed`，`Browser.setDownloadBehavior` 也不可用。需独立 CDP browser endpoint，已撤回不可用的 `downloads set-path` 实现）

- **严重程度**: 低中（功能缺口）
- **环境**: Chrome 156

**实际表现**

```bash
autobrowser --tab t13 cdp Page.setDownloadBehavior '{"behavior":"allow","downloadPath":"/tmp/dl"}'
# → {"code":-32000,"message":"Cannot not access browser-level commands"}
```

**澄清（避免误判为 autobrowser 的 bug）**

- 这**不是** autobrowser 前缀黑名单误伤：`src/core/command-spec.ts:698-712` 只拦 `Browser|Target|SystemInfo` 前缀与 `Debugger.disable`，`Page.` 前缀并不在黑名单里。
- 真正拦截发生在 **Chromium**：`Page.setDownloadBehavior` 在 Chromium 里实现为 browser 级命令（`content/browser/devtools/protocol/page_handler.cc`），page 级 DevTools session（`chrome.debugger` attach tab 得到的正是 page session）无权调用，因此返回 `-32000`，由 `extension/background/errors.ts:15-28` 包成 `EXTENSION_COMMAND_ERROR`。

**期望行为**

- 扩展侧开一条 browser 级 CDP 通道：`extension/background/chrome.ts` 增加 `getTargets` 包装（仓库当前完全没有 `getTargets` 调用）→ `extension/background-main.ts` attach `type === 'browser'` 的 target → `command-router.ts:1919` 按方法前缀分流；`src/core/command-spec.ts:702` 再精确放行 `Browser.setDownloadBehavior`。
- 或者提供更贴合场景的专门命令（如设置下载目录），不必让用户去拼 CDP。
- 零改动的现成绕法（仓库自己的 e2e 就在用）：`test/live-smoke.test.ts:2239` 用独立 CDP 客户端连 Chrome 的 browser endpoint 发 `Browser.setDownloadBehavior`。

---

### Issue 8: tab handle 在扩展 SW 重启后会重排，旧号还可能被静默复用

**处理状态**: 已处理（handle 直接由 Chrome tabId 派生，不再依赖 SW 内存中的分配顺序）

- **严重程度**: 中高（复用场景会静默打到错误页面，比报错更危险）
- **环境**: Chrome 156 / MV3 service worker

**实际表现**

- 同一个 x.com 标签页先是 `t12`，稍后变成 `t13`；`--tab t12` 报 `STALE_TAB_HANDLE` / `tab not found: t12`。

**根因分析**

- handle 是扩展内存里的**单调计数器**，key 是 Chrome tabId（`extension/background/targeting.ts:33-51`），只存在于 MV3 service worker 内存（`extension/background/state.ts:23-31`）。
- SW 一旦被回收重启，映射全部丢失，重连时 `publishState` → `listTabs()`（`chrome.tabs.query({})`）按**枚举顺序**重新分配 `t1..tN`，与原先的分配顺序无关。
- 抛错位置 `extension/background-main.ts:200`（错误定义 `targeting.ts:98-103`）。

**额外风险**

- `resolveTabInput` 只要 handle 在 map 里就直接用（`targeting.ts:72-73`），**没有 epoch / 校验和**。SW 重启后 `t12` 若被分配给了另一个 tab，旧脚本会静默命中错误页面。这比 `STALE_TAB_HANDLE` 更难发现。

**期望行为**

- handle 落到 `chrome.storage.session`，SW 启动时恢复；或改用与 tabId 绑定的稳定 handle。
- 给 handle 加 epoch / 校验和（可参考 element/frame 的 `pageEpoch` 机制，`targeting.ts:138-163`、`src/core/agent-handles.ts:76-86`），旧号复用时报错而不是静默命中。

---

### Issue 9: `network requests` 的「当前 tab」是记忆中的 target tab，而非浏览器活动 tab，且会静默回落

**处理状态**: 已确认现有防护（target tab 是有意的 agent 目标语义；结果已有 `targetFallback` / `meta.target.note`，并支持 `--tab` 覆盖，无需另改代码）

- **严重程度**: 中（是 Issue 1 的上游成因）

**根因分析**

- 过滤逻辑：`extension/background/command-router.ts:2289-2302`（默认 = 当前 target tab + 当前 pageEpoch；`--all-tabs` = 不限 tab 但每个 tab 只保留各自当前 epoch；`--all-epochs` = 不限 epoch）。
- 「当前 tab」取自 `state.targeting.targetTabId`（`extension/background/targeting.ts:29-31`），即**最近被任何 tab 定向命令命中的 tab**，不是浏览器的活动 tab。
- target 关闭后会静默回落到 `pickLastNonActiveTab`（`extension/background-main.ts:211-228`、`src/core/tab-selection.ts:6-22`），而该函数**优先选非激活页**。

**期望行为**

- 在结果里回显实际命中的 tabId / epoch（`--include-details` 之外也应有）。
- 回落时给出显式提示（项目已有类似做法：目标标签页回落时在结果主体给出可见提示）。
- 提供 `--tab` 覆盖默认 target。

---

### Issue 10: `network har stop` 的预算是写死的 30s，且没有任何覆盖手段

**处理状态**: 已处理（`network request` / `network har stop` / `network har recover` 支持 `--timeout-ms`；stop 超时提示先查 status 再 recover）

- **严重程度**: 高（采集规模越大越容易失败，且失败即数据全丢）
- **环境**: macOS / Chrome 156 / autobrowser v0.1.2

**复现步骤**

```bash
autobrowser --tab t13 network har start --har-unlimited
# 采集若干个真实响应体后
autobrowser network har stop out.har
```

**实际表现**

- 采集响应体 ≤ 256 KiB 时 stop 稳定在 0.1–0.2s，正常写出 HAR 文件。
- 采集规模变大后 stop 稳定卡满 30s：`command timed out after 30000ms: network`，**HAR 文件完全没有生成**。
- 扩展侧其实把结果算完了（`command list` 显示该命令在约 53s 后 `completed`），但 relay 早已放弃等待，CLI 从未收到 payload → **已抓到的数据全部丢失**。

**根因分析**

- 预算覆盖只对 `eval / goto / open / click / reload / wait / feed` 生效（`src/core/command-budget.ts:105-131`），`network` 类命令不在其中 —— `network har stop` 没有任何可调预算的入口。
- 而 stop 的工作量随采集规模线性增长：等待 body 抓取（`await Promise.allSettled(pending)`，`extension/background/network.ts:1536`）→ 写 checkpoint → 传输响应体。
- HAR 文件是 **CLI 侧**落盘的（`src/cli.ts:356-360`），relay 超时后 CLI 收不到 payload，文件根本不会创建。
- help 文案写的是 "large results are transparently chunked/reassembled or explicitly rejected for size, not silently truncated"（`src/cli/help.ts` 的 `network har stop`），实际表现是**静默超时**。

**期望行为**

- 给 `network har stop`（以及 `network request` / `network export`）一个随采集规模伸缩的预算，或至少允许 `--timeout-ms`。
- 超时前若结果已算好，应把 HAR 落到 checkpoint 并让 `network har recover` 能取回（当前 checkpoint 也不可用，见 Issue 11）。
- 超时文案应说明「结果可能仍在扩展侧计算中」并给出 recover 指引。

---

### Issue 11: `network har status` 与 `network har recover` 对「checkpoint 可用」的判定不一致

**处理状态**: 已处理（status 新增 `checkpoint.recoverable` 与 checkpoint 写失败原因；recover 继续拒绝空 checkpoint）

- **严重程度**: 中（唯一的数据恢复入口自己报错，且报错与 status 矛盾）

**实际表现**

```bash
autobrowser network har status
# → checkpoint: { available: true, recording: true, requestCount: 0, ... }

autobrowser network har recover out.har
# → {"code":"EXTENSION_COMMAND_ERROR","message":"no HAR checkpoint is available"}
```

**根因分析**

- status 只判断 checkpoint 对象是否存在（`extension/background/network.ts:1563-1579`：`checkpoint ? { available: true, ... } : { available: false }`）。
- recover 额外要求 `checkpoint.requests.length > 0`（`network.ts:1581-1588`）。
- stop 时写全量 checkpoint 会因 `chrome.storage.local` 配额失败（`network.ts:1542-1546`），留在 storage 里的是 start 时写的空 checkpoint（`requests: []`）→ status 说「可用」，recover 说「没有」。

**期望行为**

- 两处用同一套判定；`available` 的语义要么是「有可用数据」，要么在 status 里同时给出 `recoverable: boolean`。
- checkpoint 写失败时，status 应显示失败原因（当前只写在 stop 的 `suggestedAction` 里，而 stop 本身已经超时）。

---

### Issue 12: 采集会被页面自身流量污染；stop 挂起期间同 tab 的后续命令全部超时

**处理状态**: 已处理采集过滤（`har start` 支持 `--include-pattern` / `--exclude-pattern`；stop/status/recover 本就走独立控制面，不按原分析修改 per-tab 队列）

- **严重程度**: 中高（看起来像「浏览器卡死」，实际是 per-tab 队列被占住）

**实际表现**

- 在视频页上做采集时，页面播放器持续拉取分片，这些请求同样会被打上 capture 标记 → capture 里混入几十个并发大响应体 → stop 需要等它们的 body 抓取 → 超过 30s 预算。
- 在 stop 运行期间，**同 tab 的后续命令每一条都耗满自己的 30s**（实测连续 8 条命令各 30.1s），表现为整个标签页失灵。
- 但扩展并没有真的死锁：stop 最终会以 `completed` 结束，之后同 tab 命令立刻恢复正常（0.05–0.2s）。

**根因分析**

- 修正原分析：`network har stop/status/recover` 在 command-router 中属于 `networkControl`，本来就不会进入 per-tab FIFO；运行项被 cancel 后也会与队列脱钩。因此不能据此认定 stop 一直占用队列。
- stop 仍会等待本次 capture 的 body 任务和 checkpoint/传输，浏览器侧未完成的 CDP 工作也可能继续占用资源；通过过滤无关流量和可调超时处理，不再按错误的队列假设增加快速失败。

**期望行为**

- 采集时提供排除规则（如 `network har start --exclude-pattern`），避免页面自身流量进入 capture。
- stop 挂起期间，后续命令应快速失败并提示「该 tab 有命令正在运行」，而不是静默排队到超时。
- `network har start` 应提示「capture 会包含该 tab 的全部请求」。

---

## 二、被本次排查排除的「疑似问题」（避免后人重复走弯路）

1. **HAR body 抓取本身是好的**——只要 capture 的 tab 与发请求的 tab 一致，entries 里能拿到完整 body（实测 8440 字节文本完整落地）。问题在 tab 绑定，不在 body 通道。
2. **不是「别的 tab 把我的记录挤掉」**——`network requests` 是分页的（默认 50 条/页、最多 200），`total` 另有一个字段。早期观察到的「50 条全是别的站点」是第一页恰好装满了另一个活跃页的请求，配合分页语义看并不矛盾。
3. **`Page.setDownloadBehavior` 被拒不是 autobrowser 的黑名单误伤**，是 Chromium 把它实现成了 browser 级命令（详见 Issue 7）。
4. **扩展 SW 空闲重启清空请求缓冲：未复现**。连续 45s 空闲后 `total` 保持 150 不变（relay 的长连接可能让 SW 不进入 idle 状态）。不作为 issue 记录，但 MV3 语义下仍属潜在风险。
5. **`--har-max-requests` 的全局影响是「下一个请求才生效」**（裁剪发生在 upsert 时），不是设置即刻生效。
6. **「HAR 导出的二进制 body 是损坏的」——不成立**。实测一个 48,355 字节的 `.m4s` 分片：HAR 里 `encoding: base64`，解码后与页面内 fetch 到的真实字节**逐字节完全一致**。早期看到的「字节对不上」是因为该 URL 当时返回的是 404 的 HTML 错误页，不是二进制损坏。
7. **「响应体超过 256 KiB 一定失败」——不成立**。实测一次导出 780,272 字节的 HAR（4 × 59KB 分片）用时 <1s，upload 通道本身可用。但生产路径上确实存在 30s 卡死的复现（Issue 10），属**不稳定**而非硬上限。
8. **「Twimg 对分片请求限流」——实际是 404**（返回 HTML「dog」页，不是 403）。另外该视频的 1280x720 变体在 CDN 侧整体下架：同一播放列表 01:29 还是 200，01:32 变 404；此时页面内 `fetch` 会因错误页没有 CORS 头而表现为 `TypeError: Failed to fetch`，与 CORS 故障无法区分。

## 三、优化改进方向（按优先级）

**高**

1. capture 绑定 tab 时在 start / stop 回显实际捕获的 tab；`entries` 为 0 时 `har stop` 返回非 0 退出码 + `suggestedAction`（`src/cli/commands/state.ts:552-575` 目前只回文件路径）。
2. `harMaxRequests` 与全局请求缓冲解耦（`extension/background/network.ts:330-333`）。
3. **`network har stop` / `network request` 提供可调预算**（`src/core/command-budget.ts:105-131` 目前只覆盖 eval/goto/open/click/reload/wait/feed），并保证超时后结果仍可从 checkpoint 取回（Issue 10、11）。
4. 超时中断能力（`Runtime.terminateExecution` / `Page.stopLoading`），让超时后的同 tab 命令不再卡满预算（Issue 12）。
5. 扩展增加 browser 级 CDP session，或提供「设置下载目录」的专门命令。

**中**

6. `network requests` 默认按最新优先排序；CLI 摘要显示 `total` / `totalPages` / `currentPage`。
7. `status.lastError` 成功即清，或明确区分当前错误与历史残留。
8. tab handle 持久化 + 复用校验（参考 element/frame 的 `pageEpoch` 机制）。
9. `eval` 结果增加显式体积上限与 `truncated` 标记。
10. 采集提供排除规则，避免页面自身流量进入 capture（Issue 12）。

**低**

9. 文档：在 SKILL.md 补上 `network requests` 的分页语义、`network har start` 的 tab 绑定语义、以及 `network har stop` 的空结果判读方式。

## 四、本次可用的规避方式（不改代码）

- `network har start` 一定带 `--tab <handle>`；`har stop` 后检查 `entries` 数量，而不是只看 `ok`。
- 只需要单条响应体时，用 `network request <requestId>`（返回体里带 `harEntry`），不必整包导出 HAR。
- 大块二进制不要走 `eval` 返回值；在页面内 `fetch` 后用 Blob + `<a download>` 交给 Chrome 落盘（跨 tab 多文件下载不会被拦，已实测连续两次下载均正常落盘）。

## 五、本次排查的复现脚本

```bash
# Issue 1：capture 静默抓错 tab
autobrowser tab new "https://example.com/"
autobrowser network har start --har-unlimited
autobrowser --tab t13 eval 'fetch("https://video.twimg.com/.../playlist.m3u8").then(r=>r.text())'
autobrowser network har stop out.har
python3 -c "import json;print('entries =', len(json.load(open('out.har'))['log']['entries']))"   # → 0

# Issue 2：HAR 开关截断全局历史
autobrowser network requests --all-tabs --all-epochs    # total: 150
autobrowser network har start --har-max-requests 10
autobrowser --tab t13 eval 'fetch("https://video.twimg.com/...?probe=1")'
autobrowser network requests --all-tabs --all-epochs    # total: 10

# Issue 3：分页与 total 分离
autobrowser --json network requests --all-tabs --all-epochs   # 看 result.total 与 result.pagination
```

---

## 六、本轮实测：可用的 HAR 取数配方与正向结论

**正向结论（实测通过）**

- `network har start --tab <handle>` + `network har stop <file>` 能**无损**导出二进制响应体：`content.encoding` 为 `base64`，解码后与页面内 fetch 到的真实字节逐字节一致。
- 响应体规模在 256 KiB 量级以内时，`har stop` 稳定在 0.1–0.2s，HAR 文件正常写出。
- 原生 `network request <requestId>` 同样能取到 body（同样是无损 base64），单次响应体 ≤ 256 KiB 时 0.06–0.09s。

**可用的取数配方（原生命令为主）**

```bash
# 1) 固定采集目标页
autobrowser --tab t13 network har start --har-unlimited

# 2) 页面内触发请求（浏览器自己发，包体才是原站的）
autobrowser --tab t13 eval '(async () => { /* fetch 分片 */ return "done" })()'

# 3) 导出并落盘
autobrowser network har stop out.har
```

三个必须注意的前提：

1. **`har start` 必须带 `--tab`**（Issue 1）——不带就会静默抓到别的标签页。
2. **先让页面自身的播放器停流**，否则 capture 会被播放器持续拉取的分片污染，stop 必然超时（Issue 12）。在页面里移除 `<video>` 元素即可（实测能把 capture 从几十条降到 1 条）。
3. **单次采集的总响应体控制在 256 KiB 量级**，否则触发 upload 通道，生产路径上不稳定（Issue 10）。实践中按「每批 2–3 个分片」分批即可，实测 121 个分片分 45 批、每批 0.1s 全部成功。

**本轮用该配方实测产出**

- 121/121 个分片（60 视频 + 61 音频）全部经 HAR 导出，字节零缺失。
- 合成结果：640×360 / H.264 + AAC 44.1kHz 立体声 / 177.66s / 6.65 MB，`ffmpeg -f null -` 全片解码零报错。
- 该视频的 1280x720 变体在 CDN 侧已下架（播放列表由 200 转 404），因此 HAR 路线当前只能取到 360p 轨。
