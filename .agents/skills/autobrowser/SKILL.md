---
name: autobrowser
description: '替代WebFetch获取网站数据,需要登录,受限等情况使用、点击/填写/输入、检查标签页和窗口、管理 state/cookies/storage、截图与导出 PDF、拦截网络请求以及导出 HAR。'
---

# autobrowser Skill

## 概览

autobrowser 是一个面向 Chrome/Edge 的浏览器自动化 CLI，通过本地 relay + 扩展协作完成页面操作、状态读取和网络采集。

## 适用场景

- 启动或停止本地自动化服务
- 连接浏览器扩展并确认状态
- 打开页面、切换标签页、管理窗口和 frame
- 在页面上执行点击、双击、填写、输入、按键、悬停、聚焦、选择、勾选、拖拽和上传
- 执行页面上下文脚本、等待条件、读取元素、截图、导出 PDF
- 管理 cookies、storage、clipboard、页面状态和网络请求
- 记录与导出 HAR

## 常用命令

- `help`
- `server`
- `server stop`
- `status`
- `connect`
- `open <url>` / `goto <url>`
- `back` / `forward` / `reload [--wait-for url <pattern>|selector <sel>]`
- `tab list` / `tab new <url>` / `tab select <tN>` / `tab close [tN]`
- `target show` / `target set <tN>` / `target active` / `target clear`
- `command list` / `command cancel <id>` / `command reset`
- `window new`
- `frame <@fN|selector|top>`
- `click` / `dblclick` / `fill` / `find` / `type` / `press` / `keyboard` / `hover` / `focus` / `select` / `check` / `uncheck` / `scroll` / `scrollintoview` / `drag` / `upload`
- `is`
- `get`
- `wait`
- `snapshot`
- `screenshot`
- `eval`
- `cookies`
- `storage`
- `console`
- `errors`
- `set`
- `pdf`
- `clipboard`
- `state`
- `network route` / `network unroute` / `network requests` / `network request` / `network har start` / `network har stop` / `network har status` / `network har recover`

## 可靠流程

- `server` 会启动 relay 和 IPC 服务。
- `connect` 会打开扩展连接页，并自动保存 token、relay port，以及后续运行所需的浏览器配置。
- 如果 `connect` 传入了有效 token 且扩展已经报告 `connected`，连接页可能会自动关闭；这通常表示连接成功。
- `status` 是确认扩展是否已连接的最快方式。
- `tab list` 适合在 `connect` 或 `open` 后确认当前活动标签页。
- `network har start` 可以在采集前显式设置限额：
  - `--har-max-requests <n>`
  - `--har-max-body-bytes <n>`
  - `--har-unlimited`
- `network har stop [output.har]` 会返回完整 HAR；CLI 只会在面对较旧扩展时回退到重新组装网络请求。
- `--har-unlimited` 不限制 autobrowser 自身保存的 body 大小；若浏览器 CDP 对 `Network.getResponseBody` 触发配额错误，HAR 仍会导出，并在对应 entry 的 `response.content.comment` 标明 body 获取失败原因。

## 等待语义

- `wait time 3`、`wait ms 3` 和 `wait 3` 都表示 **3 毫秒**。
- 如果要等 3 秒，请写成 `wait time 3000`。
- `--timeout <ms>` 也是毫秒。
- 如果页面仍在加载，优先使用 `open <url>` 后再配合短等待，或直接用 `wait --load networkidle`。

## eval 使用边界

- `eval` 适合执行小段页面上下文 JS，用于只读提取、状态检查或轻量验证。
- 复杂或多行源码优先通过 `eval --file <path>` 或 `eval --stdin` 传入，避免命令行转义干扰判断。
- `--timeout-ms <ms>` 只在确认脚本本身是长任务时使用；不要把它作为复杂流程失败后的默认处理。
- 复杂交互优先拆成更小的 autobrowser 命令或脚本步骤，保留原任务目标逐步推进。

## 常见回退策略

- `connect` 之后如果连接页自动关闭，优先用 `status` 检查连接结果，不要反复等待页面。
- 如果 `connect` 没有打开或没有连上，确认浏览器命令指向已加载解包扩展的配置文件，必要时显式传 `--browser-command`。
- `snapshot` 返回的 `@eN` / `@fN` 引用比脆弱的 CSS 选择器更适合后续操作。
- `find role`、`find text`、`find label` 适合先语义定位，再点击、读取或填写。
- `tab list` 返回稳定句柄如 `t1`、`t2`，优先用 `tab select tN`，不要依赖原始 tab id。
- 页面命令超时后先运行 `status` 和 `command list`。标签页控制走独立控制面，可继续用 `tab list`、`target clear`、`tab close <tN>` 恢复；不要连续重试并堆积命令。
- `goto/open/reload` 可用 `--wait-until none|commit|domcontentloaded|interactive|load|networkidle|domquiet` 选择等待阶段；`reload` 还可追加 `--wait-for url <pattern>` 或 `--wait-for selector <sel>` 等待最终页面结果，适合 hash 路由 SPA 和验证后重定向页面。
- `cookies list` 是 `cookies get` 的别名，支持同样的 `--domain` / `--path` 过滤。
- `network requests` 默认只看目标 tab 的当前页面 epoch；跨 tab 或跨页面历史必须显式使用 `--all-tabs` / `--all-epochs`，headers/body 用 `network request <id>` 或 `--include-details` 获取。
- HAR 中断后先用 `network har status` 检查 checkpoint，再用 `network har recover [output.har]` 导出。
- 在旧扩展上，`network har stop` 可能只返回元数据；CLI 会自动兜底重建 HAR。
- 如果页面看起来空白或不对，先确认是不是登录页、验证码页，或者虚拟滚动列表。
- 对于类似 x.com 的 SPA 列表页，优先从 `article` 等可见节点读取内容，不要直接相信 `get text body`。
- `eval` 超时或页面内异常时保持原任务目标，不要换方案；先用 `status`、`snapshot`、`console`、`errors` 诊断页面状态和脚本问题，再围绕原任务重试。

## AI 专属原则 (AI-Agent Exclusives)

- ❗ **当 autobrowser 命令失败（如超时、找不到元素、被弹窗拦截、引用过期）时，明确禁止去尝试编写 Python/Selenium/Puppeteer 等其他框架脚本作为替代方案。**
- 失败通常意味着当前持有的页面状态已陈旧、网络缓慢或存在未处理的各类弹窗。应该仔细阅读报错和执行建议。
- 遇到错误时，先通过 `status` 获取控制面状态；页面仍可响应时再运行 `snapshot`。页面卡死时用 `command list`、`tab list` 和 `target clear` 恢复目标后继续使用 autobrowser。

## 更新约定

- 这个技能文件应当与当前 CLI 帮助和实现保持一致。
- 如果新增命令、改名、或调整 HAR / 网络行为，优先同步这里的说明。
