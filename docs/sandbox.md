# Sandbox & Isolation

AeroCI runs your CI steps inside a fully isolated ephemeral sandbox.
Your real project files are **never modified**.

---

## How It Works

```
Your Project Root
       │
       │  clonefile() CoW snapshot (~10ms on APFS)
       ▼
/tmp/aeroci-sandbox-{timestamp}-{id}/
   ├── src/
   ├── package.json
   ├── .github/
   │    └── workflows/
   ├── node_modules -> (symlink to real node_modules)
   ├── .github_env    (GITHUB_ENV file)
   ├── .github_path   (GITHUB_PATH file)
   └── .github_output (GITHUB_OUTPUT file)
       │
       │  All steps execute here
       ▼
🧹 Auto-deleted after pipeline completes (or fails)
```

---

## Copy Strategy

### macOS (APFS) — `clonefile()` Copy-on-Write

On macOS with APFS volumes, AeroCI uses the `COPYFILE_FICLONE` flag
which creates an instant **O(1) copy-on-write snapshot** of the project directory.

- **Setup time:** ~8–15ms regardless of project size
- **Disk impact:** Zero until files are actually modified
- **100x faster** than `cp -r` or `fs.cpSync`

```js
// Under the hood:
fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
```

### Linux / Windows — Async Parallel Copy

On non-APFS systems, AeroCI uses async parallel `fs.copyFile()` calls
across all project files simultaneously.

- **Setup time:** ~50–200ms depending on project size
- `node_modules` is always **symlinked**, never copied

---

## Environment Variables

Inside the sandbox, AeroCI pre-sets all standard GitHub Actions environment variables:

```bash
CI=true
GITHUB_ACTIONS=true
GITHUB_WORKFLOW="your-workflow-name"
GITHUB_RUN_ID=10001
GITHUB_RUN_NUMBER=1
GITHUB_SHA=local-sha-0000000
GITHUB_REF=refs/heads/main
GITHUB_REPOSITORY=local/repo
GITHUB_ACTOR=developer
GITHUB_WORKSPACE=/tmp/aeroci-sandbox-...
GITHUB_EVENT_NAME=push
RUNNER_OS=Linux
RUNNER_ARCH=X64
```

Plus everything from your `.env` file.

---

## GITHUB_OUTPUT, GITHUB_ENV, GITHUB_PATH

AeroCI fully implements the GitHub Actions output mechanisms:

```bash
# Setting a step output
echo "version=1.2.3" >> $GITHUB_OUTPUT

# Setting an env var for subsequent steps
echo "MY_VAR=hello" >> $GITHUB_ENV

# Adding to PATH
echo "/custom/bin" >> $GITHUB_PATH
```

These are parsed after each step and propagated to subsequent steps
just like real GitHub Actions.

---

## Step Outputs (`steps.<id>.outputs.*`)

```yaml
steps:
  - id: get-version
    run: echo "version=1.2.3" >> $GITHUB_OUTPUT

  - run: echo "Version is \${{ steps.get-version.outputs.version }}"
```

AeroCI reads `$GITHUB_OUTPUT` after each step and makes outputs available
to all subsequent steps via `steps.<id>.outputs.<key>` expressions.

---

## Cleanup

The sandbox is always deleted after a run — even on failure.
No temp files are left behind.

```
ℹ [AeroCI] 🧹 Ephemeral Sandbox auto-cleaned. (Zero disk footprint)
```
