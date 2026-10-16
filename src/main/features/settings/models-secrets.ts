import type { JsonObject } from '@shared/api/settings'
import { isMasked, isSecretLiteral, maskSecret, unmask } from './secrets'

/**
 * Secrets in models.json: provider `apiKey` and header values, custom model (`models[]`) headers and
 * `modelOverrides` headers. The renderer gets them masked; on save, unchanged masks get their value back.
 */

type SecretMapper = (value: string, providerId: string, field: string[]) => string

export function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

/** Apply `map` to every secret literal; `field` is its path inside the provider (custom models by id). Returns a copy. */
function mapModelsSecrets(data: JsonObject, map: SecretMapper): JsonObject {
  const copy = JSON.parse(JSON.stringify(data)) as JsonObject
  const providers = asJsonObject(copy.providers)
  if (!providers) return copy
  const mapHeaders = (headers: JsonObject | null, id: string, prefix: string[]) => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (typeof value === 'string' && isSecretLiteral(value)) headers![name] = map(value, id, [...prefix, 'headers', name])
    }
  }
  for (const [id, raw] of Object.entries(providers)) {
    const provider = asJsonObject(raw)
    if (!provider) continue
    if (typeof provider.apiKey === 'string' && isSecretLiteral(provider.apiKey)) provider.apiKey = map(provider.apiKey, id, ['apiKey'])
    mapHeaders(asJsonObject(provider.headers), id, [])
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const entry = asJsonObject(model)
      if (typeof entry?.id === 'string') mapHeaders(asJsonObject(entry.headers), id, ['models', entry.id])
    }
    for (const [modelId, override] of Object.entries(asJsonObject(provider.modelOverrides) ?? {})) {
      mapHeaders(asJsonObject(asJsonObject(override)?.headers), id, ['modelOverrides', modelId])
    }
  }
  return copy
}

/** The string at `field` inside `provider` (see mapModelsSecrets). */
function storedSecret(provider: unknown, field: string[]): string | undefined {
  let value = provider
  for (const part of field) {
    value = Array.isArray(value) ? value.find((item) => asJsonObject(item)?.id === part) : asJsonObject(value)?.[part]
  }
  return typeof value === 'string' ? value : undefined
}

export function maskModelsSecrets(data: JsonObject): JsonObject {
  return mapModelsSecrets(data, maskSecret)
}

/** Swap unchanged masks in `data` for the values in `onDisk`; other masks stay (see unresolvedSecretProviders). */
export function restoreModelsSecrets(data: JsonObject, onDisk: JsonObject): JsonObject {
  const onDiskProviders = asJsonObject(onDisk.providers)
  return mapModelsSecrets(data, (value, providerId, field) => unmask(value, storedSecret(onDiskProviders?.[providerId], field)))
}

/** Providers that still hold a mask, i.e. a secret whose original could not be found. */
export function unresolvedSecretProviders(data: JsonObject): string[] {
  const unresolved: string[] = []
  mapModelsSecrets(data, (value, providerId) => {
    if (isMasked(value)) unresolved.push(providerId)
    return value
  })
  return unresolved
}
