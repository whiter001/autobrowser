# TODO

## 核心协议与 Agent 增强 (Agent-First Design)

- [ ] **统一目标定位协议**
  - [ ] 确保所有命令都能显式接受 --tab 和 --frame 参数，减少对隐式“当前目标”的依赖。
  - [ ] 在命令响应中稳定回显实际操作的标签页句柄 (Tab Handle) 和 Frame 引用。

- [ ] **增强语义定位能力 (Semantic Locators)**
  - [ ] 扩展 find 命令：支持候选列表、Top-N 结果排序。
  - [ ] 增加更多定位策略：placeholder, alt text, title, test-id, exact-name。
  - [ ] 支持位置/次序选择：first, last, nth。

- [ ] **引用过期模型 (Snapshot Epoch)**
  - [ ] 引入 Page Epoch 或 Snapshot ID，让 Agent 能感知 DOM 状态是否发生了质变。
  - [ ] 当使用过期的元素/Frame 引用（如 @e1）时，返回清晰的机器可读错误（Stale Reference Error）。

- [ ] **优化 Agent I/O 协议**
  - [ ] 统一各命令的 JSON 响应格式，确保输出的一致性。
  - [ ] 在响应中包含更多上下文元数据（如当前 URL、页面标题、Epoch）。
  - [ ] 建立标准化的错误码系统，并提供针对性的修复建议 (Remediation Hints)。

- [ ] **降低交互延迟**
  - [ ] 增强 batch 命令的能力，支持简单的条件分支或基于结果的跳过。

## 工程化与体验

- [ ] **JSDoc 文档补全**：为 src/core 和 extension/ 下的核心 API 添加完整注释。
- [ ] **错误处理优化**：改进连接断开时的用户提示，提供更明确的恢复引导。
- [ ] **示例代码**：增加针对常用框架（如 React, Vue）复杂组件的自动化操作示例。
