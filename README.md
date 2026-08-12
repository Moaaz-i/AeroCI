# ✈️ AeroCI (`aeroci`)

> **Local Digital Twin & Pipeline Simulator for GitHub Actions**
> Eliminate blind commits and debug CI pipelines locally in milliseconds without wasting remote CI quota.

---

## 🚀 Quick Start

### Installation

Install `aeroci` globally or run locally:

```bash
npm install -g aeroci
```

### Basic Commands

```bash
# Initialize local AeroCI configuration & sample workflow
aeroci init

# Run Pre-flight Check (detect YAML syntax errors & missing local .env secrets)
aeroci check

# Simulate pipeline execution locally in an isolated ephemeral environment
aeroci run

# Enter interactive debug sandbox with simulated CI context variables
aeroci debug

# Launch live web analytics dashboard (Powered by VelociRadix HTTP engine)
aeroci ui
```

---

## 🛠️ Feature Architecture

- **`aeroci init`**: Creates `.aeroci.json` configuration and auto-generates GitHub Actions sample workflow.
- **`aeroci check`**: Pre-flight audit engine that parses workflow YAMLs, inspects required `secrets.*` and alerts if missing in `.env`.
- **`aeroci run`**: Executes step-by-step pipeline actions inside ephemeral child processes with full GitHub context (`CI=true`, `GITHUB_ACTIONS=true`).
- **`aeroci debug`**: Drops you into an interactive sub-shell configured with exact step environment variables.
- **`aeroci ui`**: Embedded high-speed dashboard powered by the **VelociRadix** HTTP engine at `http://localhost:3500`.

---

## 📄 License

MIT © Moaaz
