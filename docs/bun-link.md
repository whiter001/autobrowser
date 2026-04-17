# Bun linking

`bun link` is package-level linking. See [`overview.md`](overview.md) for the build and link workflow that places `autobrowser` next to `bun` or `bun.exe`.

The script writes a small wrapper named `autobrowser` on Unix-like systems, or `autobrowser.cmd` on Windows, next to the `bun` executable and points it at `dist/autobrowser.js`.

If you prefer Bun-managed linking, make sure the package `bin` field points at `dist/autobrowser.js` and then use `bun link` at the package root. That path is package-oriented rather than a direct single-file link.
