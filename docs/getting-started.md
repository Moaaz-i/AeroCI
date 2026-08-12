# Getting Started with AeroCI

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 16.7.0 |
| macOS (APFS) | Recommended for clonefile() speed |
| Linux / Windows | Supported (fallback copy mode) |

---

## Installation

### Global install (recommended)
```bash
npm install -g aeroci
```

### From source
```bash
git clone https://github.com/Moaaz-i/AeroCI.git
cd AeroCI
npm install
npm link        # makes `aeroci` available globally
```

### Run without installing
```bash
npx aeroci run
```

---

## Quick Start

### 1. Initialize AeroCI in your project

```bash
cd your-project
aeroci init
```

This creates:
- **`.aeroci.json`** — local configuration file
- **`.github/workflows/main.yml`** — sample GitHub Actions workflow (if none exists)

### 2. Audit your workflows

```bash
aeroci check
```

Runs 15+ static analysis guards: missing secrets, deprecated actions, syntax errors, matrix audits, and more.

### 3. Simulate the pipeline locally

```bash
aeroci run
```

Clones your project into an isolated APFS sandbox (~10ms), executes every step, then auto-deletes the sandbox. **Zero impact on your real files.**

### 4. View the results

```bash
aeroci profile          # run history & trends
aeroci report           # generate HTML/JSON/JUnit/Markdown reports
```

---

## Your First Run

```
$ aeroci run

    _                 ____ ___ 
   / \   ___ _ __ ___/ ___|_ _|
  / _ \ / _ \ '__/ _ \___ \| | 
 / ___ \  __/ | | (_) |__) | | 
/_/   \_\___|_|  \___/____/___| 
 Local Digital Twin & CI Pipeline Simulator v2.0.0

ℹ [AeroCI] ⚡ Isolated Sandbox ready at: /tmp/aeroci-sandbox-... (8ms · 12 items cloned)

▶ Executing Job: [build-and-test] (runs-on: ubuntu-latest)

  ↳ Step 1/4: Checkout Code
✔ [AeroCI]     ✔ [actions/checkout]: Isolated sandbox mounted (clonefile CoW).

  ↳ Step 2/4: Setup Node.js
✔ [AeroCI]     ✔ [actions/setup-node]: Node.js 20 ready.

  ↳ Step 3/4: Install & Build
      | added 248 packages in 3.2s
✔ [AeroCI]     ✔ Completed in 3241ms

📈 Step Execution Coverage
  • Steps Executed: 4/4  • Coverage: 100%

⏱  Per-Step Timing Breakdown
┌─────────────────────────────────────────────────────────┐
│   Job           Step              Duration   Relative   │
├─────────────────────────────────────────────────────────┤
│ ✔ build-test   Checkout           1ms       ░░░░░░░░░  │
│ ✔ build-test   Setup Node.js      1ms       ░░░░░░░░░  │
│ ✔ build-test   Install & Build   3241ms     █████████  │
└─────────────────────────────────────────────────────────┘

💰 CI Cost & Time Savings
  • Time Saved: 30.00s  • Est. Cost Saved: $0.0040 USD

✔ [AeroCI] Workflow simulated successfully in 3.4s! 🚀
ℹ [AeroCI] 🧹 Ephemeral Sandbox auto-cleaned.
```

---

## Next Steps

- 📖 [CLI Reference](./cli-reference.md) — all commands and flags
- 🛡️ [Security Audit](./features/security.md) — run `aeroci security`
- 📊 [Profiler](./features/profiler.md) — track performance over time
- 🔧 [Action Simulator](./features/actions.md) — supported actions
