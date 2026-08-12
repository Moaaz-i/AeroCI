<template v-pre>

# Security Hardening Engine

> **`aeroci security`** — Features 21–30

The Security Hardening Engine performs automated security audits on GitHub Actions workflows to detect vulnerabilities, supply chain risks, script injection vectors, and permission misconfigurations.

---

## Usage

```bash
aeroci security                            # audit all workflows
aeroci security .github/workflows/ci.yml  # audit specific workflow
aeroci security --report                   # generate security-report.md
aeroci check --security                    # include in pre-flight check
```

---

## Feature 21 — Supply Chain Attack Detector (`SEC-021`)

Flags actions that are not pinned to a full 40-character commit SHA.

```yaml
# ❌ Risky: Mutable version tags can be overwritten if an action repo is compromised
- uses: third-party/action@v1

# ✅ Secure: Immutable SHA pinning
- uses: third-party/action@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
```

> **Note:** Trusted official GitHub actions (`actions/*`) at version tags are granted low severity.

---

## Feature 22 — GITHUB_TOKEN Permission Auditor (`SEC-022`)

Audits workflow and job-level permissions to prevent overly-broad access tokens.

- **CRITICAL:** `permissions: write-all`
- **MEDIUM:** Unnecessary `write` permissions on sensitive scopes (e.g. `packages: write`, `contents: write`)

```yaml
# ❌ Dangerous
permissions: write-all

# ✅ Principle of least privilege
permissions:
  contents: read
  pull-requests: write
```

---

## Feature 23 — Environment Injection Guard (`SEC-023`)

Scans for `${{ env.VAR }}` expressions interpolated directly inside `run:` shell blocks.

```yaml
# ❌ Vulnerable to shell injection if env comes from untrusted sources
- run: echo "Hello ${{ env.USER_NAME }}"

# ✅ Secure: Pass as process environment variable
- run: echo "Hello $USER_NAME"
  env:
    USER_NAME: ${{ env.USER_NAME }}
```

---

## Feature 24 — Script Injection Scanner (`SEC-024`)

Detects direct interpolation of user-controlled GitHub context values into `run:` scripts.

**Monitored untrusted inputs:**
- `${{ github.event.issue.title }}`
- `${{ github.event.issue.body }}`
- `${{ github.event.pull_request.title }}`
- `${{ github.event.pull_request.body }}`
- `${{ github.event.comment.body }}`
- `${{ github.event.head_commit.message }}`
- `${{ github.actor }}`
- `${{ github.head_ref }}`

```yaml
# ❌ CRITICAL: Shell Injection vulnerability
- run: echo "Title: ${{ github.event.issue.title }}"

# ✅ Secure
- run: echo "Title: $TITLE"
  env:
    TITLE: ${{ github.event.issue.title }}
```

---

## Feature 25 — Secrets in Env Block Checker (`SEC-025`)

Scans `env:` blocks for hardcoded secret patterns (tokens, API keys, private keys) that should be moved to GitHub Secrets.

---

## Feature 26 — pull_request_target Poison Detector (`SEC-026`)

Detects dangerous combinations of `pull_request_target` triggers combined with checking out untrusted PR head code.

```yaml
# ❌ High Risk: Executing untrusted PR code in write-privileged target context
on: pull_request_target
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
```

---

## Feature 27 — Self-Hosted Runner Risk Scorer (`SEC-027`)

Flags sensitive cloud deployments or publish operations executing on persistent `self-hosted` runners, where runner state could be compromised across PR runs.

---

## Feature 28 — OIDC Token Scope Checker (`SEC-028`)

Audits OpenID Connect (OIDC) `id-token: write` scope usage:
- Warns if `id-token: write` is enabled at workflow level without being used.
- Validates job-level scoping of OIDC permissions.

---

## Feature 29 — Dependency Confusion Guard (`SEC-029`)

Scans shell steps for ad-hoc package manager installations of scoped packages without lockfiles or offline flags, which may be susceptible to dependency confusion hijacking.

---

## Feature 30 — Security Report Generator (`SEC-030`)

When run with `--report`, generates a detailed Markdown audit report at `security-report.md` summarizing all findings categorized by severity:
- `CRITICAL`
- `HIGH`
- `MEDIUM`
- `LOW`
- `INFO`

</template>
