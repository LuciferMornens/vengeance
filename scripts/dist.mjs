// Windows installer: electron-builder NSIS x64 from the BUILT app (npm run dist runs the build first).
// Output: release/Vengeance-Setup-<version>.exe and release/win-unpacked/. Never publishes.
//
// App self-update (electron-updater, generic provider) is opt-in at build time:
//   VENGEANCE_UPDATE_FEED=https://updates.example.com/vengeance npm run dist
// bakes that feed into the app (resources/app-update.yml) and writes release/latest.yml, which you upload
// next to the installer. Without it, the installed app only self-updates once a feed is set in
// Settings → General (that setting always wins over the baked feed).
import { Arch, build, Platform } from 'electron-builder'

const feed = process.env.VENGEANCE_UPDATE_FEED?.trim()
if (feed) console.log(`• update feed: ${feed}`)

await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: feed ? { publish: { provider: 'generic', url: feed } } : undefined
})
