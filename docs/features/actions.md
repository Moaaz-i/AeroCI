# Action Simulator Library

> Features 41–50

AeroCI includes built-in realistic local simulations for popular GitHub Actions, enabling accurate pipeline execution without relying on external network services.

---

## Feature 41 — `actions/cache` Simulator

Simulates key-based local caching using `.aeroci-artifacts/action-cache/`:
- Exact key matching & `restore-keys` prefix matching
- Local cache hit/miss simulation
- Automatic cache persistence after job completion

---

## Feature 42 — `actions/setup-python`

Detects local Python installations (`python3` / `python`), matches requested version constraints, and configures environment variables.

---

## Feature 43 — `actions/setup-java`

Detects local Java installations (`java -version`), verifies Java version & distribution specs, and exports JDK environment variables.

---

## Feature 44 — `actions/setup-go`

Detects local Go installations (`go version`) and verifies requested version compatibility.

---

## Feature 45 — `actions/github-script`

Executes inline JavaScript code provided in `with.script` within a sandboxed V8 context with mocked `github` and `core` octokit objects.

```yaml
- uses: actions/github-script@v7
  with:
    script: |
      core.info('Executing inline script');
      core.setOutput('status', 'success');
```

---

## Feature 46 — `docker/build-push-action`

Validates Docker installation, verifies Dockerfile path existence, prints build metadata, and simulates image tag building without forcing remote registry pushes.

---

## Feature 47 — `actions/create-release`

Simulates release creation step, validating release tags, names, and body text, and outputting simulated release URLs.

---

## Feature 48 — `peaceiris/actions-gh-pages`

Simulates GitHub Pages deployment: validates source directory file contents, checks output branch configuration, and verifies custom domain CNAME settings.

---

## Feature 49 — `aws-actions/configure-aws-credentials`

Audits AWS environment credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) or OIDC `role-to-assume` parameters to ensure deployment readiness.

---

## Feature 50 — Action Marketplace Version Checker

Available via `aeroci versions`: checks action references across workflows against a maintained index of the latest stable action versions, flagging outdated actions and providing upgrade recommendations.

```bash
aeroci versions
```
