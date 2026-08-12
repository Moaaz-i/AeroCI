#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { Logger, colors } = require('./utils/logger');
const { Checker } = require('./core/checker');
const { Runner } = require('./core/runner');
const { Debugger } = require('./core/debugger');
const { Initializer } = require('./core/initializer');
const { Analyzer } = require('./core/analyzer');
const { Profiler } = require('./core/profiler');
const { Security } = require('./core/security');
const { Reporter } = require('./core/reporter');
const { Actions } = require('./core/actions');
const { Server } = require('./server');

const program = new Command();

program
    .name('aeroci')
    .description('🌪️ AeroCI: Local Digital Twin & Pipeline Simulator for GitHub Actions v2.0.0')
    .version('2.0.0');

// ── 1. Init ──────────────────────────────────────────────────────────────────
program
    .command('init')
    .description('Initialize AeroCI config (.aeroci.json) and sample workflow')
    .action(() => {
        Initializer.init();
    });

// ── 2. Check ─────────────────────────────────────────────────────────────────
program
    .command('check [workflow]')
    .description('Validate workflow syntax, missing secrets, and pipeline issues')
    .option('--security', 'Also run the security hardening audit')
    .option('--analyze',  'Also run the deep workflow analyzer')
    .action((workflowFile = null, options) => {
        Logger.banner();
        Logger.info('Scanning workflow files for issues & syntax errors...');
        Checker.check(workflowFile || '.github/workflows');
        if (options.security) {
            console.log();
            Security.audit(workflowFile || '.github/workflows');
        }
        if (options.analyze) {
            console.log();
            Analyzer.analyze(workflowFile || '.github/workflows');
        }
    });

// ── 3. Run ───────────────────────────────────────────────────────────────────
program
    .command('run [workflow]')
    .description('Simulate CI pipeline locally inside an isolated ephemeral sandbox')
    .option('-d, --debug',           'Enter interactive debug sandbox if a step fails')
    .option('--only-job <id>',       'Run only a specific job by its ID')
    .option('--report',              'Generate JUnit XML, HTML, Markdown & JSON reports after run')
    .option('--timeout <minutes>',   'Per-step timeout in minutes (default: 10)', parseInt)
    .option('--env <key=value...>',  'Inject environment variables into the run (repeatable)')
    .action((workflowFile = null, options) => {
        Logger.banner();

        // Parse --env KEY=VAL entries
        const envOverrides = {};
        if (options.env) {
            const envList = Array.isArray(options.env) ? options.env : [options.env];
            for (const entry of envList) {
                const idx = entry.indexOf('=');
                if (idx > 0) {
                    envOverrides[entry.slice(0, idx)] = entry.slice(idx + 1);
                }
            }
        }

        Runner.run(workflowFile, {
            debugOnFailure: options.debug,
            onlyJob: options.onlyJob || null,
            report: !!options.report,
            stepTimeout: options.timeout || 10,
            envOverrides
        });
    });

// ── 4. Debug Sandbox ─────────────────────────────────────────────────────────
program
    .command('debug')
    .description('Spawn an interactive debug sandbox with simulated CI environment vars')
    .action(() => {
        Logger.banner();
        Debugger.start();
    });

// ── 5. Analyze ───────────────────────────────────────────────────────────────
program
    .command('analyze [workflow]')
    .description('Deep workflow intelligence: dependency graph, dead steps, complexity score & more')
    .action((workflowFile = null) => {
        Logger.banner();
        Analyzer.analyze(workflowFile || '.github/workflows');
    });

// ── 6. Security Audit ────────────────────────────────────────────────────────
program
    .command('security [workflow]')
    .description('Run dedicated security hardening audit (supply chain, injection, OIDC, etc.)')
    .option('--report', 'Save security-report.md after audit')
    .action((workflowFile = null, options) => {
        Logger.banner();
        Security.audit(workflowFile || '.github/workflows', { generateReport: !!options.report });
    });

// ── 7. Profile ───────────────────────────────────────────────────────────────
program
    .command('profile')
    .description('Show run history, trends, and performance analytics from past runs')
    .action(() => {
        Logger.banner();
        Profiler.showHistory();
    });

// ── 8. Report ────────────────────────────────────────────────────────────────
program
    .command('report')
    .description('Generate reports from the last run (use aeroci run --report to record)')
    .option('--format <formats>', 'Comma-separated formats: html,json,junit,markdown', 'html,json,junit,markdown')
    .option('--diff <fileA:fileB>', 'Show structural diff between two workflow files')
    .option('--changelog', 'Generate changelog from git history of workflow files')
    .action((options) => {
        Logger.banner();

        if (options.diff) {
            const [fileA, fileB] = options.diff.split(':');
            if (fileA && fileB) {
                Reporter.diff(fileA, fileB);
            } else {
                Logger.error('Usage: aeroci report --diff fileA.yml:fileB.yml');
            }
            return;
        }

        if (options.changelog) {
            Reporter.generateChangelog();
            return;
        }

        // Check for last run JSON
        const lastRun = path.join(process.cwd(), 'aeroci-run.json');
        if (fs.existsSync(lastRun)) {
            const data = JSON.parse(fs.readFileSync(lastRun, 'utf8'));
            const reporter = new Reporter({ workflowName: data.meta?.workflow, workflowFile: data.meta?.file });
            for (const step of (data.steps || [])) reporter.recordStep(step);
            const formats = options.format.split(',').map(f => f.trim());
            reporter.generateAll({ formats });
        } else {
            Logger.warn('No aeroci-run.json found. Run `aeroci run --report` first to record a run.');
        }
    });

// ── 9. Action Versions ────────────────────────────────────────────────────────
program
    .command('versions [workflow]')
    .description('Check action versions in your workflows against known latest releases')
    .action(async (workflowFile = null) => {
        Logger.banner();
        const yaml = require('js-yaml');
        const dir = path.resolve(process.cwd(), workflowFile || '.github/workflows');
        let files = [];

        if (fs.existsSync(dir)) {
            const stat = fs.statSync(dir);
            if (stat.isDirectory()) {
                files = fs.readdirSync(dir)
                    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
                    .map(f => path.join(dir, f));
            } else {
                files = [dir];
            }
        }

        for (const file of files) {
            const relPath = path.relative(process.cwd(), file);
            console.log(`\n${colors.bright}${colors.cyan}🔍 Checking versions in: ${relPath}${colors.reset}`);
            const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
            const steps = Object.values(doc.jobs || {}).flatMap(j => j.steps || []);
            await Actions.checkActionVersions(steps);
        }
    });

// ── 10. Web UI Dashboard ──────────────────────────────────────────────────────
program
    .command('ui')
    .description('Launch the interactive web dashboard (Velociradix) on port 3500')
    .option('-p, --port <number>', 'Port to listen on', 3500)
    .action(async (options) => {
        await Server.start(parseInt(options.port));
    });

program.parse(process.argv);
