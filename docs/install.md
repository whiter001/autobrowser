# Plugin install

Build the extension first:

```bash
bun run build:chrome
```

Then load `chrome/` as an unpacked extension in Chromium-based browsers.

Use `autobrowser connect` to open the extension connect page and save the relay settings automatically. The CLI now persists both the extension id and the browser launcher into `~/.autobrowser/config.json`, so after the first successful run it can reconnect without re-specifying them.

Example config:

```json
{
  "extensionId": "bfccnpkjkbhceghimfjgnkigilidldep",
  "browserCommand": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "browserArgs": ["--profile-directory=Profile 1"]
}
```

If you need to set it from the CLI, pass `--extension-id`, `--browser-command`, and optional `--browser-arg` values to `autobrowser connect` or `autobrowser server`; the values will be written back to the config file and reused next time. If you are running the repository directly, use `bun run src/cli.ts connect` instead.

The options page is a manual fallback and shows connection diagnostics.
