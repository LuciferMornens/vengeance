# Engine 2 response speed in Vengeance 0.2.4

> Historical qualification and installation report for 0.2.4. Account eligibility, process state,
> versions and local paths below describe that checkpoint. The later complete native suite passed
> in [the October audit](ENGINE-AUDIT-2026-10-14.md). See [current guides](../README.md) and
> [engines.lock.json](../engines.lock.json).

Prime Agent 0.10.0 accepted a requested service tier but discarded it when constructing both
OpenAI Responses transports. The direct and simple request paths therefore sent no requested
priority tier. Vengeance also disabled its OpenAI speed controls to avoid advertising behavior
that the engine could not deliver.

The native regression failed before the fix: the public simple-stream request contained `null`
instead of `priority`. Patch `0005-openai-speed-tiers.patch` carries the correction against stable
upstream revision `763094e1b6a7c17450ee8399b06cda1853847ca5`. Engine 2 identifies as
`0.10.0+vengeance.2`; Engine stays at `1.2.0+vengeance.2`, with extension SDK version `1.2.0`.

## Behavior

- OpenAI API and ChatGPT HTTP/WebSocket requests carry `priority` or `ultrafast` without
  substituting the selected model or changing reasoning.
- ChatGPT eligibility comes from the signed-in Engine 2 account's native model catalog. The
  catalog cache is scoped to endpoint and token digest; no credentials cross between engines.
  An account without Ultrafast falls back to Fast when offered, otherwise Standard. A failed
  catalog lookup never grants Ultrafast. Cancellation interrupts an outstanding lookup.
- The app renders native tier offers, supports `/fast ultrafast`, and saves the requested
  preference through model changes, restart and session branching. The native helper links the
  same patched source so its session parser understands the new tier.
- Native ChatGPT billing follows the requested tier when the response echoes `default`.
  Displayed multipliers are API-equivalent costs, not a claim about a subscription's included
  usage allowance. Eligibility is not inferred from a plan name or dollar amount.
- A provider rejection specifically naming an unsupported tier saves Standard and displays a
  notice. Ordinary rate limits leave the user's preference intact. Disconnects cannot silently
  claim that a correction was saved; a later read obtains the native state.
- Restart carries the live model and thinking level unless the requested launch configuration
  changes them. The regression caught and fixed restoration of the initial launch model.
- Older resident executables require an explicit restart to enable the new speed controls.
  OpenRouter's native Fast mode remains available without a fabricated price. Engine 2's
  Anthropic adapter still does not implement Claude Fast mode.
- The obsolete OpenAI-disable flag, duplicated native model allowlist, and Ultrafast-to-priority
  approximation were removed from the app. Native eligibility now owns those decisions.
- The Engine 2 mock keeps factory fixtures in its data module so the process implementation
  stays within the repository's source-file size limit; fixture behavior is unchanged.

Official contracts checked during implementation:
[OpenAI Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode),
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), and
[ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers).

## Qualification

Native provider tests used loopback HTTP and WebSocket servers with synthetic account tokens.
App and helper QA used temporary account, session, profile and workspace directories. The
extension test copied OpenAI Codex compat 0.0.23 and Black 0.1.0 into isolated package storage.
Neither real credentials nor real session files were used as writable test fixtures.

```text
npm run typecheck
> tsc --noEmit -p tsconfig.web.json
[exit 0]

npm run build
prime: staged 0.10.0+vengeance.2 (61 files)
Staged resources\prime-auth\bin\vengeance-prime-auth.exe
✓ built in 25.48s

npm run checks
✓ all checks passed

npm run shots
Screenshots in D:\Coding\vengeance\.shots

cargo fmt --all --check
[exit 0]

cargo clippy --locked --workspace --all-targets --target-dir <cache> -j4 -- -D warnings
Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 14s

cargo test --locked -p pa-ai -p pa-types --lib --target-dir <cache> -j4
test result: ok. 326 passed; 0 failed; 3 ignored
test result: ok. 140 passed; 0 failed

cargo test --locked -p pa-ai --test service_tiers --test service_tiers_transport --target-dir <cache> -j4
test result: ok. 2 passed; 0 failed
test result: ok. 3 passed; 0 failed

cargo test --locked -p pa-daemon --lib service_tier --target-dir <cache> -j4
test result: ok. 1 passed; 0 failed

node scripts/qa/engines/speed-mode-engine2.qa.mjs
✓ engines-speed-mode-engine2 passed

node scripts/qa/engines/speed-mode.qa.mjs
✓ engines-speed-mode passed

node scripts/qa/engines/speed-mode-subscriptions.qa.mjs
✓ engines-speed-mode-subscriptions passed (9.8s)

node scripts/qa/engines/integration.qa.mjs
✓ engines-integration passed

node scripts/qa/engines/candidate-controls.qa.mjs
✓ Native candidate controls and restart: 4 checks passed

node scripts/qa/engines/candidate-transition.qa.mjs
✓ Official-to-candidate native restart: 3 checks passed

node scripts/qa/engines/restart-notices.qa.mjs
✓ regression: 31 checks, 0 observed regressions

node scripts/checks/prime-auth-native.mjs
Native trace settings, missing preview and empty upload-all passed without network

node scripts/checks/prime-auth-oauth.mjs
✓ invalid helper credential never overwrites the account store

QA_PACKAGED_EXE=<QA package> node scripts/qa/engines/packaged.qa.mjs
✓ packaged-engines passed

QA_PACKAGED_EXE=<QA package> QA_PI_PACKAGE_ROOT=<installed package source> \
  node scripts/qa/ext/bundled-extensions.qa.mjs
✓ bundled-extensions passed (5.0s)

npx prettier --check <changed supported files>
All matched files use Prettier code style!
```

The full daemon unit run was not green: 20 failures and seven stalled tests occurred outside
the changed speed behavior. Nineteen failures reproduced on the prior four-patch source
baseline. The remaining heartbeat timing test passed on that baseline and when run alone on
the final candidate. The stalled run was stopped and is not counted as passing. Upstream's
vendored Windows terminal dependency also emits five existing dead-code warnings. The public
app integration, native executable transition and changed native contracts passed separately.

Both release and QA packages passed complete payload inventory verification after packaging.
The transition test verified the actual worker executable hash, native session identity,
saved history, model/reasoning state and another completed turn. Packaged tests verified both
engines, external bridge loading, helper operation with only the Windows system PATH, saved
history across restart, and extension commands and enablement.

Evidence lives under `.shots/qa/engine2-speed-0.2.4`,
`.shots/qa/engine2-speed-0.2.4-packaged`, and `.cache/prime-speed-*.log`.

The complete screenshot suite passed. The Fast and Ultrafast controls, context view, ChatGPT
eligibility fixture and packaged extension restart screenshots were inspected visually.
After the fixture extraction, typecheck, all checks, the app build and the Engine 2 screenshot
scenarios were repeated. The installer was rebuilt from that final source.

## Installation and existing data

The 0.2.4 installer completed with exit code 0. The installed application reports version
0.2.4, and both installed engine payloads passed complete inventory verification:

```text
pi: verified 1.2.0+vengeance.2 (14947 files)
prime: verified 0.10.0+vengeance.2 (61 files)
```

All four open-session identities were restored. All 188 saved session files remain present:
187 are byte-identical to the pre-installation snapshot. The remaining Engine 2 file retains
every prior byte and only appends a 130-byte `session_state` record marking it active. Its
native restart kept GPT 6 Astra and Extra high reasoning. A 556-message Engine conversation
also opened successfully, and the installed package inventory remained available. Lens remains
installed and disabled; it was not uninstalled.

The signed-in Engine 2 session offers Standard and Fast for GPT 6 Astra. That account/model
does not currently offer Ultrafast. Ultrafast was verified using synthetic eligible-account
catalogs and real native request paths, not a paid request with the user's account.

Engine model configuration and Engine 2 settings are byte-identical to their snapshots.
The Engine settings file has a different hash: its last-write time was 18:19:43 local on
13 October 2026, before the installation around 18:25. The source of that earlier change
was not established, and the file was not reset or replaced. No claim is made that every
configuration file remained byte-identical.

The old 0.2.3 installer and blockmap, obsolete bundled Engine 2 cache, and legacy Engine 2
release were moved to the Recycle Bin. The legacy daemon was shut down through its native
protocol only after it reported zero resident sessions. The running Engine 2 daemon and
worker both use the verified 0.2.4 payload. Installation and preservation evidence is in
`.shots/qa/install-0.2.4`.

## Artifact identities

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Vengeance-Setup-0.2.4.exe  | `7507964604c99f9be6b688118dbf9ff916c0d048157458148cc7d30ee5107cf5` |
| Engine payload inventory   | `679d24670ca84f98006003239f32e3ac29434fdbfb4a3710fa3fc04afc938db4` |
| Engine 2 payload inventory | `7095ca8d439690bee40d0503eebef68049d98cc224e7e8d2ce12728edebdb82b` |
| Engine 2 executable        | `b1031d556a90c06f875f189536498ec1da5273c55e07a2e258c1f3ba474eeebc` |
| Native helper              | `cd9aede582c97f2d99ec1b96ed1f487c70e9a3f3cefaec80d7d09c97a8254295` |
