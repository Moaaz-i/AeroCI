# Configuration — `.aeroci.json`

Every field is optional. With no file at all, AeroCI uses the defaults below —
`aeroci run` works in a project that has never heard of AeroCI.

Run `aeroci init` to write one.

```json
{
  "version": 1,
  "workflows": [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  "envFile": ".env",
  "strictSecrets": true,
  "vars": {},
  "secrets": {},
  "runner": {
    "shell": null,
    "timeoutMinutes": 10,
    "maxOutputLines": 200
  },
  "sandbox": {
    "mode": "copy",
    "exclude": [".git", "node_modules", "..."],
    "keep": false
  }
}
```

---

## Top level

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `version` | number | `1` | Schema version. |
| `workflows` | string[] | `.github/workflows/*.yml`, `*.yaml` | Globs `aeroci run` scans when you give it no target. |
| `envFile` | string | `".env"` | Where secrets come from, relative to the project root. |
| `strictSecrets` | boolean | `true` | Report a workflow that references a secret your `.env` does not define. |
| `vars` | object | `{}` | Values for the `vars` context. Merged under `--var`. |
| `secrets` | object | `{}` | Values for the `secrets` context. Merged over `.env`, so a config value wins. |

`vars` and `secrets` are a local convenience for a value you do not want in a
file. Both are held in memory for the run; neither is written anywhere.

```json
{
  "vars": { "REGION": "eu-west-1" },
  "secrets": { "NPM_TOKEN": "…" }
}
```

A workflow then reads them the way it always does:

```yaml
- run: deploy --region "${{ vars.REGION }}"
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

An invalid file is reported, not thrown: a malformed `.aeroci.json` prints a
warning naming the problem and the run continues on defaults, because a typo in
a config file should not be the reason you cannot test a workflow.

---

## `runner`

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `shell` | string \| null | `null` | Override the shell for every `run:` step. `null` uses GitHub's default: `bash` on macOS and Linux. |
| `timeoutMinutes` | number | `10` | Per-step timeout, overridden per job by `timeout-minutes:` or per step by `timeout-minutes:`. |
| `maxOutputLines` | number | `200` | Log lines kept per step. |

A step that exceeds `timeoutMinutes` has its whole process tree killed, not
just the shell, so a backgrounded server does not survive to hold the port
open. The step is reported as `timed_out`.

`maxOutputLines` bounds what is *kept*. AeroCI does not stop reading the
stream, so a chatty step still runs to completion — it is the record that is
truncated, and the report says where it cut off.

---

## `sandbox`

Controls the isolated copy each job runs in. See
[sandbox.md](./sandbox.md) for the full explanation and the measured cost.

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `mode` | `"copy"` \| `"link"` | `"copy"` | `"copy"` leaves the excluded paths out. `"link"` symlinks them to your real ones. |
| `exclude` | string[] | see below | Path names to leave out, at any depth. |
| `keep` | boolean | `false` | Keep the sandbox after the run. |

### `mode`

`"link"` is for using your installed `node_modules` without an install step.
It is **not** a speed option — both modes skip those paths, so they cost the
same to set up. What it changes is visibility: a step that writes into a linked
path edits the real files. AeroCI prints a warning naming every linked path
before anything runs, and `--keep`-style leftovers are easy to find.

```json
{ "sandbox": { "mode": "link" } }
```

### `exclude`

The defaults:

```
.git  node_modules  .aeroci-artifacts  .next  dist  build
target  vendor  .venv  __pycache__  coverage  .env
```

Each name is matched at any depth, so `dist` also excludes
`packages/web/dist`.

Your `exclude` entries are **added to** these, not substituted for them. That
is deliberate: a config that replaced the list would let
`"exclude": ["vendor"]` quietly re-include `node_modules`, and the sandbox
would then be a very expensive copy of your dependency tree.

If a workflow genuinely needs one of these paths, `mode: "link"` puts it back
and says so at the start of the run.

---

## `toolchain`

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `allowDownload` | boolean \| null | `null` | Whether `actions/setup-node` may install a runtime from the network. `null` means nobody has been asked yet. |

```json
{
  "toolchain": {
    "allowDownload": true
  }
}
```

`null` is the default and it is not `false` on purpose — it means *undecided*.
The first time a workflow needs a Node version this machine does not have,
AeroCI asks, and records the answer here. After that it stops asking.

`--allow-download` and `--deny-download` override this for a single run and do
**not** write to the file. An explicit flag is a decision about this run, and
quietly rewriting somebody's project file because they passed a flag would be a
side effect they never asked for.

The cache itself is not configured here: it lives at
`~/.aeroci/toolcache` and is shared by every project. `AERO_TOOLCACHE` moves it,
which is what the test suite uses to stay out of your home directory. The
sandbox never copies it, even if you point it inside the project. See
[Toolchains](./features/actions.md#toolchains).

---

## What is not configurable

Not every knob is worth having, and a few plausible ones were left out on
purpose:

- **`followSymlinks`** — a symlink in your project is recreated as a symlink
  and never followed. Following one could duplicate its target, recurse on a
  link pointing at a parent, or hand a step a way out of the sandbox to edit
  your real files. There is no option to change this.
- **A container runtime** — `services:` and `docker` actions are reported as
  `not simulated`. AeroCI does not pretend to have Docker.
- **A default shell per OS** — `shell: null` means "what GitHub would use
  here", not a hard-coded `bash`.

---

## A note on `.env`

`envFile` is read for the `secrets` context only, and the file itself is
excluded from the sandbox — a runner has no `.env` in the working tree. Values
are registered as log masks, so a value a step prints is shown as `***`.

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
NPM_TOKEN=npm_xxxxxxxxxxxxx
AWS_ACCESS_KEY_ID=AKIA...
```

AeroCI reads this file and passes the values to the steps you asked for. It
does not upload or log it. If you set `AERO_UNMASK_SECRETS=1`, log masking is
off and nothing you run is safe to paste into an issue.
