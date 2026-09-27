/**
 * Where AeroCI's output goes.
 *
 * Two promises live in the logger and both were false while the flag existed:
 *
 *   • `setQuiet(true)` — "suppress every line AeroCI prints" — was ignored by
 *     every call site that reached for `console.log` directly. 77 of them did.
 *   • `--json` — "print the findings as JSON" — put the banner, the tables and
 *     the report notice on stdout too, so `aeroci security --json | jq` died on
 *     the first line. The flag worked; the pipe did not.
 *
 * These are the tests for the fix, and they are stream tests on purpose: the
 * whole defect was in *which* stream a line landed on, so asserting on the
 * text alone would pass against the broken version.
 */

const { suite, test, assert, Logger, colors } = require('./harness');

/**
 * Run `fn` with both streams captured, colour codes left in.
 *
 * Raw, not stripped: a helper that silently stripped escapes would make every
 * assertion below depend on whether the runner happens to be a TTY, and the
 * colour case is worth testing too.
 */
function streams(fn) {
    const out = [];
    const err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    try {
        fn();
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
    }
    return { out: out.join(''), err: err.join('') };
}

/** The captured text with escape codes removed, the way a reader sees it. */
const plain = (s) => colors.strip(s);

suite('logger · the quiet flag is a promise', () => {
    test('nothing is printed while quiet', () => {
        const s = streams(() => {
            Logger.setQuiet(true);
            Logger.info('one');
            Logger.success('two');
            Logger.warn('three');
            Logger.error('four');
            Logger.note('five');
            Logger.metric('six', '7');
            Logger.banner();
            Logger.blank();
        });
        Logger.setQuiet(false);
        assert.strictEqual(s.out + s.err, '', `quiet still printed: ${JSON.stringify(s)}`);
    });

    test('the answer is not commentary, so quiet does not swallow it', () => {
        // A library consumer that asked for silence is not reading a CLI's
        // stdout, and `--json` is meaningless if its own output is muted.
        const s = streams(() => {
            Logger.setQuiet(true);
            Logger.answer({ findings: 1 });
        });
        Logger.setQuiet(false);
        assert.deepStrictEqual(JSON.parse(s.out), { findings: 1 },
            `the JSON must survive quiet: ${JSON.stringify(s)}`);
    });
});

suite('logger · stderr mode is a promise', () => {
    test('every line leaves stdout while it is on', () => {
        const s = streams(() => {
            Logger.setStderr(true);
            Logger.banner();
            Logger.info('progress');
            Logger.metric('Label', 'value');
        });
        Logger.setStderr(false);
        assert.strictEqual(s.out, '', `stdout must be empty in stderr mode: ${JSON.stringify(s.out)}`);
        assert.ok(/progress/.test(s.err), `the line must still be visible: ${s.err}`);
        assert.ok(/aeroci v/.test(s.err), `the banner must still be visible: ${s.err}`);
    });

    test('the answer still goes to stdout', () => {
        // The one case that has to hold: `--json` turns on stderr mode and then
        // writes the JSON. When the JSON went through `emit` it left stdout, and
        // the command produced an empty pipe and a large stderr instead.
        const s = streams(() => {
            Logger.setStderr(true);
            Logger.answer({ workflows: 2, score: 91 });
        });
        Logger.setStderr(false);
        assert.deepStrictEqual(JSON.parse(s.out), { workflows: 2, score: 91 },
            `the answer left stdout: ${JSON.stringify(s)}`);
    });

    test('errors go to stderr either way', () => {
        const off = streams(() => Logger.error('boom'));
        const on = streams(() => { Logger.setStderr(true); Logger.error('boom'); });
        Logger.setStderr(false);
        assert.ok(/boom/.test(off.err), 'an error is an error on both streams');
        assert.ok(/boom/.test(on.err), 'an error is an error in stderr mode too');
        assert.strictEqual(off.out, '', 'an error was never for stdout');
    });

    test('the flags are off again once turned off', () => {
        const s = streams(() => {
            Logger.setStderr(true);
            Logger.setStderr(false);
            Logger.info('back on stdout');
        });
        assert.ok(/back on stdout/.test(s.out), `stuck in stderr mode: ${JSON.stringify(s)}`);
        assert.strictEqual(s.err, '');
    });
});

suite('logger · the two flags do not collide', () => {
    test('quiet wins over stderr mode', () => {
        const s = streams(() => {
            Logger.setStderr(true);
            Logger.setQuiet(true);
            Logger.info('nothing');
        });
        Logger.setQuiet(false);
        Logger.setStderr(false);
        assert.strictEqual(s.out + s.err, '', `both flags on and it still printed: ${JSON.stringify(s)}`);
    });

    test('a printed line reads as text once the colour is taken out', () => {
        // With colour on, the word the reader is looking for is wrapped in escape
        // codes. `colors.strip` is what makes a captured line greppable, so it
        // has to remove the escapes and leave the words — a strip that ate the
        // text too would pass a weaker test.
        const ESC = String.fromCharCode(27);
        const before = process.env.FORCE_COLOR;
        process.env.FORCE_COLOR = '1';
        let s;
        try {
            // The colour decision is made once at module load, so whether the
            // codes appear depends on how this process was started. The two
            // assertions below hold either way; the middle one only bites when
            // colour really is on, and it is what stops the test being vacuous.
            s = streams(() => {
                Logger.setStderr(true);
                Logger.info('plain text');
            });
        } finally {
            Logger.setStderr(false);
            if (before === undefined) delete process.env.FORCE_COLOR;
            else process.env.FORCE_COLOR = before;
        }
        assert.ok(!plain(s.err).includes(ESC),
            `an escape survived stripping: ${JSON.stringify(plain(s.err))}`);
        if (colors.enabled) {
            assert.ok(s.err.includes(ESC),
                'colour is on, so the raw line should carry escapes — otherwise this test proves nothing');
        }
        assert.ok(/plain text/.test(plain(s.err)), 'stripping must not eat the words');
    });
});
