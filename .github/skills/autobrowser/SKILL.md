---
name: autobrowser
description: 'Use when automating browser tasks with autobrowser: start the server, connect the extension, navigate pages, click/fill/type, inspect tabs and windows, manage state/cookies/storage, capture screenshots and PDFs, route network requests, and export HAR files.'
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
- `back` / `forward` / `reload`
- `tab list` / `tab new <url>` / `tab select <tN>` / `tab close [tN]`
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
- `network route` / `network unroute` / `network requests` / `network request` / `network har start` / `network har stop`

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

## 等待语义

- `wait time 3`、`wait ms 3` 和 `wait 3` 都表示 **3 毫秒**。
- 如果要等 3 秒，请写成 `wait time 3000`。
- `--timeout <ms>` 也是毫秒。
- 如果页面仍在加载，优先使用 `open <url>` 后再配合短等待，或直接用 `wait --load networkidle`。

## 常见回退策略

- `connect` 之后如果连接页自动关闭，优先用 `status` 检查连接结果，不要反复等待页面。
- 如果 `connect` 没有打开或没有连上，确认浏览器命令指向已加载解包扩展的配置文件，必要时显式传 `--browser-command`。
- `snapshot` 返回的 `@eN` / `@fN` 引用比脆弱的 CSS 选择器更适合后续操作。
- `find role`、`find text`、`find label` 适合先语义定位，再点击、读取或填写。
- `tab list` 返回稳定句柄如 `t1`、`t2`，优先用 `tab select tN`，不要依赖原始 tab id。
- 在旧扩展上，`network har stop` 可能只返回元数据；CLI 会自动兜底重建 HAR。
- 如果页面看起来空白或不对，先确认是不是登录页、验证码页，或者虚拟滚动列表。
- 对于类似 x.com 的 SPA 列表页，优先从 `article` 等可见节点读取内容，不要直接相信 `get text body`。

## 更新约定

- 这个技能文件应当与当前 CLI 帮助和实现保持一致。
- 如果新增命令、改名、或调整 HAR / 网络行为，优先同步这里的说明。
