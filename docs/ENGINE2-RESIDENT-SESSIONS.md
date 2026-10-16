# Engine 2 resident sessions after an app update

> Historical fix and qualification record for app 0.2.6 / Engine 2 `0.10.0+vengeance.4`.
> The resident lifecycle rules remain current; versions, installed/running state and artifact hashes
> below describe this investigation. See [SPEC §10](../SPEC.md#10-dual-engine-decisions-supersede-earlier-pi-only-assumptions),
> [engines.lock.json](../engines.lock.json) and [current guides](../README.md).

Installing Vengeance does not replace a running Engine 2 resident. The installed app in the reported
case already contained `0.10.0+vengeance.4`, while `.3` workers remained active from the versioned
runtime cache. Both versions can run safely at the same time. No user resident was stopped or restarted
for this investigation.

## Behavior

- Incomplete selected-model state resolves input modalities, thinking levels, costs and limits from
  that resident's own native catalog by exact provider and model ID. Custom text-only models keep
  their native declaration, even when another provider has the same model ID. No model-name inference,
  catalog capability changes or production limit changes are used.
- The lookup does not copy catalog provider URLs, headers or arbitrary compatibility fields into
  selected-model state. Failed verification stays unknown and says support could not be verified;
  missing metadata no longer creates a false text-only declaration.
- The session reports the running Engine version separately from the selected Engine version.
  Different versions show a persistent notice and an explicit **Restart session** action. Temporary
  sessions must use a new session. The notice never restarts work automatically.
- Saved **Close tab** detaches. The session remains available under **Background sessions**, whether
  working or idle. Idle residents stay listed because busy flags do not prove there is no saved goal,
  child work or future schedule. Temporary tabs stop their temporary worker when closed.
- Explicit **Stop session** cancels the resident and scheduled work. Saved conversation history remains.
  Composer **Stop** ends the current turn, not the saved resident.
- Catalog lookup keeps snapshot/event ordering coherent. Disconnected or rebound replies cannot
  publish stale snapshots. Startup waits for the reattached snapshot before reporting ready; another
  disconnect during reattachment fails through the recoverable engine-error path rather than claiming
  a disconnected session is ready.

App metadata hydration does not repair the old native `.3` live-model-switch prompt or Python binding.
A fresh `.3` Sol session already accepts native tool images, while text-to-Sol switches on `.3` can keep
stale generated instructions and `model.info`. Applying `.4` requires an explicit idle restart through
native preparation, commit and roster restoration. Same-runtime residents must all be idle; busy
siblings, temporary residents, side questions and unknown launch environments retain their guards.
Saved history, selected model and thinking level survive the successful restart.

Version selection metadata is captured when the session connects or reconnects. Changing an executable
override while keeping a tab attached does not immediately change its captured selected-version label;
reopening the tab refreshes it. This does not restart the native resident.

## Qualification

All providers and accounts below are isolated local fixtures. No paid inference, real sign-in, account
writes, installed-app replacement or user-process termination is used.

- Pre-fix app: six model-state/version-notice regressions reproduced against the complete `.3` package.
  Old native startup and live-switch behavior were recorded separately. One extra baseline assertion
  was fixture noise from decimal USD JSON rounding, not a product failure; final history checks retain
  exact token/content/identity comparisons and the original saved JSONL byte prefix.
- Historical resident QA: **11 checks passed** for startup, same-ID custom text models, exact catalog
  state/privacy, detach/reopen, app relaunch, live version notice, narrow Bone layout at 200% zoom,
  explicit `.3` to `.4` transition, saved history and actual tool-image bytes.
- Saved close/stop QA: **4 checks passed**, including idle future schedules, same worker/native identity
  on resume, a live provider stream surviving close, and explicit stop retaining saved history.
- Current `.4` image QA: **14 checks passed**. Dual-engine integration and **31** restart-notice checks
  passed. The native executable and engine lock are unchanged by this app-side fix.
- Four fast normalization checks cover exact identity, custom text input, complete descriptors and
  unknown support through repeated normalization. Public test sockets cover attach/resync cursor
  ordering, stale identity replies, initial/resync disconnects during lookup and a second disconnect
  during reattachment. No private runtime fields are assigned by these tests.
- Typecheck, fast checks, build and screenshot gates passed. Dark/Bone close controls and runtime notices
  were viewed. Electron zoomed Playwright PNGs can crop the raster despite correct DOM bounds; native
  `webContents.capturePage` captures the full zoomed surface for final packaged evidence. The notice
  stays above the floating composer's fade, and its Restart action remains reachable at the window
  minimum; the visual check includes a public DOM hit test, not horizontal bounds alone.

Entrypoints and isolated baseline inputs are documented in `scripts/qa/README.md`. Evidence is in
`.cache/prime-auth/resident-followup/`. The copied historical package is a repository-generated,
ignored qualification artifact, not a writable copy of the user's account or active runtime.

The app stays `0.2.6`; Engine 2 stays `0.10.0+vengeance.4`, and the first Engine stays
`1.2.0+vengeance.3`. No native patches, catalog pins, production limits or timeouts change. New values
are test fixtures only: 24-pixel PNGs, deterministic fake PIDs/model limits, local token lifetimes and
bounded test waits. The visual stress test uses the actual 880-pixel window minimum and 200% zoom.

## Release artifact

The rebuilt installer is `release/Vengeance-Setup-0.2.6.exe` (SHA-256
`29fbf9ef2189e9aaeba357e9643bff250696013bf43a40cdf2b55dd824749fd0`).
Its packaged Engine 2 executable stays `4b1eca49b69bda05ef6afdf0f7d3d3ba8aea1497bd32cb18219af4927cd02770`.
Packaged qualification runs the unpacked app with temporary profiles and accounts; it never runs the
installer against the user's installed app.
