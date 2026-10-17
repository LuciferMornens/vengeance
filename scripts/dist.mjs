// Release packages for the host platform and architecture from the BUILT app (npm run dist runs
// the build first). Never publishes. Each platform packages on its own host: the staged engines are
// host builds, and scripts/engines/before-pack.cjs refuses to pack them for another platform or
// architecture.
//
//   npm run dist                    → the host's targets: Windows nsis, macOS dmg zip,
//                                     Linux AppImage deb rpm tar.gz, plus pacman on x64
//                                     (Arch Linux is x86_64-only)
//   node scripts/dist.mjs deb rpm   → only these electron-builder targets
//
// Output in release/: Vengeance-Setup-<version>.exe and win-unpacked/;
// Vengeance-<version>-mac-<arch>.{dmg,zip} and mac[-arm64]/Vengeance.app;
// Vengeance-<version>-linux-<arch>.{AppImage,deb,rpm,pacman,tar.gz} and linux[-arm64]-unpacked/.
//
// App self-update (electron-updater, generic provider) is opt-in at build time:
//   VENGEANCE_UPDATE_FEED=https://github.com/LuciferMornens/vengeance/releases/latest/download npm run dist
// bakes that feed into the app (resources/app-update.yml) and writes release/latest*.yml, which you
// upload next to the packages. Without it, the installed app has no feed until one is set in
// Settings → General (that setting always wins over the baked feed).
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { archFromString, build, Platform } from 'electron-builder'

/** The Linux targets that write resources/package-type (electron-updater's install method). */
const PACKAGE_TYPE_TARGETS = new Set(['deb', 'rpm', 'pacman'])

/** The host platform's release targets. */
export function hostTargets() {
  switch (process.platform) {
    case 'win32':
      return ['nsis']
    case 'darwin':
      return ['dmg', 'zip']
    case 'linux':
      return ['AppImage', 'deb', 'rpm', ...(process.arch === 'x64' ? ['pacman'] : []), 'tar.gz']
    default:
      throw new Error(`Vengeance does not package on ${process.platform}`)
  }
}

/**
 * Packages `targets` for the host platform and architecture, with `config` merged over
 * electron-builder.yml.
 *
 * One electron-builder run builds its targets concurrently from one unpacked app, which deb, rpm
 * and pacman each write into (resources/apparmor-profile, and with a feed resources/package-type):
 * every package of the run, AppImage and tar.gz included, would ship whichever type was written
 * last. So each of those targets gets its own run on a freshly unpacked app, and the other targets
 * share the last run, which leaves the AppImage's latest-linux*.yml (the self-updating format) in
 * the output.
 */
export async function distribute(targets, config = {}) {
  const platform = Platform.current()
  const arch = archFromString(process.arch)
  for (const run of platform === Platform.LINUX ? linuxRuns(targets) : [targets]) {
    await build({
      targets: platform.createTarget(run, arch),
      publish: 'never',
      config: structuredClone(config)
    })
  }
}

function linuxRuns(targets) {
  const ownRun = (target) => PACKAGE_TYPE_TARGETS.has(target.toLowerCase())
  const shared = targets.filter((target) => !ownRun(target))
  const own = targets.filter(ownRun).map((target) => [target])
  return shared.length > 0 ? [...own, shared] : own
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const feed = process.env.VENGEANCE_UPDATE_FEED?.trim()
  if (feed) console.log(`• update feed: ${feed}`)
  const targets = process.argv.slice(2)
  await distribute(
    targets.length > 0 ? targets : hostTargets(),
    // releases/latest/download serves only latest*.yml; without a channel a prerelease version
    // would bake its own ("rc") into app-update.yml and name its update files after it.
    feed ? { publish: { provider: 'generic', url: feed, channel: 'latest' } } : {}
  )
}
