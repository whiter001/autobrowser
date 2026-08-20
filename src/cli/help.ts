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
    helpNode(
      'mcp',
      'Expose core autobrowser commands as an MCP server over stdio (for Claude Desktop and other MCP clients).',
      'autobrowser mcp',
    ),
    helpNode('tab', 'Manage tabs.', 'autobrowser tab <list|new|select|close>', undefined, [
      helpNode(
        'list',
        'List tabs.',
        'autobrowser tab list [--active] [--current-window] [--filter <text>] [--page <n>] [--page-size <n>]',
      ),
      helpNode('new', 'Open a new tab.', 'autobrowser tab new [url]'),
      helpNode('select', 'Select a tab by handle.', 'autobrowser tab select <tN>'),
      helpNode(
        'close',
        'Close the current tab or a specific tab (use `close all` to close all tabs).',
        'autobrowser tab close [tN]',
      ),
    ]),
    helpNode(
      'target',
      'Inspect or change the persistent target tab.',
      'autobrowser target <show|set|active|clear>',
      undefined,
      [
        helpNode('show', 'Show the persistent target.', 'autobrowser target show'),
        helpNode('set', 'Set the target by stable handle.', 'autobrowser target set <tN>'),
        helpNode('active', 'Use the active browser tab as target.', 'autobrowser target active'),
        helpNode('clear', 'Clear the persistent target.', 'autobrowser target clear'),
      ],
    ),
    helpNode(
      'command',
      'Inspect or cancel extension commands.',
      'autobrowser command <list|status|cancel|reset>',
      undefined,
      [
        helpNode('list', 'List queued and running commands.', 'autobrowser command list'),
        helpNode(
          'status',
          'Show all commands or one command by id.',
          'autobrowser command status [id]',
        ),
        helpNode('cancel', 'Cancel a command by id.', 'autobrowser command cancel <id>'),
        helpNode('reset', 'Reset the target queue.', 'autobrowser command reset [--tab <tN>]'),
      ],
    ),
    helpNode(
      'open',
      'Navigate to a URL.',
      'autobrowser open <url> [--wait-until <mode>] [--settle-timeout <ms>] [--dom-quiet-ms <ms>]',
    ),
    helpNode(
      'goto',
      'Navigate to a URL.',
      'autobrowser goto <url> [--wait-until <mode>] [--settle-timeout <ms>] [--dom-quiet-ms <ms>]',
    ),
    helpNode(
      'close',
      'Close tabs in the current window (aliases: quit, exit).',
      'autobrowser close [all]',
      ['all  close every tab in the current window instead of just the target tab'],
    ),
    helpNode('back', 'Go back in browser history.', 'autobrowser back'),
    helpNode('forward', 'Go forward in browser history.', 'autobrowser forward'),
    helpNode(
      'reload',
      'Reload the current page.',
      'autobrowser reload [--wait-until <mode>] [--timeout-ms <ms>] [--wait-for url <pattern>|selector <sel>]',
    ),
    helpNode('window', 'Manage browser windows.', 'autobrowser window <new>', undefined, [
      helpNode('new', 'Open a new window.', 'autobrowser window new'),
    ]),
    helpNode(
      'eval',
      'Run a small page-context JavaScript snippet for read-only extraction or state checks.',
      'autobrowser eval [--stdin|--file <path>|--base64] [--timeout-ms <ms>] <script>',
      [
        '--stdin  read complex or multiline script source from stdin',
        '--file <path>  read complex or multiline script source from file',
        '--base64',
        '--timeout-ms <ms>  page evaluation timeout in milliseconds',
        'For complex interactions, split work into smaller browser commands or script steps.',
      ],
    ),
    helpNode(
      'script',
      'Manage init scripts injected before page scripts on every navigation.',
      'autobrowser script <add|list|remove>',
      undefined,
      [
        helpNode(
          'add',
          "Register an init script that runs after every navigation, before the page's own scripts; applies to all attached tabs, including tabs attached later.",
          'autobrowser script add [--stdin|--file <path>|--base64] <source>',
          ['--stdin', '--file <path>', '--base64'],
        ),
        helpNode(
          'list',
          'List registered init scripts with ids and source previews.',
          'autobrowser script list',
        ),
        helpNode(
          'remove',
          'Remove an init script by id, or remove all of them.',
          'autobrowser script remove <id|--all>',
        ),
      ],
    ),
    helpNode(
      'feed',
      'Collect structured cards from a virtual list or article feed.',
      'autobrowser feed [selector] [--selector <css>] [--limit <n>] [--dedupe url|text|none] [--max-scrolls <n>] [--pause-ms <n>] [--stall-rounds <n>]',
      [
        '--selector <css>',
        '--limit <n>',
        '--dedupe <url|text|none>',
        '--max-scrolls <n>',
        '--pause-ms <n>',
        '--stall-rounds <n>',
      ],
    ),
    helpNode('click', 'Click a selector.', 'autobrowser click <selector>'),
    helpNode('dblclick', 'Double-click a selector.', 'autobrowser dblclick <selector>'),
    helpNode('fill', 'Fill a selector with text.', 'autobrowser fill <selector> <value>'),
    helpNode(
      'fillform',
      'Fill multiple form fields in one call; individual failures do not stop the rest.',
      'autobrowser fillform [--stdin|--file <path>|--base64] <json-array|json-object>',
      ['--stdin', '--file <path>', '--base64'],
    ),
    helpNode(
      'find',
      'Find elements by role, text, label, or other attributes and optionally act on them.',
      'autobrowser find <role|text|label|placeholder|alt|title|test-id|exact-name> <query> [locate|click|fill|type|hover|focus|check|uncheck|text] [value]',
      ['--name <name>', '--exact', '--position <first|last|nth=N>', '--candidates <n>'],
    ),
    helpNode(
      'type',
      'Type text into a selector.',
      'autobrowser type <selector> <value> [--submit]',
      ['--submit  press Enter after typing to submit the form'],
    ),
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
    helpNode('drag', 'Drag between elements.', 'autobrowser drag <startSelector> <endSelector>'),
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
    helpNode(
      'dialog',
      'Handle dialogs.',
      'autobrowser dialog <accept|dismiss|status|auto>',
      undefined,
      [
        helpNode('accept', 'Accept the active dialog.', 'autobrowser dialog accept [promptText]'),
        helpNode(
          'dismiss',
          'Dismiss the active dialog.',
          'autobrowser dialog dismiss [promptText]',
        ),
        helpNode('status', 'Show dialog status.', 'autobrowser dialog status'),
        helpNode(
          'auto',
          'Query or toggle auto-accept of alert/beforeunload dialogs (runtime-only, defaults to on).',
          'autobrowser dialog auto [--on|--off]',
        ),
      ],
    ),
    helpNode(
      'downloads',
      'List tracked downloads or clear the download buffer.',
      'autobrowser downloads <list|clear>',
      ['--page-idx <n>', '--page-size <n>'],
      [
        helpNode(
          'list',
          'List tracked downloads with pagination (default subaction).',
          'autobrowser downloads list [--page-idx <n>] [--page-size <n>]',
          ['--page-idx <n>', '--page-size <n>'],
        ),
        helpNode('clear', 'Clear the tracked downloads buffer.', 'autobrowser downloads clear'),
      ],
    ),
    helpNode(
      'wait',
      'Wait for a selector state, text, URL, load state, function, or a fixed duration in milliseconds.',
      'autobrowser wait [selector|time <ms>|ms <ms>|--text <text> [--gone]|--url <pattern>|--load [networkidle]|--fn <expression>] [--state visible|hidden|stable|new] [--timeout <ms>]',
      [
        '--state <visible|hidden|stable|new>',
        '--timeout <ms> total timeout in milliseconds',
        '--text <text>',
        '--gone  wait for --text to disappear instead of appear',
        '--url <pattern>',
        '--load [networkidle]',
        '--fn <expression>',
        '--ms <ms> wait a fixed duration in milliseconds',
        'positional aliases: wait time|ms <ms>, wait url <pattern>, wait text <text>, wait load|networkidle, wait <ms>',
      ],
    ),
    helpNode(
      'cookies',
      'Inspect or update cookies.',
      'autobrowser cookies <list|get|set|clear|delete>',
      undefined,
      [
        helpNode(
          'list',
          'List cookies, optionally filtered by domain and path.',
          'autobrowser cookies list [--domain <domain>] [--path <path>]',
          ['alias of cookies get', '--domain <domain>', '--path <path>'],
        ),
        helpNode(
          'get',
          'List cookies, optionally filtered by domain and path.',
          'autobrowser cookies get [--domain <domain>] [--path <path>]',
          ['--domain <domain>', '--path <path>'],
        ),
        helpNode('set', 'Set a cookie.', 'autobrowser cookies set <name> <value> [domain]'),
        helpNode('clear', 'Clear cookies for the current site.', 'autobrowser cookies clear'),
        helpNode(
          'delete',
          'Delete a cookie by name for the current site.',
          'autobrowser cookies delete <name>',
        ),
      ],
    ),
    helpNode(
      'storage',
      'Inspect or update storage.',
      'autobrowser storage <get|set|clear|delete> [--session]',
      ['--session  operate on sessionStorage instead of localStorage'],
      [
        helpNode('get', 'Read storage by key.', 'autobrowser storage get [key] [--session]'),
        helpNode(
          'set',
          'Write storage by key.',
          'autobrowser storage set <key> <value> [--session]',
        ),
        helpNode('clear', 'Clear storage.', 'autobrowser storage clear [--session]'),
        helpNode('delete', 'Delete a storage key.', 'autobrowser storage delete <key> [--session]'),
      ],
    ),
    helpNode(
      'console',
      'Read console output.',
      'autobrowser console [clear] [--level error|warning|info|debug] [--page <n>] [--page-size <n>] [--since <timestamp>] [--all-epochs]',
      [
        '--level <error|warning|info|debug> each level includes more severe messages',
        '--page <n>',
        '--page-size <n>',
        '--since <timestamp>',
        '--all-epochs',
      ],
    ),
    helpNode(
      'errors',
      'Read page errors.',
      'autobrowser errors [clear] [--page <n>] [--page-size <n>] [--since <timestamp>] [--all-epochs]',
    ),
    helpNode(
      'set',
      'Adjust browser state.',
      'autobrowser set <viewport|offline|headers|geo|media|permission|ua|timezone|locale>',
      undefined,
      [
        helpNode(
          'viewport',
          'Set viewport settings.',
          'autobrowser set viewport [width] [height] [deviceScaleFactor] [mobile]',
        ),
        helpNode('offline', 'Toggle offline mode.', 'autobrowser set offline [false]'),
        helpNode('headers', 'Set request headers.', 'autobrowser set headers <name:value,...>'),
        helpNode(
          'geo',
          'Set geolocation.',
          'autobrowser set geo [latitude] [longitude] [accuracy]',
        ),
        helpNode(
          'media',
          'Set media emulation; omit the scheme to clear it.',
          'autobrowser set media [scheme]',
        ),
        helpNode(
          'permission',
          'Grant or reset a permission for the current tab origin.',
          'autobrowser set permission <name> [--reset]',
          ['--reset  remove the override and restore the default setting'],
        ),
        helpNode(
          'ua',
          'Override the user agent; empty value or --reset restores the default.',
          'autobrowser set ua <string|--reset>',
        ),
        helpNode(
          'timezone',
          'Override the timezone (IANA name); --reset restores the default.',
          'autobrowser set timezone <IANA-name|--reset>',
        ),
        helpNode(
          'locale',
          'Override the locale (BCP 47 tag); --reset restores the default.',
          'autobrowser set locale <tag|--reset>',
        ),
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
          'Add a network route, or list active routes.',
          'autobrowser network route <url> [--abort] [--body <json>] [--status <n>] [--content-type <mime>] [--header "Name: Value"]... [--remove-headers <a,b>]',
          [
            '--abort  fail matching requests',
            '--body <json>  mock the response body (default 200 + application/json)',
            '--status <n>  mock response status code (100-599, default 200)',
            '--content-type <mime>  mock response content-type (default application/json)',
            '--header "Name: Value"  add a response header to the mock (repeatable)',
            '--remove-headers <a,b>  strip request headers before continuing the request',
          ],
          [helpNode('list', 'List active network routes.', 'autobrowser network route list')],
        ),
        helpNode(
          'unroute',
          'Remove a network route; omit the url to remove all routes.',
          'autobrowser network unroute [url]',
        ),
        helpNode(
          'requests',
          'List captured requests.',
          'autobrowser network requests [--filter <text>] [--type <xhr,fetch>] [--method <POST>] [--status <2xx>] [--all-tabs] [--all-epochs] [--include-details]',
          [
            '--filter <text>',
            '--type <xhr,fetch>',
            '--method <POST>',
            '--status <2xx>',
            '--page <n>',
            '--page-size <n>',
            '--all-tabs',
            '--all-epochs',
            '--include-details',
          ],
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
          'autobrowser network har <start|stop|status|recover>',
          undefined,
          [
            helpNode(
              'start',
              'Start HAR capture with configurable limits.',
              'autobrowser network har start [--har-max-requests <n>] [--har-max-body-bytes <n>] [--har-unlimited]',
              ['--har-max-requests <n>', '--har-max-body-bytes <n>', '--har-unlimited'],
            ),
            helpNode(
              'status',
              'Show live and checkpoint HAR state.',
              'autobrowser network har status',
            ),
            helpNode(
              'recover',
              'Recover a HAR checkpoint and save it.',
              'autobrowser network har recover [output.har]',
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
      'autobrowser screenshot [path] [--element <selector|@eN>] [--full] [--annotate] [--screenshot-dir <dir>] [--screenshot-format png|jpeg] [--screenshot-quality <n>]',
      [
        '--element <selector|@eN>  capture only this element; an @eN ref positional also works, cannot be combined with --full',
        '--full',
        '--annotate',
        '--screenshot-dir <dir>',
        '--screenshot-format png|jpeg',
        '--screenshot-quality <n>',
      ],
    ),
    helpNode(
      'snapshot',
      'Capture or export a page snapshot.',
      'autobrowser snapshot [selector|--target <selector|@eN>] [--role <a,b,c>] [--changed]',
      [
        '--target <selector|@eN>  limit the snapshot to an element subtree',
        '--role <button,link,...>  only return elements with matching roles; @eN refs stay stable across snapshots',
        '--changed  only return elements added or changed since the last snapshot; first run returns the full snapshot with full:true',
      ],
      [
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
      ],
    ),
    helpNode(
      'search',
      'Search the page visible text and return matching lines with context.',
      'autobrowser search <query|/regex/flags> [--context <n>] [--limit <n>]',
      [
        '--context <n>  number of surrounding lines to include before and after each match (default 3)',
        '--limit <n>  maximum number of match windows to return (default 20)',
      ],
    ),
  ],
)

const ROOT_HELP_FLAGS = [
  '--json        output JSON (default)',
  '--raw         output raw text',
  '--server URL  target server base URL, default http://127.0.0.1:57979',
  '--relay-port <port> relay server port',
  '--ipc-port <port> control server port',
  '--tab <tN|id>  target a specific tab',
  '--frame <@fN|selector> target a specific frame',
  '--stdin       read command body from stdin',
  '--file PATH   read command body from file',
  '--base64      decode command body from base64',
  '--extension-id <id> browser extension id',
  '--browser-command <command> browser launch command',
  '--browser-arg <arg> browser launch argument',
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
