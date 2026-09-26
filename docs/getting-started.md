# Getting Started

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18.0.0 |
| bash | any POSIX shell; `pwsh` for `shell: pwsh` steps |
| Docker | not needed — container actions are reported as `not simulated` |

macOS, Linux and Windows all work. On macOS's APFS the sandbox copy is
copy-on-write, so it is nearly free in disk space; elsewhere it is a real byte
copy, which costs more on a large project. See [sandbox.md](./sandbox.md).

---

## Install

```bash
npm install -g aeroci
```

Or from source:

```bash
git clone https://github.com/Moaaz-i/AeroCI.git
cd AeroCI
npm install
npm link
aeroci --version
```

---

## First run

You do not need to configure anything. Point it at a project with workflows in
`.github/workflows/` and run them:

```bash
cd your-project
aeroci run
```

A real run, copied as printed (the sandbox path is shortened):

```
 aeroci v2.1.0
  Workflow                  : CI
  Event                     : push
  Repository                : acme/widgets @ ae063dc9143a
  Ref                       : refs/heads/main

▸ [build] · ubuntu-latest · 3 step(s)
ℹ [AeroCI] Sandbox /tmp/aeroci-sandbox-i5QXeT · 8 file(s) · 2.0 KB · 2ms
  ↳ Step 1/3: actions/checkout@v4
     actions/checkout@v4
     repository content is already present in the sandbox (copy-on-write clone)
     ✔ outputs ref-name=main
  ↳ Step 2/3: Build · id build
     $ echo "sha=abc123" >> "$GITHUB_OUTPUT"  (1 lines, bash)
       │ GITHUB_OUTPUT sha=abc123
     ✔ outputs sha=abc123
  ↳ Step 3/3: Report
     $ echo "done"
       │ done
     ✔ done in 15ms

  Result                    : success
  Jobs                      : 2 total · 0 failed · 0 skipped
  Steps                     : 4/4 executed
  Duration                  : 0.06s
  Step coverage             : 4/4 executed (100%)
✔ [AeroCI] All 1 workflow(s) passed.
```

Read that bottom-up: **4 of 4 steps executed**, in a sandbox that is now gone.
The repository, ref and commit come from your local git state; outside a
repository the commit is the all-zero placeholder and the run says so rather
than printing a sha you might try to look up.

If a step could not be simulated, the coverage line would say so and the run
would name it — see [Reading a result honestly](#reading-a-result-honestly)
below.

---

## What to do next

### Catch problems before you run them

```bash
aeroci check
```

Validates the workflow against what a runner requires: the schema, the job
graph, matrix definitions, `secrets.*` against your `.env`, and the shell each
`run:` step asks for.

Add `--security` for the security audit, or `--network` to have the npm
registry confirm that every package you install actually exists.

### See what a change did

```bash
aeroci report --diff ci.yml:release.yml
aeroci analyze
```

`--diff` shows the structural difference between two workflow files. `analyze`
finds the things that are not errors but cost you time: steps no dependency
can reach, outputs nothing reads, steps duplicated across jobs, and the longest
chain through the graph.

### Keep the reports

```bash
aeroci run --report
```

Writes `.aeroci-artifacts/report/` in four formats — JSON, Markdown, HTML and
JUnit XML. The JSON is the source of truth; the rest are re-renders of it, so
`aeroci report --format html` regenerates the HTML from a run you did days ago.

### Debug a failure

```bash
aeroci run -d
```

When a step fails, you are dropped into a shell with that step's environment
and a copy of your project, with the failing command printed for you to re-run.
`aeroci debug` on its own opens the same shell without a run.

---

## Optional configuration

`aeroci init` writes a `.aeroci.json`, a sample workflow, `.env.example` and a
`.gitignore` entry. You do not need any of it — every field has a default. See
[configuration.md](./configuration.md) for the schema.

Two settings are worth knowing about:

- **`sandbox.mode: "link"`** puts your real `node_modules` into the sandbox, so
  a step can use it without an install step. It is not faster; it trades
  isolation for convenience and says so at the start of the run.
- **`runner.timeoutMinutes`** caps a step at 10 minutes by default rather than
  GitHub's 6-hour platform limit, so a hung command fails while you are still
  watching.

---

## Reading a result honestly

The distinction AeroCI is careful about:

- **`success`** — the step really ran and really exited 0.
- **`not simulated`** — AeroCI cannot reproduce this, and says so instead of
  reporting a success it cannot vouch for. Deploys, container builds, CodeQL,
  AWS role assumption and reusable workflow calls land here.
- **skipped** — a dependency failed, or `--only-job` filtered it out.

A run where steps passed and others were `not simulated` is a partial result.
The summary line tells you which, and `aeroci versions` lists which actions
AeroCI can and cannot run before you discover it.

---

## Next steps

- [CLI Reference](./cli-reference.md) — every command and flag
- [Configuration](./configuration.md) — the `.aeroci.json` schema
- [Sandbox & Isolation](./sandbox.md) — what is copied, what is not, and what it costs
- [Security audit](./features/security.md)
- [Action support](./features/actions.md) — which actions are simulated
