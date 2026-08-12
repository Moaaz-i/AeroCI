# ✈️ AeroCI Documentation

> **Local Digital Twin & CI Pipeline Simulator for GitHub Actions**

---

## 📚 Table of Contents

| Guide | Description |
|-------|-------------|
| [Getting Started](./getting-started.md) | Installation, setup, quickstart |
| [CLI Reference](./cli-reference.md) | All commands & flags |
| [Configuration](./configuration.md) | `.aeroci.json` schema |
| [Sandbox & Isolation](./sandbox.md) | How the ephemeral sandbox works |
| **Features** | |
| [Workflow Analyzer](./features/analyzer.md) | Deep static analysis (Features 1–10) |
| [Performance Profiler](./features/profiler.md) | Timing, cost & trends (Features 11–20) |
| [Security Audit](./features/security.md) | Hardening engine (Features 21–30) |
| [Reports](./features/reporter.md) | JUnit, HTML, JSON, Markdown (Features 31–40) |
| [Action Simulator](./features/actions.md) | Rich action library (Features 41–50) |
| [Contributing](./contributing.md) | How to contribute |

---

## What is AeroCI?

AeroCI is a **100% local** CI pipeline simulator. It runs your GitHub Actions workflows
inside an isolated ephemeral sandbox on your machine — giving you instant feedback
without burning remote CI minutes or committing broken code.

```
aeroci run            # simulate the full pipeline locally
aeroci check          # pre-flight audit before any commit
aeroci security       # dedicated security hardening scan
aeroci analyze        # deep workflow intelligence
aeroci profile        # run history & performance trends
aeroci report         # generate HTML/JUnit/JSON/Markdown reports
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                       AeroCI CLI                         │
│                     bin/aeroci.js                        │
└──────────┬──────────────────────────────────────────────┘
           │
    ┌──────▼──────┐
    │  src/cli.js  │  Commander.js — routes commands
    └──────┬──────┘
           │
   ┌───────┼──────────────────────────────┐
   ▼       ▼        ▼        ▼       ▼    ▼
runner  checker  analyzer security profiler reporter
   │
   ▼
actions (simulator library)
   │
   ▼
APFS clonefile() Isolated Sandbox (~10ms)
```
