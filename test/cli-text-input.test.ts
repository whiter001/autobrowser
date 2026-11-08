import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stripBom } from '../src/core/text.js'
import { runCli } from './command-line-test-utils.js'

/**
 * Windows PowerShell 5 写出的文件默认带 UTF-8 BOM，而 JSON.parse 不接受 U+FEFF。
 * 报错信息里的 BOM 字符本身不可见，用户很难判断是自己的 JSON 写错了还是编码问题，
 * 所以命令体输入统一在读取入口剥掉 BOM。
 */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

async function writeWithBom(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')]))
}

describe('stripBom', () => {
  test('去掉开头的 BOM，其余内容原样保留', () => {
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}')
    expect(stripBom('\uFEFF\uFEFFx')).toBe('x')
    expect(stripBom('{"a":1}')).toBe('{"a":1}')
    // 只有开头是 BOM，中间的 U+FEFF 是正文字符，不能动
    expect(stripBom('a\uFEFFb')).toBe('a\uFEFFb')
    expect(stripBom('')).toBe('')
  })
})

describe('命令体读取入口', () => {
  test('fillform 读取带 BOM 的文件不会解析失败', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-bom-'))
    const file = path.join(dir, 'fields.json')
    await writeWithBom(file, '[{"selector":"#a","value":"1"}]')
    try {
      const result = await runCli(['fillform', '--file', file])

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls).toHaveLength(1)
      expect(result.fetchCalls[0]!.body?.args?.fields).toEqual([{ selector: '#a', value: '1' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('batch 读取带 BOM 的文件不会解析失败', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-bom-'))
    const file = path.join(dir, 'steps.json')
    await writeWithBom(file, '[{"command":"eval","args":{"script":"1+1"}}]')
    try {
      const result = await runCli(['batch', '--file', file])

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0]!.body?.command).toBe('batch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('eval 读取带 BOM 的脚本不会带上非法字符', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-bom-'))
    const file = path.join(dir, 'script.js')
    await writeWithBom(file, 'return 1 + 1')
    try {
      const result = await runCli(['eval', '--file', file])

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0]!.body?.args?.script).toBe('return 1 + 1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
