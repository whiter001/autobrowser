# Windows demo with `autobrowser.cmd`

This page documents the repo-local `autobrowser.cmd` launcher.

It is intentionally minimal: it just forwards arguments to the local `dist/autobrowser.js` build artifact through the fixed Bun path used in the demo.

If you are running the repository directly, use `bun run build:cli` first so the launcher has a build artifact to point at.

## What this demo covers

- forward Windows arguments to the built CLI
- keep the demo launcher as small as possible
- show the exact Windows batch shape that the launcher uses

## Prerequisites

```powershell
bun run build:cli
```

After building, the root-level `autobrowser.cmd` can run the local CLI artifact.

## Demo flow

Run the launcher with an explicit command, for example help:

```powershell
autobrowser.cmd help
```

Pass any CLI command through the launcher as needed:

```powershell
autobrowser.cmd status
autobrowser.cmd connect
autobrowser.cmd tab list
```

You can also forward a full workflow:

```powershell
autobrowser.cmd server
autobrowser.cmd open https://example.com
autobrowser.cmd snapshot
```

If you want to mirror the installed Windows wrapper more closely, use `autobrowser.cmd` from PATH after linking; this demo file is intentionally separate so it can stay repo-local.

## Notes

- `autobrowser.cmd` is a convenience launcher, not the installed package wrapper.
- The installed wrapper in the system PATH still comes from `bun link` or the direct Windows link step.
