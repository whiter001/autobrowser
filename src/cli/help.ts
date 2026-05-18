interface HelpNode {
  name: string
  summary: string
  usage: string
  options?: string[]
  children?: HelpNode[]
}

function helpNode(
  name: string,
  summary: string,
  usage: string,
  options?: string[],
  children?: HelpNode[],
): HelpNode {
  return {
    name,
    summary,
    usage,
    ...(options && options.length > 0 ? { options } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  }
}

const HELP_ROOT = helpNode(
  'autobrowser',
  'Browser automation CLI for controlling Chrome/Edge through a relay server and extension.',
  'autobrowser [command] [options]',
  [
    '--json',
    '--server <url>',
    '--relay-port <port>',
    '--ipc-port <port>',
    '--tab <tN|id>',
    '--frame <@fN|selector>',
    '--stdin',
    '--file <path>',
    '--base64',
    '--extension-id <id>',
    '--browser-command <command>',
    '--browser-arg <arg>',
  ],
  [
    helpNode('help', 'Show help for a command path.', 'autobrowser help [command ...]'),
    helpNode(
      'batch',
      'Execute commands in sequence with optional retries and continue-on-error.',
      'autobrowser batch [--stdin|--file <path>|--base64] <json-array|json-object>',
    ),
    helpNode(
      'server',
      'Manage the background relay and IPC servers.',
      'autobrowser server [--serve] [--relay-port <port>] [--ipc-port <port>] [--extension-id <id>] [--browser-command <command>] [--browser-arg <arg>]',
      undefined,
      [helpNode('stop', 'Stop the background servers.', 'autobrowser server stop')],
    ),
    helpNode('status', 'Show server status.', 'autobrowser status'),
    helpNode('replay', 'Replay the last recorded command.', 'autobrowser replay'),
    helpNode('config', 'Show persisted CLI connection settings.', 'autobrowser config'),
    helpNode(
      'connect',
      'Open the extension connect page, starting the local server when needed.',
      'autobrowser connect [--relay-port <port>] [--ipc-port <port>] [--extension-id <id>] [--browser-command <command>] [--browser-arg <arg>]',
    ),
    helpNode('tab', 'Manage tabs.', 'autobrowser tab <list|new|select|close>', undefined, [
      helpNode('list', 'List tabs.', 'autobrowser tab list'),
      helpNode('new', 'Open a new tab.', 'autobrowser tab new [url]'),
      helpNode('select', 'Select a tab by handle.', 'autobrowser tab select <tN>'),
      helpNode(
        'close',
        'Close the current tab, a specific tab, or all tabs.',
        'autobrowser tab close [tN|--all]',
      ),
    ]),
    helpNode('open', 'Navigate to a URL.', 'autobrowser open <url>'),
    helpNode('goto', 'Navigate to a URL.', 'autobrowser goto <url>'),
    helpNode('back', 'Go back in browser history.', 'autobrowser back'),
    helpNode('forward', 'Go forward in browser history.', 'autobrowser forward'),
    helpNode('reload', 'Reload the current page.', 'autobrowser reload'),
    helpNode('window', 'Manage browser windows.', 'autobrowser window <new>', undefined, [
      helpNode('new', 'Open a new window.', 'autobrowser window new'),
    ]),
    helpNode(
      'eval',
      'Run JavaScript in the page context.',
      'autobrowser eval [--stdin|--file path|--base64] <script>',
      ['--stdin', '--file <path>', '--base64'],
    ),
    helpNode('click', 'Click a selector.', 'autobrowser click <selector>'),
    helpNode('dblclick', 'Double-click a selector.', 'autobrowser dblclick <selector>'),
    helpNode('fill', 'Fill a selector with text.', 'autobrowser fill <selector> <value>'),
    helpNode(
      'find',
      'Find elements by role, text, or label and optionally act on them.',
      'autobrowser find <role|text|label> <query> [locate|click|fill|type|hover|focus|check|uncheck|text] [value]',
      ['--name <name>', '--exact'],
    ),
    helpNode('type', 'Type text into a selector.', 'autobrowser type <selector> <value>'),
    helpNode('press', 'Press a keyboard key.', 'autobrowser press <key>'),
    helpNode(
      'keyboard',
      'Send keyboard input.',
      'autobrowser keyboard <type|inserttext|keydown|keyup> <text>',
    ),
    helpNode('hover', 'Hover a selector.', 'autobrowser hover <selector>'),
    helpNode('focus', 'Focus a selector.', 'autobrowser focus <selector>'),
    helpNode('select', 'Select an option.', 'autobrowser select <selector> <value>'),
    helpNode('check', 'Check a checkbox.', 'autobrowser check <selector>'),
    helpNode('uncheck', 'Uncheck a checkbox.', 'autobrowser uncheck <selector>'),
    helpNode(
      'scroll',
      'Scroll a page or element.',
      'autobrowser scroll [selector] [deltaX] [deltaY]',
    ),
    helpNode(
      'scrollintoview',
      'Scroll a selector into view.',
      'autobrowser scrollintoview <selector>',
    ),
    helpNode('drag', 'Drag between elements.', 'autobrowser drag <startSelector> [endSelector]'),
    helpNode(
      'upload',
      'Upload files through a file input.',
      'autobrowser upload <selector> <files...>',
    ),
    helpNode('frame', 'Select a frame.', 'autobrowser frame <@fN|selector|top>'),
    helpNode(
      'is',
      'Check element state.',
      'autobrowser is <visible|enabled|checked|disabled|focused> <selector>',
    ),
    helpNode('get', 'Read page or element data.', 'autobrowser get <attribute> [selector]', [
      'title, url, and cdp-url read the current page and ignore selector',
      'text, html, value, count, box, and styles read from the selector',
      'other attribute names are passed through to the page element',
    ]),
    helpNode('dialog', 'Handle dialogs.', 'autobrowser dialog <accept|dismiss|status>', undefined, [
      helpNode('accept', 'Accept the active dialog.', 'autobrowser dialog accept [promptText]'),
      helpNode('dismiss', 'Dismiss the active dialog.', 'autobrowser dialog dismiss [promptText]'),
      helpNode('status', 'Show dialog status.', 'autobrowser dialog status'),
    ]),
    helpNode(
      'wait',
      'Wait for a selector, text, URL, load state, function, or a fixed duration in milliseconds.',
      'autobrowser wait [selector|time <ms>|ms <ms>|--text <text>|--url <pattern>|--load [networkidle]|--fn <expression>] [--state visible|hidden] [--timeout <ms>]',
      [
        '--state <visible|hidden>',
        '--timeout <ms> total timeout in milliseconds',
        '--text <text>',
        '--url <pattern>',
        '--load [networkidle]',
        '--fn <expression>',
        '--ms <ms> wait a fixed duration in milliseconds',
        'time <ms> positional alias for waiting a fixed duration in milliseconds',
      ],
    ),
    helpNode(
      'cookies',
      'Inspect or update cookies.',
      'autobrowser cookies <get|set|clear>',
      undefined,
      [
        helpNode('get', 'List cookies.', 'autobrowser cookies get'),
        helpNode('set', 'Set a cookie.', 'autobrowser cookies set <name> <value> [domain]'),
        helpNode('clear', 'Clear cookies.', 'autobrowser cookies clear'),
      ],
    ),
    helpNode(
      'storage',
      'Inspect or update storage.',
      'autobrowser storage <get|set|clear>',
      undefined,
      [
        helpNode('get', 'Read storage by key.', 'autobrowser storage get [key]'),
        helpNode('set', 'Write storage by key.', 'autobrowser storage set <key> <value>'),
        helpNode('clear', 'Clear storage.', 'autobrowser storage clear'),
      ],
    ),
    helpNode('console', 'Read console output.', 'autobrowser console'),
    helpNode('errors', 'Read page errors.', 'autobrowser errors'),
    helpNode(
      'set',
      'Adjust browser state.',
      'autobrowser set <viewport|offline|headers|geo|media>',
      undefined,
      [
        helpNode(
          'viewport',
          'Set viewport settings.',
          'autobrowser set viewport <width> <height> [deviceScaleFactor] [mobile]',
        ),
        helpNode('offline', 'Toggle offline mode.', 'autobrowser set offline [false]'),
        helpNode('headers', 'Set request headers.', 'autobrowser set headers <name:value,...>'),
        helpNode(
          'geo',
          'Set geolocation.',
          'autobrowser set geo <latitude> <longitude> [accuracy]',
        ),
        helpNode('media', 'Set media emulation.', 'autobrowser set media <scheme>'),
      ],
    ),
    helpNode('pdf', 'Export the current page as PDF.', 'autobrowser pdf'),
    helpNode(
      'clipboard',
      'Read or write clipboard contents.',
      'autobrowser clipboard <read|write>',
      undefined,
      [
        helpNode('read', 'Read the clipboard.', 'autobrowser clipboard read'),
        helpNode('write', 'Write to the clipboard.', 'autobrowser clipboard write [text]'),
      ],
    ),
    helpNode('state', 'Save or load browser state.', 'autobrowser state <save|load>', undefined, [
      helpNode('save', 'Save state.', 'autobrowser state save [name]'),
      helpNode(
        'load',
        'Load state from a name or JSON payload.',
        'autobrowser state load [name|json]',
      ),
    ]),
    helpNode(
      'network',
      'Inspect and control network activity.',
      'autobrowser network <route|unroute|requests|export|request|har>',
      undefined,
      [
        helpNode(
          'route',
          'Add a network route.',
          'autobrowser network route <url> [--abort] [--body <json>]',
          ['--abort', '--body <json>'],
        ),
        helpNode('unroute', 'Remove a network route.', 'autobrowser network unroute [url]'),
        helpNode(
          'requests',
          'List captured requests.',
          'autobrowser network requests [--filter <text>] [--type <xhr,fetch>] [--method <POST>] [--status <2xx>]',
          ['--filter <text>', '--type <xhr,fetch>', '--method <POST>', '--status <2xx>'],
        ),
        helpNode(
          'export',
          'Export captured request summaries as JSONL.',
          'autobrowser network export [output.jsonl] [--filter <text>] [--type <xhr,fetch>] [--method <POST>] [--status <2xx>]',
          ['--filter <text>', '--type <xhr,fetch>', '--method <POST>', '--status <2xx>'],
        ),
        helpNode('request', 'Inspect a single request.', 'autobrowser network request <requestId>'),
        helpNode(
          'har',
          'Record or stop HAR capture.',
          'autobrowser network har <start|stop>',
          undefined,
          [
            helpNode(
              'start',
              'Start HAR capture with configurable limits.',
              'autobrowser network har start [--har-max-requests <n>] [--har-max-body-bytes <n>] [--har-unlimited]',
              ['--har-max-requests <n>', '--har-max-body-bytes <n>', '--har-unlimited'],
            ),
            helpNode(
              'stop',
              'Stop HAR capture and save it.',
              'autobrowser network har stop [output.har]',
            ),
          ],
        ),
      ],
    ),
    helpNode(
      'screenshot',
      'Capture a screenshot.',
      'autobrowser screenshot [path] [--full] [--annotate] [--screenshot-dir <dir>] [--screenshot-format png|jpeg] [--screenshot-quality <n>]',
      [
        '--full',
        '--annotate',
        '--screenshot-dir <dir>',
        '--screenshot-format png|jpeg',
        '--screenshot-quality <n>',
      ],
    ),
    helpNode('snapshot', 'Capture or export a page snapshot.', 'autobrowser snapshot', undefined, [
      helpNode(
        'export',
        'Export the page snapshot as JSONL.',
        'autobrowser snapshot export [output.jsonl]',
      ),
      helpNode(
        'extract',
        'Extract field-oriented records from the snapshot as JSONL.',
        'autobrowser snapshot extract [output.jsonl] [--field <fieldPath>]...',
      ),
    ]),
  ],
)

const ROOT_HELP_FLAGS = [
  '--json        output JSON (default)',
  '--raw         output raw text',
  '--server URL  target server base URL, default http://127.0.0.1:57979',
  '--relay-port <port> relay server port',
  '--ipc-port <port> control server port',
  '--stdin       read command body from stdin',
  '--file PATH   read command body from file',
  '--base64      decode command body from base64',
  '--auto-connect proactively open the extension connect page when disconnected',
]

export function isHelpToken(value: string | undefined): boolean {
  return value === '--help' || value === '-h' || value === 'help'
}

function resolveHelpNode(
  node: HelpNode,
  pathParts: string[],
): { node: HelpNode; remainder: string[] } {
  let current = node
  let index = 0

  for (; index < pathParts.length; index += 1) {
    const next = current.children?.find((child) => child.name === pathParts[index])
    if (!next) {
      break
    }
    current = next
  }

  return {
    node: current,
    remainder: pathParts.slice(index),
  }
}

function renderHelp(node: HelpNode, isRoot = false): string {
  const lines: string[] = []
  const newline = '\n'

  lines.push(node.name)
  lines.push('')
  lines.push(node.summary)
  lines.push('')
  lines.push('Usage:')
  lines.push(`  ${node.usage}`)

  if (isRoot) {
    lines.push('')
    lines.push('Flags:')
    for (const flag of ROOT_HELP_FLAGS) {
      lines.push(`  ${flag}`)
    }
  }

  if (!isRoot && node.options && node.options.length > 0) {
    lines.push('')
    lines.push('Options:')
    for (const option of node.options) {
      lines.push(`  ${option}`)
    }
  }

  if (node.children && node.children.length > 0) {
    lines.push('')
    lines.push('Commands:')
    for (const child of node.children) {
      lines.push(`  ${child.name.padEnd(18)} ${child.summary}`)
      lines.push(`    ${child.usage}`)
    }
  }

  return `${lines.join(newline)}${newline}`
}

export function printHelp(pathParts: string[] = []): string {
  const { node, remainder } = resolveHelpNode(HELP_ROOT, pathParts)
  const rendered = renderHelp(node, node === HELP_ROOT)
  if (remainder.length === 0) {
    return rendered
  }

  return `${rendered}Unknown command path: ${remainder.join(' ')}\r\n`
}
