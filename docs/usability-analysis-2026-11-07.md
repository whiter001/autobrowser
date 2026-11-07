# autobrowser 易用性评估（2026-11-07）

> 评估方式：实机运行 CLI（`bun src/cli.ts …`）观察真实输出与退出码，读取 `src/cli/help.ts` 的帮助树与 `src/cli/flags.ts` 的全局标志位定义，再与 `README.md`、`.agents/skills/autobrowser/SKILL.md` 逐条对照。
>
> 定位：这份文档只谈**易用性**（能不能用对、出错时能不能自己爬起来、文档和实现是否一致）。功能缺失、能力边界、架构问题不在范围内。
>
> 与既有文档的关系：[`usage-issues.md`](usage-issues.md) 记录的是具体功能 bug；[`usage-issues-2026-11-06.md`](usage-issues-2026-11-06.md) 记录的是 reload 超时与断连恢复的观测。本文是横向的体验评估，不重复这两份的条目。

## 结论

autobrowser 的**能力面已经足够**，命令覆盖了导航、交互、采集、网络、诊断的完整链路，运行期错误也带了机器可读的 `code` + `suggestedAction`——这部分做得比多数同类工具好。

短板集中在三个地方，且都属于"用户以为自己做对了，其实没有"：

1. **解析期（CLI 层）错误不走 JSON 契约**，是裸文本，且没有错误码和修复建议。运行期错误很规范，解析期错误却最常被撞上。
2. **帮助树与文档和实现三处不同步**：根 help 漏掉最关键的 `--session`/`--engine`，分页 flag 实际接受却不写，`tab` 句柄形态与文档示例不一致。
3. **缺少"环境自检"入口**。新用户最大的卡点（扩展装了吗？连上了吗？为什么没反应？）分散在 `status`、`extension info`、`config` 三条命令里，没有一条命令给出整体结论和下一步。

以下条目按"踩坑概率 × 恢复成本"排序。

---

## P0 · 会直接导致误用

### 1. `wait 3` 是 3 毫秒，而且静默成功

实测：

```
autobrowser --tab t2058761205 wait 3
→ { "ok": true, "result": { "waited": true, "condition": "time", "ms": 3, … } }
```

`wait` 的裸数字参数单位是**毫秒**。用户（和 agent）几乎必然会把 `wait 3` 理解成"等 3 秒"，而命令返回 `ok: true`，没有任何 warning——这比直接报错更糟，因为它给了虚假的确定感。

这个陷阱目前**只写在 `SKILL.md`**（"如果要等 3 秒，请写成 `wait time 3000`"），而 CLI 自己的 `autobrowser help wait` 里没有任何提示：

```
--ms <ms>  wait a fixed duration in milliseconds
positional aliases: wait time|ms <ms>, wait url <pattern>, …
```

`milliseconds` 这个词挡不住一个正在赶时间的人。

**建议**

- `help wait` 首行加显式警告：`裸数字按毫秒解释（wait 3 = 3ms，不是 3 秒）；等秒请写 wait time 3000`。
- 裸数字 `< 100` 时在结果里回一个 `warning` 字段（不改语义、不破坏兼容），例如 `suggestedAction: "已按毫秒解释；若想等 3 秒请用 wait time 3000"`。
- 更彻底的做法是支持单位后缀（`wait 3s` / `wait 300ms`），裸数字保持毫秒不变以便兼容。

### 2. CLI 解析期错误不走 JSON 契约

实测：

```
autobrowser click            → missing value for click            (纯文本，无 code)
autobrowser click "#a" --nope → unexpected extra argument for click: --nope
autobrowser --json click     → missing value for click            (--json 无效)
```

对比运行期错误，格式完整得多：

```json
{ "ok": false, "error": { "message": "…", "code": "STALE_REFERENCE",
  "details": null, "suggestedAction": "…" } }
```

问题有三层：

- **契约不一致**：agent 按"stdout 永远是 JSON"解析，遇到解析期错误会直接崩在最需要它的时候。
- **缺错误码**：没有 `code`，无法按码分支处理。
- **缺修复建议**：`missing value for click` 没告诉用户该怎么写。

`SKILL.md` 里写着"每个错误码都带默认 `suggestedAction`"，但解析期根本没有错误码——文档承诺的契约没有覆盖到这一层。

**建议**：在 CLI 分发层统一收口，解析期错误也输出同样的 JSON 结构，新增 `CLI_INVALID_ARGUMENT` / `CLI_UNKNOWN_COMMAND` 两个码，并挂上 `suggestedAction`（如"命令需要 1 个选择器参数，见 `autobrowser help click`"）。

### 3. 未知命令不报"未知命令"，只打印整页根 help

实测：

```
autobrowser bogus
→ 打印约 130 行完整根 help（含 Flags、75 个命令）
→ exit code 1
```

没有任何一行提示"你输入的 `bogus` 不存在"。用户和 agent 只能自己在 130 行里找差异——**这是最常见的第一次误用场景**（记错命令名、少打一个词）。

而且现有基建里已经有 `src/cli/option-hints.ts`（`didYouMeanOption` / `optionHintSuffix`），但只接在 `network`、`console`、`tab list` 三处（`src/cli/parse.ts:244`、`src/cli/parse.ts:492`、`src/cli/commands/tabs.ts:66`），命令名层面没有对应的"你是不是想写 ……"。

**建议**

- 未知顶层命令时输出 `Unknown command "bogus"`，用编辑距离给出最多 3 个候选（`snap` → `snapshot`、`stat` → `status`）。
- 此时**不要**打印整页 help，只打印分组后的命令名列表（一行一个名字，不带 usage 和 summary）。
- 复用 `option-hints.ts` 的候选算法，不要另起一套。

---

## P1 · 可发现性与信息架构

### 4. 根 help 漏掉了最关键的两个全局标志位

实测 `autobrowser help` 的 Flags 列表里**没有** `--session`、`--engine`、`--webdriver-url`、`--brief`。

而这四个都在 `src/cli/flags.ts:4-24` 的 `SUPPORTED_GLOBAL_FLAGS` 里被真实支持。`--session` 更是 `README.md` 反复强调"必须放在命令名前"的那个。

根因是**两份真值源不同步**：

- `src/cli/help.ts:37-52` 的 `HELP_ROOT.options` 里正确写了 `--session` / `--engine` / `--webdriver-url`，但 `renderHelp` 在 `src/cli/help.ts:1064` 用 `if (!isRoot && node.options …)` 把它排除在根节点渲染之外——**这份数据对根节点是死代码**。
- 真正被渲染的是另一份手写常量 `ROOT_HELP_FLAGS`（`src/cli/help.ts:990-1005`），它没有跟着 `flags.ts` 更新。

测试里也没有锁住这两者的关系，所以漂移不会被 CI 发现。

**建议**：删除 `ROOT_HELP_FLAGS`，根节点直接渲染 `HELP_ROOT.options`；或者更进一步，从 `flags.ts` 的 `SUPPORTED_GLOBAL_FLAGS` + 一份描述映射单源生成 help。补一条一致性测试：每个 `SUPPORTED_GLOBAL_FLAGS` 都必须出现在根 help 里。

### 5. 75 个顶层命令平铺，没有分组

根 help 的 Commands 段是 75 个顶层命令（另有约 70 个子命令路径）逐行罗列，没有分类。

对照之下，**README 已经按用途分好组**（"页面与导航 / 标签页与控制 / 浏览器、网络与状态 / 其他交互与诊断"），**MCP 工具也分了组**（`README.md:523-526`）。唯独 CLI help 是平的——这恰好是新用户和新 agent 最先看到的那个视图。

**建议**：给 `HelpNode` 加一个 `category` 字段，根 help 按类别分段渲染（导航与标签页 / 元素交互 / 状态与诊断 / 网络与采集 / 媒体与下载 / 会话与服务）。分组后根 help 可以从 130 行降到 60 行以内。

### 6. 根 summary 是一段预算告警，不是一句定位

`src/cli/help.ts:34` 的根 summary 是 100 多词，讲的是 30 秒预算、5 秒传输余量、30 分钟上限、不自动重放——**这些是边缘语义，却占了用户看到的第一屏**。而"autobrowser 是什么"这句话反而不在 summary 里，只在 README 开头。

这段内容在 `SKILL.md` 的"总预算与重试"一节里已经完整讲过一遍。

**建议**：根 summary 改成一句定位（"通过浏览器扩展 + CDP 驱动 Chrome/Edge 的自动化 CLI"），预算语义下沉到 `help batch` / `help wait` / `docs/overview.md`。

### 7. help 的 flag 列表落后于真实接受的 flag

`src/cli/parse.ts:216-220` 有一段明确注释的容错：

```ts
// --limit 是分页场景的高频误写，直接按 page-size 接受，省掉一轮试错
if (value === '--page-size' || value === '--limit') { … }
```

也就是说 `network requests --limit 30` **是被支持的**（实测 `endIndex: 3`，分页正常）。但 `autobrowser help network requests` 的 usage 里：

```
autobrowser network requests [--filter <text>] [--type <xhr,fetch>] [--method <POST>]
                              [--status <2xx>] [--sort oldest|newest]
                              [--all-tabs] [--all-epochs] [--include-details]
```

`--limit`、`--page-size`、`--page`、`--page-idx` **一个都没列**。`console` / `errors` / `tab list` 有同样的问题。用户和 agent 只能靠试。

这同时暴露一个更根本的问题：**flag 白名单、usage 串、help 树是三份手写数据**，注释里说要靠 `docs/README.md` 的"以 `src/cli/help.ts` 为权威来源"来维持，但 flag 白名单其实在 `parse.ts` 里。

**建议**：给每个命令声明一份 `options` 元数据（名字 + 是否带值 + 说明），usage 串和"unsupported option"的 did-you-mean 候选都从它生成，从根上消除三处手写。

### 8. tab 句柄形态与文档示例不一致

`README.md:373-379` 的示例是：

```bash
autobrowser tab list
autobrowser tab select t2
autobrowser tab close t3
```

实测本机真实句柄是 `t` + Chrome tabId：

```json
{ "id": 2058758614, "handle": "t2058758614", … }
```

照抄文档执行 `autobrowser --tab t2 click "#x"` 会拿到：

```json
{ "ok": false, "error": { "code": "STALE_TAB_HANDLE",
  "message": "tab not found: 2",
  "suggestedAction": "Run tab list to see open tabs and refresh handles." } }
```

`SKILL.md` 里其实写对了（"`tN` 的句柄由 Chrome tabId 直接派生"），但 README 用 `t2`/`t3` 当示例，**新用户第一份文档就是错的**。

这不是单纯的文档问题：`t2058761205` 这样的句柄会出现在每一条命令的 `meta.tabHandle` 里，agent 每次都要多消耗十几个 token 去回传它。

**建议**（按取舍排序）

- 短期：把 README 示例改成真实形态并加一句"句柄是 `t` + Chrome tabId，不是序号"。
- 中期：给 tab 一个会话内短序号（`t1`、`t2`）作为主展示形态，同时保留 `t<tabId>` 作为等价输入。注意这会破坏"句柄由 tabId 单向派生、跨重连仍可用"的现有设计（`SKILL.md` 的"断连恢复"一节依赖它），需要先确认取舍。
- 另一条路：保持长句柄，但在 `tab list` 的输出里额外给一个 `shortHandle` 字段。

---

## P2 · 一致性与输出成本

### 9. 超时与分页参数命名不统一

| 概念 | 写法 |
|---|---|
| 超时 | `wait --timeout <ms>`，其余全部 `--timeout-ms <ms>` |
| 分页条数 | `--limit` / `--page-size`（互为别名） |
| 分页页码 | `--page` / `--page-idx`（互为别名） |

`wait` 是唯一一个用 `--timeout` 的命令，而 `--timeout-ms` 是全项目主流。`--limit` 和 `--page-size` 并存虽然有容错，但"哪个是正式名"没有交代——`help network` 里两个都没写。

**建议**：统一到 `--timeout-ms`（`--timeout` 保留为别名并提示）、`--page-size`、`--page`；把别名收敛到一处并在 help 里显式列出。

### 10. `network requests` 默认没有条数上限

实测本机当前 tab 有 95 条请求记录，`autobrowser network requests` 一次性全返回，**单条响应就是几万字符**。对 agent 来说是纯粹的 token 浪费，而用户想看的往往只是"刚才那个接口返回了什么"。

更糟的是，响应里没有任何提示告诉调用方"你可能需要 `--filter`"。

**建议**

- 默认加一个上限（例如 `--page-size` 默认 50），并在 `pagination` 里回显 `hasNextPage`（这部分已经有了）。
- 未带 `--filter` 时，在 `meta.suggestedAction` 里提示"用 `--filter`/`--type` 缩小范围"。
- 这与 `usage-issues.md` Issue 4 已有的"空结果给引导"是同一套思路，只是补上"结果太多"的另一半。

### 11. `STALE_REFERENCE` 混淆了"选择器没匹配"和"引用过期"

实测 `autobrowser click "#no-such-elem-xyz"` 返回：

```json
{ "code": "STALE_REFERENCE",
  "suggestedAction": "The target element was not found. If this was from a previous snapshot reference like @eX, the page may have updated. Ensure you run 'snapshot' to get fresh element references." }
```

但这里传的是**裸 CSS 选择器**，根本不存在"快照引用过期"这回事。真正的原因是选择器写错、元素在 iframe 里、或元素还没渲染。三种情况的修复动作完全不同，现在被合并成一个误导性的码。

**建议**：拆成 `ELEMENT_NOT_FOUND`（裸选择器未匹配，suggestedAction 提示检查选择器/确认元素在当前 frame）和 `STALE_REFERENCE`（`@eN` 引用过期，提示重新 snapshot）。`src/core/error-actions.ts` 已经按码集中管理建议，加码的成本很低。

### 12. did-you-mean 只覆盖了少数命令

`option-hints.ts` 的注释写得很清楚："目的是把 unsupported option 从死胡同变成纠错提示"。但它只接在 `network`、`console`、`tab list` 三处，`click`/`fill`/`snapshot`/`find` 等常用命令遇到拼错的 flag 只有一句冷冰冰的 `unexpected extra argument`。

**建议**：既然基建已经有了，在命令分发层统一接入一次即可。

---

## P3 · 上手与文档

### 13. 没有环境自检命令

新用户的第一轮问题永远是这三个：扩展装了吗？连上了吗？为什么没反应？

目前要分别跑 `status`（看连接）、`extension info`（看版本/诊断）、`config`（看保存的浏览器路径）、`tab list`（看目标），再自己拼结论。`status` 里也只有一句 `extension: connected` / `waiting for extension`，不会告诉你下一步该干什么。

**建议**：新增 `autobrowser doctor`，逐项输出检查结果和对应修复命令：

```
runtime        ok      bun 1.4.4
extension      ok      loaded, id=bfccnpkjkbhceghimfjgnkigilidldep
connection     ok      connected (relay 127.0.0.1:57978)
version        warn    CLI 1.2.0 / extension 1.1.0 — 请先 build:chrome 再 extension reload
target         ok      t2058761205 挂单监控 - …
```

`status` 保持现在的轻量定位，`doctor` 承担"我该做什么"的回答。

### 14. `SKILL.md` 有一段逐字重复

`.agents/skills/autobrowser/SKILL.md` 第 82–83 行是**完全相同的两行**（"操作系统都不为 `chrome-extension://` 注册协议关联…"）。同时全文 31KB / 193 行，对 agent 上下文偏重，"不要盲目重放"这类告警在文中重复出现 10 次以上。

**建议**：删掉重复行；把重复告警收敛成一节"结果未知时的处置准则"，各章节只引用不重述。

### 15. `docs/README.md` 索引漏项

索引里没有 [`usage-issues-2026-11-06.md`](usage-issues-2026-11-06.md)（最新的一份易用性记录）。按 `docs/README.md` 自己的约定"README 只保留高层概览，把详细使用问题导向这里"，这份文档进不了索引就等于不存在。

---

## 建议的落地顺序

| 优先级 | 改动 | 成本 | 收益 |
|---|---|---|---|
| 1 | 解析期错误统一 JSON + 错误码 + suggestedAction | 小 | 消除契约不一致，agent 不再崩 |
| 2 | 未知命令报错 + did-you-mean + 不再打印整页 help | 小 | 消除最常见的第一轮误用 |
| 3 | 根 help 补齐全局 flag（删 `ROOT_HELP_FLAGS`，单源生成） | 小 | `--session`/`--engine` 可发现 |
| 4 | `help wait` 补毫秒警告 + `ms<100` 时回 warning | 很小 | 消除最隐蔽的单位坑 |
| 5 | `network requests` 默认条数上限 + filter 提示 | 小 | 直接省 token |
| 6 | `ELEMENT_NOT_FOUND` 与 `STALE_REFERENCE` 拆分 | 小 | 错误码可分支，诊断不再误导 |
| 7 | help 命令分组 + 根 summary 改写 | 中 | 根 help 从 130 行降到 60 行内 |
| 8 | flag 元数据单源化（usage 串 + did-you-mean 共用） | 中 | 根治 help 与实现漂移 |
| 9 | `doctor` 命令 | 中 | 收敛上手路径 |
| 10 | README 的 tab 句柄示例改真实形态；评估短句柄 | 中 | 消除文档误导 |

## 本次一并修掉的两处确凿缺陷

- `SKILL.md` 第 82–83 行的逐字重复段落已删除一行。
- `docs/README.md` 索引补上 `usage-issues-2026-11-06.md` 和本文。

## P0 第 2、3 条已修复（2026-11-07）

CLI 解析期错误现在和运行期错误走同一套 JSON 契约：

- 新增 `src/cli/cli-error.ts` 作为 CLI 唯一错误出口，错误码有 `CLI_INVALID_ARGUMENT`（缺参/多参/取值非法/未知选项）、`CLI_UNKNOWN_COMMAND`（未知命令）、`CLI_ERROR`（其它 CLI 层失败），全部登记在 `src/core/error-actions.ts`，都带默认 `suggestedAction`。
- 命令层不再就地往 stderr 写裸文本，改为抛出带错误码的异常，由 `src/cli.ts` 的分发层统一按 `{ok:false,error:{message,code,details,suggestedAction}}` 输出到 stdout（`--raw`/`--brief` 仍走 stderr 文本）。
- 未知命令不再打印整页根 help，改为 `CLI_UNKNOWN_COMMAND` 报错，并用 `option-hints.ts` 的编辑距离给出最多 3 个候选（`snap` → `snapshot`），候选同时放在 `details.candidates`。
- 第 12 条（did-you-mean 覆盖更多命令的 option）未包含在本次改动内，仍只有 `network`、`console`、`tab list` 三处接了 option 提示。
