/**
 * The ReDoS rule in scripts/lint.js.
 *
 * The rule is a measurement, not a guess about the shape of a pattern, so the
 * only honest way to test it is to feed the worker patterns whose behaviour is
 * known and check that the measurement agrees. A rule that cries wolf is worse
 * than no rule: a lint gate that fails on `/\s+/g` once gets `--no-verify`.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, assert, state } = require('./harness');

const WORKER = path.resolve(__dirname, '..', 'scripts', 'regex-scan-worker.js');

/** Patterns that never finish, and why. */
const CATASTROPHIC = [
    { source: '(a+)+$', why: 'nested quantifier over a variable-length group' },
    { source: '(.*)*x', why: 'inner group can match empty, outer repeats' },
    { source: '(\\s*)+y', why: 'inner group matches empty' },
    { source: '^(a|aa)+$', why: 'alternation with a common prefix' },
    { source: '(a|a?)+$', why: 'optional inside a repeated group' },
    { source: '(x+x+)+y', why: 'adjacent groups over the same class' },
    { source: '(a{1,10})+$', why: 'bounded but variable-length inner group' }
];

/** Patterns that are fast however long the input gets. */
const LINEAR = [
    { source: '^v[0-9]+(\\.[0-9]+)*$', why: 'leading literal anchors each iteration' },
    { source: '^(a+)$', why: 'a single quantifier is not nested' },
    { source: '[^\\w-]+', flags: 'g', why: 'character class negation' },
    { source: '^\\s*const\\s+(?:\\{([^}]+)\\}|(\\w+))\\s*=\\s*require\\(', why: 'the project\'s own require matcher' },
    { source: '(?:a|ab)(?:c|bcd)', why: 'common prefix but no outer quantifier' },
    { source: '\\$\\{\\{([\\s\\S]*?)\\}\\}', flags: 'g', why: 'lazy group with a literal terminator' },
    { source: '\\s+', flags: 'g', why: 'whitespace run — once flagged as exponential' },
    { source: '\\.', flags: 'g', why: 'a literal dot — once flagged as exponential' },
    { source: '[\\w.-]+', flags: 'g', why: 'the version matcher' },
    { source: '^[\'"]|[\'"]$', flags: 'g', why: 'a quoted token' },
    { source: 'action\\.ya?ml$', why: 'the workflow-file matcher' }
];

/**
 * Run the worker over a set of patterns.
 *
 * The budget is generous because a genuinely catastrophic pattern is meant to
 * be interrupted, and interrupting it costs time on purpose. A timeout here
 * means the worker itself wedged, which is a failure, not a skip.
 */
function scan(patterns, timeoutMs = 60000) {
    const res = spawnSync(process.execPath, [WORKER, JSON.stringify(patterns)], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`worker exited ${res.status}: ${res.stderr}`);
    return JSON.parse(res.stdout || '[]');
}

const all = [...CATASTROPHIC, ...LINEAR].map((p) => ({ source: p.source, flags: p.flags || '' }));

// One scan for the whole suite: the worker costs real time, and every assertion
// below is about the same set of results.
let reported;
let scanError = null;
try {
    reported = new Map(scan(all).map((r) => [r.source, r]));
} catch (err) {
    scanError = err;
}

suite('regex rule · catastrophic backtracking is found', () => {
    for (const pattern of CATASTROPHIC) {
        test(`/${pattern.source}/ — ${pattern.why}`, () => {
            assert.strictEqual(scanError, null, `the worker did not run: ${scanError && scanError.message}`);
            assert.ok(reported.has(pattern.source), 'not reported as slow');
        });
    }
});

suite('regex rule · linear patterns are left alone', () => {
    for (const pattern of LINEAR) {
        test(`/${pattern.source}/ — ${pattern.why}`, () => {
            assert.strictEqual(scanError, null, `the worker did not run: ${scanError && scanError.message}`);
            assert.ok(!reported.has(pattern.source), 'wrongly reported as slow');
        });
    }
});

suite('regex rule · the measurement is repeatable', () => {
    test('two runs over the same linear patterns agree', () => {
        // The rule is timing based, so the question is not "is it exact?" but
        // "does it give the same answer twice?". A rule that changes its mind
        // between runs cannot be used as a build gate.
        const a = new Set(scan(LINEAR.map((p) => ({ source: p.source, flags: p.flags || '' })))
            .map((r) => r.source));
        const b = new Set(scan(LINEAR.map((p) => ({ source: p.source, flags: p.flags || '' })))
            .map((r) => r.source));
        assert.deepStrictEqual([...a], [...b]);
    });

    test('the reason given is about growth, not an absolute time', () => {
        // A report that says "took 30ms" is reporting the machine's mood. The
        // useful statement is that 4× the input cost far more than 4× the work.
        for (const [source, finding] of reported) {
            if (!finding.grew && !/^(a|\(x|\(a)/.test(source)) continue;
            if (finding.grew) assert.ok(/×/.test(finding.grew), `${source}: ${finding.grew}`);
        }
    });
});

if (state.failed > 0) {
    console.log(`\n${state.failed} regex case(s) wrong`);
}
