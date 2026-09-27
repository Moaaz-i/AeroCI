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
| **`actions/setup-node`** | Really installs the version the workflow asked for. The spec is resolved against [nodejs.org's release index](https://nodejs.org/dist/index.json), so `18` means a concrete build such as 18.20.8; the archive is checked against the `SHASUMS256.txt` published beside it; the `bin` is put on the job's `PATH`, so the rest of the job really runs on it. Cached under `~/.aeroci/toolcache`, so it is downloaded once. See [Toolchains](#toolchains) for the download consent. |
| **`actions/setup-python`** | Detects `python3`/`python`, checks the requested version, reports the resolved path. |
| **`actions/setup-go`** | Detects `go version` and checks the requested version. |
| **`actions/setup-java`** | Detects `java -version`, checks the requested version and distribution. |
| **`actions/setup-dotnet`** | Detects `dotnet --version` and checks the requested version. |
| **`actions/setup-ruby`** | Detects `ruby --version` and checks the requested version. |
| **Composite actions** | Their inline `run:` steps really execute, in order, with full expression and `secrets` resolution. A failure aborts the rest, as on a runner. |

A version constraint that your local tool does not satisfy is a **failure**,
not a warning — it is the same failure the runner would give.

---

## Toolchains

`actions/setup-node` decides which interpreter runs the rest of the job, so
AeroCI does it for real rather than describing it.

### What "the version you asked for" means

`node-version: 18` is not a runtime, it is a range. The spec is matched against
nodejs.org's official release index, so it resolves to a concrete build — today
`18` means **18.20.8**. These forms are understood:

| Written as | Resolves to |
|------------|-------------|
| `18`, `18.x`, `18.*` | the newest 18.y.z |
| `18.20` | the newest 18.20.z |
| `18.20.4` | exactly 18.20.4 — a pin, not a floor |
| `^18.20.0`, `~18.20.0` | `>=18.20.0 <19.0.0`, `>=18.20.0 <18.21.0` |
| `>=18 <21` | the newest release in that window |
| `lts/*`, `lts/hydrogen` | the newest LTS, or the newest of that codename |
| `18 \|\| 20` | the newest of either line |

`node-version-file` is honoured too — a checked-in `.nvmrc` is read from the
workspace. Syntax outside this list (`1.2.3 - 2.3.4`, a bare `node`) is
**refused and named**, never guessed at: a wrong guess would install the wrong
runtime and reintroduce the exact bug this replaced.

A range never resolves to a release candidate. `21` means a release, so it waits
for `21.0.0` rather than settling for `21.0.0-rc.1`.

### Where it goes

`~/.aeroci/toolcache/node/<version>/<arch>/bin`, laid out like a real hosted
tool cache, and `$RUNNER_TOOL_CACHE` points at it — so a step that pokes around
in there finds what setup-node put there. The cache is **global**: Node 18 is the
same forty megabytes whoever asks for it, so one download serves every project
and survives `rm -rf node_modules`. Set `AERO_TOOLCACHE` to move it.

Every download is checked against the `SHASUMS256.txt` nodejs.org publishes
beside the archive, and the unpacked binary is then run once to confirm it
reports the version it claims. A correct checksum on a build that will not start
is not an install.

### Asking before it downloads

Downloading is the one thing a run does that reaches the network, so it never
happens silently.

| Situation | What happens |
|-----------|--------------|
| `--allow-download` | downloads for this run; your `.aeroci.json` is not touched |
| `--deny-download` | never downloads, for this run |
| `toolchain.allowDownload` in `.aeroci.json` | used as-is; no question asked |
| neither, on a terminal | asked **once**, and the answer is saved to `.aeroci.json` |
| neither, no terminal (CI, a pipe) | nothing is downloaded |

A non-interactive run gets the last row on purpose: a pipeline that never agreed
to fetch forty megabytes should not find out from its bandwidth bill. Use
`--allow-download` there, which is a decision about one run and leaves no trace.

### When it cannot be done

The step still succeeds — a run is not a gatekeeper — but it says what happened
and which version the job is really on:

```
⚠ Node 18 was requested but downloading Node 18.20.8 was not permitted — Node 26.9.0 is used instead
  allow it for one run with `--allow-download`, or record the answer in .aeroci.json
```

Each reason gets its own sentence: refused, no such version, spec not
understood, no build for this OS, network gone, checksum mismatch, or an install
that would not start.

The substitution is recorded as a step warning, and it is in the **markdown,
HTML and JSON** reports — the markdown summary table says a step passed with a
warning, so it cannot be missed by reading only the top of the file. Two
surfaces deliberately do not carry it: **JUnit XML**, which has nowhere to put
a note on a testcase that passed, and the `--json` run summary, which is an
aggregate (`status`, counts, `exitCode`) and keeps no per-step detail. If your
CI reads only one of those two, the substitution is invisible to it — read the
console, which always shows it.

`actions/setup-python`, `setup-go`, `setup-java`, `setup-dotnet` and
`setup-ruby` still only detect the local tool. The machinery is per-runtime and
Node is the one that is done; the others are next.

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

Prefer doing the thing over describing it. When a step cannot be reproduced, the
choice is between a loud refusal and a green lie — and a green lie is worse,
because it is trusted. `setup-node` used to take the second road: it printed a
warning and then ran the whole job on whatever Node the machine happened to
have, so a workflow pinned to 18 finished green on 26. It now installs the real
runtime, and when it cannot, it says which of the reasons applied — the version
does not exist, the spec is not understood, the download was refused, the
network was gone — and names the version the job fell back to.
