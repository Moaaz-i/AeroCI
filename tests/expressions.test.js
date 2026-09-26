/**
 * The expression engine: `${{ … }}`.
 *
 * This is the part of AeroCI that decides what a step actually runs, so the
 * cases below are written against GitHub's documented behaviour rather than
 * against whatever the implementation happens to do. Where the two disagree,
 * the implementation is the thing that is wrong.
 */

const { suite, test, assert, throws } = require('./harness');
const {
    evaluateTemplate,
    evaluateExpression,
    evaluateCondition,
    isTruthy,
    looseEquals,
    toNumber,
    stringify,
    createHashFiles,
    CONTEXT_NAMES
} = require('../src/core/expressions');

/**
 * Build a `${{ … }}` expression.
 *
 * Written with single quotes on purpose: a literal `${{` inside a JavaScript
 * template literal opens an interpolation and breaks the file at parse time.
 * Funnelling every case through one helper means that trap exists in exactly
 * one place.
 */
const expr = (body) => `\${{ ${body} }}`;

/** `format()` in the Actions language is `stringify()` here. */
const format = stringify;

/**
 * A context object with the same shape the engine builds.
 *
 * The named contexts live under `.contexts`, and `success()` / `failure()` read
 * `ctx.status` rather than the `needs` map directly. Both are load-bearing, so
 * this helper mirrors the engine rather than a convenient fiction.
 */
function ctx(overrides = {}) {
    const needs = {
        build: { result: 'success', outputs: { sha: 'abc123', count: '3', flag: 'true' } },
        flaky: { result: 'failure', outputs: {} },
        ...(overrides.needs || {})
    };

    // The engine's rule: success() is true only when every transitive need
    // succeeded.
    const allPassed = Object.values(needs).every((n) => n.result === 'success');
    const status = {
        success: () => allPassed,
        failure: () => !allPassed,
        cancelled: () => false,
        always: () => true
    };

    const contexts = {
        github: {
            event_name: 'push',
            ref: 'refs/heads/main',
            ref_name: 'main',
            actor: 'moaaz',
            repository: 'octo/hello',
            job: 'build',
            event: {
                pull_request: { title: 'Fix <b> & "quotes"' },
                issue: { number: 7 }
            }
        },
        env: { CI: 'true', EMPTY: '' },
        job: { status: allPassed ? 'success' : 'failure', container: null, services: {} },
        jobs: {},
        steps: { one: { outputs: { value: 'v1' }, conclusion: 'success' } },
        runner: { name: 'AeroCI Local Runner', os: 'Linux', arch: 'X64', temp: '/tmp/x' },
        secrets: { TOKEN: 'shhh' },
        strategy: { 'fail-fast': true, 'job-index': 0, 'job-total': 2, 'max-parallel': 1 },
        matrix: { os: 'ubuntu-latest', node: 20 },
        needs,
        inputs: { level: 'info' },
        vars: { REGION: 'eu' },
        ...(overrides.contexts || {})
    };

    return {
        contexts,
        status,
        // `hashFiles` resolves globs against a root the engine hands it.
        hashFiles: createHashFiles(process.cwd()),
        allowedContexts: null,
        workspace: '/tmp/aeroci-test',
        matrix: contexts.matrix,
        needs,
        steps: contexts.steps,
        runner: contexts.runner,
        state: {}
    };
}

suite('expressions · literals and rendering', () => {
    test('a string literal renders without its quotes', () => {
        assert.strictEqual(evaluateTemplate(expr("'a'"), ctx()), 'a');
    });

    test('numbers render without a decimal point', () => {
        assert.strictEqual(evaluateTemplate(expr('1'), ctx()), '1');
        assert.strictEqual(evaluateTemplate(expr('1.5'), ctx()), '1.5');
    });

    test('a lone $ is not a broken expression', () => {
        // Windows batch scripts and shell variables both use $ on its own.
        assert.strictEqual(evaluateTemplate('cost is $5 {each}', ctx()), 'cost is $5 {each}');
        assert.strictEqual(evaluateTemplate('$HOME/bin', ctx()), '$HOME/bin');
        assert.strictEqual(evaluateTemplate('100% done', ctx()), '100% done');
    });

    test('text outside the markers is passed through untouched', () => {
        assert.strictEqual(
            evaluateTemplate('deploying to ' + expr('github.ref') + ' at ${HOME}', ctx()),
            'deploying to refs/heads/main at ${HOME}');
    });

    test('several expressions in one string all render', () => {
        assert.strictEqual(
            evaluateTemplate(expr('github.actor') + '@' + expr('github.ref_name'), ctx()),
            'moaaz@main');
    });

    test('a non-string template comes back unchanged', () => {
        assert.strictEqual(evaluateTemplate(null, ctx()), null);
        assert.strictEqual(evaluateTemplate(undefined, ctx()), undefined);
        assert.strictEqual(evaluateTemplate(42, ctx()), '42');
    });

    test('toNumber follows Actions coercion, where unparseable means 0', () => {
        // Not NaN. The language coerces a non-numeric string to 0, and
        // relational comparison relies on that; returning NaN here would make
        // every comparison against a missing value false.
        assert.strictEqual(toNumber('42'), 42);
        assert.strictEqual(toNumber('3.5'), 3.5);
        assert.strictEqual(toNumber(''), 0);
        assert.strictEqual(toNumber(null), 0);
        assert.strictEqual(toNumber(true), 1);
        assert.strictEqual(toNumber('abc'), 0);
        assert.strictEqual(toNumber('true'), 0);
    });
});

suite('expressions · truthiness', () => {
    test('the Actions falsy set', () => {
        for (const value of [false, 0, -0, '', null, Number.NaN]) {
            assert.ok(!isTruthy(value), `${JSON.stringify(value)} should be falsy`);
        }
    });

    test('everything else is truthy, including the string "false"', () => {
        for (const value of [true, 1, -1, 'false', '0', [], {}, 'x']) {
            assert.ok(isTruthy(value), `${JSON.stringify(value)} should be truthy`);
        }
    });
});

suite('expressions · equality is case-insensitive and coerces', () => {
    test('string comparison ignores case', () => {
        assert.ok(looseEquals('Push', 'push'));
        assert.ok(looseEquals('ubuntu-latest', 'UBUNTU-LATEST'));
    });

    test('a number and its string form are equal', () => {
        assert.ok(looseEquals(20, '20'));
        assert.ok(looseEquals('0', 0));
    });

    test('null compares equal to the empty string', () => {
        // This is documented Actions behaviour and it surprises people, which
        // is exactly why it is pinned by a test rather than left to chance.
        assert.ok(looseEquals(null, ''));
    });

    test('a non-numeric string is not silently equal to NaN', () => {
        assert.ok(!looseEquals('abc', Number.NaN));
    });

    test('!= is the exact negation of ==', () => {
        assert.strictEqual(format(evaluateExpression("'A' == 'a'", ctx())), 'true');
        assert.strictEqual(format(evaluateExpression("'A' != 'a'", ctx())), 'false');
    });
});

suite('expressions · relational operators', () => {
    test('numbers compare numerically, not as strings', () => {
        assert.strictEqual(format(evaluateExpression('10 > 9', ctx())), 'true');
        assert.strictEqual(format(evaluateExpression('9 > 10', ctx())), 'false');
        assert.strictEqual(format(evaluateExpression('2 <= 2', ctx())), 'true');
    });

    test('relational comparison coerces both sides to numbers', () => {
        // Actions compares `<` and `>` numerically. A non-numeric string
        // becomes 0, so two of them are equal rather than alphabetically
        // ordered — this is the coercion, not a string sort.
        assert.strictEqual(format(evaluateExpression("'a' < 'b'", ctx())), 'false');
        assert.strictEqual(format(evaluateExpression("'10' > '9'", ctx())), 'true');
    });
});

suite('expressions · string functions', () => {
    test('contains is case-insensitive', () => {
        assert.strictEqual(
            format(evaluateExpression("contains('Hello world', 'WORLD')", ctx())), 'true');
        assert.strictEqual(
            format(evaluateExpression("contains('Hello', 'bye')", ctx())), 'false');
    });

    test('startsWith / endsWith are case-insensitive', () => {
        assert.strictEqual(
            format(evaluateExpression("startsWith('refs/heads/main', 'REFS/HEADS')", ctx())), 'true');
        assert.strictEqual(
            format(evaluateExpression("endsWith('main', 'MAIN')", ctx())), 'true');
    });

    test('format() substitutes numbered placeholders', () => {
        assert.strictEqual(
            format(evaluateExpression("format('{0}/{1}', 'a', 'b')", ctx())), 'a/b');
        assert.strictEqual(
            format(evaluateExpression("format('{1} then {0}', 'a', 'b')", ctx())), 'b then a');
    });

    test('format() has no padding specifiers, and does not invent them', () => {
        // `{0,3}` is not a placeholder, so it survives verbatim. Reporting
        // zero padding here would be a fabricated feature.
        assert.strictEqual(
            format(evaluateExpression("format('{0,3}|', 'ab')", ctx())), '{0,3}|');
    });

    test('a missing argument leaves its placeholder in place', () => {
        assert.strictEqual(
            format(evaluateExpression("format('{0} {1}', 'only')", ctx())), 'only {1}');
    });

    test('fromJSON indexes into a parsed object', () => {
        assert.strictEqual(
            format(evaluateExpression('fromJSON(\'{"a":[1,2]}\').a[1]', ctx())), '2');
    });

    test('toJSON / fromJSON round-trip', () => {
        assert.strictEqual(
            format(evaluateExpression('fromJSON(toJSON(fromJSON(\'{"a":[1,2]}\'))).a[1]', ctx())), '2');
    });

    test('malformed JSON is an error, not a silent empty', () => {
        throws(() => evaluateExpression("fromJSON('{not json')", ctx()));
    });

    test('join turns an array into a string', () => {
        assert.strictEqual(
            format(evaluateExpression("join(fromJSON('[\"a\",\"b\"]'), '-')", ctx())), 'a-b');
    });

    test('an unknown function is an error, not undefined', () => {
        throws(() => evaluateExpression('nosuchfunction()', ctx()), /Unrecognized function/i);
    });

    test('hashFiles hashes each match, then hashes the joined digests', () => {
        // The two-level digest is what the language specifies: one hash per
        // file, and the result is the hash of those hashes concatenated.
        const crypto = require('crypto');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-expr-'));
        const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
        fs.writeFileSync(path.join(dir, 'skip.md'), 'ignored');
        try {
            const local = ctx();
            local.hashFiles = createHashFiles(dir);
            const expected = sha256(Buffer.from(
                [sha256(Buffer.from('hello')), sha256(Buffer.from('world'))].join('')
            ));
            assert.strictEqual(
                format(evaluateExpression("hashFiles('*.txt')", local)), expected);
            // A pattern that matches nothing is empty, not an error and not a
            // hash of the empty set.
            assert.strictEqual(
                format(evaluateExpression("hashFiles('*.nope')", local)), '');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('hashFiles matches a nested path', () => {
        const crypto = require('crypto');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-expr-'));
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'x');
        try {
            const local = ctx();
            local.hashFiles = createHashFiles(dir);
            const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
            assert.strictEqual(
                format(evaluateExpression("hashFiles('src/*.js')", local)),
                sha256(Buffer.from(sha256(Buffer.from('x')))));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('expressions · contexts', () => {
    test('dotted paths resolve', () => {
        assert.strictEqual(evaluateTemplate(expr('github.event_name'), ctx()), 'push');
        assert.strictEqual(evaluateTemplate(expr('needs.build.outputs.sha'), ctx()), 'abc123');
    });

    test('an unknown property is empty, not an error', () => {
        // GitHub does not fail a run over this, and neither does AeroCI.
        assert.strictEqual(evaluateTemplate(expr('github.nope.nothing'), ctx()), '');
    });

    test('an unknown context is reported, because it is a typo', () => {
        // A misspelled context would otherwise resolve to '' and look like a
        // value that happens to be blank.
        throws(() => evaluateExpression('nosuchcontext.value', ctx()), /Unrecognized named-value/);
    });

    test('the documented context list is the real one', () => {
        for (const name of ['github', 'env', 'job', 'steps', 'runner',
            'secrets', 'strategy', 'matrix', 'needs', 'inputs', 'vars']) {
            assert.ok(CONTEXT_NAMES.includes(name), `${name} should be a known context`);
        }
    });

    test('brackets index like dots', () => {
        assert.strictEqual(evaluateTemplate(expr("github['event_name']"), ctx()), 'push');
        assert.strictEqual(
            evaluateTemplate(expr("needs['build']['outputs']['sha']"), ctx()), 'abc123');
    });

    test('secrets render as their value when asked for', () => {
        assert.strictEqual(evaluateTemplate(expr('secrets.TOKEN'), ctx()), 'shhh');
    });

    test('allowedContexts narrows what a scope can see', () => {
        // `if:` at job level may not read `steps`, so it must not resolve.
        const narrow = { ...ctx(), allowedContexts: ['github', 'needs'] };
        assert.strictEqual(evaluateTemplate(expr('github.actor'), narrow), 'moaaz');
        throws(() => evaluateExpression('steps.one.outputs.value', narrow), /Unrecognized named-value/);
    });
});

suite('expressions · status functions', () => {
    test('always() is true regardless of any failure', () => {
        assert.strictEqual(format(evaluateExpression('always()', ctx())), 'true');
        assert.strictEqual(
            format(evaluateExpression('always()', ctx({ needs: { build: { result: 'failure', outputs: {} } } }))),
            'true');
    });

    test('failure() sees a failed dependency', () => {
        assert.strictEqual(
            format(evaluateExpression('failure()', ctx({ needs: { build: { result: 'failure', outputs: {} } } }))),
            'true');
    });

    test('success() is false when a dependency failed', () => {
        assert.strictEqual(
            format(evaluateExpression('success()', ctx({ needs: { build: { result: 'failure', outputs: {} } } }))),
            'false');
    });

    test('success() is true when every dependency passed', () => {
        const ok = ctx({ needs: { build: { result: 'success', outputs: {} }, flaky: { result: 'success', outputs: {} } } });
        assert.strictEqual(format(evaluateExpression('success()', ok)), 'true');
    });
});

suite('expressions · operators', () => {
    test('&& and || short-circuit like the language', () => {
        assert.strictEqual(format(evaluateExpression("'a' && 'b'", ctx())), 'b');
        assert.strictEqual(format(evaluateExpression("'' || 'fallback'", ctx())), 'fallback');
        assert.strictEqual(format(evaluateExpression("'x' && 'y' || 'z'", ctx())), 'y');
    });

    test('! negates using Actions truthiness', () => {
        assert.strictEqual(format(evaluateExpression("!''", ctx())), 'true');
        // "false" is a non-empty string, so it is truthy and ! gives false.
        assert.strictEqual(format(evaluateExpression("!'false'", ctx())), 'false');
    });

    test('the ternary picks a branch', () => {
        assert.strictEqual(
            format(evaluateExpression("github.event_name == 'push' ? 'yes' : 'no'", ctx())), 'yes');
        assert.strictEqual(
            format(evaluateExpression("github.event_name == 'tag' ? 'yes' : 'no'", ctx())), 'no');
    });

    test('parentheses group', () => {
        assert.strictEqual(format(evaluateExpression('(1 == 1) && (2 == 2)', ctx())), 'true');
    });

    test('an expression statement on its own is an error', () => {
        throws(() => evaluateExpression('1 +', ctx()));
    });
});

suite('expressions · injection safety', () => {
    test('a value with shell metacharacters is rendered verbatim, not escaped', () => {
        // Escaping here would silently corrupt the script. Where injection is
        // stopped is the `env:` block, which the security module checks — not
        // the expression engine, which has to stay faithful.
        const evil = '$(rm -rf /); `id` && echo pwned';
        const out = evaluateTemplate(expr('github.event.issue.title'), ctx({
            contexts: {
                github: {
                    event_name: 'issues',
                    repository: 'octo/hello',
                    event: { issue: { title: evil } }
                }
            }
        }));
        assert.strictEqual(out, evil);
    });

    test('a title with angle brackets and quotes survives intact', () => {
        assert.strictEqual(
            evaluateTemplate(expr('github.event.pull_request.title'), ctx()),
            'Fix <b> & "quotes"');
    });

    test('a value containing a newline is not dropped', () => {
        const value = 'line one\nline two';
        assert.strictEqual(
            evaluateTemplate(expr('github.event.issue.title'), ctx({
                contexts: {
                    github: { event_name: 'issues', repository: 'o/h', event: { issue: { title: value } } }
                }
            })),
            value);
    });
});

suite('expressions · malformed input is reported, not swallowed', () => {
    test('plain text with no expression never throws', () => {
        assert.strictEqual(evaluateTemplate('just some text', ctx()), 'just some text');
    });

    test('an unbalanced paren is reported', () => {
        throws(() => evaluateExpression('(1 + 2', ctx()));
    });

    test('an unterminated ${{ is reported', () => {
        // A silently empty result would look exactly like a context that
        // resolved to nothing, which is the hardest kind of bug to see.
        const err = throws(() => evaluateTemplate('${{ github.ref', ctx()), /unterminated/);
        assert.ok(err.message.includes('${{'), 'the error should quote the offending marker');
    });

    test('a shell ${VAR} is not mistaken for an expression', () => {
        // The check counts only `${{` and `}}`, so ordinary shell expansion
        // and awk field references must pass through untouched.
        assert.strictEqual(evaluateTemplate('echo ${HOME}/bin', ctx()), 'echo ${HOME}/bin');
        assert.strictEqual(evaluateTemplate("awk '{print $1}' f", ctx()), "awk '{print $1}' f");
    });

    test('a stray }} without an opening marker is harmless', () => {
        assert.strictEqual(evaluateTemplate('close }} brace', ctx()), 'close }} brace');
    });
});

suite('expressions · an if: condition', () => {
    test('the ${{ }} wrapper is optional in if:', () => {
        assert.strictEqual(evaluateCondition("github.event_name == 'push'", ctx()), true);
        assert.strictEqual(evaluateCondition(expr("github.event_name == 'push'"), ctx()), true);
    });

    test('a bare path is judged by truthiness', () => {
        assert.strictEqual(evaluateCondition('github.actor', ctx()), true);
        assert.strictEqual(evaluateCondition('env.EMPTY', ctx()), false);
    });

    test('status functions combine with context lookups', () => {
        const allGreen = (result) => ctx({
            needs: { build: { result, outputs: {} }, flaky: { result, outputs: {} } }
        });
        assert.strictEqual(
            evaluateCondition("success() && needs.build.result == 'success'", allGreen('success')), true);
        assert.strictEqual(
            evaluateCondition("success() && needs.build.result == 'success'", allGreen('failure')), false);
    });

    test('success() is false in the default context, which has a failing need', () => {
        // The default context ships one failing need on purpose, so a
        // status-function test cannot pass by accident.
        assert.strictEqual(evaluateCondition('success()', ctx()), false);
    });

    test('a malformed if: is an error, not a silent true', () => {
        // Defaulting to true here would run a step the author meant to guard.
        throws(() => evaluateCondition('github.event_name ==', ctx()));
    });
});
