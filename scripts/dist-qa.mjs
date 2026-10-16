// QA/dev Windows installer: the same app, NSIS template and flags as `npm run dist`, under its own identity, so
// installing it can never touch a real Vengeance install. The release appId owns the HKCU uninstall key: an
// installer with the same appId runs the "old version" uninstaller it finds there (electron-builder
// installSection.nsh), replaces the Desktop/Start Menu shortcuts and copies itself to
// %LOCALAPPDATA%/<package name>-updater. Never publishes, never creates shortcuts, never auto-starts.
//
//   npm run dist:qa              → release/qa/VengeanceQA-Setup-<version>.exe + release/qa/win-unpacked/
//   npm run dist:qa -- --dir     → release/qa/win-unpacked/ only (no installer)
//
// The app reads its identity at runtime from the product name (main/index.ts: AppUserModelID, and Electron's
// userData folder %APPDATA%/Vengeance QA), so a QA build never shares state with the release app either.
import { Arch, build, Platform } from 'electron-builder'

const QA_BUILD = Object.freeze({
  appId: 'com.vengeance.qa',
  productName: 'Vengeance QA',
  executableName: 'VengeanceQA',
  /** package.json name: NSIS keeps the installer copy in %LOCALAPPDATA%/<name>-updater (release: vengeance-updater). */
  packageName: 'vengeance-qa',
  outputDir: 'release/qa'
})

const unpackedOnly = process.argv.includes('--dir')

await build({
  targets: Platform.WINDOWS.createTarget(unpackedOnly ? 'dir' : 'nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: QA_BUILD.appId,
    productName: QA_BUILD.productName,
    extraMetadata: { name: QA_BUILD.packageName, productName: QA_BUILD.productName },
    directories: { output: QA_BUILD.outputDir, buildResources: 'build' },
    win: { executableName: QA_BUILD.executableName },
    nsis: {
      createDesktopShortcut: false,
      createStartMenuShortcut: false,
      runAfterFinish: false,
      shortcutName: QA_BUILD.productName,
      uninstallDisplayName: QA_BUILD.productName,
      artifactName: 'VengeanceQA-Setup-${version}.${ext}'
    }
  }
})
