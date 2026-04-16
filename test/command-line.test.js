import { afterEach, describe, expect, test } from 'bun:test';
import { main } from '../src/cli.js';

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function interceptStream(chunks) {
  return (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  };
}

async function runCli(argv, payload = { ok: true, result: { ok: true } }) {
  const fetchCalls = [];
  const stdout = [];
  const stderr = [];

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : null,
    });
    return {
      async json() {
        return payload;
      },
    };
  };

  process.stdout.write = interceptStream(stdout);
  process.stderr.write = interceptStream(stderr);

  const exitCode = await main(argv);

  return {
    exitCode,
    fetchCalls,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

describe('cli command routing', () => {
  test('allows title reads without a selector', async () => {
    const result = await runCli(['get', 'title'], { ok: true, result: 'Example title' });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].body).toEqual({
      command: 'get',
      args: { attr: 'title' },
    });
    expect(result.stdout).toContain('Example title');
  });

  test('still requires a selector for selector-based get commands', async () => {
    const result = await runCli(['get', 'text']);

    expect(result.exitCode).toBe(1);
    expect(result.fetchCalls).toHaveLength(0);
    expect(result.stderr).toContain('missing selector');
  });

  test('passes full prompt text to dialog commands', async () => {
    const result = await runCli(['dialog', 'accept', 'hello', 'world']);

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        accept: true,
        promptText: 'hello world',
      },
    });
  });

  test('routes requests to the configured ipc port', async () => {
    const result = await runCli(['--ipc-port', '5001', 'status'], { ok: true, ready: true });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].url).toBe('http://127.0.0.1:5001/status');
  });

  test('saves state under the requested name', async () => {
    const result = await runCli(['state', 'save', 'checkout']);

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'save',
        name: 'checkout',
      },
    });
  });

  test('loads state by saved name when input is not json', async () => {
    const result = await runCli(['state', 'load', 'checkout']);

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'load',
        name: 'checkout',
      },
    });
  });

  test('loads state from inline json when provided', async () => {
    const result = await runCli(['state', 'load', '{"name":"checkout","storage":{"step":"2"}}']);

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'load',
        data: {
          name: 'checkout',
          storage: {
            step: '2',
          },
        },
      },
    });
  });
});
