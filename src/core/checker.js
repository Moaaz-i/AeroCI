/**
 * Pre-flight Check Engine
 * Scans GitHub Actions workflow YAML for syntax errors, missing env/secrets, path drifts, and npm package typos.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');

class Checker {
    static check(targetPath = '.github/workflows') {
        const fullPath = path.resolve(process.cwd(), targetPath);
        
        let files = [];
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                files = fs.readdirSync(fullPath)
                    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
                    .map(f => path.join(fullPath, f));
            } else {
                files = [fullPath];
            }
        }

        if (files.length === 0) {
            Logger.warn(`No workflow YAML files found at: ${targetPath}`);
            Logger.info(`Tip: Run 'drift init' to generate a sample configuration & workflow.`);
            return { valid: false, errors: ['No workflow files found'] };
        }

        Logger.info(`Found ${files.length} workflow file(s) to check.\n`);

        let totalErrors = 0;
        let totalWarnings = 0;

        for (const file of files) {
            const relPath = path.relative(process.cwd(), file);
            console.log(`${colors.bright}${colors.cyan}📄 Auditing: ${relPath}${colors.reset}`);
            
            try {
                const content = fs.readFileSync(file, 'utf8');
                const doc = yaml.load(content);

                if (!doc) {
                    Logger.error(`File is empty or invalid YAML: ${relPath}`);
                    totalErrors++;
                    continue;
                }

                // Check 1: Root structure validation
                if (!doc.name) {
                    Logger.warn(`Missing 'name' field in workflow.`);
                    totalWarnings++;
                }

                if (!doc.on) {
                    Logger.error(`Missing trigger 'on' block in workflow.`);
                    totalErrors++;
                }

                if (!doc.jobs || typeof doc.jobs !== 'object' || Object.keys(doc.jobs).length === 0) {
                    Logger.error(`No 'jobs' defined in workflow.`);
                    totalErrors++;
                } else {
                    // Check 2: Jobs and steps validation
                    for (const [jobId, job] of Object.entries(doc.jobs)) {
                        Logger.metric(`Job [${jobId}]`, `runs-on: ${job['runs-on'] || 'UNSPECIFIED'}`);
                        
                        if (!job['runs-on']) {
                            Logger.error(`Job '${jobId}' missing 'runs-on' property.`);
                            totalErrors++;
                        }

                        const steps = job.steps || [];
                        if (steps.length === 0) {
                            Logger.warn(`Job '${jobId}' has 0 steps.`);
                            totalWarnings++;
                        }

                        for (const step of steps) {
                            // Check 3: Npm Package Typo Guard
                            if (step.run && step.run.includes('npm install')) {
                                const installMatch = step.run.match(/npm\s+install\s+(?:-[a-z]+\s+)*([a-z0-9_@/.-]+)/i);
                                if (installMatch && installMatch[1]) {
                                    const pkgName = installMatch[1].replace(/^-/, '');
                                    if (pkgName && !pkgName.startsWith('.') && !pkgName.startsWith('/')) {
                                        Logger.info(`  🔍 Pre-checking npm registry for package: ${colors.yellow}${pkgName}${colors.reset}`);
                                        const npmCheck = spawnSync('npm', ['view', pkgName, 'version'], { encoding: 'utf8' });
                                        if (npmCheck.status !== 0) {
                                            Logger.error(`  ✖ Package Typo Guard: '${pkgName}' does not exist on npm registry!`);
                                            totalErrors++;
                                        } else {
                                            Logger.success(`  ✔ Package '${pkgName}' verified on npm (v${npmCheck.stdout.trim()})`);
                                        }
                                    }
                                }
                            }
                        }

                        // Secret / ENV Drift Detection
                        const secretsFound = [];
                        const stepsContent = JSON.stringify(job);
                        const secretRegex = /\${{\s*secrets\.([A-Z0-9_]+)\s*}}/gi;
                        let match;
                        while ((match = secretRegex.exec(stepsContent)) !== null) {
                            if (!secretsFound.includes(match[1])) {
                                secretsFound.push(match[1]);
                            }
                        }

                        if (secretsFound.length > 0) {
                            Logger.info(`  🔑 Detected Required Secrets: ${secretsFound.map(s => `${colors.yellow}${s}${colors.reset}`).join(', ')}`);
                            
                            const envFilePath = path.join(process.cwd(), '.env');
                            let localEnvKeys = [];
                            if (fs.existsSync(envFilePath)) {
                                const envRaw = fs.readFileSync(envFilePath, 'utf8');
                                localEnvKeys = envRaw.split('\n')
                                    .map(line => line.split('=')[0].trim())
                                    .filter(Boolean);
                            }

                            const missing = secretsFound.filter(s => !localEnvKeys.includes(s) && !process.env[s]);
                            if (missing.length > 0) {
                                Logger.warn(`  ⚠️ Missing Local Environment Values for: ${missing.map(m => `${colors.red}${m}${colors.reset}`).join(', ')}`);
                                Logger.info(`     -> Add these to your local .env file before running.`);
                                totalWarnings++;
                            } else {
                                Logger.success(`  ✔ All required secrets present in local environment!`);
                            }
                        }
                    }
                }

                console.log(colors.gray + '--------------------------------------------------' + colors.reset);

            } catch (err) {
                Logger.error(`YAML Syntax Error in ${relPath}: ${err.message}`);
                totalErrors++;
            }
        }

        if (totalErrors === 0) {
            Logger.success(`Pre-flight check passed! (${totalWarnings} warning(s), 0 errors).`);
            return { valid: true, errors: [] };
        } else {
            Logger.error(`Pre-flight check failed with ${totalErrors} error(s).`);
            return { valid: false, errors: totalErrors };
        }
    }
}

module.exports = { Checker };
