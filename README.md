# ✈️ AeroCI (`aeroci`)

> **A local twin for GitHub Actions** — run, check, analyse and audit your
> workflows before you push, in an isolated copy of your project.

AeroCI executes your workflow's real commands in a real shell with the real
`GITHUB_*` environment. Where it cannot reproduce something — a deploy, a
container build, an action with no local implementation — it says
`not simulated` rather than reporting a success it cannot vouch for.

---

## 🚀 Quick Start

```bash
npm install -g aeroci

cd your-project
aeroci init        # .aeroci.json, a sample workflow, a .gitignore entry
aeroci check       # validate the workflows already in the repo
aeroci run         # execute them
```

`aeroci run` works on a project with no `.aeroci.json` at all; the file is
optional and every field in it has a default.

---

## What each command does

| Command | What it does |
|---------|--------------|
| `aeroci init` | Writes `.aeroci.json`, a sample workflow, `.env.example`, and adds generated paths to `.gitignore`. Existing files are left alone unless you pass `--force`. |
| `aeroci check` | Validates workflow YAML against what the runner actually requires: schema, action pinning, secrets vs `.env`, the job graph, matrix, shell availability. |
| `aeroci run` | Executes the workflows in an isolated sandbox — one per job and per matrix combination. |
| `aeroci debug` | Opens a shell with the same CI environment in a copy of the project, so you can re-run a failing command by hand. |
| `aeroci analyze` | Structural intelligence: dead steps, duplicate steps, unused outputs, the job graph, the longest chain, a complexity score. |
| `aeroci security` | Audits for template injection, supply-chain risk, token scope and exfiltration paths. |
| `aeroci profile` | Run history and a trend against your own previous runs. |
| `aeroci report` | Re-renders the last run in other formats, diffs two workflows, or lists the commits that touched them. |
| `aeroci versions` | Shows how every action is pinned and whether AeroCI simulates it. |
| `aeroci ui` | Serves a read-only dashboard of the workflows in this project. |

Full flags: [docs/cli-reference.md](docs/cli-reference.md).

---

## Isolation

Every job gets its own copy of the project, so a file one job writes is
invisible to the next — the same isolation separate runners give you. Your
working tree is never modified. Details and the measured cost are in
[docs/sandbox.md](docs/sandbox.md).

`.env` is one of the paths left out. A runner has no `.env` in the working
tree: your secrets reach a step through the `secrets` context and nowhere
else. Copying yours in would put every secret the project owns one `cat` away
from any step, including the ones this workflow never mentions — and one
`upload-artifact` away from a report you were about to share. They are still
available to the steps that ask for them, and still masked in the log.

The one exception is opt-in and announced at the start of the run:
`"sandbox": { "mode": "link" }` points the excluded paths (`node_modules` and
friends) at your real directories, so a step can use your installed
dependencies. A step that writes into them edits the real files.

---

## What is not simulated

The honest list, so a green run is never read as more than it is:

- **Publishing and deploying** — `actions/deploy-pages`,
  `actions/create-release`, `peaceiris/actions-gh-pages`: the step runs and is
  reported as `not simulated`. No network call, no git push.
- **Container builds** — `docker/build-push-action`, `docker/login-action`:
  the Dockerfile is located and checked, the build is not run.
- **CodeQL** — no database or runner image to run it against.
- **AWS OIDC role assumption** — the environment is validated and reported;
  the role is not assumed.
- **Reusable workflow calls** (`jobs.<id>.uses`) — reported as
  `not simulated`; a real runner delegates to a different run.
- **Any action without a local implementation** — reported as
  `not simulated`, with its real behaviour explicitly called unverified.
- **Secrets masking in a debug shell** — `aeroci debug` does not register log
  masks, so treat anything you `cat` there as if it were printed.

Everything else that AeroCI claims to run, it really runs: composite actions
execute their inline steps, `actions/github-script` really evaluates your
script against a `@actions/core` shim, `actions/cache` really hits a local
cache directory, and artifacts really get archived.

---

## Development

```bash
npm test           # every suite, each in its own process
npm run lint       # the quality gate: duplicate keys, dead code, ReDoS, static mismatches
```

See [docs/contributing.md](docs/contributing.md).

---

## 📄 License

MIT © Moaaz
