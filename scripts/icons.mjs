// Generates the app icon set from build/icon.svg (the outputs are committed):
//   build/icon.png (1024)       macOS: electron-builder derives the .icns from it
//   build/icons/<n>x<n>.png     Linux: installed as-is into the hicolor theme
//                               (a single PNG would ship at one size)
//   build/icon.ico              Windows: executable, installer and uninstaller
//   resources/icon.png (256)    the window icon (main/window.ts)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = await readFile(join(root, 'build', 'icon.svg'))

const render = (size) => sharp(svg, { density: Math.max(72, Math.ceil((72 * size) / 512) * 4) }).resize(size, size).png().toBuffer()

await mkdir(join(root, 'resources'), { recursive: true })
await writeFile(join(root, 'build', 'icon.png'), await render(1024))
await writeFile(join(root, 'resources', 'icon.png'), await render(256))
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512]
await mkdir(join(root, 'build', 'icons'), { recursive: true })
for (const size of linuxSizes) {
  await writeFile(join(root, 'build', 'icons', `${size}x${size}.png`), await render(size))
}
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = await pngToIco(await Promise.all(icoSizes.map(render)))
await writeFile(join(root, 'build', 'icon.ico'), ico)
console.log(
  [
    'icons: build/icon.png (1024)',
    `build/icons (${linuxSizes.join(', ')})`,
    `build/icon.ico (${icoSizes.join(', ')})`,
    'resources/icon.png'
  ].join(', ')
)
