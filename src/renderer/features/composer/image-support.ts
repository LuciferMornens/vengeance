import type { EngineId } from '@shared/api/engine'
import type { Model } from '@shared/engine-types'

/** What the composer says about attached images the conversation's model may not read. */
export interface ImageNotice {
  tone: 'info' | 'warning' | 'danger'
  text: string
  /** Engine 2 refuses the turn: its image model is unset, or names no signed-in model that reads images. */
  refusal?: 'unset' | 'unusable'
}

/**
 * Engine 2's exact model reference match (upstream `find_exact_model_reference_match`), case-insensitive:
 * "provider/id", then the reference split at its first slash, then an unambiguous bare id.
 */
export function matchModelReference(
  reference: string,
  models: readonly Model[]
): Model | undefined {
  const trimmed = reference.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  const only = (matches: Model[]) => (matches.length === 1 ? matches[0] : undefined)
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === lower
  )
  if (canonical.length > 0) return only(canonical)
  const slash = trimmed.indexOf('/')
  if (slash >= 0) {
    const provider = trimmed.slice(0, slash).trim().toLowerCase()
    const id = trimmed
      .slice(slash + 1)
      .trim()
      .toLowerCase()
    const split = models.filter(
      (model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id
    )
    if (provider && id && split.length > 0) return only(split)
  }
  return only(models.filter((model) => model.id.toLowerCase() === lower))
}

export interface ImageNoticeInputs {
  engine: EngineId
  model: Model
  /** Engine 2's effective `imageModel` reference. */
  imageModel?: string
  /** The effective `images.blockImages`: no image reaches any provider. */
  blockImages: boolean
  /** Engine 2's signed-in models, which `imageModel` must name; undefined until they are read. */
  available?: readonly Model[]
}

/** Engine 2 would send this image turn to `imageModel`, if its signed-in models have one that reads images. */
export function routesToImageModel({
  engine,
  model,
  imageModel,
  blockImages
}: ImageNoticeInputs): boolean {
  return (
    engine === 'prime' &&
    !blockImages &&
    !!imageModel?.trim() &&
    model.input.length > 0 &&
    !model.input.includes('image')
  )
}

/**
 * The Engine sends a turn without the images a text-only model cannot read. Engine 2 sends such a turn to
 * its image model when one is set, signed in and reads images; otherwise it refuses the turn.
 */
export function imageNotice(inputs: ImageNoticeInputs): ImageNotice | undefined {
  const { engine, model, imageModel, blockImages, available } = inputs
  if (model.input.length === 0)
    return { tone: 'warning', text: `Image support could not be verified for ${model.name}.` }
  if (model.input.includes('image')) return undefined
  if (engine === 'pi' || blockImages)
    return { tone: 'warning', text: `${model.name} can’t read images. They will be ignored.` }
  if (!routesToImageModel(inputs))
    return {
      tone: 'danger',
      text: `${model.name} can’t read images, so Engine 2 will refuse this message.`,
      refusal: 'unset'
    }
  if (!available) return undefined
  const reference = imageModel!.trim()
  const routed = matchModelReference(reference, available)
  if (routed?.input.includes('image'))
    return {
      tone: 'info',
      text: `${model.name} can’t read images, so ${routed.name} will answer this message.`
    }
  return {
    tone: 'danger',
    text: `${model.name} can’t read images, so Engine 2 will refuse this message: its image model “${reference}” isn’t a signed-in model that can.`,
    refusal: 'unusable'
  }
}
