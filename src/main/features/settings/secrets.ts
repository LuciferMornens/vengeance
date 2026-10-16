/**
 * Masking of secret-bearing config strings (models.json keys/headers, mcp.json env/headers/client
 * secrets). The renderer only ever sees a mask; on save an unchanged mask is swapped back for the value
 * on disk. `!command` and environment references (`$NAME`, `${NAME}`) are not secrets and pass through.
 */

export const SECRET_MASK = '\u2022\u2022\u2022\u2022'

/** True for literal values; references are shown as-is. */
export function isSecretLiteral(value: string): boolean {
  if (value.startsWith('!')) return false
  if (/^\$?\{?[A-Z][A-Z0-9_]*\}?$/.test(value)) return false
  // Headers like `Bearer ${TOKEN}` only reference variables.
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').replace(/^(Bearer|Basic|Token)\s*$/i, '').trim() !== ''
}

export function maskSecret(value: string): string {
  return value.length >= 12 ? `${SECRET_MASK}${value.slice(-4)}` : SECRET_MASK
}

/** Mask a value when it is a secret literal. */
export function maskIfSecret(value: string): string {
  return isSecretLiteral(value) ? maskSecret(value) : value
}

/** A value coming back from the renderer: unchanged masks resolve to the original, other masks stay unresolved. */
export function unmask(value: string, original: unknown): string {
  if (!value.startsWith(SECRET_MASK)) return value
  return typeof original === 'string' && maskSecret(original) === value ? original : value
}

export function isMasked(value: string): boolean {
  return value.startsWith(SECRET_MASK)
}
