---
name: autobrowser
description: Automate browser tasks to collect and extract website content, navigate pages, fill forms, inspect state, export HAR, and manage tabs, windows, screenshots, and network activity.
---

# autobrowser Skill

## Overview

autobrowser is a browser automation CLI for collecting content and interacting with websites in Chrome/Edge.

## What it can do

- start, inspect, and stop the automation server
- open pages, move between tabs, and manage windows
- click, fill, type, scroll, drag, and upload on pages
- run JavaScript in the page context
- wait on selectors, text, URLs, load states, JavaScript conditions, and fixed delays in milliseconds
- inspect elements, screenshots, dialogs, and browser state
- manage cookies, storage, clipboard, PDFs, and viewport/session settings
- route requests, inspect network activity, and export HAR files

## Run

Windows 上用 `autobrowser.cmd`；Unix 用 `autobrowser`。

```bash
# Windows (推荐)
autobrowser.cmd server
autobrowser.cmd connect
autobrowser.cmd open https://www.example.com
```

## Reliable workflows

- `server` starts the relay and IPC servers.
- `server stop` stops the background servers cleanly.
- `connect` opens the extension connect page and stores the token plus relay port automatically.
- `connect` also persists a valid `--extension-id`, `--browser-command`, and `--browser-arg` configuration for later runs.
- If `connect` is launched with a valid token and the extension reports `connected`, the page may close itself. Treat that as a successful connection.
- `status` is the fastest way to confirm whether the extension is connected.
- `tab list` is useful after `connect` or `open` to confirm the active tab.
- `network har stop [output.har]` returns a complete HAR on current extension builds; the CLI only falls back to rebuilding from network requests when talking to an older extension.

## Common commands

- `server`
- `server stop`
- `status`
- `connect`
- `goto <url>`
- `open <url>`
- `tab list`
- `tab new <url>`
- `tab select tN`
- `eval [--stdin|--file path|--base64] <script>`
- `click <selector>`
- `fill <selector> <value>`
- `type <selector> <value>`
- `find role|text|label ...`
- `wait [selector|time <ms>|ms <ms>|--text <text>|--url <pattern>|--load [networkidle]|--fn <expression>] [--state visible|hidden] [--timeout <ms>]`
- `snapshot`
- `screenshot`
- `network route <url>`
- `network requests`
- `network har start`
- `network har stop [output.har]`
- `state save <name>`
- `state load <name|json>`

## Wait and timing semantics

- `wait time 3`, `wait ms 3`, and `wait 3` all mean **3 milliseconds**.
- To wait 3 seconds, use `wait time 3000`.
- `--timeout <ms>` is also in milliseconds.
- If a page is still loading, prefer `open <url>` followed by a short millisecond wait or `wait --load networkidle` before extracting content.

## Failure patterns and recovery

- After `connect`, use `status` instead of waiting on the page if the connect tab auto-closes.
- If `connect` does not open or connect, verify the browser binary points to the profile that has the unpacked extension loaded, or pass `--browser-command` explicitly.
- `get text` needs a selector. Use `get text body` only when the page body is expected to be small and clean.
- `snapshot` returns agent-friendly `elements` refs such as `@e1`; prefer acting on those refs instead of brittle CSS selectors when possible.
- `snapshot` also returns `frames` refs such as `@f1`; prefer `frame @f1` over raw iframe selectors when the page has nested frames.
- Selector-based commands like `click`, `fill`, `get text`, and `wait` accept snapshot refs directly.
- `find role`, `find text`, and `find label` let agents locate the right element semantically and then click, read text, fill, or focus it in one command.
- `tab list` returns stable handles like `t1`, `t2`, and `t3`; prefer `tab select tN` over depending on raw tab ids.
- `wait time 3` is not 3 seconds. Convert seconds to milliseconds explicitly.
- On older extensions, `network har stop` may return only metadata; prefer letting the CLI rebuild automatically instead of manually stitching HAR entries.
- On x.com and similar SPA feeds, `get text body` can return huge script/config blobs instead of readable posts.
- For visible feed items, prefer `eval` in the page context and read `article` nodes directly.
- A reliable x.com extraction pattern is `Array.from(document.querySelectorAll('article')).slice(0, N).map((article) => article.innerText.trim())`.
- If the page looks empty or wrong, verify whether the current view is a login screen, a captcha, or a virtualized timeline before retrying.

## Add New Failures

- When a new failure repeats, add it here as a short bullet with the trigger, the bad command or pattern, and the preferred recovery path.
- Keep the guidance action-oriented so the next run can reuse it without re-deriving the fix.
