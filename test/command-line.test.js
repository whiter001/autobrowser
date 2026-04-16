import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { main } from '../src/cli.js'

const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)

function interceptStream(chunks) {
  return (chunk, encoding, callback) => {
    chunks.push(String(chunk))
    if (typeof encoding === 'function') {
      encoding()
    }
    if (typeof callback === 'function') {
      callback()
    }
    return true
  }
}

async function runCli(argv, payload = { ok: true, result: { ok: true } }) {
  const fetchCalls = []
  const stdout = []
  const stderr = []

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : null,
    })
    return {
      async json() {
        return payload
      },
    }
  }

  process.stdout.write = interceptStream(stdout)
  process.stderr.write = interceptStream(stderr)

  const exitCode = await main(argv)

  return {
    exitCode,
    fetchCalls,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
})

describe('cli command routing', () => {
  test('allows title reads without a selector', async () => {
    const result = await runCli(['get', 'title'], { ok: true, result: 'Example title' })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'get',
      args: { attr: 'title' },
    })
    expect(result.stdout).toContain('Example title')
  })

  test('still requires a selector for selector-based get commands', async () => {
    const result = await runCli(['get', 'text'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('missing selector')
  })

  test('passes full prompt text to dialog commands', async () => {
    const result = await runCli(['dialog', 'accept', 'hello', 'world'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        accept: true,
        promptText: 'hello world',
      },
    })
  })

  test('routes double clicks to the extension', async () => {
    const result = await runCli(['dblclick', '#submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dblclick',
      args: {
        selector: '#submit',
      },
    })
  })

  test('routes type commands to the extension', async () => {
    const result = await runCli(['type', '#editor', 'hello world'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'type',
      args: {
        selector: '#editor',
        value: 'hello world',
      },
    })
  })

  test('routes keyboard typing commands to the extension', async () => {
    const result = await runCli(['keyboard', 'type', 'abc'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'keyboard',
      args: {
        action: 'type',
        text: 'abc',
      },
    })
  })

  test('routes scroll into view commands to the extension', async () => {
    const result = await runCli(['scrollintoview', '#footer'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'scrollintoview',
      args: {
        selector: '#footer',
      },
    })
  })

  test('routes close all commands to the extension', async () => {
    const result = await runCli(['close', 'all'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'close',
      args: {
        all: true,
      },
    })
  })

  test('routes requests to the configured ipc port', async () => {
    const result = await runCli(['--ipc-port', '5001', 'status'], { ok: true, ready: true })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].url).toBe('http://127.0.0.1:5001/status')
  })

  test('routes network abort commands to the extension', async () => {
    const result = await runCli(['network', 'route', 'https://api.example.com', '--abort'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'route',
        url: 'https://api.example.com',
        abort: true,
      },
    })
  })

  test('routes network request filters to the extension', async () => {
    const result = await runCli([
      'network',
      'requests',
      '--filter',
      'api',
      '--type',
      'xhr,fetch',
      '--method',
      'POST',
      '--status',
      '2xx',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'requests',
        filter: 'api',
        type: 'xhr,fetch',
        method: 'POST',
        status: '2xx',
      },
    })
  })

  test('writes HAR output when stopping a recording', async () => {
    const payload = {
      ok: true,
      result: {
        har: {
          log: {
            version: '1.2',
            creator: { name: 'autobrowser', version: '0.1.0' },
            entries: [],
          },
        },
      },
    }
    const result = await runCli(['network', 'har', 'stop'], payload)

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)

    const outputPath = result.stdout.trim()
    expect(outputPath.length).toBeGreaterThan(0)

    const harContent = await readFile(outputPath, 'utf8')
    expect(harContent).toContain('"version": "1.2"')
    expect(harContent).toContain('"creator"')
  })

  test('saves state under the requested name', async () => {
    const result = await runCli(['state', 'save', 'checkout'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'save',
        name: 'checkout',
      },
    })
  })

  test('loads state by saved name when input is not json', async () => {
    const result = await runCli(['state', 'load', 'checkout'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'load',
        name: 'checkout',
      },
    })
  })

  test('loads state from inline json when provided', async () => {
    const result = await runCli(['state', 'load', '{"name":"checkout","storage":{"step":"2"}}'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
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
    })
  })
})
