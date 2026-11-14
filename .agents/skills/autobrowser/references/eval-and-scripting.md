# eval、CDP 与页面脚本边界

## eval 使用边界

- **按源码形态强制分流，不要先试内联转义**：`eval --expr '<script>'`（位置参数同理）只用于简单单行表达式。只要源码包含 CSS 选择器、JSON、正则、模板字符串或多行语句中的任意一种，就直接选 `--file` 或 `--stdin`，不要先用反斜杠或双引号拼一版内联再试。
  - 一次性脚本优先 `--stdin`：PowerShell 单引号 here-string 原样进管道，源码不经过任何 shell 转义。
  - 需要复用或留档的脚本写成 `.js` 文件，用 `--file <path>`。
  - `--base64` 只用于机器生成的传输（调用方已经持有编码后的字节），不要作为人工手写的默认写法。
- `eval` 适合执行小段页面上下文 JS，用于只读提取、状态检查或轻量验证。
- 脚本可直接包含顶层 `return` 和 `await`，无需手工包装 async IIFE，多语句脚本用 `return` 返回结果。
- CSS 属性选择器的值本身必须按 CSS 语法带引号，例如 `a[href*="/n/"]`——这正是最容易被命令行层层吞掉的一类源码。`not a valid selector` 表示脚本已解析并运行、页面拒绝了 CSS：原因既可能是引号被转义吃掉，也可能是选择器本身非法，不要把所有 selector 错误都归因成命令行引号问题。

PowerShell 一次性脚本的标准写法（`@'` 与结束的 `'@` 都必须独占行首，不能缩进）：

```powershell
# Windows PowerShell 5.1 默认用 ASCII 编码管道输入，源码含非 ASCII 字符时先切到 UTF-8
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
const links = Array.from(document.querySelectorAll('a[href*="/n/"]'), (a) => a.href)
return links.slice(0, 10)
'@ | autobrowser.exe eval --stdin
```

- 页面执行启用 `awaitPromise`，可直接使用顶层 `await` 或返回 async IIFE / Promise 结果，不需要为异步采集手工拆成同步片段；长任务仍需设置合理 `--timeout-ms`。
- `--timeout-ms <ms>` 只在确认脚本本身是长任务时使用；不要把它作为复杂流程失败后的默认处理。`concise` 默认限制 eval 结果为 32KiB，`detailed` 默认不设结果字节上限；显式 `--max-result-bytes <n>` 会覆盖两者，超限得到 `EVAL_RESULT_TOO_LARGE` 和实际字节数，不会静默截断。搬运 storage 等大状态时在页面侧先过滤 key、聚合或分页，不要默认提高上限；未设置上限且结果超过 256 KiB 时会走 upload，并与命令共享 deadline。
- 复杂交互优先拆成更小的 autobrowser 命令或脚本步骤，保留原任务目标逐步推进。
- 针对单个元素执行函数脚本时用 `eval --element <selector|@eN> 'el => el.textContent'`，保留 stale/frame 检查。`locator <selector>` 会生成并验证唯一 locator；`highlight <selector> [--style <outline>]` 做不改布局的高亮，单元素恢复用 `highlight <selector> --hide`，全部恢复用 `highlight --hide`。

## CDP 使用边界

- `cdp <Domain.method> [json]` 用于现有命令无法覆盖的 tab 级 CDP 场景，例如 `cdp Runtime.evaluate '{"expression":"6 * 7","returnByValue":true}'`；复杂参数也可使用 `--params '<json>'`。
- CDP 仅允许 tab 级方法，拒绝 `Browser/Target/SystemInfo` 和 `Debugger.disable`。它可能产生页面副作用，断连后的未知结果不能盲目重放；优先使用语义明确的普通命令，不要把 CDP 当成默认操作方式。

## DOM 定位失败时的探测

- 列表页/详情页的常见选择器落空时，先用 `eval` 从目标文本节点逐级 `parentElement` 打印 DOM 层级链（节点写成 `tagName#id.class`），再按真实层级写选择器；层级只是当前页面的结构，不是工具契约，不要固化成站点专属选择器。
- 这类探测脚本一长就按「eval 使用边界」改用 `--stdin` 或 `--file`，不要继续在命令行上调引号；`not a valid selector` 的归因同样以该节为准。
- `eval` 超时或页面内异常时保持原任务目标，不要换方案；先用 `status`、`snapshot`、`console`、`errors` 诊断页面状态和脚本问题，再围绕原任务重试。
