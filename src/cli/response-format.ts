export type ResponseFormat = 'concise' | 'detailed'

export function parseResponseFormat(value: unknown): ResponseFormat {
  if (value === undefined || value === null || value === '') return 'concise'
  if (value === 'concise' || value === 'detailed') return value
  throw new Error('response format must be concise or detailed')
}
