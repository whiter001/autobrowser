import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import {
  constants,
  copyFile,
  link,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { HlsDownloadError } from './hls-error.js'

export const CHECKPOINT_VERSION = 1

export interface CheckpointEntry {
  kind: 'init' | 'segment'
  track: 'video' | 'audio'
  index: number
  url: string
  path: string
  bytes: number
  sha256: string
}

export interface CheckpointFile {
  version: number
  sourceUrl: string
  outputPath: string
  quality: string
  files: CheckpointEntry[]
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export async function findDuplicateBookBySha256(
  outputDir: string,
  sha256: string,
): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(outputDir, { withFileTypes: true })
  } catch {
    return null
  }

  const books = entries
    .filter((entry) => entry.isFile() && /\.(epub|mobi)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, 1000)
  for (const name of books) {
    const candidate = path.join(outputDir, name)
    if ((await sha256File(candidate)) === sha256) return candidate
  }
  return null
}

export async function readHead(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** 清理输出目录里属于本任务前缀的临时文件 */
export async function removeTempFiles(
  outputDir: string,
  filePrefix: string,
  suffixes: string[],
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(outputDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(filePrefix)) continue
    if (suffixes.some((suffix) => entry.endsWith(suffix))) {
      await rm(path.join(outputDir, entry), { force: true })
    }
  }
}

export async function loadCheckpoint(checkpointPath: string): Promise<CheckpointFile | null> {
  try {
    const raw = await readFile(checkpointPath, 'utf8')
    const parsed = JSON.parse(raw) as CheckpointFile
    if (!parsed || parsed.version !== CHECKPOINT_VERSION || !Array.isArray(parsed.files)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * 原子提交：覆盖时用 rename 直接替换；不覆盖时用同目录 hard link + unlink，
 * link 在目标已存在时会失败，从而不会破坏旧文件。
 */
export async function commitFile(
  sourcePath: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) {
    try {
      await rename(sourcePath, targetPath)
      return
    } catch (error) {
      // 跨设备时 rename 会失败，退化成先复制再删除，语义仍然是“替换”
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyFile(sourcePath, targetPath)
      await rm(sourcePath, { force: true })
      return
    }
  }
  try {
    await link(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      // 跨设备无法 hard link，退化成独占创建，目标已存在时同样会失败
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
      await rm(sourcePath, { force: true })
      return
    }
    throw new HlsDownloadError(
      `输出文件已存在，拒绝覆盖: ${targetPath}`,
      error instanceof Error ? error.message : undefined,
    )
  }
  await unlink(sourcePath).catch(() => undefined)
}
