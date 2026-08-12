# Multi-Format Reporting Engine

> **`aeroci report`** — Features 31–40

The Reporting Engine generates rich, structured reports in multiple formats for CI/CD pipeline integration, local debugging, and documentation.

---

## Usage

```bash
aeroci run --report                          # generate reports automatically after run
aeroci report                                # generate from last run data
aeroci report --format html,json             # generate specific formats
aeroci report --diff workflowA.yml:workflowB.yml  # structural diff two workflows
aeroci report --changelog                    # git history of workflow changes
```

---

## Feature 31 — JUnit XML Report (`aeroci-report.xml`)

Generates standard JUnit XML test reports compatible with Jenkins, GitLab CI, GitHub Actions test reporting, and test visualization dashboards.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="AeroCI" time="3.412" tests="4" failures="0">
  <testsuite name="CI Workflow" time="3.412" tests="4" failures="0">
    <testcase name="Checkout Code" classname="build-and-test" time="0.001"/>
    ...
  </testsuite>
</testsuites>
```

---

## Feature 32 — Markdown Summary (`aeroci-summary.md`)

Produces GitHub Job Summary-compatible Markdown reports featuring status emojis, step timing breakdowns, and failure details.

---

## Feature 33 — JSON Run Report (`aeroci-run.json`)

Exports complete execution metadata, step exit codes, timings, and environmental context as a structured JSON artifact.

---

## Feature 34 — GitHub Annotations Emitter

Outputs standard GitHub Actions workflow commands (`::error` / `::warning`) to stdout so IDEs and GitHub PR annotation viewers highlight failing lines directly.

```
::error file=.github/workflows/main.yml,title=Step Failed — Run Tests::Job "build" step "Run Tests" failed with exit code 1
```

---

## Feature 35 — Exit Code Tracker

Captures precise exit codes for every step command to accurately track failure points across multi-step jobs.

---

## Feature 36 — Failed Step Reproducer

When a step fails, AeroCI automatically outputs exact copy-paste shell commands to reproduce the failure locally with identical environment variables:

```bash
🔁 Failed Step Reproducers:
  # build-and-test > "Run Tests"
  $ CI=true GITHUB_ACTIONS=true bash -c 'npm test'
```

---

## Feature 37 — Workflow Diff Reporter

Performs structural comparison between two workflow YAML files:
- Added/removed jobs
- Added/removed steps
- Trigger (`on:`) changes

```bash
aeroci report --diff .github/workflows/ci.yml .github/workflows/ci-v2.yml
```

---

## Feature 38 — Changelog Generator

Extracts Git commit history for workflow files under `.github/workflows/` to generate a changelog of pipeline modifications over time.

```bash
aeroci report --changelog
```

---

## Feature 39 — Step Coverage Reporter

Calculates the percentage of total defined workflow steps actually executed during the run:

```
📈 Step Execution Coverage
  • Steps Executed : 4/4
  • Coverage       : 100%
  • Progress       : ████████████████████ 100%
```

---

## Feature 40 — HTML Report Generator (`aeroci-report.html`)

Generates a standalone, beautifully styled HTML dashboard containing execution metrics, status cards, and interactive step result tables.
