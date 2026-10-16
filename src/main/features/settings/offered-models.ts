/**
 * Model ids from OpenAI's `GET /v1/models`. With an API key it answers the API list (`data[].id`); with a Sign in with
 * ChatGPT token it answers the ChatGPT list (`models[].slug`), where `visibility: "hide"` marks models OpenAI's own
 * apps do not offer and `supported_in_api: false` ones the API cannot call.
 */
interface ListedModel {
  id?: unknown
  slug?: unknown
  visibility?: unknown
  supported_in_api?: unknown
}

export function offeredModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const { data, models } = body as { data?: unknown; models?: unknown }
  const entries: unknown[] = Array.isArray(data) ? data : Array.isArray(models) ? models : []
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const model = entry as ListedModel
    if (model.visibility === 'hide' || model.supported_in_api === false) continue
    const id =
      typeof model.id === 'string' ? model.id : typeof model.slug === 'string' ? model.slug : null
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
