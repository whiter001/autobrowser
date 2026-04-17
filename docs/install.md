# Plugin install

Build the extension first:

```bash
bun run build:chrome
```

Then load `chrome/` as an unpacked extension in Chromium-based browsers.

Use `autobrowser connect` to open the extension connect page and save the relay settings automatically. If you are running the repository directly, use `bun run src/cli.ts connect` instead.

The options page is a manual fallback and shows connection diagnostics.
