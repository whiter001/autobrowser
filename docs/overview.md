# autobrowser overview

autobrowser is a Bun-based browser automation tool that drives Chrome/Edge through a local relay server and a browser extension.

## What this repo provides

- local relay server on port `57978`
- CLI API server on port `57979`
- browser extension scaffold with a token-based connection flow
- core commands for server and connection management, navigation, tab and window control, element interaction, dialogs, wait and state checks, cookies, storage, clipboard, browser state, network inspection and interception, snapshot, and screenshot

Run `bun run src/cli.ts help` to see the full command tree.

## Documentation map

The command tree in `src/cli.ts` is the canonical reference. The docs in this folder keep the longer usage flows organized:

- [`install.md`](install.md) covers unpacked extension install and saved connection settings.
- [`bun-link.md`](bun-link.md) covers the Bun wrapper and `bun link` behavior.

## Core workflow

```bash
bun run src/cli.ts server
bun run src/cli.ts connect
bun run src/cli.ts open https://example.com
```

- `server` starts the local relay and IPC servers.
- `connect` opens the extension connect page.
- `open` navigates the current tab to a URL.

## Agent-friendly workflow

Use `snapshot` before acting on a complex page. The snapshot now includes an `elements` array with refs like `@e1` and `@e2`, plus tag, role, text, and geometry metadata for each visible interactive element. It also includes a `frames` array with refs like `@f1` for visible iframes.

Those refs work anywhere a selector is accepted, so an agent can prefer this pattern:

```bash
bun run src/cli.ts snapshot
bun run src/cli.ts click @e2
bun run src/cli.ts get text @e3
bun run src/cli.ts fill @e5 "hello"
bun run src/cli.ts frame @f1
```

When CSS selectors are still too brittle, prefer semantic lookup:

```bash
bun run src/cli.ts find role button click --name "Continue"
bun run src/cli.ts find text "Pricing" click
bun run src/cli.ts find label "Email" fill "agent@example.com"
```

For multi-tab flows, prefer stable tab handles from `tab list`:

```bash
bun run src/cli.ts tab list
bun run src/cli.ts tab select t2
```

If the DOM changes significantly, refresh the refs with another `snapshot`.

## Build and link workflow

```bash
bun run build:cli
bun run build:chrome
bun run link:bun
```

- `build:cli` produces `dist/autobrowser.js`.
- `build:chrome` produces the unpacked extension under `chrome/` and injects the extension key.
- `link:bun` writes the `autobrowser` wrapper next to `bun` or `bun.exe`.

After that, run `autobrowser` directly from the same environment that exposes `bun` or `bun.exe`.
