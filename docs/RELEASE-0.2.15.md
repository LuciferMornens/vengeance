# Vengeance 0.2.15 release verification

Built on Windows x64 on 17 October 2026. Engines are unchanged: Engine `1.3.0+vengeance.1` and
Engine 2 `0.10.0+vengeance.9`. No dependencies or native patches changed.

## Included changes

- **Settings → Extensions** browses community Engine packages from the public npm index of
  `pi-package` packages: search, topic shortcuts, paging, weekly downloads and last update. A details
  view shows what a package adds (extensions, skills, prompt templates, themes), its license, size and
  links, and warns that extensions run with the user's permissions. Installs use the existing Engine
  installer with its live log, for every project or only the open one. **Add your own** installs an
  extension file or package folder. The gallery only reads the index, honors Work offline and never
  installs on its own. Packages and the inspector's Extensions tab link to it.
- Engine 2 saves auto-compaction, auto-retry and a global subagent depth to its settings file as it
  applies them. Those writes no longer offer **Restart to apply**. The toggles also apply live to open
  Engine 2 sessions; a project's own value takes a restart instead, because the engine saves applied
  toggles as the global value.
- Changing the default model or thinking level no longer offers a restart: saved sessions resume their
  own. Installs, updates and removals started in Vengeance rewrite the package list themselves; that
  write is adopted rather than reported as an outside edit.
- A project's configuration changes now concern only that folder's sessions and only when the folder is
  trusted.
- Every restart offer now names what changed, such as "Packages changed." or "Shell command prefix
  changed outside Vengeance."
- "Git" displays as a word rather than an acronym in package names.

## App checks

Main and renderer TypeScript checks and `npm run checks` passed, including the new offline gallery
checks for package names, https-only links, search results and package manifests. The complete
`npm run shots` rerun exited zero: 19 scenario files and 372 PNGs. Inspected screens include the
Extensions gallery at desktop, minimum and wide widths, search, details, installed state, Packages and
the inspector's Extensions tab. The transcript-recovery scenario deliberately injects a malformed frame
and asserts its logged renderer error and recovery flow.

```text
npm run typecheck
  typecheck:node and typecheck:web: exit 0
npm run checks
  ✓ all checks passed
npm run shots
  Screenshots in D:\Coding\vengeance\.shots
  19 scenario files; 372 PNGs; exit 0
```

Seven isolated suites passed against the same compiled output, in temporary profiles with the mock
engine and no real account:

| Suite                      | Checks | Covers                                                       |
| -------------------------- | -----: | ------------------------------------------------------------ |
| ext/packages-local         |     17 | Local file and folder installs, removal and refused tarballs |
| ext/resources              |     16 | Extensions, skills, prompts and themes                       |
| settings/external-raw      |     14 | Outside edits while Raw JSON has unsaved changes             |
| settings/app-prefs-restart |     15 | App preferences across relaunch                              |
| settings/models            |     10 | A new default model or thinking level offers no restart      |
| settings/scope-trust       |     13 | Project settings follow folder trust                         |
| engines/restart-notices    |     36 | Each restart offer and its absence; 0 observed regressions   |

## Packages

The production installer and the isolated QA package were built from the release tree. Both bundled
engines verified their staged payloads: Engine with 14,956 files and Engine 2 with 61 files. A second
`npm run build` produced byte-identical output, and the output hashed again after QA and screenshots
was unchanged.

QA and production contain the same 149 tested compiled app files, including all 144 renderer files.
Their ordered renderer SHA-256 is
`571a0db2e8ab916702523bc64a7d47213100cbe45eac28657c3e02d9f285be27`. Both packages also match the
qualified native engine manifest and helper bytes and report version 0.2.15.

The packaged shell suite passed nine checks, including a real turn through the packaged bridge and the
version shown as "Vengeance 0.2.15". The packaged engines suite passed four checks: the helper loaded
on a system-only PATH with the expected hash, both engines streamed, and Engine 2 sign-in loaded the
packaged helper and cancelled before a key.

| Artifact                          | Size (bytes) | SHA-256                                                            |
| --------------------------------- | -----------: | ------------------------------------------------------------------ |
| `Vengeance-Setup-0.2.15.exe`      |  156,392,962 | `a308e5083324d3ffa68ec14d1a0d858550c62aa5ba374aa20f4107d3733bf9c8` |
| `win-unpacked/Vengeance.exe`      |  246,638,080 | `fbcb4dbf803f844453d0802cd1a81d9f0d20752ee5ac86493152cde57a992c47` |
| Production `app.asar`             |   12,367,219 | `f79bc1c6ba1c9117e6096e9007c4903f6604785c2cccb90be6008e85c4740c4a` |
| QA `app.asar`                     |   12,367,225 | `eea49839c2cc9b43ace026ef1493ca37858c54d544823d06d908d138404668bb` |
| `vengeance-prime-auth.exe` helper |   11,330,560 | `f0a6a7ea577660676ff4ab8ea84906c745ff56af1ab4316adf244d886cc2d2ca` |

## Cleanup

After the packages were verified and no QA was running, 30 reviewed targets (1.86 GiB) were moved to
the Recycle Bin, so each stays recoverable: the 0.2.14 installer and blockmap, an unpacked 0.2.0 QA
build kept for an earlier performance baseline, an empty worktree folder, and QA temporary folders
left from runs before this release. The script checks exact paths, protected paths, links and active
QA processes, and its local receipt lists each target with its size. Current packages, engine
staging and baselines, the helper build cache, screenshots, retained reports and qualification logs
were protected.
