import { useEffect, useState } from 'react'
import type { EngineId } from '@shared/api/engine'
import type { Model } from '@shared/engine-types'
import { rpc } from '../../lib/engine'
import { revealSetting } from '../palette/settings-sections'
import { useEffectiveSetting } from '../settings/effective'
import { imageNotice, routesToImageModel, type ImageNotice } from './image-support'

/** Engine 2's image model setting, which answers image turns its session model cannot read. */
export function revealImageModelSetting(): void {
  revealSetting('models', 'imageModel', 'prime')
}

/** The notice for the draft's images, with Engine 2's image routing read from its settings and models. */
export function useImageNotice(
  agentId: string,
  engine: EngineId,
  cwd: string,
  model: Model | undefined,
  hasImages: boolean
): ImageNotice | undefined {
  const configured = useEffectiveSetting('imageModel', cwd, engine)
  const blockImages = useEffectiveSetting('images.blockImages', cwd, engine) === true
  const imageModel = engine === 'prime' && typeof configured === 'string' ? configured : undefined
  const routes =
    hasImages && !!model && routesToImageModel({ engine, model, imageModel, blockImages })
  const [available, setAvailable] = useState<{ agentId: string; models: Model[] }>()
  useEffect(() => {
    if (!routes) return
    let current = true
    // Read again each time: sign-ins and models change without telling the composer.
    rpc(agentId, { type: 'get_available_models' })
      .then(({ models }) => {
        if (current) setAvailable({ agentId, models })
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [agentId, routes])
  if (!hasImages || !model) return undefined
  return imageNotice({
    engine,
    model,
    imageModel,
    blockImages,
    available: available?.agentId === agentId ? available.models : undefined
  })
}
