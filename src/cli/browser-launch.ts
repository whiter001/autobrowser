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

/**
 * 是否禁止真的拉起浏览器。
 *
 * CLI 测试经常以子进程方式运行（那时没法注入 openUrl 替身），一旦漏掉就会把 connect 页
 * 开在开发者机器的真实浏览器里，标签页越跑越多。NODE_ENV=test 是测试进程的标准约定，
 * 这里直接不启动浏览器；需要真实浏览器的显式场景用 AUTOBROWSER_DISABLE_BROWSER=0 覆盖。
 */
function isBrowserLaunchDisabled(): boolean {
  const override = process.env.AUTOBROWSER_DISABLE_BROWSER
  if (override !== undefined) {
    return override !== '0'
  }
  return process.env.NODE_ENV === 'test'
}

export async function openUrl(
  url: string,
  browserConfig: BrowserLaunchConfig | null,
): Promise<void> {
  // chrome-extension:// 没有任何系统级协议关联：交给 rundll32/open/xdg-open 只会弹出
  // "没有可打开此链接的应用"（Windows 还会诱导去 Microsoft Store）。
  // 这里直接失败并给出可执行建议，把错误留在 CLI 里而不是系统弹窗里。
  // 校验放在启动闸门之前，测试环境也要保留同一个结论。
  if (!browserConfig?.command && /^chrome-extension:\/\//i.test(url)) {
    throw new Error(
      'cannot open a chrome-extension:// URL without an explicit browser: ' +
        'no OS associates this scheme.\n' +
        'Pass one explicitly (the value is remembered in ~/.autobrowser/config.json):\n' +
        '  autobrowser connect --browser-command "<path to msedge.exe or chrome.exe>"',
    )
  }

  if (isBrowserLaunchDisabled()) {
    return
  }

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
