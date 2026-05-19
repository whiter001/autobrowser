# autobrowser 文档

这里存放的是 `autobrowser` 更长生命周期的使用指南。

## 保持可维护性

- 把 `src/cli.ts` 里的命令树当作命令名、标志位和语法的权威来源。
- 一段工作流只在它所属的页面里更新，不要在多个文件里重复相同示例。
- `README.md` 只保留高层概览，把详细使用问题导向这里。

## 页面

- [`overview.md`](overview.md) — 核心流程、常用命令和功能地图。
- [`install.md`](install.md) — 未打包扩展的安装、已保存连接配置以及兜底路径。
- [`windows-demo.md`](windows-demo.md) — 面向 Windows 的启动示例，使用最小化的 `autobrowser.cmd` 转发器。
- [`bun-link.md`](bun-link.md) — Bun 包装器行为和 link 脚本细节。
- [`agent-design.md`](agent-design.md) — 面向 agent 的路线图、协议缺口和下一步建议调整。