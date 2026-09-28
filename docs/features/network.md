---
title: Network policy
---

# Network policy

> **AeroCI never uses the network without explicit permission.**

That sentence is easy to write and easy to break, so here is exactly what it
covers, what it does not, and how it is enforced rather than merely promised.

---

## Two decisions, not one

The most important thing on this page is what is *absent*: there is no single
switch. Two separate answers are recorded, in `~/.aeroci/config.json`:

| Key | Governs |
|-----|---------|
| `network.allowRuntimeDownloads` | AeroCI fetching a Node build from nodejs.org **for** the workflow |
| `network.allowWorkflowNetwork` | the workflow's **own** `run:` steps opening sockets |

Answering yes to the first is not an answer to the second. A workflow that
needs its runtime installed and has no business phoning home is an ordinary
thing to want, and one key cannot express it. Reading one from the other is how
`Runtime installation: ALLOWED` quietly becomes `Workflow network: ALLOWED`, so
they are never read from each other.

This is real, not theoretical:

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
  ↳ Step 3/3: fetch
     $ npm view aeroci-never-fetched-9f3a2b version
       │ npm error code EPERM
       │ npm error FetchError: request to https://registry.npmjs.org/… failed
```

AeroCI reached the network on the workflow's behalf, installed a real Node 18,
and the workflow's own registry request was still refused — with `EPERM`, which
is the refusal surfacing, not a name-resolution error.

---

## A project cannot grant it

Neither key can be set in `.aeroci.json`. Trying produces a message that names
the file that does hold it:

```console
✖ .aeroci.json cannot set network.allowWorkflowNetwork (a project cannot grant it)
  — the network policy is a decision about this machine, not about the
  repository, and it lives in ~/.aeroci/config.json. Those keys were ignored;
  the recorded answer still stands.
```

A checked-in `.aeroci.json` is content from a repository you may not trust. A
policy a repository can grant for itself is not a policy, so the project file is
stripped of these keys before anything reads them. Silently ignoring a key the
user wrote would be its own dishonesty, which is why it is reported.

`~/.aeroci/config.json` is yours. Nothing but you writes it.

---

## How the denial is enforced

Consent and enforcement are separate problems, and the answer to "the user said
no" is worthless if nothing makes it true. So every `run:` step is wrapped:

| Platform | Mechanism | Needs root? |
|----------|-----------|-------------|
| macOS | `sandbox-exec` with a Seatbelt profile | no |
| Linux | `unshare --net --map-root-user` | no, if user namespaces are enabled |
| Windows | none available | — |

The wrapper goes around the **shell**, not around the commands in the script.
Every process the script starts inherits the profile, so a `curl` piped into a
`python` cannot route around it. There is no per-command list to keep in sync
and nothing a step does can escape it.

### macOS: the profile, and why it is not the obvious one

```scheme
(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
```

The obvious spelling is `(deny network*)`, and it is wrong in a way that is easy
to miss: `network*` covers `network-bind` as well as `network-outbound`, so a
step cannot even **listen** on a port. A workflow that starts a dev server and
then curls it breaks for a reason that has nothing to do with the policy you
agreed to — and a real runner allows it.

So the denial is scoped to the one operation that leaves the machine. Seatbelt
resolves last-match-wins, which is what makes the second line an exception rather
than a contradiction, and `network-bind` is never mentioned.

Verified on macOS 15 (arm64), through a real `aeroci run`:

| Probe | Under `--deny-network` |
|-------|------------------------|
| `curl https://registry.npmjs.org/left-pad` | `HTTP 000` |
| `node net.connect(80, '104.16.0.35')` | `ERR EPERM` |
| `git ls-remote https://github.com/…` | `Failed to connect to github.com port 443` |
| DNS resolution | refused, so the failures above are not name errors |
| server bound on `127.0.0.1`, reached from the same step | `reached -> hi` |
| writing a file | works |

The raw socket matters: a policy that only blocked DNS would be routed around
with an IP literal in half a line. The filesystem row matters too — this is a
network policy, and breaking disk access would be collateral damage.

It costs about 12ms per step.

### Linux: the probe runs, it does not guess

A present-but-unusable `unshare` — a kernel without user namespaces, a rootless
container without the capability, `sysctl` with namespaces switched off — looks
exactly like a working one to a `which unshare`. So the probe executes it:

```console
$ unshare --net --map-root-user -- /bin/true
unshare: unshare failed: Operation not permitted
```

`--map-root-user` is what makes this work without root: it creates a user
namespace alongside the network one and maps you to `0` inside it.

---

## When it cannot be enforced

Windows has no mechanism, and a Linux machine may have none available. AeroCI does
not pretend otherwise. The policy still applies to what AeroCI itself does — the
runtime download is refused as asked — but the workflow's steps are **not**
isolated, and the run says so in those words before anything executes:

```
⚠ Workflow network: DENIED by policy but NOT ENFORCED — win32 has no
  network-isolation mechanism that AeroCI knows of. Steps may still reach the
  network. Use --allow-network to allow it deliberately.
```

A tool that printed "network denied" and then did nothing would be worse than
one that never claimed the policy. Refusing to run at all would be the other
honest option, and it is a worse one: it would make AeroCI unusable on Windows,
and a tool nobody can run does not protect anybody.

---

## When a step fails under a denial

A network failure and a broken workflow look identical from the inside:
`ENOTFOUND registry.npmjs.org` could be a bad lockfile. So the first failure of
a denied run says which it might be:

```
⚠ network access is denied for this run, so this failure may be AeroCI's policy
  rather than a fault in the workflow — rerun with --allow-network to tell them
  apart
```

Said once per run, not once per step: a job that installs five packages fails
five times, and repetition reads as five different problems. It is not said for
a step that succeeded, and not at all when access was allowed.

---

## What a denial does not cover

The policy governs **network access**. It cannot govern what a process already
has on disk, and pretending otherwise would be the easy lie to tell here.

A tool with its own cache can answer a request without making one. npm is the
clearest case, and it was measured rather than assumed:

| Step | `--deny-network` | `--allow-network` |
|------|------------------|-------------------|
| `npm view left-pad version` (already in npm's cache) | `1.3.0` after **70.5s** | `1.3.0` after 1.3s |
| `npm view aeroci-never-fetched-9f3a2b version` | `npm error code EPERM` | resolves normally |

Both rows are the denial holding. The 70 seconds is npm exhausting its retry
budget against a socket that will never open, and *then* answering from
`~/.npm/_cacache` — a real file on your disk that no network policy has any
business touching. The second row is what a genuine refusal looks like.

So a denied step can still succeed, and when it does, the duration is the tell.
That is a true statement about what the policy governs, not a hole in it. If you
need a step to fail without any cached material available, point `HOME` or
`npm_config_cache` at an empty directory.

---

## Being stricter than GitHub

With no answer recorded and no terminal to ask, the answer is **no**. That makes
AeroCI stricter than a GitHub-hosted runner, which has a network:

> A repository that passes on GitHub Actions can fail here, for no reason to do
> with the repository.

That is a deliberate trade. The promise is worthless if it resolves to "yes" when
nobody is listening, and the fix is one flag: `--allow-network` for a run you do
trust to reach the internet, or a recorded yes in `~/.aeroci/config.json` for
this machine.

The same applies to the runtime download, and the refusal is a **failed step**,
not a warning. That is the other deliberate change:

```
✗ Node.js 18.x is required but unavailable. Network access was not authorized.
  allow it for this run with --allow-download, or record the answer in ~/.aeroci/config.json
```

The step fails and the rest of the job never runs. It used to print a warning and
carry on with the local Node, which meant a workflow pinned to Node 18 executed
its entire test suite on whatever the machine had and finished green. A green
run that verified nothing the workflow asked for is worse than a red one, so the
step is red.

One exception, and it is not a fallback: when the host runtime already *is* the
exact version the spec resolves to, nothing is downloaded and nothing fails.
Resolving `18` means reading the release index regardless, and the download is
skipped only when the answer that comes back is the build you are already
running — `18.20.8` on a host running 18.20.8 is the same build, so fetching it
again would be a waste. Major numbers do not shortcut this: a host on 22.14.0
with a spec of `22.x` still installs the latest 22, because that is what a real
runner would do.

---

## Resolving a version without the network

Turning `18` into `18.20.8` means reading nodejs.org's release index, which is
itself a network request. So the index is cached in
`~/.aeroci/cache/node/index.json` and read from disk first:

- **Index cached, download refused** — the version is resolved correctly and the
  refusal names the real build:

  ```console
  ✗ Node.js 18.x is required but unavailable. Network access was not authorized.
  ```

- **Nothing cached, nothing permitted** — AeroCI cannot know what `18` means, and
  says exactly that instead of reaching out:

  ```console
  ✗ Node.js 18.x is required but unavailable. Network access was not authorized,
    and no release index is cached to resolve it without.
  ```

The first run of all, with an empty cache, has to ask before it can promise a
specific file. So the offer is worded for what is actually on the table:

```
AeroCI needs Node.js 18.x to execute this workflow.
Node.js 18.x is not installed locally.
Download it now?

  [Y] Yes   reach nodejs.org to resolve 18.x and install it
  [N] No    the setup-node step fails — Node.js 26.9.0 is not a substitute

  Enter means No. Network access is never granted by default.
```

Once the index is cached, the offer names the build and where it lands:

```
  [Y] Yes   download Node.js 18.20.8 to ~/.aeroci/runtimes/node/18.20.8
```

A bare Enter means No. The promise is that nothing reaches the network without
**explicit** permission, and a keypress that expresses nothing is not
permission.

---

## The question, and where the answer goes

Asked once ever, then recorded. Precedence, in order:

1. a flag on this run (`--allow-network`, `--deny-network`) — answers it, and is
   written nowhere;
2. the recorded answer in `~/.aeroci/config.json`;
3. a terminal is asked, and the answer is saved;
4. neither, and no terminal — the answer is no.

The workflow-network question is asked before any job starts, so it can never
land in the middle of a step's output. The runtime-download question is asked by
the `setup-node` step that needs it, because that is the only place that knows
which build is on offer — asked up front it could only say "18", which is a
range, not a file.

---

## Flags

| Flag | Effect |
|------|--------|
| `--allow-network` | `run:` steps may reach the network, as on a runner. This run only. |
| `--deny-network` | `run:` steps are denied outbound access. This run only. |
| `--allow-download` | AeroCI may fetch a runtime from nodejs.org. This run only. |
| `--deny-download` | No runtime is fetched; a `setup-node` step that needs one fails. |

None of them are recorded. A flag is a decision about one run, and quietly
rewriting a config file because somebody passed one would be a side effect they
never asked for.

---

## What is *not* blocked

- **AeroCI's own runtime download** is governed by `allowRuntimeDownloads`, and
  is a separate decision. Answering yes to it does not open the workflow's
  network.
- **Loopback** stays reachable under a denial, because a real runner allows it
  and a workflow that starts a service and talks to it is not making a network
  request the policy was about.
- **DNS configuration is not rewritten** with proxy or offline variables. If
  your environment needs `HTTP_PROXY` for `curl` to work, AeroCI does not set it
  for you.
