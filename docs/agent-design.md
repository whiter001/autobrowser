# 面向 Agent 的设计

状态：草稿

日期：2026-04-25

## 为什么会有这份文档

`autobrowser` 已经不再只是一个本地浏览器中继加扩展桥接器了。它现在已经暴露出一些对 agent 友好的基础原语：

- 来自 `snapshot` 的稳定元素引用，例如 `@e1`
- 来自 `snapshot` 的稳定 frame 引用，例如 `@f1`
- 稳定的标签页句柄，例如 `t1`
- 通过 `find role`、`find text` 和 `find label` 进行语义化查找

这已经是个不错的基础，但它仍然只是一个相对薄的命令面，而不是完整的 agent 运行时协议。本文描述的是：如何在不丢掉当前轻量、本地优先模型的前提下，继续把项目往 agent-first 的方向推进。

## 当前基线

当前代码库已经支持以下面向 agent 的行为：

- `snapshot` 会输出交互式元素引用和可见 frame 引用。
- 基于选择器的命令可以直接接受元素引用。
- `frame` 可以直接接受 frame 引用。
- `tab list` 会暴露稳定句柄，而 `tab select` / `tab close` 可以直接操作它们。
- `find role`、`find text` 和 `find label` 可以定位目标，并在需要时直接执行动作。

当前命令面也已经补上了几项当初写草稿时还没有的实用能力：

- 根级 `--tab` 和 `--frame` 标志，可用于兼容的命令
- `batch`，用于 JSON 编码的多步序列，支持重试、continue-on-error、条件分支（`when`）与失败跳过（`skipRemainingOnFailure`）
- `status`、`config` 和 `replay`，用于运行时诊断与命令恢复
- `snapshot export` / `snapshot extract` 以及 `network export`，用于更适合下游处理的 JSONL 输出
- 对齐 Playwright 的一批页面能力：`screenshot --element`、`snapshot --target`、`wait --gone`、`type --submit`、`network route` 的 mock 参数扩展与 `route list`、`console --level`、`cookies delete` 与 `cookies get` 过滤、`storage --session`、`set permission/ua/timezone/locale`
- `script add/list/remove`，用于管理每次导航后、页面自身脚本执行前注入的初始化脚本
- 模态状态显式建模：JS 对话框（confirm/prompt）按 tab 跟踪，`snapshot` 会返回 modal 描述，交互类命令返回 `MODAL_OPEN` 错误码与 `suggestedAction`；alert/beforeunload 仍自动接受，但记录在 `lastDialog` 中供 agent 感知
- 语义定位增强：`find` 扩展为 `role`/`text`/`label`/`placeholder`/`alt`/`title`/`test-id`/`exact-name` 八种策略，支持 `--position first|last|nth=N` 位置选择与 `--candidates <n>` Top-N 候选列表（精确匹配优先、可交互元素优先排序）
- `search` 全文检索：对页面可见文本按行匹配并返回上下文窗口（支持 `/pattern/flags` 正则与 `--context`/`--limit`），只读、不定位元素，与 `find` 的定位语义互补

当前架构仍然是扩展优先：

- CLI 解析命令并转发到本地 IPC 服务。
- 本地运行时再通过中继 socket 把命令转发给浏览器扩展。
- 扩展负责当前标签页选择、frame 选择、DOM 查找、网络拦截和 snapshot 生成。

这已经能用，但面向 agent 的若干协议仍然不完整。

## 设计目标

- 让工具对编码 agent 来说尽可能确定、低摩擦。
- 优先使用稳定句柄，而不是脆弱的 CSS 选择器。
- 让命令响应保持紧凑、结构化且一致。
- 减少 agent 完成常见流程所需的轮次。
- 显式检测过期状态，而不是悄悄做错。
- 保持当前本地优先的部署模型。

## 非目标

- 这份设计不假设 `autobrowser` 内置自然语言规划器或聊天 agent。
- 这份设计也不要求立刻脱离当前基于扩展的执行模型。
- 在核心协议稳定之前，它不会试图把所有 agent-browser 功能一口气补齐。

## 主要缺口

### 1. 目标定位还不够统一

稳定标签页句柄已经存在，根级 `--tab` / `--frame` 标志也已经覆盖了命令面的一个有用子集，但大多数命令仍然只是作用于隐式的当前目标，而不是一套统一的显式目标协议。

当前影响：

- agent 可以用 `tab select t2` 选择标签页，但很多命令还不能直接说“对 t2 执行这个操作”
- frame 选择大多仍然是可变的环境状态
- 响应也没有稳定地回显它们实际使用的标签页句柄和 frame 引用

### 2. 定位语义仍然只是“第一个匹配”

`find` 很有用，但它仍然更像一个单匹配快捷方式，而不是完整的语义选择层。

当前影响：

- 没有候选排序或 top-N 结果
- 没有 `first`、`last`、`nth` 或基于 score 的选择
- 除了当前已有子集之外，还没有针对 placeholder、alt text、title、test id 或精确 accessible name 的策略

### 3. 引用没有显式的过期模型

元素引用和 frame 引用都来自当前 DOM，但运行时没有暴露 page epoch 或 snapshot epoch，因此 agent 无法明确判断引用是否过期。

当前影响：

- agent 只能猜什么时候该刷新 `snapshot`
- 命令可能晚一点才失败，而不是返回结构化的 stale-ref 错误
- 在导航或大规模重渲染之后，没有机器可读的失效协议

### 4. agent I/O 仍然过于零散

当前的响应 payload 对人类来说还可以，但还不是一套干净的 agent 协议。

当前影响：

- 不同命令对相似结果返回的结构并不一致
- 成功 payload 不一定会包含 target handle、frame ref 或页面元数据
- 错误 payload 没有围绕明确的错误码和处理建议做统一

### 5. 太多 agent 流程仍然需要多轮交互

当前命令模型还是“一次只做一个命令”。

当前影响：

- `snapshot -> 选择引用 -> click -> wait -> read text` 需要很多次往返
- agent 还不能原子化地提交一个小而确定的命令批次
- 还没有可复用的宏或脚本层，并带有结构化结果

### 6. 可观测性弱于命令面

这个仓库虽然已经对路由和 helper 行为有比较强的单元测试，但仍然缺少面向 agent 的验证闭环。

当前影响：

- 核心 agent 工作流还没有真实浏览器 smoke 测试
- 语义匹配质量还没有 eval 语料
- 对 stale refs、多标签页流程或嵌套 frame 的回归测试还不够

## 建议调整

## A. 定义统一的目标协议

每个面向 agent 的命令都应该接受同样的目标维度：

- `tab`：可选的稳定标签页句柄，例如 `t2`
- `frame`：可选的稳定 frame 引用，例如 `@f1`
- `snapshotId`：在基于引用执行操作时可选的 snapshot 或 page epoch 标识

推荐的 CLI 形式：

```bash
autobrowser click @e3 --tab t2 --frame @f1
autobrowser get text @e9 --tab t3
autobrowser find role button click --name "Submit" --tab t2
```

推荐的运行时规则：

- 显式目标优先于环境状态
- 环境状态仍然允许用于交互式人工使用
- 每个响应在相关时都应回显 `tabHandle`、`frameRef` 和 `pageEpoch`

## B. 把 `find` 扩展成真正的语义定位层

`find` 应该成为主力语义定位接口，而不是一个薄薄的快捷方式。

建议补充：

- 策略：`placeholder`、`alt`、`title`、`testid`
- 选择器：`first`、`last`、`nth`、`all`
- 结果模式：`locate`、`list`、`count`
- 元数据：accessible name、role、文本片段、score、匹配原因

推荐的响应形状：

```json
{
  "found": true,
  "strategy": "role",
  "query": "button",
  "matches": [
    {
      "ref": "@e4",
      "role": "button",
      "name": "Submit",
      "score": 0.98,
      "reason": "role+name exact match"
    }
  ],
  "selected": "@e4"
}
```

这样在存在歧义时，agent 可以先查看候选项，再决定是否执行操作。

## C. 引入页面 epoch 和过期引用检测

运行时应该显式给页面状态编号。

建议字段：

- `pageEpoch`：在导航、刷新或会使引用失效的 DOM 重置事件之后递增
- `snapshotId`：每次 `snapshot` 返回的唯一 id
- `refEpoch`：附加到 snapshot 输出里的引用上的可选 epoch

建议行为：

- 当命令接收到 `@e4` 时，可以验证当前 page epoch 是否仍然匹配
- 过期引用应返回结构化错误，例如 `STALE_ELEMENT_REF`
- 错误中要告诉 agent 重新运行 `snapshot`

## D. 统一命令响应包络

面向 agent 的命令应收敛到少量响应形状。

建议的成功包络：

```json
{
  "ok": true,
  "target": {
    "tabHandle": "t2",
    "frameRef": "@f1",
    "pageEpoch": 17
  },
  "result": { ... }
}
```

建议的错误包络：

```json
{
  "ok": false,
  "error": {
    "code": "STALE_ELEMENT_REF",
    "message": "element ref @e4 is stale for page epoch 16",
    "suggestedAction": "run snapshot again"
  }
}
```

对 agent 来说，这比继续增加很多但 payload 各不相同的命令更有价值。

## E. 为确定性的多步工作增加 batch 执行

接下来最值得做的运行时能力，是一个小型 batch 层。

建议范围：

- 按顺序执行一组已有命令
- 可选地在第一次失败时停止
- 返回每一步的结果以及最终目标上下文
- 通过 `when` 引用前序步骤的结果做条件分支（`equals` / `truthy` / `exists` 谓词，支持点路径与数组下标）
- 通过 `skipRemainingOnFailure` 在失败时终止剩余步骤（配合 `continueOnError` 使用）

示例：

```bash
autobrowser batch \
  'snapshot' \
  'find role button click --name Continue' \
  'wait --text Welcome'
```

这样可以在保持 `autobrowser` 简洁的同时，大幅减少 agent 的往返次数。

## F. 围绕 agent 原语改进等待能力

等待命令也应该使用和其他命令一致的句柄语言。

建议补充：

- `wait @e7 --state hidden`
- `wait --tab t2 --url "**/dashboard"`
- `wait --frame @f1 --text "Loaded"`
- `wait --event navigation`

重点不是再加更多语法，而是让等待命令能一致地理解标签页句柄、frame 引用和 page epoch。

## G. 加强围绕 agent 工作流的测试

这个项目现在需要的是行为测试，而不仅仅是路由测试。

建议新增：

- `snapshot`、`find`、`tab select` 和 `frame @fN` 的真实浏览器 smoke 测试
- 面向 role、text 和 label 匹配质量的语义定位 fixture
- 导航或 DOM 替换后的 stale-ref 测试
- 多标签页和嵌套 frame 的回归用例
- 一个轻量的 eval 语料库，用于测试歧义匹配和动态 UI

## H. 发布一份显式的 agent 协议页

agent 用户需要的是一份统一的协议页面，而不是散落在 README 各处的零碎示例。

建议内容：

- 稳定句柄模型：`tN`、`@eN`、`@fN`
- 引用何时有效、何时过期
- `find` 的排序方式
- 响应包络约定
- 最佳实践工作流示例

这份文档可以逐步演进成那样的页面，但最终的协议页应该比这份设计说明更短、更规范。

## 推荐推进节奏

### 第 1 阶段：协议加固

- 在所有相关命令上增加显式的标签页句柄和 frame 引用覆盖
- 统一响应包络和错误码
- 增加 page epoch 和 stale-ref 检测

### 第 2 阶段：语义选择深度

- 扩展 `find`，让它支持候选列表、排序和更多策略
- 增加 `first`、`last`、`nth` 和 `all`
- 增强歧义报告

### 第 3 阶段：agent 吞吐量

- 扩展 `batch` 覆盖范围；如果 `batch` 还不够，再考虑复用宏或脚本
- 增加理解同一套句柄模型的定向等待

### 第 4 阶段：验证与产品化

- 增加 smoke 测试和 eval
- 发布 agent 协议页
- 决定是否继续保持扩展优先，还是以后再准备一个本地 sidecar 路径

## 推荐的下一个里程碑

如果接下来只支持一个里程碑，那应该是：

- 统一所有命令上的 `--tab` 和 `--frame` 目标能力
- 加上 page epoch 和 stale-ref 检测
- 把 `find` 从“第一个匹配”扩展为“可感知候选项”的匹配

这一组合对正确性的提升，比分散地增加很多新命令更大。

## 待决问题

- 下一步是否要让 tab label 由用户自定义，还是稳定生成的句柄就足够了？
- `snapshot` 是否应该同时提供 compact 和 verbose 两种模式？（`--role <a,b,c>` 过滤已提供一种 compact 形态；`--changed` 提供基于元素签名的增量快照）
- 这个项目是否应该继续完全保持扩展优先，还是为以后可能受扩展限制的网站准备本地 CDP 执行路径？
- `batch` 应该采用按行的 CLI 语法、JSON 输入，还是两者都支持？

## 总结

`autobrowser` 已经具备了正确的第一批 agent 原语。下一步不是大规模扩张命令数量，而是把引用、句柄、语义查找和状态失效机制，整理成一套 agent 可以信任的一致运行时协议。