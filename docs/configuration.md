# Configuration Reference — `.aeroci.json`

AeroCI is configured via a `.aeroci.json` file in your project root.
Run `aeroci init` to generate the default configuration.

---

## Full Schema

```json
{
  "$schema": "https://aeroci.dev/schema.json",
  "version": "2.0.0",

  "runner": {
    "defaultImage": "ubuntu-latest",
    "isolation": "ephemeral-node",
    "timeout": 300
  },

  "environment": {
    "envFile": ".env",
    "strictSecrets": true
  },

  "reporting": {
    "outputDir": "./aeroci-reports",
    "formats": ["html", "json", "junit", "markdown"]
  },

  "security": {
    "enabled": true,
    "failOnCritical": true,
    "failOnHigh": false
  },

  "profiler": {
    "enabled": true,
    "historyLimit": 50
  }
}
```

---

## Fields

### `runner`

Controls how the pipeline simulation sandbox behaves.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultImage` | string | `"ubuntu-latest"` | Simulated runner image label |
| `isolation` | string | `"ephemeral-node"` | Isolation strategy (`ephemeral-node` = clonefile sandbox) |
| `timeout` | number | `300` | Global pipeline timeout in seconds |

---

### `environment`

Controls how environment variables and secrets are loaded.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `envFile` | string | `".env"` | Path to local env file (relative to project root) |
| `strictSecrets` | boolean | `true` | Fail `aeroci check` if secrets referenced in workflow are missing from `.env` |

#### `.env` file example
```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxx
NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxx
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

> **Note:** AeroCI never uploads or logs your `.env` file. It stays local.

---

### `reporting`

Controls output file locations and enabled report formats.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `outputDir` | string | `"."` | Directory where report files are written |
| `formats` | array | `["html","json","junit","markdown"]` | Which report formats to generate |

Available format values: `html`, `json`, `junit`, `markdown`.

---

### `security`

Controls the security hardening engine behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable security audit |
| `failOnCritical` | boolean | `true` | Exit with code 1 on CRITICAL findings |
| `failOnHigh` | boolean | `false` | Exit with code 1 on HIGH findings |

---

### `profiler`

Controls run history storage.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Record each run to history |
| `historyLimit` | number | `50` | Maximum number of runs to keep in `.aeroci-artifacts/history.jsonl` |

---

## Minimal Configuration

You can run AeroCI with zero configuration — just a `.aeroci.json` with:

```json
{
  "version": "2.0.0"
}
```

All other values will use their defaults.
