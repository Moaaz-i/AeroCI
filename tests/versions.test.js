/**
 * `aeroci versions` — what the workflows depend on, and how firmly.
 *
 * The interesting property is honesty about the two things this command cannot
 * know: whether an action is pinned tightly enough (it can tell), and what the
 * latest release is (it cannot, without asking the network). A report that
 * guesses at either is worse than one that says it does not know.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, asyncTest, assert } = require('./harness');
const { Versions } = require('../src/core/versions');
const { MATCHERS } = require('../src/core/action-simulators');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** Inspect a workflow written on the fly. */
function inspect(steps, { options = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-versions-'));
    try {
        fs.writeFileSync(path.join(dir, 'ci.yml'),
            `name: V\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`);
        return Versions.inspect(dir, options);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const withUses = (uses) => `      - uses: ${uses}\n`;

suite('versions · classifying a reference', () => {
    const kindOf = (uses) => inspect(withUses(uses)).references[0].kind;

    test('a full commit SHA is the tightest pin', () => {
        assert.strictEqual(kindOf(`actions/checkout@${'a'.repeat(40)}`), 'sha');
    });

    test('an uppercase SHA is still a SHA', () => {
        assert.strictEqual(kindOf(`actions/checkout@${'A'.repeat(40)}`), 'sha');
    });

    test('a short SHA is its own category, not a tag', () => {
        // A 7-character ref is a commit prefix. Reading it as a tag would tell
        // the reader to change something that is already correct.
        assert.strictEqual(kindOf('actions/checkout@abc1234'), 'sha-short');
    });

    test('a version tag is a tag', () => {
        assert.strictEqual(kindOf('actions/checkout@v4'), 'tag');
        assert.strictEqual(kindOf('actions/checkout@v4.1.2'), 'tag');
    });

    test('a moving branch is a branch, not a tag', () => {
        assert.strictEqual(kindOf('actions/checkout@main'), 'branch');
        assert.strictEqual(kindOf('actions/checkout@master'), 'branch');
        assert.strictEqual(kindOf('actions/checkout@latest'), 'branch');
    });

    test('a ref containing a slash is a branch', () => {
        assert.strictEqual(kindOf('actions/checkout@releases/v1'), 'branch');
    });

    test('no ref at all is called out as its own case', () => {
        const ref = inspect(withUses('actions/checkout')).references[0];
        assert.strictEqual(ref.kind, 'none');
        assert.strictEqual(ref.severity, 'high');
    });

    test('a local action is local, and versioned with the repository', () => {
        const ref = inspect(withUses('./.github/actions/build')).references[0];
        assert.strictEqual(ref.kind, 'local');
        assert.strictEqual(ref.severity, 'ok');
    });

    test('a container image is a container image', () => {
        const ref = inspect(withUses('docker://alpine:3.19')).references[0];
        assert.strictEqual(ref.kind, 'image');
    });

    test('the reference is split into the action and the ref', () => {
        const ref = inspect(withUses('actions/checkout@v4')).references[0];
        assert.strictEqual(ref.action, 'actions/checkout');
        assert.strictEqual(ref.ref, 'v4');
    });
});

suite('versions · what AeroCI can and cannot simulate', () => {
    test('a step that is not simulated says so', () => {
        const ref = inspect(withUses('some/other-action@v1')).references[0];
        assert.strictEqual(ref.simulated, false);
        assert.ok(/not simulated/.test(ref.why), ref.why);
    });

    test('a simulated action is only claimed when a simulator exists', () => {
        for (const [name] of MATCHERS) {
            const action = name.replace(/\*.*/, 'x');
            const ref = inspect(withUses(`${action}@v1`)).references[0];
            assert.strictEqual(ref.simulated, true, `${action} should be simulated`);
        }
    });

    test('the simulated claim matches the matcher list exactly', () => {
        // If these drift apart, the table either over-claims (a pass that
        // verifies nothing) or under-claims (noise).
        const claimed = inspect(
            ['actions/checkout@v4', 'actions/cache@v4', 'actions/upload-artifact@v4']
                .map(withUses).join('')).references;
        for (const ref of claimed) {
            const expected = MATCHERS.some(([name]) => name.startsWith(ref.action))
                || /^\.\//.test(ref.uses);
            assert.strictEqual(ref.simulated, expected, ref.uses);
        }
    });

    test('a local action is simulated by definition — it is your own code', () => {
        const ref = inspect(withUses('./.github/actions/build')).references[0];
        assert.strictEqual(ref.simulated, true);
    });
});

suite('versions · the summary', () => {
    test('the counts add up to the number of references', () => {
        const out = inspect([
            withUses('actions/checkout@v4'),
            withUses('actions/cache@main'),
            withUses('someone/thing'),
            withUses('./.github/actions/build')
        ].join(''));
        const counted = out.counts.sha + out.counts.shaShort + out.counts.tag
            + out.counts.branch + out.counts.none + out.counts.local + out.counts.other;
        assert.strictEqual(counted, out.counts.total);
        assert.strictEqual(out.counts.total, 4);
    });

    test('simulated and not-simulated partition the references', () => {
        const out = inspect([
            withUses('actions/checkout@v4'),
            withUses('someone/thing@v1')
        ].join(''));
        assert.strictEqual(out.counts.simulated + out.counts.notSimulated, out.counts.total);
        assert.strictEqual(out.counts.simulated, 1);
        assert.strictEqual(out.counts.notSimulated, 1);
    });

    test('unique counts distinct actions, not references', () => {
        const out = inspect([
            withUses('actions/checkout@v4'),
            withUses('actions/checkout@v4'),
            withUses('actions/cache@v4')
        ].join(''));
        assert.strictEqual(out.counts.total, 3);
        assert.strictEqual(out.counts.unique, 2);
    });

    test('a workflow with no uses: is not a failure', () => {
        const out = inspect('      - run: echo hi\n');
        assert.strictEqual(out.references.length, 0);
        assert.strictEqual(out.counts.total, 0);
        assert.strictEqual(out.exitCode, 0);
    });
});

suite('versions · no workflows at all', () => {
    test('is a failure, because the command was pointed at nothing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-versions-empty-'));
        try {
            const out = Versions.inspect(dir);
            assert.strictEqual(out.exitCode, 1);
            assert.deepStrictEqual(out.references, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('versions · remote lookup is opt-in and honest', () => {
    test('checkRemote is a function that has to be awaited, not a guess', () => {
        // The point of the test: `checkRemote` exists, is async, and the local
        // `inspect` never calls it. No network is touched here.
        assert.strictEqual(typeof Versions.checkRemote, 'function');
        assert.strictEqual(Versions.checkRemote.constructor.name, 'AsyncFunction');
        assert.ok(!/checkRemote/.test(Versions.inspect.toString()),
            'inspect must not reach the network on its own');
    });

    asyncTest('local actions are excluded from a remote lookup, because they have no upstream', async () => {
        const rows = await Versions.checkRemote([
            { action: './.github/actions/build', uses: './.github/actions/build', ref: 'x' }
        ]);
        assert.deepStrictEqual(rows, []);
    });

    asyncTest('an unavailable answer is reported as unavailable, not as current', async () => {
        // No network is used: a zero timeout makes the request fail, and the
        // result must say so rather than fall back to a guess.
        const rows = await Versions.checkRemote(
            [{ action: 'actions/checkout', uses: 'actions/checkout@v4', ref: 'v4' }],
            { timeoutMs: 1 });
        assert.strictEqual(rows.length, 1);
        assert.ok(/unavailable/.test(String(rows[0][2])), JSON.stringify(rows[0]));
    });

    asyncTest('lookups run concurrently, and no more than six at a time', async () => {
        // The property that matters is "a dead network costs one timeout, not
        // one per action". A wall-clock assertion cannot show that — a lookup
        // that fails instantly passes either way — so the concurrency is
        // observed directly, by replacing the single request with a stub that
        // records how many of them are in flight at the same time.
        const actions = ['a/one', 'b/two', 'c/three', 'd/four', 'e/five', 'f/six', 'g/seven'];
        const references = actions.map((action) => ({ action, uses: `${action}@v1`, ref: 'v1' }));

        const original = Versions._latestRelease;
        let inFlight = 0;
        let peak = 0;
        Versions._latestRelease = async () => {
            inFlight++;
            if (inFlight > peak) peak = inFlight;
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight--;
            return null; // nothing came back
        };

        let rows;
        try {
            rows = await Versions.checkRemote(references, { timeoutMs: 1 });
        } finally {
            Versions._latestRelease = original;
        }

        assert.strictEqual(rows.length, 7);
        for (const row of rows) {
            assert.ok(/unavailable/.test(String(row[2])), JSON.stringify(row));
        }
        assert.ok(peak > 1, `peak concurrency was ${peak} — the lookups are sequential`);
        assert.ok(peak <= 6, `peak concurrency was ${peak} — the cap is not applied`);
    });

    asyncTest('the stub is restored, so a later test is not talking to a fake', async () => {
        assert.strictEqual(Versions._latestRelease.name, '_latestRelease');
    });
});
