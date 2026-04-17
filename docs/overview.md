# autobrowser overview

autobrowser is a Bun-based browser automation tool that drives Chrome/Edge through a local relay server and a browser extension.

## Entry points

- `src/cli.ts` is the development source entrypoint.
- `dist/autobrowser.js` is the built CLI artifact.
- `chrome/` is the built extension output directory.

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

See [`install.md`](install.md) for the extension install flow and [`bun-link.md`](bun-link.md) for the link-script details and Windows-specific wrapper note.
