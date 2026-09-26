/**
 * AeroCI test harness.
 *
 * No test framework: the suite has to run on a bare checkout with nothing but
 * the runtime dependencies, and a self-contained runner is a hundred lines.
 * A test that cannot fail is worse than no test, so every assertion here
 * actually compares and every failure prints both sides.
 */

const assert = require('assert');
const { Logger, colors } = require('../src/utils/logger');

const state = {
    current: null,
    passed: 0,
    failed: 0,
    failures: [],
    pending: [],
    chain: Promise.resolve(),
    only: process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
};

function suite(name, body) {
    if (state.only && !name.includes(state.only)) return;
    console.log(`\n${colors.bright}${colors.cyan}${name}${colors.reset}`);
    const previous = state.current;
    state.current = name;
    try {
        body();
    } catch (err) {
        // A throw outside a test() still belongs to this suite.
        state.failed++;
        state.failures.push({ suite: name, test: '(suite body)', err });
        console.log(`  ${colors.red}✖ the suite itself threw${colors.reset}`);
    }
    state.current = previous;
}

function test(name, body) {
    try {
        const result = body();
        if (result && typeof result.then === 'function') {
            throw new Error('test() is synchronous; use asyncTest()');
        }
        state.passed++;
        console.log(`  ${colors.green}✔${colors.reset} ${name}`);
    } catch (err) {
        state.failed++;
        state.failures.push({ suite: state.current, test: name, err });
        console.log(`  ${colors.red}✖ ${name}${colors.reset}`);
        console.log(`    ${colors.red}${String(err.message).split('\n').join(`\n    `)}${colors.reset}`);
    }
}

/**
 * An asynchronous test.
 *
 * The suite body itself stays synchronous, so each test is appended to a single
 * promise chain rather than started immediately. Running them concurrently
 * would interleave the engine's own output and — worse for these tests — let
 * several real sandraces run at once, so a failure would be impossible to
 * attribute.
 */
function asyncTest(name, body) {
    const suiteName = state.current;
    const promise = state.chain.then(async () => {
        try {
            await body();
            state.passed++;
            console.log(`  ${colors.green}✔${colors.reset} ${name}`);
        } catch (err) {
            state.failed++;
            state.failures.push({ suite: suiteName, test: name, err });
            console.log(`  ${colors.red}✖ ${name}${colors.reset}`);
            console.log(`    ${colors.red}${String(err.message).split('\n').join(`\n    `)}${colors.reset}`);
        }
    });
    // The chain must not reject, or every later test would be skipped.
    state.chain = promise.catch(() => {});
    state.pending.push(promise);
    return promise;
}

/** Assert that `body` throws, and return the error for further checks. */
function throws(body, match) {
    let err = null;
    try {
        body();
    } catch (caught) {
        err = caught;
    }
    assert.ok(err, 'expected the call to throw, but it returned');
    if (match) {
        assert.ok(match.test(err.message),
            `expected the error to match ${match}, got: ${err.message}`);
    }
    return err;
}

function summary() {
    console.log(`\n${'─'.repeat(64)}`);
    if (state.failed === 0) {
        console.log(`${colors.green}✔ ${state.passed} test(s) passed${colors.reset}`);
        return 0;
    }
    console.log(`${colors.red}✖ ${state.failed} of ${state.passed + state.failed} test(s) failed${colors.reset}\n`);
    for (const f of state.failures) {
        console.log(`  ${colors.red}${f.suite} › ${f.test}${colors.reset}`);
        const frame = (f.err.stack || '').split('\n').find((l) => l.includes('/tests/'));
        if (frame) console.log(`    ${colors.gray}at ${frame.trim()}${colors.reset}`);
    }
    return 1;
}

/**
 * A failing test has to fail the process, whether or not the suite remembered
 * to call summary(). A green exit code on a red run is the one bug a test
 * harness cannot have.
 */
process.on('exit', () => {
    if (state.failed > 0) process.exitCode = 1;
});

/**
 * Wait for every async test, then flush again if they queued more.
 *
 * `beforeExit` fires when the event loop has nothing left to do, which is
 * exactly when a parked async test would otherwise be abandoned. The guard
 * keeps the handler from re-entering itself; anything the tests queue while
 * draining is picked up on the next pass.
 */
let draining = false;
process.on('beforeExit', () => {
    if (draining || state.pending.length === 0) return;
    draining = true;
    const queue = state.pending.splice(0);
    Promise.all(queue).catch(() => { /* each test already reported itself */ })
        .finally(() => { draining = false; });
});

module.exports = { suite, test, asyncTest, throws, assert, summary, state, Logger, colors };
