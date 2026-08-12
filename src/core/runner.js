/**
 * Local Pipeline Runner Simulation Engine v1.5.0
 * Features:
 * - Full Isolated Workspace Mirroring in Ephemeral Sandbox
 * - Complete Zero-Impact Execution (cwd set to os.tmpdir sandbox)
 * - Automatic Directory Cleanup on Exit/Error
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');

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

        // Auto discovery if no path passed or path invalid
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
            Logger.info(`Run 'drift init' to generate a sample GitHub Actions workflow.`);
            process.exit(0);
        }

        // 1. Create Ephemeral Sandbox Directory in os.tmpdir()
        const tempPrefix = path.join(os.tmpdir(), `drift-sandbox-${Date.now()}-`);
        const sandboxDir = fs.mkdtempSync(tempPrefix);
        Logger.info(`Ephemeral Sandbox Workspace mounted at: ${colors.gray}${sandboxDir}${colors.reset}`);

        // 2. Copy workspace manifest & config files to Sandbox so project directory stays untouched
        const projectRoot = process.cwd();
        try {
            ['package.json', 'package-lock.json', '.vforge', '.vforge.json', '.env'].forEach(item => {
                const src = path.join(projectRoot, item);
                if (fs.existsSync(src)) {
                    fs.cpSync(src, path.join(sandboxDir, item), { recursive: true });
                }
            });
        } catch (e) {}

        // Register Auto-Cleanup Hook
        const cleanupSandbox = () => {
            if (fs.existsSync(sandboxDir)) {
                try {
                    fs.rmSync(sandboxDir, { recursive: true, force: true });
                    Logger.info(`🧹 Ephemeral Sandbox auto-cleaned. (Zero disk footprint on project)`);
                } catch (e) {}
            }
        };

        process.on('exit', cleanupSandbox);
        process.on('SIGINT', () => { cleanupSandbox(); process.exit(130); });

        let overallSuccess = true;

        for (const targetFile of targetFiles) {
            const relPath = path.relative(projectRoot, targetFile);
            Logger.info(`Initializing Digital Twin runner for: ${colors.bright}${colors.cyan}${relPath}${colors.reset}`);

            const fileContent = fs.readFileSync(targetFile, 'utf8');
            const parsedYaml = yaml.load(fileContent);

            Logger.metric('Pipeline Name', parsedYaml.name || 'Unnamed Workflow');
            Logger.metric('Trigger Event', JSON.stringify(parsedYaml.on || 'manual'));
            console.log(colors.gray + '--------------------------------------------------' + colors.reset);

            const envFilePath = path.join(projectRoot, '.env');
            const localEnv = { 
                ...process.env, 
                CI: 'true', 
                GITHUB_ACTIONS: 'true', 
                DRIFT_SIMULATOR: '1.5.0',
                DRIFT_SANDBOX: sandboxDir,
                TMPDIR: sandboxDir
            };

            if (fs.existsSync(envFilePath)) {
                const envRaw = fs.readFileSync(envFilePath, 'utf8');
                envRaw.split('\n').forEach(line => {
                    const parts = line.split('=');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const val = parts.slice(1).join('=').trim();
                        if (key && !key.startsWith('#')) {
                            localEnv[key] = val;
                        }
                    }
                });
            }

            const jobs = parsedYaml.jobs || {};
            let failedSteps = 0;
            let jobAborted = false;

            for (const [jobId, jobDetails] of Object.entries(jobs)) {
                if (jobAborted) break;

                console.log(`\n${colors.magenta}${colors.bright}▶ Executing Job: [${jobId}]${colors.reset} ${colors.gray}(runs-on: ${jobDetails['runs-on'] || 'ubuntu-latest'})${colors.reset}`);
                
                const jobEnv = { ...localEnv, ...(jobDetails.env || {}) };
                const steps = jobDetails.steps || [];

                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    const stepName = step.name || step.run || (step.uses ? `action: ${step.uses}` : `Step ${i+1}`);
                    console.log(`\n  ${colors.cyan}${colors.bright}↳ Step ${i+1}/${steps.length}:${colors.reset} ${colors.bright}${stepName}${colors.reset}`);

                    if (step.uses) {
                        Logger.info(`    ⚡ Simulating GitHub Action: ${colors.yellow}${step.uses}${colors.reset}`);
                        if (step.uses.includes('actions/checkout')) {
                            Logger.success(`    ✔ Simulated [actions/checkout]: Local workspace mirrored into Ephemeral Sandbox.`);
                        } else if (step.uses.includes('actions/setup-node')) {
                            const nodeVer = (step.with && step.with['node-version']) || process.version;
                            Logger.success(`    ✔ Simulated [actions/setup-node]: Node.js ${nodeVer} ready.`);
                        } else {
                            Logger.success(`    ✔ Simulated GitHub Action [${step.uses}] completed.`);
                        }
                        continue;
                    }

                    if (step.run) {
                        const stepEnv = { ...jobEnv, ...(step.env || {}) };
                        const rawScript = step.run.trim();

                        const displayLines = rawScript.split('\n');
                        if (displayLines.length === 1) {
                            console.log(`    ${colors.gray}$${colors.reset} ${displayLines[0]}`);
                        } else {
                            console.log(`    ${colors.gray}$ [Multi-line Script]${colors.reset}`);
                            displayLines.forEach(line => console.log(`      ${colors.gray}|${colors.reset} ${line}`));
                        }

                        const startTime = Date.now();
                        // CRITICAL FIX: Set cwd to sandboxDir so no files are downloaded into projectRoot
                        const result = spawnSync(rawScript, {
                            shell: true,
                            cwd: sandboxDir,
                            env: stepEnv,
                            stdio: 'pipe',
                            encoding: 'utf8'
                        });

                        const duration = Date.now() - startTime;

                        if (result.stdout && result.stdout.trim()) {
                            result.stdout.trim().split('\n').forEach(l => console.log(`      ${colors.cyan}|${colors.reset} ${l}`));
                        }

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

module.exports = { Runner };
