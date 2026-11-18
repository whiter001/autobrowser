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
- 每页完成后会原子更新 JSONL 和 checkpoint。失败根据提示运行 `collect resume <checkpoint.json>`，从失败页继续并按内容去重；完成态 resume 是 no-op。结果可能含敏感页面数据，妥善保管输出文件，checkpoint 不保存 cookie/token。

## SPA 列表与文本采集

- 对于类似 x.com 的 SPA 列表页，优先从 `article` 等可见节点读取内容，不要直接相信 `get text body`。

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
- `click` 是一次真实点击；对按钮、输入框等 toggle 控件，先用 snapshot/eval 检查面板或弹层当前状态，不要在 eval 里调用 `el.click()` 后又无条件执行一次 `click`，否则第二次可能把刚打开的面板关闭。
- Vue/React 等框架的状态更新和渲染是异步的，`.click()` 后同步读取 DOM 可能仍是旧值。优先用 `wait <selector>`、`wait --fn '<expression>'` 或 `wait --text <text>` 等条件等待；不要固定 sleep 2~3 秒后就断定所有页面都已完成更新。
- 开发环境热更新（HMR）后不要沿用热更新前的现场：弹层可能已被关闭、旧 ref 失效、组件数据被重置。先重新定位并重新打开弹层，等目标容器出现后再测量；发现面板只剩 `<!---->`、列表行数为 0 或默认选项为空时，先完整 `reload` 复核再判断是否真的是持久性渲染缺陷，复验选项/多选内容前也要确认接口数据已加载。
- 组件行元素和空态以真实 DOM 为准：虚拟滚动或二次封装的表格，行元素不一定在 `tbody tr` 下，先用 eval 统计真实行元素的类名和数量；空态常表现为行数为 0 加根节点空态类，正好用来区分"确实没有数据"和"选择器写错"，不要凭假设的选择器断言表格未渲染。

## HTML5 拖放与鼠标

- 自定义 HTML5 拖放用 `drop <selector> --data 'text/plain=hello'`，本地文件用重复 `--path <file>`；单文件最大 32MiB、总计 64MiB。文件 input 仍优先 `upload`。坐标鼠标用 `mousemove` 定位后配套 `mousedown`/`mouseup`，`mousewheel` 在当前位置滚动。
