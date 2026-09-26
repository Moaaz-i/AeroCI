# Action support

`uses:` steps are either **really executed**, or **reported as `not
simulated`**. There is no third option, and nothing that did not run is ever
reported as a success.

```bash
aeroci versions            # every action, how it is pinned, and whether it is simulated
```

---

## How a `uses:` step is resolved

| Form | What happens |
|------|--------------|
| `./path/to/action` (local) | Read from disk. A `composite` action runs its inline steps for real; a `node` action runs its `main` if the bundle is present. |
| A known action with a simulator | See the tables below. |
| A known action with no local implementation | `not simulated`, with the reason. |
| A `node` action with no bundle on disk | **Fails**, with a message saying the bundle is missing. This is deliberate: running nothing and reporting success is the one outcome a CI tool must not produce. |
| A `docker` action | `not simulated` — AeroCI does not pretend to have a container runtime. |
| An unrecognised `using:` | Fails as an unsupported runtime. |

---

## Really executed

These do the thing, locally.

| Action | What actually happens |
|--------|----------------------|
| **`actions/checkout`** | Your project is already in the sandbox (it was copied there), so this reports that and sets the outputs. `ref:`, `repository:`, `path:`, `clean:`, `set-safe-directory` and `fetch-depth: 0` are honoured. `sparse-checkout`, `submodules`, `lfs` and a non-default `ref` needing history are reported as not simulated. |
| **`actions/github-script`** | Your JavaScript really is evaluated, with a working `@actions/core` shim: `setOutput`, `setFailed`, `setSecret`, `addMask`, `addPath`, `exportVariable`, `getInput`, `getState`/`saveState`, `notice`/`warning`/`error`/`info`/`debug`, `summary`, `startGroup`/`endGroup`. Outputs and masks land where a real run puts them. |
| **`actions/cache`** | A real cache on disk, in the run's own cache directory. Exact `key` match, then `restore-keys` prefix match, then a miss. Saves on post-job when the primary key was not already hit. The size shown is the real size on disk. |
| **`actions/upload-artifact`** | Really archives the files. A later `download-artifact` with a matching name really gets them back. |
| **`actions/setup-node`** | Detects your local `node` (`--version`) and checks it against the requested range. **Your** Node is used, not a downloaded one — installing a toolchain is not a local simulation of one. |
| **`actions/setup-python`** | Detects `python3`/`python`, checks the requested version, reports the resolved path. |
| **`actions/setup-go`** | Detects `go version` and checks the requested version. |
| **`actions/setup-java`** | Detects `java -version`, checks the requested version and distribution. |
| **`actions/setup-dotnet`** | Detects `dotnet --version` and checks the requested version. |
| **`actions/setup-ruby`** | Detects `ruby --version` and checks the requested version. |
| **Composite actions** | Their inline `run:` steps really execute, in order, with full expression and `secrets` resolution. A failure aborts the rest, as on a runner. |

A version constraint that your local tool does not satisfy is a **failure**,
not a warning — it is the same failure the runner would give.

---

## Reported as `not simulated`

These cannot be reproduced locally, and AeroCI says so rather than inventing a
result.

| Action | Why |
|--------|-----|
| `actions/deploy-pages` | A deployment is a network call to GitHub. |
| `actions/create-release` | Would create a real release. The tag, name and body are validated and reported. |
| `peaceiris/actions-gh-pages` | Would push to a branch. |
| `docker/build-push-action` | The Dockerfile and context are found and checked; the build is not run, and `push` is never attempted. |
| `docker/login-action` | A registry login is a network call and a credential write. |
| `github/codeql-action` | There is no database and no runner image. |
| `aws-actions/configure-aws-credentials` | The environment is validated — and **fails** if the credentials the step needs are absent, which is what the runner would do — but no role is assumed. |
| `actions/download-artifact` without `with.name` | Would download every artifact of the run, including across jobs. |
| `actions/upload-pages-artifact` | Archiving is real; the Pages-specific naming is not something AeroCI can claim to do. |
| `jobs.<id>.uses` (reusable workflow) | A real runner delegates to a separate run. |
| Anything unrecognised | Reported as `not simulated`, never as passed. |

---

## `aeroci versions`

Shows how every action reference in the project is pinned, and whether it is
simulated.

```bash
aeroci versions
aeroci versions --check-remote    # ask the GitHub API for the latest release
```

Pinning is classified, because the distinction is the point:

| Classification | Meaning |
|----------------|---------|
| **SHA** | `@e5c0a1b…` — immutable. This is the only fully safe form. |
| **short SHA** | `@e5c0a1b` — not immutable; a short prefix is not a unique identifier. |
| **tag** | `@v4` — a movable name that a maintainer can repoint. |
| **branch** | `@main` — moves continuously, and the content is not reviewable. |
| **local** | `./path` — code in your repository, not a dependency. |
| **container** | `docker://…` — a mutable image reference. |

`--check-remote` is off by default and needs the network. It looks up six at a
time, so a project with a dozen actions costs two round trips rather than
twelve, and the result is compared against what you pinned.

---

## Adding a simulator

A new one is a method on `ActionSimulators` plus a line in `MATCHERS` in
`src/core/action-simulators.js`.

Two rules the existing code follows, and the reason they are there:

1. **A simulator that cannot do the thing returns `notSimulated: true`.** The
   engine marks the step honestly on that flag alone.
2. **It never returns `success: true` for work it did not do.** A green step
   means a green step.

Prefer detecting a local tool and *checking* it over pretending to install it.
That is why `setup-node` uses your Node and tells you the version: it is the
only claim that can be true on your machine.
