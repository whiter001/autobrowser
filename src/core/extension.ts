import { createHash } from 'node:crypto'

export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAotlQtKvLjh26OAh4W7gN2uJDwsIwT+FUu+x2sup4C2d6H4tqsExN5CjGM4NjALmMN+WStxYzEMNxXIkuUtWdd9wrMLxODDuVMp4DVXxE9cw/2WJWw8ODnmq4SKgHNuRTsDt/ePMbAmAFJF/ezPeWCPRpwbV6brusPTM+yVnQ6o0ySVRZOCG/WqVFe9+WlEwxj+YmIl8lJ0P960lMgWb9qzKHmPWVtLE9J06vop+HMniDGVViLO869oE2aFr586th9sJyhxwgahws5eZFH3SOH/UG6Z/IXtes2a9uqUaFn7rDOwoskhBWFnUZMCxg/FZS9bO+PQWw51qM/GTr1FsgBwIDAQAB'

function mapHexToExtensionId(hex: string): string {
  return hex
    .slice(0, 32)
    .split('')
    .map((value) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(value, 16)))
    .join('')
}

function normalizeExtensionIdCandidate(value: string | null | undefined): string {
  return String(value || '').trim()
}

function isValidExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value)
}

function pickExtensionId(...candidates: Array<string | null | undefined>): string | null {
  return candidates.map(normalizeExtensionIdCandidate).find(isValidExtensionId) || null
}

/**
 * 根据公钥生成标准的 Chrome 扩展 ID。
 * 默认使用项目预设的测试密钥公钥。
 */
export function getExtensionId(publicKey: string = EXTENSION_PUBLIC_KEY): string {
  const keyBytes = Buffer.from(publicKey, 'base64')
  const hash = createHash('sha256').update(keyBytes).digest('hex')
  return mapHexToExtensionId(hash)
}

/**
 * 解析实际使用的扩展 ID，优先级：手动传入 > 环境变量 > 默认公钥生成。
 */
export function resolveExtensionId(extensionId?: string | null): string {
  return pickExtensionId(extensionId, process.env.AUTOBROWSER_EXTENSION_ID) || getExtensionId()
}

/**
 * 构建指向扩展程序内部页面的 chrome-extension:// URL。
 * @param pathname 扩展内的文件路径（如 /connect.html）
 * @param searchParams 要附带的查询参数
 * @param extensionId 可选的扩展 ID 覆盖
 */
export function getExtensionUrl(
  pathname: string,
  searchParams: Record<string, string | number | boolean | null | undefined> = {},
  extensionId?: string | null,
): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(`chrome-extension://${resolveExtensionId(extensionId)}${normalizedPath}`)

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === null || value === undefined) {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}
