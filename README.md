# CompSaver — Next-Gen Motion Workflow Suite for Adobe After Effects

[![Kiro Challenge 2026](https://img.shields.io/badge/Kiro%20Challenge-2026%20Participant-6366f1.svg)](https://kiro.dev/2026/university/)
[![Adobe CEP](https://img.shields.io/badge/Adobe%20CEP-Chromium%2088-ff0000.svg)](https://github.com/Adobe-CEP)
[![Test Suite](https://img.shields.io/badge/Tests-1%2C580%2B%20Passing-success.svg)](tests/)
[![Property Testing](https://img.shields.io/badge/Testing-fast--check%20Property--Based-blueviolet.svg)](https://github.com/dubzzz/fast-check)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A unified, high-performance Adobe After Effects panel extension engineered with **Kiro Spec-Driven Development**. Combines template management, asset organization, animation curves, and workflow automation into a single, blazing-fast workspace.

---

## 🌟 What is CompSaver?

Motion designers and animators in After Effects constantly suffer from workflow friction: juggling dozens of disparate scripts, freezing the UI while saving heavy compositions, losing keyframe velocity presets, and manually rebuilding repetitive layer rigs.

**CompSaver** solves this by providing a unified, Obsidian-themed command center inside After Effects:
- **Zero-Freeze Composition Saving:** Isolate and export active comps with dependency packaging while keeping the live project safe.
- **Scalable Virtualized Library:** Smoothly browse and search 5,000+ templates and assets without DOM lag.
- **Media Engine:** Instant drag-and-drop batch asset import with asynchronous 320×180 thumbnail generation.
- **Motion Toolkit & Workbench:** Instant utility actions (Auto-crop, Smart Paste, Center Anchor, Layer Align, Cleaners).
- **Flow Graph Editor:** Visual cubic bezier easing curve designer with 1-click keyframe velocity application.
- **ColorFlow System:** Centralized project color palette manager with live layer fill/stroke theming.
- **OneFramers Engine:** 106 production-ready effect recipes with automated parameter rollback on error.

---

## 🎓 Built with Kiro — Challenge Showcase

CompSaver was engineered and structured following the core principles of the **Kiro AI IDE**:

### 1. Spec-Driven Development (`.kiro/specs/`)
Every major subsystem is backed by formal specifications utilizing the **EARS (Easy Approach to Requirements Syntax)** framework:
- **[`save-performance-optimization`](.kiro/specs/save-performance-optimization/):** 18KB requirements document with strict Ubiquitous, Event-driven, State-driven, and Unwanted-behaviour rules, paired with a 39KB design document and 11KB task plan.
- **[`obsidian-ui-redesign`](.kiro/specs/obsidian-ui-redesign/):** Architectural specifications for tokenized theme consistency and layout contracts.

### 2. Steering Documents (`.kiro/steering/`)
Project context and runtime invariants are codified in structured steering documents:
- **`product.md`:** Value proposition, user personas, and core capability matrices.
- **`tech.md`:** Dual runtime architecture (CEP Chromium 88 vs After Effects ES3 ExtendScript) and hex-bridge protocol contracts.
- **`structure.md`:** Repository hierarchy and the locked 11-module CSS load sequence in `style.css`.
- **`coding-conventions.md`:** Strict ES3 host rules, undo group integrity, and error boundaries.

### 3. Automated Hooks (`.kiro/hooks/`)
Autonomous verification guards running before changes:
- `extendscript-es3-guard.json`: Prevents accidental modern syntax (`const`, `let`, arrow functions) in host scripts.
- `test-contract-guard.json`: Guarantees interactive DOM IDs match the contract baseline.
- `css-token-lint.json`: Enforces `--cs-*` design token consistency.

### 4. Property-Based Testing (Fast-Check)
Over 20 property-based suites testing deep algorithmic edge cases:
- Bridge hex encoding/decoding reversibility round-trips.
- Live project survival during simulated save crashes.
- FIFO background render queue integrity and ordering.

### 5. Kiro Powers (`.kiro/powers/`)
- **`ae-cep-helper`:** Custom power providing deep CEP manifest inspections and ExtendScript syntax validation.

### 6. Model Context Protocol (`.kiro/mcp.json`)
- MCP servers configured to expose After Effects scripting APIs and local file system bridges directly to the AI agent.

### 7. Custom Specialized Agents (`.kiro/agents/`)
- **`ae-script-reviewer.md`:** Specialized agent enforcing After Effects ExtendScript ES3 safety and undo boundaries.
- **`compsaver-debugger.md`:** CEP bridge log analyzer and crash diagnostician.

---

## 🏗️ Architecture & Dual Runtime

CompSaver bridges modern web standards with Adobe's native scripting engine:

```
┌───────────────────────────────────────────────┐
│        CompSaver Panel (CEP Chromium 88)      │
│  HTML5 + Vanilla CSS (Tokens) + ES2020 JS     │
│  - Virtual Grid Renderer (5,000+ items)       │
│  - Persistent Cache Index & State Machines    │
└───────────────────────┬───────────────────────┘
                        │
             Hex-Encoded Bridge Protocol
             encodeBridge() / decodeBridge()
                        │
┌───────────────────────▼───────────────────────┐
│        After Effects Host (ExtendScript ES3)  │
│  - app.beginUndoGroup() / app.endUndoGroup()  │
│  - Reduce-First Project Isolation Engine      │
│  - Keyframe Velocity & Layer Manipulators     │
└───────────────────────────────────────────────┘
```

---

## 🚀 Getting Started & Installation

### Prerequisites
- **Adobe After Effects:** 2020 through 2026+
- **Node.js:** v18+ (for development and test execution)

### 1. Enable Adobe CEP Debug Mode
Allow unsigned extensions to run during development:
- **Windows (PowerShell):**
  ```powershell
  Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.9" -Name "PlayerDebugMode" -Value "1"
  Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.10" -Name "PlayerDebugMode" -Value "1"
  Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.11" -Name "PlayerDebugMode" -Value "1"
  ```
- **macOS:**
  ```bash
  defaults write com.adobe.CSXS.9 PlayerDebugMode 1
  defaults write com.adobe.CSXS.10 PlayerDebugMode 1
  defaults write com.adobe.CSXS.11 PlayerDebugMode 1
  ```

### 2. Install the Extension
Clone or symlink this repository into your Adobe CEP extensions directory:
- **Windows:**
  ```powershell
  %APPDATA%\Adobe\CEP\extensions\CompSaver
  ```
- **macOS:**
  ```bash
  ~/Library/Application Support/Adobe/CEP/extensions/CompSaver
  ```

### 3. Launch in After Effects
1. Open Adobe After Effects.
2. In the top menu, navigate to: **Window ▸ Extensions ▸ Comp Saver**.
3. The panel will dock into any panel space in your After Effects workspace.

---

## 🧪 Testing & Verification

CompSaver maintains a rigorous test suite with 1,580+ automated unit, contract, and property-based tests:

```bash
# Install dependencies
npm install

# Run the complete test suite
npm test

# Run contract tests
npx jest tests/class-contract.test.js

# Run property-based tests
npx jest tests/background-queue-fifo.property.test.js
```

---

## 📁 Repository Structure

```
CompSaver/
├── index.html                   # Master CEP application shell & DOM layout
├── package.json                 # Test runners and scripts
├── CSXS/manifest.xml            # Adobe CEP extension manifest
├── .kiro/                       # Kiro IDE configuration & specifications
│   ├── specs/                   # EARS feature specifications & tasks
│   ├── steering/                # Product, tech, and convention docs
│   ├── hooks/                   # Automated pre-commit verification guards
│   ├── agents/                  # Autonomous specialized review agents
│   ├── powers/                  # Domain-specific developer powers
│   └── mcp.json                 # Model Context Protocol definitions
├── css/                         # Obsidian design tokens & component styles
├── js/
│   ├── core/                    # Immutable bridge, state, persistence primitives
│   ├── ui/                      # Responsive components (Sidebar, Modals, Toast)
│   ├── templates/               # Virtualized grid and template handlers
│   └── toolkit/                 # Motion design utility tools
├── jsx/                         # Host ExtendScript modules executed in After Effects
│   ├── core.jsx                 # Base host utilities, undo helpers, JSON parser
│   ├── templates_save.jsx       # Non-destructive composition saving engine
│   └── workflow.jsx             # Keyframe, layer, and timeline manipulators
└── tests/                       # 1,580+ Jest & fast-check property tests
```

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
