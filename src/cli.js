#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { Logger, colors } = require('./utils/logger');
const { Checker } = require('./core/checker');
const { Runner } = require('./core/runner');
const { Debugger } = require('./core/debugger');
const { Initializer } = require('./core/initializer');
const { Server } = require('./server');

const program = new Command();

program
    .name('drift')
    .description('🌪️ CI-Drift: Local Digital Twin & Pipeline Simulator for GitHub Actions')
    .version('1.0.0');

// 1. Initializer Command
program
    .command('init')
    .description('Initializes CI-Drift config (.drift.json) and sample GitHub Actions workflow')
    .action(() => {
        Initializer.init();
    });

// 2. Pre-flight Check Command
program
    .command('check [workflow]')
    .description('Validates workflow syntax, missing secrets, and path drifts locally')
    .action((workflowFile = '.github/workflows') => {
        Logger.banner();
        Logger.info('Scanning workflow files for drifts & syntax errors...');
        Checker.check(workflowFile);
    });

// 3. Simulator Runner Command
program
    .command('run [workflow]')
    .description('Simulates CI pipeline locally inside an isolated ephemeral runner')
    .option('-d, --debug', 'Enter interactive debug sandbox if a step fails')
    .action((workflowFile = '.github/workflows/main.yml', options) => {
        Logger.banner();
        Runner.run(workflowFile, { debugOnFailure: options.debug });
    });

// 4. Debug Sandbox Command
program
    .command('debug')
    .description('Spawns an interactive debug sandbox with simulated CI context & env vars')
    .action(() => {
        Logger.banner();
        Debugger.start();
    });

// 5. Web UI Dashboard Command (VelociRadix Powered)
program
    .command('ui')
    .description('Launches the interactive local web dashboard (VelociRadix Engine) on port 3500')
    .option('-p, --port <number>', 'Port to listen on', 3500)
    .action((options) => {
        Server.start(parseInt(options.port));
    });

program.parse(process.argv);
