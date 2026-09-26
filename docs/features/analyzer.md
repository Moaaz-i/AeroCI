# Workflow analyzer

```bash
aeroci analyze                          # every workflow in the project
aeroci analyze .github/workflows/ci.yml # one file
aeroci analyze --json                   # machine-readable
aeroci analyze --strict                 # exit non-zero on dead steps / unused outputs
aeroci check --analyze                  # as part of the pre-flight check
```

It reads the YAML and reports what it finds. It never runs anything, so every
finding is about the file, not about your machine.

---

## What it checks

### Dead steps

A step that can never influence the result:

```yaml
- name: Deploy
  run: ./deploy.sh
  continue-on-error: false    # ← if this fails, everything below is dead code

- name: Notify
  run: ./notify.sh            # ← flagged: unreachable once the step above fails
```

`continue-on-error: true` on the failing step makes the later steps live again,
and the analyzer knows that. So does an `if: always()` or `if: failure()` on
the later step.

The point is not style. A step that cannot run is a step you are maintaining
that has never worked.

### Duplicate steps

The same `run:` script appearing in more than one job, or twice in one job —
usually a job that should be a composite action, or a matrix that should have
been a matrix.

### Unused outputs

A step declares `id:` and writes to `$GITHUB_OUTPUT`, and nothing ever reads
`steps.<id>.outputs.*`. Reported with the job it is in, so you can delete it.

### Redundant jobs

A job whose steps are a subset of another job's, or a job that does nothing a
dependency already did.

### Shell compatibility

A step that declares `shell: sh` (or the default on a non-bash runner) but
writes bash: arrays, `[[ ]]`, process substitution `<(…)`, here-strings
`<<<`.

AeroCI runs steps the way a runner does — `bash --noprofile --norc -eo pipefail`
— so this is about the shell your workflow *asks for*, not the one it gets.

### Cycles

`needs:` that forms a loop. GitHub rejects this at queue time, after you have
pushed. The analyzer reports it with the cycle spelled out:

```
Circular "needs" dependency: a → b → a
```

### Concurrency conflicts

Jobs sharing a `concurrency.group`. Two jobs in the same group can cancel each
other, which is occasionally the intent and usually a surprise.

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

`aeroci analyze` exits `0` normally. With `--strict` it exits non-zero when
there are dead steps or unused outputs — the two findings that are almost
always real problems. The rest are advisory.

---

## On step-duration estimates

The analyzer does not estimate how long your steps take, and this is worth
saying plainly: a number here would be invented. It knows a step calls a
package manager; it does not know whether your lockfile is warm, whether the
registry is slow, or whether the cache hit.

For real timings, run the workflow and use `aeroci run --profile` or
`aeroci profile`, which report what was measured on your machine.
