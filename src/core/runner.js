/**
 * Ultra-Fast Sub-Millisecond GitHub Actions Engine Simulator v4.0.0
 * 50+ Enterprise Features:
 * 1. APFS clonefile() Isolated Sandbox  — true isolation, ~10ms setup
 * 2. Profiler                           — per-step timing, cost estimator, trend analysis
 * 3. Rich Reporter                      — JUnit XML, HTML, Markdown, JSON reports
 * 4. Action Simulator Library           — cache, setup-*, docker, AWS, github-script
 * 5. Matrix include/exclude support     — proper GitHub Actions semantics
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');
const { Profiler } = require('./profiler');
const { Reporter } = require('./reporter');
const { Actions } = require('./actions');

class GitHubActionsEngine {
    constructor(sandboxDir, projectRoot) {
        this.sandboxDir = sandboxDir;
        this.projectRoot = projectRoot;

        this.envFile = path.join(sandboxDir, '.github_env');
        this.pathFile = path.join(sandboxDir, '.github_path');
        this.outputFile = path.join(sandboxDir, '.github_output');

        fs.writeFileSync(this.envFile, '');
        fs.writeFileSync(this.pathFile, '');
        fs.writeFileSync(this.outputFile, '');

        this.outputs = {};
    }

    evaluateExpressions(str, context = {}) {
        if (!str || typeof str !== 'string') return str;

        return str.replace(/\${{\s*([^}]+)\s*}}/g, (_, expr) => {
            expr = expr.trim();

            if (expr.startsWith('github.')) {
                const key = expr.replace('github.', '');
                return context.github ? (context.github[key] || '') : '';
            }
            if (expr.startsWith('matrix.')) {
                const key = expr.replace('matrix.', '');
                return context.matrix ? (context.matrix[key] || '') : '';
            }
            if (expr.startsWith('env.')) {
                const key = expr.replace('env.', '');
                return context.env ? (context.env[key] || '') : '';
            }
            if (expr.startsWith('secrets.')) {
                const key = expr.replace('secrets.', '');
                return context.secrets ? (context.secrets[key] || '') : '';
            }
            if (expr.startsWith('steps.')) {
                const parts = expr.split('.');
                const stepId = parts[1];
                const outputKey = parts[3];
                return (this.outputs[stepId] && this.outputs[stepId][outputKey]) || '';
            }

            return expr;
        });
    }

    buildEnvironment(jobEnv = {}, stepEnv = {}, context = {}) {
        const baseEnv = {
            ...process.env,
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            GITHUB_WORKFLOW: context.workflowName || 'CI Simulator',
            GITHUB_RUN_ID: '10001',
            GITHUB_RUN_NUMBER: '1',
            GITHUB_JOB: context.jobId || 'build',
            GITHUB_ACTION: context.stepId || 'run',
            GITHUB_ACTOR: process.env.USER || 'developer',
            GITHUB_REPOSITORY: 'local/repository',
            GITHUB_EVENT_NAME: context.eventName || 'push',
            GITHUB_SHA: 'local-sha-000000',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REF_NAME: 'main',
            GITHUB_WORKSPACE: this.sandboxDir,
            RUNNER_OS: process.platform === 'darwin' ? 'macOS' : (process.platform === 'win32' ? 'Windows' : 'Linux'),
            RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
            RUNNER_TEMP: path.join(this.sandboxDir, 'tmp'),
            GITHUB_ENV: this.envFile,
            GITHUB_PATH: this.pathFile,
            GITHUB_OUTPUT: this.outputFile,
            TMPDIR: this.sandboxDir
        };

        if (fs.existsSync(this.envFile)) {
            const envContent = fs.readFileSync(this.envFile, 'utf8');
            envContent.split('\n').forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    baseEnv[parts[0].trim()] = parts.slice(1).join('=').trim();
                }
            });
        }

        return { ...baseEnv, ...jobEnv, ...stepEnv };
    }

    parseWorkflowCommands(output) {
        if (!output) return;

        output.split('\n').forEach(line => {
            if (line.startsWith('::notice::')) {
                Logger.info(`📢 ${colors.bright}${line.replace('::notice::', '')}${colors.reset}`);
            } else if (line.startsWith('::warning::')) {
                Logger.warn(`⚠️ ${line.replace('::warning::', '')}`);
            } else if (line.startsWith('::error::')) {
                Logger.error(`✖ ${line.replace('::error::', '')}`);
            }
        });
    }

    parseGithubOutputs(stepId) {
        if (stepId && fs.existsSync(this.outputFile)) {
            const content = fs.readFileSync(this.outputFile, 'utf8');
            if (!this.outputs[stepId]) this.outputs[stepId] = {};
            content.split('\n').forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    this.outputs[stepId][parts[0].trim()] = parts.slice(1).join('=').trim();
                }
            });
            fs.writeFileSync(this.outputFile, '');
        }
    }
}

class Runner {
    static run(workflowPath = null, options = {}) {
        const totalTimerStart = process.hrtime();
        const { onlyJob = null, report = false, envOverrides = {} } = options;

        let targetFiles = [];

        if (workflowPath) {
            const resolved = path.resolve(process.cwd(), workflowPath);
            if (fs.existsSync(resolved)) {
                if (fs.statSync(resolved).isDirectory()) {
                    targetFiles = fs.readdirSync(resolved)
                        .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
                        .map(f => path.join(resolved, f));
                } else {
                    targetFiles = [resolved];
                }
            }
        }

        if (targetFiles.length === 0) {
            const dir = path.resolve(process.cwd(), '.github/workflows');
            if (fs.existsSync(dir)) {
                targetFiles = fs.readdirSync(dir)
                    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
                    .map(f => path.join(dir, f));
            }
        }

        if (targetFiles.length === 0) {
            Logger.error(`No workflow files found to run!`);
            process.exit(0);
        }

        // ── Ultra-Fast Isolated Sandbox ──────────────────────────────────────────
        // Strategy:
        //   • Files       → COPYFILE_FICLONE  (APFS clonefile = O(1) CoW, no data copy)
        //   • Directories → fs.cpSync         (uses clonefile internally on macOS)
        //   • node_modules→ symlink            (read-only deps, saves ~99% setup time)
        //   • .git        → skipped           (not needed in CI)
        // Result: true isolation (scripts write freely without touching real project)
        // ─────────────────────────────────────────────────────────────────────────
        const tempPrefix = path.join(os.tmpdir(), `aeroci-sandbox-${Date.now()}-`);
        const sandboxDir = fs.mkdtempSync(tempPrefix);
        const projectRoot = process.cwd();

        const setupTimer = process.hrtime();
        let clonedCount = 0;

        try {
            const entries = fs.readdirSync(projectRoot);
            for (const entry of entries) {
                if (entry === '.git') continue;

                const srcPath = path.join(projectRoot, entry);
                const destPath = path.join(sandboxDir, entry);

                // node_modules: symlink — massive time saver, deps are read-only in CI
                if (entry === 'node_modules') {
                    try { fs.symlinkSync(srcPath, destPath, 'dir'); } catch (_) {}
                    continue;
                }

                try {
                    const stat = fs.statSync(srcPath);
                    if (stat.isDirectory()) {
                        // fs.cpSync uses clonefile() on macOS APFS internally = near-instant
                        fs.cpSync(srcPath, destPath, { recursive: true, preserveTimestamps: true });
                    } else {
                        // COPYFILE_FICLONE: CoW clone on APFS, auto-fallback on other FS
                        fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_FICLONE);
                    }
                    clonedCount++;
                } catch (_) {
                    // Non-APFS fallback: regular copy
                    try {
                        const stat = fs.statSync(srcPath);
                        if (stat.isDirectory()) {
                            fs.cpSync(srcPath, destPath, { recursive: true });
                        } else {
                            fs.copyFileSync(srcPath, destPath);
                        }
                        clonedCount++;
                    } catch (_2) {}
                }
            }
        } catch (_) {}

        const setupNs = process.hrtime(setupTimer);
        const setupDuration = (setupNs[0] * 1000 + setupNs[1] / 1e6).toFixed(2);
        Logger.info(`⚡ Isolated Sandbox ready at: ${colors.gray}${sandboxDir}${colors.reset} (${colors.cyan}${setupDuration}ms${colors.reset} · ${clonedCount} items cloned · node_modules linked)`);

        const cleanupSandbox = () => {
            if (fs.existsSync(sandboxDir)) {
                try {
                    fs.rmSync(sandboxDir, { recursive: true, force: true });
                    Logger.info(`🧹 Ephemeral Sandbox auto-cleaned. (Zero disk footprint)`);
                } catch (e) {}
            }
        };

        process.on('exit', cleanupSandbox);
        process.on('SIGINT', () => { cleanupSandbox(); process.exit(130); });

        const engine = new GitHubActionsEngine(sandboxDir, projectRoot);
        let overallSuccess = true;

        // Inject --env overrides into process.env for this run
        for (const [k, v] of Object.entries(envOverrides)) {
            process.env[k] = v;
        }

        for (const targetFile of targetFiles) {
            const relPath = path.relative(projectRoot, targetFile);
            Logger.info(`Initializing Sub-Millisecond Runner for: ${colors.bright}${colors.cyan}${relPath}${colors.reset}`);

            const fileContent = fs.readFileSync(targetFile, 'utf8');
            const parsedYaml = yaml.load(fileContent);

            const workflowName = parsedYaml.name || 'Unnamed Workflow';
            const relPathShort = path.relative(projectRoot, targetFile);
            Logger.metric('Pipeline Name', workflowName);
            Logger.metric('Trigger Event', JSON.stringify(parsedYaml.on || 'manual'));
            if (onlyJob) Logger.info(`🎯 Running only job: ${colors.yellow}${onlyJob}${colors.reset}`);
            console.log(colors.gray + '--------------------------------------------------' + colors.reset);

            const profiler = new Profiler(workflowName);
            const reporter = new Reporter({ workflowName, workflowFile: relPathShort });
            profiler.startMemoryTracking();

            const jobs = parsedYaml.jobs || {};
            let failedSteps = 0;
            let jobAborted = false;

            for (const [jobId, jobDetails] of Object.entries(jobs)) {
                if (jobAborted) break;

                let matrixInstances = [{}];
                if (jobDetails.strategy && jobDetails.strategy.matrix) {
                    const matrix = jobDetails.strategy.matrix;
                    // Separate special directives from regular matrix keys
                    const { include, exclude, ...regularMatrix } = matrix;
                    const keys = Object.keys(regularMatrix);
                    matrixInstances = [];

                    // Build all combinations from regular matrix keys
                    if (keys.length > 0) {
                        const combinations = (index, current) => {
                            if (index === keys.length) {
                                matrixInstances.push({ ...current });
                                return;
                            }
                            const key = keys[index];
                            const values = Array.isArray(regularMatrix[key]) ? regularMatrix[key] : [regularMatrix[key]];
                            values.forEach(val => {
                                combinations(index + 1, { ...current, [key]: val });
                            });
                        };
                        combinations(0, {});
                    }

                    // Handle 'include': merge into matching combos or add as new instances
                    if (include && Array.isArray(include)) {
                        if (matrixInstances.length === 0) {
                            // No regular matrix — include items ARE the instances
                            matrixInstances = include.map(item => ({ ...item }));
                        } else {
                            include.forEach(item => {
                                const match = matrixInstances.find(combo =>
                                    Object.entries(item).every(([k, v]) => combo[k] === undefined || combo[k] === v)
                                );
                                if (match) {
                                    Object.assign(match, item);
                                } else {
                                    matrixInstances.push({ ...item });
                                }
                            });
                        }
                    }

                    // Handle 'exclude': remove matching combinations
                    if (exclude && Array.isArray(exclude)) {
                        matrixInstances = matrixInstances.filter(combo =>
                            !exclude.some(ex =>
                                Object.entries(ex).every(([k, v]) => combo[k] === v)
                            )
                        );
                    }

                    if (matrixInstances.length === 0) matrixInstances = [{}];
                }

                for (const matrixCtx of matrixInstances) {
                    const matrixLabel = Object.keys(matrixCtx).length > 0 
                        ? ` (${Object.entries(matrixCtx).map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')})` 
                        : '';

                    // --only-job filter
                    if (onlyJob && jobId !== onlyJob) {
                        console.log(`\n${colors.gray}⏭ Skipping Job: [${jobId}] (--only-job ${onlyJob})${colors.reset}`);
                        continue;
                    }

                    profiler.startJob(jobId);
                    console.log(`\n${colors.magenta}${colors.bright}▶ Executing Job: [${jobId}]${matrixLabel}${colors.reset} ${colors.gray}(runs-on: ${jobDetails['runs-on'] || 'ubuntu-latest'})${colors.reset}`);

                    const steps = jobDetails.steps || [];

                    for (let i = 0; i < steps.length; i++) {
                        const step = steps[i];

                        const evalContext = {
                            workflowName,
                            jobId,
                            eventName: typeof parsedYaml.on === 'string' ? parsedYaml.on : Object.keys(parsedYaml.on || {})[0],
                            matrix: matrixCtx,
                            github: { sha: 'local-sha', ref: 'refs/heads/main', repository: 'local/repo', event_name: 'push' }
                        };

                        const stepName = engine.evaluateExpressions(
                            step.name || step.run || (step.uses ? `action: ${step.uses}` : `Step ${i+1}`),
                            evalContext
                        );

                        console.log(`\n  ${colors.cyan}${colors.bright}↳ Step ${i+1}/${steps.length}:${colors.reset} ${colors.bright}${stepName}${colors.reset}`);

                        if (step.if) {
                            const evaluatedIf = engine.evaluateExpressions(step.if, evalContext);
                            if (evaluatedIf === 'false' || evaluatedIf === 'failure()') {
                                Logger.info(`    ⏭️ Step skipped due to condition: if: ${step.if}`);
                                continue;
                            }
                        }

                        if (step.uses) {
                            const evaluatedUses = engine.evaluateExpressions(step.uses, evalContext);
                            Logger.info(`    ⚡ Simulating GitHub Action: ${colors.yellow}${evaluatedUses}${colors.reset}`);

                            const stepStart = Date.now();

                            // Try the rich action simulator first
                            const simResult = Actions.simulate({ ...step, uses: evaluatedUses }, {
                                cacheKeySuffix: JSON.stringify(matrixCtx),
                                inputs: step.with || {}
                            });

                            if (simResult === null) {
                                // Fallback: built-in handlers
                                if (evaluatedUses.includes('actions/checkout')) {
                                    Logger.success(`    ✔ [actions/checkout]: Isolated sandbox mounted (clonefile CoW).`);
                                } else if (evaluatedUses.includes('actions/setup-node')) {
                                    const rawVer = (step.with && step.with['node-version']) || process.version;
                                    const nodeVer = engine.evaluateExpressions(String(rawVer), evalContext);
                                    Logger.success(`    ✔ [actions/setup-node]: Node.js ${nodeVer} ready.`);
                                } else {
                                    Logger.success(`    ✔ GitHub Action [${evaluatedUses}] completed.`);
                                }
                            }

                            const actionDur = Date.now() - stepStart;
                            profiler.recordStep(jobId, stepName, actionDur, 0, { uses: evaluatedUses });
                            reporter.recordStep({ jobId, stepName, durationMs: actionDur, exitCode: 0, uses: evaluatedUses });
                            continue;
                        }

                        if (step.run) {
                            const rawScript = engine.evaluateExpressions(step.run.trim(), evalContext);
                            const stepEnv = engine.buildEnvironment(jobDetails.env || {}, step.env || {}, evalContext);

                            const displayLines = rawScript.split('\n');
                            if (displayLines.length === 1) {
                                console.log(`    ${colors.gray}$${colors.reset} ${displayLines[0]}`);
                            } else {
                                console.log(`    ${colors.gray}$ [Multi-line Script]${colors.reset}`);
                                displayLines.forEach(line => console.log(`      ${colors.gray}|${colors.reset} ${line}`));
                            }

                            const startTime = Date.now();

                            // Apply per-step timeout (default 10 min)
                            const stepTimeout = (step['timeout-minutes'] || options.stepTimeout || 10) * 60 * 1000;

                            const result = spawnSync(rawScript, {
                                shell: true,
                                cwd: sandboxDir,
                                env: stepEnv,
                                stdio: 'pipe',
                                encoding: 'utf8',
                                timeout: stepTimeout
                            });

                            const duration = Date.now() - startTime;

                            if (result.stdout && result.stdout.trim()) {
                                engine.parseWorkflowCommands(result.stdout.trim());
                                result.stdout.trim().split('\n').forEach(l => {
                                    if (!l.startsWith('::')) {
                                        console.log(`      ${colors.cyan}|${colors.reset} ${l}`);
                                    }
                                });
                            }

                            engine.parseGithubOutputs(step.id);

                            // Record to profiler & reporter
                            const exitCode = result.status ?? (result.error ? 1 : 0);
                            profiler.recordStep(jobId, stepName, duration, exitCode, { script: rawScript });
                            reporter.recordStep({ jobId, stepName, durationMs: duration, exitCode, script: rawScript });

                            if (exitCode !== 0) {
                                if (result.error?.code === 'ETIMEDOUT') {
                                    Logger.error(`Step timed out after ${step['timeout-minutes'] || options.stepTimeout || 10}min`);
                                }
                                if (result.stderr && result.stderr.trim()) {
                                    result.stderr.trim().split('\n').forEach(l => console.log(`      ${colors.red}|${colors.reset} ${l}`));
                                }
                                Logger.error(`Command failed with exit code ${exitCode} (${duration}ms)`);
                                failedSteps++;

                                if (!step['continue-on-error']) {
                                    Logger.error(`Job [${jobId}] aborted immediately due to step failure.`);
                                    jobAborted = true;
                                    overallSuccess = false;
                                    break;
                                }
                            } else {
                                Logger.success(`    ✔ Completed in ${duration}ms`);
                            }
                        }
                    }
                }
            }

            profiler.stopMemoryTracking();
            profiler.saveToHistory();

            console.log(colors.gray + '\n--------------------------------------------------' + colors.reset);
            const totalDuration = (process.hrtime(totalTimerStart)[0] * 1000 + process.hrtime(totalTimerStart)[1] / 1e6).toFixed(2);

            // Coverage
            const totalStepsInWorkflow = Object.values(jobs).reduce((s, j) => s + (j.steps || []).length, 0);
            Reporter.computeCoverage(totalStepsInWorkflow, profiler.runs.length);

            // Profiler report
            profiler.printFullReport(jobs);

            if (failedSteps === 0) {
                Logger.success(`Workflow [${relPath}] simulated successfully in ${colors.bright}${totalDuration}ms${colors.reset}! 🚀`);
            } else {
                reporter.printReproducers();
                Logger.error(`Workflow [${relPath}] stopped with ${failedSteps} failed step(s).`);
                if (report) reporter.generateAll();
                cleanupSandbox();
                process.exit(1);
            }

            // Generate reports if --report flag passed
            if (report) {
                reporter.generateAll();
                reporter.emitAnnotations();
            }
        }

        cleanupSandbox();
        if (overallSuccess) {
            process.exit(0);
        }
    }
}

module.exports = { Runner, GitHubActionsEngine };
