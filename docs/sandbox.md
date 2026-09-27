# Sandbox & Isolation

AeroCI runs your steps inside an isolated copy of your project. Your working
tree is never modified, and a file one job writes is invisible to the next.

---

## How it works

```
your project root
      │
      │  one real copy per job instance
      ▼
$TMPDIR/aeroci-sandbox-XXXXXX/
   ├── src/                    a copy, not a symlink to yours
   ├── package.json
   ├── .github/workflows/
   ├── _temp/  tmp/  bin/      the directories a real runner provides
   ├── externals/  work/
   │
   │  every step executes here
   ▼
removed when the job finishes (unless you ask to keep it)
```

The file-command channels live in a separate per-run directory, not in the
sandbox:

```
$TMPDIR/aeroci-run-XXXXXX/
   ├── event.json              the simulated event payload
   ├── artifacts/              what upload-artifact wrote
   ├── cache/                  what actions/cache reads and writes
   └── .aeroci/
       ├── env  output  state  path  summary
       └── event.json          $GITHUB_ENV, $GITHUB_OUTPUT, $GITHUB_STATE,
                               $GITHUB_PATH, $GITHUB_STEP_SUMMARY
```

`GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH` and `GITHUB_STATE` are reset
between jobs and shared between the steps of one job — exactly as on a runner.
`GITHUB_STEP_SUMMARY` accumulates for the whole run.

---

## One sandbox per job instance

A sandbox is created for **each job**, and for **each matrix combination** of
that job. A three-way matrix builds three copies, so two combinations cannot
see each other's files even when they run one after another.

This is the behaviour that makes a local result trustworthy. A single shared
directory would let job order decide whether a workflow passes.

The run prints the total:

```
2 isolated workspace(s) created (3ms each) and removed — a file one job writes
is invisible to the next, as on a real runner.
```

---

## Copy strategy

Every file is a real, independent copy. Files are copied with
`COPYFILE_FICLONE`, which is copy-on-write on APFS and falls back to a byte
copy on other filesystems.

What is preserved, and why it matters:

| Behaviour | Reason |
|-----------|--------|
| Real copies, never symlinks to your project | A workflow can never write through the sandbox into your files. |
| The executable bit is preserved | `./script.sh` behaves the same locally and on a runner. |
| Symlinks in your project are recreated as symlinks, never followed | Following one would duplicate its target, and a link pointing at a parent would recurse. There is no option to change this: a link out of the project would hand a step a way to edit the real filesystem. |
| Sockets, FIFOs and devices are skipped | They would block the copy and mean nothing to a build. |

### What it costs

Measured on this machine (macOS, APFS) over a 68-file, 276 KB project that
contains a `node_modules`, so `link` had a real path to link. Nine runs each,
whole create-and-remove cycle:

| Mode | linked paths | min | median | max |
|------|--------------|-----|--------|-----|
| `copy` | 0 | 19.1 ms | 20.5 ms | 23.1 ms |
| `link` | 1 | 18.5 ms | 19.1 ms | 22.2 ms |

`link` comes out about 1.4 ms ahead, which is inside the spread of either mode —
the ranges overlap on both ends. Treat it as *no difference*, and treat any
"fast path" claim for `link` as unsupported.

Setup cost scales with the number of files that are **not** excluded. Your
`node_modules` is excluded by default, so it costs nothing to skip — which is
the other half of why `link` cannot be faster than `copy` here. Make the
project mostly excluded files and both modes get cheap together.

Reproduce it:

```js
const { Sandbox } = require('./src/core/sandbox');
const { DEFAULTS } = require('./src/core/config');
for (const mode of ['copy', 'link']) {
    const t = process.hrtime.bigint();
    Sandbox.create(projectRoot, { exclude: DEFAULTS.sandbox.exclude, mode }).dispose({ quiet: true });
    console.log(mode, Number(process.hrtime.bigint() - t) / 1e6);
}
```

The copy is synchronous, not a parallel async walk. On a project with many
small files it is the slowest part of a run, and it is reported rather than
hidden.

---

## The exclude list

These are left out of the sandbox by default:

```
.git  node_modules  .aeroci-artifacts  .next  dist  build
target  vendor  .venv  __pycache__  coverage  .env
```

`node_modules` is excluded because a fresh runner has none until a step
installs one. Shipping your local copy would make a missing install step look
fine. The same is true of `dist` and `build`: a stale local build would hide a
broken build step.

**`.env` is excluded, and this one matters.** A runner has no `.env` file:
your secrets reach a step through the `secrets` context, not as a file sitting
in the working tree. Copying yours in put every secret the project owns —
including the ones this workflow never references — one `cat .env` away from
any step, and one `upload-artifact` away from a report you were about to share.
The values are still available through the `secrets` context, and they are still
masked in the log.

A name matches at any depth, so `dist` excludes `packages/x/dist` too. Adding
to the list adds to the defaults rather than replacing them, so naming one
extra path cannot quietly un-exclude `node_modules`.

---

## `mode: "link"`

```json
{ "sandbox": { "mode": "link" } }
```

An entry the exclude list would have dropped is symlinked to the real one
instead. That is the whole of it: a step can use your installed
`node_modules` without an install step.

It is **not** a speed option — both modes skip those paths, so they cost the
same. It trades isolation for convenience, and the run says so before
anything executes:

```
⚠ Sandbox mode "link" — 12 excluded path(s) point at your real project:
    .git, node_modules, .aeroci-artifacts, .next, dist, build, target, vendor, .venv, __pycache__, coverage, .env
    A step that writes into them edits the real files. Everything else is still a private copy.
```

Only the excluded paths are linked. Everything the workflow *edits* is still
a private copy — the test suite asserts that the only symlink in the sandbox
is the excluded entry, so the hole cannot widen by accident.

---

## Keeping a sandbox

```bash
aeroci run --keep      # or "sandbox": { "keep": true } in .aeroci.json
aeroci debug --keep
```

A kept sandbox is left in `$TMPDIR` and its location is printed. Without the
flag it is removed when the job finishes, including when the job fails.

---

## The environment a step sees

Measured from a real run (`env | grep -E '^GITHUB_|^RUNNER_|^CI='`):

```
CI=true
GITHUB_ACTION=
GITHUB_ACTIONS=true
GITHUB_ACTION_PATH=
GITHUB_ACTOR=local
GITHUB_API_URL=https://api.github.com
GITHUB_ENV=…/aeroci-sandbox-XXXXXX/.aeroci/env
GITHUB_EVENT_NAME=push
GITHUB_EVENT_PATH=…/aeroci-sandbox-XXXXXX/.aeroci/event.json
GITHUB_GRAPHQL_URL=https://api.github.com/graphql
GITHUB_JOB=<job id>
GITHUB_OUTPUT=…/aeroci-sandbox-XXXXXX/.aeroci/output
GITHUB_PATH=…/aeroci-sandbox-XXXXXX/.aeroci/path
GITHUB_REF=refs/heads/main
GITHUB_REF_NAME=main
GITHUB_REF_PROTECTED=true
GITHUB_REF_TYPE=branch
GITHUB_REPOSITORY=local/aeroci-simulation
GITHUB_REPOSITORY_OWNER=local
GITHUB_RUN_ATTEMPT=1
GITHUB_RUN_ID=10040
GITHUB_RUN_NUMBER=1
GITHUB_SERVER_URL=https://github.com
GITHUB_SHA=<40-char sha from your local git state>
GITHUB_STATE=…/.aeroci/state
GITHUB_STEP_SUMMARY=…/.aeroci/summary
GITHUB_TRIGGERING_ACTOR=local
GITHUB_WORKFLOW=<the workflow's name:>
GITHUB_WORKSPACE=…/aeroci-sandbox-XXXXXX
RUNNER_ARCH=ARM64
RUNNER_DEBUG=
RUNNER_ENVIRONMENT=aeroci
RUNNER_NAME=AeroCI Local Runner
RUNNER_OS=macOS
RUNNER_TEMP=…/aeroci-sandbox-XXXXXX/_temp
RUNNER_TOOL_CACHE=~/.aeroci/toolcache
```

`RUNNER_OS` and `RUNNER_ARCH` report your machine, not `Linux`/`X64`. That is
deliberate: a step that branches on them is asking what it is running on, and
answering anything else would be a lie. It also means a workflow that assumes
Linux will fail locally rather than pass by accident.

`GITHUB_WORKFLOW` and `github.workflow` are the workflow's `name:`, falling
back to the file name when it has none — the same as GitHub.

`RUNNER_TOOL_CACHE` is a real directory outside the sandbox, and it holds
something. This used to be a path that had never been created: the tool cache
lived inside the sandbox copy, which is deleted at the end of every run, so
anything put there was gone before the next one. `actions/setup-node` now
installs into it for real — see
[Toolchains](./features/actions.md#toolchains). Because it is outside the
sandbox, the sandbox copy never includes it.

### When there is no git repository

Outside a repository there is no commit, so `GITHUB_SHA` is 40 zeros and
`GITHUB_REPOSITORY` is `local/aeroci-simulation`. `aeroci debug` says so
explicitly rather than printing a SHA that looks real:

```
Commit    not a git repository — GITHUB_SHA is the all-zero placeholder
```

---

## Secrets

Values from `.env` are loaded through the same parser the engine uses and are
registered as log masks, so a value a step echoes is replaced with `***` in
the log. The real runner masks a secret when it is first seen; AeroCI masks
from the start, which is stricter.

A `.env` value is **not** placed in a step's environment. A runner does not do
that either — a secret is reachable through `secrets.NAME` or an `env:` block
that names one, and nowhere else. Injecting it would let a workflow pass
locally for a reason that does not exist on a runner:

```yaml
- name: Wrong locally, right on a runner
  run: echo "${#TOKEN}"      # 0 in both — this is faithful
- name: The way a runner does it
  env:
    T: ${{ secrets.TOKEN }}
  run: echo "$T"              # the value, masked in the log
```

`AERO_UNMASK_SECRETS=1` turns masking off. It exists for debugging a value
and is **not** a faithful simulation of anything — the runner has no such
switch, and nothing you run under it is safe to paste into an issue.

---

## `aeroci debug` uses the same sandbox

`aeroci debug` reads the same exclusion list from the same config, so the shell
it opens is the environment the failing step actually had. This is the whole
point of the command, and it is easy to get wrong: a debug shell with your
`node_modules` and your `.env` in it is a *different* environment, so a
command that worked there and failed in the run sends you looking for the wrong
reason.

It also does not register log masks, so treat anything you `cat` in that shell
as if it had been printed in a report.

```bash
aeroci debug                  # the run's conditions, in a copy of your project
aeroci debug --keep           # leave that copy behind to poke at
aeroci debug --expose-env     # also export your .env as plain variables
```

`--expose-env` is a deliberate departure, and the session says so when it is
on: it exports the values a runner would not expose, so a command can be
tried against them. It is a convenience for one specific debugging need, not a
more faithful simulation.
