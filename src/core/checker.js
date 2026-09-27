/**
 * AeroCI pre-flight checker.
 *
 * Static, offline validation of workflow files. The design rule is that a check
 * must be *correct*: no heuristic that cries wolf, no network call that hangs,
 * and every finding carries a concrete fix.
 *
 * Rules
 *   structure  name / on / jobs / runs-on / steps shape
 *   schema     job & step keys GitHub does not recognise
 *   actions    unpinned or deprecated action versions, third-party actions
 *   secrets    referenced secrets without a local value, hardcoded credentials
 *   graph      unknown `needs`, cycles, unreachable jobs
 *   matrix     empty axis, an `include` that can never apply
 *   shell      unknown `shell:` keyword
 *   packages   typos in `npm install <pkg>` (opt-in, needs the registry)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');
const { loadEnvFile } = require('./secrets');
const { expandMatrix } = require('./matrix');
const { orderJobs } = require('./graph');
const { VERSION } = require('../version');

/** Keys GitHub accepts on a job. */
const JOB_KEYS = new Set([
    'name', 'needs', 'runs-on', 'permissions', 'environment', 'concurrency', 'outputs',
    'env', 'defaults', 'if', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error',
    'container', 'services', 'uses', 'with', 'secrets', 'name', 'defaults'
]);

/** Keys GitHub accepts on a step. */
const STEP_KEYS = new Set([
    'id', 'if', 'name', 'uses', 'run', 'with', 'env', 'shell', 'working-directory',
    'timeout-minutes', 'continue-on-error'
]);

const KNOWN_SHELLS = new Set([
    'bash', 'sh', 'pwsh', 'powershell', 'python', 'python3', 'cmd', 'node'
]);

/** First-party actions do not need a supply-chain warning. */
const OFFICIAL_ACTIONS = /^(actions|github|docker|aws-actions|azure|google-github-actions|hashicorp)\//;

/** Scopes where `write` materially widens the blast radius. */
const SENSITIVE_SCOPES = new Set(['contents', 'id-token', 'actions', 'packages', 'deployments', 'security-events']);

/**
 * Every `needs.<job>.outputs.<key>` read anywhere in a job's own YAML.
 *
 * The expression syntax has more ways to reach a value than a plain dotted
 * path — `needs['build'].outputs.value`, `needs.*.outputs.value` — so this
 * recognises the three forms that actually appear in workflows and ignores the
 * rest rather than guessing.
 */
function readJobOutputs(value) {
    if (value === null || value === undefined) return [];
    if (typeof value !== 'string') {
        if (typeof value === 'number' || typeof value === 'boolean') return [];
        if (Array.isArray(value)) return value.flatMap(readJobOutputs);
        return Object.values(value).flatMap(readJobOutputs);
    }

    const found = [];
    const push = (job, key) => found.push({ job, key });

    for (const m of value.matchAll(/needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)/g)) {
        push(m[1], m[2]);
    }
    for (const m of value.matchAll(/needs\[['"]([^'"]+)['"]\]\.outputs\.([A-Za-z_][\w-]*)/g)) {
        push(m[1], m[2]);
    }
    for (const m of value.matchAll(/needs\[['"]([^'"]+)['"]\]\.outputs\[['"]([^'"]+)['"]\]/g)) {
        push(m[1], m[2]);
    }
    return found;
}

const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

class Checker {
    /**
     * @param {string} targetPath  file or directory
     * @param {object} options
     * @param {boolean} options.network  allow the npm registry lookup (default off)
     * @returns {{valid:boolean, errors:number, warnings:number, findings:Array}}
     */
    static check(targetPath = '.github/workflows', options = {}) {
        const files = Checker.collectFiles(targetPath);
        const findings = [];
        const envFile = loadEnvFile(path.resolve(process.cwd(), '.env'));

        if (files.length === 0) {
            Logger.warn(`No workflow files found at: ${targetPath}`);
            Logger.note('  Run `aeroci init` to create a starter workflow, or point AeroCI at a file.');
            // A count with no finding behind it is the worst of both worlds:
            // the summary says one error, the list says none, and anything
            // reading `findings` concludes there is nothing to fix.
            const exists = fs.existsSync(path.resolve(process.cwd(), targetPath));
            return {
                valid: false,
                errors: 1,
                warnings: 0,
                findings: [{
                    file: targetPath,
                    severity: SEVERITY.ERROR,
                    rule: 'target',
                    message: exists
                        ? `no .yml or .yaml workflow files at ${targetPath}`
                        : `no such file or directory: ${targetPath}`,
                    fix: exists
                        ? `point AeroCI at a workflow file, or run \`aeroci init\``
                        : 'check the path — AeroCI reads .github/workflows by default'
                }]
            };
        }

        Logger.info(`Checker v${VERSION} · ${files.length} workflow file(s) · ${options.network ? 'registry checks enabled' : 'offline'}\n`);

        for (const file of files) {
            const rel = path.relative(process.cwd(), file);
            const content = fs.readFileSync(file, 'utf8');

            let doc;
            try {
                doc = yaml.load(content, { filename: file });
            } catch (err) {
                const line = err.mark ? err.mark.line + 1 : null;
                findings.push({
                    file: rel, severity: SEVERITY.ERROR, rule: 'yaml',
                    message: `invalid YAML: ${err.message.split('\n')[0]}`,
                    line, fix: 'fix the indentation or quoting of the reported line'
                });
                continue;
            }

            if (!doc || typeof doc !== 'object') {
                findings.push({
                    file: rel, severity: SEVERITY.ERROR, rule: 'empty',
                    message: 'file is empty or does not contain a mapping',
                    fix: 'add at least `on:` and `jobs:`'
                });
                continue;
            }

            findings.push(...Checker.checkWorkflow(doc, rel, envFile, options));
        }

        return Checker.report(findings);
    }

    /**
     * Workflow files under a target: a directory, a glob, or one file.
     *
     * The extension filter applies to a single file too. GitHub only reads
     * `.yml` / `.yaml` from `.github/workflows`, so pointing AeroCI at
     * `notes.txt` should say "not a workflow file" rather than try to parse it
     * and report the contents as a malformed workflow.
     *
     * A directory that *is* a project root is also searched for workflows, so
     * `aeroci check .` finds them instead of reporting nothing found.
     */
    static collectFiles(targetPath) {
        const full = path.resolve(process.cwd(), targetPath);
        const isWorkflow = (name) => /\.ya?ml$/i.test(name);
        const listYaml = (dir) => fs.readdirSync(dir)
            .filter(isWorkflow)
            .map((f) => path.join(dir, f))
            .sort();
        if (!fs.existsSync(full)) {
            // Allow a glob like ".github/workflows/*.yml"
            const dir = path.dirname(full);
            if (fs.existsSync(dir)) {
                const rx = new RegExp('^' + path.basename(full)
                    .replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
                return fs.readdirSync(dir)
                    .filter((f) => rx.test(f) && isWorkflow(f))
                    .map((f) => path.join(dir, f))
                    .sort();
            }
            return [];
        }
        if (fs.statSync(full).isDirectory()) {
            const direct = listYaml(full);
            if (direct.length) return direct;
            // A bare project root is the common case, and its workflows live one
            // level down where GitHub puts them.
            const nested = path.join(full, '.github', 'workflows');
            if (fs.existsSync(nested)) return listYaml(nested);
            return direct;
        }
        return isWorkflow(full) ? [full] : [];
    }

    static checkWorkflow(doc, file, envFile, options) {
        const out = [];
        const add = (severity, rule, message, extra = {}) =>
            out.push({ file, severity, rule, message, ...extra });

        // ── structure ─────────────────────────────────────────────────────────
        if (!doc.name) {
            add(SEVERITY.WARNING, 'structure', 'workflow has no `name`', {
                fix: 'add `name: My workflow` so the run is identifiable'
            });
        }
        if (doc.on === undefined) {
            add(SEVERITY.ERROR, 'structure', 'missing the `on:` trigger block', {
                fix: 'add `on: [push]` (or your real triggers)'
            });
        }
        if (!doc.jobs || typeof doc.jobs !== 'object' || Object.keys(doc.jobs).length === 0) {
            add(SEVERITY.ERROR, 'structure', 'no `jobs` defined');
            return out;
        }

        // ── graph ─────────────────────────────────────────────────────────────
        const { order, cycles } = orderJobs(doc.jobs);
        for (const cycle of cycles) {
            add(SEVERITY.ERROR, 'graph', `circular needs: ${cycle.join(' → ')}`, {
                fix: 'break the cycle by removing one `needs` entry'
            });
        }
        for (const [jobId, job] of Object.entries(doc.jobs)) {
            const needs = job.needs ? (Array.isArray(job.needs) ? job.needs : [job.needs]) : [];
            for (const dep of needs) {
                if (!doc.jobs[dep]) {
                    add(SEVERITY.ERROR, 'graph', `job "${jobId}" needs "${dep}", which does not exist`, {
                        fix: `fix the typo or add job "${dep}"`
                    });
                }
            }
        }
        void order;

        Checker.checkJobOutputs(doc, add);

        // ── per job ───────────────────────────────────────────────────────────
        for (const [jobId, job] of Object.entries(doc.jobs)) {
            if (!job || typeof job !== 'object') {
                add(SEVERITY.ERROR, 'structure', `job "${jobId}" is not a mapping`);
                continue;
            }
            for (const key of Object.keys(job)) {
                if (!JOB_KEYS.has(key)) {
                    add(SEVERITY.WARNING, 'schema', `job "${jobId}" has an unrecognised key "${key}"`, {
                        fix: 'GitHub will reject or ignore this key — check for a typo'
                    });
                }
            }

            const reusableCall = job.uses && !job['runs-on'];
            if (!job['runs-on'] && !reusableCall) {
                add(SEVERITY.ERROR, 'structure', `job "${jobId}" has no \`runs-on\``, {
                    fix: 'add `runs-on: ubuntu-latest`'
                });
            }
            if (job.steps !== undefined && !Array.isArray(job.steps)) {
                add(SEVERITY.ERROR, 'schema', `job "${jobId}": \`steps\` must be a list`);
            }
            const steps = Array.isArray(job.steps) ? job.steps : [];
            if (!reusableCall && steps.length === 0) {
                add(SEVERITY.WARNING, 'structure', `job "${jobId}" has no steps`);
            }

            Checker.checkMatrix(job, jobId, add);

            const referencedSecrets = new Set();

            steps.forEach((step, index) => {
                const where = `job "${jobId}" step ${index + 1}`;
                if (!step || typeof step !== 'object') {
                    add(SEVERITY.ERROR, 'schema', `${where} is not a mapping`);
                    return;
                }
                for (const key of Object.keys(step)) {
                    if (!STEP_KEYS.has(key)) {
                        add(SEVERITY.WARNING, 'schema', `${where}: unrecognised key "${key}"`, {
                            fix: 'check for a typo — GitHub ignores unknown step keys'
                        });
                    }
                }
                if (step.run === undefined && step.uses === undefined) {
                    add(SEVERITY.ERROR, 'schema', `${where} has neither \`run\` nor \`uses\``);
                }
                if (step.run !== undefined && step.uses !== undefined) {
                    add(SEVERITY.ERROR, 'schema', `${where} has both \`run\` and \`uses\` — only one is allowed`);
                }
                if (typeof step.run === 'boolean') {
                    add(SEVERITY.ERROR, 'schema', `${where}: \`run\` was parsed as a boolean`, {
                        fix: 'quote it, e.g. `run: "false"`'
                    });
                }
                if (step.shell !== undefined && !KNOWN_SHELLS.has(String(step.shell))
                    && !String(step.shell).includes('{0}')) {
                    add(SEVERITY.WARNING, 'shell', `${where}: unknown shell "${step.shell}"`, {
                        fix: `use one of: ${[...KNOWN_SHELLS].join(', ')} — or a custom \`command {0}\``
                    });
                }
                if (step.uses) Checker.checkAction(step.uses, where, add);
                if (step.run) Checker.checkScript(step.run, where, add, referencedSecrets, options);
            });

            // ── secrets ───────────────────────────────────────────────────────
            if (referencedSecrets.size) {
                const missing = [...referencedSecrets].filter(
                    (name) => !(name in envFile.values) && !process.env[name]);
                // `where` is scoped to the per-step callback above; naming the
                // job is the honest label for a whole-job summary.
                add(SEVERITY.INFO, 'secrets',
                    `job "${jobId}" references ${[...referencedSecrets].join(', ')}` +
                    (missing.length ? ` — no local value for ${missing.join(', ')}` : ' — all present locally'),
                { fix: missing.length ? `add ${missing.join(', ')} to .env` : undefined });
            }

            if (steps.some((s) => s && s.run && /\bsudo\b/.test(String(s.run)))) {
                add(SEVERITY.WARNING, 'permissions', `job "${jobId}" uses \`sudo\``, {
                    fix: 'sudo is a no-op on hosted runners and adds nothing on self-hosted ones'
                });
            }
        }

        // ── permissions: one verdict per workflow, not one per job ───────────
        Checker.checkWorkflowPermissions(doc, out);

        Checker.checkSecretPaths(doc, add);

        return out;
    }

    /**
     * Job outputs have to be declared before another job can read them.
     *
     * `needs.build.outputs.value` is empty unless job `build` says
     *   outputs:
     *     value: ${{ steps.build.outputs.value }}
     * Step outputs are not job outputs. This is one of the most common reasons
     * a downstream job silently gets an empty string, and nothing about it
     * looks wrong, so it is worth naming.
     */
    static checkJobOutputs(doc, add) {
        const jobs = doc.jobs || {};

        /** name → Set of output keys it declares in its `outputs:` block. */
        const declared = new Map();
        for (const [jobId, job] of Object.entries(jobs)) {
            const map = (job && typeof job.outputs === 'object' && job.outputs) || null;
            declared.set(jobId, map ? new Set(Object.keys(map)) : null);
        }

        /** jobId → { key → [where it was read] } */
        const read = new Map();

        const note = (job, key, where) => {
            if (!read.has(job)) read.set(job, new Map());
            const keys = read.get(job);
            if (!keys.has(key)) keys.set(key, []);
            // The same read found through two paths is one place, not two.
            if (!keys.get(key).includes(where)) keys.get(key).push(where);
        };

        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job || typeof job !== 'object') continue;

            // Inside `steps`, name the step — "job X `steps`" sends nobody
            // anywhere when the job has twenty of them.
            if (Array.isArray(job.steps)) {
                job.steps.forEach((step, index) => {
                    if (!step || typeof step !== 'object') return;
                    const at = `job "${jobId}" step ${index + 1}`;
                    for (const value of Object.values(step)) {
                        for (const m of readJobOutputs(value)) note(m.job, m.key, at);
                    }
                });
            }

            for (const [key, value] of Object.entries(job)) {
                if (key === 'steps') continue;
                const at = `job "${jobId}" \`${key}\``;
                for (const m of readJobOutputs(value)) note(m.job, m.key, at);
            }
        }

        for (const [producer, keys] of read) {
            const declaredKeys = declared.get(producer);
            const names = [...keys.keys()];

            // The snippet a reader can paste. Step ids cannot be guessed, so
            // they stay as a placeholder rather than being invented.
            const snippet = (list) => list
                .map((key) => `        ${key}: \${{ steps.<step-id>.outputs.${key} }}`)
                .join('\n');

            if (declaredKeys === null) {
                add(SEVERITY.WARNING, 'outputs',
                    `job "${producer}" is read for outputs but declares none — `
                    + `${names.join(', ')} will always be empty`,
                { fix: `add to job "${producer}":\n    outputs:\n${snippet(names)}` });
                continue;
            }
            for (const [key, readers] of keys) {
                if (declaredKeys.has(key)) continue;
                add(SEVERITY.ERROR, 'outputs',
                    `${readers[0]} reads \`needs.${producer}.outputs.${key}\`, `
                    + `but job "${producer}" declares no output named "${key}"`,
                { fix: `add to job "${producer}":\n    outputs:\n${snippet([key])}` });
            }
        }

        // The other direction: a reference to a step id the job does not have.
        // `steps` is populated from the `id:` of each step in the *same* job, so
        // a name that is not there is unconditionally empty — whether it is read
        // in a script, in `with:`, or in the job's own `outputs:` block.
        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job || typeof job !== 'object') continue;
            const stepIds = new Set((Array.isArray(job.steps) ? job.steps : [])
                .filter((s) => s && typeof s === 'object' && typeof s.id === 'string')
                .map((s) => s.id));
            if (stepIds.size === 0 && !Object.keys(job.outputs || {}).length
                && !Array.isArray(job.steps)) {
                continue;
            }

            // One finding per (step id, location): the same missing id read
            // twice in one step is one mistake, not two.
            const reported = new Set();

            // `outputs: { sha: '${{ steps.… }}' }` is a mapping of strings, so
            // the walk has to descend rather than stringify into `[object Object]`.
            const scan = (value, where, seen = new Set()) => {
                if (value === null || value === undefined) return;
                if (typeof value === 'object') {
                    if (seen.has(value)) return;
                    seen.add(value);
                    if (Array.isArray(value)) value.forEach((v) => scan(v, where, seen));
                    else Object.values(value).forEach((v) => scan(v, where, seen));
                    return;
                }
                for (const m of String(value).matchAll(/steps\.([A-Za-z_][\w-]*)\.(outputs|conclusion|outcome)\b/g)) {
                    const stepId = m[1];
                    if (stepIds.has(stepId)) continue;
                    const key = `${stepId}|${where}`;
                    if (reported.has(key)) continue;
                    reported.add(key);
                    add(SEVERITY.ERROR, 'outputs',
                        `${where} reads \`steps.${stepId}.${m[2]}\`, but no step in `
                        + `job "${jobId}" has \`id: ${stepId}\``,
                    { fix: `give the step an \`id: ${stepId}\`, or point at a step that exists` });
                }
            };

            if (Array.isArray(job.steps)) {
                job.steps.forEach((step, index) => {
                    if (!step || typeof step !== 'object') return;
                    for (const value of Object.values(step)) {
                        scan(value, `job "${jobId}" step ${index + 1}`);
                    }
                });
            }
            for (const [key, value] of Object.entries(job)) {
                if (key === 'steps') continue;
                scan(value, `job "${jobId}" \`${key}\``);
            }
        }
    }

    /**
     * `secrets` is a map of strings, not of objects.
     *
     * `${{ secrets.NPM_TOKEN.value }}` is a natural thing to write when you
     * expect a nested value, and it resolves to nothing at all — silently, and
     * differently from how the same mistake in a `with:` block behaves. Since
     * a real secret is left untouched, the step usually passes with an empty
     * variable, which is exactly the class of bug that reaches production.
     */
    static checkSecretPaths(doc, add) {
        const jobs = doc.jobs || {};

        // `secrets.X.y` / `secrets.X[0]` / `secrets['X'].y` — anything past the
        // first key. A well-formed `${{ secrets.X }}` never reaches here.
        const SUSPECT = /secrets\.([A-Za-z_][\w-]*)\s*[.[]|secrets\[['"]([^'"]+)['"]\]\s*[.[]/g;

        const walk = (value, where) => {
            if (typeof value === 'string') {
                SUSPECT.lastIndex = 0;
                let m;
                while ((m = SUSPECT.exec(value)) !== null) {
                    const name = m[1] || m[2];
                    add(SEVERITY.ERROR, 'secrets',
                        `${where}: \`secrets.${name}\` is a string, not an object — `
                        + 'reading a property of it gives an empty value',
                    { fix: `use \${{ secrets.${name} }} directly` });
                }
                return;
            }
            if (Array.isArray(value)) {
                for (const item of value) walk(item, where);
                return;
            }
            if (value && typeof value === 'object') {
                for (const item of Object.values(value)) walk(item, where);
            }
        };

        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job || typeof job !== 'object') continue;
            const steps = Array.isArray(job.steps) ? job.steps : [];

            for (const [key, value] of Object.entries(job)) {
                if (key === 'steps') continue;
                walk(value, `job "${jobId}" \`${key}\``);
            }
            steps.forEach((step, index) => {
                if (!step || typeof step !== 'object') return;
                for (const value of Object.values(step)) walk(value, `job "${jobId}" step ${index + 1}`);
            });
        }

        // The same mistake at workflow level.
        for (const [key, value] of Object.entries(doc)) {
            if (key === 'jobs' || key === 'on' || key === 'name') continue;
            walk(value, `workflow \`${key}\``);
        }
    }

    /** Elevated scopes that deserve a warning even when a job opts in. */
    static checkWorkflowPermissions(doc, out) {
        const add = (severity, message, extra = {}) =>
            out.push({ file: out[0] ? out[0].file : null, severity, rule: 'permissions', message, ...extra });

        const workflowLevel = doc.permissions;

        if (workflowLevel === 'write-all') {
            add(SEVERITY.ERROR, 'workflow requests `permissions: write-all`', {
                fix: 'enumerate the scopes the workflow actually needs'
            });
        } else if (typeof workflowLevel === 'object' && workflowLevel) {
            for (const [scope, level] of Object.entries(workflowLevel)) {
                if (level === 'write' && SENSITIVE_SCOPES.has(scope)) {
                    add(SEVERITY.WARNING, `workflow grants \`${scope}: write\``, {
                        fix: `drop \`${scope}: write\` unless a step needs it`
                    });
                }
            }
        }

        const jobIds = Object.keys(doc.jobs || {});
        const without = jobIds.filter((id) => doc.jobs[id]
            && doc.jobs[id].permissions === undefined
            && !(doc.jobs[id].uses && !doc.jobs[id]['runs-on']));

        if (workflowLevel === undefined && without.length === jobIds.length && jobIds.length > 0) {
            add(SEVERITY.WARNING,
                'no job declares `permissions`, so every job gets the repository default token', {
                    fix: 'add a workflow-level `permissions: { contents: read }`'
                });
        } else {
            for (const id of without) {
                add(SEVERITY.INFO, `job "${id}" has no explicit \`permissions\``);
            }
        }

        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
            if (!job || typeof job !== 'object') continue;
            if (job.permissions === 'write-all') {
                add(SEVERITY.ERROR, `job "${jobId}" requests \`permissions: write-all\``);
            } else if (job.permissions && typeof job.permissions === 'object') {
                for (const [scope, level] of Object.entries(job.permissions)) {
                    if (level === 'write' && SENSITIVE_SCOPES.has(scope)) {
                        add(SEVERITY.WARNING, `job "${jobId}" grants \`${scope}: write\``);
                    }
                }
            }
        }
    }

    static checkMatrix(job, jobId, add) {
        const strategy = job.strategy;
        if (!strategy || typeof strategy !== 'object') return;
        const matrix = strategy.matrix;
        if (!matrix || typeof matrix !== 'object') {
            add(SEVERITY.ERROR, 'matrix', `job "${jobId}": \`strategy.matrix\` must be a mapping`);
            return;
        }

        const axes = Object.keys(matrix).filter((k) => k !== 'include' && k !== 'exclude');
        if (axes.length === 0 && !matrix.include) {
            add(SEVERITY.ERROR, 'matrix', `job "${jobId}": matrix has no axes`, {
                fix: 'list at least one axis, e.g. `matrix: { node: [18, 20] }`'
            });
            return;
        }
        for (const axis of axes) {
            const value = matrix[axis];
            if (!Array.isArray(value) || value.length === 0) {
                add(SEVERITY.ERROR, 'matrix', `job "${jobId}": matrix axis "${axis}" must be a non-empty list`);
            }
        }

        const { combinations, truncated } = expandMatrix(strategy);
        if (combinations.length === 0) {
            add(SEVERITY.ERROR, 'matrix',
                `job "${jobId}": every combination is excluded, so the job will never run`, {
                    fix: 'relax one entry in `exclude`'
                });
        } else if (combinations.length === 1 && axes.length > 0) {
            add(SEVERITY.WARNING, 'matrix',
                `job "${jobId}": \`exclude\` removes all but one combination`, {
                    fix: 'a single-combination matrix is usually a copy/paste mistake'
                });
        }
        if (truncated) {
            add(SEVERITY.WARNING, 'matrix', `job "${jobId}": matrix expansion was truncated`);
        }
    }

    static checkPermissions(job, jobId, add) {
        if (job.permissions === undefined) {
            add(SEVERITY.INFO, 'permissions', `job "${jobId}" declares no \`permissions\``);
            return;
        }
        const perms = job.permissions;
        if (perms === 'write-all') {
            add(SEVERITY.ERROR, 'permissions', `job "${jobId}" requests \`permissions: write-all\``);
            return;
        }
        if (typeof perms === 'object') {
            for (const [scope, level] of Object.entries(perms)) {
                if (level === 'write' && SENSITIVE_SCOPES.has(scope)) {
                    add(SEVERITY.WARNING, 'permissions', `job "${jobId}" grants \`${scope}: write\``);
                }
            }
        }
    }

    static checkAction(uses, where, add) {
        if (typeof uses !== 'string') {
            add(SEVERITY.ERROR, 'schema', `${where}: \`uses\` must be a string`);
            return;
        }
        if (/^\.\//.test(uses) || uses.startsWith('../')) {
            if (!/action\.ya?ml$/.test(uses) && !/^\.\//.test(uses)) {
                add(SEVERITY.ERROR, 'schema', `${where}: local action "${uses}" must point at a directory containing action.yml`);
            }
            return;
        }
        if (!uses.includes('@')) {
            add(SEVERITY.ERROR, 'schema', `${where}: "${uses}" has no version`, {
                fix: 'pin it, e.g. `uses: ' + uses + '@v4`'
            });
            return;
        }
        const [name, version] = uses.split('@');
        if (!version) {
            add(SEVERITY.ERROR, 'schema', `${where}: "${name}" has an empty version`);
            return;
        }
        if (/^v[12]$/.test(version)) {
            add(SEVERITY.WARNING, 'actions', `${where}: "${uses}" uses a deprecated major (${version})`, {
                fix: 'upgrade to a supported major'
            });
        }
        if (/^[0-9a-f]{40}$/.test(version)) {
            add(SEVERITY.INFO, 'actions', `${where}: "${uses}" is pinned to a full commit SHA (good practice)`);
        } else if (version !== 'main' && version !== 'master') {
            add(SEVERITY.INFO, 'actions', `${where}: "${uses}" is pinned to a tag, not a commit SHA`);
        }
        if (!OFFICIAL_ACTIONS.test(name) && !name.includes('/')) {
            add(SEVERITY.WARNING, 'actions', `${where}: "${uses}" is not owner/action`);
        }
    }

    static checkScript(run, where, add, referencedSecrets, options) {
        const text = String(run);

        // Hardcoded credentials — precise patterns, no false positives on env refs.
        const credentialPatterns = [
            { rx: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id' },
            { rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: 'GitHub token' },
            { rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, name: 'Slack token' },
            { rx: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: 'private key' },
            { rx: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, name: 'JWT' }
        ];
        for (const { rx, name } of credentialPatterns) {
            if (rx.test(text)) {
                add(SEVERITY.ERROR, 'secrets', `${where}: a hardcoded ${name} appears in the script`, {
                    fix: 'move it to `secrets.*` and rotate the exposed value'
                });
                break;
            }
        }

        // Script injection: an untrusted value interpolated into a shell script.
        const injection = /\${{[^}]*(github\.event\.(issue|pull_request|comment|review|discussion)\.(title|body|head\.ref)|github\.head_ref|github\.event\.head_commit\.message|github\.event\.comment\.body)[^}]*}}/;
        if (injection.test(text)) {
            add(SEVERITY.ERROR, 'injection',
                `${where}: untrusted input is interpolated into the shell`, {
                fix: 'pass it through an environment variable: `env: { TITLE: ${{ github.event.issue.title }} }` then use "$TITLE"'
            });
        }

        // Secrets referenced from the script.
        const secretRx = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
        let match;
        while ((match = secretRx.exec(text)) !== null) referencedSecrets.add(match[1]);

        // Package typos: only with --network, and only for bare package names.
        if (options.network && /\bnpm\s+(?:i|install|add)\b/.test(text)) {
            const rx = /\bnpm\s+(?:i|install|add)\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*(@?[a-z0-9][\w@/.-]*)/gi;
            let m;
            while ((m = rx.exec(text)) !== null) {
                const pkg = m[1];
                if (!pkg || pkg.startsWith('.') || pkg.startsWith('/') || pkg.startsWith('-')) continue;
                if (pkg.includes('/') && !pkg.startsWith('@')) continue;
                Checker.verifyPackage(pkg, where, add);
            }
        }
    }

    static verifyPackage(pkg, where, add) {
        const res = spawnSync('npm', ['view', pkg, 'name', '--json'], {
            encoding: 'utf8', timeout: 8000, stdio: 'pipe'
        });
        if (res.error) return; // offline / npm missing → stay quiet
        if (res.status !== 0) {
            add(SEVERITY.ERROR, 'packages', `${where}: package "${pkg}" does not exist on the npm registry`, {
                fix: `check the spelling, or use \`${pkg.replace(/[^\w@/.-]/g, '')}\``
            });
        }
    }

    static report(findings) {
        const errors = findings.filter((f) => f.severity === SEVERITY.ERROR);
        const warnings = findings.filter((f) => f.severity === SEVERITY.WARNING);
        const infos = findings.filter((f) => f.severity === SEVERITY.INFO);

        if (findings.length === 0) {
            Logger.success('Pre-flight check passed — no issues found.');
            return { valid: true, errors: 0, warnings: 0, findings };
        }

        let lastFile = null;
        for (const finding of findings) {
            if (finding.file !== lastFile) {
                Logger.emit('');
                Logger.emit(`${colors.bright}${colors.cyan}📄 ${finding.file}${colors.reset}`);
                lastFile = finding.file;
            }
            const tag = finding.severity === SEVERITY.ERROR ? colors.red('error')
                : finding.severity === SEVERITY.WARNING ? colors.yellow('warn ')
                : colors.gray('info ');
            const loc = finding.line ? colors.gray(`:${finding.line}`) : '';
            Logger.emit(`   ${tag}${loc}  ${finding.message}${colors.gray(`  [${finding.rule}]`)}`);
            if (finding.fix) Logger.emit(`         ${colors.gray('↳')} ${colors.gray(finding.fix)}`);
        }

        Logger.emit('');
        Logger.emit(colors.gray + '─'.repeat(64) + colors.reset);
        if (errors.length === 0) {
            Logger.success(`Pre-flight passed — ${warnings.length} warning(s), ${infos.length} note(s), 0 errors.`);
        } else {
            Logger.error(`Pre-flight failed — ${errors.length} error(s), ${warnings.length} warning(s).`);
        }
        return { valid: errors.length === 0, errors: errors.length, warnings: warnings.length, findings };
    }
}

module.exports = { Checker, SEVERITY, collectFiles: Checker.collectFiles };
