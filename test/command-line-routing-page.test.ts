import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

describe('cli command routing', () => {
  test('routes computed styles requests to the extension', async () => {
    const result = await runCli(['get', 'styles', '#panel'], {
      ok: true,
      result: {
        found: true,
        value: {
          display: 'block',
          width: '320px',
        },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'get',
      args: {
        selector: '#panel',
        attr: 'styles',
      },
    })
    expect(result.stdout).toContain('display')
    expect(result.stdout).toContain('width')
  })

  test('prints boolean state checks as primitive output', async () => {
    const result = await runCli(['is', 'visible', '#submit'], {
      ok: true,
      result: {
        found: true,
        state: 'visible',
        value: true,
      },
    })

    const isCall = result.fetchCalls.find((call) => call.body?.command === 'is')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(isCall?.body).toEqual({
      command: 'is',
      args: {
        selector: '#submit',
        state: 'visible',
      },
    })
    expect(result.stdout.trim()).toBe('true')
  })

  test('routes selector waits to the extension with visible state by default', async () => {
    const result = await runCli(['wait', '#spinner'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'selector',
        selector: '#spinner',
      },
    })
  })

  test('routes hidden selector waits to the extension', async () => {
    const result = await runCli(['wait', '#spinner', '--state', 'hidden'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'hidden',
        type: 'selector',
        selector: '#spinner',
      },
    })
  })

  test('routes text waits to the extension', async () => {
    const result = await runCli(['wait', '--text', 'Welcome'])
    const waitCall = result.fetchCalls.find((call) => call.body?.command === 'wait')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(waitCall?.body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'text',
        text: 'Welcome',
      },
    })
  })

  test('routes glob url waits to the extension', async () => {
    const result = await runCli(['wait', '--url', '**/dash'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'url',
        url: '**/dash',
      },
    })
  })

  test('routes load and fn waits to the extension', async () => {
    const loadResult = await runCli(['wait', '--load', 'networkidle'])

    expect(loadResult.exitCode).toBe(0)
    expect(loadResult.fetchCalls).toHaveLength(1)
    expect(loadResult.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'networkidle',
      },
    })

    const fnResult = await runCli(['wait', '--fn', 'window.ready === true'])

    expect(fnResult.exitCode).toBe(0)
    expect(fnResult.fetchCalls).toHaveLength(1)
    expect(fnResult.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'fn',
        fn: 'window.ready === true',
      },
    })
  })

  test('still requires a selector for selector-based get commands', async () => {
    const result = await runCli(['get', 'text'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('missing selector')
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

  test('routes dialog dismiss commands to the extension', async () => {
    const result = await runCli(['dialog', 'dismiss'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        accept: false,
        promptText: '',
      },
    })
  })

  test('routes dialog status commands to the extension', async () => {
    const result = await runCli(['dialog', 'status'], {
      ok: true,
      result: {
        open: false,
        type: null,
        message: null,
        defaultPrompt: null,
        url: null,
        openedAt: null,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        action: 'status',
      },
    })
    expect(result.stdout).toContain('open')
    expect(result.stdout).toContain('false')
  })

  test('routes screenshot options to the extension and writes the output file', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-test-'))
    const outputPath = path.join(outputDir, 'shot.jpeg')
    const screenshotBytes = Buffer.from('screenshot-bytes')

    const result = await runCli(
      [
        'screenshot',
        outputPath,
        '--full',
        '--annotate',
        '--screenshot-format',
        'jpeg',
        '--screenshot-quality',
        '80',
      ],
      {
        ok: true,
        result: {
          data: screenshotBytes.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: true,
        annotate: true,
        format: 'jpeg',
        quality: 80,
      },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        path: outputPath,
        mimeType: 'image/jpeg',
        format: 'jpeg',
        full: true,
        annotate: true,
      },
    })
    expect((await readFile(outputPath)).toString()).toBe('screenshot-bytes')
  })

  test('adds global tab and frame overrides to screenshot commands', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-frame-test-'))
    const outputPath = path.join(outputDir, 'shot.png')
    const screenshotBytes = Buffer.from('frame-screenshot-bytes')

    const result = await runCli(['screenshot', '--tab', 't2', '--frame', '@f4', outputPath], {
      ok: true,
      result: {
        data: screenshotBytes.toString('base64'),
        mimeType: 'image/png',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'png',
        tabId: 't2',
        frame: '@f4',
      },
    })
    expect((await readFile(outputPath)).toString()).toBe('frame-screenshot-bytes')
  })

  test('saves screenshots into the configured screenshot dir when no path is provided', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-dir-test-'))
    const screenshotBytes = Buffer.from('temp-screenshot')

    const result = await runCli(
      ['screenshot', '--screenshot-dir', outputDir, '--screenshot-format', 'jpeg'],
      {
        ok: true,
        result: {
          data: screenshotBytes.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
    )

    const savedPath = JSON.parse(result.stdout).result.path
    const screenshotCall = result.fetchCalls.find((call) => call.body?.command === 'screenshot')
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(screenshotCall?.body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'jpeg',
      },
    })
    expect(savedPath.startsWith(outputDir)).toBe(true)
    expect(savedPath.endsWith('.jpeg')).toBe(true)
    expect((await readFile(savedPath)).toString()).toBe('temp-screenshot')
  })

  test('saves screenshots to a temporary directory when no path is provided', async () => {
    const screenshotBytes = Buffer.from('auto-temp-screenshot')

    const result = await runCli(['screenshot'], {
      ok: true,
      result: {
        data: screenshotBytes.toString('base64'),
        mimeType: 'image/png',
      },
    })

    const savedPath = JSON.parse(result.stdout).result.path
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'png',
      },
    })
    expect(path.dirname(savedPath).startsWith(os.tmpdir())).toBe(true)
    expect(savedPath.includes('autobrowser-screenshot-')).toBe(true)
    expect((await readFile(savedPath)).toString()).toBe('auto-temp-screenshot')
  })

  test('routes double clicks to the extension', async () => {
    const result = await runCli(['dblclick', '#submit'])
    const doubleClickCall = result.fetchCalls.find((call) => call.body?.command === 'dblclick')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(doubleClickCall?.body).toEqual({
      command: 'dblclick',
      args: {
        selector: '#submit',
      },
    })
  })

  test('returns a non-zero exit code when the extension reports a failed command', async () => {
    const result = await runCli(['click', '#submit'], {
      ok: false,
      error: {
        message: 'click failed',
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'click',
      args: {
        selector: '#submit',
      },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: 'click failed',
      },
    })
    expect(result.stderr).toBe('')
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

  test('routes type --submit to the extension', async () => {
    const result = await runCli(['type', '#q', 'hello', '--submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'type',
      args: {
        selector: '#q',
        value: 'hello',
        submit: true,
      },
    })
  })

  test('routes element screenshots to the extension', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-element-test-'))
    const outputPath = path.join(outputDir, 'shot.png')
    const screenshotBytes = Buffer.from('element-screenshot')

    const result = await runCli(['screenshot', outputPath, '--element', '#card'], {
      ok: true,
      result: {
        data: screenshotBytes.toString('base64'),
        mimeType: 'image/png',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'png',
        element: '#card',
      },
    })
    expect((await readFile(outputPath)).toString()).toBe('element-screenshot')
  })

  test('rejects element screenshots combined with --full before calling the extension', async () => {
    const result = await runCli(['screenshot', '--element', '#card', '--full'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('cannot be combined')
  })

  test('routes text-gone waits to the extension', async () => {
    const result = await runCli(['wait', '--text', 'Loading', '--gone'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'text',
        text: 'Loading',
        gone: true,
      },
    })
  })

  test('routes snapshot subtree targets to the extension', async () => {
    const result = await runCli(['snapshot', '--target', '#panel'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        selector: '#panel',
        responseFormat: 'concise',
      },
    })
  })

  test('routes snapshot role filters and changed mode to the extension', async () => {
    const result = await runCli(['snapshot', '--role', 'button,link', '--changed'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        roles: ['button', 'link'],
        changed: true,
        responseFormat: 'concise',
      },
    })
  })

  test('routes semantic role finds to the extension', async () => {
    const result = await runCli(['find', 'role', 'button', 'click', '--name', 'Submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        name: 'Submit',
        exact: false,
        action: 'click',
      },
    })
  })

  test('routes semantic text finds with exact matching to the extension', async () => {
    const result = await runCli(['find', 'text', 'Sign in', 'text', '--exact'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'text',
        query: 'Sign in',
        exact: true,
        action: 'text',
      },
    })
  })

  test('routes semantic label fills to the extension', async () => {
    const result = await runCli(['find', 'label', 'Email', 'fill', 'test@example.com'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'label',
        query: 'Email',
        exact: false,
        action: 'fill',
        value: 'test@example.com',
      },
    })
  })

  test('routes find candidates mode to the extension', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'text',
        query: 'Save',
        exact: false,
        candidates: 3,
      },
    })
  })

  test('routes find position selection to the extension', async () => {
    const result = await runCli(['find', 'role', 'button', '--position', 'last'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        exact: false,
        position: 'last',
      },
    })
  })

  test('rejects find candidates combined with position', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3', '--position', 'last'])
    expect(result.exitCode).toBe(1)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      '--candidates cannot be combined with --position',
    )
  })

  test('rejects find candidates with a non-locate action', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3', 'click'])
    expect(result.exitCode).toBe(1)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      '--candidates only supports the locate action',
    )
  })

  test('adds global tab and frame overrides to selector commands', async () => {
    const result = await runCli(['click', '--tab', 't2', '--frame', '@f1', '@e3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'click',
      args: {
        selector: '@e3',
        tabId: 't2',
        frame: '@f1',
      },
    })
  })

  test('adds global tab and frame overrides to semantic find commands', async () => {
    const result = await runCli([
      'find',
      'role',
      'button',
      'click',
      '--name',
      'Submit',
      '--tab',
      't3',
      '--frame',
      '@f2',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        name: 'Submit',
        exact: false,
        action: 'click',
        tabId: 't3',
        frame: '@f2',
      },
    })
  })

  test('routes search queries to the extension', async () => {
    const result = await runCli(['search', 'Sign in'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: 'Sign in',
        context: 3,
        limit: 10,
        responseFormat: 'concise',
      },
    })
  })

  test('routes search regex queries with context and limit options', async () => {
    const result = await runCli(['search', '/foo/i', '--context', '5', '--limit', '2'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: '/foo/i',
        context: 5,
        limit: 2,
        responseFormat: 'concise',
      },
    })
  })

  test('adds global tab and frame overrides to search commands', async () => {
    const result = await runCli(['search', '--tab', 't2', '--frame', '@f1', 'Sign in'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: 'Sign in',
        context: 3,
        limit: 10,
        responseFormat: 'concise',
        tabId: 't2',
        frame: '@f1',
      },
    })
  })

  test('rejects invalid search invocations', async () => {
    const missingQuery = await runCli(['search'])
    expect(missingQuery.exitCode).toBe(1)
    expect(cliErrorPayload(missingQuery.stdout).error.message).toContain('missing search query')
    expect(missingQuery.fetchCalls).toHaveLength(0)

    const badRegex = await runCli(['search', '/foo[/'])
    expect(badRegex.exitCode).toBe(1)
    expect(cliErrorPayload(badRegex.stdout).error.message).toContain('invalid search regex')
    expect(badRegex.fetchCalls).toHaveLength(0)

    const badOption = await runCli(['search', 'x', '--bogus'])
    expect(badOption.exitCode).toBe(1)
    expect(cliErrorPayload(badOption.stdout).error.message).toContain(
      'unsupported search option: --bogus',
    )
    expect(badOption.fetchCalls).toHaveLength(0)

    const extraArg = await runCli(['search', 'x', 'extra'])
    expect(extraArg.exitCode).toBe(1)
    expect(cliErrorPayload(extraArg.stdout).error.message).toContain(
      'unexpected extra search argument: extra',
    )
    expect(extraArg.fetchCalls).toHaveLength(0)
  })

  test('adds global tab overrides without leaking frame overrides to frame selection', async () => {
    const result = await runCli(['frame', '--tab', 't4', '@f3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.some((call) => call.body?.command === 'frame')).toBe(true)
    expect(result.fetchCalls.find((call) => call.body?.command === 'frame')?.body).toEqual({
      command: 'frame',
      args: {
        selector: '@f3',
        tabId: 't4',
      },
    })
  })

  test('adds global tab and frame overrides to upload commands', async () => {
    const result = await runCli([
      'upload',
      '--tab',
      't5',
      '--frame',
      '@f6',
      '#avatar',
      'avatar.png',
      'avatar@2x.png',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'upload',
      args: {
        selector: '#avatar',
        files: ['avatar.png', 'avatar@2x.png'],
        tabId: 't5',
        frame: '@f6',
      },
    })
  })

  test('adds global tab and frame overrides to storage commands', async () => {
    const result = await runCli([
      'storage',
      'set',
      '--tab',
      't6',
      '--frame',
      '@f7',
      'draft',
      'ready',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: {
        action: 'set',
        key: 'draft',
        value: 'ready',
        tabId: 't6',
        frame: '@f7',
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

  test('routes stable frame refs to the extension', async () => {
    const result = await runCli(['frame', '@f1'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'frame',
      args: {
        selector: '@f1',
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
})
