# 高级自动化

## 信息流与虚拟列表采集

- `feed collect [selector] --limit <n>` 自动滚动并收集卡片，输出 author、handle、time、text、url、mediaUrls、avatarUrls、timelineContext、repostBy、adapter、promoted、authorUrl、trackingUrl；`stopReason` 区分 limit/maxScrolls/stalled。等待新卡片或列表稳定可分别用 `wait <selector> --state new|stable`。
- `mediaUrls` 只含正文图片/视频，头像单独放 `avatarUrls`（X 的 `/profile_images/` 路径与常见 avatar/profile 语义容器算头像；没有头像语义的普通站点图片仍算正文媒体）。
- `promoted` 表示是不是广告推广条目（普通条目为 `false`），`authorUrl` 是作者主页地址，`trackingUrl` 是广告跟踪链接；站点没有对应语义时后两者为 `null`。
- `timelineContext` 是时间线上下文（如 `Hongbo Zhang 已转帖`），没有则为 `null`；`repostBy` 是转帖人，不是转帖或识别不出时为 `null`。转帖不会改写 author/handle。
- `adapter` 是本次生效的可选站点适配层 id（如 `youtube`），没有启用时为 `null`。适配层只有在 host 与页面 DOM 特征都命中时才启用；未启用时所有字段都来自通用采集逻辑，不要因为 `adapter: null` 就认为字段缺失。
- YouTube 语义（适配层启用时）：`author` 是频道名，`handle` 取自指向 `/@name` 的频道链接，`time` 只从视频元信息行取可靠的相对时间或明确日期（`3 个月前` / `3 months ago` / `Oct 5, 2024`），取不到就是 `null`，不会从描述正文里猜日期；频道链接（`/@`、`/channel/`、`/user/`）里的图片算头像，普通的 `/watch` 视频缩略图仍算正文媒体。X 页面继续走通用逻辑，社交上下文与转帖人识别不受影响。
- B 站语义（适配层启用时，页面存在 `.bili-video-card` 或 `.bpx-player-primary-area`）：`author` 取 `.bili-video-card__info--owner` 的第一个非空行（作者区域里的空头像图标不算作者），`time` 只从卡片日期区域取并去掉前导 `·` 等分隔符（取不到就是 `null`，不会从描述里猜日期），`url` 只认 BV 视频链接，`authorUrl` 是 `space.bilibili.com/<uid>`；B 站没有 handle 概念，`handle` 为 `null`，不要伪造 `@handle`。`cm.bilibili.com` 跟踪链接或明确的“广告”标记会让 `promoted` 为 `true`，跟踪链接只进 `trackingUrl`；只有广告链接没有 BV 时 `url` 为 `null`，`dedupe=url` 会回退到作者+正文，不会拿超长跟踪 URL 当身份。
- 默认 `dedupe=url` 优先按链接去重，无链接卡片自动回退到 author/handle/text，避免虚拟列表重复交付；需要强制正文去重或允许重复时显式选 text/none。
- 采集期间不要导航或刷新。page epoch 变化会返回 `STALE_FEED_STATE` 并丢弃旧结果，应在当前页面重新采集，不要把旧卡片与新页面拼接。
- 长任务用 `collect run <spec.json>` 将 feed 或 network-first 流程一次执行并输出 JSONL。network spec 需要 `urlPattern/itemsPath`，可选 `nextPath` 跟随真实响应游标；没有匹配数据返回 `NETWORK_DATA_NOT_FOUND`，先检查请求链，不要伪造 DOM 结果。
- 输出是追加式 JSONL，checkpoint 是 version 2 的小文件（`spec/status/nextUrl/nextPage/failures/itemCount`，不含条目数组）：每页只追加新条目，不重写整个输出，翻页成本与已有数据量无关。
- `collect resume <checkpoint.json>` 会用 node stream 流式扫描一遍输出 JSONL，重建去重集合与 `itemCount`，既不把整个文件读进内存也不重写输出；从失败页继续并按内容去重，完成态 resume 是 no-op。
- 崩溃窗口（条目已追加、checkpoint 还没推进）：resume 会重抓该页，并按已落盘内容跳过重复条目后正常推进，不会产生重复行。
- 输出末尾若残留上次崩溃留下的半行 JSON，resume 只截掉这段残片、保留有效前缀，并在结果与 checkpoint 的 `warnings` 里说明；最后一行是合法 JSON 但缺换行时，追加前会先补换行，不会把两条记录粘连。
- 中间出现损坏的 JSON 记录会报 `COLLECT_OUTPUT_CORRUPT` 且不推进 checkpoint；输出文件缺失但 checkpoint 已记录条目时报 `COLLECT_OUTPUT_MISSING`，不要从零重跑，先把输出文件找回来。
- 旧的 version 1 checkpoint 在 resume 时会一次性迁移成 version 2（以 `checkpoint.items` 为权威重写输出，`_meta` 与 `failures` 原样保留），之后只追加。
- `feed` 模式的 `nextSelector` 翻页：点击前先捕获列表签名（可见节点数 + 前几个节点的文本/href/几何），点击后等待签名变化；同步替换整列表也能立刻判定成功，不要依赖 `wait new`（它的基线建立得太晚，同步替换会永远等不到变化）。签名读不到（选择器没匹配到可见卡片）会报错并停在当前页，resume 后重试。
- 失败根据提示运行 `collect resume <checkpoint.json>`。结果可能含敏感页面数据，妥善保管输出文件，checkpoint 不保存 cookie/token。

## 静态结构化提取（extract）

- 根级 `extract` 按 spec 从当前页面静态提取一维记录：`autobrowser extract ./spec.json`。只读 DOM，spec 内容以数据形式注入，不会被当成代码执行。
- spec 是 `{itemSelector, fields:{name:{selector?, attr?, type?, required?}}, limit?}`：`itemSelector` 选中每个条目根节点，`fields` 定义要取的字段名与取法。
- 取值规则：`selector` 省略时在条目根元素上取值，`attr` 读属性，`type` 取 `text|string|number|boolean|url|html`（默认 `text`），`url` 基于 `document.baseURI` 转绝对地址。
- `required` 字段缺失或类型非法（`number/boolean/url`）会让整行作废；可选字段缺失或非法写 `null` 并计入 `missingFields`。
- `--dry-run` 默认只取前 5 条且不能与 `--output` 同用，显式 `--limit` 覆盖 dry-run 条数与 spec 里的 `limit`；`--output items.jsonl` 只把有效 items 写成 JSONL。
- 无 `--output` 时返回 `items` 与 `quality`；`quality` 含 `matchedCount`、`scannedCount`、`itemCount`、`invalidCount`、`missingFields`、有界 `errors`（含 `rowIndex/field/code/message`）、`totalErrorCount`、`errorsTruncated`——先看 quality 再决定是放宽 selector 还是换字段取法。
- 空匹配是成功结果（`items: []`、`matchedCount: 0`），不要当成失败反复重跑；相对路径按调用方 cwd 解析，根级 `--tab`/`--frame` 同样生效。
- 与 `feed`/`collect` 的分工：`extract` 处理当前页已经渲染出来的静态列表；需要滚动加载或翻页的流式内容用 `feed`/`collect`。

## 长文与 PDF 读取（read_page）

- `read_page` 面向“读正文”而不是“找元素”：它滚动扫描 DOM（或解析 PDF 文本层），把捕获到的全文分片返回。与 `snapshot`（可交互元素）、`search`（已加载文本里的查找）、`feed`（结构化卡片）分工不同。
- 只有 `complete:true` 表示真正扫到底；`ok:true` 不等于读到了全文。`stopReason` 说明为什么停：`maxScreens`（屏数用尽）、`endlessFeed`（信息流持续长高）、`renderFrozen`（后台标签渲染被冻结）、`stalled`（滚动卡住）、`budgetExhausted`（页内预算耗尽）、`documentChanged`（扫描途中页面变了）、`captureLimit`（超过 400 万字符）、`noText`（没有文本）。空文本永远不会标成 `complete`。
- `--cursor` 续读同一次扫描已捕获的内容（扩展侧缓存最多 8 份、总文本 8MiB、5 分钟 TTL），不会重新滚动扫描，因此不能与 `--max-screens`/`--timeout-ms` 同用。页面导航、URL 变化或缓存过期后游标失效并返回 `STALE_READ_CURSOR`；此时重新不带 `--cursor` 跑一次，不要把旧文本当成新页面。
- `--output <path>` 把本次扫描捕获的完整文本（不只是 stdout 当前分片）以 UTF-8 原始文本写入文件，stdout 改为 `{ path, bytes }` 并保留完整读取元数据；长文优先落盘再按需摘取，避免把整篇塞进上下文。
- 分片不会切断 UTF-16 代理对；同一篇正文里合法重复的行会保留（只去掉相邻两屏因滚动而重叠的部分），虚拟列表不会重复交付同一段文字。
- PDF 页面自动切换为 `strategy:"pdf"`：逐页取文本层并保留 `[page N/M]` 标记，返回 `pdfStatus`（`ok`/`loading`/`no_text`/`password`/`too_large`/`unavailable`）与 `pages`/`pagesRead`。顶层原生 PDF 的视图器不可达时，会按原 PDF URL 带登录态（`credentials:"include"`）下载原始字节（上限 20MiB），用扩展内置 pdf.js 在本地解析文本，字节不发往外部服务。密码保护、无文本层、未加载完成、解析失败都不会返回 `complete:true`；没有文本层时只提示外部做 OCR，autobrowser 不自动 OCR、不绕过密码。frame 里的 PDF 用 webNavigation 的 `documentId` 唯一定位，同名 URL 出现在多个 frame 时报 `AMBIGUOUS_FRAME`，不会猜一个。
- 只读观察：不点击、不提交、不主动激活标签页，读完恢复原滚动位置；可在只读 workspace 运行。

## SPA 列表与文本采集

- 对于类似 x.com 的 SPA 列表页，优先从 `article` 等可见节点读取内容，不要直接相信 `get text body`。
- 长文正文优先选择语义容器，例如 `article`、`[itemprop="articleBody"]`、站点实际使用的正文根节点；“取 `innerText` 最长的容器”只作兜底，因为 `body` 常混入热门评论、推荐阅读和“大家都在搜”。先在选定正文根节点内排除导航、分享、评论和推荐区，再读取文本；不要把某个站点的类名当成通用规则。
- 生产构建通常不暴露 `__vue__` 等框架内部对象，遍历 DOM 也找不到时不代表组件状态不存在。优先读渲染后的 DOM 和已捕获的网络响应；需要完整响应体时，可在正确页面/frame 上下文用原生 `fetch`（必要时 `credentials:"include"`）复现只读接口，不要依赖框架私有字段。

## 脚本注入注册

- `script add` 注册的是"下一次文档加载前注入"的脚本：返回 `registration.appliesTo:"next-document-load"`、`attachedTabs`、`failures`，必要时附 `warnings`。`registeredTabs: []` 表示当时没有已附加的标签页——配置已保存但不会注入，要等导航/刷新后才生效；`failures` 非空说明注册失败，不要只看 `ok:true`。
- 已注册的 init script 会持久化：扩展被回收或重载后，重新 attach 时自动 replay。`script list` 为空就是确实没有注册，不要把它当成"已注册但没生效"。

## Playwright Page 脚本

- `run <file.js>` 执行文件中的 `async (page) => { ... }`，获得真实 Playwright Page；可用 `--tab <tN>` 选 tab、`--timeout-ms <ms>` 控制总预算，也可用共享的 `--file/--stdin/--base64` 输入。返回值在 `result.value`。
- run 会等待目标 tab 已在执行的旧命令，然后独占该 tab；等待或运行期间普通同 tab 命令返回 `PAGE_SCRIPT_ACTIVE`，应等待结束或显式操作其他 tab，不要并发打架。其他 tab 可并行。
- 脚本只获得一个已有 tab；用 `page.frames()` / `page.frameLocator()` 处理 frame，不传根级 `--frame`。不支持 `context.newPage()`，也不能嵌进 batch，目前不支持 WebDriver/MCP。
- 脚本是有本地 Node.js/Bun 权限的可信代码。结束、失败、超时和断连都会释放锁，但不会撤销已发生的页面副作用；重试前先检查页面。`page.route()` 随桥接停止而失效，autobrowser 会按 tab 恢复自己的路由。

## 组件交互与异步断言

- `fill` 负责派发真实输入事件，但受控组件可能按自身状态回滚输入值。antd DatePicker 支持文本录入时，先 `click` 输入框，再用 `type <selector> <value>` 逐键输入日期并按 `press Enter`，最后用 `get value` 核验；`fill` 不等于逐键输入，不能用它回滚就断言组件不支持手动输入。组件未接受键入或只需面板选择时，再打开面板点击具体日期单元格，不要反复 `fill` 或改用 DOM 赋值绕过组件。
- `fill` 成功、`get value` 读出正确值，只证明**控件值**，不证明业务已生效：日期、筛选条件、查询框改完后，很多页面要按 Enter 或点页面上的"查询"按钮才会发请求刷新数据。0 条结果先核对查询时间范围（默认区间常常很短）和筛选条件，再用 `network requests --filter <接口片段>` 确认请求确实发出且参数正确；不要因为控件值正确就断言"没有数据"，也不要反复重填或改方案。
- `type --submit` 的 Enter 紧跟键入发出，受控组件可能还没处理完 `input` 事件就读到空串并把值清空（antd DatePicker 实测会被清空）。组件库场景用 `type` 后单独 `press Enter`，中间留出事件处理时间。
- `fill ""` 会触发受控组件的 `onChange(null)`，对"一组输入框"是破坏性的：antd RangePicker 只对一侧 `fill` 就会清掉整段区间（含另一侧已填好的值）；`press Escape` 同样会取消"只选了一半"的区间。范围选择器填不同起止值只能点浮层单元格，两端填同一个值也可以（文本录入只会写进一侧）。
- RangePicker 的文本录入只能写进一半：在起始框输入会清掉结束值，反之亦然；**起止两端填同一个值**才能得到完整区间（`2026-02` → `2026-02` 实测有效）。两端填不同值只能点浮层里的日期单元格。
- antd 各 picker 的默认 format（实测结论，文本录入按此格式填）：

  | 类型 | format | 备注 |
  |---|---|---|
  | date | `YYYY-MM-DD` | |
  | week | `YYYY-WW周` | zh_CN locale，`wo` 渲染成"周"；`2024-12th` / `2024-W12` 也能解析 |
  | month | `YYYY-MM` | |
  | quarter | `YYYY-QN` | 面板单元格文案就是 `Q1`~`Q4` |
  | year | `YYYY` | |
  | time | `HH:mm:ss` | 输 `12:30` 会被补成 `12:30:00` |
  | date + showTime | `YYYY-MM-DD HH:mm:ss` | 范围选择器带 showTime 时是 `YYYY-MM-DD HH:mm` |
- antd 带 showTime 的 RangePicker：选完起始日期与时间后要再点浮层底部的「确定」（`.ant-picker-ok button`），面板才会切到结束选择；`mode="time"` 的 DatePicker 面板点不动，只能往输入框录完整日期时间。取值优先从浮层里"未禁用的单元格"反推，`disabledDate` 会让含禁用日期的月份在界面上仍显示可用、但录入被拒。
- 判断 antd 浮层是否打开用 `d.style.display!=='none'` 加高度判断，不要用 `ant-slide-up-enter/leave` 动画 class（窗口失焦时 leave 动画可能永远不结束，class 会停在 enter）；连续操作多个选择器时先关掉上一个浮层，否则它的 portal 会盖住下一个输入框，让 `click` 打在浮层上。
- `click` 是一次真实点击；对按钮、输入框等 toggle 控件，先用 snapshot/eval 检查面板或弹层当前状态，不要在 eval 里调用 `el.click()` 后又无条件执行一次 `click`，否则第二次可能把刚打开的面板关闭。
- Vue/React 等框架的状态更新和渲染是异步的，`.click()` 后同步读取 DOM 可能仍是旧值。优先用 `wait <selector>`、`wait --fn '<expression>'` 或 `wait --text <text>` 等条件等待；不要固定 sleep 2~3 秒后就断定所有页面都已完成更新。
- 开发环境热更新（HMR）后不要沿用热更新前的现场：弹层可能已被关闭、旧 ref 失效、组件数据被重置。先重新定位并重新打开弹层，等目标容器出现后再测量；发现面板只剩 `<!---->`、列表行数为 0 或默认选项为空时，先完整 `reload` 复核再判断是否真的是持久性渲染缺陷，复验选项/多选内容前也要确认接口数据已加载。
- 组件行元素和空态以真实 DOM 为准：虚拟滚动或二次封装的表格，行元素不一定在 `tbody tr` 下，先用 eval 统计真实行元素的类名和数量；空态常表现为行数为 0 加根节点空态类，正好用来区分"确实没有数据"和"选择器写错"，不要凭假设的选择器断言表格未渲染。
- 结构选择器（如 `button:has(.icon)`、`:nth-child`）只保证"匹配到某个节点"，不保证是目标：同名按钮或页面上有多个弹层时会命中第一个错误按钮，回执仍可能是 `ok: true, domFallback: true`。优先用 snapshot ref 或 `find role button --name <名称> --exact`，点击后用弹层是否出现/关闭、选中值、关键 DOM 变化核对结果，不要拿 `ok`/`domFallback` 当业务成功。
- Teleport/portal 弹窗的宿主节点常是 0×0、`innerText` 为空的壳（如 `lt-modal-host` 一类包装层），真实内容和 footer 按钮被挂到 body 或其他容器，且 footer 的「取消/保存」不一定在内容容器内。定位时从文档级查实际的 `role=dialog` 或可见内容根节点，查按钮不要只圈定内容容器；宿主 `innerText` 为空不代表弹窗未渲染，也不要用宿主节点截图判断空白。
- 虚拟表格分层渲染时，表格容器内的 `thead`/`input` 计数可能暂时为 0，而内容已经显示。先把目标标签置前再观察（后台标签 `visibilityState=hidden`，渲染常不完整），随后用带 `aria-label` 的全局查询或实际控件数量、几何尺寸核验，不要用容器内计数判断是否加载完成，也不要把后台标签的空结果当作交互回归。

## 后台标签与 Ant 弹层组件

- 后台/隐藏标签里 Drawer、TreeSelect 的入场动效可能停在 `enter-start`、面板留在视口外：先 `tab select <tN>` 把目标标签置前（会恢复并聚焦窗口，最小化窗口一并还原为 `normal`，`visibilityState` 与 CSS/rAF 时钟随之恢复），再点击或测量；不要改用 eval 改样式绕过动效。
- 需要在隐藏标签上做真实点击时，用 `set focus on` 打开 CDP 焦点仿真，结束后 `set focus off`；它只模拟焦点，不等于激活标签页。
- TreeSelect 打开后，用 `snapshot --target .ant-tree-select-dropdown` 查看全部选项，或 `find role treeitem --name <名称>` 直接定位节点：选项的 `.ant-select-tree-node-content-wrapper[title]` 没有显式 role，snapshot/find 已按组件语义把它识别为 treeitem。
- `click` 成功只代表事件已派发，不代表弹层开了或关了；要读回 `.ant-select-selection-item` 的文本核对选中值，再决定下一步。
- 验证到选择结果为止，不要提交业务表单；用户明确要求提交时再操作。

## HTML5 拖放与鼠标

- 自定义 HTML5 拖放用 `drop <selector> --data 'text/plain=hello'`，本地文件用重复 `--path <file>`；单文件最大 32MiB、总计 64MiB。文件 input 仍优先 `upload`。坐标鼠标用 `mousemove` 定位后配套 `mousedown`/`mouseup`，`mousewheel` 在当前位置滚动。
