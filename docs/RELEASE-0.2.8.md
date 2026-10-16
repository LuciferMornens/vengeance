# Vengeance 0.2.8 release verification

Built and checked on Windows x64 on 14 October 2026 from `main`. The installer is built locally,
not installed or published.

## Included changes

- Responsive shell: the center pane keeps at least 480px beside the sidebar and inspector. Panels
  shrink first (inspector, then sidebar); when both cannot dock, the inspector opens as an overlay
  drawer. Panel widths follow live window resizing without spring lag. Saved widths are unchanged.
- The composer footer stays one row at every width and text size. Container-query steps in em
  first drop the Engine, Steer and Follow-up labels, then reduce thinking, speed and the context
  meter to glyphs; the model name truncates in between.
- Inspector tab labels follow the drawn panel width; its minimum width is now 304px.
- Narrow panes tighten transcript and composer padding. Short windows compact the empty-session
  hero and hide its recent-session list (760px tall or less) and card hints (640px or less).
- `scripts/shots/responsive.mjs` captures five window sizes and sweeps widths from 880 to 1600px at
  85% and 125% text, failing on a wrapped or overflowing footer or a narrowed center pane.
- App version metadata advances from 0.2.7 to 0.2.8 in `package.json` and both root lockfile fields.

Native payloads are unchanged: Engine remains `1.2.0+vengeance.3` (upstream SDK `1.2.0`) and
Engine 2 remains `0.10.0+vengeance.5`, as qualified in the
[14 October engine audit](ENGINE-AUDIT-2026-10-14.md).

## Validation

Logs are under `.engine-staging/release-0.2.8/`.

```text
npm run typecheck                [exit 0, both TypeScript projects]
npm run checks                   ✓ all checks passed
npm run dist                     • building block map  blockMapFile=release\Vengeance-Setup-0.2.8.exe.blockmap
node scripts/dist-qa.mjs --dir   pi: verified 1.2.0+vengeance.3 (14951 files)
                                 prime: verified 0.10.0+vengeance.5 (61 files)
```

The full screenshot gate (`npm run shots`, 17 scenario files) passed on the UI commit `2c39a47`;
the version bump changes no renderer code. Its only renderer-error report is the deliberate
malformed transcript frame in `transcript-recovery.mjs`.

Packaged qualification (`QA_PACKAGED_EXE` = `release/qa/win-unpacked/VengeanceQA.exe`, report
directory `.shots/qa/release-0.2.8`, suites `packaged`, `model-isolation`, `bundled-extensions`):

```text
PASS  engines/model-isolation.qa.mjs  (44.7s)
PASS  engines/packaged.qa.mjs  (31.4s)
PASS  ext/bundled-extensions.qa.mjs  (21.5s)
PASS  shell/packaged.qa.mjs  (6.2s)
All 4 suite(s) passed
```

About and Updates show 0.2.8 (`shell-shots/packaged-4-about.png`,
`packaged-2-updates-version.png`). The production executable reports ProductVersion `0.2.8.0` and
FileVersion `0.2.8`. Tests made no external sign-in or paid provider requests.

## Artifact identity

| Artifact                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.8.exe` | `87493595c3a71c4254e7d385472d5705d4c5b2c4d4d4e0a366645b763334bfb3` |

## Repository and runtime state

All work is on `main`, the only branch, in one checkout. No Git remote is configured and no push
was made. The superseded 0.2.7 installer and blockmap were moved to the Windows Recycle Bin;
`release/` holds only the 0.2.8 installer and its production and QA unpacked apps. The user's
installed app, account configuration and running residents were not touched.
