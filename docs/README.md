# autobrowser docs

This folder holds the longer-lived usage guidance for autobrowser.

## Keep it maintainable

- Treat the command tree in `src/cli.ts` as the source of truth for command names, flags, and syntax.
- Update the page that owns a workflow instead of repeating the same example across multiple files.
- Keep `README.md` high-level and point detailed usage questions here.

## Pages

- [`overview.md`](overview.md) — the core workflow, common commands, and the feature map.
- [`install.md`](install.md) — unpacked extension install, saved connection settings, and the fallback path.
- [`bun-link.md`](bun-link.md) — Bun wrapper behavior and link-script details.
- [`agent-design.md`](agent-design.md) — the agent-first roadmap, contract gaps, and recommended next adjustments.
