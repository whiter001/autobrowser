import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type BrowserLaunchConfig } from '../core/config.js'

const execFileAsync = promisify(execFile)

export function buildSystemOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }

  if (platform === 'win32') {
    return {
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }

  return { command: 'xdg-open', args: [url] }
}

/** Chrome/Edge 等基于 Chromium 的浏览器在 profile 被另一个实例占用时的 stderr 特征 */
const BROWSER_PROFILE_LOCK_PATTERN =
  /opening in existing browser session|profile(?: directory)? is already in use|user data directory is already in use|process singleton|already running/i

/**
 * 判断浏览器启动输出（stderr）是否表明该 profile 已被另一个运行中的实例占用。
 * 场景：server 被 SIGKILL 后旧浏览器仍持有 profile 锁，下次 connect --browser-command
 * 启动的新浏览器会秒退（exit 0）并输出这些特征，CLI 不能把这种情况当成成功。
 */
export function detectBrowserProfileLock(output: string): boolean {
  return BROWSER_PROFILE_LOCK_PATTERN.test(output)
}

/**
 * profile 被占用的可执行建议：提示关闭旧实例或改用隔离 profile。
 */
export class BrowserProfileLockError extends Error {
  constructor() {
    super(
      'The browser reported that its profile directory is already in use by another running ' +
        'browser instance. This usually means a previous autobrowser browser session is still open ' +
        '(for example, the autobrowser server was killed while the browser kept running).\n' +
        'Close the existing browser window, or launch this session with an isolated profile, e.g.:\n' +
        '  autobrowser connect --browser-arg=--user-data-dir=/tmp/autobrowser-profile',
    )
    this.name = 'BrowserProfileLockError'
  }
}

export async function openUrl(
  url: string,
  browserConfig: BrowserLaunchConfig | null,
): Promise<void> {
  if (browserConfig?.command) {
    let stderr = ''
    try {
      const result = await execFileAsync(browserConfig.command, [...browserConfig.args, url])
      stderr = result.stderr ?? ''
    } catch (error) {
      stderr = String((error as { stderr?: unknown })?.stderr ?? '')
      if (detectBrowserProfileLock(stderr)) {
        throw new BrowserProfileLockError()
      }
      throw error
    }

    // 浏览器秒退且 stderr 带 profile 锁特征时，execFile 仍会正常 resolve（exit 0），
    // 必须在这里拦截并给出可执行建议，否则 CLI 会静默把"没打开任何新浏览器"当成成功
    if (detectBrowserProfileLock(stderr)) {
      throw new BrowserProfileLockError()
    }
    return
  }

  const systemOpenCommand = buildSystemOpenCommand(process.platform, url)
  await execFileAsync(systemOpenCommand.command, systemOpenCommand.args)
}
