// QA/dev packages: the same app, templates and flags as `npm run dist` (scripts/dist.mjs), under
// their own identity, so installing one can never touch a real Vengeance install. On Windows the
// release appId owns the HKCU uninstall key: an installer with the same appId runs the
// "old version" uninstaller it finds there (electron-builder installSection.nsh), replaces the
// Desktop/Start Menu shortcuts and copies itself to %LOCALAPPDATA%/<package name>-updater. Never
// publishes, never creates shortcuts, never auto-starts.
//
//   npm run dist:qa              → release/qa/: the host's packages (VengeanceQA-*) and the
//                                  unpacked app
//   npm run dist:qa -- --dir     → release/qa/: the unpacked app only
//
// Both print the unpacked app's executable: win-unpacked/VengeanceQA.exe,
// mac[-arm64]/VengeanceQA.app/Contents/MacOS/VengeanceQA or linux[-arm64]-unpacked/vengeance-qa.
//
// The app reads its identity at runtime from the product name (main/index.ts: AppUserModelID, and
// Electron's userData folder, e.g. %APPDATA%/Vengeance QA), so a QA build never shares state with
// the release app either. On Linux its desktop entry and Wayland app_id are vengeance-qa, apart
// from the release app's.
import { join, resolve } from 'node:path'
import { archFromString, getArchSuffix, Platform } from 'electron-builder'
import { distribute, hostTargets } from './dist.mjs'

const QA_BUILD = Object.freeze({
  appId: 'com.vengeance.qa',
  productName: 'Vengeance QA',
  /** Windows and macOS executable (and .app) name. */
  executableName: 'VengeanceQA',
  /** Linux executable, desktop entry and Wayland app_id. */
  linuxExecutableName: 'vengeance-qa',
  /**
   * package.json name: the deb/rpm/pacman package name, and NSIS keeps the installer copy in
   * %LOCALAPPDATA%/<name>-updater (release: vengeance-updater).
   */
  packageName: 'vengeance-qa',
  outputDir: 'release/qa'
})

const unpackedOnly = process.argv.includes('--dir')

await distribute(unpackedOnly ? ['dir'] : hostTargets(), {
  appId: QA_BUILD.appId,
  productName: QA_BUILD.productName,
  extraMetadata: {
    name: QA_BUILD.packageName,
    productName: QA_BUILD.productName,
    desktopName: `${QA_BUILD.linuxExecutableName}.desktop`
  },
  directories: { output: QA_BUILD.outputDir, buildResources: 'build' },
  win: { executableName: QA_BUILD.executableName },
  nsis: {
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    runAfterFinish: false,
    shortcutName: QA_BUILD.productName,
    uninstallDisplayName: QA_BUILD.productName,
    artifactName: 'VengeanceQA-Setup-${version}.${ext}'
  },
  mac: {
    executableName: QA_BUILD.executableName,
    artifactName: 'VengeanceQA-${version}-mac-${arch}.${ext}'
  },
  linux: {
    executableName: QA_BUILD.linuxExecutableName,
    artifactName: 'VengeanceQA-${version}-linux-${arch}.${ext}'
  }
})

console.log(`QA executable: ${unpackedExecutable()}`)

/** electron-builder's unpacked app for the host platform and architecture, under release/qa. */
function unpackedExecutable() {
  const platform = Platform.current()
  const folder = resolve(
    QA_BUILD.outputDir,
    `${platform.buildConfigurationKey}${getArchSuffix(archFromString(process.arch))}`
  )
  const { executableName, linuxExecutableName } = QA_BUILD
  if (platform === Platform.WINDOWS) return join(`${folder}-unpacked`, `${executableName}.exe`)
  if (platform === Platform.MAC) {
    return join(folder, `${executableName}.app`, 'Contents', 'MacOS', executableName)
  }
  return join(`${folder}-unpacked`, linuxExecutableName)
}
