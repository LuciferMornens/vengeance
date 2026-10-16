// Generates the app icon set from build/icon.svg: build/icon.png (512), build/icon.ico, resources/icon.png (256).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = await readFile(join(root, 'build', 'icon.svg'))

const render = (size) => sharp(svg, { density: Math.max(72, Math.ceil((72 * size) / 512) * 4) }).resize(size, size).png().toBuffer()

await mkdir(join(root, 'resources'), { recursive: true })
await writeFile(join(root, 'build', 'icon.png'), await render(512))
await writeFile(join(root, 'resources', 'icon.png'), await render(256))
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = await pngToIco(await Promise.all(icoSizes.map(render)))
await writeFile(join(root, 'build', 'icon.ico'), ico)
console.log(`icons: build/icon.png, build/icon.ico (${icoSizes.join(', ')}), resources/icon.png`)
