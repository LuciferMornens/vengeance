# AGENTS.md — Vengeance

Read `SPEC.md` fully before doing anything. It is the contract.

For engine, helper, compatibility or update changes, also read `UPSTREAM.md`. Preserve the upgrade path
for both upstream engines; local native patches are temporary and require qualification on each new base.

- Product name in UI: **Vengeance**. Engine = pi (never branded "pi" in the UI; say "Engine").
- Both engines ship as Vengeance source builds, pinned in `engines.lock.json`, with patches in `patches/`.
  Run `npm run engines:prepare` for editable upstream checkouts and `npm run build:engines` to build.
  Export native changes as patches and update the lock before rebuilding; never hand-edit staged binaries.
  The staged pi SDK is `.engine-staging/bundled/pi/node_modules/@earendil-works/pi-coding-agent`;
  docs live in `<root>/docs`, types in `<root>/dist/**/*.d.ts`. Read `UPSTREAM.md` for qualification.
- Never edit anything under `C:/Users/dev/.pi/` except through the app's own feature code at runtime. Do not
  modify the user's real `settings.json`, `auth.json`, `models.json` during development/testing — use a temp
  `PI_CODING_AGENT_DIR` (see the staged pi package's `docs/environment-variables.md`) or mock mode for tests
  that write config. Engine 2 uses a separate temporary `PRIME_AGENT_CODING_AGENT_DIR`; never use the
  user's real `.prime` account or sessions as writable test fixtures. See `scripts/qa/README.md`.
- Real-engine tests: tiny prompts only, in a temp folder, `--no-session` or temp session dir.
- Gates: `npm run typecheck`, `npm run build`, `npm run shots` (look at the PNGs!).
- Windows paths: use `path`/`node:path`, never hardcode `/` separators for fs ops. Shell is Git Bash for dev.
- Keep code clean: no dead code, no placeholder TODO stubs left in owned files when you finish, no
  `any` unless at a protocol boundary with a comment.
- Commit on your branch when done.
