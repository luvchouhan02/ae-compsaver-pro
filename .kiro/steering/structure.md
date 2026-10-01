# CompSaver — Repository & Project Structure

## 1. Directory Layout

```
CompSaver/
├── index.html                   # Master CEP application shell & layout skeleton
├── package.json                 # Project configuration, test scripts & dependencies
├── CSXS/
│   └── manifest.xml             # Adobe CEP extension manifest (panel geometry, permissions)
├── css/                         # Obsidian design system & component styles
│   ├── tokens.css               # Core CSS variables, colors, radii, shadows (--cs-*)
│   ├── base.css                 # Reset, typography, and backward-compatible legacy tokens
│   ├── style.css                # Master stylesheet importing 11 modules in strict order
│   └── [module].css             # Component stylesheets (header, toolkit, templates, etc.)
├── js/
│   ├── CSInterface.js           # Official Adobe CEP communication library
│   ├── main.js                  # Application entry point, lifecycle bootstrap & routing
│   ├── core/                    # Immutable core primitives (Bridge, State, Persistence, Scheduler)
│   ├── ui/                      # UI components (Header, Sidebar, Accent Picker, Modals, Toast)
│   ├── templates/               # Template library, virtual grid, and thumbnail handlers
│   ├── toolkit/                 # Motion design utility tools (Workbench, Crop, Paste, Cleaners)
│   └── textanim/                # Text animation engine and preset orchestrator
├── jsx/                         # Host ExtendScript modules executed in After Effects (ES3)
│   ├── core.jsx                 # Base host utilities, undo helpers, JSON parser
│   ├── compSaver.jsx            # Composition saving, packaging, and export engine
│   ├── toolkit.jsx              # ExtendScript implementations of utility actions
│   ├── import.jsx               # Media and asset import pipeline
│   └── workflow.jsx             # Keyframe, layer, and timeline manipulators
├── presets/                     # Pre-bundled animation recipes and user presets
├── assets/                      # Icons, graphic badges, and UI artwork
├── tests/                       # Jest test suites & property-based tests (1,580+ tests)
│   ├── fixtures/                # Contract baselines and test fixtures
│   ├── helpers/                 # Test harnesses and fake AE host implementations
│   └── performance/             # Startup, virtual grid, and bridge performance benchmarks
└── .kiro/                       # Kiro IDE configuration, steering, specs, and hooks
    ├── steering/                # Product, Tech, Structure, and Convention guidelines
    ├── specs/                   # Feature specifications (Requirements, Design, Tasks)
    ├── hooks/                   # Automated pre-commit / edit verification guards
    └── agents/                  # Kiro specialized agents (ae-script-reviewer, compsaver-debugger)
```

## 2. CSS Load Order Invariant (Locked)
In `css/style.css`, the 11 component stylesheets are imported in this exact, immutable sequence:
1. `base.css`
2. `header.css`
3. `toolkit.css`
4. `effects.css`
5. `flow.css`
6. `templates.css`
7. `colorflow.css`
8. `responsive.css`
9. `textanim.css`
10. `layout.css`
11. `polish.css`

> **Note:** Any reordering or omission will violate `tests/class-contract.test.js` and break CEP rendering cascading.

## 3. Component Invariants & Extension Guidelines
- **Core Immutability:** Existing functions in `js/core/` are treated as frozen public APIs. Enhancements must be strictly additive.
- **Contract Integrity:** Interactive element IDs (`btn-*`, `input-*`), view class names, and data attributes are pinned in `tests/fixtures/class-contract.baseline.json`. Renaming or deleting an interactive DOM ID requires updating the contract baseline after user sign-off.
- **Webkit Compatibility:** All backdrop filters must provide `-webkit-backdrop-filter` for CEP Chromium 88 compatibility.
