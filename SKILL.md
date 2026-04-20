---
name: autobrowser
description: CLI capability reference for autobrowser browser automation commands.
---

# autobrowser Skill

## Overview

autobrowser is a browser automation CLI for controlling Chrome/Edge through a relay server and extension.

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
