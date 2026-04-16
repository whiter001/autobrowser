---
name: autobrowser
description: Current CLI and build reference for dist/autobrowser.js, chrome/ extension output, and browser automation commands.
---

# autobrowser Skill

## Overview

autobrowser is a Bun-based browser automation tool that drives Chrome/Edge through a local relay server and a browser extension. The current canonical runtime entrypoint is the compiled CLI at `dist/autobrowser.js`, built from `src/cli.ts`.

## Current Entry Points

- `dist/autobrowser.js` is the runtime entrypoint for day-to-day use.
- `src/cli.ts` is the development source entrypoint.
- `chrome/` is the built extension output directory.

## Build Workflow

```bash
bun run build:cli
bun run build:chrome
```

- `build:cli` produces `dist/autobrowser.js`.
- `build:chrome` produces the unpacked extension under `chrome/` and injects the extension key.

## Local Binary Link

`bun link` is package-level linking. If you want the compiled CLI to sit next to the `bun` executable as a convenience command, use the bundled link script instead:

```bash
bun run build:cli
bun run link:bun
```

After that you can run `autobrowser server` or `autobrowser connect` from the same directory that exposes `bun`.

The script writes a small wrapper named `autobrowser` next to the `bun` executable and points it at `dist/autobrowser.js`.

If you prefer Bun-managed linking, make sure the package `bin` field points at `dist/autobrowser.js` and then use `bun link` at the package root. That path is package-oriented rather than a direct single-file link.

## Runtime Model

- Default relay WebSocket port: `47978`
- Default IPC HTTP port: `47979`
- Runtime state and token storage: `~/.autobrowser`
- `server` starts both the relay server and the IPC server.
- `connect` opens the extension connect page and falls back to the relay page if the extension URL is unavailable.

## Recommended Usage

Start the server:

```bash
bun dist/autobrowser.js server
```

Open the connect page:

```bash
bun dist/autobrowser.js connect
```

Check status:

```bash
bun dist/autobrowser.js status
```

## CLI Flags

- `--json` outputs JSON.
- `--server <url>` overrides the IPC server base URL.
- `--ipc-port <port>` overrides the IPC port and updates the default server URL unless `--server` is explicitly set.
- `--relay-port <port>` overrides the relay port used by `connect` and `server`.
- `--stdin` reads command content from stdin.
- `--file <path>` reads command content from a file.
- `--base64` decodes command content from base64.

## Command Surface

### Navigation and tabs

- `server`
- `status`
- `connect`
- `tab list`
- `tab new <url>`
- `open <url>`
- `goto <url>`
- `back`
- `forward`
- `reload`
- `window new`

### Page interaction

- `eval [--stdin|--file path|--base64] <script>`
- `click <selector>`
- `dblclick <selector>`
- `fill <selector> <value>`
- `type <selector> <value>`
- `keyboard type <text>`
- `keyboard inserttext <text>`
- `keyboard keydown <key>`
- `keyboard keyup <key>`
- `hover <selector>`
- `focus <selector>`
- `select <selector> <value>`
- `check <selector>`
- `uncheck <selector>`
- `scroll [selector] [deltaX] [deltaY]`
- `scrollintoview <selector>`
- `drag <startSelector> [endSelector]`
- `upload <selector> <files...>`
- `press <key>`

### Session control

- `close [all]`

### Inspection and waits

- `snapshot`
- `screenshot`
- `frame <selector|top>`
- `is <visible|enabled|checked|disabled> <selector>`
- `get <text|html|value|title|url|count|attr|box> [selector]`
- `wait <selector|url|text|time|load|networkidle> [value] [timeout]`
- `dialog accept|dismiss [promptText]`

### Browser state and tools

- `cookies get|set|clear`
- `storage get|set|clear [key] [value]`
- `console`
- `errors`
- `set viewport|offline|headers|geo|media`
- `pdf`
- `clipboard read|write [text]`
- `state save [name]`
- `state load [name|json]`

## Examples

```bash
bun dist/autobrowser.js goto https://example.com
bun dist/autobrowser.js eval "document.title"
echo "document.location.href" | bun dist/autobrowser.js eval --stdin
bun dist/autobrowser.js click "#submit"
bun dist/autobrowser.js fill "#username" "admin"
bun dist/autobrowser.js type "#search" "hello world"
bun dist/autobrowser.js keyboard type "hello"
bun dist/autobrowser.js state load '{"viewport":{"width":1280,"height":720}}'
```

## Notes

- Prefer the compiled CLI in `dist/autobrowser.js` when describing user workflows.
- Use `chrome/` as the unpacked extension directory when loading the plugin into Chromium-based browsers.
- If you need the development source instead of the built artifact, use `src/cli.ts` and the matching Bun scripts.
