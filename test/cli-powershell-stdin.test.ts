import { expect, test } from 'bun:test'
import path from 'node:path'

const PROCESS_TIMEOUT_MS = 10_000
const subprocessEnv = {
  ...process.env,
  AUTOBROWSER_HOME: path.join(import.meta.dir, `.autobrowser-stdin-${crypto.randomUUID()}`),
  AUTOBROWSER_WORKSPACE: 'off',
  NO_PROXY: '127.0.0.1',
}

async function runProcess(argv: string[], describeStage: () => string) {
  const child = Bun.spawn(argv, {
    env: subprocessEnv,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const output = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${PROCESS_TIMEOUT_MS} ms 超时：${describeStage()}`))
      }, PROCESS_TIMEOUT_MS)
    })
    return await Promise.race([output, deadline])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      // Windows 上只结束 PowerShell 不会结束仍在等待 stdin 的 launcher 和 Bun。
      try {
        const kill = Bun.spawnSync(['taskkill.exe', '/PID', `${child.pid}`, '/T', '/F'], {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3_000,
        })
        if (!kill.success && child.exitCode === null && child.signalCode === null) {
          console.error(`无法清理子进程树 (PID ${child.pid})：${kill.stderr.toString()}`)
          child.kill()
        }
        await child.exited
      } catch (error) {
        // 清理异常只作为补充诊断，不覆盖原始错误。
        console.error(`清理子进程 (PID ${child.pid}) 时出错：`, error)
        try {
          child.kill()
          await child.exited
        } catch (fallbackError) {
          console.error(`无法结束子进程 (PID ${child.pid})：`, fallbackError)
        }
      }
    }
  }
}

const shells = ['powershell.exe', 'pwsh.exe'].map((name) => ({
  name,
  executable: process.platform === 'win32' ? Bun.which(name) : null,
}))
const launcher = shells.some(({ executable }) => executable) ? Bun.which('autobrowser.exe') : null
// PATH 中的 launcher 可能残留，但它引用的 Bun 或构建产物已移走；只跳过已知的安装缺失。
const missingInstall = launcher
  ? await runProcess([launcher, 'version'], () => '探测已安装的 autobrowser.exe').then(
      ([code, , stderr]) =>
        code !== 0 &&
        /^\[autobrowser\] cannot find (?:Bun \(|dist\/autobrowser\.js \()/m.test(stderr),
    )
  : true

const script = [
  'const name = await Promise.resolve("世界")',
  'const count = await Promise.resolve(2)',
  'return `你好，${name}！${count + 1}`',
].join('\n')
const reply = { ok: true, result: { value: '你好，世界！3' } }

for (const { name, executable } of shells) {
  test.skipIf(!executable || missingInstall)(
    `${name} here-string reaches installed autobrowser.exe eval --stdin`,
    async () => {
      const requests: { command?: string; args?: { script?: string } }[] = []
      let received = false
      let replied = false
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          if (request.method !== 'POST' || new URL(request.url).pathname !== '/command') {
            return new Response(null, { status: 404 })
          }
          received = true
          requests.push(await request.json())
          replied = true
          return Response.json(reply)
        },
      })
      const describeStage = () =>
        replied
          ? 'mock relay 已收到 eval 请求并生成响应；检查响应处理或子进程退出'
          : received
            ? 'mock relay 已收到请求头，但请求体尚未解析完成'
            : 'mock relay 未收到 /command；检查 PowerShell/launcher 的 stdin 及请求发出前的阶段'
      try {
        // 用 UTF-16LE 只传 PowerShell 命令；eval 源码仍由 here-string 经原生管道送入 stdin。
        const command = [
          "$ErrorActionPreference = 'Stop'",
          "$ProgressPreference = 'SilentlyContinue'",
          '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
          "@'",
          script,
          `'@ | & '${launcher!.replaceAll("'", "''")}' --server http://127.0.0.1:${server.port} eval --stdin`,
          'exit $LASTEXITCODE',
        ].join('\n')
        const [exitCode, stdout, stderr] = await runProcess(
          [
            executable!,
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(command, 'utf16le').toString('base64'),
          ],
          describeStage,
        )
        if (exitCode !== 0 || !replied) {
          throw new Error(
            `${describeStage()} (exit ${exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`,
          )
        }
        expect(requests).toHaveLength(1)
        expect(requests[0]?.command).toBe('eval')
        // PowerShell 为管道对象追加一个行结束符；保留对其余空白与字符的完整比较。
        expect(requests[0]?.args?.script?.replaceAll('\r\n', '\n')).toBe(`${script}\n`)
        expect(JSON.parse(stdout)).toEqual(reply)
        expect(stderr).toBe('')
      } finally {
        server.stop(true)
      }
    },
    PROCESS_TIMEOUT_MS + 5_000,
  )
}
