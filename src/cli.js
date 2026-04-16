import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_IPC_PORT, DEFAULT_RELAY_PORT } from "./core/protocol.js";
import { startServers } from "./server.js";

const execFileAsync = promisify(execFile);

function parseCli(argv) {
  // 这里只做轻量解析，保持 CLI 启动快且依赖最少。
  const flags = {
    json: false,
    server: `http://127.0.0.1:${DEFAULT_IPC_PORT}`,
    relayPort: DEFAULT_RELAY_PORT,
    ipcPort: DEFAULT_IPC_PORT,
    stdin: false,
    file: null,
    base64: false,
  };

  const args = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      flags.json = true;
      continue;
    }

    if (value === "--stdin") {
      flags.stdin = true;
      continue;
    }

    if (value === "--base64") {
      flags.base64 = true;
      continue;
    }

    if (value === "--file") {
      flags.file = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (value === "--server") {
      flags.server = argv[index + 1] || flags.server;
      index += 1;
      continue;
    }

    if (value === "--relay-port") {
      flags.relayPort = Number(argv[index + 1] || flags.relayPort);
      index += 1;
      continue;
    }

    if (value === "--ipc-port") {
      flags.ipcPort = Number(argv[index + 1] || flags.ipcPort);
      index += 1;
      continue;
    }

    args.push(value);
  }

  return { flags, args };
}

function printHelp() {
  return `autobrowser

Usage:
  autobrowser server
  autobrowser status
  autobrowser connect
  autobrowser tab list
  autobrowser tab new <url>
  autobrowser goto <url>
  autobrowser open <url>
  autobrowser eval [--stdin|--file path|--base64] <script>
  autobrowser click <selector>
  autobrowser fill <selector> <value>
  autobrowser screenshot
  autobrowser snapshot

Flags:
  --json        output JSON
  --server URL  target server base URL, default http://127.0.0.1:47979
  --stdin       read command body from stdin
  --file PATH   read command body from file
  --base64      decode command body from base64
`;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let content = "";
  for await (const chunk of process.stdin) {
    content += chunk;
  }

  return content;
}

async function openUrl(url) {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }

  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  await execFileAsync("xdg-open", [url]);
}

async function requestCommand(baseUrl, command, args = {}) {
  const response = await fetch(`${baseUrl}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ command, args }),
  });

  return await response.json();
}

async function getStatus(baseUrl) {
  const response = await fetch(`${baseUrl}/status`);
  return await response.json();
}

async function resolveEvalScript(flags, rest) {
  if (flags.file) {
    return await readFile(flags.file, "utf8");
  }

  if (flags.base64) {
    const raw = rest.join(" ").trim();
    return Buffer.from(raw, "base64").toString("utf8");
  }

  if (flags.stdin) {
    return await readStdin();
  }

  if (rest.length > 0) {
    return rest.join(" ");
  }

  return await readStdin();
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, args } = parseCli(argv);
  const [command, ...rest] = args;

  function writeResult(payload) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    if (payload?.ok === false) {
      process.stderr.write(`${payload.error?.message || "command failed"}\n`);
      process.exitCode = 1;
      return;
    }

    const result = payload?.result ?? payload;
    if (typeof result === "string") {
      process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(printHelp());
    return 0;
  }

  if (command === "server") {
    const servers = await startServers({ relayPort: flags.relayPort, ipcPort: flags.ipcPort });
    process.stdout.write(
      `autobrowser server started\nrelay: http://127.0.0.1:${servers.runtime.runtime.relayPort}\nipc: http://127.0.0.1:${servers.runtime.runtime.ipcPort}\n`,
    );

    const shutdown = async () => {
      await servers.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise(() => {});
  }

  if (command === "connect") {
    await openUrl(`http://127.0.0.1:${flags.relayPort}/connect`);
    return 0;
  }

  if (command === "status") {
    const status = await getStatus(flags.server);
    writeResult(status);
    return 0;
  }

  if (command === "tab") {
    const [subcommand, ...tabArgs] = rest;
    if (subcommand === "list") {
      const payload = await requestCommand(flags.server, "tab.list", {});
      writeResult(payload);
      return 0;
    }

    if (subcommand === "new") {
      const url = tabArgs[0] || "about:blank";
      const payload = await requestCommand(flags.server, "tab.new", { url });
      writeResult(payload);
      return 0;
    }
  }

  if (command === "open" || command === "goto") {
    const url = rest[0];
    if (!url) {
      process.stderr.write("missing url\n");
      return 1;
    }

    const payload = await requestCommand(flags.server, "goto", { url });
    writeResult(payload);
    return 0;
  }

  if (command === "eval") {
    const script = await resolveEvalScript(flags, rest);
    const payload = await requestCommand(flags.server, "eval", { script });
    writeResult(payload);
    return 0;
  }

  if (command === "click") {
    const selector = rest[0];
    if (!selector) {
      process.stderr.write("missing selector\n");
      return 1;
    }

    const payload = await requestCommand(flags.server, "click", { selector });
    writeResult(payload);
    return 0;
  }

  if (command === "fill") {
    const selector = rest[0];
    const value = rest.slice(1).join(" ");
    if (!selector) {
      process.stderr.write("missing selector\n");
      return 1;
    }

    const payload = await requestCommand(flags.server, "fill", { selector, value });
    writeResult(payload);
    return 0;
  }

  if (command === "snapshot" || command === "screenshot") {
    const payload = await requestCommand(flags.server, command, {});
    writeResult(payload);
    return 0;
  }

  process.stderr.write(`${printHelp()}\n`);
  return 1;
}

if (import.meta.main) {
  main().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  });
}
