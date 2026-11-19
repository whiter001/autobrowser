# 网络请求与 HAR

## 网络请求查询

- 未启动 HAR 时只自动监控网络元数据，不预取 body；`network request <id>` 按需通过 CDP 获取 body，历史请求或失效 CDP 会话可能无法补取，须查看获取失败信息。`--include-details` 只包含已存储的详情，不保证 body 完整。
- `network requests` 默认只看目标 tab 的当前页面 epoch；跨 tab 或跨页面历史必须显式使用 `--all-tabs` / `--all-epochs`，headers/body 用 `network request <id>` 或 `--include-details` 获取。默认按最旧记录分页（每页 50，`--page` / `--page-size` 调页；`--limit` 是 `--page-size` 的别名），调试最新流量加 `--sort newest`；`total` 是过滤后的总数，不是当前页条数。
- 列表侧过滤用 `network requests` 自己的参数：`--filter <子串>`（在 URL、方法、资源类型、状态文本等字段里做子串匹配）、`--type <xhr,fetch>`、`--method`、`--status <2xx>`、`--sort newest`，例如 `network requests --filter centralized/policy --type xhr,fetch --sort newest --limit 30`。`--include-pattern`/`--exclude-pattern` 只属于 `network har start`，传给 `network requests` 会报 `CLI_INVALID_ARGUMENT`；需要收窄结果就换 `--filter`/`--type`，不要因为参数写错就重放整条列表或改去抓 HAR。
- `emptyReason: FILTERED_OUT` 表示已有请求历史但被当前过滤条件全部排除，**不代表请求没有发生**；`EPOCH_FILTERED` 才是被页面 epoch 过滤。前者先放宽或去掉 `--filter`/`--type`/`--method`/`--status` 并核对分页范围，后者再试 `--all-epochs`；最后用 `total`、`snapshot` 和页面自身状态判断，不要把空列表当成接口失败或"页面没发请求"的依据。

## HAR 采集限额与 body

- `network har start` 可以在采集前显式设置限额：
  - `--har-max-requests <n>`
  - `--har-max-body-bytes <n>`
  - `--har-unlimited`
- HAR body 获取使用 4 个并发槽和每次 10 秒逻辑超时；底层 CDP 不可中止时仍占槽直到结束，不会因超时无限启动新请求。`stop` 只等待本次 capture 的有界任务。
- `--har-max-body-bytes` 只限制 body 存储大小，不限制 CDP 下载或传输量。
- `--har-unlimited` 不限制 autobrowser 自身保存的 body 大小，但不是绕过 CDP/传输资源上限；若浏览器 CDP 对 `Network.getResponseBody` 触发配额错误，HAR 仍会导出，并在对应 entry 的 `response.content.comment` 标明 body 获取失败原因。

## stop、过滤与恢复

- `network har stop [output.har]` 的输出路径可放在选项前后；等大结果在 relay 支持时走“WebSocket 控制消息 + 本地鉴权 HTTP 数据通道”：扩展发送响应元数据，HTTP 按字节范围上传，relay 落盘并校验 SHA-256 后重组；中断会从已确认偏移续传，15 秒无数据进度才判定传输停滞，整体仍受原命令预算约束。旧 relay 或小响应自动沿用 WebSocket 内联/分片协议，CLI/MCP 返回格式不变；传输超限明确报错，不静默截断。CLI 只会在面对较旧扩展时回退到重新组装网络请求。
- HAR start 默认包含目标 tab 的全部请求，可用 `--include-pattern <text>` 只采 URL 子串命中项，或用 `--exclude-pattern <text>` 排除页面播放器/无关流量；过滤不会删除全局请求历史。并发任务保存 start 返回的 captureId，stop 传 `--capture-id <id>` 防止误停其他 capture；stop 加 `--include-urls` 可直接返回本次捕获的去重 URL。中断或 stop 超时后先查 `network har status` 的 `checkpoint.recoverable`，再用 `network har recover [output.har]`；大采集可用 `--timeout-ms <ms>` 延长预算。stop/recover 的 `meta.har` 回显 captureId、原 capture tab 和请求数。
- 在旧扩展上，`network har stop` 可能只返回元数据；CLI 会自动兜底重建 HAR。
