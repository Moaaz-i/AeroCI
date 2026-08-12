# 🌪️ CI-Drift (`drift`)

> **Local Digital Twin & Pipeline Simulator for GitHub Actions**
> Eliminate blind commits and debug CI pipelines locally in milliseconds without wasting remote CI quota.

---

## 🚀 Quick Start

### Installation

Install `ci-drift` globally or run locally:

```bash
npm install -g ci-drift
```

### Basic Commands

```bash
# Initialize local CI-Drift configuration & sample workflow
drift init

# Run Pre-flight Check (detect YAML syntax errors & missing local .env secrets)
drift check

# Simulate pipeline execution locally in an isolated ephemeral environment
drift run

# Enter interactive debug sandbox with simulated CI context variables
drift debug

# Launch live web analytics dashboard (Powered by VelociRadix HTTP engine)
drift ui
```

---

## 🛠️ Feature Architecture

- **`drift init`**: Creates `.drift.json` configuration and auto-generates GitHub Actions sample workflow.
- **`drift check`**: Pre-flight audit engine that parses workflow YAMLs, inspects required `secrets.*` and alerts if missing in `.env`.
- **`drift run`**: Executes step-by-step pipeline actions inside ephemeral child processes with full GitHub context (`CI=true`, `GITHUB_ACTIONS=true`).
- **`drift debug`**: Drops you into an interactive sub-shell configured with exact step environment variables.
- **`drift ui`**: Embedded high-speed dashboard powered by the **VelociRadix** HTTP engine at `http://localhost:3500`.

---

## 📄 License

MIT © Moaaz
