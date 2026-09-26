#!/usr/bin/env node

/**
 * AeroCI test entry point.
 *
 * Every suite runs in its own process, because several of them change the
 * process's working directory or set `process.exitCode`, and a failure in one
 * must not decide the outcome of another. The exit code is 0 only if all of
 * them passed.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SUITES = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const verbose = process.argv.includes('--verbose');

const selected = only ? SUITES.filter((f) => f.includes(only)) : SUITES;

if (selected.length === 0) {
    console.error(only ? `No suite matches --only ${only}` : 'No test suites found.');
    console.error(`Available: ${SUITES.join(', ')}`);
    process.exitCode = 1;
} else {
    let failed = 0;
    const durations = [];

    for (const suite of selected) {
        const started = Date.now();
        const result = spawnSync(process.execPath, [path.join(DIR, suite), ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR || '1' }
        });
        const ms = Date.now() - started;
        durations.push([suite, ms]);
        // A suite that dies without an exit code of its own (a crash, an
        // unhandled rejection) has not passed.
        if (result.status !== 0) failed++;
    }

    console.log(`\n${'═'.repeat(64)}`);
    if (verbose) {
        for (const [suite, ms] of durations) {
            console.log(`  ${suite.padEnd(30)} ${String(ms).padStart(6)} ms`);
        }
        console.log(`${'─'.repeat(64)}`);
    }
    console.log(`${selected.length - failed}/${selected.length} suite(s) passed`);
    process.exitCode = failed === 0 ? 0 : 1;
}
