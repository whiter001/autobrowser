# autobrowser

autobrowser is a Bun-based browser automation tool inspired by v-browser.

## Current status

This repository now contains the initial Bun implementation scaffold:

- local relay server on port `47978`
- CLI API server on port `47979`
- browser extension scaffold with a token-based connection flow
- basic commands for `server`, `connect`, `status`, `tab`, `goto`, `open`, `eval`, `click`, `fill`, `snapshot`, and `screenshot`

## Run

```bash
bun run src/cli.js server
```

Then open the connect page from another terminal:

```bash
bun run src/cli.js connect
```

## Extension

Build the unpacked extension first:

```bash
pnpm run build:chrome
```

Then load the `chrome/` folder as an unpacked extension in Chromium-based browsers. Run `autobrowser connect` to open the extension connect page; it will save the token and relay port automatically, then the extension will try to connect to the local relay server. The options page still works as a manual fallback and shows diagnostics.

## Tests

Run `bun test`.
