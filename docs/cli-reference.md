# CLI Reference

Complete reference for all `aeroci` commands.

---

## Global Options

```
aeroci [command] [options]

Options:
  -V, --version   Print version number
  -h, --help      Display help
```

---

## Commands

### `aeroci init`

Initialize AeroCI in the current project directory.

```bash
aeroci init
```

**Creates:**
- `.aeroci.json` — local configuration
- `.github/workflows/main.yml` — sample workflow (if missing)

---

### `aeroci check [workflow]`

Pre-flight audit of workflow files.

```bash
aeroci check                        # scan .github/workflows/
aeroci check path/to/workflow.yml   # scan a specific file
aeroci check --security             # also run security audit
aeroci check --analyze              # also run deep analyzer
```

**Options:**

| Flag | Description |
|------|-------------|
| `--security` | Run the [Security Hardening Engine](./features/security.md) |
| `--analyze` | Run the [Deep Workflow Analyzer](./features/analyzer.md) |

**What it checks:**
- ✅ YAML syntax validity
- ✅ Missing `name`, `on`, `jobs` fields
- ✅ Deprecated action versions (`@v1`, `@v2`)
- ✅ npm package typo guard (live npm registry check)
- ✅ Hardcoded credentials detection
- ✅ Sudo usage warnings
- ✅ Required secrets vs local `.env` comparison
- ✅ Matrix strategy audit

---

### `aeroci run [workflow]`

Simulate the full CI pipeline inside an isolated ephemeral sandbox.

```bash
aeroci run                           # run all workflows in .github/workflows/
aeroci run path/to/workflow.yml      # run a specific workflow
aeroci run --only-job build          # run only the "build" job
aeroci run --report                  # generate HTML/JUnit/JSON/MD reports after run
aeroci run --timeout 5               # set per-step timeout to 5 minutes
aeroci run --env NODE_ENV=production # inject environment variables
aeroci run --env KEY=val --env K2=v2 # multiple injections
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--only-job <id>` | string | — | Run only a specific job by ID |
| `--report` | boolean | false | Generate all report formats after run |
| `--timeout <min>` | number | 10 | Per-step timeout in minutes |
| `--env <KEY=VAL>` | string | — | Inject env vars (repeatable) |
| `-d, --debug` | boolean | false | Enter interactive debug shell on failure |

**How it works:**
1. Clones project to an isolated temp directory using APFS `clonefile()` (~10ms)
2. Symlinks `node_modules` (no copy needed)
3. Executes each workflow step in the sandbox
4. Prints profiler report, coverage, cost estimate
5. Auto-deletes the sandbox on exit

---

### `aeroci debug`

Spawn an interactive sub-shell pre-configured with the simulated GitHub Actions environment.

```bash
aeroci debug
```

Environment variables set inside the shell:
```
CI=true
GITHUB_ACTIONS=true
GITHUB_RUN_ID=10001
GITHUB_REF=refs/heads/main
AEROCI_DEBUG=1
# + all keys from your .env file
```

Exit with `Ctrl+D` or `exit`.

---

### `aeroci analyze [workflow]`

Run the [Deep Workflow Analyzer](./features/analyzer.md) — 10 intelligence checks.

```bash
aeroci analyze
aeroci analyze .github/workflows/deploy.yml
```

**Checks:**
1. Step dependency graph
2. Dead step detector
3. Duplicate step detector
4. Step duration estimator
5. Shell compatibility checker
6. Secret flow map
7. Artifact lifecycle tracker
8. Circular job dependency detector
9. Concurrency group conflict analyzer
10. Workflow complexity score (0–100)

---

### `aeroci security [workflow]`

Dedicated [Security Hardening Audit](./features/security.md) — 10 security checks.

```bash
aeroci security
aeroci security --report            # save security-report.md
```

**Options:**

| Flag | Description |
|------|-------------|
| `--report` | Save findings to `security-report.md` |

**Checks:**
- Supply chain attack detection
- Overly-broad `write-all` permissions
- Environment variable injection risks
- Script injection via user-controlled input
- Hardcoded secrets in env blocks
- `pull_request_target` + checkout vulnerability
- Self-hosted runner sensitive operation risks
- OIDC token scope validation
- Dependency confusion guard

---

### `aeroci profile`

Display run history, timing trends, and performance analytics.

```bash
aeroci profile
```

Shows the last 20 runs from `.aeroci-artifacts/history.jsonl`:

```
📊 Run History (last 5 run(s)):
┌──────────────────────────────────────────────────────────────┐
│ Timestamp          Workflow        Duration  Steps  Peak Mem │
├──────────────────────────────────────────────────────────────┤
│ 8/12/2026 7:34 AM  Build & Test    3.40s     4/4    12MB     │
└──────────────────────────────────────────────────────────────┘
```

---

### `aeroci report`

Generate or view reports from the last run.

```bash
aeroci run --report                        # generate reports during run
aeroci report                              # re-generate from last run data
aeroci report --format html                # specific format only
aeroci report --format html,junit          # multiple formats
aeroci report --diff fileA.yml:fileB.yml   # structural diff two workflows
aeroci report --changelog                  # git history of workflow changes
```

**Options:**

| Flag | Description |
|------|-------------|
| `--format <list>` | Comma-separated: `html`, `json`, `junit`, `markdown` |
| `--diff <a:b>` | Show structural diff between two workflow files |
| `--changelog` | Generate changelog from git history |

**Output files:**

| Format | File |
|--------|------|
| HTML | `aeroci-report.html` |
| JSON | `aeroci-run.json` |
| JUnit XML | `aeroci-report.xml` |
| Markdown | `aeroci-summary.md` |
| Security | `security-report.md` |

---

### `aeroci versions [workflow]`

Check action versions in your workflows against the known latest releases.

```bash
aeroci versions
aeroci versions .github/workflows/deploy.yml
```

**Example output:**
```
⚠ actions/checkout@v3  →  Latest: v4
⚠ actions/setup-node@v3  →  Latest: v4
✔ actions/cache@v4  →  Up to date
```

---

### `aeroci ui`

Launch the local web dashboard (powered by Velociradix) at `http://localhost:3500`.

```bash
aeroci ui
aeroci ui --port 4000     # custom port
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <n>` | 3500 | Port to listen on |
