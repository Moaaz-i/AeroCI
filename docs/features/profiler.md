# Profiler

```bash
aeroci run --profile        # timing table, cost projection and trend for this run
aeroci profile             # your run history
aeroci profile --limit 50  # how many runs to show
```

History lives in `.aeroci-artifacts/history.jsonl`, one JSON line per run,
appended by `aeroci run`. It is a record of what happened on **your machine**,
and everything below is measured there.

The tables below are real output from a four-step workflow, copied as printed.

---

## The timing table

```
🐢 Slowest steps

┌──────────────────────────────────────────────────────────┐
│ Job     Step                 Time  Share                 │
├──────────────────────────────────────────────────────────┤
│ build   Build                37ms  100%  ████████████████ │
│ build   Report               16ms  43%   ███████         │
│ notify  echo "notified "     15ms  41%   ███████         │
│ build   actions/checkout@v4  1ms   3%    █               │
└──────────────────────────────────────────────────────────┘
```

Real measurements of real processes. A step that took 3.2s because `npm ci`
downloaded 248 packages shows 3.2s, and nothing is estimated — a step that
could not be timed is not in the table.

The `Share` column is each step's fraction of the slowest step, not of the
total. It answers "what is worth looking at", which is why the baseline is the
maximum rather than the sum.

---

## The cost projection

```
💵 Cost on a GitHub-hosted ubuntu-latest
  Measured step time        : 69ms
  Billable minutes          : 2 (each job rounds up to 1 minute · $0.008/min)
  Projected cost            : $0.016
     This is a projection from the durations measured above, not a measurement of a
     hosted run. Real time is usually higher, so treat it as a lower bound.
```

How it is computed: your measured step time is grouped by job, each job is
rounded **up** to a whole minute, and multiplied by the list price for that OS.

| Runner | USD/min |
|--------|---------|
| Linux | 0.008 |
| Windows | 0.016 |
| macOS | 0.08 |

The two jobs above took 69ms between them and bill as 2 minutes, which is why
the figure is `$0.016` and not `$0.009`. That rounding is GitHub's, not a
penalty the tool added.

Two things it cannot include, both of which make a real run slower: a hosted
runner spends real time you are not measuring — cloning the repo, downloading
the toolchain, starting the VM — and it spends time in the queue, which is
usually the largest term of all.

Use it to compare two versions of a workflow against each other. It is not a
quote, and the tool says so in the output every time rather than only here.

---

## Run history

```
ℹ [AeroCI] Run history — last 10 of 10

┌───────────────────────────────────────────────────────────────┐
│ When                   Workflow  Step time  Pass  Fail  Heap  │
├───────────────────────────────────────────────────────────────┤
│ 9/26/2026, 2:50:52 PM  CI        62ms       4     0     8MB   │
│ 9/26/2026, 2:50:57 PM  CI        50ms       4     0     7.8MB │
│ 9/26/2026, 2:51:15 PM  CI        55ms       4     0     8MB   │
│ 9/26/2026, 2:52:26 PM  CI        69ms       4     0     7.7MB │
└───────────────────────────────────────────────────────────────┘
```

(Real output; the run above had ten entries and the middle six are elided.)

---

## The trend

With two or more runs of the same workflow, `aeroci run --profile` compares
this run against your previous ones:

```
📊 Compared with your last 9 run(s)
  This run                  : 69ms
  Average before            : 51ms (median 50ms)
  Change vs median          : 19ms (38%) slower
  ▇▅▅▅▅▅▅▅▅  10 most recent runs
```

The word carries the direction and the number carries the size, so the line
never says "19ms (-38%) slower". Both numbers are shown because they answer
different questions: the median is what a typical run of this workflow costs,
the average is what the last twelve cost together, and they diverge exactly
when there is an outlier worth knowing about.

The baseline is a **median**, not a mean, so one slow afternoon does not move
it for good. The sparkline is the most recent runs at a glance — in the
example, one tall bar at the end is the run in question.

Only runs of the **same workflow** count. A slow `release` run never becomes
the baseline for `CI`.

---

## The observations

```
🔎 Worth knowing
  ! every job is on one dependency chain (2 deep), so none of them overlap — if they do
    not actually depend on each other's output, drop the `needs:`
  · no job sets `timeout-minutes`, so a hung step waits for the 6-hour platform limit
  Peak heap                 : 7.7MB (+0.1MB during the run)
```

These are concrete facts about the workflow, not a score. A 0–100 number would
hide which of them matters for your repository — a missing `timeout-minutes` is
free to fix and worth more than a duplicate step you cannot delete because two
teams own it.

The set covers: a package install with no `actions/cache` step, a job with no
`timeout-minutes`, steps that look like tests or checks with no `if:` guard, a
job chain that serialises work that could overlap, and more.

---

## What the profiler does not do

- **It does not compare against a hosted run.** There is no baseline of what CI
  "should" cost; every number here was measured on your machine.
- **It does not estimate durations before you run.** The analyzer's old keyword
  table (`npm install` → 60s) was removed: a number invented from a keyword is
  a number that will be wrong, and being wrong about time is worse than saying
  nothing.
- **It does not know your cache state, registry latency or queue time.** Those
  are the difference between your 69ms and GitHub's four minutes.
