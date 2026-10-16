# Extension compatibility in Vengeance 0.2.3

> Historical qualification for 0.2.3. Versions, hashes and local evidence below describe that
> checkpoint; the SDK compatibility fix remains in the ordered patch series. See
> [current guides](../README.md) and [engines.lock.json](../engines.lock.json).

The 0.2.2 engine package replaced upstream's `1.2.0` version with `1.2.0+vengeance.1`.
The native SDK exports that package version as `VERSION`. OpenAI Codex compat 0.0.23 and
Black 0.1.0 both reject a `+` suffix in their runtime version checks, so they refused to load
despite the engine providing the required APIs. Restarting reproduced the refusal.

The failure was reproduced with copies of both installed extensions in a temporary account.
The failing screenshot is `.shots/qa/extension-version-red/bundled-extensions-shots/bundled-extensions-FAILED.png`.

## Correction

- The native package and SDK report the actual upstream API version, `1.2.0`.
- `package.json`'s `vengeance.version`, CLI `--version`, the engine manifest and app descriptor
  report `1.2.0+vengeance.2`. The customized build remains identifiable.
- Native install-change detection compares the distribution version, including patch upgrades
  on the same upstream base. Self-update refusal and suppression of upstream update queries remain active.
- The app reads the distribution metadata when locating its engine. Ordinary custom engines keep
  their own package version.
- The native change is an ordered source patch in `patches/pi`, with the exact upstream revision
  pinned in `engines.lock.json`. Extension packages and their capability checks are not modified.
- App version is 0.2.3. Engine 2's complete payload is identical to the qualified 0.2.2 release.

## Validation

All engine operations used temporary account, session and workspace directories. Extension package
files were copied before execution. Model turns used local provider fixtures and no paid credentials.

```text
npm run typecheck
> tsc --noEmit -p tsconfig.web.json
[exit 0]

npm run build
pi: staged 1.2.0+vengeance.2 (14947 files)
prime: staged 0.10.0+vengeance.1 (61 files)
✓ built in 26.07s

npm run checks
✓ all checks passed

QA_TMP_ROOT=D:/Vengeance-QA-temp node scripts/checks/bundled-engines.mjs
✓ upstream SDK version, distribution identity, replacement detection, update guard
✓ pi 1.2.0+vengeance.2: system PATH, native self-update refusal, config intact
✓ prime 0.10.0+vengeance.1: system PATH, native self-update refusal, config intact
✓ bundled native engine checks passed

QA_PI_PACKAGE_ROOT=C:/Users/dev/.pi/agent node scripts/qa/ext/bundled-extensions.qa.mjs
copied pi-openai-codex-compat@0.0.23 into isolated QA storage
copied pi-black@0.1.0 into isolated QA storage
✓ bundled-extensions passed

QA_TMP_ROOT=D:/Vengeance-QA-temp node scripts/qa/engines/integration.qa.mjs
✓ engines-integration passed

node scripts/dist.mjs
• building block map  blockMapFile=release\Vengeance-Setup-0.2.3.exe.blockmap
[exit 0]

node scripts/dist-qa.mjs --dir
pi: verified 1.2.0+vengeance.2 (14947 files)
prime: verified 0.10.0+vengeance.1 (61 files)
[exit 0]

QA_PACKAGED_EXE=D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe \
QA_PI_PACKAGE_ROOT=C:/Users/dev/.pi/agent node scripts/qa/ext/bundled-extensions.qa.mjs
✓ load extensions with upstream SDK and package versions
✓ save a conversation before restarting
✓ restart without removing or disabling extensions
✓ complete a model turn with both extensions enabled
✓ bundled-extensions passed (4.4s)

QA_PACKAGED_EXE=D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe \
node scripts/qa/engines/packaged.qa.mjs
✓ packaged native helper loads with only the Windows system PATH
✓ packaged Engine streams and loads its external bridge
✓ packaged Engine2 streams through its native resident API
✓ public Engine2 sign-in loads the packaged helper and cancels before a key
✓ packaged-engines passed

node scripts/qa/ext/bundled-extensions.qa.mjs
✓ bundled-extensions passed (3.3s)

npm run shots
Screenshots in D:\Coding\vengeance\.shots
[exit 0]

npx prettier --check <all changed supported files>
All matched files use Prettier code style!
```

The native pi source passed Biome over 1,464 files, pinned/runtime dependency checks, TypeScript
import and entry-graph checks, install-lock verification, TypeScript checking and browser smoke.
The affected native version-check and install-change tests passed: 11 passed, 16 unrelated cases
deselected. The full config/version test pair also ran: seven installation-command/permissions
tests failed identically on the prior source checkout and this candidate on Windows; those failures
are not counted as passes. The packaged native distribution regression separately verifies the
update guard and replacement detection against the actual shipped metadata.

The dual-engine integration run covered concurrent streams, Python tools, queues and abort,
settings/provider/account isolation, resources, saved history and native identity, restart and
peer recovery, exports and branches, schedules, goals, autonomy, subagents, side questions, traces,
and app relaunch. Live provider OAuth completion and paid provider calls were not exercised.

The packaged extension check verifies the saved native session ID and file, the earlier answer in
native history, package enablement, extension commands, the bridge, and another completed model turn.
The portable regression also passes without any installed third-party packages. Both release and QA
packages passed a complete post-test engine-payload hash verification.

Inspected screenshots include the reproduced crash; the fixed extension transcript; the packaged
transcript containing answers before and after restart; both packaged engines; concurrent native
engines; Engine 2 settings in Bone; and Engine settings showing build `1.2.0+vengeance.2` alongside
SDK `1.2.0`. Packaged evidence is under `.shots/qa/extension-version-packaged`, and the dual-engine
run is under `.shots/qa/extension-version-dual-engine`.

## Artifact identities

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Vengeance-Setup-0.2.3.exe  | `a97fb45f63888bda22be22202aeef88f68b0229adbe59fd440feee9dd4b96580` |
| Engine payload inventory   | `679d24670ca84f98006003239f32e3ac29434fdbfb4a3710fa3fc04afc938db4` |
| Engine 2 payload inventory | `328616808d04840a48a5586c91866a5e78d56d62a5ecd8b4f85ff7bd05e915c8` |
| Engine 2 executable        | `b0616a1a35ab1ac426cc8d9df8c4ac99b0dfbdddf5bf2a3216606ad536c7592d` |

The installer is built locally; it does not replace an installed app until run. User engine
configuration, credentials and installed extension files were not modified by the fix or its tests.
