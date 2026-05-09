# 项目优化 TODO

基于代码审查结果，以下是 `autobrowser` 后续的优化方向。

## 已处理

- [x] **Shadow DOM 穿透深度限制**
  - **说明**: `deep-dom.ts` 已支持可配置的最大穿透深度，避免极端 DOM 结构导致无限递归或性能抖动。
- [x] **HAR 辅助稳定性增强**
  - **说明**: `compareHarRecords` 现在会把缺失或非法 `startedAt` 的记录排到后面，`buildHarPayload` 也会对输入 entries 做防御性拷贝。
- [x] **超大 HAR 文件处理优化**
  - **说明**: `writeHarFile` 已改为流式写入 HAR JSON，避免先拼出整串大字符串再落盘。
- [x] **命令批处理 (Batching)**
  - **说明**: `batch` 现在会一次性发送到扩展端，由扩展侧顺序执行所有步骤并返回聚合结果，减少了逐步往返开销。

## 待处理

### 核心协议与性能

### 类型安全与校验

- [ ] **参数 Schema 校验**
  - **描述**: 为 `CommandSpec` 引入 Zod 等库进行参数校验。
  - **意图**: 在控制流初期（CLI 或 Server 端）拦截非法参数，避免无效请求进入浏览器扩展。
