import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../core/command-spec.js'
import { getHomeDir } from '../core/protocol.js'
import { isRecord, type CommandResponse } from './client.js'
import { helpRequested } from './commands/shared.js'
import type { CommandContext } from './commands/types.js'

// 超过该体积的截图 base64 不再内联进 MCP 响应（会爆模型上下文），改为落盘后回文本路径
const SCREENSHOT_MAX_INLINE_BYTES = 2 * 1024 * 1024

interface McpToolDefinition {
  name: string
  description: string
  command: string
  inputSchema: {
    type: 'object'
    properties: Record<string, object>
    required?: string[]
  }
  toArgs(args: Record<string, unknown>): Record<string, unknown>
}

function selectorOnlyTool(name: string, description: string, command: string): McpToolDefinition {
  return {
    name,
    description,
    command,
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'A CSS selector or an @eN element ref from snapshot (e.g. "button.submit" or "@e4").',
        },
      },
      required: ['selector'],
    },
    toArgs: (args) => ({ selector: args.selector }),
  }
}

function onlyDefined(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (args[key] !== undefined) {
      out[key] = args[key]
    }
  }
  return out
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Navigate to a URL in the current tab. Waits for the navigation to commit and the page to settle; the result reports settled, and settleReason when the page did not settle in time.',
    command: 'goto',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to.' },
        waitUntil: {
          type: 'string',
          enum: [
            'none',
            'commit',
            'domcontentloaded',
            'interactive',
            'load',
            'networkidle',
            'domquiet',
          ],
          description: 'Navigation phase to wait for (default domquiet).',
        },
        timeoutMs: { type: 'number', description: 'Total navigation timeout in milliseconds.' },
        settleTimeoutMs: {
          type: 'number',
          description: 'Maximum settle phase time in milliseconds.',
        },
        domQuietMs: { type: 'number', description: 'Required DOM quiet interval in milliseconds.' },
      },
      required: ['url'],
    },
    toArgs: (args) => ({
      url: args.url,
      ...onlyDefined(args, ['waitUntil', 'timeoutMs', 'settleTimeoutMs', 'domQuietMs']),
    }),
  },
  {
    name: 'snapshot',
    description:
      'Capture interactive/visible elements with @eN refs, roles, names and positions, plus @fN frame refs. Refs are not reused within a document, but removed nodes are invalid and navigation makes refs stale: refresh snapshot before acting. Output is bounded to 200000 UTF-8 bytes; when truncated, narrow target/roles or use changed to read changes. Start here to discover targets.',
    command: 'snapshot',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Restrict the snapshot to an element subtree: a CSS selector or an @eN ref.',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only return elements with these roles (e.g. button, link); @eN refs stay stable across snapshots.',
        },
        changed: {
          type: 'boolean',
          description:
            'Return added/changed elements including state changes (checked/disabled etc.) and removedRefs. Baselines are document/frame scoped; first run or navigation returns full: true. Truncated snapshots only cache delivered elements.',
        },
      },
    },
    toArgs: (args) => {
      const out = onlyDefined(args, ['roles', 'changed'])
      if (args.target !== undefined) {
        out.selector = args.target
      }
      return out
    },
  },
  {
    name: 'search',
    description:
      'Search the page visible text and return matching lines with surrounding context. Good for reading page data rather than locating elements.',
    command: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Text to match (case-insensitive substring) or a /pattern/flags regular expression.',
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 50,
          description: 'Context lines around each match (default 3, maximum 50).',
        },
        limit: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            'Maximum match windows (default 20, capped at 200; 0 returns no windows or cursor); output also has a 200-line / 100000 UTF-8 byte budget.',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            '1-based starting line (default 1). When truncated and nextStartLine is present, repeat the same query with startLine: nextStartLine; e.g. startLine: 201.',
        },
      },
      required: ['query'],
    },
    toArgs: (args) => onlyDefined(args, ['query', 'context', 'limit', 'startLine']),
  },
  {
    name: 'find',
    description:
      'Find elements by role, text, label, placeholder, alt, title, test-id, or exact-name and optionally act. Read-only locate/text default to the first match. Write actions with multiple matches return AMBIGUOUS_TARGET and candidates unless position is explicit. Inspect candidates, narrow the query/exact match, or deliberately choose position before retrying.',
    command: 'find',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          description: 'The lookup strategy; exact-name always matches exactly.',
          enum: ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'test-id', 'exact-name'],
        },
        role: {
          type: 'string',
          description: 'The ARIA role to look up (when strategy is role).',
        },
        query: {
          type: 'string',
          description: 'The text/attribute to look up (when strategy is text, label, ...).',
        },
        name: {
          type: 'string',
          description:
            'Accessible name filter (best with strategy role): substring by default; use exact: true for an exact match.',
        },
        exact: {
          type: 'boolean',
          description: 'Require an exact text match instead of a substring match.',
        },
        position: {
          type: 'string',
          description: 'Pick the first, last, or Nth match (e.g. "first", "last", "nth=2").',
        },
        candidates: {
          type: 'number',
          description: 'Return a Top-N ranked candidate list (only with action locate).',
        },
        action: {
          type: 'string',
          description: 'Optional action to perform on the matched element.',
          enum: ['locate', 'click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck', 'text'],
        },
        value: {
          type: 'string',
          description: 'Text to enter when action is fill or type.',
        },
      },
      required: ['strategy'],
    },
    toArgs: findToArgs,
  },
  selectorOnlyTool(
    'click',
    'Click an element. Accepts a CSS selector or an @eN element ref from snapshot. If the click triggers a navigation, waits for the page to settle and reports navigatedToUrl/settled.',
    'click',
  ),
  selectorOnlyTool(
    'dblclick',
    'Double-click an element. Accepts a CSS selector or an @eN element ref from snapshot.',
    'dblclick',
  ),
  selectorOnlyTool(
    'hover',
    'Move the mouse over an element. Accepts a CSS selector or an @eN element ref from snapshot.',
    'hover',
  ),
  {
    name: 'fill',
    description:
      'Fill a form field: text inputs, textareas and contenteditable take the text value; select elements match an option by its text or value; checkbox/radio inputs take "true" or "false". Accepts a CSS selector or an @eN element ref.',
    command: 'fill',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'A CSS selector or an @eN element ref from snapshot.',
        },
        value: { type: 'string', description: 'The text to enter.' },
      },
      required: ['selector', 'value'],
    },
    toArgs: (args) => ({ selector: args.selector, value: args.value }),
  },
  {
    name: 'type',
    description:
      'Type text into a field, optionally pressing Enter (submit) afterward. Accepts a CSS selector or an @eN element ref.',
    command: 'type',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'A CSS selector or an @eN element ref from snapshot.',
        },
        value: { type: 'string', description: 'The text to type.' },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing to submit the form.',
        },
      },
      required: ['selector', 'value'],
    },
    toArgs: (args) => onlyDefined(args, ['selector', 'value', 'submit']),
  },
  {
    name: 'press',
    description: 'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace).',
    command: 'press',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key name to press.' },
      },
      required: ['key'],
    },
    toArgs: (args) => ({ key: args.key }),
  },
  {
    name: 'scroll',
    description: 'Scroll the page or an element horizontally/vertically by a number of pixels.',
    command: 'scroll',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'Optional element to scroll (CSS selector or @eN ref); scrolls the page when omitted.',
        },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in pixels.' },
      },
    },
    toArgs: (args) => onlyDefined(args, ['selector', 'deltaX', 'deltaY']),
  },
  {
    name: 'get',
    description:
      'Read page or element data: text (default), html, value, count, box, styles, title, url, or any other element attribute.',
    command: 'get',
    inputSchema: {
      type: 'object',
      properties: {
        attr: {
          type: 'string',
          description:
            'What to read: text (default), html, value, count, box, styles, title, url, or an attribute name.',
        },
        selector: {
          type: 'string',
          description:
            'The element to read from (CSS selector or @eN ref). Ignored for title, url, cdp-url.',
        },
      },
    },
    toArgs: (args) => {
      const out: Record<string, unknown> = {}
      const attr = args.attr
      if (attr !== undefined) {
        out.attr = attr
      } else {
        out.attr = 'text'
      }
      if (args.selector !== undefined) {
        out.selector = args.selector
      }
      return out
    },
  },
  {
    name: 'wait',
    description:
      'Wait for a selector state, text, URL, load state, a function expression, or a fixed duration.',
    command: 'wait',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'What to wait for; inferred from the other arguments when omitted.',
          enum: ['selector', 'url', 'text', 'fn', 'time', 'load', 'networkidle'],
        },
        selector: {
          type: 'string',
          description: 'Element to wait on (CSS selector or @eN ref).',
        },
        state: {
          type: 'string',
          description:
            'Expected state for selector waits: visible (default), hidden, stable, or new.',
          enum: ['visible', 'hidden', 'stable', 'new'],
        },
        text: { type: 'string', description: 'Text that should appear (or disappear with gone).' },
        url: { type: 'string', description: 'URL pattern the page should navigate to.' },
        fn: { type: 'string', description: 'JS expression that should evaluate truthy.' },
        timeout: { type: 'number', description: 'Total timeout in milliseconds (default 30000).' },
        ms: { type: 'number', description: 'Fixed duration to wait in milliseconds.' },
        gone: { type: 'boolean', description: 'Wait for text to disappear instead of appear.' },
      },
    },
    toArgs: waitToArgs,
  },
  {
    name: 'screenshot',
    description:
      'Capture a screenshot of the page or a specific element and return it as an image.',
    command: 'screenshot',
    inputSchema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport.',
        },
        annotate: { type: 'boolean', description: 'Overlay numbered labels on elements.' },
        format: { type: 'string', description: 'Image format.', enum: ['png', 'jpeg'] },
        quality: { type: 'number', description: 'JPEG quality (1-100).' },
        element: {
          type: 'string',
          description:
            'Capture only this element (CSS selector or @eN ref); cannot be combined with full.',
        },
      },
    },
    toArgs: (args) => onlyDefined(args, ['full', 'annotate', 'format', 'quality', 'element']),
  },
  {
    name: 'tab_list',
    description: 'List open tabs with their stable handles (tN), titles, and URLs.',
    command: 'tab.list',
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'Only return active tabs.' },
        currentWindow: { type: 'boolean', description: 'Only return tabs in the target window.' },
        filter: { type: 'string', description: 'Match handle, title, or URL.' },
        pageIdx: { type: 'number', description: 'Zero-based page index.' },
        pageSize: { type: 'number', description: 'Tabs per page.' },
      },
    },
    toArgs: (args) =>
      onlyDefined(args, ['active', 'currentWindow', 'filter', 'pageIdx', 'pageSize']),
  },
  {
    name: 'target',
    description: 'Inspect, set, clear, or replace the persistent target tab with the active tab.',
    command: 'target',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'set', 'active', 'clear'] },
        handle: { type: 'string', description: 'Stable tN handle required by set.' },
      },
      required: ['action'],
    },
    toArgs: (args) => ({ action: args.action, ...onlyDefined(args, ['handle']) }),
  },
  {
    name: 'command_control',
    description:
      'Inspect or cancel queued/running extension commands; reset detaches a stuck target queue.',
    command: 'command',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'cancel', 'reset'] },
        commandId: { type: 'string', description: 'Command id required by cancel.' },
        handle: { type: 'string', description: 'Target queue handle for reset.' },
      },
      required: ['action'],
    },
    toArgs: (args) => ({ action: args.action, ...onlyDefined(args, ['commandId', 'handle']) }),
  },
  {
    name: 'tab_new',
    description: 'Open a new tab, optionally at a URL.',
    command: 'tab.new',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open; opens a blank tab when omitted.' },
      },
    },
    toArgs: (args) => ({ url: typeof args.url === 'string' ? args.url : 'about:blank' }),
  },
  {
    name: 'tab_select',
    description: 'Select a tab by its handle (tN) to make it the active tab.',
    command: 'tab.select',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The tab handle, e.g. "t2".' },
      },
      required: ['handle'],
    },
    toArgs: (args) => ({ handle: args.handle }),
  },
  {
    name: 'tab_close',
    description: 'Close the current tab, a specific tab by handle (tN), or all tabs with "all".',
    command: 'tab.close',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description:
            'The tab handle to close (e.g. "t3"); omit to close the current tab, pass "all" to close all.',
        },
      },
    },
    toArgs: (args) => (args.handle !== undefined ? { handle: args.handle } : {}),
  },
  {
    name: 'eval',
    description:
      'Run JavaScript in the page context and return the serialized result. The script can use await.',
    command: 'eval',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'JavaScript source; with element, use a function such as el => el.textContent.',
        },
        element: {
          type: 'string',
          description: 'Optional CSS/@eN target passed to the script as el.',
        },
      },
      required: ['script'],
    },
    toArgs: (args) => ({ script: args.script, ...onlyDefined(args, ['element']) }),
  },
  {
    name: 'cdp',
    description:
      'Execute a tab-scoped Chrome DevTools Protocol method with object params. Browser/Target/SystemInfo methods and Debugger.disable are rejected. May have side effects; do not replay unknown outcomes.',
    command: 'cdp',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'CDP method, for example Runtime.evaluate.' },
        params: { type: 'object', description: 'CDP method parameters (default {}).' },
      },
      required: ['method'],
    },
    toArgs: (args) => ({ method: args.method, ...onlyDefined(args, ['params']) }),
  },
  {
    name: 'console',
    description:
      'Return console messages recorded for the target tab (folded consecutive duplicates with repeatCount). Messages are paginated; an out-of-range pageIdx falls back to the first page with pagination.invalidPage: true. Use pageSize to control how many messages come back (default 50, max 200).',
    command: 'console',
    inputSchema: {
      type: 'object',
      properties: {
        pageIdx: { type: 'number', description: 'Zero-based page index (default 0).' },
        pageSize: { type: 'number', description: 'Messages per page (default 50, max 200).' },
        action: { type: 'string', enum: ['list', 'clear'] },
        since: {
          type: 'number',
          description: 'Only records at or after this Unix millisecond timestamp.',
        },
        allEpochs: { type: 'boolean', description: 'Include prior page epochs in the target tab.' },
      },
    },
    toArgs: (args) => onlyDefined(args, ['action', 'pageIdx', 'pageSize', 'since', 'allEpochs']),
  },
  {
    name: 'errors',
    description:
      'Return page errors (uncaught exceptions, failed loads) recorded for the target tab. Paginated like console: an out-of-range pageIdx falls back to the first page with pagination.invalidPage: true.',
    command: 'errors',
    inputSchema: {
      type: 'object',
      properties: {
        pageIdx: { type: 'number', description: 'Zero-based page index (default 0).' },
        pageSize: { type: 'number', description: 'Errors per page (default 50, max 200).' },
        action: { type: 'string', enum: ['list', 'clear'] },
        since: {
          type: 'number',
          description: 'Only records at or after this Unix millisecond timestamp.',
        },
        allEpochs: { type: 'boolean', description: 'Include prior page epochs in the target tab.' },
      },
    },
    toArgs: (args) => onlyDefined(args, ['action', 'pageIdx', 'pageSize', 'since', 'allEpochs']),
  },
  {
    name: 'network_requests',
    description:
      'Return network requests observed by the extension (document loads, XHR, fetch), in chronological order. Paginated like console: an out-of-range pageIdx falls back to the first page with pagination.invalidPage: true.',
    command: 'network',
    inputSchema: {
      type: 'object',
      properties: {
        pageIdx: { type: 'number', description: 'Zero-based page index (default 0).' },
        pageSize: { type: 'number', description: 'Requests per page (default 50, max 200).' },
        allTabs: { type: 'boolean', description: 'Include all tabs instead of the target tab.' },
        allEpochs: { type: 'boolean', description: 'Include prior page epochs.' },
        includeDetails: {
          type: 'boolean',
          description:
            'Include stored headers/body details, not a guarantee of body availability. Without HAR only metadata is monitored; CLI network request <id> fetches body on demand via CDP, which may fail for historical/expired requests.',
        },
      },
    },
    toArgs: (args) => ({
      action: 'requests',
      ...onlyDefined(args, ['pageIdx', 'pageSize', 'allTabs', 'allEpochs', 'includeDetails']),
    }),
  },
  {
    name: 'network_har',
    description:
      'Start, stop, inspect, or recover checkpointed HAR capture. Body fetches use 4 slots and a 10s logical timeout; uncancellable CDP work keeps its slot until settled. Stop waits only for this capture and transparently reassembles large chunked results (or returns an explicit size error), without silently truncating HAR.',
    command: 'network',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'recover'] },
        maxRequests: { type: 'number' },
        maxBodyBytes: {
          type: 'number',
          description: 'Stored body byte limit, not a CDP download/transfer limit.',
        },
      },
      required: ['action'],
    },
    toArgs: (args) => ({
      action: 'har',
      subaction: args.action,
      ...onlyDefined(args, ['maxRequests', 'maxBodyBytes']),
    }),
  },
  {
    name: 'dialog',
    description:
      'Inspect or respond to the JavaScript dialog (alert/confirm/prompt) open in the target tab. status reports whether a dialog is open and its message; accept or dismiss closes it (accept a prompt dialog with an optional promptText).',
    command: 'dialog',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do with the dialog.',
          enum: ['accept', 'dismiss', 'status'],
        },
        promptText: {
          type: 'string',
          description: 'Text to supply when accepting a prompt dialog.',
        },
      },
      required: ['action'],
    },
    toArgs: (args) => {
      const action = args.action
      if (action === 'status') {
        return { action: 'status' }
      }
      if (action === 'accept') {
        return { accept: true, ...onlyDefined(args, ['promptText']) }
      }
      if (action === 'dismiss') {
        return { accept: false, ...onlyDefined(args, ['promptText']) }
      }
      throw new Error('dialog action must be accept, dismiss, or status')
    },
  },
  {
    name: 'cookies',
    description:
      'Inspect or modify cookies for the target tab. list/get lists cookies (optionally filtered by domain), set stores a cookie by name/value/domain, delete removes a cookie by name, clear removes all cookies for the current site.',
    command: 'cookies',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do with cookies.',
          enum: ['list', 'get', 'set', 'delete', 'clear'],
        },
        name: { type: 'string', description: 'Cookie name (set/delete).' },
        value: { type: 'string', description: 'Cookie value (set).' },
        domain: { type: 'string', description: 'Cookie domain (set, or get filter).' },
      },
      required: ['action'],
    },
    toArgs: (args) => ({
      action: args.action === 'list' ? 'get' : args.action,
      ...onlyDefined(args, ['name', 'value', 'domain']),
    }),
  },
  {
    name: 'storage',
    description:
      'Read or modify localStorage for the target tab (sessionStorage when session is true). get reads a key, set writes a key/value, delete removes a key, clear empties the storage.',
    command: 'storage',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do with storage.',
          enum: ['get', 'set', 'delete', 'clear'],
        },
        key: { type: 'string', description: 'Storage key (get/set/delete).' },
        value: { type: 'string', description: 'Storage value (set).' },
        session: {
          type: 'boolean',
          description: 'Operate on sessionStorage instead of localStorage.',
        },
      },
      required: ['action'],
    },
    toArgs: (args) => ({ action: args.action, ...onlyDefined(args, ['key', 'value', 'session']) }),
  },
  {
    name: 'locator',
    description: 'Generate and verify a unique data-testid, id, CSS path or agent-ref locator.',
    command: 'locator',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector or @eN element ref.' } },
      required: ['selector'],
    },
    toArgs: (args) => ({ selector: args.selector }),
  },
  {
    name: 'highlight',
    description:
      'Highlight an element without changing layout. Use hide with a selector to restore it, or hide without a selector to clear all.',
    command: 'highlight',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @eN element ref.' },
        style: {
          type: 'string',
          description: 'CSS outline shorthand; cannot be combined with hide.',
        },
        hide: {
          type: 'boolean',
          description: 'Restore previous outlines instead of highlighting.',
        },
      },
    },
    toArgs: (args) => onlyDefined(args, ['selector', 'style', 'hide']),
  },
  {
    name: 'drop',
    description: 'Drop text data or base64-encoded files onto an element, including inside frames.',
    command: 'drop',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @eN element ref.' },
        data: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'MIME type to text data, for example {"text/plain":"hello"}.',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              mimeType: { type: 'string' },
              dataBase64: {
                type: 'string',
                description: 'Base64 file content; max 32MiB per file.',
              },
            },
            required: ['name', 'mimeType', 'dataBase64'],
          },
          description: 'Files to drop; maximum 64MiB total.',
        },
      },
      required: ['selector'],
    },
    toArgs: (args) => ({ selector: args.selector, ...onlyDefined(args, ['data', 'files']) }),
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse to viewport coordinates in the target tab.',
    command: 'mousemove',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
    toArgs: (args) => ({ x: args.x, y: args.y }),
  },
  {
    name: 'mouse_down',
    description: 'Press a mouse button at the current position; follow with mouse_up.',
    command: 'mousedown',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string', enum: ['left', 'right', 'middle', 'back', 'forward'] },
      },
    },
    toArgs: (args) => onlyDefined(args, ['button']),
  },
  {
    name: 'mouse_up',
    description: 'Release a mouse button at the current position.',
    command: 'mouseup',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string', enum: ['left', 'right', 'middle', 'back', 'forward'] },
      },
    },
    toArgs: (args) => onlyDefined(args, ['button']),
  },
  {
    name: 'mouse_wheel',
    description: 'Scroll by deltaX/deltaY at the current mouse position.',
    command: 'mousewheel',
    inputSchema: {
      type: 'object',
      properties: { deltaX: { type: 'number' }, deltaY: { type: 'number' } },
      required: ['deltaX', 'deltaY'],
    },
    toArgs: (args) => ({ deltaX: args.deltaX, deltaY: args.deltaY }),
  },
  {
    name: 'video',
    description:
      'Record WebM video with chapters and action callouts; stop writes video and chapter files (64MiB limit).',
    command: 'video',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'chapter', 'show-actions', 'hide-actions'],
        },
        maxDurationMs: { type: 'integer', minimum: 1, maximum: 3600000 },
        title: { type: 'string' },
        description: { type: 'string' },
        durationMs: { type: 'integer', minimum: 0 },
        position: { type: 'string', description: 'CSS position declarations for action callouts.' },
        highlightStyle: { type: 'string', description: 'CSS outline for the action target.' },
      },
      required: ['action'],
    },
    toArgs: (args) => ({
      action: args.action,
      ...onlyDefined(args, [
        'maxDurationMs',
        'title',
        'description',
        'durationMs',
        'position',
        'highlightStyle',
      ]),
    }),
  },
  {
    name: 'tracing',
    description: 'Start, check or stop a CDP trace; stop writes the trace to a file (32MiB limit).',
    command: 'tracing',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop', 'status'] } },
      required: ['action'],
    },
    toArgs: (args) => ({ action: args.action }),
  },
  {
    name: 'actions',
    description: 'Read or clear the bounded command timeline; argument values are not recorded.',
    command: 'actions',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'clear'] } },
      required: ['action'],
    },
    toArgs: (args) => ({ action: args.action }),
  },
  {
    name: 'auto_snapshot',
    description: 'Enable or disable snapshots after successful navigation and input actions.',
    command: 'set',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
    toArgs: (args) => ({ type: 'auto-snapshot', enabled: args.enabled }),
  },
  {
    name: 'media_emulation',
    description:
      'Set or reset color scheme, print/screen media, reduced motion, forced colors or contrast for the target tab.',
    command: 'set',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['color-scheme', 'media-type', 'reduced-motion', 'forced-colors', 'contrast'],
        },
        value: {
          type: 'string',
          description: 'Emulation value; omit or use an empty string to reset this item.',
        },
      },
      required: ['type'],
    },
    toArgs: (args) =>
      args.type === 'color-scheme'
        ? { type: 'media', media: typeof args.value === 'string' ? args.value : '' }
        : { type: args.type, value: typeof args.value === 'string' ? args.value : '' },
  },
  {
    name: 'device',
    description:
      'Apply a coordinated viewport, DPR, mobile and user-agent preset, or reset device emulation.',
    command: 'set',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['iphone-15', 'pixel-10', 'desktop-chrome'] },
      },
    },
    toArgs: (args) => ({
      type: 'device',
      value: typeof args.preset === 'string' ? args.preset : '',
    }),
  },
  {
    name: 'fill_form',
    description:
      'Fill multiple form fields in one call; each field is filled in order and a failing field is reported in results without stopping the rest. ALWAYS prefer this tool over multiple individual fill calls when filling several fields.',
    command: 'fillform',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'The fields to fill, in order.',
          items: {
            type: 'object',
            properties: {
              selector: {
                type: 'string',
                description: 'A CSS selector or an @eN element ref from snapshot.',
              },
              value: {
                type: 'string',
                description:
                  'The text to fill. For select elements, match an option by its text or value; for checkbox/radio inputs use "true" or "false".',
              },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['fields'],
    },
    toArgs: (args) => {
      if (!Array.isArray(args.fields)) {
        throw new Error('fill_form requires a fields array')
      }
      return { fields: args.fields }
    },
  },
]

const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]))

function findToArgs(args: Record<string, unknown>): Record<string, unknown> {
  const strategy = args.strategy
  if (typeof strategy !== 'string') {
    throw new Error(
      'find requires a strategy: role, text, label, placeholder, alt, title, test-id, or exact-name',
    )
  }

  const out: Record<string, unknown> = { strategy }
  if (strategy === 'role') {
    out.role = typeof args.role === 'string' ? args.role : args.query
  } else {
    out.query = typeof args.query === 'string' ? args.query : args.role
  }
  for (const key of ['name', 'exact', 'position', 'candidates', 'action', 'value']) {
    if (args[key] !== undefined) {
      out[key] = args[key]
    }
  }
  return out
}

function waitToArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const gone = args.gone === true
  const explicitType = args.type

  if (explicitType !== undefined) {
    out.type = explicitType
  } else if (args.url !== undefined) {
    out.type = 'url'
  } else if (args.text !== undefined) {
    out.type = 'text'
  } else if (args.fn !== undefined) {
    out.type = 'fn'
  } else if (args.ms !== undefined) {
    out.type = 'time'
  } else {
    out.type = 'selector'
  }

  if (gone && String(out.type) !== 'text') {
    throw new Error('wait --gone requires --text <text>')
  }

  return {
    ...out,
    ...onlyDefined(args, ['selector', 'state', 'text', 'url', 'fn', 'timeout', 'ms', 'gone']),
  }
}

function extractScreenshotData(result: Record<string, unknown>): {
  data: string
  mimeType: string
} {
  const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
  const rawData =
    typeof result.data === 'string'
      ? result.data
      : dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : ''

  if (!rawData) {
    throw new Error('missing screenshot data')
  }

  const mimeType =
    typeof result.mimeType === 'string'
      ? result.mimeType
      : dataUrl.startsWith('data:image/jpeg')
        ? 'image/jpeg'
        : 'image/png'

  return {
    data: rawData,
    mimeType,
  }
}

function toErrorResult(
  code: string | undefined,
  message: string,
  error: {
    suggestion?: string
    suggestedAction?: string
    details?: unknown
  } = {},
): CallToolResult {
  const suggestion = error.suggestion || error.suggestedAction
  const text = suggestion ? `${message}\n\n[AI SUGGESTION]: ${suggestion}` : message
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        ...(code ? { code } : {}),
        message,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
  }
}

function toSuccessResult(result: unknown): CallToolResult {
  const structuredContent = isRecord(result) && !Array.isArray(result) ? result : undefined
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

function toScreenshotResult(result: Record<string, unknown>): Promise<CallToolResult> {
  const { data, mimeType } = extractScreenshotData(result)
  const summary: Record<string, unknown> = { mimeType }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'data' && key !== 'dataUrl') {
      summary[key] = value
    }
  }
  const dimensions =
    typeof result.width === 'number' && typeof result.height === 'number'
      ? ` (${result.width}x${result.height})`
      : ''
  const byteLength = Buffer.from(data, 'base64').length
  if (byteLength > SCREENSHOT_MAX_INLINE_BYTES) {
    return writeOversizedScreenshot(result, summary, data, mimeType, byteLength)
  }
  return Promise.resolve({
    content: [
      { type: 'image', data, mimeType },
      { type: 'text', text: `Screenshot captured as ${mimeType}${dimensions}.` },
    ],
    structuredContent: summary,
  })
}

/** 超过 2MB 的截图落盘到 ~/.autobrowser/screenshots/，只回文本路径，避免 base64 进模型上下文 */
async function writeOversizedScreenshot(
  result: Record<string, unknown>,
  summary: Record<string, unknown>,
  data: string,
  mimeType: string,
  byteLength: number,
): Promise<CallToolResult> {
  const extension = mimeType === 'image/jpeg' ? 'jpeg' : 'png'
  const directory = path.join(getHomeDir(), '.autobrowser', 'screenshots')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `autobrowser-${Date.now()}.${extension}`)
  await writeFile(filePath, data, 'base64')

  const sizeMb = (byteLength / (1024 * 1024)).toFixed(1)
  const sizeText =
    typeof result.width === 'number' && typeof result.height === 'number'
      ? `${result.width}x${result.height} pixels`
      : `${byteLength} bytes`
  const text = `screenshot saved to ${filePath} (${sizeText}, ${sizeMb} MB, too large to inline)`
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ...summary, path: filePath },
  }
}

async function toVideoResult(result: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof result.data !== 'string') return toSuccessResult(result)
  const { data, ...summary } = result
  const directory = path.join(getHomeDir(), '.autobrowser', 'videos')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `video-${Date.now()}.webm`)
  await writeFile(filePath, data, 'base64')
  let chaptersPath: string | undefined
  if (Array.isArray(result.chapters) && result.chapters.length) {
    chaptersPath = filePath.replace(/\.webm$/i, '') + '.chapters.json'
    await writeFile(chaptersPath, `${JSON.stringify(result.chapters, null, 2)}\n`)
  }
  return {
    content: [{ type: 'text', text: `video saved to ${filePath}` }],
    structuredContent: { ...summary, path: filePath, chaptersPath },
  }
}

async function toTracingResult(result: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof result.data !== 'string') return toSuccessResult(result)
  const { data, ...summary } = result
  const directory = path.join(getHomeDir(), '.autobrowser', 'tracing')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `trace-${Date.now()}.json`)
  await writeFile(filePath, data, result.base64Encoded === true ? 'base64' : 'utf8')
  return {
    content: [{ type: 'text', text: `trace saved to ${filePath}` }],
    structuredContent: { ...summary, path: filePath },
  }
}

export interface McpServerDependencies {
  name?: string
  version?: string
  requestCommand: (command: string, args: Record<string, unknown>) => Promise<CommandResponse>
}

export class AutobrowserMcpServer {
  readonly name: string
  readonly version: string
  private readonly requestCommand: McpServerDependencies['requestCommand']

  constructor(dependencies: McpServerDependencies) {
    this.name = dependencies.name ?? 'autobrowser'
    this.version = dependencies.version ?? '0.1.0'
    this.requestCommand = dependencies.requestCommand
  }

  listTools(): Tool[] {
    return MCP_TOOLS.map((definition) => {
      const properties: Record<string, object> = { ...definition.inputSchema.properties }
      if (commandSupportsTabTarget(definition.command)) {
        properties.tab = {
          type: 'string',
          description: 'Target a specific tab by handle (tN) or id.',
        }
      }
      if (commandSupportsFrameTarget(definition.command)) {
        properties.frame = {
          type: 'string',
          description: 'Target a specific frame by reference (@fN) or selector.',
        }
      }
      return {
        name: definition.name,
        description: definition.description,
        inputSchema: {
          type: 'object',
          properties,
          ...(definition.inputSchema.required ? { required: definition.inputSchema.required } : {}),
        },
      }
    })
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const definition = MCP_TOOLS_BY_NAME.get(name)
    if (!definition) {
      return toErrorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`, {
        suggestedAction: `Available tools: ${MCP_TOOLS.map((tool) => tool.name).join(', ')}`,
      })
    }

    const commandArgs: Record<string, unknown> = {}
    try {
      Object.assign(commandArgs, definition.toArgs(args ?? {}))
      if (commandSupportsTabTarget(definition.command) && args?.tab !== undefined) {
        commandArgs.tabId = args.tab
      }
      if (commandSupportsFrameTarget(definition.command) && args?.frame !== undefined) {
        commandArgs.frame = args.frame
      }
    } catch (error) {
      return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
    }

    let payload: CommandResponse
    try {
      payload = await this.requestCommand(definition.command, commandArgs)
    } catch (error) {
      return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
    }

    if (payload.ok === false) {
      const error = payload.error
      return toErrorResult(error?.code, error?.message || 'command failed', {
        suggestion: error?.suggestion,
        suggestedAction: error?.suggestedAction,
        details: error?.details,
      })
    }

    if (definition.command === 'video' && isRecord(payload.result)) {
      try {
        return await toVideoResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    if (definition.command === 'tracing' && isRecord(payload.result)) {
      try {
        return await toTracingResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    if (
      definition.command === 'screenshot' &&
      isRecord(payload.result) &&
      !Array.isArray(payload.result)
    ) {
      try {
        return toScreenshotResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    return toSuccessResult(payload.result)
  }

  async connect(transport: Transport): Promise<void> {
    const server = new Server(
      { name: this.name, version: this.version },
      {
        capabilities: { tools: {} },
        instructions:
          'Request budgets default to 30s. Explicit eval/navigation/click timeoutMs or wait timeout/ms adds 5s transport allowance (at least 30s); batch combines step/retry/delay budgets, capped at 30 minutes including allowance. Sent commands with unknown outcomes are not automatically replayed: inspect status, command_control and page state before retrying. Explicit batch retries may repeat side effects and are not an idempotency guarantee.',
      },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.callTool(request.params.name, request.params.arguments)
    })
    await server.connect(transport)
  }
}

export async function handleMcpCommand(
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  if (helpRequested(rest[0], context, ['mcp'])) {
    return 0
  }

  try {
    await context.getCommandStatus(context.flags.server)
  } catch {
    // The first tool call surfaces any connection problem as an isError result.
  }

  const server = new AutobrowserMcpServer({
    requestCommand: async (command, args) =>
      await context.requestCommand(context.flags.server, command, args),
  })
  const transport = new StdioServerTransport()
  transport.onclose = () => process.exit(0)
  await server.connect(transport)
  return undefined
}
