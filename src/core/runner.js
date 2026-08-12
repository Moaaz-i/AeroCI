/**
 * Local Pipeline Runner Simulation Engine
 * Executes workflow steps inside isolated child processes with simulated GitHub environment context.
 */

const fs = require('fs');
const path = require('path');
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
            process.exit(1);
        }

        for (const targetFile of targetFiles) {
            const relPath = path.relative(process.cwd(), targetFile);
            Logger.info(`Initializing Digital Twin runner for: ${colors.bright}${colors.cyan}${relPath}${colors.reset}`);

            const fileContent = fs.readFileSync(targetFile, 'utf8');
            const parsedYaml = yaml.load(fileContent);

            Logger.metric('Pipeline Name', parsedYaml.name || 'Unnamed Workflow');
            Logger.metric('Trigger Event', JSON.stringify(parsedYaml.on || 'manual'));
            console.log(colors.gray + '--------------------------------------------------' + colors.reset);

            // Load local .env variables into execution context
            const envFilePath = path.join(process.cwd(), '.env');
            const localEnv = { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', DRIFT_SIMULATOR: '1.0.0' };
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
            let totalStepsExecuted = 0;
            let failedSteps = 0;

            for (const [jobId, jobDetails] of Object.entries(jobs)) {
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
                            Logger.success(`    ✔ Simulated [actions/checkout]: Local workspace already mounted.`);
                        } else if (step.uses.includes('actions/setup-node')) {
                            const nodeVer = (step.with && step.with['node-version']) || process.version;
                            Logger.success(`    ✔ Simulated [actions/setup-node]: Node.js ${nodeVer} ready.`);
                        } else {
                            Logger.success(`    ✔ Simulated GitHub Action [${step.uses}] completed.`);
                        }
                        totalStepsExecuted++;
                        continue;
                    }

                    if (step.run) {
                        const stepEnv = { ...jobEnv, ...(step.env || {}) };
                        const commands = step.run.split('\n').map(c => c.trim()).filter(Boolean);

                        for (const cmd of commands) {
                            console.log(`    ${colors.gray}$${colors.reset} ${cmd}`);
                            const startTime = Date.now();
                            
                            const result = spawnSync(cmd, {
                                shell: true,
                                cwd: process.cwd(),
                                env: stepEnv,
                                stdio: 'pipe',
                                encoding: 'utf8'
                            });

                            const duration = Date.now() - startTime;

                            if (result.stdout && result.stdout.trim()) {
                                result.stdout.trim().split('\n').forEach(l => console.log(`      ${colors.gray}|${colors.reset} ${l}`));
                            }

                            if (result.status !== 0) {
                                if (result.stderr && result.stderr.trim()) {
                                    result.stderr.trim().split('\n').forEach(l => console.log(`      ${colors.red}|${colors.reset} ${l}`));
                                }
                                Logger.error(`Command failed with exit code ${result.status} (${duration}ms)`);
                                failedSteps++;
                                
                                if (options.debugOnFailure) {
                                    Logger.warn(`Entering debug mode for step...`);
                                }
                                
                                if (!step['continue-on-error']) {
                                    Logger.error(`Job [${jobId}] aborted due to step failure.`);
                                    break;
                                }
                            } else {
                                Logger.success(`    ✔ Completed in ${duration}ms`);
                                totalStepsExecuted++;
                            }
                        }
                    }
                }
            }

            console.log(colors.gray + '\n--------------------------------------------------' + colors.reset);
            if (failedSteps === 0) {
                Logger.success(`Workflow [${relPath}] simulated successfully! ✨`);
            } else {
                Logger.error(`Workflow [${relPath}] finished with ${failedSteps} failed step(s).`);
            }
        }
    }
}

module.exports = { Runner };
