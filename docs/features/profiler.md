# Performance Profiler

> **`aeroci profile`** — Features 11–20

The Profiler automatically records every run, measures per-step timing,
tracks memory usage, estimates costs, and detects performance trends.

---

## Usage

```bash
aeroci run              # profiler runs automatically
aeroci profile          # view run history and trends
```

---

## Feature 11 — Per-Step Timing Table

After every `aeroci run`, a timing table is printed:

```
⏱  Per-Step Timing Breakdown

┌────────────────────────────────────────────────────────────────────────────┐
│     Job           Step                    Duration   Relative              │
├────────────────────────────────────────────────────────────────────────────┤
│ ✔   build         Checkout                1ms        ░░░░░░░░░░░░░░░░░░░░  │
│ ✔   build         Setup Node.js           1ms        ░░░░░░░░░░░░░░░░░░░░  │
│ ✔   build         Install dependencies    3241ms     ████████████████████  │
│ ✔   build         Run tests               892ms      ████████░░░░░░░░░░░░  │
└────────────────────────────────────────────────────────────────────────────┘
```

The `Relative` column shows a mini bar chart proportional to each step's
share of the total runtime.

---

## Feature 12 — Slowest Step Highlighter

The slowest step is always highlighted at the bottom of the timing report:

```
  Slowest step: "Install dependencies" in job build (3241ms)
```

---

## Feature 13 — CI Cost Estimator

Calculates how much money and time AeroCI saved vs running on GitHub Actions:

```
💰 CI Cost & Time Savings
  • Local Execution Time     : 4.14s
  • Est. GitHub Actions Time : 34.14s (incl. runner setup)
  • Time Saved               : 30.00s  (8.2x faster)
  • Est. Billable Minutes    : 0.57 min
  • Est. Cost Saved          : $0.0046 USD
```

Calculations use GitHub's public [billing rates](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions):
- **Linux:** $0.008 / minute
- **macOS:** $0.08 / minute
- **Windows:** $0.016 / minute

---

## Feature 14 — Run History Logger

Every run is appended to `.aeroci-artifacts/history.jsonl` (newline-delimited JSON):

```json
{"timestamp":"2026-08-12T04:34:18.000Z","workflow":"CI","totalMs":4142,"passed":4,"failed":0,"peakMemMB":12}
{"timestamp":"2026-08-12T04:36:22.000Z","workflow":"CI","totalMs":3891,"passed":4,"failed":0,"peakMemMB":11}
```

View with: `aeroci profile`

---

## Feature 15 — Trend Analyzer

When 2+ historical runs exist, the profiler compares the latest run to the average:

```
📈 Performance Trend (vs last 5 runs)
  • Average Duration: 4.02s
  • This Run:         4.14s  (+3.0% slower)
  • Trend:            ↗ Slightly slower

  Sparkline: ▂▃▂▃▄▃▃▄  (last 8 runs)
```

---

## Feature 16 — Parallelism Analyzer

Detects jobs that **could** run in parallel (no `needs:` dependency between them)
but are currently sequential:

```
💡 Parallelism Opportunity
  Jobs "lint" and "test" have no dependency relationship.
  Consider running them in parallel to save ~45s.
```

---

## Feature 17 — Cache Hit Simulator

Simulates `actions/cache` hit/miss logic using a local `.aeroci-artifacts/action-cache/index.json`:

- **First run:** MISS — registers cache key for next run
- **Subsequent runs:** HIT — simulates restored cache

```
✔ [actions/cache]: Cache HIT for key "node-modules-abc123"
↩ Restored "node_modules" from local cache store
```

---

## Feature 18 — Network I/O Estimator

Estimates the amount of data that would be downloaded during a real CI run,
based on detected operations:

| Operation | Estimated Size |
|-----------|----------------|
| `npm install` (no lock) | ~50 MB |
| `npm ci` (with lock) | ~30 MB |
| `pip install -r requirements.txt` | ~20 MB |
| `actions/checkout` | ~5 MB |
| Docker base image pull | ~100 MB |

---

## Feature 19 — Memory Usage Tracker

Tracks Node.js heap usage during the simulation:

```
  • Peak Memory Used: 14 MB
```

Reported in the run history for trend analysis.

---

## Feature 20 — Pipeline Efficiency Score

A 0–100 score evaluating your pipeline's configuration quality:

```
🏆 Pipeline Efficiency Score
  • Score: 87/100 🟢 Excellent

  Deductions:
    -5: No job timeout-minutes set
    -8: No caching step detected (npm install without cache)
```

| Score | Rating |
|-------|--------|
| 90–100 | 🟢 Excellent |
| 75–89 | 🟡 Good |
| 50–74 | 🟠 Needs Work |
| 0–49 | 🔴 Poor |

**Factors evaluated:**
- Job timeout configuration
- Caching strategy
- Step count per job
- Use of matrix builds
- Secrets management
