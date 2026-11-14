import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'
import type { DetachedProcessHandle } from '../src/cli/server-control.js'
import type { CliDependencies } from '../src/cli/types.js'
import type { BrowserLaunchConfig } from '../src/core/config.js'

/** CLI 发给 relay 的请求体结构：command + args。 */
export interface CliCommandBody {
  command?: string
  args?: Record<string, unknown>
  [key: string]: unknown
}

/** CLI 发出的 fetch 请求参数；body 是 JSON 字符串，没有请求体时为 undefined。 */
export interface CliFetchInit {
  method?: string
  headers?: Record<string, string | undefined>
  body?: string
}

/**
 * 测试里的 fetch 替身：CLI 只用到 ok/json()/text() 这几个成员。
 * 这些成员都设为可选，因为不同分支只读取其中一部分，替身不必实现全部成员
 * （例如解码失败的替身只需要 json()，而 CLI 在该分支上根本不看 ok）。
 */
export interface FetchResponseLike {
  ok?: boolean
  status?: number
  statusText?: string
  json?(): Promise<unknown>
  text?(): Promise<string>
}

export type FetchMock = (url: string, init: CliFetchInit) => Promise<FetchResponseLike>

export interface FetchCall {
  url: string
  init: CliFetchInit
  body: CliCommandBody | null
}

export interface SpawnCall {
  command: string
  args: string[]
}

export interface RunCliOptions {
  homeDir?: string
  fetchImpl?: FetchMock
  openUrl?: (url: string, browserConfig: BrowserLaunchConfig | null) => Promise<void>
  spawnDetachedProcess?: (
    command: string,
    args: string[],
  ) => DetachedProcessHandle | Promise<DetachedProcessHandle>
  findProcessIdByPort?: (port: number) => Promise<number | null>
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean
  /** 为 true 时不改写 AUTOBROWSER_WORKSPACE，用于验证默认 auto 或自定义环境变量 */
  preserveWorkspaceEnv?: boolean
}

export interface RunCliResult {
  exitCode: number | void
  fetchCalls: FetchCall[]
  spawnCalls: SpawnCall[]
  openCalls: string[]
  browserCalls: (BrowserLaunchConfig | null)[]
  stdout: string
  stderr: string
}

export const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)
let cliRunQueue: Promise<unknown> = Promise.resolve()

export interface CliErrorPayload {
  ok: false
  error: {
    message: string
    code: string
    retryable: boolean
    details?: unknown
    suggestedAction: string
  }
}

/**
 * CLI 失败统一走 JSON 契约（stdout 上的 {ok:false,error:{...}}），
 * 测试里从这里取错误消息，避免到处散落 JSON.parse。
 */
export function cliErrorPayload(stdout: string): CliErrorPayload {
  return JSON.parse(stdout) as CliErrorPayload
}

export function interceptStream(chunks: string[]): typeof process.stdout.write {
  return ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    chunks.push(String(chunk))
    if (typeof encoding === 'function') {
      encoding()
    }
    if (typeof callback === 'function') {
      callback()
    }
    return true
  }) as typeof process.stdout.write
}

export async function runCli(
  argv: string[],
  payload: unknown = { ok: true, result: { ok: true } },
  options: RunCliOptions = {},
): Promise<RunCliResult> {
  const run = cliRunQueue.then(async () => {
    const fetchCalls: FetchCall[] = []
    const spawnCalls: SpawnCall[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    const openCalls: string[] = []
    const browserCalls: (BrowserLaunchConfig | null)[] = []
    const previousAutobrowserHome = process.env.AUTOBROWSER_HOME
    const previousAutobrowserWorkspace = process.env.AUTOBROWSER_WORKSPACE
    const homeDir =
      options.homeDir || (await mkdtemp(path.join(os.tmpdir(), 'autobrowser-home-run-')))

    process.env.AUTOBROWSER_HOME = homeDir
    // CLI 默认启用 auto workspace；既有断言大多假设无 workspace，统一用 off 隔离。
    if (!options.preserveWorkspaceEnv) {
      process.env.AUTOBROWSER_WORKSPACE = 'off'
    }

    globalThis.fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      const requestInit = init as CliFetchInit
      const bodyText = requestInit.body ? String(requestInit.body) : ''
      fetchCalls.push({
        url: String(url),
        init: requestInit,
        body: bodyText ? (JSON.parse(bodyText) as CliCommandBody) : null,
      })

      if (options.fetchImpl) {
        return options.fetchImpl(String(url), requestInit)
      }

      return {
        ok: true,
        async json() {
          return payload
        },
        async text() {
          return `${JSON.stringify(payload)}\n`
        },
      }
    }) as typeof fetch

    process.stdout.write = interceptStream(stdout)
    process.stderr.write = interceptStream(stderr)

    const dependencies: CliDependencies = {}
    const openUrlImpl = options.openUrl
    const spawnImpl = options.spawnDetachedProcess

    // 默认就注入 openUrl 替身：CLI 测试绝不能真的拉起浏览器，否则 connect 页会开在
    // 开发者机器的真实浏览器里，标签页越跑越多。需要断言时用 options.openUrl 覆盖。
    dependencies.openUrl = async (url, browserConfig) => {
      openCalls.push(url)
      browserCalls.push(browserConfig)
      if (openUrlImpl) {
        await openUrlImpl(url, browserConfig)
      }
    }

    if (spawnImpl) {
      const spawnDetached = spawnImpl
      dependencies.spawnDetachedProcess = (command, args) => {
        const child = spawnDetached(command, args)
        spawnCalls.push({ command, args })
        return child
      }
    }

    dependencies.findProcessIdByPort = options.findProcessIdByPort
    dependencies.killProcess = options.killProcess

    try {
      const exitCode = await main(argv, dependencies)

      return {
        exitCode,
        fetchCalls,
        spawnCalls,
        openCalls,
        browserCalls,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      }
    } finally {
      globalThis.fetch = originalFetch
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite

      if (previousAutobrowserHome === undefined) {
        delete process.env.AUTOBROWSER_HOME
      } else {
        process.env.AUTOBROWSER_HOME = previousAutobrowserHome
      }

      if (previousAutobrowserWorkspace === undefined) {
        delete process.env.AUTOBROWSER_WORKSPACE
      } else {
        process.env.AUTOBROWSER_WORKSPACE = previousAutobrowserWorkspace
      }
    }
  })

  // 这些 CLI 测试会临时替换全局 fetch/stdout/stderr；串行化能避免全量并发执行时互相踩状态。
  cliRunQueue = run.catch(() => {})
  return await run
}
