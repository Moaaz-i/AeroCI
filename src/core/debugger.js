/**
 * `aeroci debug` — drop into a shell that matches a failed step.
 *
 * The point is to be able to run the failing command again by hand and get the
 * same result, so this rebuilds the *conditions* rather than the process:
 *
 *   • a real isolated sandbox (the run's own copy is already deleted by now)
 *   • the same `GITHUB_*` context, derived from your local git state
 *   • `GITHUB_ENV` / `GITHUB_OUTPUT` / `GITHUB_PATH` / `GITHUB_STATE` /
 *     `GITHUB_STEP_SUMMARY` pointed at real files, so the workflow commands work
 *   • `.env` loaded through the same parser the engine uses
 *
 * What it is not: the run itself. Outputs written here are not collected, and a
 * secret is not registered as a log mask the way the runner does it, so treat
 * anything you `cat` here as if it were printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Logger, colors } = require('../utils/logger');
const { Sandbox } = require('./sandbox');
const { loadEnvFile } = require('./secrets');
const { readGitState, buildEventPayload, buildGithubContext } = require('./event');
const { loadConfig } = require('./config');
const { cacheRoot } = require('./toolchain');
const { VERSION } = require('../version');

/** GitHub's own default shell per platform. */
function defaultShell() {
    if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
    if (process.platform === 'darwin') return { command: process.env.SHELL || '/bin/zsh', args: ['-i'] };
    return { command: process.env.SHELL || '/bin/bash', args: ['-i'] };
}

class Debugger {
    /**
     * @param {object} options
     * @param {object} options.step    the step record from the engine
     * @param {string} options.cwd     the project root
     * @param {string} options.event   event name to simulate
     * @param {boolean} options.keep   leave the sandbox on disk afterwards
     * @returns {Promise<number>} exit code
     */
    static async start(options = {}) {
        const { step = null } = options;
        const projectRoot = path.resolve(options.cwd || process.cwd());
        const eventName = options.event || 'push';

        // ── the sandbox ─────────────────────────────────────────────────────
        // `keep` follows the flag. It used to be hard-coded to `true` so the
        // sandbox would survive the session — but `dispose()` honours that same
        // flag, so every `aeroci debug` leaked a full copy of the project into
        // the temp directory and `--keep` controlled nothing.
        //
        // The exclusion list comes from the same place the engine reads it, and
        // that is the point of the whole command: a debug shell with your
        // `node_modules` and your `.env` in it is a *different* environment from
        // the one the failing step had, so a command that worked here and failed
        // there sent you looking for the wrong reason — and it handed a `cat`
        // every secret in the project.
        const config = options.config || loadConfig(projectRoot);
        let sandbox = null;
        try {
            sandbox = Sandbox.create(projectRoot, {
                exclude: config.sandboxExcludes,
                excludePaths: [cacheRoot()],
                mode: config.sandbox.mode,
                keep: !!options.keep
            });
            if (config.sandbox.mode === 'link') {
                Logger.warn(`Sandbox mode "link" — the excluded paths here point at your real project, `
                    + `exactly as they did in the run.`);
            }
        } catch (err) {
            Logger.warn(`Could not create a sandbox (${err.message}) — continuing in ${projectRoot}.`);
        }
        const workspace = sandbox ? sandbox.dir : projectRoot;

        // ── the environment ────────────────────────────────────────────────
        // The context comes from the same builders the engine uses, so what
        // you see here is what the step saw — not a second, drifting copy.
        const gitState = readGitState(projectRoot);
        const payload = buildEventPayload(eventName, gitState);
        const github = buildGithubContext(gitState, eventName, payload, {
            workflowFile: step ? step.workflowFile || '.github/workflows/ci.yml' : '',
            workflowName: step ? step.workflowName || 'debug' : 'debug',
            runId: '1',
            runNumber: '1',
            workspace,
            jobId: step ? step.jobId : ''
        });

        const envFile = options.envFile || path.join(projectRoot, '.env');
        const envValues = loadEnvFile(envFile).values;
        // A runner does NOT put secrets in a step's environment. They are only
        // reachable through the `secrets` context, or an `env:` block that
        // names one. Injecting .env here made the shell more permissive than
        // the run it is meant to reproduce, so a step that failed for want of
        // $TOKEN succeeded in the debugger and sent you looking for the wrong
        // reason. `options.exposeEnv` opts in, and says what it costs.
        const exposeEnv = !!options.exposeEnv;

        // The file commands a step uses get real files, so testing them works.
        const filesDir = path.join(workspace, '.aeroci', 'debug-files');
        fs.mkdirSync(filesDir, { recursive: true });
        const files = {};
        for (const name of ['env', 'output', 'path', 'state', 'summary']) {
            files[name] = path.join(filesDir, name);
            fs.writeFileSync(files[name], '', 'utf8');
        }
        const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-debug-'));
        // The real tool cache, not a folder inside the sandbox. A cache that dies
        // with the sandbox is a cache nobody can use: this used to point at
        // <workspace>/.aeroci/tool-cache, a throwaway copy, so anything a debug
        // session put there was gone before the next run.
        const toolCache = cacheRoot();
        fs.mkdirSync(toolCache, { recursive: true });

        const env = {
            ...process.env,
            ...(exposeEnv ? envValues : {}),
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            AEROCI_DEBUG: '1',
            AEROCI_VERSION: VERSION,
            GITHUB_WORKSPACE: workspace,
            GITHUB_ACTION: '',
            GITHUB_ACTION_PATH: '',
            GITHUB_ACTOR: github.actor,
            GITHUB_TRIGGERING_ACTOR: github.triggering_actor,
            GITHUB_REPOSITORY: github.repository,
            GITHUB_REPOSITORY_OWNER: github.repository_owner,
            GITHUB_EVENT_NAME: github.event_name,
            GITHUB_EVENT_PATH: path.join(workspace, '.aeroci', 'event.json'),
            GITHUB_SHA: github.sha,
            GITHUB_REF: github.ref,
            GITHUB_REF_NAME: github.ref_name,
            GITHUB_REF_PROTECTED: String(github.ref_protected),
            GITHUB_REF_TYPE: github.ref_type,
            GITHUB_SERVER_URL: github.server_url,
            GITHUB_API_URL: github.api_url,
            GITHUB_GRAPHQL_URL: github.graphql_url,
            GITHUB_ENV: files.env,
            GITHUB_OUTPUT: files.output,
            GITHUB_PATH: files.path,
            GITHUB_STATE: files.state,
            GITHUB_STEP_SUMMARY: files.summary,
            RUNNER_OS: process.platform,
            RUNNER_ARCH: process.arch,
            RUNNER_NAME: 'AeroCI',
            RUNNER_ENVIRONMENT: 'aerocid',
            RUNNER_TEMP: runnerTemp,
            RUNNER_TOOL_CACHE: toolCache,
            RUNNER_DEBUG: '1',
            AGENT_TOOLSDIRECTORY: toolCache
        };

        fs.writeFileSync(env.GITHUB_EVENT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

        // ── report ─────────────────────────────────────────────────────────
        Logger.emit('');
        Logger.banner();
        if (step) {
            Logger.error(`Reproducing the failure of ${colors.bright(`${step.jobId} › ${step.name}`)}`);
            if (step.script) {
                Logger.emit(colors.gray('  the command was:'));
                for (const line of String(step.script).trimEnd().split('\n')) {
                    Logger.emit(colors.gray(`    ${line}`));
                }
            }
            if (step.exitCode !== null && step.exitCode !== undefined) {
                Logger.metric('Exit code', String(step.exitCode));
            }
            for (const e of step.errors || []) Logger.error(String(e));
        } else {
            Logger.info('No failing step given — starting a plain debug shell.');
        }
        Logger.emit('');
        Logger.metric('Workspace', workspace + (sandbox ? colors.gray('  (isolated copy)') : colors.gray('  (NOT isolated)')));
        Logger.metric('Event', env.GITHUB_EVENT_NAME);
        if (gitState.isRepo) {
            Logger.metric('Commit', `${env.GITHUB_SHA.slice(0, 8)} on ${env.GITHUB_REF_NAME}`
                + (gitState.dirty ? colors.yellow('  (uncommitted changes)') : ''));
        } else {
            // Printing `00000000 on main` reads like a real commit and sends
            // somebody hunting for a commit that does not exist.
            Logger.metric('Commit', colors.yellow('not a git repository — GITHUB_SHA is the all-zero placeholder'));
        }
        Logger.metric('.env', `${Object.keys(envValues).length} value(s) from ${path.basename(envFile)}`
            + (exposeEnv
                ? colors.yellow('  (exported into this shell — a runner does not do this)')
                : colors.gray('  (not exported — a runner only exposes them as ${{ secrets.NAME }})')));
        if (!sandbox) {
            Logger.warn('This is your real working tree. Anything you run here edits your files.');
        }
        Logger.note('  The file commands work: GITHUB_ENV, GITHUB_OUTPUT, GITHUB_PATH,');
        Logger.note('  GITHUB_STATE, GITHUB_STEP_SUMMARY and RUNNER_TEMP are real files.');
        Logger.emit(colors.gray('  Ctrl+D or `exit` to leave.' + colors.reset));

        // ── the shell ──────────────────────────────────────────────────────
        const shell = defaultShell();
        const code = await Debugger._spawnInteractive(shell, workspace, env);

        if (sandbox) {
            // `dispose` prints the "kept" notice itself when `keep` is set, so
            // there is one message about the sandbox rather than two.
            sandbox.dispose({ Logger, colors });
        }
        fs.rmSync(runnerTemp, { recursive: true, force: true });

        Logger.info('Left the debug shell.');
        return code;
    }

    /** spawnSync would block the event loop; the shell needs a real tty. */
    static _spawnInteractive(shell, cwd, env) {
        return new Promise((resolve) => {
            const child = spawn(shell.command, shell.args, { cwd, env, stdio: 'inherit' });
            const finish = (code) => resolve(code === null ? 0 : code);
            child.on('error', (err) => {
                Logger.error(`Could not start ${shell.command}: ${err.message}`);
                resolve(1);
            });
            child.on('exit', finish);
            // A closed stdin (piped input, CI) must not leave the child running.
            process.stdin.on('end', () => { if (!child.killed) child.kill(); });
        });
    }
}

module.exports = { Debugger };
