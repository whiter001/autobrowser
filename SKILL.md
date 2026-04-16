# autobrowser Skills

## Overview

autobrowser is a browser automation tool that controls Chrome/Edge via a browser extension, exposing a CLI API for scripting and automation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        autobrowser                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐      ┌──────────────┐      ┌───────────┐  │
│  │    CLI      │      │   IPC Server │      │ Relay WS  │  │
│  │ (bun cli.js)│──────│  port 47979  │      │ port 47978│  │
│  └──────────────┘      └──────┬───────┘      └─────┬─────┘  │
│                               │                    │        │
│                               │                    │        │
│                        ┌──────▼────────────────▼──┐        │
│                        │     Browser Extension     │        │
│                        │    (background.js)        │        │
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
job spawn { bun src/cli.js server }

# Wait for server to be ready
sleep 3sec

# Execute commands
bun src/cli.js goto https://www.baidu.com
bun src/cli.js get title
```

### Complete Workflow

```nushell
# One-liner execution
nu -c "job spawn { bun src/cli.js server }; sleep 3sec; bun src/cli.js goto https://x.com; bun src/cli.js wait time 8000; bun src/cli.js get title"

# Multi-step workflow
nu -c "
  job spawn { bun src/cli.js server }
  sleep 3sec
  bun src/cli.js goto https://www.baidu.com
  bun src/cli.js get title
  bun src/cli.js goto https://x.com
  bun src/cli.js wait time 5000
  bun src/cli.js eval \"[...document.querySelectorAll('article')].slice(0,3).map(t => t.innerText.slice(0,200)).join('===')\"
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
bun src/cli.js server &
```

**do --bg (Nu 0.60+)**
```nushell
do -b bun src/cli.js server
```

**External command prefix ^**
```nushell
^bun src/cli.js server &
```

## CLI Commands

### Server Management

```bash
# Start server (blocks)
bun src/cli.js server

# Check server status
bun src/cli.js status
```

### Tab Operations

```bash
# Navigate to URL
bun src/cli.js goto https://example.com
bun src/cli.js open https://example.com

# Tab management
bun src/cli.js tab list
bun src/cli.js tab new <url>

# Navigation
bun src/cli.js back
bun src/cli.js forward
bun src/cli.js reload
```

### Element Interaction

```bash
# Click element
bun src/cli.js click "#submit-button"

# Fill input
bun src/cli.js fill "#username" "admin"

# Hover/Focus
bun src/cli.js hover "#menu"
bun src/cli.js focus "#search"

# Select dropdown
bun src/cli.js select "#country" "US"

# Check/Uncheck
bun src/cli.js check "#agree"
bun src/cli.js uncheck "#agree"

# Press key
bun src/cli.js press "Enter"
bun src/cli.js press "Control+KeyA"
```

### Element State & Retrieval

```bash
# Check element state
bun src/cli.js is visible "#dialog"
bun src/cli.js is enabled "#submit"
bun src/cli.js is checked "#checkbox"
bun src/cli.js is disabled "#button"

# Get element attributes
bun src/cli.js get text "#title"        # textContent
bun src/cli.js get html "#content"      # innerHTML
bun src/cli.js get value "#input"       # value
bun src/cli.js get title                # document.title
bun src/cli.js get url                  # window.location.href
bun src/cli.js get count "div.card"     # querySelectorAll count
bun src/cli.js get box "#image"         # bounding box
```

### Scrolling & Dragging

```bash
# Scroll page or element
bun src/cli.js scroll                   # scroll by 0,100
bun src/cli.js scroll "div.content" 50 100

# Drag element
bun src/cli.js drag "#handle" "#target"
```

### Waiting

```bash
# Wait for selector
bun src/cli.js wait selector "#loading" 30000

# Wait for URL pattern
bun src/cli.js wait url "https://example.com" 30000

# Wait for text
bun src/cli.js wait text "Success" 30000

# Wait for page load
bun src/cli.js wait load 30000

# Wait for network idle
bun src/cli.js wait networkidle 30000

# Wait for fixed time
bun src/cli.js wait time 5000
```

### Execute Script

```bash
# Eval JS (inline)
bun src/cli.js eval "document.title"

# Eval from file
bun src/cli.js eval --file script.js

# Eval from stdin
echo "Math.random()" | bun src/cli.js eval --stdin

# Eval from base64
bun src/cli.js eval --base64 "Y29uc29sZS5sb2coJ2hlbGxvJyk="
```

### Cookies & Storage

```bash
# Cookies
bun src/cli.js cookies get
bun src/cli.js cookies set "name" "value" ".example.com"
bun src/cli.js cookies clear

# LocalStorage
bun src/cli.js storage get "token"
bun src/cli.js storage set "token" "abc123"
bun src/cli.js storage clear
```

### Browser Settings

```bash
# Viewport
bun src/cli.js set viewport 1920 1080 1 false

# Offline mode
bun src/cli.js set offline true

# Headers
bun src/cli.js set headers "[{\"name\":\"X-Custom\",\"value\":\"test\"}]"

# Geolocation
bun src/cli.js set geo 39.9042 116.4074 100

# Media (color scheme)
bun src/cli.js set media "dark"
bun src/cli.js set media "light"
```

### Dialog Handling

```bash
# Accept dialog with optional prompt text
bun src/cli.js dialog accept "optional prompt"

# Dismiss dialog
bun src/cli.js dialog dismiss
```

### Clipboard

```bash
# Read clipboard
bun src/cli.js clipboard read

# Write clipboard
bun src/cli.js clipboard write "text to copy"
```

### State Management

```bash
# Save browser state (cookies + localStorage)
bun src/cli.js state save "session1"

# Load state
bun src/cli.js state load '{"cookies":[...],"storage":{...}}'
```

### Other Commands

```bash
# Screenshot
bun src/cli.js screenshot

# PDF generation
bun src/cli.js pdf

# Snapshot (full state)
bun src/cli.js snapshot

# Current console messages
bun src/cli.js console

# Page errors
bun src/cli.js errors

# File upload
bun src/cli.js upload "input[type=file]" "file1.txt" "file2.txt"
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
powershell -Command "& {Start-Process -FilePath 'bun' -ArgumentList 'src/cli.js','server' -NoNewWindow -PassThru; Start-Sleep -Seconds 3; bun src/cli.js status}"
```

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

## Project Commands

```bash
# Development
npm run dev                 # Start server with bun

# Code quality
npm run oxlint              # Lint code
npm run oxfmt               # Format code
npm run lint                # Lint + check format
npm run lint:fix            # Auto-fix format

# Testing
npm run test                # Run tests
npm run check               # Run test suite

# Extension
bun src/cli.js connect      # Show connect page info
```

## Token Regeneration

Token is auto-generated on first server start and persisted. To regenerate:

```bash
# Stop server
# Delete ~/.autobrowser directory
rm -rf ~/.autobrowser

# Restart server - new token generated
bun src/cli.js server
```

## Troubleshooting

### Extension won't connect

1. Verify token matches between extension and server
2. Check relay port in extension options matches server
3. Ensure no firewall blocking localhost connections

### Commands fail with "ConnectionRefused"

Server not running. Start it first with nushell:
```nushell
job spawn { bun src/cli.js server }
sleep 3sec
```

### "unauthorized" error

Token mismatch. Verify extension has correct token, or reset by deleting `~/.autobrowser`.

## File Structure

```
autobrowser/
├── src/
│   ├── cli.js           # CLI entry point
│   ├── server.js        # HTTP/WS server setup
│   └── core/
│       ├── protocol.js  # Constants & utilities
│       └── runtime.js   # Runtime state management
├── extension/
│   ├── background.js    # Chrome extension background
│   └── options.js       # Extension options page
├── test/
│   └── command-line.test.js
├── package.json
├── .oxlintrc.json       # Lint config
├── .oxfmtrc.json        # Format config
├── SKILL.md             # This file
└── README.md            # Project overview
```
