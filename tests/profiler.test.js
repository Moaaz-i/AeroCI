/**
 * The profiler's numbers are the ones people act on — "did my change make it
 * slower?" — so the arithmetic and the wording both have to be right. Two bugs
 * lived here: a static reached through `this` that made `aeroci run --profile`
 * throw after printing every table, and a signed percentage printed next to a
 * word that already carried the direction, so a faster run read
 * "2ms (-4%) faster".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { suite, test, assert, Logger } = require('./harness');
const { Profiler } = require('../src/core/profiler');

Logger.setQuiet(true);

/**
 * Colour codes wrap the number being asserted on, so they come off first.
 * `Logger` colours only when stdout is a TTY, and the suite runner is not
 * one — but a developer running this file by hand is.
 */
const ANSI = /\x1b\[[0-9;]*m/g;

/** Run `fn` with console.log captured, and hand back what it printed. */
function captured(fn) {
    const lines = [];
    const real = console.log;
    // `Logger.metric` writes through `console.log` but honours the quiet flag,
    // and the harness turns it on for the whole suite. The trend table is the
    // thing under test, so it has to be allowed to speak.
    Logger.setQuiet(false);
    console.log = (...args) => lines.push(args.join(' '));
    try {
        fn();
    } finally {
        console.log = real;
        Logger.setQuiet(true);
    }
    return lines.join('\n').replace(ANSI, '');
}

/** A throwaway history file with the given runs, oldest first. */
function history(runs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-prof-'));
    const file = path.join(dir, 'history.jsonl');
    fs.writeFileSync(file, runs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return { dir, file };
}

const RUN = (workflow, totalMs) => ({
    workflow,
    file: '.github/workflows/ci.yml',
    event: 'push',
    status: 'success',
    totalMs,
    steps: 4,
    passed: 4,
    failed: 0,
    peakMemoryMB: 8,
    date: new Date().toISOString()
});

suite('profiler · the trend arithmetic', () => {
    test('the baseline is the runs before this one', () => {
        const { dir, file } = history([
            RUN('CI', 100), RUN('CI', 200), RUN('CI', 50)
        ]);
        try {
            const trend = Profiler.trends('CI', { historyFile: file });
            assert.ok(trend, 'a trend needs at least one previous run');
            assert.strictEqual(trend.latest, 50, 'the latest run is the one just measured');
            assert.strictEqual(trend.baseline.runs, 2, 'the baseline is the two before it');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the median is used, not the mean', () => {
        // 10, 10, 1000 has a mean of 340 and a median of 10. A single slow
        // afternoon must not become the baseline for good.
        const { dir, file } = history([
            RUN('CI', 10), RUN('CI', 10), RUN('CI', 1000), RUN('CI', 12)
        ]);
        try {
            const trend = Profiler.trends('CI', { historyFile: file });
            assert.strictEqual(trend.baseline.median, 10,
                'the baseline is the two 10ms runs; 1000ms is the outlier, 12ms is this run');
            assert.ok(trend.baseline.average > 100,
                `an average of 10 means the median was not the baseline: ${trend.baseline.average}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a first run has no trend rather than a trend against nothing', () => {
        const { dir, file } = history([RUN('CI', 42)]);
        try {
            // Only one run recorded: there is nothing to compare it to, so the
            // table is omitted instead of comparing the run to itself.
            const trend = Profiler.trends('CI', { historyFile: file });
            assert.ok(!trend || trend.baseline.runs === 0,
                `a trend against no history: ${JSON.stringify(trend)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('another workflow\'s runs are not in the baseline', () => {
        const { dir, file } = history([
            RUN('CI', 10), RUN('release', 5000), RUN('CI', 20), RUN('CI', 30)
        ]);
        try {
            const trend = Profiler.trends('CI', { historyFile: file });
            assert.strictEqual(trend.baseline.runs, 2, 'the release run is not CI history');
            assert.ok(trend.baseline.average < 100,
                `a 5000ms release run leaked into the CI baseline: ${trend.baseline.average}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('profiler · the words next to the numbers', () => {
    /** The trend table, printed from a controlled history. */
    function trendFor(priorMs, latestMs) {
        // `printTrendReport` reads the history file itself, so the "latest" run
        // is the last line — `p.runs` is the in-memory record of the run that
        // just happened and is not what the table is built from.
        const { dir, file } = history([
            RUN('CI', priorMs), RUN('CI', priorMs), RUN('CI', priorMs), RUN('CI', latestMs)
        ]);
        try {
            const p = new Profiler('CI', { historyDir: dir });
            return captured(() => p.printTrendReport());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('a faster run says "faster" with no minus sign', () => {
        // The bug: `delta` is negative, the percentage was formatted with that
        // sign, and the word already said "faster" — so the line read
        // "2ms (-4%) faster".
        const out = trendFor(100, 80);
        assert.ok(/faster/.test(out), `no trend printed: ${out}`);
        assert.ok(!/-\d+%/.test(out), `a negative percentage beside a direction word: ${out}`);
        assert.ok(/\(\d+%\)/.test(out), `the percentage is missing: ${out}`);
    });

    test('a slower run says "slower" and says how much', () => {
        const out = trendFor(10, 20);
        assert.ok(/slower/.test(out), `no trend printed: ${out}`);
        assert.ok(!/-\d+%/.test(out), `a negative percentage beside a direction word: ${out}`);
    });

    test('the direction and the size agree', () => {
        // A percentage of 0 with a direction word means the arithmetic is off.
        for (const [prior, latest] of [[10, 20], [20, 10], [100, 1000]]) {
            const out = trendFor(prior, latest);
            const m = /Change vs median\s*:.*?\((\d+)%\)/.exec(out);
            assert.ok(m, `no percentage in: ${out}`);
            assert.notStrictEqual(Number(m[1]), 0, `0% reported with a direction word: ${out}`);
        }
    });

    test('an unchanged run reports no direction at all', () => {
        // "0ms (0%) slower" is a sentence about a run that did not move.
        const out = trendFor(50, 50);
        assert.ok(!/faster|slower/.test(out), `a direction word on an unchanged run: ${out}`);
    });
});

suite('profiler · printAll does not throw', () => {
    test('every table prints, including the observations', () => {
        // `printObservations` is static; `printAll` is an instance method. It
        // used to reach the static through `this`, so the command threw *after*
        // printing the timing table and the cost projection — the numbers were
        // on screen and the run still exited as a crash.
        const { dir, file } = history([RUN('CI', 50), RUN('CI', 50)]);
        try {
            const p = new Profiler('CI', { historyDir: dir });
            p.runs = [{ totalMs: 10, jobId: 'build', workflow: 'CI', status: 'success' }];
            const out = captured(() => p.printAll({
                doc: {
                    jobs: {
                        build: { steps: [{ run: 'npm ci' }, { run: 'npm test' }] },
                        deploy: { needs: 'build', steps: [{ run: 'echo' }] }
                    }
                },
                runner: 'ubuntu-latest'
            }));
            assert.ok(out.length > 0, 'printAll printed nothing');
            assert.ok(!/not a function/.test(out), `printAll threw: ${out}`);
            assert.ok(/Worth knowing|Worth knowing|📎|🔎/.test(out) || /Worth knowing/.test(out),
                `the observations were not printed: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('profiler · the observations are facts, not a score', () => {
    test('a package install with no cache is reported', () => {
        const notes = Profiler.observations({
            jobs: { build: { steps: [{ run: 'npm ci' }] } }
        });
        assert.ok(notes.some((n) => /cache/i.test(n.text || n)),
            `no cache observation in: ${JSON.stringify(notes)}`);
    });

    test('a workflow that caches is not reported as uncached', () => {
        const notes = Profiler.observations({
            jobs: {
                build: {
                    steps: [
                        { uses: 'actions/cache@v4' },
                        { run: 'npm ci' }
                    ]
                }
            }
        });
        assert.ok(!notes.some((n) => /cache/i.test(n.text || n)),
            `a workflow using actions/cache was told it does not: ${JSON.stringify(notes)}`);
    });

    test('an unused timeout-minutes is reported', () => {
        const notes = Profiler.observations({
            jobs: { build: { steps: [{ run: 'echo' }] } }
        });
        assert.ok(notes.some((n) => /timeout-minutes/.test(n.text || n)),
            `no timeout observation in: ${JSON.stringify(notes)}`);
    });

    test('a job that sets its own timeout is not reported', () => {
        const notes = Profiler.observations({
            jobs: { build: { 'timeout-minutes': 5, steps: [{ run: 'echo' }] } }
        });
        assert.ok(!notes.some((n) => /timeout-minutes/.test(n.text || n)),
            `a job with a timeout was told it had none: ${JSON.stringify(notes)}`);
    });
});
