# autobrowser

autobrowser is a Bun-based browser automation tool inspired by v-browser.

Detailed usage docs live in [`docs/README.md`](docs/README.md).

## Current status

This repository now contains a Bun implementation with the main automation flows in place:

- local relay server on port `57978`
- CLI API server on port `57979`
- browser extension scaffold with a token-based connection flow
- core commands for server and connection management, navigation, tab and window control, element interaction, dialogs, wait and state checks, cookies, storage, clipboard, browser state, network inspection and interception, snapshot, and screenshot

Run `bun run src/cli.ts help` to see the full command tree.

## Run

```bash
bun run src/cli.ts server
```

This starts the relay and IPC servers in the background. To stop them later:

```bash
bun run src/cli.ts server stop
```

Then open the connect page from another terminal:

```bash
bun run src/cli.ts connect
```

## Check State

Use `is` to inspect element state:

```bash
bun run src/cli.ts is visible <sel>
bun run src/cli.ts is enabled <sel>
bun run src/cli.ts is checked <sel>
```

The command also supports `disabled` and `focused`.

## Dialogs

Dialog commands support accept, dismiss, and status:

```bash
bun run src/cli.ts dialog accept [text]
bun run src/cli.ts dialog dismiss
bun run src/cli.ts dialog status
```

Alert and beforeunload dialogs are accepted automatically so they do not block automation. Confirm and prompt dialogs still require explicit handling.

## Wait

Wait for element state, text, URL, load state, JS condition, or time:

```bash
bun run src/cli.ts wait <selector>
bun run src/cli.ts wait <ms>
bun run src/cli.ts wait --text "Welcome"
bun run src/cli.ts wait --url "**/dash"
bun run src/cli.ts wait --load networkidle
bun run src/cli.ts wait --fn "window.ready === true"
bun run src/cli.ts wait "#spinner" --state hidden
```

## Extension

Build the unpacked extension first:

```bash
pnpm run build:chrome
```

Then load the `chrome/` folder as an unpacked extension in Chromium-based browsers. Run `autobrowser connect` to open the extension connect page if the CLI binary is installed globally; it will save the token and relay port automatically, and any `--extension-id`, `--browser-command`, or `--browser-arg` values you pass will be persisted in `~/.autobrowser/config.json` for later runs. If you are running the repository directly, use `bun run src/cli.ts connect` instead. The options page still works as a manual fallback and shows diagnostics.

## Network

The CLI also exposes network inspection and interception commands:

```bash
bun run src/cli.ts network route <url> [--abort] [--body <json>]
bun run src/cli.ts network unroute [url]
bun run src/cli.ts network requests [--filter api] [--type xhr,fetch] [--method POST] [--status 2xx]
bun run src/cli.ts network request <requestId>
bun run src/cli.ts network har start
bun run src/cli.ts network har stop [output.har]
```

## Screenshot

Take a screenshot and save it to a file. If no path is provided, the CLI writes into a temporary directory and prints the file path.

```bash
bun run src/cli.ts screenshot
bun run src/cli.ts screenshot ./shots/page.png --full
bun run src/cli.ts screenshot --annotate
bun run src/cli.ts screenshot --screenshot-dir ./shots --screenshot-format jpeg --screenshot-quality 80
```

`--full` captures the full page, `--annotate` adds numbered element labels, and `--screenshot-format` / `--screenshot-quality` control the encoded image output.

## Agent-friendly refs

`snapshot` now emits an `elements` list with stable refs such as `@e1`, `@e2`, and `@e3`, plus a `frames` list with refs like `@f1` for the current page view. Selector-based commands accept element refs anywhere a selector is expected, and `frame` accepts frame refs directly, so an agent can snapshot first and then act on handles instead of guessing CSS selectors.

```bash
bun run src/cli.ts snapshot
bun run src/cli.ts click @e2
bun run src/cli.ts fill @e5 "test@example.com"
bun run src/cli.ts get text @e3
bun run src/cli.ts wait @e7 --state hidden
bun run src/cli.ts frame @f1
```

Semantic find commands are also available for role, text, and label based lookup:

```bash
bun run src/cli.ts find role button click --name "Submit"
bun run src/cli.ts find text "Sign in" text --exact
bun run src/cli.ts find label "Email" fill "test@example.com"
```

Tabs now expose stable handles in `tab list`, and the CLI can switch or close them without relying on raw numeric ids:

```bash
bun run src/cli.ts tab list
bun run src/cli.ts tab select t2
bun run src/cli.ts tab close t3
```

If the page rerenders heavily or navigates, run `snapshot` again to refresh the refs before continuing.

## Tests

Run `bun test`.
