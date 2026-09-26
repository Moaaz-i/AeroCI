# Reports

```bash
aeroci run --report                     # write reports for this run
aeroci report                           # re-render the last run
aeroci report --format html             # pick the formats
aeroci report --out ~/reports           # write them somewhere else
aeroci report --diff a.yml:b.yml        # structural diff of two workflows
aeroci report --history                 # commits that touched the workflows
```

---

## What gets written

Everything goes under `.aeroci-artifacts/report/`, one set of files per
workflow, named after the workflow file:

```
.aeroci-artifacts/
├── history.jsonl          one line per run, appended by aeroci run
└── report/
    ├── index.json         what was run, and where each detail file is
    ├── ci.json            the full record — the source of truth
    ├── ci.md              GitHub Job Summary markdown
    ├── ci.html            a standalone report you can open or share
    └── ci.xml             JUnit XML
```

Override the location with `--report-dir`, or the per-invocation output with
`--out`. Each workflow gets its own `<slug>.*`, so running several at once
cannot make the last one overwrite the others.

**The JSON is the source of truth.** The other three formats are re-renders of
it, which is why `aeroci report --format html` can regenerate a report for a
run from last week without re-running anything — and why changing formats can
never change what the run actually did.

---

## The formats

### JSON

The complete record: the git state the run saw, every job and matrix
instance, every step with its script, exit code, duration, outputs, log lines,
warnings, and whether it was `not simulated`.

This is the one to read when you want to know exactly what happened.

### Markdown

Meant for a GitHub job summary: status emoji, a table of steps with timings,
and the failure detail for anything that failed. Paste it into
`$GITHUB_STEP_SUMMARY` if you want it in the run page.

### HTML

A single self-contained file — no external assets, no network. Open it from
disk or attach it. It is not interactive beyond the tables; it is a document
that reads well.

### JUnit XML

For whatever consumes JUnit: Jenkins, GitLab, a test dashboard, or a CI system
that wants to fail a build on a step failure.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="AeroCI" time="0.067" tests="4" failures="0" errors="0" skipped="0">
  <testsuite name="CI" time="0.067" tests="4" failures="0" errors="0" skipped="0">
    <testsuite name="build" time="0.051" tests="3" failures="0" errors="0" skipped="0">
      <testcase name="Build" classname="build" time="0.032">
        <system-out>GITHUB_OUTPUT sha=abc123</system-out>
      </testcase>
```

Jobs are nested `testsuite`s, so a viewer can attribute a failure to a job and
a step.

---

## GitHub annotations

A failing step emits the workflow command a runner would:

```
::error file=.github/workflows/fail.yml,title=Run tests::job "t" step "Run tests" failed with exit code 3
```

Any tool that reads `::error` — an IDE, a PR view — highlights the right line
without knowing anything about AeroCI. `--no-annotations` turns it off.

---

## Reproducers

When a step fails, the report ends with the command to run it again, in the
same shell AeroCI used:

```
Reproduce a failure
Each command runs the failing step in the same shell AeroCI used:

  # 1 t > "Run tests"
  $ bash --noprofile --norc -eo pipefail <<'AEROCI_REPRO'
  exit 3
  AEROCI_REPRO
  # or: bash --noprofile --norc -eo pipefail -c 'exit 3'
```

The flags in that command are the real ones — `--noprofile --norc` so your own
dotfiles cannot change the answer, and `-eo pipefail` so the semantics match
the step's. Pasting it reproduces the failure instead of approximating it.

Run it inside `aeroci debug` and you have the step's environment too.

---

## Step coverage

The summary reports how much of the workflow actually ran:

```
  Steps                     : 4/4 executed
  Step coverage             : 4/4 executed (100%)
```

A run that skipped half its steps because a dependency failed shows 50%, not
100%. And a step that was `not simulated` is counted as not executed — which is
the point.

---

## `--diff`

A structural comparison of two workflow files: jobs and steps added or removed,
and `on:` trigger changes. It compares structure, not text, so reindenting a
file or reordering two steps of equal weight shows no diff.

```bash
aeroci report --diff ci.yml:release.yml
```

The form is `a:b` — one argument, colon-separated, not two paths.

---

## `--history`

The commits that touched a workflow directory, from `git log`. Useful after a
run broke: the question is usually "what changed", and the answer is usually
one of the last three commits.

```bash
aeroci report --history                    # .github/workflows
aeroci report --history path/to/workflows  # somewhere else
```

Outside a git repository it says so rather than printing an empty list.
