/**
 * AeroCI Security Hardening Engine v2.0.0
 * Features 21-30: Advanced security auditing for GitHub Actions
 *
 * 21. Supply Chain Attack Detector     — flag actions not pinned to SHA
 * 22. GITHUB_TOKEN Permission Auditor  — overly-broad write-all permissions
 * 23. Environment Injection Guard      — ${{ env.* }} in run: blocks
 * 24. Script Injection Scanner         — ${{ github.event.* }} in run: (user-controlled input)
 * 25. Secrets in Env Block Checker     — secrets accidentally set as plain env vars
 * 26. pull_request_target Poison       — dangerous checkout in pull_request_target
 * 27. Self-Hosted Runner Risk Scorer   — sensitive steps on self-hosted runners
 * 28. OIDC Token Scope Checker         — id-token: write scope validation
 * 29. Dependency Confusion Guard       — internal packages that could be hijacked
 * 30. Security Report Generator        — output security-report.md
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Logger, colors } = require('../utils/logger');

const SEVERITY = {
    CRITICAL: `${colors.red}${colors.bright}[CRITICAL]${colors.reset}`,
    HIGH:     `${colors.red}[HIGH]${colors.reset}    `,
    MEDIUM:   `${colors.yellow}[MEDIUM]${colors.reset}  `,
    LOW:      `${colors.gray}[LOW]${colors.reset}     `,
    INFO:     `${colors.cyan}[INFO]${colors.reset}    `,
};

class Security {
    static #findings = [];

    static #add(severity, ruleId, title, detail, location = '') {
        Security.#findings.push({ severity, ruleId, title, detail, location });
        const prefix = SEVERITY[severity] || SEVERITY.INFO;
        console.log(`  ${prefix} ${colors.bright}${title}${colors.reset}`);
        if (detail) console.log(`           ${colors.gray}${detail}${colors.reset}`);
        if (location) console.log(`           ${colors.cyan}@ ${location}${colors.reset}`);
    }

    // ─── Feature 21: Supply Chain Attack Detector ─────────────────────────────
    static checkActionPinning(steps, jobId) {
        for (const step of steps) {
            if (!step.uses) continue;
            const uses = step.uses;
            // Pinned to full SHA (40 hex chars)
            if (/[a-f0-9]{40}/.test(uses)) continue;
            // Official GitHub actions are trusted at any version tag
            if (uses.startsWith('actions/')) continue;
            // Anything else at a mutable tag (v1, v2, main, latest) is risky
            if (/@(main|master|latest|v\d+)$/.test(uses) || !uses.includes('@')) {
                Security.#add('HIGH', 'SEC-021',
                    `Action not pinned to SHA: "${uses}"`,
                    `Mutable tags can be silently overwritten (supply chain attack).`,
                    `job:${jobId} > "${step.name || step.uses}"`
                );
            }
        }
    }

    // ─── Feature 22: GITHUB_TOKEN Permission Auditor ─────────────────────────
    static checkPermissions(doc, jobId, job) {
        const checkPerms = (perms, scope) => {
            if (!perms) return;
            if (perms === 'write-all') {
                Security.#add('HIGH', 'SEC-022',
                    `Overly-broad permissions: write-all`,
                    `Grant only the minimum permissions required.`,
                    scope
                );
                return;
            }
            if (typeof perms === 'object') {
                for (const [k, v] of Object.entries(perms)) {
                    if (v === 'write' && ['packages', 'contents', 'pull-requests'].includes(k)) {
                        Security.#add('MEDIUM', 'SEC-022',
                            `Broad write permission: ${k}: write`,
                            `Verify this scope is actually required.`,
                            scope
                        );
                    }
                }
            }
        };
        checkPerms(doc.permissions, 'workflow-level');
        if (job) checkPerms(job.permissions, `job:${jobId}`);
    }

    // ─── Feature 23: Environment Injection Guard ──────────────────────────────
    static checkEnvInjection(steps, jobId) {
        for (const step of steps) {
            if (!step.run) continue;
            // ${{ env.SOME_VAR }} in run: can be injected if env is user-controlled
            const matches = [...step.run.matchAll(/\$\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g)];
            for (const m of matches) {
                Security.#add('MEDIUM', 'SEC-023',
                    'Env variable interpolation in run: script — ${{ env.' + m[1] + ' }}',
                    `If this env var originates from user input, it enables code injection. Use env: block to pass as process env instead.`,
                    `job:${jobId} > "${step.name || '(unnamed)'}"`
                );
            }
        }
    }

    // ─── Feature 24: Script Injection Scanner ────────────────────────────────
    static checkScriptInjection(steps, jobId) {
        const USER_CONTROLLED = [
            'github.event.issue.title',
            'github.event.issue.body',
            'github.event.pull_request.title',
            'github.event.pull_request.body',
            'github.event.comment.body',
            'github.event.review.body',
            'github.event.head_commit.message',
            'github.event.commits[0].message',
            'github.actor',
            'github.head_ref',
            'github.event.inputs',
        ];

        for (const step of steps) {
            if (!step.run) continue;
            for (const uc of USER_CONTROLLED) {
                if (step.run.includes(uc)) {
                    Security.#add('CRITICAL', 'SEC-024',
                        'Script injection via user-controlled input: ${{ ' + uc + ' }}',
                        `Attacker can inject arbitrary shell commands. Store in env var first and reference as $ENV_VAR.`,
                        `job:${jobId} > "${step.name || '(unnamed)'}"`
                    );
                }
            }
        }
    }

    // ─── Feature 25: Secrets in Env Block Checker ────────────────────────────
    static checkSecretsInEnv(job, jobId) {
        const checkEnvBlock = (env, scope) => {
            for (const [key, val] of Object.entries(env || {})) {
                const valStr = String(val);
                // Literal secret values (not ${{ secrets.X }} references)
                if (!valStr.includes('secrets.') && valStr.length > 20 &&
                    /[A-Z0-9]{16,}/.test(valStr)) {
                    Security.#add('HIGH', 'SEC-025',
                        `Possible hardcoded secret in env: ${key}`,
                        `Value looks like a token/key. Use \${{ secrets.MY_SECRET }} instead.`,
                        scope
                    );
                }
            }
        };

        checkEnvBlock(job.env, `job:${jobId} env`);
        for (const step of (job.steps || [])) {
            checkEnvBlock(step.env, `job:${jobId} > "${step.name || '(unnamed)'}" env`);
        }
    }

    // ─── Feature 26: pull_request_target Poison Detector ─────────────────────
    static checkPRTargetPoison(doc) {
        if (!doc.on?.pull_request_target) return;

        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
            const hasCheckout = (job.steps || []).some(
                s => s.uses?.includes('actions/checkout') && s.with?.ref
            );
            if (hasCheckout) {
                Security.#add('CRITICAL', 'SEC-026',
                    `pull_request_target + checkout with ref — PWNED vulnerability`,
                    `This pattern allows attackers to run arbitrary code in privileged context. See GitHub advisory GHSA-h3w9-3qp8.`,
                    `job:${jobId}`
                );
            }
        }
    }

    // ─── Feature 27: Self-Hosted Runner Risk Scorer ───────────────────────────
    static checkSelfHostedRunners(jobs) {
        const SENSITIVE_ACTIONS = ['aws-actions/', 'azure/', 'google-github-actions/', 'npm publish', 'docker push'];

        for (const [jobId, job] of Object.entries(jobs)) {
            const runsOn = String(job['runs-on'] || '');
            if (!runsOn.includes('self-hosted')) continue;

            const steps = job.steps || [];
            for (const step of steps) {
                const content = JSON.stringify(step);
                for (const sensitive of SENSITIVE_ACTIONS) {
                    if (content.includes(sensitive)) {
                        Security.#add('HIGH', 'SEC-027',
                            `Sensitive operation "${sensitive}" on self-hosted runner`,
                            `Self-hosted runners can be compromised. Sensitive operations (cloud deploys, publishes) should run on ephemeral cloud runners.`,
                            `job:${jobId} (runs-on: ${runsOn})`
                        );
                        break;
                    }
                }
            }
        }
    }

    // ─── Feature 28: OIDC Token Scope Checker ────────────────────────────────
    static checkOIDCScope(doc) {
        const workflowPerms = doc.permissions;
        const hasIdTokenWrite = (perms) =>
            perms === 'write-all' ||
            (typeof perms === 'object' && perms['id-token'] === 'write');

        if (hasIdTokenWrite(workflowPerms)) {
            // Check if it's actually used
            const content = JSON.stringify(doc.jobs || {});
            if (!content.includes('getIDToken') && !content.includes('id-token') && !content.includes('oidc')) {
                Security.#add('MEDIUM', 'SEC-028',
                    `id-token: write granted but OIDC not detected in any step`,
                    `Remove id-token: write if you're not using OIDC authentication.`,
                    'workflow permissions'
                );
            }
        }

        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
            if (hasIdTokenWrite(job.permissions)) {
                // Good — job-scoped OIDC is preferred
                Security.#add('INFO', 'SEC-028',
                    `OIDC id-token: write correctly scoped to job:${jobId}`,
                    `Good practice: scoping id-token to specific job.`,
                    `job:${jobId}`
                );
            }
        }
    }

    // ─── Feature 29: Dependency Confusion Guard ───────────────────────────────
    static checkDependencyConfusion(steps) {
        // Look for scoped packages with internal-looking names installed without lock files
        for (const step of steps) {
            if (!step.run) continue;
            // Installing packages by version range that might shadow public registry
            const matches = [...step.run.matchAll(/npm install (?:--save)?(?:-dev)?\s+(@?[\w-]+\/[\w-]+)/g)];
            for (const m of matches) {
                const pkg = m[1];
                if (pkg.startsWith('@') && !pkg.startsWith('@types/')) {
                    Security.#add('LOW', 'SEC-029',
                        `Scoped package install: ${pkg}`,
                        `Verify this scope is registered publicly or use --prefer-offline with a lock file to prevent dependency confusion attacks.`,
                        `step: "${step.name || '(unnamed)'}"`
                    );
                }
            }
        }
    }

    // ─── Feature 30: Security Report Generator ───────────────────────────────
    static #generateReport(targetFile) {
        const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
        for (const f of Security.#findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

        const now = new Date().toISOString();
        let md = `# AeroCI Security Report\n\nGenerated: ${now}\n\n`;
        md += `## Summary\n\n`;
        md += `| Severity | Count |\n|----------|-------|\n`;
        for (const [sev, count] of Object.entries(counts)) {
            if (count > 0) md += `| ${sev} | ${count} |\n`;
        }
        md += '\n## Findings\n\n';

        if (Security.#findings.length === 0) {
            md += '✅ No security issues found.\n';
        } else {
            for (const f of Security.#findings) {
                md += `### [${f.severity}] ${f.title} \`${f.ruleId}\`\n\n`;
                md += `**Detail:** ${f.detail}\n\n`;
                if (f.location) md += `**Location:** \`${f.location}\`\n\n`;
                md += '---\n\n';
            }
        }

        const outPath = path.join(process.cwd(), 'security-report.md');
        fs.writeFileSync(outPath, md, 'utf8');
        Logger.success(`Security report saved → ${colors.cyan}security-report.md${colors.reset}`);
        return outPath;
    }

    // ─── Main Entry Point ─────────────────────────────────────────────────────
    static audit(targetPath = '.github/workflows', { generateReport = false } = {}) {
        Security.#findings = [];
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
            Logger.warn('No workflow files found to audit.');
            return;
        }

        Logger.info(`🛡️  Security Hardening Engine v2.0.0 — auditing ${files.length} file(s)...\n`);

        for (const file of files) {
            const relPath = path.relative(process.cwd(), file);
            console.log(`${colors.bright}${colors.red}🔒 Security Audit: ${relPath}${colors.reset}\n`);

            let doc;
            try {
                doc = yaml.load(fs.readFileSync(file, 'utf8'));
            } catch (e) {
                Logger.error(`YAML parse error: ${e.message}`);
                continue;
            }
            if (!doc) continue;

            const jobs = doc.jobs || {};

            // Run all checks
            Security.checkPRTargetPoison(doc);
            Security.checkPermissions(doc, null, null);
            Security.checkOIDCScope(doc);
            Security.checkSelfHostedRunners(jobs);

            for (const [jobId, job] of Object.entries(jobs)) {
                const steps = job.steps || [];
                Security.checkPermissions(doc, jobId, job);
                Security.checkActionPinning(steps, jobId);
                Security.checkEnvInjection(steps, jobId);
                Security.checkScriptInjection(steps, jobId);
                Security.checkSecretsInEnv(job, jobId);
                Security.checkDependencyConfusion(steps);
            }

            console.log(colors.gray + '--------------------------------------------------' + colors.reset + '\n');
        }

        // Summary
        const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
        for (const f of Security.#findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

        console.log(`${colors.bright}Security Summary:${colors.reset}`);
        Logger.metric('Critical', String(counts.CRITICAL));
        Logger.metric('High',     String(counts.HIGH));
        Logger.metric('Medium',   String(counts.MEDIUM));
        Logger.metric('Low',      String(counts.LOW));
        Logger.metric('Info',     String(counts.INFO));
        console.log();

        if (counts.CRITICAL > 0) {
            Logger.error(`Security audit failed: ${counts.CRITICAL} CRITICAL issue(s) found!`);
        } else if (counts.HIGH > 0) {
            Logger.warn(`Security audit: ${counts.HIGH} HIGH severity issue(s) need attention.`);
        } else {
            Logger.success('Security audit passed with no CRITICAL or HIGH findings.');
        }

        if (generateReport) {
            Security.#generateReport();
        }

        return Security.#findings;
    }
}

module.exports = { Security };
