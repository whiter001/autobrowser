import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../client.js'
import { parseOptionalNumberArg } from '../parse.js'
import {
  createActionCommand,
  parseOrWriteError,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import { COMMAND_ACTIONS } from './actions.js'
import type { CommandContext, CommandRegistry } from './types.js'

async function resolveTracePath(outputPath: string | null): Promise<string> {
  if (outputPath) return outputPath
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-tracing-'))
  return path.join(directory, `trace-${Date.now()}.json`)
}

async function handleTracing(rest: string[], context: CommandContext): Promise<number | void> {
  // switch 分支集合就是 tracing 的实现面，测试会拿它和 action 表核对。
  const tracingAction = rest[0]
  switch (tracingAction) {
    case 'start':
    case 'status': {
      if (rest.length > 1)
        return writeCommandError(`unexpected argument for tracing ${tracingAction}: ${rest[1]}`)
      await requestAndWrite(context, 'tracing', { action: tracingAction })
      return 0
    }
    case 'stop': {
      if (rest.length > 2)
        return writeCommandError(`unexpected extra argument for tracing stop: ${rest[2]}`)
      const payload = await context.requestCommand(context.flags.server, 'tracing', {
        action: tracingAction,
      })
      if (payload.ok === false) {
        context.writeResult(payload)
        return 1
      }
      if (!isRecord(payload.result) || typeof payload.result.data !== 'string')
        return writeCommandError('tracing stop returned no trace data')
      const { data, ...summary } = payload.result
      const outputPath = await resolveTracePath(rest[1] || null)
      await writeFile(outputPath, data, summary.base64Encoded === true ? 'base64' : 'utf8')
      context.writeResult({ ...payload, result: { ...summary, path: outputPath } })
      return 0
    }
    default:
      return writeCommandError(`unsupported tracing action: ${tracingAction || '(empty)'}`)
  }
}

function readVideoOptions(rest: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index]!
    if (!allowed.includes(name)) throw new Error(`unsupported video option: ${name}`)
    const value = rest[++index]
    if (value === undefined) throw new Error(`missing value for ${name}`)
    options[name] = value
  }
  return options
}

async function resolveVideoPath(outputPath: string | null): Promise<string> {
  if (outputPath) return outputPath
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-video-'))
  return path.join(directory, `video-${Date.now()}.webm`)
}

async function handleVideo(rest: string[], context: CommandContext): Promise<number | void> {
  // switch 分支集合就是 video 的实现面，测试会拿它和 action 表核对。
  const videoAction = rest[0]
  switch (videoAction) {
    case 'status': {
      await requestAndWrite(context, 'video', { action: videoAction })
      return 0
    }
    case 'start': {
      const options = parseOrWriteError(() =>
        readVideoOptions(rest.slice(1), ['--max-duration-ms']),
      )
      if (!options) return 1
      await requestAndWrite(context, 'video', {
        action: videoAction,
        ...(options['--max-duration-ms']
          ? { maxDurationMs: Number(options['--max-duration-ms']) }
          : {}),
      })
      return 0
    }
    case 'chapter': {
      const title = rest[1]
      if (!title) return writeCommandError('missing title for video chapter')
      const options = parseOrWriteError(() =>
        readVideoOptions(rest.slice(2), ['--description', '--duration']),
      )
      if (!options) return 1
      await requestAndWrite(context, 'video', {
        action: videoAction,
        title,
        ...(options['--description'] ? { description: options['--description'] } : {}),
        ...(options['--duration']
          ? {
              durationMs: parseOptionalNumberArg(options['--duration'], 'chapter duration', 0, {
                min: 0,
                integer: true,
              }),
            }
          : {}),
      })
      return 0
    }
    case 'show-actions': {
      const options = parseOrWriteError(() =>
        readVideoOptions(rest.slice(1), ['--duration', '--position', '--highlight-style']),
      )
      if (!options) return 1
      await requestAndWrite(context, 'video', {
        action: videoAction,
        ...(options['--duration']
          ? {
              durationMs: parseOptionalNumberArg(options['--duration'], 'callout duration', 600, {
                min: 1,
                integer: true,
              }),
            }
          : {}),
        ...(options['--position'] ? { position: options['--position'] } : {}),
        ...(options['--highlight-style'] ? { highlightStyle: options['--highlight-style'] } : {}),
      })
      return 0
    }
    case 'hide-actions': {
      await requestAndWrite(context, 'video', { action: videoAction })
      return 0
    }
    case 'stop': {
      if (rest.length > 2)
        return writeCommandError(`unexpected extra argument for video stop: ${rest[2]}`)
      const payload = await context.requestCommand(context.flags.server, 'video', {
        action: videoAction,
      })
      if (payload.ok === false) {
        context.writeResult(payload)
        return 1
      }
      if (!isRecord(payload.result) || typeof payload.result.data !== 'string')
        return writeCommandError('video stop returned no video data')
      const { data, ...summary } = payload.result
      const outputPath = await resolveVideoPath(rest[1] || null)
      await writeFile(outputPath, data, 'base64')
      let chaptersPath: string | undefined
      if (Array.isArray(summary.chapters) && summary.chapters.length) {
        chaptersPath = outputPath.replace(/\.webm$/i, '') + '.chapters.json'
        await writeFile(chaptersPath, `${JSON.stringify(summary.chapters, null, 2)}\n`)
      }
      context.writeResult({ ...payload, result: { ...summary, path: outputPath, chaptersPath } })
      return 0
    }
    default:
      return writeCommandError(`unsupported video action: ${videoAction || '(empty)'}`)
  }
}

const handleActions = createActionCommand({
  helpPath: ['actions'],
  allowed: COMMAND_ACTIONS.actions.actions,
  handle: async (rest, context, action) => {
    if (rest.length)
      return writeCommandError(`unexpected argument for actions ${action}: ${rest[0]}`)
    await requestAndWrite(context, 'actions', { action })
    return 0
  },
})

export const diagnosticsCommandRegistry: CommandRegistry = {
  tracing: handleTracing,
  video: handleVideo,
  actions: handleActions,
}
