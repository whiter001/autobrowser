# Bun linking

This page explains the wrapper that places `autobrowser` next to `bun` or `bun.exe`, and when plain `bun link` is enough.

`bun link` is package-level linking. See [`overview.md`](overview.md) for the build and link workflow that places `autobrowser` next to `bun` or `bun.exe`.

The repo's current `bin` entry still points at `./src/cli.ts`, so a plain `bun link` will link the source entrypoint unless you change that field first.

The `scripts/link-bun.ts` helper writes a small wrapper named `autobrowser` on Unix-like systems, or `autobrowser.cmd` on Windows, next to the `bun` executable and points it at `dist/autobrowser.js`.

If you prefer Bun-managed linking for the built artifact, update the package `bin` field to point at `dist/autobrowser.js`, run `bun run build:cli`, and then use `bun link` at the package root. That path is package-oriented rather than a direct single-file link.
