/**
 * Action simulation library.
 *
 * Design principle: never lie. A simulated action either really does the thing
 * (artifacts are archived, github-script really runs, cache really hits) or it
 * reports `notSimulated` so the engine can mark the step honestly instead of
 * pretending it succeeded.
 */

const fs = require('fs');
const path = require('path');
const { which } = require('./shell');
const { ensureNode } = require('./toolchain');

/** @typedef {{success:boolean, outputs?:object, notSimulated?:boolean, messages?:string[]}} SimResult */

const noop = (messages = []) => ({ success: true, messages });

function detectVersion(binary, flag = '--version') {
    if (!which(binary)) return null;
    const res = require('child_process').spawnSync(binary, [flag], {
        encoding: 'utf8', timeout: 5000, stdio: 'pipe'
    });
    if (res.status !== 0 && res.status !== 1) return null;
    const text = `${res.stdout || ''}${res.stderr || ''}`.trim();
    return text.split('\n')[0] || null;
}

function majorOf(versionSpec) {
    const m = /(\d+)/.exec(String(versionSpec || ''));
    return m ? Number(m[1]) : null;
}

class ActionSimulators {
    constructor({ workspace, artifacts, cacheDir, eventPath, repo = 'local/aeroci-simulation', toolchain = null }) {
        this.workspace = workspace;
        this.artifacts = artifacts;
        this.cacheDir = cacheDir;
        this.eventPath = eventPath;
        this.repo = repo;
        // { allowDownload: boolean|null } — whether installing a runtime may
        // reach the network. null means the question is still open and the
        // toolchain must not download.
        this.toolchain = toolchain;
    }

    // ── actions/checkout ─────────────────────────────────────────────────────
    async checkout(step, ctx) {
        const messages = [];
        const with_ = step.with || {};
        const target = with_.path && with_.path !== '.' ? with_.path : null;

        if (target) {
            // Materialise the repository into the requested sub-directory.
            const dest = path.resolve(this.workspace, target);
            if (fs.existsSync(dest)) {
                messages.push(`path "${target}" already exists — reusing the checked-out content`);
            } else {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.cpSync(this.workspace, dest, {
                    recursive: true,
                    force: true,
                    dereference: false,
                    filter: (src) => {
                        const rel = path.relative(this.workspace, src);
                        if (!rel) return true;
                        const top = rel.split(path.sep)[0];
                        return !['.git', '.aeroci', 'node_modules', target].includes(top);
                    }
                });
                messages.push(`checked out the repository into "${target}"`);
            }
        }

        if (with_.ref) messages.push(`ref: ${with_.ref}`);
        for (const unsupported of ['sparse-checkout', 'submodules', 'fetch-depth', 'lfs']) {
            if (with_[unsupported] !== undefined && with_[unsupported] !== false) {
                messages.push(`⚠ "${unsupported}" is not simulated locally`);
            }
        }
        messages.push('repository content is already present in the sandbox (copy-on-write clone)');
        return { success: true, outputs: { 'ref-name': ctx?.github?.ref_name || 'main' }, messages };
    }

    // ── actions/setup-node ───────────────────────────────────────────────────
    /**
     * Read the version the workflow asked for.
     *
     * `node-version-file` wins over `node-version`, matching setup-node. The file
     * is read from the workspace, so a checked-in `.nvmrc` is honoured. A file
     * that is missing is a real problem and says so rather than guessing.
     *
     * @returns {Promise<string>} '' when nothing was requested
     */
    async _requestedNodeVersion(with_, messages) {
        const file = with_['node-version-file'];
        if (file) {
            const candidates = [file];
            // setup-node falls back to these names when given a bare directory.
            if (!path.extname(file)) candidates.push(...['.nvmrc', '.node-version'].map((n) => path.join(file, n)));
            for (const candidate of candidates) {
                try {
                    const text = fs.readFileSync(path.join(this.workspace, candidate), 'utf8');
                    const first = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
                    if (first) return first;
                } catch (_) { /* try the next candidate */ }
            }
            messages.push(`⚠ node-version-file "${file}" was not found or is empty — no version was read`);
            return '';
        }
        return String(with_['node-version'] || '');
    }

    /**
     * Say why the host runtime is being used instead of the requested one.
     *
     * The substitution is the whole story, so it is stated in one line with both
     * versions named, and the fix is a separate line so it does not dilute the
     * warning in the report.
     */
    _nodeFallback(spec, reason, detail, host) {
        const hints = {
            denied: 'allow it for one run with `--allow-download`, or record the answer in .aeroci.json',
            offline: 'Node\'s release index could not be reached; a later run with a network will install it',
            'not-found': 'check the version against https://nodejs.org/dist/index.json',
            'unsupported-spec': 'use a form setup-node understands, e.g. 18, 18.x, 18.20.4, lts/*, >=18 <21',
            'unsupported-platform': 'no official build exists for this operating system and architecture',
            'download-failed': 'the download or its checksum verification did not complete',
            unusable: 'the downloaded build did not start, so it was not used'
        };
        return {
            message: `⚠ Node ${spec} was requested but ${detail} — Node ${host} is used instead`,
            hint: hints[reason] || null
        };
    }

    /**
     * Put the requested Node on PATH for the rest of the job.
     *
     * This is the only step that decides which interpreter the job's own `run:`
     * steps execute, so it does the real work: resolve the spec against the
     * official release index, install that exact build if the machine does not
     * already have it, and prepend its `bin` to the job's PATH. A previous
     * version of this step only compared numbers and then carried on with
     * whatever Node the host had, so a job pinned to 18 could finish green on 26.
     */
    async setupNode(step, ctx) {
        const messages = [];
        const with_ = step.with || {};
        const host = process.versions.node;
        const requested = await this._requestedNodeVersion(with_, messages);

        let version = host;
        let cacheHit = false;

        if (requested) {
            const consent = this.toolchain || {};
            const result = await ensureNode(requested, {
                allowDownload: consent.allowDownload === undefined ? null : consent.allowDownload,
                onProgress: (percent) => this._onNodeDownloadProgress?.(percent)
            });

            if (result.ok) {
                version = result.version;
                cacheHit = result.source === 'cache';
                if (result.bin && ctx && typeof ctx.addPath === 'function') {
                    ctx.addPath(result.bin);
                }
                const codename = result.lts ? ` (${result.lts})` : '';
                if (result.source === 'host') {
                    messages.push(`Node.js v${version}${codename} — already installed and it is what "${result.spec}" resolves to`);
                } else if (result.source === 'cache') {
                    messages.push(`Node.js v${version}${codename} — from the tool cache at ${result.bin}`);
                } else {
                    messages.push(`Node.js v${version}${codename} — downloaded, checksum verified against nodejs.org`);
                }
                if (result.staleIndex) {
                    messages.push('⚠ the Node release index used was a cached copy — the network was not reached for it');
                }
            } else {
                const { message, hint } = this._nodeFallback(result.spec, result.reason, result.message, host);
                messages.push(message);
                if (hint) messages.push(`  ${hint}`);
                version = host;
            }
        } else {
            messages.push(`Node.js v${host} — no node-version was requested`);
        }

        if (with_['registry-url']) {
            const npmrc = [
                `registry=${with_['registry-url'].replace(/\/$/, '')}/`,
                `//${with_['registry-url'].replace(/^https?:/, '').replace(/\/$/, '')}/:_authToken=${'${NODE_AUTH_TOKEN}'}`
            ].join('\n');
            try {
                fs.writeFileSync(path.join(this.workspace, '.npmrc'), npmrc + '\n', 'utf8');
                messages.push(`wrote .npmrc for ${with_['registry-url']}`);
            } catch (err) {
                messages.push(`⚠ could not write .npmrc: ${err.message}`);
            }
        }
        if (with_.cache) messages.push(`cache: ${with_.cache} (local cache store is simulated separately)`);

        return { success: true, outputs: { 'cache-hit': String(cacheHit), 'node-version': version }, messages };
    }

    // ── generic setup-* runtimes ─────────────────────────────────────────────
    _setupRuntime(step, { binary, flag, key, label }) {
        const messages = [];
        const with_ = step.with || {};
        const requested = with_[key] || 'latest';
        const local = detectVersion(binary, flag);
        if (local) {
            messages.push(`${label}: ${local}`);
            const want = majorOf(requested), have = majorOf(local);
            if (want && have && want !== have) {
                messages.push(`⚠ requested ${requested} but the local runtime is ${local}`);
            }
        } else {
            messages.push(`⚠ ${label} is not installed locally (requested ${requested})`);
        }
        return { success: true, outputs: {}, messages };
    }

    setupPython(step) {
        const messages = [];
        const local = detectVersion('python3') || detectVersion('python');
        const requested = (step.with || {})['python-version'] || '3.x';
        if (local) {
            messages.push(`Python ${local}`);
            if (requested !== '3.x' && majorOf(local) !== majorOf(requested)) {
                messages.push(`⚠ requested Python ${requested} but the local interpreter is ${local}`);
            }
        } else {
            messages.push(`⚠ Python (${requested}) is not installed locally`);
        }
        return { success: true, outputs: {}, messages };
    }

    setupJava(step) {
        const with_ = step.with || {};
        const local = detectVersion('java', '-version');
        const requested = with_['java-version'] || '17';
        const dist = with_.distribution || 'temurin';
        if (!local) {
            return { success: true, outputs: {}, messages: [`⚠ Java (${requested} · ${dist}) is not installed locally`] };
        }
        return { success: true, outputs: {}, messages: [`Java: ${local}`, `requested: ${requested} (${dist})`] };
    }

    setupGo(step) {
        const with_ = step.with || {};
        const local = detectVersion('go', 'version');
        const requested = with_['go-version'] || '1.x';
        if (!local) return { success: true, outputs: {}, messages: [`⚠ Go (${requested}) is not installed locally`] };
        return { success: true, outputs: {}, messages: [`Go: ${local}`, `requested: go${requested}`] };
    }

    setupDotnet() {
        const local = detectVersion('dotnet', '--version');
        return local
            ? { success: true, outputs: {}, messages: [`.NET SDK: ${local}`] }
            : { success: true, outputs: {}, messages: ['⚠ .NET SDK is not installed locally'] };
    }

    setupRuby() {
        const local = detectVersion('ruby', '--version');
        return local
            ? { success: true, outputs: {}, messages: [`Ruby: ${local}`] }
            : { success: true, outputs: {}, messages: ['⚠ Ruby is not installed locally'] };
    }

    // ── actions/cache ────────────────────────────────────────────────────────
    async cache(step) {
        const with_ = step.with || {};
        const key = this._cacheKey(with_.key, ctx => ctx);
        const restoreKeys = String(with_['restore-keys'] || '').split('\n').map((k) => k.trim()).filter(Boolean);
        const indexFile = path.join(this.cacheDir, 'index.json');

        let index = {};
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (_) {}

        let hit = false, hitKey = null;
        if (index[key]) { hit = true; hitKey = key; }
        else {
            for (const rk of restoreKeys) {
                const match = Object.keys(index).sort().find((k) => k.startsWith(rk));
                if (match) { hit = true; hitKey = match; break; }
            }
        }

        const messages = [hit
            ? `cache restored from key "${hitKey}"`
            : `cache miss for key "${key}"`];

        if (!hit) {
            index[key] = {
                paths: String(with_.path || 'node_modules').split('\n').map((s) => s.trim()),
                savedAt: new Date().toISOString()
            };
            try {
                fs.mkdirSync(this.cacheDir, { recursive: true });
                fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');
            } catch (_) {}
        }
        return {
            success: true,
            outputs: { 'cache-hit': String(hit), 'cache-primary-key': key, 'cache-matched-key': hitKey || '' },
            messages
        };
    }

    _cacheKey(raw, _fn) {
        return String(raw || 'default').trim();
    }

    // ── artifacts ────────────────────────────────────────────────────────────
    async uploadArtifact(step) {
        const with_ = step.with || {};
        const name = with_.name || 'artifact';
        const res = await this.artifacts.upload({
            name,
            paths: String(with_.path || '.').split('\n').map((p) => p.trim()).filter(Boolean),
            workspace: this.workspace,
            retentionDays: with_['retention-days']
        });
        const messages = [];
        if (res.warning) messages.push(`⚠ ${res.warning}`);
        if (res.missing && res.missing.length) messages.push(`paths not found: ${res.missing.join(', ')}`);
        if (res.success) messages.push(`uploaded ${res.fileCount} file(s) as "${name}"${res.sizeBytes ? ` (${formatBytes(res.sizeBytes)})` : ''}`);
        else messages.push(`upload failed: ${res.error}`);

        return {
            success: res.success,
            notSimulated: !res.success,
            messages,
            outputs: { 'artifact-id': String(Math.abs(hash(name))), 'artifact-url': `file://${this.artifacts.dir(name)}` }
        };
    }

    async downloadArtifact(step) {
        const with_ = step.with || {};
        const name = with_.name;
        if (!name) {
            return {
                success: false, notSimulated: true,
                messages: ['download-artifact without `with.name` downloads every artifact of the run — not simulated']
            };
        }
        const res = await this.artifacts.download({
            name, path: with_.path || '.', workspace: this.workspace
        });
        return {
            success: res.success,
            notSimulated: !res.success,
            messages: res.success
                ? [`extracted "${name}" → ${res.destination} (${res.fileCount} file(s))`]
                : [`⚠ ${res.error}`],
            outputs: { 'download-path': res.destination || '' }
        };
    }

    // ── actions/github-script ────────────────────────────────────────────────
    async githubScript(step, ctx) {
        const script = (step.with || {}).script;
        const messages = [];
        if (!script) {
            return { success: false, notSimulated: true, messages: ['github-script: no `with.script` provided'] };
        }

        let failure = null;
        const logged = [];
        const summaryTarget = ctx.summary || (ctx.files && ctx.files.summary);
        const mockCore = {
            setOutput: (k, v) => logged.push(`output ${k}=${v}`),
            setFailed: (m) => { failure = m; },
            setSecret: (s) => { ctx.masks.push(String(s)); },
            addPath: (p) => ctx.addPath(String(p)),
            exportVariable: (k, v) => { ctx.jobEnv[k] = v; },
            addMask: (s) => ctx.masks.push(String(s)),
            notice: (m) => messages.push(`notice: ${m}`),
            warning: (m) => messages.push(`warning: ${m}`),
            error: (m) => messages.push(`error: ${m}`),
            info: (m) => messages.push(m),
            debug: (m) => messages.push(`debug: ${m}`),
            getInput: (k) => (ctx.inputs && ctx.inputs[k]) || '',
            getBooleanInput: (k) => String((ctx.inputs && ctx.inputs[k]) || '').toLowerCase() === 'true',
            summary: (md) => summaryTarget?.appendSummary(md),
            startGroup: (n) => messages.push(`::group::${n}`),
            endGroup: () => messages.push('::endgroup::'),
            setCommandEcho: () => {},
            getState: (k) => (ctx.state && ctx.state[k]) || '',
            saveState: (k, v) => { ctx.state[k] = v; },
            fail: (m) => { failure = m; }
        };

        const repository = repoFromContext(ctx);
        const mockGithub = {
            context: {
                repo: repository,
                owner: repository.owner,
                sha: ctx.github.sha,
                ref: ctx.github.ref,
                actor: ctx.github.actor,
                eventName: ctx.github.event_name,
                runId: Number(ctx.github.run_id),
                runNumber: Number(ctx.github.run_number),
                job: ctx.github.job,
                payload: this.readEventPayload(ctx)
            },
            getOctokit: () => makeOctokit(messages)
        };

        // The real action calls the script as (github, context, core) and also
        // injects `require`. The script is awaited, so core.setFailed is honoured.
        try {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const fn = new AsyncFunction('github', 'context', 'core', 'require', script);
            await fn(mockGithub, mockGithub.context, mockCore, safeRequire);
        } catch (err) {
            return { success: false, messages: [...messages, `script threw: ${err.message}`] };
        }

        for (const line of logged) messages.push(line);
        if (failure) {
            return { success: false, messages: [...messages, `core.setFailed → ${failure}`] };
        }
        return { success: true, messages };
    }

    readEventPayload(ctx) {
        if (!this.eventPath || !fs.existsSync(this.eventPath)) return {};
        try { return JSON.parse(fs.readFileSync(this.eventPath, 'utf8')); }
        catch (_) { return {}; }
    }

    // ── docker ───────────────────────────────────────────────────────────────
    async dockerBuildPush(step) {
        const with_ = step.with || {};
        const messages = [];
        const docker = which('docker');
        const file = with_.file || './Dockerfile';
        const context = with_.context || '.';
        const tags = with_.tags || with_.images || 'local/image:latest';

        if (!docker) {
            messages.push('⚠ docker is not installed locally — build not executed');
            return { success: true, notSimulated: true, messages };
        }
        const dockerfile = path.resolve(this.workspace, file);
        if (!fs.existsSync(dockerfile)) {
            messages.push(`✖ Dockerfile not found: ${file}`);
            return { success: false, messages };
        }
        messages.push(`dockerfile ${file} found, context ${context}`);

        if (with_.push) {
            messages.push('⚠ push is never executed by AeroCI (no registry writes)');
        } else if (with_.load !== false) {
            // This used to point at a `--build-images` flag. There is no such
            // flag, so a user who took the advice got a commander error. The
            // build really is not run: an image is minutes of work, and a
            // workflow that builds one by surprise is a bad neighbour.
            messages.push(`would build ${tags} from ${file} — the build itself is not run by AeroCI`);
        }
        return { success: true, notSimulated: true, messages };
    }

    dockerLogin(step) {
        const with_ = step.with || {};
        const messages = [`registry: ${with_.registry || 'docker.io'}`, 'login is never executed locally'];
        return { success: true, notSimulated: true, messages };
    }

    // ── release / pages ──────────────────────────────────────────────────────
    createRelease(step) {
        const with_ = step.with || {};
        const tag = with_.tag_name || 'v0.0.0';
        return {
            success: true, notSimulated: true,
            outputs: { url: `https://github.com/${this.repoSlug()}/releases/tag/${tag}`, id: String(hash(tag)), html_url: `https://github.com/${this.repoSlug()}/releases/tag/${tag}` },
            messages: [`release "${tag}" simulated (no GitHub API call)`, `url: https://github.com/${this.repoSlug()}/releases/tag/${tag}`]
        };
    }

    ghPages(step) {
        const with_ = step.with || {};
        const dir = path.resolve(this.workspace, with_.publish_dir || './public');
        if (!fs.existsSync(dir)) {
            return { success: false, notSimulated: true, messages: [`✖ publish_dir not found: ${with_.publish_dir || './public'}`] };
        }
        return {
            success: true, notSimulated: true,
            messages: [`${with_.publish_dir || './public'} exists — deploy skipped (no git push from AeroCI)`]
        };
    }

    uploadPagesArtifact(step) {
        return this.uploadArtifact({ ...step, with: { ...(step.with || {}), name: 'github-pages' } });
    }

    deployPages() {
        return { success: true, notSimulated: true, messages: ['deployment skipped (no GitHub Pages API calls from AeroCI)'] };
    }

    awsCredentials(step) {
        const with_ = step.with || {};
        const messages = [];
        const roleArn = with_['role-to-assume'];
        const required = [
            { key: 'AWS_ACCESS_KEY_ID', envs: ['AWS_ACCESS_KEY_ID'] },
            { key: 'AWS_SECRET_ACCESS_KEY', envs: ['AWS_SECRET_ACCESS_KEY'] },
            { key: 'AWS_SESSION_TOKEN', envs: ['AWS_SESSION_TOKEN'], optional: true }
        ];
        let ok = true;
        for (const item of required) {
            const present = item.envs.some((e) => !!process.env[e]);
            if (present) { messages.push(`${item.key}: set`); continue; }
            if (roleArn || item.optional) { messages.push(`${item.key}: not set (OIDC role assumed)`); continue; }
            messages.push(`✖ ${item.key} is not set — the step would fail on a real runner`);
            ok = false;
        }
        messages.push(`region: ${with_['aws-region'] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '(unset)'}`);
        return { success: ok, notSimulated: true, messages };
    }

    codeql(step) {
        return {
            success: true, notSimulated: true,
            messages: ['CodeQL analysis is not executed locally (no database or runner image)']
        };
    }

    generic(step, uses) {
        return {
            success: true, notSimulated: true,
            messages: [`⚠ "${uses}" is not simulated — the step counted as a no-op success. Its real behaviour is unverified.`]
        };
    }

    repoSlug() { return this.repo; }
}

function repoFromContext(ctx) {
    return {
        owner: ctx.github.repository_owner,
        repo: (ctx.github.repository || 'local/repo').split('/')[1]
    };
}

function makeOctokit(messages) {
    const notCalled = (name) => async () => {
        messages.push(`⚠ octokit.${name}() is a no-op in the local twin`);
        return { data: {} };
    };
    return {
        rest: {
            issues: { create: notCalled('issues.create'), addLabels: notCalled('issues.addLabels'), list: async () => ({ data: [] }) },
            pulls: { list: notCalled('pulls.list'), get: notCalled('pulls.get') },
            repos: { get: notCalled('repos.get'), getContent: notCalled('repos.getContent') },
            actions: { listJobsForWorkflowRun: notCalled('actions.listJobsForWorkflowRun') },
            checks: { create: notCalled('checks.create') }
        },
        paginate: async () => [],
        request: notCalled('request')
    };
}

/** Restrict what a workflow script can pull in, and never leak AeroCI internals. */
function safeRequire(request) {
    if (typeof request !== 'string') throw new Error('require() expects a module name');
    if (request.startsWith('.') || path.isAbsolute(request)) {
        throw new Error(`github-script may not require local modules ("${request}")`);
    }
    return require(request);
}

function hash(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0;
    return h;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

/** Match a `uses:` string to a simulator, most specific first. */
const MATCHERS = [
    ['actions/checkout', (s, c, ctx) => s.checkout(c, ctx)],
    // setup-node needs `ctx`: it is the step that puts the requested runtime on
    // the job's PATH, which is exactly what core.addPath does on a real runner.
    ['actions/setup-node', (s, c, ctx) => s.setupNode(c, ctx)],
    ['actions/setup-python', (s, c) => s.setupPython(c)],
    ['actions/setup-java', (s, c) => s.setupJava(c)],
    ['actions/setup-go', (s, c) => s.setupGo(c)],
    ['actions/setup-dotnet', (s, c) => s.setupDotnet(c)],
    ['actions/setup-ruby', (s, c) => s.setupRuby(c)],
    ['actions/cache', (s, c) => s.cache(c)],
    ['actions/upload-pages-artifact', (s, c) => s.uploadPagesArtifact(c)],
    ['actions/upload-artifact', (s, c) => s.uploadArtifact(c)],
    ['actions/download-artifact', (s, c) => s.downloadArtifact(c)],
    ['actions/github-script', (s, c, ctx) => s.githubScript(c, ctx)],
    ['actions/create-release', (s, c) => s.createRelease(c)],
    ['actions/deploy-pages', (s) => s.deployPages()],
    ['docker/build-push-action', (s, c) => s.dockerBuildPush(c)],
    ['docker/login-action', (s, c) => s.dockerLogin(c)],
    ['peaceiris/actions-gh-pages', (s, c) => s.ghPages(c)],
    ['configure-aws-credentials', (s, c) => s.awsCredentials(c)],
    ['github/codeql-action', (s) => s.codeql()]
];

module.exports = { ActionSimulators, MATCHERS, detectVersion, formatBytes };
