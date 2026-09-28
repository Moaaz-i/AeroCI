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

## What is not configurable here: the network

There is no `network` key in `.aeroci.json`, and adding one does not work. AeroCI
reports the attempt and ignores it:

```
✖ .aeroci.json cannot set network.allowWorkflowNetwork (a project cannot grant it)
  — the network policy is a decision about this machine, not about the
  repository, and it lives in ~/.aeroci/config.json. Those keys were ignored;
  the recorded answer still stands.
```

The reason is not tidiness. `.aeroci.json` is content that arrives with a
repository, and a policy a repository can grant for itself is not a policy. So
the two decisions live in `~/.aeroci/config.json`, which only you write:

```json
{
  "network": {
    "allowRuntimeDownloads": true,
    "allowWorkflowNetwork": false
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `allowRuntimeDownloads` | boolean \| null | `null` | May AeroCI fetch a Node build from nodejs.org for a workflow that needs a version this machine lacks? |
| `allowWorkflowNetwork` | boolean \| null | `null` | May the workflow's own `run:` steps open sockets? |

`null` means *undecided*, which is not the same as `false`. The first run that
needs an answer asks you, and the answer is recorded, so the question is asked
once. A run with no terminal — a CI job, a pipe, a cron entry — cannot answer,
so the answer is `no`. Guessing "yes" would be the network access nothing agreed
to.

**The two are independent.** Answering yes to the first says nothing about the
second:

```console
$ aeroci run --allow-download --deny-network
  Workflow network: DENIED — enforced with sandbox-exec on every run: step
  ↳ Step 1/2: actions/setup-node@v4
     ⚡ actions/setup-node@v4
     Node.js v18.20.8 (Hydrogen) — downloaded, checksum verified against nodejs.org
     ✔ outputs cache-hit=false node-version=18.20.8
  ↳ Step 2/2: version
     $ node --version
       │ v18.20.8
```

A workflow can legitimately need its runtime installed and have no business
phoning home. That is an ordinary thing to want, and one key cannot express it.

`--allow-download` / `--deny-download` and `--allow-network` / `--deny-network`
answer for a single run and write nothing anywhere. An explicit flag is a
decision about this run.

See [Network policy](./features/network.md) for what the denial actually does,
and what happens on a machine that cannot enforce it.

---

## The global tree

Not everything AeroCI keeps is in your project. It keeps these:

```
~/.aeroci/
├── config.json            the network policy
├── runtimes/              installed, checksum-verified runtimes
│   └── node/18.20.8/arm64/bin/node
│       node/18       → 18.20.8    (symlink to the newest 18.x installed)
│       node/18.20    → 18.20.8
└── cache/                 safe to delete at any time
    ├── node/index.json    the release index, refreshed every 6 hours
    ├── downloads/         archives being fetched
    └── actions/           what `actions/cache` keeps between runs
```

`runtimes/` and `cache/` are separate on purpose. A runtime is something you
installed and verified against a published checksum; a cache is something you may
throw away whenever you like. Keeping them apart is what makes
`rm -rf ~/.aeroci/cache` a safe suggestion to somebody whose disk is full.

`AERO_HOME` moves the whole tree at once, which is what the test suite uses to
stay out of your home directory. The sandbox never copies any of it, even if you
point `AERO_HOME` inside the project — the directory name alone proves nothing,
so the exclusion follows the path rather than the name.

A `toolcache/` left by an older version is moved into place on the first run, so
an already-installed Node is not downloaded a second time. Nothing is deleted by
that move: a file whose destination already exists is left alone, and the old
directory survives if anything unexpected is in it.

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
- **The network policy** — see above. It is the one setting a project file
  cannot reach, on purpose.

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
