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
