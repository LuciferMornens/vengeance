import { handle } from './handle'
import { galleryPackage, searchGallery } from '../features/gallery/gallery'

/** Extension gallery: read-only discovery of community Engine packages. */
export function registerGalleryIpc(): void {
  handle('gallery:search', (args) => searchGallery(args))
  handle('gallery:package', (name) => galleryPackage(name))
}
