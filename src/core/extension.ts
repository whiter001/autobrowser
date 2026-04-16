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

export function getExtensionId(publicKey: string = EXTENSION_PUBLIC_KEY): string {
  const keyBytes = Buffer.from(publicKey, 'base64')
  const hash = createHash('sha256').update(keyBytes).digest('hex')
  return mapHexToExtensionId(hash)
}

export function getExtensionUrl(
  pathname: string,
  searchParams: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(`chrome-extension://${getExtensionId()}${normalizedPath}`)

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === null || value === undefined) {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}
