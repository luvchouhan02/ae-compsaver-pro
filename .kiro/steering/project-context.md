# CompSaver — Project Context

## Overview

CompSaver is a professional Adobe After Effects CEP (Common Extensibility Platform) panel extension that provides motion designers with a comprehensive toolkit for composition management, project organization, and workflow automation. It runs inside After Effects' embedded Chromium (CEP, Chromium 88+) and communicates with the host application via ExtendScript through a hex-encoded bridge protocol.

## Architecture

### Dual Runtime

- **Panel (Frontend):** HTML/CSS/JS running in CEP's Chromium 88 environment. No ES modules — all scripts load as classic `<script>` tags. Code must target ES2020 or below.
- **Host (Backend):** ExtendScript (ECMAScript 3 only) files in `jsx/` executed by After Effects. Must use `var`, `function`, no arrow functions, no `const`/`let`, no template literals.

### Key Directories

```
CompSaver/
├── index.html          # Shell — structural skeleton (~300 lines)
├── views/              # View fragments injected into shell at startup
├── css/                # Stylesheets (tokens.css loaded first)
│   └── style.css       # Master import — 11 modules in fixed order
├── js/
│   ├── core/           # Bridge, state, persistence, scheduling — IMMUTABLE public APIs
│   └── ui/             # Sidebar, header, toast, command-palette, workbench
├── jsx/                # ExtendScript host functions (ES3 only)
├── CSXS/               # CEP manifest (manifest.xml)
├── presets/             # OneFramers FX recipes, template presets
├── tests/              # Jest 29 + fast-check — 130+ suites, 1500+ tests
├── assets/             # Icons, images
└── .kiro/              # Kiro specs, steering, hooks, agents
```

### Bridge Protocol

All Panel↔Host communication uses a hex-encoded bridge:
- `encodeBridge(str)` → 4 hex digits per UTF-16 code unit
- `decodeBridge(hex)` → original string
- Round-trip property: `decodeBridge(encodeBridge(s)) === s`
- Host calls go through `ToolBridge.call` (toolkit actions) or `callHost` (general)
- Default timeout: 30,000 ms

### Shell & Routing

- 7 routes: `templates`, `tools`, `effects`, `text`, `easing`, `colorflow`, `settings`
- Managed by `js/ui/shell-state.js`
- Persistent sidebar with icon navigation
- View fragments loaded and inserted at startup

### Design System

- Obsidian dark theme via `--cs-*` design tokens in `css/tokens.css`
- User-selectable accent colors (6 presets + custom hex)
- Legacy tokens in `css/base.css` `:root` must be preserved

## Testing

- Jest 29.7.0 + fast-check 3.22.0
- Contract tests assert DOM structure, class names, IDs, import order
- `tests/fixtures/class-contract.baseline.json` pins 106 interactive IDs, 104 static IDs, 31 classes, 8 data attributes
- Property-based tests for bridge encoding, state management
- All tests run via `npm test`

## Critical Invariants

1. Never modify public APIs in `js/core/` — additions only
2. Never interpolate raw user text into ExtendScript — always use Bridge_Payload
3. Every Host function must wrap changes in `app.beginUndoGroup()` / `app.endUndoGroup()`
4. CSS style.css import order (11 modules) must not change — contract-tested
5. All `backdrop-filter` must pair with `-webkit-backdrop-filter`
