# autobrowser Skills

## Overview

autobrowser is a browser automation tool that controls Chrome/Edge via a browser extension, exposing a CLI API for scripting and automation.

**Technology Stack:**
- Language: TypeScript (.ts files)
- Runtime: Bun >=1.3.12
- Code Quality: oxlint (linting), oxfmt (formatting)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        autobrowser                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐      ┌──────────────┐      ┌───────────┐  │
│  │    CLI      │      │   IPC Server │      │ Relay WS  │  │
│  │ (cli.ts)    │──────│  port 47979  │      │ port 47978│  │
│  └──────────────┘      └──────┬───────┘      └─────┬─────┘  │
│                               │                    │        │
│                               │                    │        │
│                        ┌──────▼────────────────▼──┐        │
│                        │     Browser Extension     │        │
│                        │   (background.ts)          │        │
│                        └────────────┬──────────────┘        │
│                                     │                       │
│                               ┌─────▼─────┐                 │
│                               │   Chrome  │                 │
│                               │  Browser  │                 │
│                               └───────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Token Authentication

- Server generates a random 32-char hex token on first start
- Token is stored in `~/.autobrowser/token` and `~/.autobrowser/state.json`
- Extension needs this token to connect via WebSocket to relay server
- Token is fixed once generated; delete `~/.autobrowser` to reset

### Two Servers

| Server | Port | Purpose |
|--------|------|---------|
| Relay WS | 47978 | Extension connects via WebSocket with token |
| IPC HTTP | 47979 | CLI sends commands via HTTP POST |

### Extension Connection Flow

1. Extension loads token from `chrome.storage.local`
2. Opens WebSocket: `ws://127.0.0.1:47978/ws?token=xxx&extensionId=xxx`
3. Server validates token, upgrades connection
4. Extension registers message handler for CLI commands
5. Extension dispatches commands to Chrome DevTools Protocol (CDP)

## Nushell Usage (Recommended)

### Recommended: job spawn

```nushell
# Start server in background
job spawn { bun src/cli.ts server }

# Wait for server to be ready
sleep 3sec

# Execute commands
bun src/cli.ts goto https://www.baidu.com
bun src/cli.ts get title
```

### Complete Workflow

```nushell
# One-liner execution
nu -c "job spawn { bun src/cli.ts server }; sleep 3sec; bun src/cli.ts goto https://x.com; bun src/cli.ts wait time 8000; bun src/cli.ts get title"

# Multi-step workflow
nu -c "
  job spawn { bun src/cli.ts server }
  sleep 3sec
  bun src/cli.ts goto https://www.baidu.com
  bun src/cli.ts get title
  bun src/cli.ts goto https://x.com
  bun src/cli.ts wait time 5000
  bun src/cli.ts eval \"[...document.querySelectorAll('article')].slice(0,3).map(t => t.innerText.slice(0,200)).join('===')\"
"
```

### Job Management

```nushell
# List background jobs
job list

# Wait for specific job
job wait <job_id>

# Kill a job
job kill <job_id>

# Foreground (suspend)
fg <job_id>
```

### Alternative Methods

**Ampersand & (simple)**
```nushell
bun src/cli.ts server &
```

**do --bg (Nu 0.60+)**
```nushell
do -b bun src/cli.ts server
```

**External command prefix ^**
```nushell
^bun src/cli.ts server &
```

## CLI Commands

### Server Management

```bash
# Start server (blocks)
bun src/cli.ts server

# Check server status
bun src/cli.ts status

# Open connect page in browser
bun src/cli.ts connect
```

### Tab Operations

```bash
# Navigate to URL
bun src/cli.ts goto https://example.com
bun src/cli.ts open https://example.com

# Tab management
bun src/cli.ts tab list
bun src/cli.ts tab new <url>

# Navigation
bun src/cli.ts back
bun src/cli.ts forward
bun src/cli.ts reload
```

### Element Interaction

```bash
# Click element
bun src/cli.ts click "#submit-button"

# Fill input
bun src/cli.ts fill "#username" "admin"

# Hover/Focus
bun src/cli.ts hover "#menu"
bun src/cli.ts focus "#search"

# Select dropdown
bun src/cli.ts select "#country" "US"

# Check/Uncheck
bun src/cli.ts check "#agree"
bun src/cli.ts uncheck "#agree"

# Press key
bun src/cli.ts press "Enter"
bun src/cli.ts press "Control+KeyA"
```

### Element State & Retrieval

```bash
# Check element state
bun src/cli.ts is visible "#dialog"
bun src/cli.ts is enabled "#submit"
bun src/cli.ts is checked "#checkbox"
bun src/cli.ts is disabled "#button"

# Get element attributes
bun src/cli.ts get text "#title"        # textContent
bun src/cli.ts get html "#content"       # innerHTML
bun src/cli.ts get value "#input"        # value
bun src/cli.ts get title                 # document.title
bun src/cli.ts get url                   # window.location.href
bun src/cli.ts get count "div.card"      # querySelectorAll count
bun src/cli.ts get box "#image"          # bounding box
```

### Scrolling & Dragging

```bash
# Scroll page or element
bun src/cli.ts scroll                    # scroll by 0,100
bun src/cli.ts scroll "div.content" 50 100

# Drag element
bun src/cli.ts drag "#handle" "#target"
```

### Waiting

```bash
# Wait for selector
bun src/cli.ts wait selector "#loading" 30000

# Wait for URL pattern
bun src/cli.ts wait url "https://example.com" 30000

# Wait for text
bun src/cli.ts wait text "Success" 30000

# Wait for page load
bun src/cli.ts wait load 30000

# Wait for network idle
bun src/cli.ts wait networkidle 30000

# Wait for fixed time
bun src/cli.ts wait time 5000
```

### Execute Script

```bash
# Eval JS (inline)
bun src/cli.ts eval "document.title"

# Eval from file
bun src/cli.ts eval --file script.js

# Eval from stdin
echo "Math.random()" | bun src/cli.ts eval --stdin

# Eval from base64
bun src/cli.ts eval --base64 "Y29uc29sZS5sb2coJ2hlbGxvJyk="
```

### Cookies & Storage

```bash
# Cookies
bun src/cli.ts cookies get
bun src/cli.ts cookies set "name" "value" ".example.com"
bun src/cli.ts cookies clear

# LocalStorage
bun src/cli.ts storage get "token"
bun src/cli.ts storage set "token" "abc123"
bun src/cli.ts storage clear
```

### Browser Settings

```bash
# Viewport
bun src/cli.ts set viewport 1920 1080 1 false

# Offline mode
bun src/cli.ts set offline true

# Headers
bun src/cli.ts set headers "[{\"name\":\"X-Custom\",\"value\":\"test\"}]"

# Geolocation
bun src/cli.ts set geo 39.9042 116.4074 100

# Media (color scheme)
bun src/cli.ts set media "dark"
bun src/cli.ts set media "light"
```

### Dialog Handling

```bash
# Accept dialog with optional prompt text
bun src/cli.ts dialog accept "optional prompt"

# Dismiss dialog
bun src/cli.ts dialog dismiss
```

### Clipboard

```bash
# Read clipboard
bun src/cli.ts clipboard read

# Write clipboard
bun src/cli.ts clipboard write "text to copy"
```

### State Management

```bash
# Save browser state (cookies + localStorage)
bun src/cli.ts state save "session1"

# Load state
bun src/cli.ts state load '{"cookies":[...],"storage":{...}}'
```

### Other Commands

```bash
# Screenshot
bun src/cli.ts screenshot

# PDF generation
bun src/cli.ts pdf

# Snapshot (full state)
bun src/cli.ts snapshot

# Current console messages
bun src/cli.ts console

# Page errors
bun src/cli.ts errors

# File upload
bun src/cli.ts upload "input[type=file]" "file1.txt" "file2.txt"
```

### Flags

```bash
--json                    # Output JSON
--server URL              # Target server (default: http://127.0.0.1:47979)
--stdin                   # Read script from stdin
--file PATH               # Read script from file
--base64                  # Decode script from base64
```

## PowerShell Alternative

PowerShell also works but is slower (~4.6s vs ~3.7s for nushell):

```powershell
powershell -Command "& {Start-Process -FilePath 'bun' -ArgumentList 'src/cli.ts','server' -NoNewWindow -PassThru; Start-Sleep -Seconds 3; bun src/cli.ts status}"
```

## Project Commands

```bash
# Development
npm run dev                 # Start server with bun
bun src/cli.ts server        # Direct start

# Code quality
npm run fmt                 # Format code (oxfmt)
npm run lint                # Lint code (oxlint)
npm run fix                 # Format + fix lint
npm run check               # Lint + build validation

# Build
npm run build               # Compile standalone .exe
npm run build:js            # Build JS bundle

# Testing
npm run test                # Run test suite
```

### Build Outputs

| Command | Output | Description |
|---------|--------|-------------|
| `npm run build` | `dist/autobrowser.exe` | Standalone executable (~111MB) |
| `npm run build:js` | `dist/autobrowser.js` | Bundled JS (~35KB) |

## Extension Configuration

### Setup Steps

1. Load `extension/` as unpacked extension in Chrome/Edge
2. Open extension options page
3. Paste token from relay page
4. Click Save
5. Extension auto-connects to relay server

### Options Page Fields

- **Token**: The 32-char hex token from server's connect page
- **Relay Port**: Relay server port (default: 47978)

## Token Regeneration

Token is auto-generated on first server start and persisted. To regenerate:

```bash
# Stop server
# Delete ~/.autobrowser directory
rm -rf ~/.autobrowser

# Restart server - new token generated
bun src/cli.ts server
```

## Duplicate Server Prevention

Starting server when one is already running will fail with:
```
Server already running on port 47978
```

The `isPortInUse()` check validates before attempting to bind the port.

## Troubleshooting

### Extension won't connect

1. Verify token matches between extension and server
2. Check relay port in extension options matches server
3. Ensure no firewall blocking localhost connections

### Commands fail with "ConnectionRefused"

Server not running. Start it first with nushell:
```nushell
job spawn { bun src/cli.ts server }
sleep 3sec
```

### "unauthorized" error

Token mismatch. Verify extension has correct token, or reset by deleting `~/.autobrowser`.

### Build fails

Ensure bun version >= 1.3.12:
```bash
bun --version  # should be >= 1.3.12
```

## File Structure

```
autobrowser/
├── src/
│   ├── cli.ts            # CLI entry point
│   ├── server.ts         # HTTP/WS server setup
│   └── core/
│       ├── protocol.ts  # Constants & utilities
│       └── runtime.ts    # Runtime state management
├── extension/
│   ├── background.ts     # Chrome extension background
│   ├── options.ts       # Extension options page
│   ├── options.html     # Options page UI
│   └── manifest.json    # Extension manifest
├── test/
│   └── command-line.test.js
├── dist/
│   ├── autobrowser.exe   # Built executable
│   └── autobrowser.js    # Built JS bundle
├── package.json
├── tsconfig.json         # TypeScript config
├── .oxlintrc.json        # Lint config
├── .oxfmtrc.json         # Format config
├── SKILL.md              # This file
└── README.md             # Project overview
```

## Requirements

- **Bun**: >=1.3.12
- **Node**: Not required (uses bun runtime)
- **Browser**: Chrome/Edge with extension loading support