#!/usr/bin/env node

/**
 * AeroCI command line.
 *
 * Every command is a thin wrapper: it parses arguments, calls the module that
 * does the work, and turns the result into an exit code. No business logic
 * lives here.
 *
 * The process exit code is set through `process.exitCode`, never
 * `process.exit()`, so buffered stdout is always flushed before the process
 * ends — a truncated report is worse than a slow one.
 */

const path = require('path');
const fs = require('fs');
const { Command, Option } = require('commander');

const { Logger, colors } = require('./utils/logger');
const { Checker } = require('./core/checker');
const { Runner } = require('./core/runner');
const { Debugger } = require('./core/debugger');
const { Initializer } = require('./core/initializer');
const { Analyzer } = require('./core/analyzer');
const { Profiler } = require('./core/profiler');
const { Security } = require('./core/security');
const { Reporter } = require('./core/reporter');
const { Versions } = require('./core/versions');
const { Server } = require('./server');
const { VERSION } = require('./version');

const DEFAULT_TARGET = '.github/workflows';

/** Only the non-zero defect counts, so the message is not a row of zeroes. */
function describeDefects(defects) {
    const labels = {
        deadSteps: 'dead step',
        duplicateSteps: 'duplicate step',
        unusedOutputs: 'unused output',
        shellIssues: 'shell issue',
        redundantJobs: 'redundant job'
    };
    return Object.entries(defects)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${count} ${labels[key]}${count === 1 ? '' : 's'}`)
        .join(', ');
}

/**
 * `--env A=1 --env B=2`
 *
 * A variadic option (`--env <k=v...>`) also swallows the positional workflow
 * path when the option comes first, so `aeroci run --env A=1 ci.yml` silently
 * treats `ci.yml` as an environment entry. Collecting one value per flag
 * removes the ambiguity.
 */
function collectEnv(value, previous) {
    const separator = value.indexOf('=');
    if (separator < 1) {
        Logger.warn(`Ignoring --env "${value}": expected KEY=value`);
        return previous;
    }
    return { ...previous, [value.slice(0, separator)]: value.slice(separator + 1) };
}

const program = new Command();

program
    .name('aeroci')
    .description('AeroCI — run and audit your GitHub Actions workflows locally')
    .version(VERSION, '-V, --version', `output the version number (${VERSION})`)
    .showHelpAfterError('(run `aeroci --help` for usage)')
    .configureOutput({
        outputError: (str, write) => write(colors.red(str))
    });

// ── init ──────────────────────────────────────────────────────────────────────

program
    .command('init')
    .description('create .aeroci.json, a sample workflow and a .gitignore entry')
    .option('-f, --force', 'overwrite files that already exist')
    .option('--no-sample', 'do not write a sample workflow')
    .option('--no-env', 'do not write .env.example')
    .action((options) => {
        Logger.banner();
        Initializer.init({ force: !!options.force, sample: options.sample, env: options.env });
    });

// ── check ────────────────────────────────────────────────────────────────────

program
    .command('check')
    .description('validate workflows: schema, actions, secrets, graph, matrix, shell')
    .argument('[target]', 'file, directory or project root', DEFAULT_TARGET)
    .option('--security', 'also run the security audit')
    .option('--analyze', 'also run the workflow analyzer')
    .option('--network', 'also ask the npm registry whether each installed package exists (needs the network)')
    .action((target, options) => {
        Logger.banner();
        // Off unless asked: the check shells out to `npm view` per package, and
        // a checker that reaches the network without being told to is a trap.
        const report = Checker.check(target, { network: !!options.network });
        if (options.security) {
            Logger.emit('');
            Security.audit(target);
        }
        if (options.analyze) {
            Logger.emit('');
            Analyzer.analyze(target);
        }
        // Errors fail the command; warnings are advisory and do not.
        process.exitCode = report.errors > 0 ? 1 : 0;
    });

// ── run ──────────────────────────────────────────────────────────────────────

program
    .command('run')
    .description('run workflows in an isolated sandbox')
    .argument('[target]', 'file, directory, glob or project root', DEFAULT_TARGET)
    .option('-d, --debug', 'drop into a matching shell if a step fails')
    .option('--only-job <id>', 'run only this job id')
    .option('--event <name>', 'event to simulate', 'push')
    .option('--timeout <minutes>', 'per-step timeout in minutes', (v) => Number(v))
    .option('--env <KEY=VALUE>', 'set an environment variable (repeatable)', collectEnv, {})
    .option('--var <KEY=VALUE>', 'set a repository variable (repeatable)', collectEnv, {})
    .option('--keep', 'keep the sandbox on disk after the run')
    .option('--dry-run', 'resolve and print what would run, without running it')
    .option('--report', 'write json, markdown, html and junit reports under .aeroci-artifacts/report/')
    .option('--report-dir <dir>', 'where those reports go', '.aeroci-artifacts/report')
    .option('--format <list>', 'comma-separated: json,markdown,html,junit', 'json,markdown,html,junit')
    .option('--json [path]', 'write the run summary as JSON (default: alongside the reports)')
    .option('--no-annotations', 'do not emit ::error / ::warning workflow commands')
    .option('--allow-download', 'let AeroCI fetch a runtime from nodejs.org when a workflow needs a version this machine lacks')
    .option('--deny-download', 'never fetch a runtime; a setup-node step that needs one fails, as it would on a runner')
    .option('--allow-network', 'let the workflow\'s own run: steps reach the network, as they would on a runner')
    .option('--deny-network', 'deny the workflow\'s run: steps outbound access (the default, on a machine that can enforce it)')
    .option('--profile', 'show the timing table and the cost projection')
    .action(async (target, options) => {
        Logger.banner();
        const exitCode = await Runner.run(target, {
            cwd: process.cwd(),
            event: options.event,
            debugOnFailure: !!options.debug,
            onlyJob: options.onlyJob || null,
            report: !!options.report,
            reportDir: options.reportDir,
            reportFormats: String(options.format).split(',').map((f) => f.trim()).filter(Boolean),
            stepTimeout: Number.isFinite(options.timeout) ? options.timeout : undefined,
            envOverrides: options.env,
            vars: options.var,
            keepSandbox: !!options.keep,
            dryRun: !!options.dryRun,
            json: !!options.json,
            jsonPath: typeof options.json === 'string' ? options.json : null,
            annotations: options.annotations !== false,
            reproducers: true,
            allowDownload: options.allowDownload ? true : (options.denyDownload ? false : undefined),
            allowNetwork: options.allowNetwork ? true : (options.denyNetwork ? false : undefined),
            profile: !!options.profile
        });
        process.exitCode = exitCode;
    });

// ── debug ────────────────────────────────────────────────────────────────────

program
    .command('debug')
    .description('open a shell with the CI environment, in an isolated copy of the project')
    .option('--event <name>', 'event to simulate', 'push')
    .option('--keep', 'keep the sandbox on disk afterwards')
    .option('--expose-env', 'also export your .env values as plain variables (a runner does NOT do this)')
    .action(async (options) => {
        const exitCode = await Debugger.start({
            cwd: process.cwd(),
            event: options.event,
            keep: !!options.keep,
            exposeEnv: !!options.exposeEnv
        });
        process.exitCode = exitCode;
    });

// ── analyze ──────────────────────────────────────────────────────────────────

program
    .command('analyze')
    .description('workflow structure: graph, dead steps, duplicates, unused outputs, matrix, complexity')
    .argument('[target]', 'file, directory or project root', DEFAULT_TARGET)
    .option('--json', 'print the analysis as JSON')
    .option('--strict', 'exit non-zero on dead steps, duplicate steps, unused outputs, shell issues or redundant jobs')
    .action((target, options) => {
        if (options.json) Logger.setStderr(true);
        Logger.banner();
        // `--json` is a promise that stdout parses. Everything AeroCI says about
        // its own progress moves to stderr so the JSON owns stdout — the banner,
        // the tables, the per-workflow headers. One switch, so the next progress
        // line someone adds cannot quietly break the pipe.
        const report = Analyzer.analyze(target, { print: !options.json });
        if (options.json) Logger.answer(report);
        // The complexity score is a number for comparing workflows, not a
        // verdict, so it never fails the command. Only real defects can.
        if (options.strict && report.defects) {
            const d = report.defects;
            const total = d.deadSteps + d.unusedOutputs + d.duplicateSteps
                + d.shellIssues + d.redundantJobs;
            if (total > 0) {
                Logger.error(`${total} actionable defect(s) found `
                    + `(${describeDefects(d)}).`);
                process.exitCode = 1;
            }
        }
    });

// ── security ─────────────────────────────────────────────────────────────────

program
    .command('security')
    .description('audit for template injection, supply chain, token scope and exfiltration')
    .argument('[target]', 'file, directory or project root', DEFAULT_TARGET)
    .option('--report [path]', 'write a markdown report (default: security-report.md)')
    .option('--json', 'print findings as JSON instead of text')
    .action((target, options) => {
        if (options.json) Logger.setStderr(true);
        Logger.banner();
        const { exitCode } = Security.audit(target, {
            // No default on the option itself: with one, `!!options.report` was
            // true for a bare `aeroci security`, so every audit wrote
            // security-report.md into the caller's project whether they asked
            // for a file or not.
            report: !!options.report,
            reportPath: typeof options.report === 'string' ? options.report : 'security-report.md',
            format: options.json ? 'json' : 'text'
        });
        // Critical and high findings are what make CI fail; lower ones do not.
        process.exitCode = exitCode;
    });

// ── profile ──────────────────────────────────────────────────────────────────

program
    .command('profile')
    .description('run history and trend against your own previous runs')
    .argument('[target]', 'file, directory or project root', DEFAULT_TARGET)
    .option('--limit <n>', 'how many runs to show', (v) => Number(v), 20)
    .action((target, options) => {
        Logger.banner();
        Profiler.showHistory({ limit: options.limit });
        const yaml = require('js-yaml');
        for (const file of Checker.collectFiles(target)) {
            let doc;
            try {
                doc = yaml.load(fs.readFileSync(file, 'utf8'), { filename: file });
            } catch (_) { continue; }
            if (!doc) continue;
            const notes = Profiler.observations(doc, []);
            if (notes.length) {
                Logger.emit('');
                Logger.info(`Observations for ${path.relative(process.cwd(), file)}`);
                Profiler.printObservations(notes);
            }
        }
    });

// ── report ───────────────────────────────────────────────────────────────────

program
    .command('report')
    .description('re-render the last run in other formats, diff two workflows, or list their history')
    .addOption(new Option('--format <list>', 'comma-separated: json,markdown,html,junit')
        .default('json,markdown,html,junit'))
    .option('--run <dir>', 'the report directory to read from', '.aeroci-artifacts/report')
    .option('--out <dir>', 'where to write the re-rendered reports')
    .option('--diff <a:b>', 'structural diff between two workflow files')
    .option('--history [dir]', 'commits that touched the workflow directory')
    .action((options) => {
        Logger.banner();

        if (options.diff) {
            // Split on the last colon so a Windows drive letter still works.
            const cut = options.diff.lastIndexOf(':');
            const fileA = cut > 1 ? options.diff.slice(0, cut) : '';
            const fileB = cut > 1 ? options.diff.slice(cut + 1) : '';
            if (!fileA || !fileB) {
                Logger.error('Usage: aeroci report --diff old.yml:new.yml');
                process.exitCode = 2;
                return;
            }
            const { changes } = Reporter.diff(fileA, fileB);
            process.exitCode = changes > 0 ? 1 : 0;
            return;
        }

        if (options.history !== undefined) {
            const dir = typeof options.history === 'string' ? options.history : DEFAULT_TARGET;
            const history = Reporter.workflowHistory(dir);
            if (!history.ok) {
                Logger.error(`Could not read git history: ${history.reason}`);
                process.exitCode = 1;
                return;
            }
            if (history.commits.length === 0) {
                Logger.warn(`No commits touch ${dir}.`);
                return;
            }
            Logger.table(
                ['Commit', 'Date', 'Subject'],
                history.commits.map((c) => [c.hash, c.date, c.subject])
            );
            return;
        }

        rerenderLastRun(options);
    });

/**
 * Rebuild reports from a stored run.
 *
 * `aeroci run --report` writes the step detail as JSON. That is enough to
 * re-render every other format later, so converting a run to a JUnit file for
 * an existing CI collector does not mean executing the workflow again.
 */
function rerenderLastRun(options) {
    const runDir = path.resolve(process.cwd(), options.run);
    const indexFile = path.join(runDir, 'index.json');

    if (!fs.existsSync(indexFile)) {
        Logger.warn(`No run recorded in ${path.relative(process.cwd(), runDir) || options.run}.`);
        Logger.note('  Produce one with:  aeroci run --report --format json');
        process.exitCode = 1;
        return;
    }

    let index;
    try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (err) {
        Logger.error(`${indexFile}: ${err.message}`);
        process.exitCode = 1;
        return;
    }

    const formats = String(options.format).split(',').map((f) => f.trim()).filter(Boolean);
    const missing = formats.filter((f) => !['json', 'markdown', 'html', 'junit'].includes(f));
    if (missing.length) {
        Logger.error(`Unknown format(s): ${missing.join(', ')}`);
        Logger.note('  Valid: json, markdown, html, junit');
        process.exitCode = 2;
        return;
    }

    Logger.info(`${index.workflows.length} workflow(s) recorded at ${index.generatedAt}`);
    Logger.metric('Exit code', String(index.exitCode ?? 'unknown'));
    Logger.emit('');

    const outDir = path.resolve(process.cwd(), options.out || runDir);
    let rendered = 0;
    let skipped = 0;

    for (const workflow of index.workflows) {
        const detailFile = workflow.detail
            ? path.resolve(path.dirname(indexFile), workflow.detail)
            : null;
        if (!detailFile || !fs.existsSync(detailFile)) {
            Logger.warn(`${workflow.name}: no step detail stored (run again with --report --format json)`);
            skipped++;
            continue;
        }
        const reporter = Reporter.fromJSON(JSON.parse(fs.readFileSync(detailFile, 'utf8')));
        // Keep the same slug the run used, so re-rendering overwrites its own
        // output rather than starting a second series of files.
        reporter.slug = workflow.slug || reporter.slug;
        reporter.generateAll({ formats, dir: outDir });
        rendered++;
    }

    if (rendered) {
        Logger.emit('');
        Logger.metric('Re-rendered', `${rendered} workflow(s) → ${path.relative(process.cwd(), outDir) || outDir}`);
    }
    if (skipped) {
        Logger.note(`${skipped} workflow(s) had no stored step detail.`);
        Logger.note('  A run keeps step detail only if it was asked for it:');
        Logger.note('    aeroci run --report --format json');
    }
    process.exitCode = 0;
}

// ── versions ─────────────────────────────────────────────────────────────────

program
    .command('versions')
    .description('how every action is pinned, and whether AeroCI simulates it')
    .argument('[target]', 'file, directory or project root', DEFAULT_TARGET)
    .option('--check-remote', 'also ask the GitHub API for the latest release (needs the network)')
    .action(async (target, options) => {
        Logger.banner();
        const report = Versions.inspect(target);
        Versions.print(report);
        if (options.checkRemote) {
            Logger.emit('');
            await Versions.checkRemote(report.references);
        }
        process.exitCode = report.exitCode;
    });

// ── ui ───────────────────────────────────────────────────────────────────────

program
    .command('ui')
    .description('serve a read-only dashboard of the workflows in this project')
    .option('-p, --port <number>', 'port to listen on', (v) => Number(v), 3500)
    .addOption(new Option('--host <address>', 'address to bind to')
        .default('127.0.0.1')
        .env('AEROCI_HOST'))
    .action(async (options) => {
        await Server.start({
            port: options.port,
            host: options.host,
            cwd: process.cwd()
        });
    });

program.parseAsync(process.argv).catch((err) => {
    Logger.error(err && err.message ? err.message : String(err));
    if (process.env.AEROCI_DEBUG) Logger.emitErr(err && err.stack);
    process.exitCode = 1;
});
