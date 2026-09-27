/**
 * AeroCI execution engine.
 *
 * Faithfully reproduces the GitHub Actions runner for everything that can be
 * reproduced locally:
 *
 *   • expression evaluation (github/env/matrix/steps/needs/… + functions)
 *   • job `needs:` ordering, job-level and step-level `if` with
 *     success()/failure()/always()/cancelled() and the real cascade
 *   • matrix expansion (include/exclude/max-parallel/fail-fast)
 *   • GITHUB_OUTPUT / GITHUB_ENV / GITHUB_PATH / GITHUB_STATE / step summary
 *   • workflow commands on stdout *and* stderr (::error, ::warning, …)
 *   • per-step shell selection using GitHub's exact argument vectors
 *   • step timeouts that kill the whole process tree
 *   • exit codes, continue-on-error at step and job level
 *
 * Anything it cannot reproduce is reported as `not simulated` — never as a
 * silent success.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { Logger, colors } = require('../utils/logger');
const { run } = require('../utils/exec');
const { Sandbox } = require('./sandbox');
const { ArtifactStore } = require('./artifacts');
const { FileCommandSet } = require('./action-files');
const { ActionSimulators, MATCHERS } = require('./action-simulators');
const { cacheRoot } = require('./toolchain');
const { parseLocalAction, entryExists } = require('./local-action');
const { readGitState, buildEventPayload, buildGithubContext } = require('./event');
const expressions = require('./expressions');
const { resolveShell } = require('./shell');
const { parseWorkflowCommands } = require('./workflow-commands');
const { expandMatrix, MAX_COMBINATIONS } = require('./matrix');
const { orderJobs, normalizeNeeds, transitiveNeeds } = require('./graph');
const { loadEnvFile } = require('./secrets');
const { DEFAULTS } = require('./config');

const STATUS = {
    SUCCESS: 'success',
    FAILURE: 'failure',
    SKIPPED: 'skipped',
    CANCELLED: 'cancelled',
    TIMED_OUT: 'timed_out',
    NOT_SIMULATED: 'not_simulated'
};

const FAILED_STATUSES = new Set([STATUS.FAILURE, STATUS.TIMED_OUT]);

/** Contexts GitHub exposes for each `if:` scope. */
const CONTEXTS_BY_SCOPE = {
    workflowLevel: ['github', 'inputs', 'vars'],
    jobLevel: ['github', 'needs', 'vars', 'inputs'],
    stepLevel: ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs']
};

const RUNNER_OS = process.platform === 'darwin' ? 'macOS'
    : process.platform === 'win32' ? 'Windows' : 'Linux';

class Engine {
    constructor(options = {}) {
        this.options = options;
        this.cwd = options.cwd || process.cwd();
        this.debug = !!options.debug;
        this.maxOutputLines = options.maxOutputLines ?? 200;
        this.dryRun = !!options.dryRun;
        this.inheritEnv = options.inheritEnv !== false;
        this.envOverrides = options.envOverrides || {};
        this.onlyJob = options.onlyJob || null;
        this.defaultTimeoutMinutes = options.stepTimeoutMinutes ?? 10;
        this.strictSecrets = options.strictSecrets !== false;
        this.unmaskSecrets = options.unmaskSecrets ?? process.env.AERO_UNMASK_SECRETS === '1';
        this.onStepStart = options.onStepStart || null;
        this.onStepEnd = options.onStepEnd || null;
        // Whether `actions/setup-*` may install a runtime from the network.
        // `null` is the honest default: the question is asked once, by the CLI,
        // and until it is answered nothing is downloaded.
        this.allowDownload = options.allowDownload === true;
        // Per-workflow wiring, replaced for every file.
        this.workspace = null;
        this.simulators = null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    static loadWorkflowFile(file) {
        const content = fs.readFileSync(file, 'utf8');
        let doc;
        try {
            doc = yaml.load(content, { filename: file });
        } catch (err) {
            return {
                file,
                error: {
                    kind: 'yaml',
                    message: err.message.split('\n')[0],
                    line: err.mark ? err.mark.line + 1 : null,
                    column: err.mark ? err.mark.column + 1 : null
                }
            };
        }
        if (!doc || typeof doc !== 'object') {
            return { file, error: { kind: 'empty', message: 'workflow file is empty or not a mapping' } };
        }
        // A workflow with nothing to run is not a workflow. GitHub refuses to
        // start one, so reporting `success` for an empty `jobs:` would hand back
        // a green result for a file that on the real runner never runs at all.
        if (!doc.jobs || typeof doc.jobs !== 'object' || Object.keys(doc.jobs).length === 0) {
            return {
                file,
                error: { kind: 'schema', message: 'no "jobs" defined — there is nothing for the runner to execute' }
            };
        }
        return { file, doc, problems: validateWorkflow(doc) };
    }

    async run(workflowFiles) {
        const results = [];
        for (const file of workflowFiles) {
            let loaded;
            try {
                loaded = Engine.loadWorkflowFile(file);
            } catch (err) {
                results.push(this._fatalResult(file, { kind: 'io', message: err.message }));
                continue;
            }
            if (loaded.error) {
                results.push(this._fatalResult(file, loaded.error));
                continue;
            }
            for (const problem of loaded.problems) {
                Logger.warn(`${path.relative(this.cwd, file)}: ${problem}`);
            }
            results.push(await this._executeWorkflow(loaded));
        }
        return results;
    }

    _fatalResult(file, error) {
        Logger.error(`${colors.bright(path.relative(this.cwd, file))}: ${error.message}`);
        if (error.line) Logger.info(`  at line ${error.line}${error.column ? `, column ${error.column}` : ''}`);
        return {
            file,
            relativeFile: path.relative(this.cwd, file),
            name: path.basename(file),
            status: STATUS.FAILURE,
            error,
            jobs: [],
            steps: [],
            durationMs: 0
        };
    }

    // ── Workflow ─────────────────────────────────────────────────────────────

    async _executeWorkflow(loaded) {
        const { doc, file } = loaded;
        const relativeFile = path.relative(this.cwd, file);
        const result = {
            file,
            relativeFile,
            name: doc.name || path.basename(file),
            eventName: null,
            git: null,
            status: STATUS.SUCCESS,
            jobs: [],
            steps: [],
            error: null,
            secretsMissing: [],
            durationMs: 0
        };

        const gitState = readGitState(this.cwd);
        const envFile = this.options.envFile || path.join(this.cwd, '.env');
        const envLoaded = loadEnvFile(envFile);
        for (const warning of envLoaded.warnings) Logger.warn(`${path.relative(this.cwd, envFile)}: ${warning}`);

        // ── what is per-run and what is per-job ───────────────────────────────
        //
        // On a real runner every job — and every matrix combination — gets a
        // fresh machine and a fresh checkout, so a file one job writes is
        // invisible to the next. Sharing one workspace would let job order
        // decide whether a workflow passes, which is precisely the class of
        // bug this tool exists to catch.
        //
        // The channels that DO carry data between jobs are the ones GitHub
        // defines: artifacts, the cache, and `needs` outputs. Those live in a
        // run-level directory that outlives every individual job.
        let runRoot;
        try {
            runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-run-'));
        } catch (err) {
            return this._fatalResult(file, { kind: 'sandbox', message: err.message });
        }
        fs.mkdirSync(path.join(runRoot, 'artifacts'), { recursive: true });
        fs.mkdirSync(path.join(runRoot, 'cache'), { recursive: true });
        const disposeRunRoot = () => {
            if (this.options.keepSandbox) {
                Logger.info(`${colors.gray}Run state kept at${colors.reset} ${runRoot}`);
                return;
            }
            try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        };

        const artifacts = new ArtifactStore(path.join(runRoot, 'artifacts'));
        const cacheDir = path.join(runRoot, 'cache');
        const eventPath = path.join(runRoot, 'event.json');
        const eventName = this._pickEvent(doc);
        result.eventName = eventName;
        result.git = gitState;

        const payload = buildEventPayload(eventName, gitState, this.options.inputs || {});
        fs.writeFileSync(eventPath, JSON.stringify(payload, null, 2), 'utf8');

        const workflowEnv = this._buildEnv(doc.env, { secrets: envLoaded.values, vars: this.options.vars || {} });
        const githubBase = buildGithubContext(gitState, eventName, payload, {
            workflowFile: path.basename(file),
            workflowName: doc.name || path.basename(file),
            runId: 10000 + (gitState.sha.length % 900),
            runNumber: 1,
            workspace: runRoot,
            jobId: ''
        });

        const started = Date.now();
        Logger.metric('Workflow', result.name);
        Logger.metric('Event', eventName);
        Logger.metric('Repository', `${gitState.repository} @ ${gitState.sha.slice(0, 12)}`);
        Logger.metric('Ref', gitState.ref);
        if (envLoaded.exists) {
            Logger.metric('Secrets file', `${path.relative(this.cwd, envFile) || '.env'} (${Object.keys(envLoaded.values).length} value(s))`);
        }
        Logger.emit(colors.gray + '─'.repeat(64) + colors.reset);

        const { order, cycles, deps } = orderJobs(doc.jobs || {});
        if (cycles.length) {
            const cycle = cycles[0].join(' → ');
            Logger.error(`Circular "needs" dependency: ${colors.red}${cycle}${colors.reset}`);
            result.status = STATUS.FAILURE;
            result.error = { kind: 'graph', message: `circular needs: ${cycle}` };
            disposeRunRoot();
            result.durationMs = Date.now() - started;
            return result;
        }

        // A job id that is not in the workflow. Silently skipping every job
        // made `--only-job typo` report "all workflows passed" with 0/4 steps
        // executed — a green result for a run that did nothing, which is the one
        // outcome a CI tool must never produce.
        if (this.onlyJob && !(this.onlyJob in doc.jobs)) {
            const known = Object.keys(doc.jobs || {});
            Logger.error(`No job "${this.onlyJob}" in ${result.relativeFile}. `
                + (known.length ? `It has: ${known.join(', ')}.` : 'It has no jobs.'));
            result.status = STATUS.FAILURE;
            result.error = {
                kind: 'filter',
                message: `--only-job ${this.onlyJob} matched no job in ${result.relativeFile}`
            };
            disposeRunRoot();
            result.durationMs = Date.now() - started;
            return result;
        }

        const jobResults = new Map();
        let sandboxesRemoved = 0;
        let sandboxMs = 0;

        // `mode: 'link'` shares the excluded paths with the real project, so it
        // is stated before anything runs rather than left for the reader to find
        // in the configuration file.
        const sandboxCfg = this.options.config ? this.options.config.sandbox : null;
        if (sandboxCfg && sandboxCfg.mode === 'link') {
            const shared = this.options.config.sandboxExcludes || [];
            Logger.warn(`Sandbox mode "link" — ${shared.length} excluded path(s) point at your real project:`);
            Logger.note(`  ${shared.join(', ')}`);
            Logger.note('  A step that writes into them edits the real files. Everything else is still a private copy.');
        }

        for (const jobId of order) {
            const job = doc.jobs[jobId];

            if (this.onlyJob && jobId !== this.onlyJob) {
                result.jobs.push(this._skippedJob(jobId, job, `filtered out by --only-job ${this.onlyJob}`));
                continue;
            }

            if (job && job.uses && !job.steps) {
                // Reusable workflow call — the real runner delegates to another run.
                Logger.job(`${colors.gray}[${jobId}]${colors.reset} ${colors.yellow}reusable workflow "${job.uses}" is not simulated${colors.reset}`);
                result.jobs.push({
                    jobId, name: job.name || jobId, status: STATUS.NOT_SIMULATED,
                    reason: `reusable workflow call (${job.uses})`,
                    'runs-on': job['runs-on'] || null, needs: normalizeNeeds(job.needs),
                    matrixInstances: [], durationMs: 0, steps: []
                });
                continue;
            }

            // The job-level `if:` is decided before any runner exists, so this
            // context is built against the run-level directory. Nothing in it
            // writes: an `if:` only reads contexts.
            const gateSandbox = {
                dir: runRoot,
                resolve: (...parts) => path.join(runRoot, ...parts)
            };
            const baseCtx = this._buildContext({
                doc, jobId, job, deps, jobResults, github: githubBase, matrix: {},
                workflowEnv, envLoaded, sandbox: gateSandbox,
                files: new FileCommandSet(runRoot, path.join(runRoot, '_temp')), strategy: {}
            });

            const shouldRun = this._conditionPasses(job.if, baseCtx, 'jobLevel', `job "${jobId}"`);
            if (!shouldRun) {
                result.jobs.push(this._skippedJob(jobId, job, `if: ${job.if} is false`));
                continue;
            }

            const { combinations, truncated, maxParallel, failFast } = job.strategy
                ? expandMatrix(job.strategy)
                : { combinations: [{}], truncated: false, maxParallel: Infinity, failFast: true };

            if (truncated) {
                Logger.warn(`Job [${jobId}]: matrix expansion exceeded ${MAX_COMBINATIONS} combinations — some were skipped`);
            }

            const parallelNote = combinations.length > 1
                ? ` ${colors.gray}(${combinations.length} combination${combinations.length === 1 ? '' : 's'}, max-parallel ${maxParallel === Infinity ? '∞' : maxParallel})${colors.reset}`
                : '';

            Logger.job(`[${jobId}]${job.name && job.name !== jobId ? ` ${colors.gray}(${expressions.evaluateTemplate(String(job.name), baseCtx)})${colors.reset}` : ''} ${colors.gray}· ${job['runs-on'] || 'ubuntu-latest'} · ${(job.steps || []).length} step(s)${parallelNote}`);

            const instanceResults = [];
            let jobFailed = false;

            for (const [index, matrix] of combinations.entries()) {
                if (combinations.length > 1) {
                    Logger.note(`matrix ${index + 1}/${combinations.length} ${colors.gray}${JSON.stringify(matrix)}${colors.reset}`);
                }

                // A fresh checkout per instance. This is what makes a matrix
                // combination independent: they run on separate machines, so a
                // file one of them writes is not there for the next.
                let instanceSandbox;
                try {
                    instanceSandbox = this._createSandbox();
                    sandboxMs += instanceSandbox.setupMs || 0;
                    Logger.info(`${colors.gray}Sandbox${colors.reset} ${colors.bright(instanceSandbox.dir)}${colors.reset} ${colors.gray}· ${instanceSandbox.stats.files} file(s) · ${instanceSandbox.humanSize} · ${instanceSandbox.setupMs.toFixed(0)}ms${colors.reset}`);
                } catch (err) {
                    instanceResults.push({
                        jobId, matrix, status: STATUS.FAILURE, steps: [], outputs: {},
                        durationMs: 0, reason: `sandbox: ${err.message}`
                    });
                    jobFailed = true;
                    break;
                }

                this.workspace = instanceSandbox.dir;
                const instanceFiles = new FileCommandSet(
                    instanceSandbox.dir, instanceSandbox.resolve('_temp'));

                let instance;
                try {
                    const ctx = this._buildContext({
                        doc, jobId, job, deps, jobResults,
                        github: { ...githubBase, workspace: instanceSandbox.dir },
                        matrix,
                        workflowEnv, envLoaded, sandbox: instanceSandbox, files: instanceFiles,
                        strategy: {
                            'fail-fast': failFast,
                            'job-index': index,
                            'job-total': combinations.length,
                            'max-parallel': maxParallel === Infinity ? 1 : maxParallel
                        }
                    });
                    this.simulators = new ActionSimulators({
                        workspace: instanceSandbox.dir,
                        artifacts,
                        cacheDir,
                        eventPath,
                        repo: gitState.repository,
                        toolchain: { allowDownload: this.allowDownload }
                    });

                    instance = await this._runJobInstance({ jobId, job, ctx });
                } finally {
                    // The workspace goes away with the job, whatever happened in
                    // it — that is what keeps one run from filling the disk.
                    if (this.options.keepSandbox) {
                        Logger.info(`${colors.gray}Sandbox kept at${colors.reset} ${instanceSandbox.dir}`);
                    } else {
                        instanceSandbox.dispose({ Logger, colors, quiet: true });
                        sandboxesRemoved++;
                    }
                }
                this.workspace = null;

                instance.matrix = matrix;
                instance.strategy = {
                    'fail-fast': failFast,
                    'job-index': index,
                    'job-total': combinations.length,
                    'max-parallel': maxParallel === Infinity ? 1 : maxParallel
                };
                instanceResults.push(instance);
                result.steps.push(...instance.steps);

                const failed = FAILED_STATUSES.has(instance.status);
                if (failed) jobFailed = true;

                const tolerated = job['continue-on-error'] === true;
                jobResults.set(jobId, {
                    // Gate for `needs` + success(): a tolerated failure lets the
                    // workflow continue, which is the documented purpose of
                    // job-level continue-on-error.
                    status: failed && !tolerated ? STATUS.FAILURE : STATUS.SUCCESS,
                    // What `needs.<job>.result` reports: the raw outcome.
                    rawResult: failed ? STATUS.FAILURE : STATUS.SUCCESS,
                    outputs: instance.outputs,
                    matrix
                });

                if (failed && failFast && index < combinations.length - 1) {
                    Logger.warn(`Job [${jobId}]: fail-fast → ${combinations.length - index - 1} remaining combination(s) cancelled`);
                    for (let i = index + 1; i < combinations.length; i++) {
                        instanceResults.push({
                            jobId, matrix: combinations[i], status: STATUS.CANCELLED,
                            steps: [], outputs: {}, durationMs: 0, reason: 'cancelled by fail-fast'
                        });
                    }
                    break;
                }
            }

            const tolerated = job['continue-on-error'] === true;
            const jobStatus = jobFailed && tolerated ? STATUS.SUCCESS : (jobFailed ? STATUS.FAILURE : STATUS.SUCCESS);
            if (jobFailed && tolerated) {
                Logger.warn(`Job [${jobId}] failed but continue-on-error is set → job counts as successful`);
            }

            result.jobs.push({
                jobId,
                name: job.name || jobId,
                status: jobStatus,
                'runs-on': job['runs-on'],
                needs: normalizeNeeds(job.needs),
                strategy: job.strategy || null,
                durationMs: instanceResults.reduce((s, i) => s + (i.durationMs || 0), 0),
                matrixInstances: instanceResults,
                steps: instanceResults.flatMap((i) => i.steps)
            });

            if (jobStatus === STATUS.FAILURE) result.status = STATUS.FAILURE;
        }

        if (this.strictSecrets) this._reportMissingSecrets(result, envFile, envLoaded);

        result.durationMs = Date.now() - started;
        // Report the isolation cost plainly: a separate checkout per job is what
        // makes one job's files invisible to the next, and it is paid in time.
        if (sandboxesRemoved > 0) {
            const avg = sandboxMs / sandboxesRemoved;
            Logger.info(`${colors.gray}${sandboxesRemoved} isolated workspace(s) created (${avg.toFixed(0)}ms each) and removed — a file one job writes is invisible to the next, as on a real runner.${colors.reset}`);
        }
        disposeRunRoot();
        this.workspace = null;
        return result;
    }

    _skippedJob(jobId, job, reason) {
        Logger.job(`${colors.gray}[${jobId}] skipped — ${reason}${colors.reset}`);
        return {
            jobId, name: (job && job.name) || jobId, status: STATUS.SKIPPED, reason,
            'runs-on': (job && job['runs-on']) || null, needs: normalizeNeeds(job && job.needs),
            matrixInstances: [], durationMs: 0, steps: []
        };
    }

    _reportMissingSecrets(result, envFile, envLoaded) {
        const referenced = new Set();
        const collect = (steps) => {
            for (const s of steps || []) {
                for (const n of s.secretsUsed || []) referenced.add(n);
                if (s.steps) collect(s.steps);
            }
        };
        for (const job of result.jobs) collect(job.steps);

        result.secretsMissing = [...referenced]
            .filter((n) => !(n in envLoaded.values) && !process.env[n]);

        if (result.secretsMissing.length) {
            Logger.warn(`Missing local secret values: ${result.secretsMissing.map((m) => colors.yellow(m)).join(', ')}`);
            Logger.note(`  → add them to ${path.relative(this.cwd, envFile) || '.env'} to simulate with real values`);
        }
    }

    // ── Context construction ─────────────────────────────────────────────────

    _buildContext({ doc, jobId, job, deps, jobResults, github, matrix, workflowEnv, envLoaded, sandbox, files, strategy }) {
        const steps = {};
        // The process environment of a job = workflow env + job env.
        const jobEnv = {
            ...workflowEnv,
            ...this._buildEnv(job.env, { secrets: envLoaded.values, vars: this.options.vars || {} })
        };
        const env = { ...jobEnv };

        const needs = {};
        for (const depId of normalizeNeeds(job.needs)) {
            const recorded = jobResults.get(depId);
            needs[depId] = {
                result: recorded?.rawResult || recorded?.status || STATUS.SKIPPED,
                outputs: recorded?.outputs || {}
            };
        }

        const runner = {
            name: 'AeroCI Local Runner',
            os: RUNNER_OS,
            arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
            temp: sandbox.resolve('_temp'),
            tool_cache: cacheRoot(),
            debug: this.debug ? '1' : '',
            environment: 'aeroci'
        };

        const status = {
            success: () => this._cascadeSuccess(jobId, deps, jobResults),
            failure: () => !this._cascadeSuccess(jobId, deps, jobResults),
            cancelled: () => this._cancelled,
            always: () => true
        };
        this._cancelled = false;

        const secrets = { ...envLoaded.values, ...(this.options.secrets || {}) };
        const contexts = {
            github: { ...github, job: jobId },
            env,
            job: { status: status.success() ? STATUS.SUCCESS : STATUS.FAILURE, container: null, services: {} },
            jobs: {},
            steps,
            runner,
            secrets,
            strategy,
            matrix,
            needs,
            inputs: this.options.inputs || {},
            vars: this.options.vars || {}
        };

        const ctx = {
            contexts,
            status,
            hashFiles: expressions.createHashFiles(sandbox.dir),
            allowedContexts: null,
            workspace: sandbox.dir,
            github: contexts.github,
            env: contexts.env,
            jobEnv,
            matrix, needs, steps, runner, jobId,
            state: {},
            // The real runner pre-registers repository secrets so they are masked
            // even if a step forgets `::add-mask::`. Set AERO_UNMASK_SECRETS=1
            // to see the raw values while debugging (not GitHub-faithful).
            masks: this.unmaskSecrets ? [] : registeredSecretValues(secrets),
            files,
            summary: files.summary,
            addPath: (p) => { jobEnv.PATH = `${p}${path.delimiter}${jobEnv.PATH || process.env.PATH || ''}`; },
            // Surface for actions/github-script
            io: { log: (m) => Logger.note(`   ${m}`), error: (m) => Logger.error(m) },
            exec: async (cmd, args, opts) => run(cmd, args || [], { cwd: workspaceOf(ctx, opts), timeoutMs: 60000, ...opts }),
            filesystem: { fs, path },
            inputs: contexts.inputs
        };
        void doc;
        return ctx;
    }

    _buildEnv(envBlock, { secrets, vars }) {
        const out = {};
        for (const [key, rawValue] of Object.entries(envBlock || {})) {
            if (key === 'shell') continue;
            let value = rawValue;
            if (typeof rawValue === 'string' && rawValue.includes('${{')) {
                value = rawValue
                    .replace(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
                        (m, n) => (secrets[n] === undefined ? '' : String(secrets[n])))
                    .replace(/\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
                        (m, n) => (vars[n] === undefined ? '' : String(vars[n])));
            }
            out[key] = value === null || value === undefined ? '' : String(value);
        }
        return out;
    }

    /** `success()` for a job: every transitive dependency must have succeeded. */
    _cascadeSuccess(jobId, deps, jobResults) {
        for (const id of transitiveNeeds(jobId, deps)) {
            const recorded = jobResults.get(id);
            if (!recorded || recorded.status !== STATUS.SUCCESS) return false;
        }
        return true;
    }

    _conditionPasses(ifExpr, ctx, scope, label) {
        // A job with no `if:` inherits success().
        if (ifExpr === undefined || ifExpr === null || String(ifExpr).trim() === '') {
            return ctx.status.success();
        }
        try {
            return expressions.evaluateCondition(ifExpr, { ...ctx, allowedContexts: CONTEXTS_BY_SCOPE[scope] });
        } catch (err) {
            Logger.error(`${label}: invalid "if" expression — ${err.message}`);
            return false;
        }
    }

    _pickEvent(doc) {
        if (this.options.event) return this.options.event;
        const triggers = doc.on;
        if (typeof triggers === 'string') return triggers;
        if (Array.isArray(triggers)) return triggers[0] || 'push';
        if (triggers && typeof triggers === 'object') {
            const names = Object.keys(triggers);
            return names.find((n) => n.startsWith('pull_request')) || names[0] || 'push';
        }
        return 'push';
    }

    _createSandbox() {
        const cfg = this.options.config;
        // With no config file the defaults still apply. This used to fall back
        // to a hand-written short list, so a project without `.aeroci.json` got
        // a different sandbox from one with it: `.env`, `dist`, `build`,
        // `.venv` and `coverage` were copied in, and the `mode: 'link'` warning
        // counted the wrong number of paths. One list, not three.
        return Sandbox.create(this.cwd, {
            exclude: cfg ? cfg.sandboxExcludes : [...DEFAULTS.sandbox.exclude],
            excludePaths: [cacheRoot()],
            keep: this.options.keepSandbox,
            mode: cfg ? cfg.sandbox.mode : DEFAULTS.sandbox.mode
        });
    }

    // ── Job instance ─────────────────────────────────────────────────────────

    async _runJobInstance({ jobId, job, ctx }) {
        const started = Date.now();
        const steps = job.steps || [];
        const stepResults = [];
        let status = STATUS.SUCCESS;
        // Not a copy: steps publish env back into ctx.jobEnv and the next step
        // must see it, exactly like GITHUB_ENV inside one job.
        const jobEnv = ctx.jobEnv;

        ctx.files.resetJobScoped();
        ctx.steps = {};
        ctx.contexts.steps = ctx.steps;
        ctx.state = {};

        const jobTimeoutMinutes = Number(job['timeout-minutes']) > 0 ? Number(job['timeout-minutes']) : 360;

        for (const [index, step] of steps.entries()) {
            // Once a step fails, the rest only runs with an explicit condition.
            if (FAILED_STATUSES.has(status) && !this._conditionPasses(step.if, ctx, 'stepLevel', `job "${jobId}" step ${index + 1}`)) {
                const skipped = this._skipRecord(jobId, step, index, steps.length, 'a previous step failed');
                stepResults.push(skipped);
                continue;
            }

            const record = await this._runStep({ jobId, step, index, total: steps.length, ctx, jobTimeoutMinutes, jobEnv });
            stepResults.push(record);

            if (FAILED_STATUSES.has(record.status)) {
                if (this._tolerates(step['continue-on-error'])) {
                    record.tolerated = true;
                    record.conclusion = STATUS.SUCCESS;
                    Logger.note(`   ↳ failure tolerated (continue-on-error)`);
                } else {
                    status = record.status;
                    break;
                }
            }
        }

        // Remaining steps after a hard failure are recorded as skipped.
        if (FAILED_STATUSES.has(status)) {
            for (let i = stepResults.length; i < steps.length; i++) {
                stepResults.push(this._skipRecord(jobId, steps[i], i, steps.length, 'a previous step failed'));
            }
        }

        const outputs = {};
        for (const [name, expr] of Object.entries(job.outputs || {})) {
            outputs[name] = expressions.evaluateTemplate(String(expr), ctx);
        }

        return { jobId, status, steps: stepResults, outputs, durationMs: Date.now() - started };
    }

    _tolerates(value) {
        if (value === true) return true;
        if (typeof value === 'string' && value !== '' && value !== 'false') return true;
        if (value && typeof value === 'object') return true; // matrix expression → tolerated
        return false;
    }

    _skipRecord(jobId, step, index, total, reason) {
        const name = step.name || step.uses || (step.run ? String(step.run).trim().split('\n')[0] : `Step ${index + 1}`);
        return {
            jobId, name, id: step.id || null, index: index + 1, total,
            status: STATUS.SKIPPED, reason, durationMs: 0, exitCode: null,
            outputs: {}, warnings: [], secretsUsed: [], log: []
        };
    }

    // ── Step execution ───────────────────────────────────────────────────────

    async _runStep({ jobId, step, index, total, ctx, jobTimeoutMinutes, jobEnv }) {
        const rawName = step.name || step.uses || (step.run ? String(step.run).trim().split('\n')[0] : `Step ${index + 1}`);
        const name = expressions.evaluateTemplate(String(rawName), ctx);
        const record = {
            jobId, name, id: step.id || null, index: index + 1, total,
            status: STATUS.SUCCESS, conclusion: null, durationMs: 0, exitCode: null,
            uses: step.uses || null, script: step.run || null, outputs: {},
            shell: null, warnings: [], errors: [], secretsUsed: [], log: []
        };

        Logger.step(`${colors.cyan}Step ${index + 1}/${total}:${colors.reset} ${colors.bright(name)}${colors.reset}` +
            (step.id ? colors.gray(` · id ${step.id}`) : ''));
        this.onStepStart?.(record);

        const started = Date.now();
        let resolved;
        try {
            resolved = this._resolveStep(step, ctx, record);
        } catch (err) {
            record.status = STATUS.FAILURE;
            record.error = err.message;
            record.durationMs = 0;
            Logger.error(`   ✖ ${err.message}`);
            this.onStepEnd?.(record);
            return record;
        }

        if (resolved.__skip) {
            record.status = STATUS.SKIPPED;
            record.reason = `if: ${step.if} evaluated to false`;
            Logger.note(`   ⏭ skipped — if: ${step.if}`);
            this.onStepEnd?.(record);
            return record;
        }

        try {
            if (resolved.uses) {
                await this._runActionStep({ step: resolved, ctx, record, jobEnv });
            } else if (resolved.run !== undefined && resolved.run !== null) {
                await this._runShellStep({ step: resolved, ctx, record, jobEnv, jobTimeoutMinutes });
            } else {
                record.warnings.push('step declares neither "run" nor "uses"');
                Logger.note('   ↳ nothing to execute');
            }
        } catch (err) {
            record.status = STATUS.FAILURE;
            record.error = err.message;
            Logger.error(`   ✖ ${err.message}`);
        }

        record.durationMs = Date.now() - started;
        record.conclusion = record.tolerated ? STATUS.SUCCESS : record.status;
        // Where the step actually ran, so `aeroci debug` can put you back there.
        record.cwd = resolved.cwd || ctx.workspace;

        if (step.id) {
            ctx.steps[step.id] = {
                outputs: { ...(ctx.steps[step.id]?.outputs || {}), ...record.outputs },
                conclusion: record.conclusion,
                outcome: record.status === STATUS.SKIPPED ? 'skipped' : 'success'
            };
        }

        this._logStepOutcome(record);
        this.onStepEnd?.(record);
        return record;
    }

    _logStepOutcome(record) {
        if (record.status === STATUS.SUCCESS) {
            const mark = record.notSimulated ? colors.yellow('✔') : colors.green('✔');
            const outputKeys = Object.keys(record.outputs || {});
            const detail = outputKeys.length
                ? `outputs ${outputKeys.map((k) => `${k}=${truncate(String(record.outputs[k]), 40)}`).join(' ')}`
                : `done in ${record.durationMs}ms`;
            Logger.note(`   ${mark} ${detail}`);
        } else if (record.status === STATUS.FAILURE) {
            Logger.error(`   ✖ step failed${record.exitCode !== null ? ` (exit code ${record.exitCode})` : ''}`);
        }
    }

    /** Evaluate the step's own `if:` and resolve templates in run/uses/with/env. */
    _resolveStep(step, ctx, record) {
        const out = { ...step, __skip: false };

        if (step.if !== undefined && step.if !== null && String(step.if).trim() !== '') {
            const passes = this._conditionPasses(step.if, ctx, 'stepLevel',
                `job "${record.jobId}" step "${step.name || record.index}"`);
            if (!passes) out.__skip = true;
        }

        const secretsUsed = new Set();

        if (step.uses) out.uses = expressions.evaluateTemplate(String(step.uses), ctx);
        if (step.run !== undefined && step.run !== null) {
            out.run = expressions.evaluateTemplate(String(step.run), ctx);
        }

        if (step.with && typeof step.with === 'object') {
            out.with = {};
            for (const [k, v] of Object.entries(step.with)) {
                const value = expressions.evaluateTemplate(String(v), ctx);
                out.with[k] = value;
                collectSecretsInto(secretsUsed, value);
            }
        }

        if (step.env && typeof step.env === 'object') {
            out.env = {};
            for (const [k, v] of Object.entries(step.env)) {
                const value = expressions.evaluateTemplate(String(v), ctx);
                out.env[k] = value;
                collectSecretsInto(secretsUsed, value);
                ctx.contexts.env[k] = value;
            }
        }

        if (step.run) {
            for (const n of collectSecrets(String(step.run))) secretsUsed.add(n);
        }
        record.secretsUsed = [...secretsUsed];
        return out;
    }

    // ── `uses:` steps ────────────────────────────────────────────────────────

    async _runActionStep({ step, ctx, record, jobEnv }) {
        const uses = step.uses;
        Logger.note(`   ⚡ ${colors.yellow(uses)}${colors.reset}`);

        if (uses.startsWith('./') || uses.startsWith('../') || path.isAbsolute(uses)) {
            await this._runLocalAction({ step, ctx, record, jobEnv });
            return;
        }

        const actionName = uses.split('@')[0];
        for (const [needle, invoke] of MATCHERS) {
            if (actionName === needle || actionName.startsWith(`${needle}/`)) {
                const result = (await invoke(this.simulators, step, ctx)) || {};
                this._applyActionResult(result, record);
                return;
            }
        }

        this._applyActionResult(this.simulators.generic(step, uses), record);
    }

    _applyActionResult(result, record) {
        record.outputs = result.outputs || {};
        record.notSimulated = !!result.notSimulated;
        if (!result.success) {
            record.status = STATUS.FAILURE;
            if (record.exitCode === null) record.exitCode = 1;
        }
        for (const message of result.messages || []) {
            const text = String(message);
            if (text.startsWith('⚠')) record.warnings.push(text);
            if (text.startsWith('✖')) record.errors.push(text);
            const isProblem = text.startsWith('⚠') || text.startsWith('✖');
            Logger.note(`   ${isProblem ? colors.yellow(text) : colors.gray(text)}`);
        }
    }

    async _runLocalAction({ step, ctx, record, jobEnv }) {
        const dir = path.resolve(ctx.workspace, step.uses);
        const action = parseLocalAction(dir);

        if (!action.valid) {
            record.status = STATUS.FAILURE;
            record.notSimulated = true;
            record.error = action.error;
            record.exitCode = 1;
            Logger.error(`   ✖ local action: ${action.error}`);
            return;
        }

        // Defaults declared in action.yml, overridden by the step's `with:`.
        const declaredInputs = {};
        for (const [name, def] of Object.entries(action.inputs || {})) {
            declaredInputs[name] = (def && typeof def === 'object' && 'default' in def) ? def.default : '';
        }
        const inputs = { ...declaredInputs, ...(step.with || {}) };
        const sharedFiles = ctx.files;
        const actionCtx = {
            ...ctx,
            contexts: {
                ...ctx.contexts,
                inputs,
                files: sharedFiles,
                github: {
                    ...ctx.contexts.github,
                    action: action.name,
                    action_path: dir,
                    action_ref: '',
                    action_repository: ctx.contexts.github.repository
                }
            },
            github: {
                ...ctx.contexts.github,
                action: action.name,
                action_path: dir
            },
            // Composite sub-steps publish their outputs into `steps.<id>`.
            steps: {},
            files: sharedFiles,
            inputs
        };
        actionCtx.contexts.steps = actionCtx.steps;

        const using = action.runs.using;

        if (using === 'composite') {
            const subSteps = action.runs.steps || [];
            Logger.note(`   ⚡ composite ${colors.gray}${action.name}${colors.reset} ${colors.gray}(${subSteps.length} inline step(s))${colors.reset}`);
            const nested = [];
            for (const [i, sub] of subSteps.entries()) {
                const subStep = { ...sub, name: sub.name || compositeStepName(action.name, sub, i) };
                const subRecord = await this._runStep({
                    jobId: record.jobId,
                    step: subStep,
                    index: i, total: subSteps.length, ctx: actionCtx,
                    jobTimeoutMinutes: this.defaultTimeoutMinutes, jobEnv
                });
                nested.push(subRecord);
                if (FAILED_STATUSES.has(subRecord.status)) {
                    record.status = subRecord.status;
                    record.exitCode = subRecord.exitCode;
                    record.steps = nested;
                    Logger.note(`   ↳ composite action aborted`);
                    return;
                }
            }
            record.steps = nested;
            record.outputs = this._compositeOutputs(action, actionCtx);
            return;
        }

        if (String(using || '').startsWith('node')) {
            if (!entryExists(action)) {
                record.status = STATUS.FAILURE;
                record.notSimulated = true;
                record.exitCode = 1;
                record.error = `action "${action.name}" has no ${using} bundle at "${action.runs.main}" — build it first`;
                Logger.error(`   ✖ ${record.error}`);
                return;
            }
            Logger.note(`   ⚡ node action ${colors.gray}${action.name}${colors.reset} ${colors.gray}→ node ${action.runs.main}${colors.reset}`);
            const env = this._buildStepEnv({ step, ctx, jobEnv, actionCtx, actionDir: dir });
            const res = await run(process.execPath, [path.join(dir, action.runs.main)], {
                cwd: ctx.workspace, env, timeoutMs: this.defaultTimeoutMinutes * 60 * 1000
            });
            record.exitCode = res.code;
            this._consumeOutput(res, ctx, record);
            if (res.timedOut) record.status = STATUS.TIMED_OUT;
            else record.status = res.code === 0 ? STATUS.SUCCESS : STATUS.FAILURE;
            return;
        }

        if (using === 'docker') {
            record.notSimulated = true;
            Logger.note(`   ⚠ docker action ${colors.gray}${action.name}${colors.reset} is not simulated (no container runtime)`);
            return;
        }

        record.status = STATUS.FAILURE;
        record.notSimulated = true;
        record.exitCode = 1;
        record.error = `unsupported action runtime "using: ${using}"`;
        Logger.error(`   ✖ ${record.error}`);
    }

    _compositeOutputs(action, ctx) {
        const outputs = {};
        for (const [name, def] of Object.entries(action.outputs || {})) {
            const raw = typeof def === 'string' ? def : (def && def.value);
            if (!raw) continue;
            outputs[name] = expressions.evaluateTemplate(String(raw), ctx);
        }
        return outputs;
    }

    // ── `run:` steps ──────────────────────────────────────────────────────────

    async _runShellStep({ step, ctx, record, jobEnv, jobTimeoutMinutes }) {
        const script = String(step.run).replace(/\r\n/g, '\n');
        const shell = resolveShell(step.shell ?? this.options.shell, ctx.runner.os);

        record.shell = shell.keyword;
        record.script = script;

        if (shell.unknown) {
            record.status = STATUS.FAILURE;
            record.exitCode = 1;
            record.error = `unknown shell keyword "${shell.keyword}"`;
            Logger.error(`   ✖ unknown shell keyword "${shell.keyword}"`);
            return;
        }
        if (!shell.available) {
            record.status = STATUS.FAILURE;
            record.exitCode = 127;
            record.error = `shell "${shell.keyword}" is not installed on this machine`;
            Logger.error(`   ✖ shell "${shell.keyword}" is not installed locally`);
            return;
        }

        const workingDir = step['working-directory']
            ? path.resolve(ctx.workspace, expressions.evaluateTemplate(String(step['working-directory']), ctx))
            : ctx.workspace;

        if (!fs.existsSync(workingDir)) {
            record.status = STATUS.FAILURE;
            record.exitCode = 1;
            record.error = `working-directory does not exist: ${step['working-directory']}`;
            Logger.error(`   ✖ ${record.error}`);
            return;
        }

        const scriptFile = path.join(ctx.runner.temp, `step-${record.index}-${sanitize(record.name)}.${shellExt(shell.keyword)}`);
        fs.writeFileSync(scriptFile, script.endsWith('\n') ? script : `${script}\n`, 'utf8');
        record.scriptFile = scriptFile;

        if (this.dryRun) {
            record.dryRun = true;
            Logger.note(`   ${colors.gray}(dry run — not executed)${colors.reset}`);
            this._echoScript(script, shell);
            return;
        }

        const env = this._buildStepEnv({ step, ctx, jobEnv });

        Logger.note(`   ${colors.gray}$${colors.reset} ${colors.gray}${firstLine(script)}${colors.reset}` +
            `${script.includes('\n') ? colors.gray(`  (${script.trim().split('\n').length} lines, ${shell.label})${colors.reset}`) : ''}`);

        const stepMinutes = Number(step['timeout-minutes']) > 0 ? Number(step['timeout-minutes']) : this.defaultTimeoutMinutes;
        const timeoutMs = Math.min(stepMinutes, jobTimeoutMinutes) * 60 * 1000;

        const args = shell.args.map((arg) => arg.replace(/'\{0\}'/g, scriptFile).replace(/\{0\}/g, scriptFile));
        const res = await run(shell.command, args, { cwd: workingDir, env, timeoutMs });

        this._consumeOutput(res, ctx, record);

        if (res.spawnError) {
            record.status = STATUS.FAILURE;
            record.error = res.spawnError.message;
            return;
        }
        if (res.timedOut) {
            record.status = STATUS.TIMED_OUT;
            record.exitCode = null;
            Logger.error(`   ✖ timed out after ${Math.round(timeoutMs / 60000)}min — whole process tree killed`);
            return;
        }
        if (res.code === null && res.signal) {
            record.status = STATUS.FAILURE;
            record.exitCode = null;
            record.signal = res.signal;
            Logger.error(`   ✖ terminated by signal ${res.signal}`);
            return;
        }

        record.exitCode = res.code;
        record.status = res.code === 0 ? STATUS.SUCCESS : STATUS.FAILURE;
    }

    _echoScript(script, shell) {
        const lines = script.trim().split('\n');
        Logger.note(`   ${colors.gray}${shell.label} script (${lines.length} line(s)):${colors.reset}`);
        for (const line of lines.slice(0, this.maxOutputLines)) {
            Logger.note(`     ${colors.gray}|${colors.reset} ${colors.gray(line)}${colors.reset}`);
        }
    }

    _buildStepEnv({ step, ctx, jobEnv, actionCtx, actionDir }) {
        const github = (actionCtx || ctx).github;
        const runner = ctx.runner;
        const files = ctx.files;

        const env = {
            ...(this.inheritEnv ? process.env : {}),
            ...this.envOverrides,
            ...jobEnv,
            ...(step.env || {}),

            CI: 'true',
            GITHUB_ACTIONS: 'true',
            GITHUB_WORKFLOW: github.workflow,
            GITHUB_RUN_ID: github.run_id,
            GITHUB_RUN_NUMBER: github.run_number,
            GITHUB_RUN_ATTEMPT: github.run_attempt,
            GITHUB_JOB: github.job,
            GITHUB_ACTION: step.uses ? String(step.uses).split('@')[0] : '',
            GITHUB_ACTION_PATH: actionDir || '',
            GITHUB_ACTOR: github.actor,
            GITHUB_TRIGGERING_ACTOR: github.triggering_actor,
            GITHUB_REPOSITORY: github.repository,
            GITHUB_REPOSITORY_OWNER: github.repository_owner,
            GITHUB_EVENT_NAME: github.event_name,
            GITHUB_EVENT_PATH: path.join(ctx.workspace, '.aeroci', 'event.json'),
            GITHUB_SHA: github.sha,
            GITHUB_REF: github.ref,
            GITHUB_REF_NAME: github.ref_name,
            GITHUB_REF_PROTECTED: String(github.ref_protected),
            GITHUB_REF_TYPE: github.ref_type,
            GITHUB_WORKSPACE: ctx.workspace,
            GITHUB_SERVER_URL: github.server_url,
            GITHUB_API_URL: github.api_url,
            GITHUB_GRAPHQL_URL: github.graphql_url,
            GITHUB_ENV: files.env.path,
            GITHUB_OUTPUT: files.output.path,
            GITHUB_PATH: files.path.path,
            GITHUB_STATE: files.state.path,
            GITHUB_STEP_SUMMARY: files.summary.path,
            RUNNER_OS: runner.os,
            RUNNER_ARCH: runner.arch,
            RUNNER_NAME: runner.name,
            RUNNER_TEMP: runner.temp,
            RUNNER_TOOL_CACHE: runner.tool_cache,
            RUNNER_DEBUG: runner.debug,
            RUNNER_ENVIRONMENT: runner.environment,
            AGENT_TOOLSDIRECTORY: runner.tool_cache
        };

        if (step.shell) env.SHELL = shellBinaryFor(step.shell);
        return env;
    }

    /** Process stdout/stderr: workflow commands, outputs, env, path, state. */
    _consumeOutput(res, ctx, record) {
        const files = ctx.files;

        for (const [stream, raw] of [['stdout', res.stdout], ['stderr', res.stderr]]) {
            if (!raw) continue;
            const { commands, lines } = parseWorkflowCommands(raw, { debug: this.debug });

            for (const cmd of commands) {
                switch (cmd.command) {
                    case 'error':
                        record.errors.push(cmd.message);
                        Logger.error(`   ✖ ${cmd.message}`);
                        break;
                    case 'warning':
                        record.warnings.push(cmd.message);
                        Logger.warn(`   ⚠ ${cmd.message}`);
                        break;
                    case 'notice':
                        Logger.note(`   ${colors.cyan}ℹ${colors.reset} ${cmd.message}`);
                        break;
                    case 'debug':
                        Logger.note(`   ${colors.gray}debug: ${cmd.message}${colors.reset}`);
                        break;
                    case 'group':
                        Logger.note(`   ${colors.magenta}▸ ${cmd.message}${colors.reset}`);
                        break;
                    case 'endgroup':
                    case 'echo':
                    case 'stop-commands':
                        break;
                    case 'add-mask':
                        if (cmd.message) ctx.masks.push(cmd.message);
                        break;
                    case 'save-state':
                    case 'set-output':
                    case 'set-env': {
                        // Deprecated commands still emitted by older actions.
                        const name = cmd.properties.name;
                        if (!name) break;
                        if (cmd.command === 'save-state') ctx.state[name] = cmd.message;
                        else if (cmd.command === 'set-output') record.outputs[name] = cmd.message;
                        else {
                            ctx.contexts.env[name] = cmd.message;
                            ctx.jobEnv[name] = cmd.message;
                        }
                        record.warnings.push(`deprecated "::${cmd.command}::" — use $GITHUB_OUTPUT / $GITHUB_ENV`);
                        break;
                    }
                    default:
                        Logger.note(`   ${colors.gray}${cmd.raw}${colors.reset}`);
                        break;
                }
            }

            for (const line of lines) {
                if (!line.trim()) continue;
                this._appendLog(record, stream, line, ctx.masks);
            }
        }

        // File-based outputs / env / path / state
        const envUpdates = files.envVars();
        for (const [k, v] of Object.entries(envUpdates)) {
            ctx.contexts.env[k] = v;
            ctx.jobEnv[k] = v;
            this._appendLog(record, 'env', `GITHUB_ENV ${k}=${truncate(String(v), 60)}`, ctx.masks);
        }

        for (const [k, v] of Object.entries(files.stepOutputs())) {
            record.outputs[k] = v;
            this._appendLog(record, 'output', `GITHUB_OUTPUT ${k}=${truncate(String(v), 60)}`, ctx.masks);
        }

        for (const added of Object.values(files.addedPaths())) {
            if (added) ctx.jobEnv.PATH = `${added}${path.delimiter}${ctx.jobEnv.PATH || ''}`;
        }

        Object.assign(ctx.state, files.savedState());

        if (res.truncated) {
            record.warnings.push('output truncated');
            Logger.warn('   (output truncated)');
        }
    }

    _appendLog(record, stream, line, masks) {
        if (record.log.length >= this.maxOutputLines) return;
        // Apply every registered mask, exactly like the runner does.
        let masked = line;
        for (const secret of masks || []) {
            if (typeof secret === 'string' && secret.length > 2) {
                masked = masked.split(secret).join('***');
            }
        }
        record.log.push({ stream, line: masked });
        const pipe = stream === 'stderr' ? colors.red('│') : colors.cyan('│');
        const text = (stream === 'env' || stream === 'output') ? colors.gray(masked) : masked;
        Logger.note(`     ${pipe} ${text}`);
    }
}

function workspaceOf(ctx, opts = {}) {
    return opts && opts.cwd ? opts.cwd : ctx.workspace;
}

/** Readable label for an inlined composite sub-step. */
function compositeStepName(actionName, sub, index) {
    if (sub.uses) return `${actionName}: ${sub.uses}`;
    if (sub.run) {
        const first = String(sub.run).trim().split('\n')[0];
        return `${actionName}: ${truncate(first, 48)}`;
    }
    return `${actionName} step ${index + 1}`;
}

/** Secret values that the runner would pre-mask because they are repository secrets. */
function registeredSecretValues(secrets) {
    return Object.values(secrets || {})
        .filter((v) => typeof v === 'string' && v.length > 2);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectSecrets(text) {
    const names = new Set();
    collectSecretsInto(names, text);
    return [...names];
}

function collectSecretsInto(set, text) {
    const re = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) set.add(m[1]);
}

function shellExt(keyword) {
    if (keyword === 'python' || keyword === 'python3') return 'py';
    if (keyword === 'pwsh' || keyword === 'powershell') return 'ps1';
    return 'sh';
}

function shellBinaryFor(declared) {
    const value = String(declared);
    if (value.includes('{0}')) return value.split(/\s+/)[0];
    if (value === 'sh') return 'sh';
    if (value === 'python' || value === 'python3') return 'python3';
    return 'bash';
}

function sanitize(name) {
    return String(name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'step';
}

function firstLine(script) {
    return truncate(String(script).trim().split('\n')[0] || '', 72);
}

function truncate(str, max) {
    const s = String(str);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function validateWorkflow(doc) {
    const problems = [];
    if (!doc.jobs || typeof doc.jobs !== 'object' || Object.keys(doc.jobs).length === 0) {
        problems.push('no "jobs" defined');
    }
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
        if (!job || typeof job !== 'object') { problems.push(`job "${jobId}" is not a mapping`); continue; }
        if (job.uses && !job['runs-on']) continue; // reusable workflow call
        if (!job['runs-on']) problems.push(`job "${jobId}" is missing "runs-on"`);
        if (job.steps !== undefined && !Array.isArray(job.steps)) {
            problems.push(`job "${jobId}" has a non-list "steps"`);
        }
        (Array.isArray(job.steps) ? job.steps : []).forEach((step, i) => {
            if (!step || typeof step !== 'object') {
                problems.push(`job "${jobId}" step ${i + 1} is not a mapping`);
                return;
            }
            if (step.run === undefined && step.uses === undefined) {
                problems.push(`job "${jobId}" step ${i + 1} has neither "run" nor "uses"`);
            }
            if (step.run !== undefined && typeof step.run === 'boolean') {
                problems.push(`job "${jobId}" step ${i + 1}: "run" was parsed as a boolean — quote it to make it a command`);
            }
            if (step.run !== undefined && typeof step.run !== 'string'
                && typeof step.run !== 'number' && typeof step.run !== 'boolean') {
                problems.push(`job "${jobId}" step ${i + 1}: "run" must be a string, got ${Array.isArray(step.run) ? 'a list' : typeof step.run}`);
            }
        });
    }
    return problems;
}

module.exports = { Engine, STATUS, FAILED_STATUSES, validateWorkflow, CONTEXTS_BY_SCOPE, RUNNER_OS };
