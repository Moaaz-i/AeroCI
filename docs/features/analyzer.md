# Workflow analyzer

```bash
aeroci analyze                          # every workflow in the project
aeroci analyze .github/workflows/ci.yml # one file
aeroci analyze --json                   # machine-readable
aeroci analyze --strict                 # exit non-zero on real defects
aeroci check --analyze                  # as part of the pre-flight check
```

It reads the YAML and reports what it finds. It never runs anything, so every
finding is about the file, not about your machine.

---

## What it checks

### Dead steps

A step that can never influence the result. The trigger is a step that
*always* exits non-zero — not one that might:

```yaml
- name: Check
  run: exit 1                  # ← always fails

- name: Notify
  run: ./notify.sh             # ← unreachable: the step above always fails
```

Two findings come back, and they are two different problems:

| Kind | What it is | Why it matters |
|------|------------|----------------|
| `always-fails` | the step that always exits non-zero | the cause — it ends the job on every run |
| `unreachable` | every step behind it with no `if:` | the consequence — it has never run |

They are counted and printed separately, because "can never affect the result"
is true of the second and exactly backwards for the first: failing the job is
precisely how that step affects the result.

Two things make the later steps live again, and the analyzer honours both:
`continue-on-error: true` on the failing step, and an `if:` on the later step.
An explicit `continue-on-error: false` is a failure, not a tolerance.

The point is not style. A step that cannot run is a step you are maintaining
that has never worked.

### Duplicate steps

The same `run:` body in **more than one job** — the shape that usually wants to
be a composite action under `.github/actions/`.

Two limits keep the noise down, and both are deliberate:

- The body has to be at least 15 characters. `echo ok` in five jobs is a
  coincidence, not a shared action.
- It has to be in two *different* jobs. The same script twice in one job is a
  different problem, and the advice — extract it to a composite action — would
  be wrong there.

A repeated `uses:` action is not a duplicate. `actions/checkout@v4` in every
job is what you are supposed to write.

### Unused outputs

A job declares `outputs:` and nothing reads it through
`needs.<job>.outputs.<name>`. Reported with the job and the output name, so
you can delete the declaration.

This is about the **job-level** `outputs:` block, not about a step's `id:`. A
step output that nothing reads is not reported: it may be consumed by a later
step through `$GITHUB_OUTPUT`, by a composite action, or by nothing at all,
and the file alone cannot tell you which — so a warning there would be a guess
about your workflow rather than a fact about it.

### Redundant jobs

Two jobs with the same `needs:`, the same matrix, and the same steps. A job
that is a *subset* of another is not reported, and neither is one that differs
only in `needs:` — the ordering is often the entire point of having two jobs.

### Shells

Two checks, both about the shell your workflow *asks for*:

- **A Windows-only shell in a job that does not run on Windows.** `cmd`,
  `powershell` and `pwsh` in a job whose `runs-on` is not Windows is a finding
  at high severity — the step cannot work. The same shell in a job pinned to
  `windows-latest` is not, because it is the correct shell on that runner. A
  `runs-on` that is an array, a matrix, or an expression is read as written; an
  expression is not assumed to be Windows.
- **A custom shell that is not bash.** `shell: sh -c {0}` is a low-severity
  note, because it is your call and AeroCI runs it as written. `shell: bash -eo
  pipefail {0}` is *not* reported — that is the customisation GitHub's own
  documentation recommends.

AeroCI invokes each shell the way a runner does — `bash --noprofile --norc -eo
pipefail {0}`, `sh -e {0}`, `pwsh -command ". '{0}'"`, `cmd /D /E:ON /V:OFF /S /C
CALL "{0}"` — so the argument vector is not the thing that differs from CI.

**What this does not check:** bash-only syntax inside a `shell: sh` step —
arrays, `[[ ]]`, process substitution, here-strings. It is a real class of bug
and AeroCI does not flag it statically, because deciding it needs a parser and a
heuristic that would produce false positives on working workflows. Running the
step does not reliably catch it either, and it is worth knowing why: on macOS
`/bin/sh` is bash in POSIX mode, so a bash array under `shell: sh` passes
locally and fails on a Linux runner, where `/bin/sh` is dash. If your workflow
targets Linux, the way to check this is to run it under a real `sh` or in a
container.

### Cycles

`needs:` that forms a loop. GitHub rejects this at queue time, after you have
pushed. The analyzer reports it with the cycle spelled out:

```
Circular needs: a → b → a
```

### Concurrency conflicts

Jobs sharing a `concurrency.group` run one at a time. What `cancel-in-progress`
does depends on where it is set, so each case is described on its own terms
rather than lumped together:

| Setting | What actually happens |
|---------|-----------------------|
| `cancel-in-progress: true` | the newly queued job **cancels the one already running**, so an earlier run can be killed mid-step |
| unset (the default) | the running job finishes, but a job still *pending* in the group is dropped so only the newest goes on |
| `cancel-in-progress: false` | as unset — and the serialising is worth a look if those jobs could have overlapped |

A group that matches the workflow-level `concurrency` is reported as serialising
and nothing more, because the workflow already decides the order and the per-job
setting has nothing left to say.

### Matrix sanity

For every `strategy.matrix`: the axes, how many combinations they produce,
whether the count was truncated, `max-parallel`, `fail-fast`, and **axes that
are constant across every combination** — a matrix dimension that varies
nothing, which usually means a copy-paste that nobody noticed.

---

## Complexity score

A 0–100 number where **100 is simple and 0 is very complex** — the opposite
direction from a score you might expect, because a high number is the good
outcome.

| Score | Rating |
|-------|--------|
| 80–100 | simple |
| 60–79 | moderate |
| 40–59 | complex |
| 0–39 | very complex |

Every penalty is a pure function of the structure, and the breakdown is printed
so the number is explainable rather than magic:

| Component | Penalty |
|-----------|---------|
| Jobs | 1.5 per job beyond the second |
| Steps | 1.2 per step beyond the sixth |
| Graph depth | 4 per level beyond the first |
| Coupling | 1.5 per `needs:` reference beyond one per job |
| Expressions | 0.8 per template expression beyond the fifth |
| Custom shells | 2 per step with an explicit `shell:` |
| Matrix jobs | 2 per job with a matrix |
| `continue-on-error` | 1.5 per step that uses it |
| Cycles | 15 per cycle |

The score is a way to compare two versions of a workflow, and a signal that a
file has grown past what one person can hold in their head. It is not a quality
verdict: a linear pipeline with twenty jobs is not better than a four-job graph
with a cycle in it — the cycles cost you 15 points each and they should.

---

## Exit codes

`aeroci analyze` exits `0` normally. With `--strict` it exits `1` when it finds
any of the five actionable defects:

| Finding | Fails `--strict` |
|---------|------------------|
| Dead steps | yes |
| Unused outputs | yes |
| Duplicate steps | yes |
| Redundant jobs | yes |
| Shell issues | yes |
| Matrix expansion, wasted axes, complexity, concurrency groups, cycles | no |

The complexity score never fails the command. It is a number for comparing one
version of a workflow against another, not a verdict, and letting it set an exit
code would mean a workflow that got bigger could not be checked in CI at all.

---

## On step-duration estimates

The analyzer does not estimate how long your steps take, and this is worth
saying plainly: a number here would be invented. It knows a step calls a
package manager; it does not know whether your lockfile is warm, whether the
registry is slow, or whether the cache hit.

For real timings, run the workflow and use `aeroci run --profile` or
`aeroci profile`, which report what was measured on your machine.
