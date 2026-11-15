import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createBuildInfo,
  formatBuildVersionName,
  readGitCommit,
  writeBuildInfoFile,
} from '../scripts/lib/build-info.js'

describe('chrome version_name', () => {
  test('encodes version, UTC build time and commit', () => {
    expect(formatBuildVersionName('0.1.5', '2026-11-15T02:13:16.789Z', 'a458338')).toBe(
      '0.1.5-dev.20261115T021316Z+a458338',
    )
  })

  test('omits the commit suffix when no commit is available', () => {
    expect(formatBuildVersionName('0.1.5', '2026-11-15T02:13:16.000Z', null)).toBe(
      '0.1.5-dev.20261115T021316Z',
    )
  })

  test('normalizes non-UTC timestamps and drops milliseconds', () => {
    // 构建机可能不在 UTC：version_name 固定用 UTC，避免同一构建在不同时区显示不同身份
    expect(formatBuildVersionName('0.1.5', '2026-11-15T10:13:16.789+08:00', 'a458338')).toBe(
      '0.1.5-dev.20261115T021316Z+a458338',
    )
  })
})

describe('build info helpers', () => {
  test('reads the package version and writes the shared build-info.json shape', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-build-info-'))
    try {
      await writeFile(
        path.join(rootDir, 'package.json'),
        `${JSON.stringify({ name: 'fixture', version: '9.8.7' })}\n`,
        'utf8',
      )

      // 临时目录没有 .git：commit 必须退化为 null，而不是让构建失败
      expect(readGitCommit(rootDir)).toBeNull()

      const buildInfo = await createBuildInfo(rootDir)
      expect(buildInfo.version).toBe('9.8.7')
      expect(buildInfo.commit).toBeNull()
      expect(new Date(buildInfo.buildTime).toISOString()).toBe(buildInfo.buildTime)

      await writeBuildInfoFile(rootDir, buildInfo)
      expect(JSON.parse(await readFile(path.join(rootDir, 'build-info.json'), 'utf8'))).toEqual({
        version: '9.8.7',
        buildTime: buildInfo.buildTime,
        commit: null,
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
