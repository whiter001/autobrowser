# autobrowser

autobrowser is a Bun-based browser automation tool inspired by v-browser.

## Current status

This repository now contains the initial Bun implementation scaffold:

- local relay server on port `47978`
- CLI API server on port `47979`
- browser extension scaffold with a token-based connection flow
- core commands for `server`, `connect`, `status`, `tab`, `goto`, `open`, `eval`, `click`, `dblclick`, `fill`, `type`, `keyboard`, `scrollintoview`, `close`, `snapshot`, and `screenshot`

## Run

```bash
bun run src/cli.ts server
```

Then open the connect page from another terminal:

```bash
bun run src/cli.ts connect
```

## Check State

Use `is` to inspect element state:

```bash
bun run src/cli.ts is visible <sel>
bun run src/cli.ts is enabled <sel>
bun run src/cli.ts is checked <sel>
```

The command also supports `disabled` and `focused`.

## Wait

Wait for element state, text, URL, load state, JS condition, or time:

```bash
bun run src/cli.ts wait <selector>
bun run src/cli.ts wait <ms>
bun run src/cli.ts wait --text "Welcome"
bun run src/cli.ts wait --url "**/dash"
bun run src/cli.ts wait --load networkidle
bun run src/cli.ts wait --fn "window.ready === true"
bun run src/cli.ts wait "#spinner" --state hidden
```

## Extension

Build the unpacked extension first:

```bash
pnpm run build:chrome
```

Then load the `chrome/` folder as an unpacked extension in Chromium-based browsers. Run `autobrowser connect` to open the extension connect page if the CLI binary is installed globally; it will save the token and relay port automatically, then the extension will try to connect to the local relay server. If you are running the repository directly, use `bun run src/cli.ts connect` instead. The options page still works as a manual fallback and shows diagnostics.

## Network

The CLI also exposes network inspection and interception commands:

```bash
bun run src/cli.ts network route <url> [--abort] [--body <json>]
bun run src/cli.ts network unroute [url]
bun run src/cli.ts network requests [--filter api] [--type xhr,fetch] [--method POST] [--status 2xx]
bun run src/cli.ts network request <requestId>
bun run src/cli.ts network har start
bun run src/cli.ts network har stop [output.har]
```

## Tests

Run `bun test`.
