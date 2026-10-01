# Implementation Plan: Obsidian UI Redesign

> HISTORICAL / SUPERSEDED: Do not resume this feature-addition plan for the new redesign. Use [REDESIGN-MASTER-PROMPT.md](../../../REDESIGN-MASTER-PROMPT.md) for the UI-only MNTools visual redesign and capacity for 35 future tools. Completed task records and baseline artifacts remain historical evidence, not restrictions on the new appearance or permission to add tools.

## Overview

The plan implements the design in its eight Milestones, preceded by a test-harness task. Work is ordered so that every top-level task ends with `npm test` inside the Test_Baseline (at most the 5 listed failing suites and 9 failing tests, with at least 130 suites and 1,587 tests), checked with `tests/helpers/compare-test-baseline.js` (Req 3.1, 3.2). The Composed_Markup helper and the switch of the 12 markup-reading tests land first, while `index.html` is still unchanged, so the later Shell split changes markup only. New modules are built and unit-tested in one task and wired into the Shell in the next. `js/core/` receives only added lines: the `global.comp-monitor-info` bridge registry entry and three settings keys (Req 1.7).

Languages: JavaScript (ES2020, classic scripts, no transpiler) for the Panel under `js/`, ExtendScript (ES3) for the Host under `jsx/`, Jest 29.7.0 with fast-check 3.22.0 for tests. Sub-tasks marked "[Manual]" are Maintainer steps in After Effects and are not run by the coding agent.

## Tasks

- [x] 1. Test harness and Test_Baseline guards (before Milestone 1)
  - [x] 1.1 Record the Test_Baseline and write the comparison script
    - Run `npx jest --json` on the unmodified repository and write `tests/fixtures/obsidian-test-baseline.json`: suite and test totals, the 5 failing suite files, the full names of the 9 failing tests, and a list of suites recorded as `flaky` (see the next bullet)
    - Re-run each failing suite file once; a suite that passes on the re-run is recorded as `flaky`, not as a baseline failure. Stop and ask the user only if the totals are below 130 suites or 1,587 tests, or if a stably failing suite is not one of the five Test_Baseline suites (`performance/contract-baseline`, `media-card-lifecycle-exploration`, `catalog-patch-ordering-exploration`, `media-card-lifecycle-preservation.property`, `metadata-cache-currency`); a Test_Baseline suite that now passes is fine
    - Snapshot the current `js/core/*.js` files byte for byte into `.kiro/specs/obsidian-ui-redesign/baseline/js-core/`, outside `tests/` and `js/` so no test or scanner reads them; the working tree has uncommitted `js/core/` changes, so a git commit is not a usable reference
    - Write `tests/helpers/check-js-core-additive.js`: for every file in that snapshot, every snapshot line still appears in the current `js/core/` file in the same relative order (additions only); exits non-zero and prints the file and the first missing line otherwise; files new in `js/core/` are allowed
    - Write `tests/helpers/compare-test-baseline.js`: `node tests/helpers/compare-test-baseline.js <jest-json>` exits non-zero and prints the extra failures when a failing suite or test is not in the fixture (matched by suite file and full test name), or when the suite or test count falls below 130 or 1,587; before reporting, it re-runs once every failing suite file that is outside the fixture and reports it only if it fails again, printing which suites were retried
    - _Requirements: 3.1, 3.2, 20.1, 20.2_
  - [x] 1.2 Capture the pre-redesign dispatcher fixture
    - Copy `runToolkitAction` verbatim from the untouched `js/toolkit/toolkit.js` into `tests/fixtures/toolkit-dispatch.pre-redesign.js`, with a loader that evaluates it in a VM realm against a recording ToolBridge and recording Panel-side handlers (`paste`, the five `effect-*` keys)
    - It is taken now, before any redesign edit, so it is the exact pre-redesign oracle that Property 2 compares against in Milestone 4
    - _Requirements: 1.2, 1.3_
  - [ ]* 1.3 [Manual] Record the pre-redesign reference run in After Effects
    - Maintainer step with the current Panel: measure `startup.init` start to `startup.readiness` end over 5 consecutive opens on one machine and template library, and run every Existing_Capability once on a saved test project, noting each observable result; keep both records for Milestone 8
    - _Requirements: 19.6, 20.5_
  - [x] 1.4 Add the Composed_Markup helper to `tests/helpers/static-analysis.js`
    - Add `VIEWS_DIR`, `viewManifest()`, `composeMarkup(options)`, `listMarkupFiles()` and `ComposeError` (with `code`, fragment and mount) per the design's Helper API and composition algorithm: one `data-view-mount` per manifest entry, whitespace-only mounts, BOM stripping, the fragment rules (no `<script>`, `<link>`, `<style>`, `<html>`, `<head>`, `<body>`, doctype, `on*=` attribute or `data-view-mount`), insertion from the end of the Shell backwards, no caching and no line-ending rewrite
    - Error codes `MOUNT_MISSING`, `MOUNT_DUPLICATE`, `MOUNT_NOT_EMPTY`, `MOUNT_UNKNOWN`, `FRAGMENT_MISSING`, `FRAGMENT_EMPTY` and `FRAGMENT_FORBIDDEN`, each message naming the fragment or mount
    - `composeMarkup` accepts `{ shellText, readFragment, manifest }` for in-memory fixtures. `viewManifest()` requires `js/ui/view-loader.js` and returns `[]` while that file does not exist, so until task 5 `composeMarkup()` returns `index.html` unchanged and `listMarkupFiles()` returns `["index.html"]`; once the Shell has mounts, a missing loader surfaces as `MOUNT_UNKNOWN`
    - _Requirements: 3.10, 3.11_
  - [ ]* 1.5 Write property test for the Composed_Markup helper
    - **Property 3: Composed_Markup is deterministic and fails loudly**
    - **Validates: Requirements 3.10, 3.11**
    - `tests/compose-markup.property.test.js` with in-memory Shells of 1 to 8 mounts; the repository example (every class-contract baseline id exactly once) lands in 5.6, because `flow-target-toggle` stays duplicated until the split
  - [x] 1.6 Switch the 12 markup-reading tests and the baseline generator to the Composed_Markup
    - Replace only the lines that load `index.html` with `SA.composeMarkup()` at module scope (or `SA.listMarkupFiles()` for the two `renderIcons` scanners) in `accent-picker`, `accent-theme`, `class-contract`, `colorflow-target`, `component-invariants`, `header-contract`, `panel-script-manifest`, `templates-contract`, `textanim-layout`, `toolkit-contract`, `media-card-lifecycle-exploration` and `media-card-lifecycle-preservation.property`; switch `tests/helpers/generate-baseline.js` the same way
    - Keep every assertion and expected value; confirm with the compare script that the failing set of the two `media-card-lifecycle` Test_Baseline suites is unchanged
    - _Requirements: 3.5, 3.10, 3.11, 3.12_
  - [ ]* 1.7 Write the skip-marker guard test
    - `tests/test-inventory.test.js`: no `.skip`, `.only`, `xit`, `xtest` or `xdescribe` in `tests/` beyond the one `test.skip` already in `catalog-patch-ordering-exploration.test.js`; the name inventory is added in 24.4
    - _Requirements: 3.2_
  - [ ]* 1.8 Write property test for the Bridge codecs
    - **Property 1: Bridge round trip and length**
    - **Validates: Requirements 2.2**
    - `tests/obsidian-bridge-roundtrip.property.test.js` over the unchanged `js/core/bridge.js` and the host codec from `jsx/core.jsx`, 100 runs for the 10,000-unit strings
    - _Requirements: 2.1, 2.2_

- [x] 2. Milestone 1: Design_Tokens, accent derivation and the tokens-only CSS framework
  - [x] 2.1 Align `css/tokens.css` with the master token block
    - Declare `color-scheme: dark` and the master block on `:root`: correct the 13 differing declarations, set `--cs-accent-default: #3b82f6` and `--cs-accent: var(--cs-user-accent, var(--cs-accent-default))`, move the channel defaults to 59, 130, 246, and write `--cs-accent-subtle`, `--cs-accent-glow` and `--cs-border-focus` as `rgba()` over the channel tokens; never declare `--cs-user-accent`
    - Remove the remote Google Fonts `@import`; the font stacks keep Inter and JetBrains Mono first with system fallbacks
    - Add the new tokens `--cs-on-accent`, `--cs-glass-blur`, `--cs-scrim`, `--cs-scrim-strong`, `--cs-shimmer`, `--cs-shimmer-dim`, `--cs-scrollbar-thumb`, `--cs-scrollbar-thumb-hover`, `--cs-h-btn`, `--cs-h-ico`, `--cs-h-field`, `--cs-h-opt`, `--cs-gap-card`, `--cs-rail-ico`, `--cs-nav-ico-stroke`, `--cs-sidebar-width-narrow`, `--cs-toast-info`, `--cs-toast-info-border` and `--cs-duration-reduced` (if not declared yet); point `--cs-focus-ring` at `var(--cs-accent)`; declare the 16 referenced-but-undeclared names from the design table
    - Delete the 16 dead legacy alias redeclarations in `tokens.css`; keep the `--logo-flask` and `--logo-glow` declarations in `header.css` (user decision: they are the only declarations of those names, so they are not redeclarations and stay); leave the `base.css` `:root` untouched
    - _Requirements: 3.8, 5.1, 5.2, 5.3, 5.8, 19.6_
  - [x] 2.2 Derive the Obsidian accent tokens in `js/ui/accent.js`
    - Add `CS_INLINE_KEYS`, `CS_RETIRED_KEYS`, `isKnownSelection`, `shiftL` and the pure, exported `computeObsidian(hex)`; `apply` writes `--cs-user-accent` (lowercase `#rrggbb`), the three channel tokens, `--cs-accent-hover` (HSL lightness +0.07) and `--cs-accent-active` (−0.09) for every selection, `blue` included, and removes stale inline `--cs-accent`, `--cs-accent-subtle`, `--cs-accent-glow` and `--cs-border-focus`
    - An unknown preset or an invalid custom hex resolves to `#4f8cff`, with no Settings write and no toast; `_clearOverrides` clears only the legacy keys
    - Keep the presets, the setting defaults, the `Settings.onChange` live updates and every source pattern `accent-theme` and `accent-picker` check; `Accent.init()` stays in `init()`; end with the CommonJS guard
    - _Requirements: 2.9, 5.4, 5.5, 5.6, 5.9, 5.10_
  - [ ]* 2.3 Write property test for accent derivation
    - **Property 4: Accent tokens follow the selection**
    - **Validates: Requirements 5.4, 5.9, 5.10**
    - `tests/accent-obsidian.property.test.js`, with the `:root` token resolver in `tests/helpers/token-resolver.js`
  - [x] 2.4 Load each linked stylesheet once
    - In `css/base.css`, delete the `.cs-segmented` and `.cs-segment` declarations that `components.css` also sets (they lose the cascade today); then remove the `@import`s of `sidebar.css`, `components.css`, `command-palette.css` and `media-engine.css` from `css/layout.css`; keep the 11 `css/style.css` imports and their order unchanged
    - _Requirements: 3.6, 3.8, 4.3_
  - [x] 2.5 Move the redesigned stylesheets to tokens only and apply the shared control scale
    - Replace every literal color, non-zero pixel radius, font family and `font` shorthand in `layout.css`, `components.css`, `sidebar.css` and `command-palette.css` with `var(--cs-…)` tokens (the scrim, shimmer, scrollbar and radius tokens of 2.1)
    - Shared primitives in `components.css`: labeled `.cs-btn` variants get `min-height: var(--cs-h-btn)` and `--cs-radius-lg`; `.cs-btn--icon`, `[data-icon-only="true"]` and the new `.cs-icon-btn` are 28px squares; `.cs-field__control` and `.cs-select__control` get `min-height: var(--cs-h-field)`
    - On accent fills, switch text and icons to `--cs-on-accent` in the rules the design lists (the `components.css` primary family, `base.css` `.cs-btn-primary`, `.btn-neon-outline:hover` and `.modal-buttons button:last-child`, the `flow.css` Flow Apply rule, the `settings.css` and `colorflow.css` `--accent-on-color` rules), and turn the gradient fills in `toolkit.css`, `effects.css` and `templates.css` into flat `--cs-accent` with `--cs-accent-hover` on hover
    - Move text uses of `--cs-text-muted` and `--cs-text-disabled` in `base.css`, `command-palette.css`, `components.css`, `flow.css`, `header.css` and `sidebar.css` to `--cs-text-secondary`, keeping the two tokens only on icon or mark selectors and disabled states
    - _Requirements: 5.7, 6.2, 18.5, 18.10_
  - [ ]* 2.6 Write property test for the tokens-only checker
    - **Property 5: Redesigned stylesheets use tokens only**
    - **Validates: Requirements 5.7**
    - `tests/tokens-only-lint.property.test.js` over the checker in `tests/helpers/token-lint.js`
  - [ ]* 2.7 Write unit tests for Milestone 1
    - `tests/tokens-obsidian.test.js`: master values through the resolver, `--cs-accent` resolving to `#3b82f6` without `--cs-user-accent`, every referenced `--cs-` name declared on `:root` except `--cs-user-accent`, no name declared in both `tokens.css` and `base.css` or `header.css`, and the tokens-only repository scan over `layout.css`, `components.css`, `sidebar.css`, `command-palette.css`, `toast.css` and `modals.css` (the last two once they exist) plus every Obsidian-namespace rule in any stylesheet
    - `tests/on-accent-color.test.js`; the contrast tables and the muted-token color rule in a new `tests/a11y-static.test.js`; the remote-URL and CSS-nesting bans in a new `tests/css-guards.test.js`; the equal-specificity cascade comparison in `tests/stylesheet-cascade.test.js`
    - `tests/js-syntax-guard.test.js` and `tests/js-modules-load.test.js`, starting with `js/ui/accent.js` (the full module list is added in 24.4)
    - _Requirements: 2.8, 2.9, 4.3, 5.1, 5.2, 5.3, 5.7, 5.8, 18.5, 18.10_

- [x] 3. Checkpoint: Milestone 1 complete
  - Run `npm test`, write the run with `npx jest --json --outputFile=<temp file>` and pass it to `node tests/helpers/compare-test-baseline.js`; run `node tests/helpers/check-js-core-additive.js` to confirm `js/core/` has no removed or changed line, which also keeps the Bridge codec in `js/core/bridge.js` unchanged. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 2.1, 3.1, 3.2, 19.1, 20.1, 20.2_

- [x] 4. Milestone 2: Standalone Shell modules (startup gate, router, Sidebar, focus manager)
  - [x] 4.1 Create `js/ui/startup-gate.js`
    - `StartupGate` with `arm()` and gates G1 and G2 opened from `PerfEvents` `lifecycle.transition` events and `AppLifecycle.getState()` per the design table (G1: first paint of the active Route; G2, the Host_Call_Gate: a state at or after `FIRST_CARD_USABLE`, or a `templates.cold-scan.complete` event with `templateCount` 0), the `lifecycleV1 === false` path (both open on the first frame after bootstrap), open-once state, and callbacks that run at once when registered after opening
    - In `js/templates/templates.js`, emit `templates.cold-scan.complete` with `{ templateCount }` through `PerfEvents.emit` once the cold scan of every library root has settled, `typeof`-guarded
    - _Requirements: 8.14, 8.17, 19.3, 19.4_
  - [ ]* 4.2 Write unit tests for the startup gate
    - `tests/startup-gate.test.js`: each opening condition, the zero-template event, `DEGRADED`, late registration, the legacy path
    - _Requirements: 8.14, 8.17, 19.3, 19.4_
  - [x] 4.3 Create `js/ui/shell-router.js`
    - `CompSaverRouter` creates one `CompSaverShellState` instance and registers the 7 route adapters from the `makeAdapter` factory: `ensureMounted` before any side effect, `VIEW_UNAVAILABLE`, `showOnlyMount`, the startup and rollback legacy-switch rules with `lastLegacyRoute`, `restore` and patch hooks, and `handleAction` through `spec.actions`
    - `current()`, `go(route, { source })` (never throws; `{ ok: false, code, message }` after the rollback; route-local fallback write-back after `navigate` returns; `onChange` listeners; `CompSaverFocus.check("route")` behind `typeof`), `onChange(fn)` and `back()` (the Route active before Settings, else `templates`)
    - The views loader, Shell_State, legacy switches and focus manager are injectable so Jest runs the router without a DOM; CommonJS guard
    - _Requirements: 4.12, 7.2, 7.3, 7.4, 7.9, 7.10, 7.11, 9.5, 9.6_
  - [x] 4.4 Create `js/ui/sidebar.js`
    - `CompSaverSidebar` with `ITEMS` (8 items in Sidebar order, the Commands trigger with `route: null`), `init(deps)` binding one `click` listener per item, `activate`, `applyRoute` (exactly one `aria-current="page"`), `itemForRoute` and `focusActive`
    - The active Route's item does nothing; Commands calls `CommandPalette.open()` with no router call; a failed navigation shows `✕ Couldn't open <label>. Reload the panel to try again.` after the rollback
    - _Requirements: 6.5, 7.1, 7.2, 7.3, 7.5, 7.9, 7.10, 7.11, 18.8_
  - [ ]* 4.5 Write property test for the Sidebar and router
    - **Property 6: The Sidebar marks exactly the active Route**
    - **Validates: Requirements 6.4, 7.3, 7.10, 7.11**
    - `tests/sidebar-router.property.test.js` over `sidebar.js`, `shell-router.js` and `shell-state.js` with fake adapters that can throw
  - [ ]* 4.6 Write unit tests for the Sidebar and router
    - `tests/sidebar.test.js`: startup `aria-current`, the Colors item, the Commands trigger, `VIEW_UNAVAILABLE` rollback without a legacy reset, `back()`
    - _Requirements: 4.12, 7.4, 7.5, 7.9, 7.10_
  - [x] 4.7 Create `js/ui/focus-manager.js`
    - `CompSaverFocus` with the base, keyboard and composite key sets; pure `keyInterestFor(set, platform)` with the Windows and macOS virtual key codes (Shift+Tab, Shift+Enter and Shift+Space included); `registerKeyEventsInterest` only when the set changes; delegated Enter and Space for `role="button"` elements that are not native buttons (Space clicks on `keyup`)
    - `check(reason)` focus recovery (the palette input, the active FocusTrap container, else `CompSaverSidebar.focusActive()`; a control disabled only while its own call runs counts as usable), `prefersReducedMotion()` and `onReducedMotionChange(fn)`
    - _Requirements: 9.4, 16.1, 18.1, 18.7, 18.8, 18.9_
  - [ ]* 4.8 Write unit tests for the focus manager
    - `tests/focus-manager.test.js`: `keyInterestFor` per platform, modality switches, recovery targets, the busy exemption, Space on `keyup`
    - _Requirements: 18.8, 18.9_

- [x] 5. Milestone 2: Split `index.html` into the Shell and View_Fragments and wire startup
  - [x] 5.1 Create `js/ui/view-loader.js`
    - `CompSaverViews` with the frozen 8-entry `MANIFEST` (`overlays`, `templates`, `tools`, `colorflow`, `effects`, `easing`, `text`, `settings`, with their files, `cs-route-<route>` or `cs-overlay-root` mounts and labels), `begin`, `mountSync`, `ensureMounted`, `whenMounted`, `onMounted`, `startDeferred` (next frame, one fragment per macrotask in the design order, timers registered with `AppLifecycle`), `getState`, `getFailure` and `configure({ readText })`
    - Read with `window.cep.fs.readFile`, falling back to `require("fs").readFileSync`; strip a BOM; map failures to `missing`, `unreadable`, `empty` and `not-inserted` (5,000 ms watchdog); on failure keep the mount empty, drop its queue, hold one error toast per fragment until `DOM.toast` exists and emit `views.mount.failed`; record the `startup.views` span; nothing throws and nothing is logged at error level
    - _Requirements: 4.6, 4.10, 4.11, 19.2, 19.6_
  - [ ]* 5.2 Write unit tests for the view loader
    - `tests/view-loader.test.js` with a fake reader: each failure kind, exactly-once injection, the `whenMounted` drop on failure, the watchdog, held toasts, the deferred order
    - _Requirements: 4.6, 4.10, 4.11_
  - [x] 5.3 Move the route markup into `views/*.html` and reduce `index.html` to the Shell
    - Create `overlays.html` (first line `<!-- SAVE MODAL -->`), `templates.html`, `tools.html` (today's `#toolkit-tools-view` without the ColorFlow card), `colorflow.html` (`#toolkit-colorflow-view` around `#colorflow-card`), `effects.html`, `easing.html`, `text.html` (first line the TEXT ANIMATION marker) and `settings.html`, moving the markup unchanged apart from the fixes below
    - Rename the Flow view toggle to `id="flow-apply-target-toggle"` and change the `js/toolkit/flow.js` selector to `#flow-apply-target-toggle [data-flow-target]`, so the ColorFlow toggle keeps `flow-target-toggle` and every baseline id appears once
    - Shell per the design outline: the Sidebar first (8 `cs-sidebar-item` buttons with `data-sidebar-route`, `aria-label`, icon and label, and 1 divider; new ids `btn-sidebar-colors` and `btn-sidebar-palette`; `btn-sidebar-help` and the version badge removed), then the HEADER marker with today's Header, `#toolkit-module` holding the `tools`, `colorflow`, `effects`, `easing` and `text` mounts, the SETTINGS and TEMPLATES markers with their mounts, the overlay root, the palette overlay, the toast surface and `.cs-legacy-hooks` with `#sidebar-tk-switcher` and `#sidebar-tpl-switcher`
    - Script manifest per the design table: `ui/view-loader.js`, `ui/startup-gate.js` and `ui/shell-state.js` right after `ui/toast.js`, and `ui/shell-router.js` and `ui/sidebar.js` after `ui/command-palette.js`; each `src` listed once
    - _Requirements: 1.6, 3.3, 3.4, 3.5, 4.1, 4.2, 4.5, 4.7, 4.8, 4.9, 7.1, 7.6, 7.7_
  - [x] 5.4 Rewrite `css/sidebar.css` and add the Shell grid and mount rules
    - Sidebar values from the design: 56px rail with an inset hairline shadow, 40px min-height items, 18px icons at stroke 1.8, 7px uppercase one-line labels, hover state, the `[aria-current="page"]` accent plate as the only highlight, a 1px focus offset and no `outline: none`
    - `layout.css`: the `.cs-app` grid with the Standard areas, `.app-sidebar` reduced to its grid placement, `.cs-route:not([hidden])` as a flex column and no `display` on `.cs-route` outside `:not([hidden])`; tokens only
    - _Requirements: 5.7, 6.3, 6.4, 7.8, 18.2, 18.3_
  - [x] 5.5 Wire the startup sequence and the new modules
    - `js/main.js`: steps 1 to 10 of the design's startup sequence: `CompSaverViews.begin()`, `StartupGate.arm()`, the start Route resolved before `init()` with the Sidebar-order fallback, `mountSync("overlays")` and the start Route, a guarded `whenViewMounted` helper around the fragment-bound init calls (`initSequencerControls`, `ColorFlow.init`, `loadSavedEffects`, `TextAnim.init`, `SettingsPanel.init`, the templates warm paint and toolbar bindings) keeping each call site single, `onMounted` running `cacheDOM()` and `bindToolkitActionControls(root)`, the router start with `source: "startup"`, `mountSync("templates")` right after `SHELL_VISIBLE`, and `startDeferred()`; every new call is `typeof`-guarded and `Accent.init()` stays in `init()`
    - `js/toolkit/toolkit.js`: `bindToolkitActionControls(root)` with a `WeakSet`, keeping the literal `root.querySelectorAll("[data-toolkit-action]")` and the `dataset` reads; `initToolkitNav()` binds the Shell and wraps its Flow calls in `whenViewMounted("easing", …)`
    - `js/ui/header.js`: `switchToolkitSubSection` shows `toolkit-colorflow-view` for `"colorflow"`, `updateSidebarNavState` and `switchMainModule` stop writing Sidebar state, and `initSidebarNav()` delegates to `CompSaverSidebar.init()`; `js/ui/settings-panel.js`: Back calls `CompSaverRouter.back()` with the old call as fallback
    - _Requirements: 1.1, 1.6, 4.6, 4.11, 4.12, 5.5, 7.3, 7.4, 7.9, 15.9, 19.1, 19.2_
  - [ ]* 5.6 Write structure tests for the split
    - `tests/shell-structure.test.js` (at most 300 lines, one empty mount per manifest entry, the six region markers once and in order, overlay root, palette and toast present, every baseline id exactly once in the Composed_Markup); `tests/view-fragments.test.js` (static markup only); `tests/sidebar-guard.test.js` (8 items and 1 divider in order, the 8 ids once, non-empty names, no `main-nav-btn`, `section-btn`, `switcher-label` or `switcher-overflow__summary` inside `#app-sidebar`, no `cs-sidebar` selector in `responsive.css` or `polish.css`)
    - _Requirements: 3.3, 4.1, 4.2, 4.6, 7.1, 7.6, 7.7, 15.2_

- [x] 6. Milestone 2: Header and Comp_Monitor
  - [x] 6.1 Add the `csActiveCompInfo` Host query
    - Create `jsx/workbench.jsx` (ES3, declarations only) with the read-only `csActiveCompInfo()`, which returns `OK:{"comp":false}` or `OK:{"comp":true,"name":…,"width":…,"height":…,"fps":…}` as a Bridge_Payload and an error string on exceptions; include it in `jsx/compSaver.jsx` right after `text.jsx`
    - Add the `global.comp-monitor-info` entry for the named function `csActiveCompInfo` to `js/core/bridgeRegistry.js` as new lines only, leaving `global.comp-monitor` and the inline-expression count unchanged
    - _Requirements: 1.7, 2.4, 2.7, 8.4, 8.5_
  - [ ]* 6.2 Write Host tests for `csActiveCompInfo`
    - `tests/workbench-host.test.js` (a comp, no comp, a throwing `app`) through `loadHelpers({ lenient: false })`; `tests/host-static.test.js` with the ES3 token scan over `jsx/workbench.jsx`
    - _Requirements: 2.4, 2.7, 3.13_
  - [x] 6.3 Rebuild the Header markup and styles
    - Header per the design: `.cs-hdr` with the status dot (`data-state`, `role="img"`, label), the `COMPSAVER` wordmark in one `nowrap` group with the dot, `btn-hdr-purge` (`data-toolkit-action="cache"`) and `btn-hdr-truedup` (`truedup`) as 28px `.cs-icon-btn` buttons with action names, the hidden legacy hooks kept inside the Header, and `#monitor-active-comp` as a `.cs-comp-monitor` button with name and meta spans; keep `class="header"`, `class="hdr-status"` and every id and class `header-contract` pins
    - `layout.css`: the reset of the legacy `.header` box, the two rows with row 1 wrapping, the name-only ellipsis, the pill, the dot states with the pulse ring (removed under reduced motion) and the `.cs-hdr .brand-title` color; tokens only
    - `js/ui/header.js`: `CompSaverHeader.setStatus(state)`; make `btn-search-toggle` a hidden hook by removing its bindings in `js/main.js` and `js/ui/command-palette.js`
    - _Requirements: 3.5, 4.1, 5.7, 8.1, 8.2, 8.3, 8.9, 8.10, 8.13, 8.16, 18.4, 18.6_
  - [x] 6.4 Rebuild `js/ui/comp-monitor.js`
    - `CompMonitor` with `refresh(reason)` (single flight, `callHost("csActiveCompInfo()", { timeoutMs: 2000 })`, automatic reasons dropped while G2 is closed), pure `parseCompInfo`, `formatFps`, `formatReadout` and `nextState`, `configure` seams, `textContent` rendering with `title` and `aria-label`; the global `updateActiveCompMonitor()` calls `refresh("legacy")`; a click or Enter or Space refreshes with reason `click`
    - `js/main.js`: remove `updateActiveCompMonitor()` from `init()` and call `CompMonitor.refresh("startup")` when G2 opens
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 8.14, 8.16, 8.17, 19.4_
  - [ ]* 6.5 Write property test for the readout format
    - **Property 7: Comp readout format**
    - **Validates: Requirements 8.4**
    - `tests/comp-monitor.property.test.js`
  - [ ]* 6.6 Write property test for the monitor status and single flight
    - **Property 8: Comp_Monitor status and single flight**
    - **Validates: Requirements 8.2, 8.3, 8.5, 8.8, 8.17**
    - Added to `tests/comp-monitor.property.test.js`
  - [ ]* 6.7 Write unit tests for the Comp_Monitor and the Header status
    - `tests/comp-monitor.test.js`: rendering, dot states through `CompSaverHeader.setStatus`, the query when G2 opens, the legacy caller
    - _Requirements: 8.6, 8.14, 8.16_

- [x] 7. Milestone 2: Focus management, responsive modes and the CEP manifest
  - [x] 7.1 Wire the focus manager and the accessibility overrides
    - List `ui/focus-manager.js` right after `ui/shell-router.js` in the Shell and call `CompSaverFocus.init()` from `init()` behind `typeof`, registering the base key set
    - `layout.css`: the `:focus-visible` override (style, width and color `!important`, offset 2px) and the reduced-motion block using `--cs-duration-reduced`, the only two `!important` blocks in the file
    - Give the legacy icon-only buttons in the fragments (`btn-flow-flip-h`, `btn-flow-flip-v`, `btn-flow-reset-graph`, `btn-flow-reset`, the Effects refresh and import buttons) an `aria-label` with the words of their `title`
    - _Requirements: 6.8, 9.4, 16.1, 18.1, 18.3, 18.4, 18.6, 18.7, 18.8, 18.9_
  - [x] 7.2 Implement the responsive modes and the Workbench column bands
    - Narrow (`max-width: 279.98px`), Standard and Wide (`min-width: 550.02px`) rules: the Narrow grid areas with the Header across both columns, the icon-only Sidebar at the constant 56px width, and the text-fitting rules (2-line clamps, 1-line ellipsis, `min-width: 0`, viewport-capped widths, `overflow-x: hidden` on view scrollers)
    - `.cs-wb-grid` bands in `toolkit.css` (1, 2, 3, 4, 5 and 6 columns from 180, 220, 280, 420, 760 and 940px); the Flow view `@media (max-width: 550px)` block in `flow.css`; remove the `.ta-grid` gap rule from `responsive.css` and keep every rule `responsive-grid` checks; `.cs-app` sets body padding and gap to 0
    - `shell-router.js`: keep Shell_State `responsiveMode` in step through `matchMedia` listeners (with the `addListener` fallback), retried on the next frame when a change arrives during a transition
    - _Requirements: 7.8, 8.13, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9_
  - [ ]* 7.3 Write property test for column counts
    - **Property 25: Column counts never drop as the panel widens**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.6**
    - `tests/responsive-columns.property.test.js`, modelling every Card_Grid and Workbench grid from the declared CSS at 180 to 1200px every 5px plus 279.98, 280, 550 and 550.02px
  - [x] 7.4 Raise the CEP runtime minimum
    - `CSXS/manifest.xml`: `<RequiredRuntime Name="CSXS" Version="11.0"/>` and the AEFT host range `[22.0,99.9]`
    - _Requirements: 2.8, 2.12_
  - [ ]* 7.5 Write the remaining Milestone 2 structure tests
    - `tests/cep-manifest.test.js`; `tests/shell-manifest.test.js` (script order and uniqueness, `pathBuilders.js` before `utils.js`, `bridge.js`, `toolBridge.js` and `toast.js` before any top-level caller, `tokens.css` linked first, every stylesheet loaded once)
    - Extend `tests/css-guards.test.js` (`display` only under `:not([hidden])` for `.cs-route`, `.cs-wb-panel`, `.cs-fx-panel`, `.cs-fx-card`, `.cs-notify` and `.cs-legacy-hooks`; no `order`, `row-reverse`, `column-reverse` or `grid-auto-flow: dense`; `!important` in `layout.css` only inside its two blocks; mode `display: none` rules hide no focusable element) and `tests/a11y-static.test.js` (no positive `tabindex`, names of icon-only controls, the reduced-motion block)
    - _Requirements: 2.12, 4.3, 4.7, 4.8, 4.9, 15.5, 18.1, 18.2, 18.4, 18.6_

- [x] 8. Checkpoint: Milestone 2 complete
  - Run `npm test` and the compare script as in task 3, confirm every `tests/performance/` suite that passes in the Test_Baseline still passes, and run `node tests/helpers/check-js-core-additive.js`. Tell the user that the `performance/contract-baseline` hash pin of `index.html` belongs to another spec and is left untouched. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 19.1, 20.1, 20.2_

- [x] 9. Milestone 3: Toast_Engine, notifications and the feedback policy
  - [x] 9.1 Rebuild `js/ui/toast.js`
    - IIFE `CompSaverToast` that keeps the globals `showToast(msg, type)` and `clearToast()`: `TYPES`, `ENTER_MS` 150, `DURATION_MS` 2000, `EXIT_MS` 150, `QUEUE_MAX` 8, `HISTORY_MAX` 20, pure `normalizeType`, `displayText`, `ariaFor` and `reduce`, plus `getState`, `getHistory`, `onDisplay`, `prefixNext(match, prefix)` and `configure` seams; timers through the injected `setTimeout`, registered with `AppLifecycle` when present
    - Rendering: icon and text children created once; `role`, `aria-live` and `data-toast-type` set before the text; constant SVG icons; `textContent` only; `hideInstant` for `clear`; return without effect when `DOM.toast` is missing
    - `js/main.js` unload handler: replace the `toastTimer` read with a guarded `clearToast()`; leave `tests/toast.test.js` untouched
    - _Requirements: 8.11, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.12, 14.15_
  - [ ]* 9.2 Write property test for the toast queue
    - **Property 23: Toast queue**
    - **Validates: Requirements 8.11, 14.4, 14.5, 14.6, 14.7, 14.15**
    - `tests/toast-engine.property.test.js`
  - [ ]* 9.3 Write property test for toast types and roles
    - **Property 24: Toast type and live-region role**
    - **Validates: Requirements 14.3, 14.8**
    - Added to `tests/toast-engine.property.test.js`
  - [ ]* 9.4 Write unit tests for the Toast_Engine
    - `tests/toast-engine.test.js` with a fake surface and fake timers: render order, glyph stripping, the missing surface, `prefixNext` consumed or dropped within one task, `clear`
    - _Requirements: 14.3, 14.8, 14.12, 14.15_
  - [x] 9.5 Add `css/toast.css` and `css/modals.css`
    - `toast.css`, with only `#toast`, `.toast` and `.cs-toast-surface*` selectors: fixed bottom-center placement capped at `calc(100vw - 16px)`, glass background and border with paired `backdrop-filter` and `-webkit-backdrop-filter` of `var(--cs-glass-blur)`, wrapping text, four type colors (`--cs-toast-info` for info), 150 ms motion with its reduced-motion variant, the `#toast.toast::before` reset and `--cs-z-toast`
    - `modals.css`, with only modal dialog, backdrop and overlay container selectors: the `.modal-overlay` scrim with the paired blur, and `.modal-content` with 16px padding, `--cs-radius-lg`, a 1px border and a weight-800 title; the legacy rules stay
    - Link both once, after `css/style.css`, in the Shell, and give the toast element `class="toast cs-toast-surface" role="status" aria-live="polite" aria-atomic="true"`
    - _Requirements: 3.7, 3.9, 4.3, 4.4, 5.7, 6.1, 14.1, 14.2_
  - [x] 9.6 Add the Header notifications list
    - Shell: `btn-hdr-notify` (`aria-label`, `aria-expanded`, `aria-controls="cs-notify"`) after the two utility icons, and the `.cs-notify` region with its list and empty-state paragraph
    - `CompSaverHeader.toggleNotifications`, `openNotifications` (renders `CompSaverToast.getHistory()` and subscribes to `onDisplay`, staying at 20 entries), `closeNotifications` and `renderNotifications` (`textContent`, type icon and hidden type word, "No notifications yet"); close on a second click, on Escape unless the palette or a modal is open, and on an outside click; `layout.css` rules with no `display` on `.cs-notify`
    - _Requirements: 8.11, 8.12, 8.15, 8.16, 18.4_
  - [ ]* 9.7 Write unit tests for the notifications list
    - `tests/header-notifications.test.js`: newest first, the 20-entry cap, the empty state, additions while open, the three close rules
    - _Requirements: 8.11, 8.12, 8.15_
  - [x] 9.8 Implement the feedback policy and Quiet rapid tools in `js/toolkit/toolkit.js`
    - Pure `classifyToolkitResult(action, mode, decoded)` with rules 1, 2, 3, R, 4, 5 and 6 in that order; rule R reads `OK:{…}` reports whose `op` equals the action through a formatter table that the Milestone 5 and 6 tasks fill, and may return a `followUp`; the frozen legacy precondition table (crop strings included), the precondition texts per code, the success texts, `ACTION_LABELS`, `toolkitActionLabel(action, mode)` and the 160-character cut
    - `reportToolkitResult(action, mode, result, btn)`, called from ToolBridge's `onResult`: requests the Comp_Monitor refresh for every status, keeps the `effects` `.active` reflection, uses `prefixNext` so ToolBridge's transport error names the action, shows the classified toast and its follow-up, and under Quiet suppresses only the success toasts of `SILENT_SUCCESS_ACTIONS` (the anchor mark or a 600 ms `apply-flash` instead); Host errors are logged with `console.warn`
    - Add `toolkit.quietRapidTools` (boolean, default `false`) to `js/core/settings.js` as new lines only, and a toggle in the Toolkit Defaults section of `js/ui/settings-panel.js`
    - If an existing suite pins a pre-redesign toast kind for an existing action, stop and ask the user instead of editing the assertion
    - _Requirements: 1.7, 1.8, 1.9, 8.7, 14.9, 14.10, 14.11, 14.13, 14.14, 20.3_
  - [ ]* 9.9 Write property test for feedback classification
    - **Property 10: Feedback classification and Quiet rapid tools**
    - **Validates: Requirements 1.9, 11.13, 12.7, 14.9, 14.10, 14.11, 14.13**
    - `tests/toolkit-feedback.property.test.js`; rule R cases are drawn from the formatter table, so formatters added in later tasks are covered without editing the test
  - [ ]* 9.10 Write unit tests for the feedback policy
    - `tests/toolkit-dispatch.test.js`: each legacy precondition string shows as a warning, partial `OK:` results of `anchor` and `align` as info, Quiet on and off, one toast per transport failure with the action prefix, the busy info toast
    - _Requirements: 1.8, 1.9, 14.9, 14.13, 14.14_

- [x] 10. Checkpoint: Milestone 3 complete
  - Run `npm test` and the compare script as in task 3 and run `node tests/helpers/check-js-core-additive.js`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 20.1, 20.2_

- [ ] 11. Milestone 4: Workbench module and the Text Preset Browser source
  - [ ] 11.1 Create `js/ui/toolkit-workbench.js`
    - `CompSaverWorkbench` with `TABS` and `LABELS`, pure `normalizeTab`, `nextTab` and `normalizeInt(raw, min, max, fallback)`, `init(root, deps)`, `select(tab, { focus })` (in one task: `aria-selected`, roving `tabindex`, `hidden` on the other three panels, then `onTabChange`), Left and Right Arrow with wrap-around, `getRestorationPatch()` and `restore(subsection)` returning `{ tab, fellBack }`
    - `.cs-wb-seg` radio groups (roving `tabindex`, arrows move the checked option, Enter or Space checks the focused one) and `optionValue(name)`; no ToolBridge, `callHost` or `evalScript`; CommonJS guard
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 18.1_
  - [ ]* 11.2 Write property test for Workbench tab state
    - **Property 9: Workbench tab state**
    - **Validates: Requirements 9.2, 9.4, 9.5, 9.6**
    - `tests/workbench-tabs.property.test.js` with fake nodes and a fake `tools` adapter
  - [ ] 11.3 Expose the text presets from `js/textanim/textanim.js`
    - Add `getPresets()` (a frozen copy in the order the `text` Route shows under All), `applyPreset(path)` (the existing internal apply) and `onPresetsChanged(fn)`; additions only
    - _Requirements: 12.1, 12.11_
  - [ ] 11.4 Add `TOOL_INDEX`, `runTool` and the Text Preset Browser renderer
    - `TOOL_INDEX` rows `{ id, tab, title, action, mode, run, focus }` for the Existing_Capability tools of the Tool Placement table: anchor cells, Comp-scope align, the precompose family and Crop Precomp, the five `create` modes, Paste Image, Remove Expressions, Sequence & Stagger, Snap to Playhead, Bounce and its settings, the Text Preset Browser, Guides On and Off, and the four Project strip tools; the Milestone 5 and 6 tasks add the new tools
    - `runTool(id, { source })` for `direct`, `control` (the control's own composer path; the "needs the Workbench" error when the control is missing) and `open` (go to `tools`, select the tab, focus the named input)
    - The preset list renders one `data-toolkit-action="text-preset"` button per preset with the path in `dataset.mode`, rebinds through `bindToolkitActionControls(list)`, and shows "No text presets yet" or "Text presets are unavailable"
    - _Requirements: 1.1, 1.5, 12.1, 12.11, 16.2_
  - [ ]* 11.5 Write unit tests for the Workbench module
    - `tests/workbench.test.js`: `normalizeInt` examples, option groups, the three `run` kinds, the missing-control error, the browser states
    - _Requirements: 3.13, 9.7, 11.7, 12.1_

- [ ] 12. Milestone 4: Workbench markup, wiring and dispatcher composers
  - [ ] 12.1 Extend `runToolkitAction` for the Workbench
    - Keep every existing branch, its order and its script strings; add `registerToolkitModeComposer`, `resolveToolkitMode` and the invalid-result path in the bound listener (a toast of the composer's kind, no Host call, inputs untouched)
    - The anchor block selects `[data-toolkit-action="anchor"]` and sets `.active` and `aria-pressed` on exactly one cell before the Host call; the unknown-action fallback `✕ This tool isn't available (<action>)` returns before any Host call; add the frozen `TOOLKIT_TIMEOUTS` table
    - Panel-side keys `crop` (`CropController.start(btn)` replaces the id-bound listener on `btn-tk-crop-execute`; preflight, shared-precomp modal and the 120 s execute unchanged) and `text-preset` (`TextAnim.applyPreset(path)`), both requesting a Comp_Monitor refresh; `PasteController` (`js/ui/paste.js`) and the crop handler pass non-success Host texts through `classifyToolkitResult`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 8.7, 9.9, 9.10, 10.2, 10.6, 10.13, 12.11_
  - [ ] 12.2 Build the Workbench markup in `views/tools.html` and the `.cs-wb-*` styles
    - Tablist with four tabs and four panels (`Layout & Rig` selected, the other panels `hidden`), groups with `h3` titles, tool cards (tile, title, optional description), `data-wb-tool` on every control, and the Project strip after the panels (Organize, Toggle Effects, Purge Cache, and the Resize cluster with `resize-res`, `resize-fps` and `btn-resize-apply`)
    - Layout & Rig: the 3×3 anchor grid (9 cells with `aria-label` and `aria-pressed`), the six align buttons, Smart Precompose, Multi-Precompose, De-compose, Un-precompose, True Duplicate, Crop Precomp (`btn-tk-crop-execute` with `data-toolkit-action="crop"`), Parent Null, Solid, Adjustment Layer, Camera and Text (`create` modes), Paste Image (`btn-paste-image`) and Remove Expressions
    - Velocity: the Sequence cluster (order radio group with `data-seq-mode` `up`, `center`, `random`; the `stepper-seq-step` and `stepper-seq-group` steppers without `readonly`; the Sequence & Stagger button), Snap to Playhead (`data-seq-mode="down"`), and Bounce (`btn-bounce-apply`) with `btn-bounce-gear` beside it; Text: the Text Preset Browser list; Guides: Guides On and Guides Off
    - Keep every class-contract baseline id, class and data attribute; put `data-mode` only on elements with `data-toolkit-action`
    - `toolkit.css`: tabs, panels (no `display`), cards per the anatomy table, tiles, clamps, anchor grid, align row, `.cs-wb-seg`, steppers, the chip and option-row styles the Milestone 5 controls reuse, the Project strip and `apply-flash`; tokens only, no transform on press
    - _Requirements: 1.1, 3.3, 3.4, 6.1, 6.6, 6.7, 9.1, 9.2, 9.8, 10.1, 10.6, 10.7, 11.1, 11.5, 13.1, 15.4, 18.4_
  - [ ] 12.3 Move `sequence`, `resize` and `bounce` onto mode composers
    - The `sequence` composer returns `order|step|group` (the control's own `data-seq-mode` first, else the checked option; `normalizeInt` 0 to 999 with fallback 3 and 1 to 999 with fallback 1, written back on `change`, `blur` and dispatch); rewrite `initSequencerControls()` (single call site) for the option group, the ± buttons with press-and-hold, the wheel and ArrowUp or ArrowDown (Shift steps by 10), still writing `selectedStaggerMode`
    - `resize` and `bounce`: the controls gain `data-toolkit-action` and their id-bound listeners are removed in the same change; the composers keep the existing validation texts and fallbacks (Freq 3, Amp 40, Decay 5), so the payloads stay byte-identical
    - Add `toolkit.staggerStep` (0 to 999, default 3) and `toolkit.staggerOrder` (`up`, `center`, `random`, default `up`) to `js/core/settings.js` as new lines only; point the two Sequencer rows in `settings-panel.js` at them; remove the sequencer block from `resetToolkitStates()` in `header.js`
    - _Requirements: 1.3, 1.7, 1.10, 11.5, 11.6, 11.7, 11.14_
  - [ ] 12.4 Wire the Workbench into the Shell
    - List `ui/toolkit-workbench.js` once after `toolkit/toolkit.js`; initialize the Workbench and the Velocity defaults (from the two new keys) through `whenViewMounted("tools", …)` in `main.js`; the `tools` adapter restores `subsection`, returns `getRestorationPatch()`, wires `onTabChange` to `updateRouteState("tools", …)` and writes `layout` back after a fallback
    - _Requirements: 4.5, 4.6, 9.5, 9.6, 11.5_
  - [ ]* 12.5 Write property test for the dispatcher oracle
    - **Property 2: Dispatch scripts keep their bytes and carry user text only as hex**
    - **Validates: Requirements 1.2, 1.3, 1.5, 2.3**
    - `tests/toolkit-dispatch-oracle.property.test.js` against the 1.2 fixture; new keys are enumerated from `ACTION_LABELS` minus the 23 existing keys and the Panel-side keys, so the keys added in Milestones 5 and 6 are covered without editing the test
  - [ ]* 12.6 Write property test for stagger mode composition
    - **Property 16: Stagger mode composition**
    - **Validates: Requirements 11.6, 11.7**
    - `tests/workbench-velocity.property.test.js`
  - [ ]* 12.7 Write unit and contract tests for Milestone 4
    - `tests/toolkit-dispatch.test.js`: the Null Shift rule, the unknown action, `resize` validation, a composer refusal, the `crop` and `text-preset` handlers, one dispatch per control
    - `tests/workbench-contract.test.js`: `data-wb-tool` values and `TOOL_INDEX` match both ways, every Workbench `data-toolkit-action` has a branch, `direct` modes equal their controls' `data-mode`, `data-mode` only with `data-toolkit-action`, no ToolBridge, `callHost` or `evalScript` in `toolkit-workbench.js`; extend `tests/shell-manifest.test.js` with the Req 4.5 module check
    - _Requirements: 1.4, 1.5, 1.10, 4.5, 9.8, 9.9, 9.10_

- [ ] 13. Checkpoint: Milestone 4 complete
  - Run `npm test` and the compare script as in task 3 and run `node tests/helpers/check-js-core-additive.js`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 20.1, 20.2_

- [ ] 14. Milestone 5: Host scaffolding and the Layout & Rig tools
  - [ ] 14.1 Add the shared Host helpers to `jsx/workbench.jsx`
    - `csWbPrecondition`, `csWbReport`, `csWbFail`, `csWbRun` (the only `app.beginUndoGroup` and `app.endUndoGroup` calls, `endUndoGroup` in its own guard, exactly one `encodeBridge`), `csWbSelection`, `csWbWithUnlocked` and `csWbSkips`; ES3 only
    - _Requirements: 2.4, 2.5, 2.6, 2.7_
  - [ ]* 14.2 Create the After Effects fakes for the Host tests
    - `tests/helpers/ae-fakes.js` (undo counters, mutation journal, layer classes whose `instanceof` works through `Symbol.hasInstance`, keyed properties, an effect parade with an installed set, the enums, `File`, `ImportOptions`, a fault plan) and `tests/helpers/ae-arbitraries.js` (fake project states and the `WORKBENCH_ENTRY_POINTS` list that Property 11 iterates)
    - _Requirements: 3.13_
  - [ ] 14.3 Add align to Selection
    - `jsx/toolkit.jsx` `toolkitAlignLayers`: split the decoded mode at the first `|`; no suffix runs the Comp path exactly as today; `selection` aligns to the union of the eligible layers' bounds taken before any move and returns `PRE:need-two:…` before the undo group when exactly one layer is eligible, with the existing result strings otherwise; any other suffix is an error before the undo group
    - Panel: the `data-wb-align-scope` option group (Comp checked at every load, not persisted) in `views/tools.html`, the `align` composer that appends `|selection`, the success text's scope read from the suffix, the `need-two` warning text, and the six `<edge>|selection` rows in `TOOL_INDEX`
    - _Requirements: 1.3, 10.3, 10.4, 10.5, 10.14, 10.15, 10.16_
  - [ ] 14.4 Add Mirror Flip
    - Pure `csWbMirrorValue` and `csWbMirrorFlip(axisHex)`: static and keyed Scale, Bezier ease speeds of the axis dimension negated, `locked` and `no-scale` skips, report `mirror`; the `mirror` branch and label, the Horizontal and Vertical cards in Layer helpers, the formatter (success, or info for a partial result) and two `TOOL_INDEX` rows
    - _Requirements: 10.7, 10.8, 10.9, 10.10, 10.12, 10.13, 10.14, 10.15_
  - [ ]* 14.5 Write property test for Mirror Flip
    - **Property 12: Mirror Flip is an involution**
    - **Validates: Requirements 10.8, 10.9, 10.10**
    - `tests/workbench-layout-host.property.test.js`
  - [ ] 14.6 Add Batch Blend Mode
    - Pure `csWbBlendName` and `csWbSetBlendMode(modeHex)`: unlocked `AVLayer`s only, `not-av` and `locked` skips, report `blend-mode`; the branch and label, the seven chips (Normal, Add, Screen, Multiply, Overlay, Soft Light, Darken) in a labelled group, the formatter and seven `TOOL_INDEX` rows
    - _Requirements: 10.7, 10.11, 10.12, 10.13, 10.14, 10.15_
  - [ ]* 14.7 Write property test for Host entry-point discipline
    - **Property 11: Host entry points keep undo and result discipline**
    - **Validates: Requirements 2.5, 2.6, 2.7, 2.11, 10.12, 10.13, 10.15, 11.11, 12.12, 12.13, 12.14, 13.7, 17.15**
    - `tests/workbench-host-discipline.property.test.js` over `WORKBENCH_ENTRY_POINTS` (now `toolkitAlignLayers`, `csWbMirrorFlip` and `csWbSetBlendMode`; later tasks append theirs)
  - [ ]* 14.8 Write example and static tests for the Layout & Rig tools
    - `tests/workbench-host.test.js`: success and failure paths (no comp, no selection, single-layer Selection align, every layer skipped) with undo counters
    - `tests/host-static.test.js`: the ES3 scan of `jsx/toolkit.jsx`, undo calls only inside `csWbRun`, and every string a Workbench-reachable Host function returns before its undo group is in the legacy table or starts with `PRE:`; `tests/toolkit-dispatch.test.js`: `mirror`, `blend-mode` and the align composer
    - _Requirements: 2.4, 2.5, 3.13, 10.12, 10.16, 14.13_

- [ ] 15. Milestone 5: Velocity tools
  - [ ] 15.1 Add Instant Speed Ramp
    - Pure `csWbRampPlan` and `csWbSpeedRamp()`: eligible layers are Time-Remap-capable, unlocked and span the playhead (`no-remap`, `locked` and `no-span` skips, `PRE:no-eligible` when none); keys at t − 0.5, t − 0.1, t + 0.3 and t + 0.8 s, clamped with the nearest-to-playhead rule; Bezier ease with speed 0 and influence 85; in and out points restored
    - The `speed-ramp` branch, the card in the Time Remap group, the formatter with ` · K skipped` and the follow-up warning, and the `TOOL_INDEX` row
    - _Requirements: 11.1, 11.2, 11.10, 11.11, 11.12, 11.13_
  - [ ]* 15.2 Write property test for the speed ramp plan
    - **Property 14: Speed ramp plan**
    - **Validates: Requirements 11.2, 11.10**
    - Added to `tests/workbench-velocity.property.test.js`
  - [ ] 15.3 Add Reverse Video
    - Pure `csWbReverseKeys` and `csWbLinearAt`, and `csWbReverse()`: the two linear keys written before the other keys are removed, in and out points unchanged; branch, card, formatter and `TOOL_INDEX` row
    - _Requirements: 11.1, 11.3, 11.4, 11.10, 11.11, 11.12, 11.13_
  - [ ]* 15.4 Write property test for Reverse Video
    - **Property 15: Reverse Video involution on linear mappings**
    - **Validates: Requirements 11.3, 11.4**
    - Added to `tests/workbench-velocity.property.test.js`
  - [ ] 15.5 Add Split at Playhead
    - `csWbSplitAtPlayhead()` with `layer.duplicate()` and in and out point edits (copy directly above, both halves relocked), `no-span` and `matte` skips including the rule for matte users before After Effects 23.0, and `PRE:no-span` or `PRE:no-eligible` when nothing splits; branch, card in the Cut group, formatter and `TOOL_INDEX` row
    - _Requirements: 11.1, 11.8, 11.11, 11.12, 11.13_
  - [ ]* 15.6 Write property test for the layer tools' eligible sets
    - **Property 13: Layer tools change exactly the eligible layers**
    - **Validates: Requirements 10.5, 10.11, 10.14, 10.16, 11.8**
    - Added to `tests/workbench-layout-host.property.test.js`, covering `mirror`, `blend-mode`, `split` and align to Selection
  - [ ] 15.7 Add Compact Time Remap
    - Pure `csWbFrameRange` and `csWbCompactSamples` (one-pass cone walk with tolerance fd / 4), and `csWbCompactTimeRemap()`: every frame sampled before any change, one `setValuesAtTimes` call, linear keys, old keys removed, out-point set to the last key; `no-remap`, `few-keys` and `locked` skips; branch with the 120 s timeout, card, formatter and `TOOL_INDEX` row
    - _Requirements: 11.1, 11.9, 11.10, 11.11, 11.12, 11.13_
  - [ ]* 15.8 Write property test for Compact Time Remap
    - **Property 17: Compact Time Remap stays on frames and within tolerance**
    - **Validates: Requirements 11.9**
    - Added to `tests/workbench-velocity.property.test.js`
  - [ ]* 15.9 Write example tests for the Velocity tools
    - Success and failure paths for the four entry points in `tests/workbench-host.test.js`; their branches and follow-up warnings in `tests/toolkit-dispatch.test.js`; append the four entry points to `WORKBENCH_ENTRY_POINTS`
    - _Requirements: 3.13, 11.10, 11.11, 11.12, 11.13_

- [ ] 16. Milestone 5: Text tools
  - [ ] 16.1 Add Responsive Text Box
    - `csWbResponsiveTextBox()`: `PRE:no-comp` and `PRE:no-text-layer` before the undo group; for each selected text layer a shape layer `<name> Box` directly below it and parented to it, with a zeroed transform, Padding X, Padding Y and Roundness sliders (30, 20, 20), a Rectangle and a Fill, and the layer-name-free Size, Position and Roundness expressions clamped to 0 to 500; branch, card, formatter and `TOOL_INDEX` row
    - _Requirements: 12.1, 12.2, 12.3, 12.12, 12.13, 12.14_
  - [ ] 16.2 Add the pure split function
    - `csWbSplitPieces(text, mode)` with the explicit space set Z (U+0003 included), CRLF, CR, LF and U+0003 line breaks, user-perceived `letters` (surrogate pairs, combining marks, variation selectors, ZWJ joins), `words` runs and non-empty `lines`; ES3 only
    - _Requirements: 12.4, 12.5_
  - [ ]* 16.3 Write property test for text splitting
    - **Property 18: Text splitting round trip**
    - **Validates: Requirements 12.5**
    - `tests/workbench-text.property.test.js`
  - [ ] 16.4 Add Text Splitter
    - `csWbSplitText(modeHex)` with the refusals before the undo group (`no-comp`, `one-text-layer`, `split-empty`, `split-limit` above 500 pieces, and `split-unsupported` for paragraph text in Letters or Words, text on a path, Text Animators, and right-to-left or vertical text from After Effects 24.0) and the placement algorithm of the design (baseline geometry, scratch advance measurement, Anchor Point and mask offsets, animator and expression clean-up, controller Null, source disabled, scratch removed)
    - Panel: the `data-wb-split-mode` group (Words checked) and the Split button, the `split-text` composer and branch with the 120 s timeout, the formatter and the `TOOL_INDEX` `open` row
    - _Requirements: 12.1, 12.4, 12.10, 12.12, 12.13, 12.14_
  - [ ]* 16.5 Write property test for the Text Splitter
    - **Property 19: Text Splitter builds pieces or refuses before any change**
    - **Validates: Requirements 12.4, 12.13**
    - Added to `tests/workbench-text.property.test.js`
  - [ ] 16.6 Add Find & Replace
    - Pure `csWbFold` and `csWbReplaceLiteral`, and `csWbFindReplace(findHex, replaceHex, scopeHex, caseHex)`: `decodeBridge` only, the input checks repeated, `comp` scope as a visited-set walk through nested precomps, `project` scope, a read-only pass and then one undo group only when N ≥ 1, `CharacterRange` replacement from After Effects 24.3 and whole-document writes before it, and a report with `n` and `m`
    - Panel: labelled `cs-wb-fr-find` and `cs-wb-fr-replace` fields without `maxlength`, the scope group (Active Comp checked), the Match Case checkbox (checked), the Replace All button, Enter in either field clicking it (no `<form>`); the composer's three warnings; the branch passing four Bridge_Payloads with the 120 s timeout; the formatter (`✓ Replaced N occurrences in M layers`, or the no-match info); the `TOOL_INDEX` `open` row
    - _Requirements: 2.3, 12.1, 12.6, 12.7, 12.8, 12.9, 12.10, 12.12, 12.14_
  - [ ]* 16.7 Write property test for Find & Replace
    - **Property 20: Find & Replace is literal and counts correctly**
    - **Validates: Requirements 12.6, 12.10**
    - Added to `tests/workbench-text.property.test.js`
  - [ ]* 16.8 Write example tests for the Text tools
    - Success and failure paths for the three entry points in `tests/workbench-host.test.js`; the composer warnings and the four-payload call in `tests/toolkit-dispatch.test.js`; append the entry points to `WORKBENCH_ENTRY_POINTS`
    - _Requirements: 3.13, 12.9, 12.12, 12.13, 12.14_

- [ ] 17. Milestone 5: Guides tools
  - [ ] 17.1 Author the Instagram Reel guide asset
    - `assets/guides/ig_reel_guide_1080x1920.png`: 1080×1920, transparent 8-bit RGBA, at most 100 KB, marking the top (about 250 px), bottom (about 420 px) and right-rail (about 120 px) regions at 25% opacity or less with a dashed outline around the clear area; generate it with a one-off Node script using `zlib` (no new dependency) and do not ship the script
    - _Requirements: 13.2, 13.10_
  - [ ] 17.2 Add the Instagram Reel Safe Zone
    - `csWbToggleIgGuide(assetPathHex)` with `CS_WB_IG_GUIDE_NAME`: when guide layers exist, remove all of them (and the footage item when no comp uses it) in the Off undo group; otherwise check the file name and existence before the On undo group, reuse or import the footage, add it at index 1 as a guide layer, fit it to (0, 0)–(W, H) with the pixel-aspect factor, span the comp, lock it last, and clean up the layer and any imported item on a throw
    - Panel: the card first in the Guides tab, the `ig-guide` composer that builds the asset path from the extension folder, the branch, the formatter (the exact enabled and disabled texts) and the `TOOL_INDEX` `control` row
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.7, 13.9, 13.10_
  - [ ]* 17.3 Write property test for the guide toggle
    - **Property 22: Instagram guide toggle round trip**
    - **Validates: Requirements 13.2, 13.4**
    - `tests/workbench-guides.property.test.js`
  - [ ] 17.4 Add the Aspect Ratio Switcher
    - Pure `csWbAspectSize` and `csWbSwitchAspect(presetHex)`: unknown preset, `no-comp` and the 4 to 30,000 px bound checked before the undo group; a matching size reports `changed: 0`; unparented layers shifted by half the size change (cameras and lights on their Point of Interest too); Instagram guide layers re-fitted
    - Panel: the `9:16`, `16:9`, `1:1` and `4:5` buttons in a labelled group after the guide card, the branch, the formatter (`✓ Comp resized to WxH` or `✓ Comp is already WxH`) and four `TOOL_INDEX` rows
    - _Requirements: 13.1, 13.5, 13.6, 13.7, 13.8, 13.10_
  - [ ]* 17.5 Write property test for the aspect math
    - **Property 21: Aspect Ratio Switcher math**
    - **Validates: Requirements 13.6, 13.10**
    - Added to `tests/workbench-guides.property.test.js`
  - [ ]* 17.6 Write example and final contract tests for the Workbench
    - Success and failure paths for the two entry points in `tests/workbench-host.test.js` and their branches in `tests/toolkit-dispatch.test.js`; append them to `WORKBENCH_ENTRY_POINTS`; in `tests/workbench-contract.test.js`, assert the `TOOL_INDEX` counts 43, 8, 4, 7 and 4, the Text tab's four controls and the Guides tab's four groups in order
    - _Requirements: 3.13, 12.1, 13.1, 13.7, 13.10, 16.2_

- [ ] 18. Checkpoint: Milestone 5 complete
  - Run `npm test` and the compare script as in task 3 and run `node tests/helpers/check-js-core-additive.js`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 20.1, 20.2_

- [ ] 19. Milestone 6: Recipe parser, loader and Host application
  - [ ] 19.1 Create `js/toolkit/oneframers-recipes.js`
    - `OneFramers` with pure `parseText` (BOM strip, `invalid-json`, `not-array`, per-element `validateRecipe` in file order with `index`, skip records `{ index, field, reason }` naming the first failing field), `validateRecipe` (the design's check order and reasons, `-0` to `0`, a string `blend` kept, any other `blend` type dropped, extra keys ignored), `printRecipes` and `printRecipe`
    - `ensureLoaded()` (at most one read per Panel_Session, requests before G1 held until G1, read and parse in one macrotask, the `missing`, `unreadable`, `invalid-json` and `not-array` states), `onLoaded(fn)` and `configure({ readText, extensionPath })`; CommonJS guard
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.7, 17.22, 19.3, 19.5_
  - [ ]* 19.2 Write property test for recipe validation
    - **Property 29: Recipe validation reports the first failing field**
    - **Validates: Requirements 17.3, 17.5, 17.22**
    - `tests/oneframers-recipes.property.test.js`
  - [ ]* 19.3 Write property test for the recipe round trip
    - **Property 30: Recipe parse, print, parse round trip**
    - **Validates: Requirements 17.7, 17.8**
    - Added to `tests/oneframers-recipes.property.test.js`, with the byte-for-byte example on `presets/oneframers_106_recipes.json`
  - [ ] 19.4 Create `jsx/oneframers.jsx` with `csFxApplyRecipe`
    - `csFxApplyRecipe(recipeHex, targetHex)`: `decodeBridge` and `jsonParse` with no `eval`, `csFxValidateRecipe`, target `selected` or `adjust`, and `PRE:no-comp`, `PRE:fx-no-target` and `PRE:no-eligible` before the undo group; one `csWbRun` group; for `adjust`, the `[<name> Look]` adjustment layer above the topmost selected layer or at index 1 with the `csFxAdjustSpan` span; effects appended in recipe order with the first addable match name, parameters set with per-item skips, the `blend` table looked up with `hasOwnProperty`, `skippedBlend`; the report fields of the design
    - Pure `csFxMatchNames`, `csFxValidateRecipe`, `csFxShortName`, `csFxLookName`, `csFxBlendKey` and `csFxAdjustSpan`; include the file in `jsx/compSaver.jsx` after `workbench.jsx`
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.11, 17.12, 17.13, 17.14, 17.15, 17.16, 17.18, 17.19, 17.20, 17.21_
  - [ ]* 19.5 Write property test for recipe application
    - **Property 32: Recipe application follows the recipe and reports every skip**
    - **Validates: Requirements 17.12, 17.13, 17.14**
    - `tests/oneframers-host.property.test.js`
  - [ ]* 19.6 Write example tests for the recipe Host function
    - `tests/oneframers-host.test.js`: both targets, empty, malformed and invalid payloads, no comp, no selection, every layer ineligible, a throw partway; extend `tests/host-static.test.js` to `jsx/oneframers.jsx`; append `csFxApplyRecipe` to `WORKBENCH_ENTRY_POINTS`
    - _Requirements: 2.11, 3.13, 17.15, 17.16, 17.19_

- [ ] 20. Milestone 6: FX_Browser and the `fx-recipe` action
  - [ ] 20.1 Create `js/toolkit/fx-browser.js`
    - `CompSaverFx`: the Presets and One-Framers switch (tablist behavior, `restorePanel(subsection)` with the `presets` fallback), one card per accepted recipe in file order (`data-mode` file index, `textContent` name, the two-line `title`, `swatchRgb` background), pure `filterRecipes` with its own `foldCase` copy, `hidden` filtering, the loading, ready, all-skipped and failed states, the skipped disclosure (up to 50 entries) and `getRecipe(mode)`
    - Delegated `click` and `keydown` listeners (Enter or Space with `preventDefault`; repeats and Ctrl, Alt or Meta presses ignored) that call `runToolkitAction("fx-recipe", "<index>" or "<index>|adjust", card, event)` once per activation; cards never go through `bindToolkitActionControls`; `CompSaverFocus.check` after each filter pass
    - _Requirements: 17.2, 17.4, 17.6, 17.9, 17.10, 17.11, 17.16, 17.18, 18.8, 18.9, 19.5_
  - [ ]* 20.2 Write property test for FX_Browser search
    - **Property 31: FX_Browser search**
    - **Validates: Requirements 17.10**
    - Added to `tests/oneframers-recipes.property.test.js`
  - [ ] 20.3 Add the FX_Browser markup and styles
    - `views/effects.html`: the `cs-fx-switch` tablist, `#cs-fx-panel-presets` holding today's children unchanged, and `#cs-fx-panel-oneframers` (`hidden`) with `#cs-fx-search` (`maxlength="100"`), the status line, the skipped disclosure and `#cs-fx-grid`
    - `.cs-fx-*` rules at the end of `css/effects.css`: panels displayed only under `:not([hidden])`, the Card_Grid formula with `--grid-min-col: 72px`, cards, swatch, the 2-line name clamp, and the switch with the Workbench tab values; tokens only; the `.fx-grid` alias left alone
    - _Requirements: 3.3, 5.7, 6.1, 15.4, 15.6, 15.7, 17.9, 17.11_
  - [ ] 20.4 Wire the FX_Browser and the `fx-recipe` action
    - `js/toolkit/toolkit.js`: the `fx-recipe` branch (split the mode, `CompSaverFx.getRecipe`, target `selected` or `adjust`, `✕ This One-Framer isn't available (<mode>)` with no Host call, the recipe and target as two Bridge_Payloads), the 120 s timeout, `ACTION_LABELS` `One-Framer` with the recipe name in `toolkitActionLabel`, the formatter and warnings of the design, and the `isWellFormedBridgeHex(outcome.raw)` check for unreadable results
    - Shell: list `toolkit/oneframers-recipes.js` and `toolkit/fx-browser.js` before `ui/toolkit-workbench.js`; `main.js`: the FX_Browser init through `whenViewMounted("effects", …)` beside `loadSavedEffects()` (one call site), and `OneFramers.ensureLoaded()` at G1; the `effects` adapter calls `ensureLoaded()` on its first activation, restores and patches `subsection`, and writes `presets` back after a fallback
    - _Requirements: 2.3, 2.10, 4.6, 17.1, 17.2, 17.12, 17.14, 17.15, 17.16, 17.17, 17.18, 17.19, 17.21, 19.3, 19.5_
  - [ ]* 20.5 Write property test for recipe loading
    - **Property 33: The recipe file is read once and never before the first paint**
    - **Validates: Requirements 17.1, 17.2, 19.3**
    - `tests/oneframers-load.property.test.js` over `OneFramers.ensureLoaded`, `StartupGate` and the `effects` adapter
  - [ ]* 20.6 Write example tests for the FX_Browser
    - `tests/fx-browser.test.js`: one `runToolkitAction` call each for click, Enter and Shift+Space with the expected mode, the error text per failure kind, the skipped count, the no-match state, swatch colors; the `fx-recipe` feedback cases in `tests/toolkit-dispatch.test.js`
    - _Requirements: 3.13, 17.4, 17.6, 17.9, 17.11, 17.14, 17.16, 17.17, 17.18_

- [ ] 21. Checkpoint: Milestone 6 complete
  - Run `npm test` and the compare script as in task 3, confirm the `tests/performance/` suites still pass, and run `node tests/helpers/check-js-core-additive.js`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 19.1, 20.1, 20.2_

- [ ] 22. Milestone 7: Command_Palette
  - [ ] 22.1 Add the pure palette filter to `js/ui/command-palette.js`
    - `foldCase` (per code unit, length preserving) and `filterEntries(index, query)` (trim; the first 15 entries for an empty query; folded substring match on title or category, in index order); add the CommonJS guard
    - _Requirements: 2.9, 16.4, 16.5, 16.12_
  - [ ]* 22.2 Write property test for filter soundness
    - **Property 26: Palette filter is sound, complete and ordered**
    - **Validates: Requirements 16.4**
    - `tests/command-palette-filter.property.test.js`
  - [ ]* 22.3 Write property test for monotonic narrowing
    - **Property 27: Palette results narrow as the query grows**
    - **Validates: Requirements 16.5**
    - Added to `tests/command-palette-filter.property.test.js`
  - [ ]* 22.4 Write property test for the empty query
    - **Property 28: Empty palette query shows the first 15 entries**
    - **Validates: Requirements 16.12**
    - Added to `tests/command-palette-filter.property.test.js`
  - [ ] 22.5 Build the palette index
    - Pure `buildIndex(sources, deps)` over the nine blocks in order (Routes, template operations, template sections, Workbench tools from `TOOL_INDEX`, the Project strip, Header notifications, the three kept operations, Settings sections, accepted recipes): frozen entries with folded `_title` and `_category`, the first entry kept for a repeated id with a `palette.index.duplicate` event, and `run` per kind; `setIndex` and `setRecipes`
    - `SettingsPanel.getSections()` and `openSection(id)` as additions, with the accordion headers given `role="button"`, `tabindex="0"` and `aria-expanded`; `CompSaverRouter.dispatch(route, action)` with the adapter actions `section` (templates), `open-tool` (tools) and `open-section` (settings)
    - _Requirements: 16.2, 16.15, 18.8_
  - [ ]* 22.6 Write unit tests for the palette index
    - `tests/palette-index.test.js`: 95 static entries with unique ids and non-empty titles and categories, 201 with the shipped recipes, the block order
    - _Requirements: 16.2_
  - [ ] 22.7 Rebuild the palette overlay behavior and styles
    - Shell markup: the combobox input (`maxlength="200"`, `aria-controls`, `aria-autocomplete`), the listbox and the status line; remove the static `COMMANDS` list
    - `open()` and `close()` with the remembered element and the body fallback; the `KeyK` hotkey rule per platform; the capture-phase key layer (arrows with wrap-around and `scrollIntoView`, Enter closes and then runs once, Escape and the hotkey close, Tab stays inside); the `focusin` guard; pointer rules (`mousedown` keeps focus, a row click runs, a backdrop click closes); `runEntry` with exactly one error toast per failure and no index change; DOM-built rows with `aria-activedescendant`; the no-results and `Preparing commands…` states; an index refresh while open keeps the highlighted id; the `palette.filter` span
    - `css/command-palette.css` per the design styling table: scrim overlay with the paired blur, box, 34px rows, the highlighted-row outline, badge, status and hint; tokens only
    - _Requirements: 3.9, 5.7, 6.1, 6.8, 16.1, 16.3, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.13, 16.14, 16.15, 18.5_
  - [ ] 22.8 Wire the palette index
    - `main.js`: at G1, `CommandPalette.setIndex(buildIndex(staticSources(), deps))`; `OneFramers.onLoaded` calls `CommandPalette.setRecipes`; the Sidebar Commands item and the registered hotkey open the same palette
    - _Requirements: 7.5, 16.1, 16.2, 19.3_
  - [ ]* 22.9 Write unit tests for the palette
    - `tests/command-palette.test.js`: focus and highlight on open, focus return on close, Enter with and without results, arrow wrap, the Tab trap, pointer and backdrop, the failure toasts of each row of the design table, the Preparing state
    - _Requirements: 16.1, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.13, 16.14, 16.15_

- [ ] 23. Checkpoint: Milestone 7 complete
  - Run `npm test` and the compare script as in task 3 and run `node tests/helpers/check-js-core-additive.js`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 1.11, 3.1, 3.2, 20.1, 20.2_

- [ ] 24. Visual-parity mapping and the final automated checks
  - [ ] 24.1 Write the visual-parity mapping document
    - `.kiro/specs/obsidian-ui-redesign/visual-parity-mapping.md` with one entry per component type of Req 6.1 (sidebar item, Workbench tool card, segmented control, labeled button, icon button, toast, modal, Palette_Entry row): a Reference_Screenshot file, an MNTools_Reference file-and-selector pair, the measured padding, border radius, height and font-weight, the CompSaver selector and values, and the deliberate differences the design lists
    - Find the captures the design's reference table still lacks (toast, modal) among the Reference_Screenshots; where no matching MNTools element exists, say so and name the MNTools_Reference token set used instead
    - _Requirements: 6.1, 6.9_
  - [ ] 24.2 Write the parity mapping check script
    - `tests/helpers/check-parity-mapping.js`, a Maintainer script and not a Jest test: every named screenshot exists in the Reference_Screenshots folder and every file-and-selector pair exists in the MNTools_Reference; exits non-zero and lists the missing items
    - _Requirements: 6.9, 20.7_
  - [ ]* 24.3 Write the visual specification test
    - `tests/visual-spec.test.js`: the Visual Specification targets against the values declared in the stylesheets (within 2px, equal font weights) and the mapping document's entry count and fields
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.8, 6.9_
  - [ ]* 24.4 Complete the test inventory and the module guards
    - `tests/test-inventory.test.js`: every new module, action key and Host function name appears in at least one test file; `tests/js-syntax-guard.test.js` and `tests/js-modules-load.test.js` list every new or modified `js/` module
    - _Requirements: 2.8, 2.9, 3.2, 3.13_

- [ ] 25. Milestone 8: Verification in After Effects (manual Maintainer steps)
  - [ ]* 25.1 [Manual] Run the automated gate
    - Run `npm test`, the compare script and `node tests/helpers/check-parity-mapping.js`; record any failing suite or test outside the Test_Baseline and keep the Milestone open until a later run is clean
    - _Requirements: 3.1, 20.1, 20.2_
  - [ ]* 25.2 [Manual] Console and activation pass
    - Load the Panel with the CEP DevTools console open; activate each of the 7 Routes through the Sidebar and each Workbench tool through its tab, with an open comp and the selection each tool needs; confirm zero error-level entries from startup to the last activation
    - _Requirements: 20.3, 20.4_
  - [ ]* 25.3 [Manual] Existing_Capability parity and Undo
    - Run every Existing_Capability against the test project of 1.3 and compare each result with the reference run; confirm one Edit > Undo reverts each project change, and that each capability is reachable within 3 clicks in Narrow, Standard and Wide modes
    - _Requirements: 1.1, 20.5, 20.6_
  - [ ]* 25.4 [Manual] Visual captures
    - After `check-parity-mapping.js` passes, capture every Route with a mapped Reference_Screenshot at 260, 400 and 700px and confirm the layout mode and the 2px tolerance against the mapping
    - _Requirements: 6.1, 20.7_
  - [ ]* 25.5 [Manual] Host-only behaviors
    - Ctrl+K and Cmd+K reach the palette with focus outside a text field; an OS reduced-motion change applies within 1 s; the `palette.filter` span stays under 50 ms with a synthetic 1,000-entry index and a 200-character query
    - The Text Splitter 1px bound on the supported cases and the Responsive Text Box following text edits within 1px; the overflow pass at 180 to 1200px and the focus-ring clipping pass at 260, 400 and 700px
    - Split at Playhead with track mattes below and from After Effects 23.0, Find & Replace on mixed-style text below and from 24.3, and the Instagram guide import, fit and non-rendering guide layer
    - _Requirements: 11.8, 12.3, 12.4, 12.6, 13.2, 15.4, 16.1, 16.3, 18.3, 18.7_
  - [ ]* 25.6 [Manual] Startup time
    - Measure `startup.init` start to `startup.readiness` end over 5 opens and compare the mean with the 1.3 measurement; it stays within 10%
    - _Requirements: 19.6_
  - [ ]* 25.7 [Manual] Record and repeat failed checks
    - Record each failing Route, Workbench tool, Existing_Capability or capture with the observed result; Milestone 8 stays open until a repeat of each failed check passes
    - _Requirements: 20.8_

- [ ] 26. Final checkpoint
  - Ensure all tests pass and the compare script reports no failure outside the Test_Baseline, ask the user if questions arise.
  - _Requirements: 1.11, 3.1, 3.2_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be deferred for a faster first pass. Req 3.13 still requires, before the feature is complete, at least one passing Jest test for every new module, action key and Host function, covering a success path and a failure path for each action and Host function; 24.4 checks that inventory.
- Every top-level task, not only the checkpoints, ends with `npm test` inside the Test_Baseline, verified with `tests/helpers/compare-test-baseline.js` (Req 3.1, 3.2). Sub-tasks inside one top-level task may break tests temporarily.
- Existing tests are never deleted, skipped or given new expected values; the only edit to existing test files is the markup-source switch in 1.6. If an existing assertion conflicts with a required change, stop and ask the user.
- `js/core/` gets only new lines: the `global.comp-monitor-info` entry in `bridgeRegistry.js` (6.1) and the three keys in `settings.js` (9.8, 12.3). Checkpoints verify this with `tests/helpers/check-js-core-additive.js` against the snapshot taken in 1.1.
- Panel code under `js/` is ES2020 classic script with the CommonJS guard and no DOM access at load time; new calls in `main.js` are `typeof`-guarded and keep the single call sites `startup-containment` counts. Host code under `jsx/` is ES3, checks preconditions before `csWbRun`, and returns exactly one Bridge_Payload.
- Any `--cs-` name a new rule references is declared on `:root` in `tokens.css` in the same task (Req 5.8), and every new Obsidian rule is tokens-only (Req 5.7).
- New modules are built and unit-tested in one task and wired into the Shell in the next (4 → 5 and 7, 11 → 12, 19 → 20), so no top-level task leaves the Panel half-wired.
- Two placements differ from the suggested outline because the design requires it: the notifications list moves to Milestone 3 (9.6), since it reads the Toast_Engine history, and the align scope control lands with its Host change in Milestone 5 (14.3), so no control sends a mode the Host cannot handle.
- Property tests carry the `// Feature: obsidian-ui-redesign, Property N: …` tag and the Validates line, and use at least 100 runs (200 for cheap pure generators).
- The "[Manual]" sub-tasks (1.3 and task 25) are Maintainer steps in After Effects. They are marked optional so the task runner skips them; the Maintainer runs 1.3 by hand before starting task 2 and task 25 at the end.
- Before running all tasks, finish or pause the other open specs that edit the same files (for example `media-card-lifecycle-edge-fixes`, `catalog-patch-ordering-fixes` and `comp-template-pipeline-audit-fix`), so two task runs do not edit `index.html`, `js/templates/templates.js` or `css/` at the same time.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.8"] },
    { "id": 1, "tasks": ["1.5", "1.6", "1.7"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.4"] },
    { "id": 3, "tasks": ["2.3", "2.5"] },
    { "id": 4, "tasks": ["2.6"] },
    { "id": 5, "tasks": ["2.7"] },
    { "id": 6, "tasks": ["4.1", "4.3", "4.7"] },
    { "id": 7, "tasks": ["4.2", "4.4", "4.8"] },
    { "id": 8, "tasks": ["4.5", "4.6"] },
    { "id": 9, "tasks": ["5.1", "5.4"] },
    { "id": 10, "tasks": ["5.2", "5.3"] },
    { "id": 11, "tasks": ["5.5"] },
    { "id": 12, "tasks": ["5.6"] },
    { "id": 13, "tasks": ["6.1", "6.3"] },
    { "id": 14, "tasks": ["6.2", "6.4"] },
    { "id": 15, "tasks": ["6.5", "6.7"] },
    { "id": 16, "tasks": ["6.6"] },
    { "id": 17, "tasks": ["7.1", "7.4"] },
    { "id": 18, "tasks": ["7.2"] },
    { "id": 19, "tasks": ["7.3", "7.5"] },
    { "id": 20, "tasks": ["9.1", "9.5"] },
    { "id": 21, "tasks": ["9.2", "9.4", "9.6", "9.8"] },
    { "id": 22, "tasks": ["9.3", "9.7", "9.9", "9.10"] },
    { "id": 23, "tasks": ["11.1", "11.3"] },
    { "id": 24, "tasks": ["11.2", "11.4"] },
    { "id": 25, "tasks": ["11.5"] },
    { "id": 26, "tasks": ["12.1", "12.2"] },
    { "id": 27, "tasks": ["12.3", "12.4"] },
    { "id": 28, "tasks": ["12.5", "12.6", "12.7"] },
    { "id": 29, "tasks": ["14.1", "14.2", "14.3"] },
    { "id": 30, "tasks": ["14.4"] },
    { "id": 31, "tasks": ["14.5", "14.6"] },
    { "id": 32, "tasks": ["14.7", "14.8"] },
    { "id": 33, "tasks": ["15.1"] },
    { "id": 34, "tasks": ["15.2", "15.3"] },
    { "id": 35, "tasks": ["15.4", "15.5"] },
    { "id": 36, "tasks": ["15.6", "15.7"] },
    { "id": 37, "tasks": ["15.8", "15.9"] },
    { "id": 38, "tasks": ["16.1"] },
    { "id": 39, "tasks": ["16.2"] },
    { "id": 40, "tasks": ["16.3", "16.4"] },
    { "id": 41, "tasks": ["16.5", "16.6"] },
    { "id": 42, "tasks": ["16.7", "16.8"] },
    { "id": 43, "tasks": ["17.1", "17.2"] },
    { "id": 44, "tasks": ["17.3", "17.4"] },
    { "id": 45, "tasks": ["17.5", "17.6"] },
    { "id": 46, "tasks": ["19.1", "19.4"] },
    { "id": 47, "tasks": ["19.2", "19.5", "19.6"] },
    { "id": 48, "tasks": ["19.3"] },
    { "id": 49, "tasks": ["20.1", "20.3"] },
    { "id": 50, "tasks": ["20.2", "20.4"] },
    { "id": 51, "tasks": ["20.5", "20.6"] },
    { "id": 52, "tasks": ["22.1"] },
    { "id": 53, "tasks": ["22.2", "22.5"] },
    { "id": 54, "tasks": ["22.3", "22.6", "22.7"] },
    { "id": 55, "tasks": ["22.4", "22.8"] },
    { "id": 56, "tasks": ["22.9"] },
    { "id": 57, "tasks": ["24.1", "24.4"] },
    { "id": 58, "tasks": ["24.2", "24.3"] },
    { "id": 59, "tasks": ["25.1"] },
    { "id": 60, "tasks": ["25.2", "25.3", "25.4", "25.5", "25.6"] },
    { "id": 61, "tasks": ["25.7"] }
  ]
}
```
