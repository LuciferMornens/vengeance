# Vengeance design system: "Obsidian & Ember"

This is the contract every screen follows. Tokens live in `src/renderer/styles/tokens.css`, Tailwind mappings
in `src/renderer/styles/globals.css`, and primitives in `src/renderer/ui/` (import them from `@renderer/ui`). To browse every
token and primitive in both themes and all accents, open the live gallery: run `npm run dev`, then set
`location.hash = '#design'` in the devtools console. It only exists in dev and test builds. To regenerate the
screenshots, run `npm run shots -- design` (`.shots/design-*.png`).

Mode: **Operate**. Brand shows up in precise details, not decoration. Dark (Obsidian) is the hero and light
(Bone) must look just as good. When a choice is unclear, use the quieter option.

---

## 1. Color roles

| Token / utility                                                        | Use for                                                                                                                                         | Never use for                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `--accent` / `bg-accent` (solid ember)                                 | **Only** these: primary CTA fill (`Button variant="primary"`), the live/running dot, the streaming caret, the selected-row caret, progress fill | Text, borders, badges, icons, focus, tints |
| `--accent-2`                                                           | The softer sibling. Every ember tint derives from it                                                                                            | —                                          |
| `accent-soft` / `accent-softer` / `accent-border` / `text-accent-text` | "Ember highlight": something new, yours or highlighted (soft orange, never red)                                                                 | Errors, counts, scopes, kinds              |
| `control-on`                                                           | Switch / checkbox / slider "on" (the accent at reduced chroma, so a column of switches is never an ember wall)                                  | —                                          |
| `danger` (rose) / `danger-soft` / `--danger-border`                    | Errors and destructive actions. **The only true red**                                                                                           | Emphasis, branding                         |
| `success` / `warning` / `info` (+ `-soft`, `--*-border`)               | Semantic states only                                                                                                                            | Decoration                                 |
| `bg-pill` + `--pill-fg`                                                | Neutral status pills (titlebar activity, counts)                                                                                                | —                                          |
| `fg` / `fg-2` / `fg-3`                                                 | Primary text / secondary text / tertiary metadata; verify contrast on the actual background                                                     | —                                          |
| `fg-4`                                                                 | Disabled text, decorative glyphs only                                                                                                           | Body copy, placeholders (use `fg-3`)       |
| `bg` < `surface-1` < `surface-2` < `surface-3` < `surface-4`           | Window → pane → card → raised control → pressed/thumb                                                                                           | —                                          |
| `hairline-soft` / `hairline` / `hairline-strong`                       | Dividers inside a surface / card edges / control edges and hovers                                                                               | —                                          |
| `hover` / `active`                                                     | Row and ghost hover / pressed or selected fill                                                                                                  | —                                          |

Rules:

- **Counts, scopes, tags, kinds, model names and "new" badges are neutral** (`Badge` default) or `info`.
  Use `accent` only when the thing is genuinely highlighted. Never use red for anything that is not an error.
- Focus is **neutral-bright** everywhere. Outlines use `--focus-color` (global `:focus-visible`); custom fields
  use `shadow-focus` (`--focus-ring`). `--accent-ring` is a legacy alias of `--focus-color`; don't use it in new code.
- Accent tints follow the user's accent automatically. Any element with `data-accent="violet"` (etc.)
  re-themes its subtree, which is how the gallery and the settings accent swatches can preview accents.

## 2. Shape, elevation, layout

| Radius | Utility                                      | Use                                                                |
| ------ | -------------------------------------------- | ------------------------------------------------------------------ |
| 4      | `rounded-xs`                                 | Badges, kbd, inline code, checkbox                                 |
| 6      | `rounded-sm` (legacy alias `rounded-chip`)   | Chips, xs buttons, icon tiles ≤24px, segmented thumbs              |
| 8      | `rounded-md`                                 | **Controls, inputs, list rows, sm/md buttons**                     |
| 10     | `rounded-card`                               | Cards, popovers, menus, toasts, 32px+ icon tiles, workbench corner |
| 14     | `rounded-lg` (legacy alias `rounded-dialog`) | Dialogs, composer, palette                                         |
| 18     | `rounded-xl`                                 | Hero surfaces (onboarding card)                                    |

> **Review rule:** use `rounded-md` for controls, rows and inputs; `rounded-sm` is the 6px chip radius.
> Replace ad-hoc `rounded-[Npx]` with the scale: 5→`xs`, 7/8→`md`, 9→`card`
> (or `md` for rows), 12/16→`lg`.

| Elevation | Utility         | Use                                                                        |
| --------- | --------------- | -------------------------------------------------------------------------- |
| 0         | `shadow-elev-0` | Recessed wells (inset hairline)                                            |
| 1         | `shadow-elev-1` | Cards, raised controls                                                     |
| 2         | `shadow-elev-2` | Popovers, menus, toasts (with `bg-[var(--glass-strong)] backdrop-blur-xl`) |
| 3         | `shadow-elev-3` | Dialogs, palette                                                           |

Layout tokens: `--titlebar-h` 40px · **`--pane-header-h` 44px** (every pane header, so hairlines line up across
panes; use `h-[var(--pane-header-h)]` + `border-b border-hairline-soft`) · `--transcript-w` 760px ·
`--composer-h` (see §5).

Stacking (`z-[var(--z-*)]`): titlebar 30 · sheet 40 · toast 45 · modal 50 · popover 55 · tooltip 60 · lightbox 80.
Feature overlays must use these instead of literal z-indices. A modal dialog is always 50, so toasts sit under it.

Typography: `text-2xs` 10.5 · `xs` 11.5 · `sm` 12.5 · `ui` 13.5 (default) · `md` 14 · **`title` 15 (dialog/card
titles)** · `prose` 15 · `lg` 17 · `xl` 21 · `2xl` 28. Titles use `.heading` (tight tracking, weight 600 in both
themes). List rows use `.weight-row` (450 on dark to offset ClearType bloom, 500 on Bone). Use `tabular` for numbers.
**Use sentence case everywhere.** No uppercase + tracking for labels, badges or group headers; for a section
eyebrow use `text-xs font-medium text-fg-3`.

## 3. Motion

`lib/motion.ts` presets. **Never inline a spring config.**

| Preset                        | Use                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `spring.snappy`               | Buttons, chips, toggles, indicators (`layoutId`), toasts, pills                      |
| `spring.smooth`               | Popovers, menus, dialogs, tab content                                                |
| `spring.panel`                | Sidebar/inspector width, sheets                                                      |
| `spring.layout`               | Height/layout changes (tool cards, `Collapse`)                                       |
| `spring.gentle`               | Hero and first-run moments (onboarding mark, empty-state hero)                       |
| `press`                       | `whileTap={press}` on motion buttons and pills. In CSS, use the `.pressable` utility |
| `duration.*` / `--dur-*`      | instant 80 (hover, press) · fast 120 · base 180 · panel 260 · slow 420               |
| `--ease-out`, `--ease-spring` | CSS easing; `--ease-spring` is a `linear()` spring (≈ smooth) for keyframes          |

Rules:

- Hover feedback is a color/background change over `--dur-instant`. Press feedback is `scale(.97)` on
  **buttons and pills only, never on rows**.
- Enter with a spring and exit with a short ease (≤160ms). Don't use a spring on close.
- Reduced motion: the root `<MotionConfig reducedMotion>` (App.tsx) follows the OS or Settings → Motion, and
  CSS animations collapse under `prefers-reduced-motion` and `html[data-motion=reduce]`. Hide purely
  decorative loops (progress bars, shimmer sweeps) with `motion-reduce:hidden [[data-motion=reduce]_&]:hidden`.
- Never animate layout of streaming text. Infinite pings are banned: pulse a few times, then settle.

## 4. Primitives

All primitives keep backward-compatible props. New props are additive.

### Button / IconButton

`variant`: `primary` (the one CTA per surface: crisp ember fill, inner highlight, a hairline accent edge and
`shadow-sm`, press scale; **no outer glow**, so it matches the composer's send button) · `secondary` ·
`outline` · `ghost` · `danger` (rose tint). `size`: xs 24 / sm 28 / md 32 / lg 40. Disabled is **neutral for
every variant** (no opacity-muddied ember). `loading` shows a spinner and sets `aria-busy`.
IconButton: `label` is required (it becomes the tooltip and aria-label), plus `hotkey`. `active` marks a pressed
toggle (`aria-pressed`). Don't leave panel toggles filled at rest unless they are truly "on".

### Badge · Chip · Pill (the triad)

- `Badge`: 18px, r4, 10.5/600, sentence case, `tone` + optional `dot`. For counts, states and kinds.
- `Chip`: 24px, r6, 12.5/500, `icon`, `mono`, `onRemove`. For files, models, queued messages and filters.
- `Pill`: 24px, full radius, clickable status (`indicator="dot" | "live" | "spinner"`). Neutral by default; pass
  `tone="warning"` etc. only for semantic states. Titlebar activity uses it, and **the updates pill should too**
  (neutral, `indicator="dot"`, no infinite ping).
- `toneClass(tone)` returns the matching classes for custom surfaces.

### ListRow (the one list row)

`<ListRow density="menu|list|rich" icon iconTile title subtitle meta trailing selected danger />`

- `menu` 30px (menus, selects) · `list` 36px (pickers, sidebars, suggestion menus) · `rich` 44px+ (two-line:
  model rows, extension selects).
- Hover and keyboard highlight share the quiet `bg-hover`. `selected` (persistent choice: the current session,
  the chosen model) = `bg-active` + a 2px accent caret inset **inside** the row's rounded background (4px from
  the left edge, 6–8px from top and bottom per density). The caret is the only selection signal: no extra check
  icon on the selected row (a check is fine on a non-row choice such as "All workspaces"). Rows never scale.
- For rows that must be another element (cmdk `Command.Item`, Radix items), use
  `className={listRowClass({ density, selected })}` with `<ListRowContent …/>` inside. Highlight states follow
  `data-highlighted`, `data-selected=true` and `aria-selected=true` automatically.
- Menus (`DropdownMenu`, `ContextMenu`) and `Select` already use it.

### Dialog (the one modal shell)

`<Dialog size="confirm|form|picker|editor" icon iconTone title description hint footer persistent …/>`

- Widths: confirm 400 · form 480 (default) · picker 560 · editor 720. `width` still overrides.
- Anchored at **18vh**, so it never jumps while a list filters. Spring scale-in (`--ease-spring`). Optional
  32px icon tile (r10; `iconTone` neutral/danger/warning/info/accent). Title 15/600, description 13.5 `fg-2`.
  Footer actions sit on the right and an optional `hint={{ combo, label }}` kbd hint on the left (`footerStart` replaces it
  when the left side needs more: several key hints, a checkbox, a reset action). `onKeyDown` handles list keys for the surface.
- `persistent` keeps it open on outside click (unsaved input). Esc still closes.
- Clicking a toast never dismisses a dialog or sheet.
- `dialogSurface` gives the surface classes for custom modal shells. `DIALOG_WIDTHS` holds the preset widths.
- Destructive confirm: `size="confirm" icon={<Trash2/>} iconTone="danger"`, footer
  `ghost Cancel` + `danger Delete`. Only one primary per dialog, and secondary actions are `secondary`/`ghost`.

### Sheet

- `side="full"`: a page-like surface filling the window **below the titlebar**. The titlebar stays undimmed and
  draggable. No outer radius or gutter. Enters with y 12→0 + fade over 260ms. Only Esc or the sheet's own close
  button dismisses it. Use it for Settings, **Updates** and **Shortcuts**: content column `max-w-[720px]` with
  `px-[clamp(24px,4vw,72px)]` and a 244px nav where relevant. The content column is centered at every width
  (no right reserve). A sheet with a nav sets `html[data-sheet-nav]` while mounted (Settings does); a sheet
  without a nav ends its scroll column with `pb-36` (144px) so every control scrolls clear of a toast (see Toast).
- `SheetHeader` (`settings/layout.tsx`): the sticky 56px header of a full sheet (title, actions, close). It is
  opaque in the column's surface color and shows its `hairline-soft` bottom border only once the content scrolls.
- The titlebar owns the one full-width hairline under it; sheets and the workbench draw no top border of their own.
- Opening a full sheet sets `html[data-sheet="full"]` (counted, so nested sheets are safe).
- `side="right"`: contextual drawer below the titlebar with an overlay. Use it only for genuinely contextual panes.
- Sheets sit under toasts and modals, so dialogs opened from a sheet stack above it.

### Toast

`toast({ level, title, description?, action?, duration? })`; `useToasts().clear()` clears queued toasts.
Toasts stack bottom-right with the newest at the bottom, up to 3 visible; older ones wait behind a
"+N more · Clear all" pill. The tone lives in the icon only (info/success/warning/error, never ember; no side
bar), plus a hairline progress bar. Hovering pauses every timer, and swiping right dismisses. Toasts render above
sheets and below modals and the palette.

- Placement comes from `--toast-right`, `--toast-bottom` and `--toast-w` (globals.css). In the workbench the shell
  keeps them clear of the inspector (`--toast-inset-right`) and the composer (`--toast-inset-bottom` =
  `--composer-h` + 8px).
- While a full sheet is open (`html[data-sheet="full"]`) toasts are 300px wide at 16px from the bottom-right
  corner and ignore the composer/inspector insets. Sheet content stays centered at every width.
  - **Sheet with a nav** (`html[data-sheet-nav]`, set by Settings): toasts dock bottom-left over the 244px nav
    column at every width (212px wide, 16px inset), never over content controls.
  - **Sheet without a nav** (Updates, Shortcuts): toasts stay bottom-right and the scroll column ends with
    `pb-36` (144px: a toast with a description and an action, plus its 16px inset), so every control can be
    scrolled clear of a toast.

### Controls

`Switch` (on = `control-on`, a spring thumb, neutral when disabled) · `Checkbox` · `Slider` · `Input`/`Textarea`
(r8, neutral `shadow-focus` ring, `aria-invalid` → rose ring; `fieldClass` exported for custom fields) ·
`Select` (ListRow items, neutral check) · `SegmentedControl` (2–5 options, sliding thumb) ·
`Tabs variant="underline|segmented"` (underline for pane navigation with a neutral `fg` indicator; segmented
shares SegmentedControl's track and thumb).

### Surfaces and feedback

`Card variant="raised|flat|inset" interactive` · `floatingSurface` (frosted glass, r10, elev-2, origin-aware
pop) for custom popovers · `Popover sideOffset` · `Tooltip` (500ms delay, instant when moving between triggers,
r6, optional `hotkey`) · `Kbd` · `ScrollArea` (overlay thumbs on both axes) · `Skeleton` / `Shimmer` / `Spinner` ·
`EmptyState` · `Mark` · `Avatar` · `AnsiText` · `Markdown`/`CodeView`/`CopyButton`/`Collapse` (props unchanged).

### Engine output and commands

- **Process log** (`settings/process-log.tsx`, installs, updates, MCP auth): a calm status card. The header reads
  "Running" / "Done · 12:04" (or the caller's `doneLabel`, e.g. "Updated") / "Failed · 12:04", with the last
  friendly status line under it. Raw output and the exact command (`detail`) sit in a "Details" disclosure that
  is collapsed by default and opens by itself on failure; the well is `bg-surface-1`, mono, with a 16px top fade.
  Cancelling is a ghost "Cancel" button.
- **`EngineCommand`** (`launch/parts.tsx`): the engine command line behind a "Show engine command" disclosure with
  a copy button. Never print the command inline; Launch options and the inspector Overview both use it.
- Extension, package and flag labels go through `friendlyExtensionName` / `friendlyFlagName` (or the
  `displayName` / `groupLabel` main provides); the technical name is secondary text or a tooltip.

## 5. Shell contracts

- **Titlebar** (shell): Vengeance mark · sidebar toggle (no resting fill, hidden on first run) · workspace crumb |
  centered search pill | background-activity `Pill` (neutral; warning only when a session needs input) ·
  `UpdatesPill` slot (lazy). **There is no inspector toggle in the titlebar.** The chat lane puts it in the
  session header toolbar (SPEC §9.1), next to the pane it opens.
- **Workbench**: the center pane and inspector share one raised surface (r10 top-left only while the sidebar is
  open). The inspector is separated by a `hairline-soft` rule, so corners never jump when panels toggle.
  Inspector and session header heights must both be `--pane-header-h`.
- **`--composer-h`**: the session pane element carries `data-session-pane`, with a default of 132px in
  globals.css. The Composer must write its measured height inline on that element:
  ``root.closest('[data-session-pane]')?.style.setProperty('--composer-h', `${h}px`)`` (ResizeObserver).
  Transcript bottom padding and the jump pill offset derive from that variable.
  The shell mirrors the value for toasts.
- **Window blur**: use the `window-blurred:` Tailwind variant (e.g. `window-blurred:opacity-60`) for chrome that
  should dim while the window is in the background.
- **Panel resize** commits once on pointer up, so there is no prefs write per mouse move.
- **Lazy surfaces**: Settings, Onboarding, Inspector (on first open), the Updates pill and sheet, and the
  design gallery are split chunks. Feature lanes should lazy-load their own heavy, rarely visible surfaces the
  same way: `ShortcutsSheet` (palette), `Lightbox` (chat), `FilePreviewDialog` (inspector), and the `diff`
  model (tools). Use `const X = lazy(() => import('./X').then((m) => ({ default: m.X })))` inside
  `<Suspense fallback={…skeleton…}>`.

## 6. Do / don't

- ✅ One primary button per surface. ❌ Two ember CTAs side by side (e.g. "Open page" + "Continue": make one
  `secondary`).
- ✅ Neutral badges for scope, kind and count. ❌ Ember or red "Scope", "EXT", "Live" or override badges
  (override → `info`).
- ✅ `ListRow` for every list. ❌ New ad-hoc row heights or radii.
- ✅ `Dialog` presets for every modal. ❌ A custom `RDialog` shell with its own width, top offset or overlay.
- ✅ Token radii and elevations. ❌ `rounded-[7px]` or a hand-rolled `shadow-[var(--highlight),0_0_0_1px…]`
  (use `shadow-elev-1/2/3`).
- ✅ `text-fg-3` for metadata. ❌ `text-fg-4` for anything a user must read.
- ✅ Spring presets. ❌ Inline `{ type: 'spring', stiffness: … }`.
- ✅ `--focus-color` / `shadow-focus`. ❌ Ember focus rings (they read as validation errors).
- ✅ Light-theme variants for every custom color (console, code, diff). ❌ A near-black console on Bone.

## 7. Feature review checklist

Use these checks when changing a feature. They describe the target conventions, not an outstanding
migration backlog; current implementation and qualification status live in the source and release reports.

- **chat**: header `h-[var(--pane-header-h)]`, right toolbar (`IconButton sm`: fork, export, divider,
  inspector toggle); transcript padding and jump pill from `--composer-h`; neutral focus on the rename input
  (`shadow-focus`); `rounded-sm` → `rounded-md` on rows; recent-sessions list → `ListRow`.
- **tools**: Badges for RUN/TS (`info`/neutral, sentence case); light `--console-*` variables; nested cards
  borderless; drop `rounded-[Npx]`; lazy-load the `diff` model.
- **composer**: write `--composer-h`; send/steer = `Button variant="primary"` look (disabled is neutral
  automatically); glow on `--accent-2`; SuggestionMenu rows → `listRowClass({ density: 'list' })`, kinds as
  `text-2xs text-fg-3` suffixes, a single group label.
- **extension-ui**: `DialogFrame` → `Dialog` (size preset, `icon`, `hint`, `persistent`); neutral countdown
  ring (`fg-3`, `warning` under 5s); StatusChips → `Chip`/`Badge` neutral.
- **palette**: rows → `listRowClass` + `ListRowContent` (`rich` for models, `list` otherwise); top offset =
  `calc(var(--titlebar-h) + 8px)`; z via `--z-modal`; ShortcutsSheet → `Sheet side="full"` + lazy.
- **sessions**: rows → `listRowClass({ density: 'rich', selected })`; workspace count `Badge` neutral;
  SessionDialogs → `Dialog size="confirm"|"picker"` + `icon`; pinned glyph 12px `fg-3`.
- **inspector**: header `h-[var(--pane-header-h)]`; collapsed tab badge = 6px dot; extension command names
  `font-mono text-fg-2`; Overview "Thinking" badge neutral; lazy `FilePreviewDialog`.
- **settings**: override pill and dot → `info`; drop the "Live" badges (show "Requires restart" only where it
  applies); one primary in the auth flow; `Input`/`fieldClass` for fields; `Switch` already uses `control-on`;
  content `max-w-[720px]`; theme card selection ring neutral `fg` (not ember).
- **onboarding**: `spring.gentle`/`spring.smooth` presets; shorter delays; completed checks `success`.
- **updates**: pill → `Pill indicator="dot"` (neutral; `indicator="spinner"` while running); sheet →
  `Sheet side="full"`; neutral version text.
