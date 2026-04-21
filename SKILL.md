---
name: autobrowser
description: Automate browser tasks to collect and extract website content, navigate pages, fill forms, inspect state, and manage tabs, windows, screenshots, and network activity.
---

# autobrowser Skill

## Overview

autobrowser is a browser automation CLI for collecting content and interacting with websites in Chrome/Edge.

## What it can do

- start and inspect the automation server
- open pages, move between tabs, and manage windows
- click, fill, type, scroll, drag, and upload on pages
- run JavaScript in the page context
- wait on selectors, text, URLs, loads, and time
- inspect elements, screenshots, dialogs, and browser state
- manage cookies, storage, clipboard, PDFs, and viewport/session settings
- route requests and inspect network activity

## Run

Windows 上用 `autobrowser.cmd`；Unix 用 `autobrowser`。

```bash
# Windows (推荐)
autobrowser.cmd server
autobrowser.cmd connect
autobrowser.cmd open https://www.example.com
```

## Common commands

- `server`
- `status`
- `connect`
- `goto <url>`
- `open <url>`
- `tab list`
- `tab new <url>`
- `eval [--stdin|--file path|--base64] <script>`
- `click <selector>`
- `fill <selector> <value>`
- `type <selector> <value>`
- `wait <selector|url|text|time|load|networkidle> [value] [timeout]`
- `snapshot`
- `screenshot`
- `network route <url>`
- `network requests`
- `state save <name>`
- `state load <name|json>`

## Failure patterns and recovery

- `get text` needs a selector. Use `get text body` only when the page body is expected to be small and clean.
- On x.com and similar SPA feeds, `get text body` can return huge script/config blobs instead of readable posts.
- For visible feed items, prefer `eval` in the page context and read `article` nodes directly.
- A reliable x.com extraction pattern is `Array.from(document.querySelectorAll('article')).slice(0, N).map((article) => article.innerText.trim())`.
- When a page is still loading, run `open <url>` first and then a short `wait <ms>` before extracting.
- If the page looks empty or wrong, verify whether the current view is a login screen, a captcha, or a virtualized timeline before retrying.

## Add New Failures

- When a new failure repeats, add it here as a short bullet with the trigger, the bad command or pattern, and the preferred recovery path.
- Keep the guidance action-oriented so the next run can reuse it without re-deriving the fix.
