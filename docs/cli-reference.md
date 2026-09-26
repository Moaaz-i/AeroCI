# CLI Reference

Every flag below is copied from the tool's own `--help`. If a flag is not
listed here, it does not exist.

```
aeroci [command] [options]

  -V, --version   output the version number
  -h, --help      display help for command
```

`target` means a workflow file, a directory of them, a glob, or a project root
whose `.github/workflows/` should be scanned. It defaults to
`.github/workflows`.

---

## `aeroci init`

Create `.aeroci.json`, a sample workflow, `.env.example`, and a `.gitignore`
entry.

| Flag | Effect |
|------|--------|
| `-f, --force` | overwrite files that already exist |
| `--no-sample` | do not write a sample workflow |
| `--no-env` | do not write `.env.example` |

Without `--force` an existing file is left alone and the run says so. You do
not need this file: `aeroci run` works without it, on defaults.

---

## `aeroci check [target]`

Validate workflows against what a runner actually requires.

| Flag | Effect |
|------|--------|
| `--security` | also run the security audit |
| `--analyze` | also run the workflow analyzer |
| `--network` | also ask the npm registry whether each installed package exists |

**What it checks:** YAML syntax and required fields (`name`, `on`, `jobs`);
action references and how they are pinned; `secrets.*` against your `.env`;
the job graph (unresolvable `needs`, cycles); matrix definitions; and the
shell your `run:` steps ask for.

`--network` is off by default. It shells out to `npm view` once per package,
which is a request per package to a registry you did not ask about. Turn it on
when you want the typo guard:

```
error  job "install" step 1: package "exprees" does not exist on the npm registry
```

**Exit code:** `1` if there are errors. Warnings are advisory and exit `0`.

---

## `aeroci run [target]`

Execute workflows in an isolated sandbox — one per job and per matrix
combination. See [sandbox.md](./sandbox.md).

| Flag | Effect |
|------|--------|
| `-d, --debug` | drop into a matching shell if a step fails |
| `--only-job <id>` | run only this job id |
| `--event <name>` | event to simulate (default `push`) |
| `--timeout <minutes>` | per-step timeout; `timeout-minutes:` in the workflow wins |
| `--env <KEY=VALUE>` | set an environment variable (repeatable) |
| `--var <KEY=VALUE>` | set a repository variable for `vars.NAME` (repeatable) |
| `--keep` | keep the sandbox on disk after the run |
| `--dry-run` | resolve and print what would run, without running it |
| `--report` | write reports under `.aeroci-artifacts/report/` |
| `--report-dir <dir>` | where those reports go |
| `--format <list>` | `json,markdown,html,junit` (default: all four) |
| `--json [path]` | write the run summary as JSON |
| `--no-annotations` | do not emit `::error` / `::warning` workflow commands |
| `--profile` | show the timing table and the cost projection |

**Exit code:** `0` when every job succeeded, `1` when any step failed, and `7`
when a step timed out.

```bash
aeroci run                                  # everything in .github/workflows/
aeroci run ci.yml                           # one file
aeroci run 'release-*.yml'                  # a glob
aeroci run --only-job build --event pull_request
aeroci run --report --format json,html
aeroci run --dry-run                        # what would run, and why
```

`--dry-run` resolves expressions, the job graph and matrix expansion, then
stops. It is the fast way to see what a workflow *would* do — including which
steps a failing dependency would skip — without spending the time.

---

## `aeroci debug`

Open a shell with the same CI environment, in the same kind of isolated copy,
so a failing command can be re-run by hand.

| Flag | Effect |
|------|--------|
| `--event <name>` | event to simulate (default `push`) |
| `--keep` | keep the sandbox on disk afterwards |
| `--expose-env` | also export your `.env` values as plain variables |

`--expose-env` is a deliberate departure from a runner, which exposes a secret
only through the `secrets` context. The session says so when it is on.

Log masking is not active in this shell — treat anything you `cat` as if it had
been printed in a report.

---

## `aeroci analyze [target]`

Structural intelligence: the job graph in dependency order, dead steps,
duplicate steps, outputs nothing reads, redundant jobs, matrix expansion, the
longest chain, and a complexity score with the penalties that produced it.

| Flag | Effect |
|------|--------|
| `--json` | print the analysis as JSON |
| `--strict` | exit non-zero when dead steps or unused outputs are found |

---

## `aeroci security [target]`

Audit for template injection through untrusted context, script injection into
the shell, over-broad or missing `permissions:`, actions pinned to a mutable
tag, `pull_request_target` combined with a checkout, and hardcoded credential
patterns.

| Flag | Effect |
|------|--------|
| `--report [path]` | write a markdown report (default `security-report.md`) |
| `--json` | print findings as JSON instead of text |

---

## `aeroci profile [target]`

Your own run history, and a trend against it.

| Flag | Effect |
|------|--------|
| `--limit <n>` | how many runs to show (default 20) |

History is read from `.aeroci-artifacts/history.jsonl`, appended by
`aeroci run`. It is your machine's record, not an estimate of what GitHub
would have charged — see the note on cost below.

---

## `aeroci report`

Re-render the last run in other formats, diff two workflows, or list the
commits that touched them.

| Flag | Effect |
|------|--------|
| `--format <list>` | `json,markdown,html,junit` (default: all four) |
| `--run <dir>` | the report directory to read from (default `.aeroci-artifacts/report`) |
| `--out <dir>` | where to write the re-rendered reports |
| `--diff <a:b>` | structural diff between two workflow files |
| `--history [dir]` | commits that touched the workflow directory |

```bash
aeroci report --format markdown             # re-render from the stored JSON
aeroci report --diff ci.yml:release.yml     # what changed between two files
aeroci report --history                     # from git log
```

The JSON is the source of truth. Every other format is a re-render of it, so
switching formats cannot change what the run actually did.

---

## `aeroci versions [target]`

How every action is pinned — SHA, short SHA, tag, moving branch, local action
or container image — and whether AeroCI simulates it.

| Flag | Effect |
|------|--------|
| `--check-remote` | also ask the GitHub API for the latest release |

`--check-remote` needs the network and is off by default. Lookups run six at a
time, so ten actions cost two round trips rather than ten.

---

## `aeroci ui`

Serve a read-only dashboard of the workflows in this project.

| Flag | Effect |
|------|--------|
| `-p, --port <number>` | port to listen on (default 3500) |
| `--host <address>` | address to bind to (default `127.0.0.1`, or `$AEROCI_HOST`) |

Read-only, and bound to localhost by default. Binding it to `0.0.0.0` puts
your workflow source on the network — `--host 0.0.0.0` is a deliberate act.

---

## Environment variables

| Variable | Effect |
|----------|--------|
| `AERO_UNMASK_SECRETS=1` | turn log masking off. **Not** a faithful simulation — nothing you run under it is safe to share. |
| `AEROCI_HOST` | default bind address for `aeroci ui` |
| `AEROCI_DEBUG` | print stack traces on failure |
| `NO_COLOR` | disable colour |

---

## On the cost projection

`aeroci run --profile` prints a table of step time and a dollar figure derived
from GitHub's published per-minute prices for the runner labels it recognises.

That figure is a **projection from your local timings**, not a measurement of
anything GitHub billed. It is useful for comparing one version of a workflow
against another. It is not a quote, and it does not include the minutes a job
spent waiting in a queue.
