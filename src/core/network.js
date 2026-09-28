/**
 * AeroCI's network policy: the one place that decides whether anything reaches
 * the network, and the only place able to enforce the answer.
 *
 * The promise this module exists to keep is simple to state and easy to break:
 *
 *     AeroCI never uses the network without explicit permission.
 *
 * Two very different things used to sit under that sentence, and conflating them
 * is how a tool ends up quietly permissive. They are now separate keys, decided
 * separately, and *neither* of them is inherited from the other:
 *
 *   | decision                    | what it governs                        |
 *   |-----------------------------|----------------------------------------|
 *   | `allowRuntimeDownloads`     | AeroCI itself fetching a runtime from  |
 *   |                             | nodejs.org on the workflow's behalf    |
 *   | `allowWorkflowNetwork`      | the workflow's own `run:` steps opening |
 *   |                             | sockets, and `npm install` inside them  |
 *
 * Answering "yes" to the first is not an answer to the second. A workflow can
 * legitimately want its runtime installed and still have no business phoning
 * home; the reverse is just as common. Reading one from the other is how
 * `Runtime installation: ALLOWED` silently turns into `Workflow network: ALLOWED`.
 *
 * Both decisions live in a **global** config file, `~/.aeroci/config.json`, not
 * in the project's `.aeroci.json`. That is not a tidiness choice. A checked-in
 * `.aeroci.json` is content from a repository you may not trust, and a policy
 * that a repository can grant for itself is not a policy. The project file is
 * still loaded for everything else — `sandbox.mode`, `workflows`, `envFile` —
 * but a `network` key written there is **refused, with a message naming this
 * file**, because silently ignoring a key the user wrote is its own kind of
 * dishonesty. See `config.js`.
 *
 * Enforcement is a separate problem from consent, and this module is careful
 * about the difference. On macOS the denial is real: every `run:` step is wrapped
 * in `sandbox-exec` with a profile that cuts outbound traffic while leaving the
 * filesystem and loopback alone. Where no such mechanism exists the answer is
 * never "allowed" — it is `enforced: false` with a reason, and the run says out
 * loud that the policy is not being applied. A tool that reported "network
 * denied" while doing nothing would be worse than one that never claimed the
 * policy at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

// ── the global data tree ───────────────────────────────────────────────────────
//
//   ~/.aeroci/
//   ├── config.json            the network policy (this file's neighbour)
//   ├── runtimes/              installed runtimes, shared by every project
//   │   └── node/18.20.8/arm64/bin/node
//   └── cache/                 everything disposable
//       ├── node/index.json    the release index, refreshed every 6 hours
//       ├── downloads/         archives being fetched, before they are unpacked
//       └── actions/           what `actions/cache` keeps between runs
//
// `runtimes/` and `cache/` are separated on purpose. A runtime is something you
// installed and verified against a published checksum; a cache is something you
// may throw away at any time. Deleting the second must never be able to make the
// first look broken, and `rm -rf ~/.aeroci/cache` is a safe thing to suggest to
// somebody whose disk is full.

/** The root of everything AeroCI keeps between runs. `AERO_HOME` moves it,
 *  which is how the tests stay out of the developer's real home directory. */
function globalRoot() {
    return process.env.AERO_HOME || path.join(os.homedir(), '.aeroci');
}

/** Installed, verified runtimes. `RUNNER_TOOL_CACHE` points here. */
function runtimesRoot() {
    return path.join(globalRoot(), 'runtimes');
}

/** Everything that is safe to delete. */
function cacheRoot() {
    return path.join(globalRoot(), 'cache');
}

/** Where `actions/cache` keeps entries between runs. */
function actionsCacheRoot() {
    return path.join(cacheRoot(), 'actions');
}

function globalConfigPath() {
    return path.join(globalRoot(), 'config.json');
}

// ── the global config file ─────────────────────────────────────────────────────

/**
 * `null` is a real value here and not the same as `false`: it means nobody has
 * been asked yet. The distinction is the whole "ask once" behaviour, so it is kept
 * all the way to the prompt instead of being collapsed early.
 */
const GLOBAL_DEFAULTS = {
    network: {
        // May AeroCI download a Node build from nodejs.org for a workflow that
        // needs a version this machine does not have?
        allowRuntimeDownloads: null,
        // May a workflow's own `run:` steps reach the network?
        allowWorkflowNetwork: null
    }
};

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isDecision(v) {
    return v === true || v === false || v === null;
}

/**
 * Read `~/.aeroci/config.json`.
 *
 * A missing file is the normal case, not an error: the tree is created on first
 * write, and asking a question should not litter the disk before the answer.
 *
 * @returns {{data: object, errors: string[], path: string, existed: boolean}}
 */
function loadGlobalConfig() {
    const file = globalConfigPath();
    if (!fs.existsSync(file)) {
        return { data: structuredClone(GLOBAL_DEFAULTS), errors: [], path: file, existed: false };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isPlainObject(parsed)) {
            return {
                data: structuredClone(GLOBAL_DEFAULTS),
                errors: [`${file} must contain a JSON object`],
                path: file,
                existed: true
            };
        }
        const data = {
            ...structuredClone(GLOBAL_DEFAULTS),
            ...parsed,
            network: { ...GLOBAL_DEFAULTS.network, ...(isPlainObject(parsed.network) ? parsed.network : {}) }
        };
        const errors = [];
        for (const key of Object.keys(GLOBAL_DEFAULTS.network)) {
            if (!isDecision(data.network[key])) {
                errors.push(`${file}: network.${key} must be true, false or null — got ${JSON.stringify(data.network[key])}`);
                data.network[key] = GLOBAL_DEFAULTS.network[key];
            }
        }
        return { data, errors, path: file, existed: true };
    } catch (err) {
        return {
            data: structuredClone(GLOBAL_DEFAULTS),
            errors: [`${file} is not valid JSON: ${err.message}`],
            path: file,
            existed: true
        };
    }
}

/**
 * Record one network decision, leaving the rest of the file intact.
 *
 * The answer is written whether or not it can be saved: a machine whose home
 * directory is read-only still gets the policy it just agreed to for this run,
 * it just gets asked again next time. Reporting a failure to write is the
 * honest outcome — swallowing it would mean the next run asks again with no
 * explanation.
 *
 * @param {'allowRuntimeDownloads'|'allowWorkflowNetwork'} key
 * @param {boolean} allowed
 * @returns {boolean} whether it reached disk
 */
function saveGlobalConfig(key, allowed) {
    const { data } = loadGlobalConfig();
    data.network = { ...data.network, [key]: !!allowed };
    const file = globalConfigPath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

/** A one-line description of where the policy lives, for messages. */
function configPathLabel() {
    return globalConfigPath();
}

// ── one-time migration ─────────────────────────────────────────────────────────

/**
 * Move the old `~/.aeroci/toolcache` layout into the tree that replaced it.
 *
 * The rename is not cosmetic. `toolcache/node/<version>/<arch>` became
 * `runtimes/node/<version>/<arch>`, and a user with Node 18 already installed
 * would otherwise be told to download it again — forty megabytes, a checksum
 * fetch, and a question they had already answered once, all to re-create a
 * directory that was sitting right there.
 *
 * Nothing is deleted. A file whose destination already exists is left alone, an
 * unexpected entry is left in place, and the old directory is only removed once
 * it is empty. A migration that can lose data is worse than a re-download.
 *
 * @returns {{moved: string[], skipped: string[]}}
 */
function migrateLegacyTree() {
    const moved = [];
    const skipped = [];
    const legacy = path.join(globalRoot(), 'toolcache');
    if (!fs.existsSync(legacy)) return { moved, skipped };

    const pairs = [
        [path.join(legacy, 'node'), path.join(runtimesRoot(), 'node')],
        [path.join(legacy, 'index.json'), path.join(cacheRoot(), 'node', 'index.json')]
    ];

    for (const [from, to] of pairs) {
        if (!fs.existsSync(from)) continue;
        if (fs.existsSync(to)) {
            skipped.push(path.relative(globalRoot(), to));
            continue;
        }
        try {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
            moved.push(path.relative(globalRoot(), to));
        } catch (_) {
            // A cross-device move, or a directory that will not rename. Leaving it
            // behind costs a re-download; guessing at a copy risks the user
            // ending up with two half-truths and no idea which one is used.
            skipped.push(path.relative(globalRoot(), to));
        }
    }

    try {
        if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    } catch (_) { /* not empty, or not ours to remove */ }

    return { moved, skipped };
}

// ── asking ─────────────────────────────────────────────────────────────────────

/**
 * Ask on stderr, so a piped `--json` on stdout stays parseable.
 *
 * A bare Enter means **No**. The promise is that nothing reaches the network
 * without explicit permission, and "explicit" is the operative word: a keypress
 * that expresses nothing is not permission.
 */
function askYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
            rl.close();
            const text = String(answer || '').trim().toLowerCase();
            resolve(text === 'y' || text === 'yes');
        });
    });
}

/**
 * The question asked before a runtime is downloaded.
 *
 * It says three things a user needs and nothing they do not: what is missing,
 * what is being offered, and what answering No costs — because "No" now fails the
 * step, and that has to be visible before the answer is given, not discovered
 * afterwards.
 *
 * The `version` argument is the concrete build when AeroCI already knows it, and
 * empty when it does not. That is not a presentation detail. Turning `18` into
 * `18.20.8` means reading nodejs.org's release index, which is itself a network
 * request, so the only runs that can promise a specific file are the ones whose
 * index is already cached. Promising `18.20.8` while still having to go and look
 * it up would be a claim AeroCI has not earned yet, so the offer is worded for
 * what is actually on the table.
 *
 * @param {{label: string, version: string, host: string}} details
 * @returns {string}
 */
function runtimeDownloadQuestion({ label, version, host }) {
    const destination = version
        ? `download Node.js ${version} to ${path.join(runtimesRoot(), 'node', version)}`
        : `reach nodejs.org to resolve ${label} and install it`;
    return [
        `AeroCI needs Node.js ${label} to execute this workflow.`,
        `Node.js ${label} is not installed locally.`,
        'Download it now?',
        '',
        `  [Y] Yes   ${destination}`,
        `  [N] No    the setup-node step fails — Node.js ${host} is not a substitute`,
        '',
        '  Enter means No. Network access is never granted by default.',
        '  '
    ].join('\n');
}

/**
 * Decide whether a runtime may be downloaded, asking at most once ever.
 *
 * The order is deliberate:
 *
 *   1. a flag on this invocation answers it for this run and is not recorded —
 *      an explicit flag is a decision about *this* run, and quietly writing it
 *      into a config file would be a side effect nobody asked for;
 *   2. otherwise the recorded answer in `~/.aeroci/config.json` is used, which is
 *      the "ask once" part;
 *   3. with neither, an interactive terminal is asked once and the answer is
 *      saved for next time;
 *   4. with neither and no terminal — a CI job, a pipe, a cron job — nothing is
 *      downloaded. Guessing "yes" would make a pipeline pull forty megabytes it
 *      never agreed to, and the step fails either way.
 *
 * @param {{explicit?: boolean, ask?: Function, spec?: string, version?: string,
 *          host?: string}} options
 * @returns {Promise<boolean>}
 */
async function resolveRuntimeConsent({
    explicit, ask, spec = '', version = '', host = process.versions.node
} = {}) {
    if (explicit === true || explicit === false) return explicit;
    const { data } = loadGlobalConfig();
    const recorded = data.network.allowRuntimeDownloads;
    if (recorded === true || recorded === false) return recorded;
    if (!process.stdin.isTTY) return false;
    const askFn = ask || askYesNo;
    const answer = await askFn(runtimeDownloadQuestion({
        label: requestLabel(spec, version),
        version,
        host
    }));
    saveGlobalConfig('allowRuntimeDownloads', answer);
    return answer;
}

/**
 * Decide whether a workflow's steps may reach the network, asking at most once.
 *
 * The same precedence as the runtime consent, for the same reasons.
 *
 * @param {{explicit?: boolean, ask?: Function}} options
 * @returns {Promise<boolean>}
 */
async function resolveWorkflowConsent({ explicit, ask } = {}) {
    if (explicit === true || explicit === false) return explicit;
    const { data } = loadGlobalConfig();
    const recorded = data.network.allowWorkflowNetwork;
    if (recorded === true || recorded === false) return recorded;
    if (!process.stdin.isTTY) return false;
    const askFn = ask || askYesNo;
    const answer = await askFn([
        'AeroCI blocks workflow steps from reaching the network unless you allow it.',
        'Allow this machine\'s workflows to use the network?',
        '',
        '  [Y] Yes   `run:` steps may reach the network, as they would on a runner',
        '  [N] No    `run:` steps are denied outbound access',
        '',
        '  This is a decision about the machine, not this repository, and it is',
        '  recorded in ' + globalConfigPath() + '.',
        '',
        '  Enter means No.',
        '  '
    ].join('\n'));
    saveGlobalConfig('allowWorkflowNetwork', answer);
    return answer;
}

/**
 * How a version request should be *named* in a sentence.
 *
 * `18` becomes `18.x` rather than `18`, because "Node.js 18 is not installed" is
 * not true and reads as a claim about a runtime. A fully pinned spec is shown as
 * written, and anything with no numbers to speak of (`lts/*`) falls back to the
 * concrete build it resolved to — the version the user is really being offered.
 *
 * @param {string} spec
 * @param {string} [resolved]
 * @returns {string}
 */
function requestLabel(spec, resolved = '') {
    const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(spec || ''));
    if (m) {
        if (m[3]) return `${m[1]}.${m[2]}.${m[3]}`;
        if (m[2]) return `${m[1]}.${m[2]}.x`;
        return `${m[1]}.x`;
    }
    return resolved ? `v${String(resolved).replace(/^v/, '')}` : String(spec || '').trim();
}

// ── enforcement ────────────────────────────────────────────────────────────────

/**
 * The macOS Seatbelt profile.
 *
 * The obvious spelling, `(deny network*)`, is wrong in a way that is easy to miss
 * and annoying to live with: `network*` covers `network-bind` as well as
 * `network-outbound`, so it also stops a step from *listening* on a port. A
 * workflow that starts a dev server and then curls it breaks in a way that has
 * nothing to do with the policy the user agreed to, and a real runner allows
 * that. So the denial is scoped to the one operation that leaves the machine:
 *
 *   - `deny network-outbound` for every remote, then
 *   - `allow network-outbound` for localhost.
 *
 * Seatbelt resolves last-match-wins, which is what makes that ordering an
 * exception rather than a contradiction, and `network-bind` is never mentioned,
 * so a step can still listen.
 *
 * Verified on macOS 15 (arm64): outbound DNS and TLS fail with `HTTP 000` and
 * `EPERM`; a raw socket to a literal IP gets `EPERM`; a server bound on
 * 127.0.0.1 answers a request from the same step; the filesystem is untouched;
 * and the wrapper costs about 12ms per step.
 */
const DENY_PROFILE = [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))'
].join(' ');

/**
 * Find out whether this machine can actually enforce a denial, and how.
 *
 * The probe runs the wrapper for real rather than checking that a binary exists.
 * A present-but-unusable `unshare` — a kernel without user namespaces, a
 * container without the capability, a rootless user namespace switched off in
 * `sysctl` — is the common case, and `which unshare` would report it as a
 * working mechanism. So the probe asks a process that has nothing to lose to
 * create a namespace, and believes the answer.
 *
 * @param {{platform?: string, run?: Function}} [options] injection points for tests
 * @returns {{mechanism: string|null, command: string|null, args: string[], reason: string|null}}
 */
function probeIsolation({ platform = process.platform, run } = {}) {
    const exec = run || ((cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 }));

    if (platform === 'darwin') {
        if (exec('/usr/bin/sandbox-exec', ['-p', DENY_PROFILE, '/usr/bin/true']).status === 0) {
            return { mechanism: 'sandbox-exec', command: '/usr/bin/sandbox-exec', args: ['-p', DENY_PROFILE], reason: null };
        }
        return {
            mechanism: null, command: null, args: [],
            reason: 'sandbox-exec is present but a trivial profile did not run'
        };
    }

    if (platform === 'linux') {
        // `--map-root-user` creates a user namespace alongside the network one,
        // which is what makes this work without root. Plain `unshare --net`
        // needs privileges a developer laptop does not have.
        const probe = exec('unshare', ['--net', '--map-root-user', '--', '/bin/true']);
        if (probe.status === 0) {
            return {
                mechanism: 'unshare', command: 'unshare',
                args: ['--net', '--map-root-user', '--'], reason: null
            };
        }
        const detail = probe.error && probe.error.code === 'ENOENT'
            ? 'unshare is not installed'
            : `unshare --net --map-root-user failed (exit ${probe.status})`;
        return { mechanism: null, command: null, args: [], reason: detail };
    }

    return {
        mechanism: null, command: null, args: [],
        reason: `${platform} has no network-isolation mechanism that AeroCI knows of`
    };
}

/**
 * How a policy decision becomes a command prefix, and whether that prefix can
 * actually deliver.
 *
 * `enforced: false` is a first-class answer, not an error. It means the user said
 * no and the machine cannot say no for them — so the run continues, and says so
 * in those words, rather than pretending the policy is in force.
 *
 * @param {boolean} allowed
 * @param {{platform?: string, run?: Function}} [options]
 * @returns {{policy: 'allow'|'deny', allowed: boolean, enforced: boolean,
 *            mechanism: string|null, command: string|null, args: string[],
 *            reason: string|null, notice: string|null}}
 */
function guard(allowed, options = {}) {
    if (allowed) {
        return {
            policy: 'allow', allowed: true, enforced: true, mechanism: null,
            command: null, args: [], reason: null, notice: null
        };
    }
    const probe = probeIsolation(options);
    if (!probe.mechanism) {
        return {
            policy: 'deny', allowed: false, enforced: false, mechanism: null,
            command: null, args: [],
            reason: probe.reason,
            notice: `workflow network access is DENIED by policy but NOT enforced — ${probe.reason}. ` +
                    'Steps may still reach the network. Allow it with --allow-network, ' +
                    'or accept that this machine cannot isolate them.'
        };
    }
    return {
        policy: 'deny', allowed: false, enforced: true, mechanism: probe.mechanism,
        command: probe.command, args: probe.args, reason: null, notice: null
    };
}

module.exports = {
    globalRoot,
    runtimesRoot,
    cacheRoot,
    actionsCacheRoot,
    globalConfigPath,
    configPathLabel,
    migrateLegacyTree,
    loadGlobalConfig,
    saveGlobalConfig,
    resolveRuntimeConsent,
    resolveWorkflowConsent,
    runtimeDownloadQuestion,
    requestLabel,
    guard,
    probeIsolation,
    askYesNo,
    GLOBAL_DEFAULTS,
    DENY_PROFILE
};
