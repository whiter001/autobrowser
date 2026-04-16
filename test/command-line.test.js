import { describe, expect, test } from "bun:test";

function parseCli(argv) {
  const flags = {
    json: false,
    server: "http://127.0.0.1:47979",
    relayPort: 47978,
    ipcPort: 47979,
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

describe("cli parsing", () => {
  test("keeps positional args after flags", () => {
    const result = parseCli(["--json", "tab", "list"]);
    expect(result.flags.json).toBe(true);
    expect(result.args).toEqual(["tab", "list"]);
  });

  test("reads file flag with path", () => {
    const result = parseCli(["eval", "--file", "/tmp/a.js"]);
    expect(result.args).toEqual(["eval"]);
    expect(result.flags.file).toBe("/tmp/a.js");
  });

  test("parses ports", () => {
    const result = parseCli(["--relay-port", "5000", "--ipc-port", "5001", "status"]);
    expect(result.flags.relayPort).toBe(5000);
    expect(result.flags.ipcPort).toBe(5001);
    expect(result.args).toEqual(["status"]);
  });
});
