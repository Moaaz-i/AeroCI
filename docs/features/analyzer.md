# Deep Workflow Analyzer

> **`aeroci analyze`** — Features 1–10

The Analyzer performs static intelligence checks on your workflow YAML files,
helping you catch structural problems, inefficiencies, and hidden risks
before running the pipeline.

---

## Usage

```bash
aeroci analyze                             # scan all workflows
aeroci analyze .github/workflows/ci.yml   # scan a specific file
aeroci check --analyze                     # combine with pre-flight check
```

---

## Feature 1 — Step Dependency Graph

Maps `needs:` relationships between jobs and detects:
- Which jobs run in parallel
- Which jobs block others
- Missing `needs:` on jobs that require prior outputs

```
Output example:
  📊 Job Dependency Graph
  build  →  test  →  deploy
              ↘
               lint (parallel)
```

---

## Feature 2 — Dead Step Detector

Identifies steps that can **never execute** because they have an `if:` condition
that always evaluates to `false`:

```yaml
- name: Deploy to Prod
  if: false          # ← flagged as dead step
  run: ./deploy.sh
```

---

## Feature 3 — Duplicate Step Detector

Finds identical `run:` scripts repeated across multiple steps or jobs.
Suggests extracting them into a reusable composite action.

---

## Feature 4 — Step Duration Estimator

Provides intelligent time estimates for each step based on keywords:

| Pattern | Estimated Duration |
|---------|--------------------|
| `npm install` / `pip install` | ~60s |
| `npm test` / `pytest` | ~30s |
| `npm run build` | ~45s |
| `docker build` | ~120s |
| `actions/checkout` | ~5s |

These estimates are used by the Profiler's cost calculator.

---

## Feature 5 — Shell Compatibility Checker

Detects `bash`-specific syntax used in steps that run with `sh` (the default):

```yaml
- run: |
    arr=(a b c)     # ← bash array syntax, fails in sh
    echo ${arr[0]}
  shell: sh         # ← incompatible
```

**Flagged patterns:**
- Arrays: `arr=(...)`
- `[[ ]]` double brackets
- Process substitution: `<(...)`
- Here-strings: `<<< "..."`

---

## Feature 6 — Secret Flow Map

Traces the path of each `${{ secrets.* }}` reference through:
- Workflow-level `env:` blocks
- Job-level `env:` blocks
- Step `env:` blocks
- `run:` script inline references

Flags secrets that flow into unsafe contexts (e.g., directly into `run:` scripts).

---

## Feature 7 — Artifact Lifecycle Tracker

Verifies that every `actions/upload-artifact` has a corresponding
`actions/download-artifact` in a dependent job, and vice versa.

```
⚠ [AeroCI Warning] Artifact "build-output" uploaded in job:build
  but never downloaded in any dependent job
```

---

## Feature 8 — Circular Job Dependency Detector

GitHub Actions will fail at queue time if `needs:` creates a cycle.
AeroCI detects it locally:

```yaml
jobs:
  a:
    needs: b    # ← CYCLE!
  b:
    needs: a
```

```
⚠ Circular dependency detected: a → b → a
```

---

## Feature 9 — Concurrency Group Conflict Analyzer

Detects when multiple jobs use the same `concurrency.group` string,
which could cause unexpected cancellations.

---

## Feature 10 — Workflow Complexity Score

Produces a single **0–100 score** rating the complexity of your workflow:

| Score | Label |
|-------|-------|
| 0–25 | 🟢 Simple |
| 26–50 | 🟡 Moderate |
| 51–75 | 🟠 Complex |
| 76–100 | 🔴 Very Complex |

**Factors considered:**
- Number of jobs
- Total step count
- Matrix dimensions
- Number of `needs:` edges
- Use of dynamic expressions

A high complexity score is a signal to split your workflow into multiple files.
