/**
 * AeroCI run orchestrator.
 *
 * Responsibilities kept here (and only here):
 *   • resolve which workflow files to run
 *   • load `.aeroci.json` and the secret file
 *   • drive the Engine
 *   • feed the profiler / reporter
 *   • decide the process exit code
 *
 * The process exit code is published through `process.exitCode` so that buffered
 * stdout/stderr is always flushed — the previous implementation called
 * `process.exit()` which truncated output and killed the reporter mid-write.
 */

const fs = require('fs');
const path = require('path');

const { Logger, colors } = require('../utils/logger');
const { Engine, STATUS, FAILED_STATUSES } = require('./engine');
const { loadConfig } = require('./config');
const { Profiler } = require('./profiler');
const { Reporter } = require('./reporter');
const { Debugger } = require('./debugger');
const { VERSION } = require('../version');

/** Accepts a file, a directory, a project root, or glob-ish patterns. */
function resolveWorkflowFiles(target, cwd, globs) {
    const absolute = path.resolve(cwd, target);

    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return [absolute];

    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
        const direct = listWorkflowsIn(absolute);
        if (direct.length) return direct;
        // A project root: fall back to the conventional location.
        for (const candidate of ['.github/workflows', '.github/workflows.disabled', '.gitea/workflows']) {
            const nested = path.join(absolute, candidate);
            if (fs.existsSync(nested)) {
                const found = listWorkflowsIn(nested);
                if (found.length) return found;
            }
        }
        return [];
    }

    // Not on disk → treat as a glob relative to the cwd.
    const matches = expandGlob(absolute);
    if (matches.length) return matches;

    // Fall back to the configured globs.
    return unique(globs.flatMap((g) => expandGlob(path.resolve(cwd, g))));
}

function listWorkflowsIn(dir) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
        .map((e) => path.join(dir, e.name))
        .sort();
}

/** Tiny glob: supports ** and * and ? — enough for workflow globs. */
function expandGlob(pattern) {
    const normalised = pattern.replace(/\\/g, '/');
    if (!/[*?]/.test(normalised)) return [];

    const starIndex = normalised.search(/[*?]/);
    const base = normalised.slice(0, starIndex).replace(/\/[^/]*$/, '');
    const root = fs.existsSync(base) && fs.statSync(base).isDirectory() ? base : process.cwd();

    const rx = new RegExp('^' + normalised
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '(?:.*/)?') + '$');

    const results = [];
    walk(root, '', rx, results, 0);
    return results.sort();
}

function walk(dir, prefix, rx, out, depth) {
    if (depth > 8 || out.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, rel, rx, out, depth + 1);
        else if (rx.test(rel)) out.push(full);
    }
}

function unique(list) {
    return [...new Set(list)];
}

/** The `runs-on:` of the first job, as a label for the cost projection. */
function firstRunsOn(doc) {
    for (const job of Object.values((doc && doc.jobs) || {})) {
        const value = job && job['runs-on'];
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && value.length) return value.join(',');
    }
    return null;
}

class Runner {
    /**
     * @param {string|null} target  workflow file / directory / glob
     * @param {object} options
     * @returns {Promise<number>} the process exit code
     */
    static async run(target = null, options = {}) {
        const cwd = options.cwd || process.cwd();
        const config = loadConfig(cwd);

        for (const error of config.errors) Logger.warn(error);

        const files = resolveWorkflowFiles(target, cwd, config.workflowGlobs);
        if (files.length === 0) {
            Logger.error(`No workflow files found${target ? ` for "${target}"` : ''}.`);
            Logger.note('  Point AeroCI at a file, a folder, or a glob:');
            Logger.note('    aeroci run .github/workflows/ci.yml');
            Logger.note('    aeroci run .github/workflows');
            return 1;
        }

        const envOverrides = {};
        for (const [key, value] of Object.entries(options.envOverrides || {})) {
            if (key && typeof value === 'string') envOverrides[key] = value;
        }

        const engine = new Engine({
            cwd,
            config,
            debug: !!options.debugOnFailure,
            dryRun: !!options.dryRun,
            onlyJob: options.onlyJob || null,
            event: options.event || null,
            envOverrides,
            envFile: config.envFile,
            inputs: options.inputs || {},
            // Command-line --var wins over .aeroci.json, which wins over .env.
            vars: { ...config.vars, ...(options.vars || {}) },
            secrets: config.secrets,
            shell: options.shell || config.runner.shell || null,
            strictSecrets: config.strictSecrets,
            stepTimeoutMinutes: options.stepTimeout || config.runner.timeoutMinutes || 10,
            maxOutputLines: config.runner.maxOutputLines || 200,
            keepSandbox: !!options.keepSandbox
        });

        let results;
        try {
            results = await engine.run(files);
        } catch (err) {
            Logger.error(`AeroCI crashed: ${err.message}`);
            if (options.debugOnFailure) console.error(err.stack);
            return 1;
        }

        return Runner.finalize(results, options, cwd);
    }

    /** Profiling, reporting, the summary and the exit code. */
    static finalize(results, options = {}, cwd = process.cwd()) {
        let exitCode = 0;
        let totalFailedSteps = 0;
        const workflows = [];

        // One directory for the whole run. Each workflow writes its own
        // `<slug>.<ext>` files inside it, so running several workflows at once
        // cannot make the last one overwrite the others.
        const reportDir = options.reportDir || path.join(cwd, '.aeroci-artifacts', 'report');

        for (const result of results) {
            const reporter = new Reporter({
                workflowName: result.name,
                workflowFile: result.relativeFile
            });
            const profiler = new Profiler(result.name);
            profiler.startMemoryTracking();

            let declaredSteps = 0;
            const stepCountByJob = new Map();
            try {
                const loaded = Engine.loadWorkflowFile(result.file);
                if (loaded.doc) {
                    for (const [id, job] of Object.entries(loaded.doc.jobs || {})) {
                        const count = (job && Array.isArray(job.steps) ? job.steps.length : 0);
                        stepCountByJob.set(id, count);
                        declaredSteps += count;
                    }
                }
            } catch (_) { /* already reported by the engine */ }

            // A step inside a matrix job runs once per combination, so the
            // expected count has to be multiplied out. Otherwise the ratio
            // reports more than 100% and means nothing.
            const expectedSteps = result.jobs.reduce((sum, job) => {
                const instances = Array.isArray(job.matrixInstances) && job.matrixInstances.length
                    ? job.matrixInstances.length
                    : 1;
                return sum + (stepCountByJob.get(job.jobId) || 0) * instances;
            }, 0);

            let executedSteps = 0;
            for (const step of result.steps) {
                const stepOk = !FAILED_STATUSES.has(step.status);
                if (step.status !== STATUS.SKIPPED && step.status !== STATUS.CANCELLED) executedSteps++;
                if (!stepOk) totalFailedSteps++;

                reporter.recordStep({
                    jobId: step.jobId,
                    stepName: step.name,
                    stepId: step.id,
                    status: step.status,
                    durationMs: step.durationMs,
                    exitCode: step.exitCode,
                    script: step.script,
                    uses: step.uses,
                    outputs: step.outputs,
                    warnings: step.warnings,
                    errors: step.errors,
                    notSimulated: step.notSimulated,
                    log: step.log
                });
                profiler.recordStep(step.jobId, step.name, step.durationMs,
                    step.exitCode ?? (stepOk ? 0 : 1), { status: step.status });
            }

            profiler.stopMemoryTracking();
            profiler.saveToHistory();

            const failed = result.status === STATUS.FAILURE;
            if (failed) exitCode = 1;

            const matrixCombinations = result.jobs.reduce((sum, job) => {
                if (!job.strategy) return sum;
                return sum + (Array.isArray(job.matrixInstances) ? job.matrixInstances.length : 1);
            }, 0);

            console.log(colors.gray + '─'.repeat(64) + colors.reset);
            Runner._printSummary(result, { declaredSteps, expectedSteps, executedSteps });
            Reporter.printCoverage({
                expected: expectedSteps,
                executed: executedSteps,
                declared: declaredSteps,
                skipped: result.steps.filter((s) => s.status === STATUS.SKIPPED
                    || s.status === STATUS.CANCELLED),
                combinations: matrixCombinations,
                notSimulated: result.steps.filter((s) => s.notSimulated).length
            });

            if (options.profile) {
                let doc = {};
                try {
                    doc = (Engine.loadWorkflowFile(result.file).doc) || {};
                } catch (_) { /* the engine already reported a bad file */ }
                const runnerLabel = firstRunsOn(doc) || 'ubuntu-latest';
                console.log(colors.gray + '─'.repeat(64) + colors.reset);
                profiler.printAll({ doc, runner: runnerLabel });
            }

            if (options.report) {
                const formats = options.reportFormats || ['json', 'markdown', 'html', 'junit'];
                reporter.generateAll({ formats, dir: reportDir });
            }
            if (options.annotations) reporter.emitAnnotations();
            if (options.reproducers !== false) reporter.printReproducers();

            workflows.push({
                name: result.name,
                file: result.relativeFile,
                status: result.status,
                durationMs: result.durationMs,
                notSimulated: result.steps.filter((s) => s.notSimulated).length,
                jobs: result.jobs.map((j) => ({
                    id: j.jobId,
                    status: j.status,
                    durationMs: j.durationMs,
                    steps: (j.steps || []).length
                })),
                event: result.eventName,
                slug: reporter.slug,
                // Where the step-level detail for this workflow lives, relative
                // to the index file itself, so the directory can be moved or
                // zipped and the reference still resolves.
                detail: options.report ? `${reporter.slug}.json` : null
            });
        }

        // The run summary. It is a different thing from the per-workflow reports
        // and lives beside them under its own name, so neither can clobber the
        // other: `index.json` is the run, `<slug>.json` is one workflow.
        if (options.json || options.report) {
            const out = path.resolve(cwd, options.jsonPath
                || path.join('.aeroci-artifacts', 'report', 'index.json'));
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, `${JSON.stringify({
                generator: `AeroCI ${VERSION}`,
                generatedAt: new Date().toISOString(),
                event: results.length === 1 ? results[0].eventName : null,
                exitCode,
                workflows
            }, null, 2)}\n`, 'utf8');
            if (options.json) {
                Logger.info(`Run summary → ${colors.cyan(path.relative(cwd, out) || out)}`);
            }
        }

        if (exitCode !== 0) {
            Logger.error(`${totalFailedSteps} step(s) failed across ${results.length} workflow(s).`);
            if (options.debugOnFailure) {
                const firstFailure = results.flatMap((r) => r.steps).find((s) => FAILED_STATUSES.has(s.status));
                if (firstFailure) Debugger.start({ step: firstFailure, results });
            }
        } else {
            const unverified = results.reduce((n, r) => n + r.steps.filter((s) => s.notSimulated).length, 0);
            if (unverified) {
                Logger.warn(`All ${results.length} workflow(s) passed, but ${unverified} step(s) were not`
                    + ` simulated — those are unverified.`);
            } else {
                Logger.success(`All ${results.length} workflow(s) passed.`);
            }
        }

        return exitCode;
    }

    static _printSummary(result, { declaredSteps, expectedSteps, executedSteps }) {
        const failedJobs = result.jobs.filter((j) => FAILED_STATUSES.has(j.status));
        const skippedJobs = result.jobs.filter((j) => j.status === STATUS.SKIPPED);
        const notSimulated = result.steps.filter((s) => s.notSimulated).length;
        const expanded = expectedSteps > declaredSteps;

        Logger.metric('Result', result.status === STATUS.SUCCESS
            ? colors.green('success') : colors.red('failure'));
        Logger.metric('Jobs', `${result.jobs.length} total · ${failedJobs.length} failed · ${skippedJobs.length} skipped`);
        if (expectedSteps) {
            Logger.metric('Steps', `${executedSteps}/${expectedSteps} executed`
                + (expanded ? colors.gray(` (${declaredSteps} declared, matrix expanded)`) : ''));
        }
        Logger.metric('Duration', `${(result.durationMs / 1000).toFixed(2)}s`);
        if (notSimulated) {
            Logger.metric('Not simulated', colors.yellow(`${notSimulated} step(s) — see the warnings above`));
        }
        if (result.secretsMissing && result.secretsMissing.length) {
            Logger.metric('Missing secrets', colors.yellow(result.secretsMissing.join(', ')));
        }
    }
}

module.exports = { Runner, resolveWorkflowFiles, expandGlob };
