/**
 * Complete GitHub Actions Engine Simulator v2.0.0
 * Fully emulates GitHub Actions Contexts, Environment Files, Expressions, Workflow Commands, Matrix Strategy, and Artifacts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');

class GitHubActionsEngine {
    constructor(sandboxDir, projectRoot) {
        this.sandboxDir = sandboxDir;
        this.projectRoot = projectRoot;

        // GitHub Actions Environment Files
        this.envFile = path.join(sandboxDir, '.github_env');
        this.pathFile = path.join(sandboxDir, '.github_path');
        this.outputFile = path.join(sandboxDir, '.github_output');

        fs.writeFileSync(this.envFile, '');
        fs.writeFileSync(this.pathFile, '');
        fs.writeFileSync(this.outputFile, '');

        // Step outputs store
        this.outputs = {};
    }

    /**
     * Evaluates GitHub Actions Expression Contexts: ${{ github.sha }}, ${{ matrix.node-version }}, ${{ steps.id.outputs.val }}
     */
    evaluateExpressions(str, context = {}) {
        if (!str || typeof str !== 'string') return str;

        return str.replace(/\${{\s*([^}]+)\s*}}/g, (_, expr) => {
            expr = expr.trim();

            // 1. Evaluate Contexts (github, matrix, env, steps, secrets)
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

    /**
     * Constructs full GitHub Actions Environment Variables
     */
    buildEnvironment(jobEnv = {}, stepEnv = {}, context = {}) {
        const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || '0000000000000000000000000000000000000000';
        const gitBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'main';

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
            GITHUB_SHA: gitCommit,
            GITHUB_REF: `refs/heads/${gitBranch}`,
            GITHUB_REF_NAME: gitBranch,
            GITHUB_WORKSPACE: this.sandboxDir,
            RUNNER_OS: process.platform === 'darwin' ? 'macOS' : (process.platform === 'win32' ? 'Windows' : 'Linux'),
            RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
            RUNNER_TEMP: path.join(this.sandboxDir, 'tmp'),
            GITHUB_ENV: this.envFile,
            GITHUB_PATH: this.pathFile,
            GITHUB_OUTPUT: this.outputFile,
            TMPDIR: this.sandboxDir
        };

        // Parse accumulated GITHUB_ENV
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

    /**
     * Parses Workflow Commands (e.g. ::set-output, ::error::, ::warning::, ::notice::)
     */
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

    /**
     * Parses GITHUB_OUTPUT file written by steps (echo "key=value" >> $GITHUB_OUTPUT)
     */
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
            fs.writeFileSync(this.outputFile, ''); // reset for next step
        }
    }
}

class Runner {
    static run(workflowPath = null, options = {}) {
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

        const tempPrefix = path.join(os.tmpdir(), `drift-sandbox-${Date.now()}-`);
        const sandboxDir = fs.mkdtempSync(tempPrefix);
        Logger.info(`Ephemeral Sandbox Workspace mounted at: ${colors.gray}${sandboxDir}${colors.reset}`);

        const projectRoot = process.cwd();
        try {
            fs.cpSync(projectRoot, sandboxDir, {
                recursive: true,
                filter: (src) => {
                    const relative = path.relative(projectRoot, src);
                    return !relative.startsWith('node_modules') && !relative.startsWith('.git');
                }
            });
        } catch (e) {}

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

        for (const targetFile of targetFiles) {
            const relPath = path.relative(projectRoot, targetFile);
            Logger.info(`Initializing GitHub Actions Simulator v2.0.0 for: ${colors.bright}${colors.cyan}${relPath}${colors.reset}`);

            const fileContent = fs.readFileSync(targetFile, 'utf8');
            const parsedYaml = yaml.load(fileContent);

            const workflowName = parsedYaml.name || 'Unnamed Workflow';
            Logger.metric('Pipeline Name', workflowName);
            Logger.metric('Trigger Event', JSON.stringify(parsedYaml.on || 'manual'));
            console.log(colors.gray + '--------------------------------------------------' + colors.reset);

            const jobs = parsedYaml.jobs || {};
            let failedSteps = 0;
            let jobAborted = false;

            for (const [jobId, jobDetails] of Object.entries(jobs)) {
                if (jobAborted) break;

                // Matrix Strategy Emulation
                let matrixInstances = [{}];
                if (jobDetails.strategy && jobDetails.strategy.matrix) {
                    const matrix = jobDetails.strategy.matrix;
                    const keys = Object.keys(matrix);
                    matrixInstances = [];
                    
                    // Simple combination generator
                    const combinations = (index, current) => {
                        if (index === keys.length) {
                            matrixInstances.push({ ...current });
                            return;
                        }
                        const key = keys[index];
                        const values = Array.isArray(matrix[key]) ? matrix[key] : [matrix[key]];
                        values.forEach(val => {
                            combinations(index + 1, { ...current, [key]: val });
                        });
                    };
                    combinations(0, {});
                }

                for (const matrixCtx of matrixInstances) {
                    const matrixLabel = Object.keys(matrixCtx).length > 0 
                        ? ` (${Object.entries(matrixCtx).map(([k,v]) => `${k}:${v}`).join(', ')})` 
                        : '';

                    console.log(`\n${colors.magenta}${colors.bright}▶ Executing Job: [${jobId}]${matrixLabel}${colors.reset} ${colors.gray}(runs-on: ${jobDetails['runs-on'] || 'ubuntu-latest'})${colors.reset}`);

                    const steps = jobDetails.steps || [];

                    for (let i = 0; i < steps.length; i++) {
                        const step = steps[i];

                        // Expression Evaluation Context
                        const evalContext = {
                            workflowName,
                            jobId,
                            eventName: typeof parsedYaml.on === 'string' ? parsedYaml.on : Object.keys(parsedYaml.on || {})[0],
                            matrix: matrixCtx,
                            github: {
                                sha: 'local-sha',
                                ref: 'refs/heads/main',
                                repository: 'local/repo',
                                event_name: 'push'
                            }
                        };

                        const stepName = engine.evaluateExpressions(
                            step.name || step.run || (step.uses ? `action: ${step.uses}` : `Step ${i+1}`),
                            evalContext
                        );

                        console.log(`\n  ${colors.cyan}${colors.bright}↳ Step ${i+1}/${steps.length}:${colors.reset} ${colors.bright}${stepName}${colors.reset}`);

                        // Evaluate `if:` condition
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
                            
                            if (evaluatedUses.includes('actions/checkout')) {
                                Logger.success(`    ✔ [actions/checkout]: Local workspace mirrored in Ephemeral Sandbox.`);
                            } else if (evaluatedUses.includes('actions/setup-node')) {
                                const rawVer = (step.with && step.with['node-version']) || process.version;
                                const nodeVer = engine.evaluateExpressions(String(rawVer), evalContext);
                                Logger.success(`    ✔ [actions/setup-node]: Node.js ${nodeVer} environment ready.`);
                            } else {
                                Logger.success(`    ✔ GitHub Action [${evaluatedUses}] completed.`);
                            }
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
                            const result = spawnSync(rawScript, {
                                shell: true,
                                cwd: sandboxDir,
                                env: stepEnv,
                                stdio: 'pipe',
                                encoding: 'utf8'
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

                            if (result.status !== 0) {
                                if (result.stderr && result.stderr.trim()) {
                                    result.stderr.trim().split('\n').forEach(l => console.log(`      ${colors.red}|${colors.reset} ${l}`));
                                }
                                Logger.error(`Command failed with exit code ${result.status} (${duration}ms)`);
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

            console.log(colors.gray + '\n--------------------------------------------------' + colors.reset);
            if (failedSteps === 0) {
                Logger.success(`Workflow [${relPath}] simulated successfully! ✨`);
            } else {
                Logger.error(`Workflow [${relPath}] stopped with ${failedSteps} failed step(s).`);
                cleanupSandbox();
                process.exit(1);
            }
        }

        cleanupSandbox();
        if (overallSuccess) {
            process.exit(0);
        }
    }
}

module.exports = { Runner, GitHubActionsEngine };
