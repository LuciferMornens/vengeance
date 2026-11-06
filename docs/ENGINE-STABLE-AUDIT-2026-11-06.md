# Engine stable audit — 6 November 2026

Both engines move to their newest stable releases. The release APIs and remote tags were checked on
6 November 2026. Upstream `main` has moved on by 237 commits on pi and 36 on Prime; those commits are
unreleased and were not adopted.

## Release identity

| Engine      | Latest stable | Published UTC             | Exact upstream commit                      | Vengeance build      |
| ----------- | ------------- | ------------------------- | ------------------------------------------ | -------------------- |
| pi          | `v1.5.0`      | 2 November 2026, 11:05:31 | `f9a26365568127461c47a07a37dcb42c140a3ac5` | `1.5.0+vengeance.1`  |
| Prime Agent | `v0.10.2`     | 28 October 2026, 16:03:19 | `ea9d9602ec0938d9e454e8963107cd85af1565c6` | `0.10.2+vengeance.1` |

pi's tag points directly at its commit; Prime's annotated tag `26b06045` peels to its commit. Prime's
model catalog moves to `01f4d46dd5157ec73f8faf440214088237c81d59`. The helper links the same patched
Prime revision.

Sources: [pi release](https://github.com/earendil-works/pi/releases/tag/v1.5.0) and
[Prime release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.2).

## pi 1.5.0

All eleven patches carry over; see the [pi patch guide](../patches/pi/README.md). Rebasing needed three
reviewed resolutions. `0003` takes upstream's reported editor failures, keeps launching through
`spawnProcess`, and now reports an empty editor command as a failure. `0005` drops its
`check:entry-graphs` hunk because upstream compares `/` paths itself. `0010` keeps upstream's `./models`
forbid list and its own 21-file budget.

1.5.0 adds two tests that assume POSIX paths. `0005` normalizes the JSON Schema suite's fixture names, which
otherwise failed 936 cases, and reads the packed tarball in `preview-packages.test.mjs` by relative path,
because GNU tar takes the `D:` of a Windows path for a remote host. 1.5.0 also requires a resize profile on
every vision model, which `0012` now declares. Every internal `dist/` module the app imports still exists.

`node scripts/checks/pi-workspace.mjs check` passes. The full isolated suite ran every workspace; the
script tests pass 55/55, and agent, ai, codemode, env, evals, mcp, schema, telemetry and tui pass. Sixteen
tests fail in chord (13), durable (2) and coding-agent (1). A targeted run of the same 12 chord, 2 durable
and 2 coding-agent files on unpatched `v1.5.0` through the same harness fails 17 tests, those 16 plus the
memory test `keeps a watcher's memory proportional…`, which failed on the patched tree in one of its two
runs too. They are POSIX assumptions on Windows (`chmod` on a directory, symlinks, `SIGTERM`, socket file
locks) and durable timing. No patch touches those files or the code they test. Because `npm test` stops
a workspace at its first failure, durable's later passes (zero document retention, store, workers) did
not run.

Tool arguments now validate through `pi-schema` instead of TypeBox's validator, so TypeBox refinements,
codecs and registered formats no longer apply to extension tools. `scripts/qa/ext/bundled-extensions.qa.mjs`
qualifies the bundled extensions against it.

## Prime 0.10.2

The series stays at 21 patches; see the [Prime patch guide](../patches/prime-agent/README.md). `0025`
joins it and `0010` is retired: upstream #3823 deleted the dead built-in `bash` and `edit` tools it reported
Windows failures for, so no code remains to patch, and the same removal took the matching hunks out of
`0008`.
`0015` keeps both `session_id` and `native_messages` in `compact_session.rs`, and `0024` keeps both
tests in `agent_engine/tests/session.rs`.

`node scripts/checks/prime-workspace.mjs --with-kernel` ran the whole workspace with the packaged kernel:
243 test binaries, 4,971 passing, 7 failing and 14 ignored. The 26 October audit gave only two targets the
kernel, so `kernel_snapshot_resume` had not run with it on Windows. That test compared Python's working directory
with a `\\?\` canonical path, panicked, and then hung with its kernel still running until the 2-hour bound.
`0008` now canonicalizes both sides, and the same prefix needed the same treatment in
`a_restarted_supervisors_registration_seeds_the_roster_family`. Upstream raised the threshold compaction
test's window, and `0008`'s Windows value had to follow. Measured on Windows, the seed turn counts 16,987
tokens and an 8 KB crossing turn only 12,716, so no window could separate them. The test now sends 24 KB
against a 27,000 window.

With those fixes in, six failures remain, none in code a patch touches:

- `pa-tui`: `at_lookup_answers_inline_from_a_built_index` and `at_index_matches_the_walk_on_random_trees`
  test the `@` file index new in 0.10.2 and fail the same on unpatched `v0.10.2`. Vengeance runs Engine 2 with
  `--mode daemon`, so it does not use this TUI completion.
- `pa-perf`: `generated_kernel_snapshot_unpickles_to_an_empty_dictionary`,
  `the_manifest_is_the_file_set_baseline` and `the_same_seed_rebuilds_the_identical_tree` also fail on
  unpatched `v0.10.2`, as they did on `v0.10.1`. The unpatched run fails a fourth,
  `the_warm_pass_writes_product_sidecars`, which passed on the patched tree.
- `pa-models`: `a_dropped_refresh_resolves_the_gate_and_the_next_refresh_starts_fresh` failed once under
  full-suite load and passes 3 of 3 runs alone.

## OrcaRouter

pi `0012` and Prime `0025` add `orca/orcacyber-k3.1-pro`. Live QA on both engines exposed what fake
providers could not. A `modelOverrides` entry without `compat` made Prime's `merge_compat` return none,
which erased the built-in compat and brought back the `developer` role and a 400 on every turn. `0025`
keeps the base compat, with a regression test. On Engine 1, a live Off turn kept calling `true` for three
minutes until stopped. Four bounded Off runs and two Low runs show this is the model's behaviour, not the
request's, so Off stays and the [Limits](RELEASE-0.3.9.md#limits) warn about it.

Live QA on the final engines (`VENGEANCE_LIVE_ORCAROUTER_QA=1`, temporary accounts) passes on both engines.

## App qualification

`npm run typecheck`, `npm run build`, `npm run checks` and `npm run shots` pass on the final engines, and
`npm run qa` passes 100 of its 106 suites. The other six:

- `settings/parity`: 1.5.0 documents `selfUpdateCommand`. Vengeance's `pi update` refuses to update itself, so
  the setting has no effect here. The suite records it as not applicable and it passes.
- `auth/model-parity-real`: it compared the composer picker with a list read before a background catalog
  refresh, so the same models appeared in a different order. It now rereads the list and passes.
- `shell/packaged`: passes against the `npm run dist:qa -- --dir` package with `QA_PACKAGED_EXE` set, as does
  `engines/packaged`, which skips itself without it.
- `engines/candidate-controls` and `engines/candidate-transition` need a verified baseline package. They run in
  the release workflow's upgrade group, not here.
- `chat/real-providers`: the default Anthropic model answered, then the suite stopped because this account
  holds no `openai-codex` credential. Its later steps did not run.

`system-prompts` and `session-tree-real` also needed updates for upstream changes. pi rewrote the first line
of its built-in prompt, and its nested `get_tree` no longer overflows the stack: 48,000 linear entries pass, where
pi 1.1.0 failed past about 2,200. `requestSessionTree` keeps rebuilding from `get_entries` on any `get_tree`
failure, and the real-engine check no longer requires that failure.

`bundled-engines`, `pi-catalog`, `pi-changelog`, `native-kernel`, `session-tree-real`, `sdk-host-recovery`,
`prime-source`, `prime-adapter-real`, `prime-native-real`, `prime-restart-native`, `prime-restart-isolation`,
`prime-resident-identity`, `prime-auth-native` and `prime-auth-oauth` pass. Clippy with `-D warnings`, the
formatting check and the three repaired test targets pass on the exported series. On Windows x64, both packaged
suites pass. Other platforms are qualified by the release workflow.
