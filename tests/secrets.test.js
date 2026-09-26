/**
 * `.env` parsing.
 *
 * A mistyped secret silently becomes an empty string, and an empty token
 * produces a confusing 401 on the real runner rather than here. The dialect
 * has to be a real one, and the failure cases have to be reported rather than
 * skipped in silence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const {
    parseEnv,
    loadEnvFile,
    collectSecretReferences,
    collectVarReferences
} = require('../src/core/secrets');

suite('secrets · the basic dialect', () => {
    test('KEY=value', () => {
        assert.deepStrictEqual(parseEnv('TOKEN=abc123').values, { TOKEN: 'abc123' });
    });

    test('spaces around the equals sign are tolerated', () => {
        assert.deepStrictEqual(parseEnv('TOKEN = abc123').values, { TOKEN: 'abc123' });
    });

    test('the export prefix is accepted', () => {
        assert.deepStrictEqual(parseEnv('export TOKEN=abc').values, { TOKEN: 'abc' });
    });

    test('a value containing equals signs keeps all of them', () => {
        assert.deepStrictEqual(
            parseEnv('URL=postgres://u:p@h:5432/db?sslmode=require').values,
            { URL: 'postgres://u:p@h:5432/db?sslmode=require' });
    });

    test('a value that is only whitespace survives as empty', () => {
        assert.deepStrictEqual(parseEnv('EMPTY=').values, { EMPTY: '' });
    });

    test('the last assignment of a key wins', () => {
        // Later wins is what a shell would do, and it is what makes an
        // override at the bottom of the file behave predictably.
        assert.deepStrictEqual(parseEnv('A=1\nA=2').values, { A: '2' });
    });
});

suite('secrets · quoting', () => {
    test('double quotes are stripped and the value kept whole', () => {
        assert.deepStrictEqual(parseEnv('A="hello world"').values, { A: 'hello world' });
    });

    test('single quotes are stripped and nothing is expanded', () => {
        assert.deepStrictEqual(parseEnv("A='$HOME no expand'").values, { A: '$HOME no expand' });
    });

    test('a # inside quotes is part of the value, not a comment', () => {
        assert.deepStrictEqual(parseEnv('A="a # b"').values, { A: 'a # b' });
    });

    test('a # after whitespace in an unquoted value starts a comment', () => {
        assert.deepStrictEqual(parseEnv('A=value # note').values, { A: 'value' });
    });

    test('a # glued to a value is kept', () => {
        assert.deepStrictEqual(parseEnv('A=va#lue').values, { A: 'va#lue' });
    });

    test('an escaped quote inside a quoted value', () => {
        assert.deepStrictEqual(parseEnv('A="say \\"hi\\""').values, { A: 'say "hi"' });
    });

    test('a quoted value may span lines', () => {
        // Private keys are pasted in as multi-line PEM blocks; failing to read
        // them means every signing step fails on the real runner.
        const { values } = parseEnv('KEY="line one\nline two"\nAFTER=1');
        assert.strictEqual(values.KEY, 'line one\nline two');
        assert.strictEqual(values.AFTER, '1');
    });

    test('a single-quoted value keeps its backslashes', () => {
        // The dotenv convention: single quotes are literal. A private key
        // pasted in with \n separators has to survive intact, and expanding
        // them here would hand the runner a value nobody wrote.
        assert.deepStrictEqual(parseEnv("KEY='a\\nb'").values, { KEY: 'a\\nb' });
        const { values } = parseEnv("KEY='one\ntwo'");
        assert.strictEqual(values.KEY, 'one\ntwo');
    });

    test('a single-quoted value does not treat an escaped quote as a terminator', () => {
        // '\\' is literal in single quotes, so the value closes at the last '
        // on the line, not the first.
        assert.deepStrictEqual(parseEnv("KEY='it\\'s'").values, { KEY: "it\\'s" });
    });
});

suite('secrets · escapes', () => {
    test('\\n becomes a newline', () => {
        assert.deepStrictEqual(parseEnv('A="one\\ntwo"').values, { A: 'one\ntwo' });
    });

    test('\\r and \\t are expanded', () => {
        assert.deepStrictEqual(parseEnv('A="a\\tb\\rc"').values, { A: 'a\tb\rc' });
    });

    test('an escaped backslash collapses', () => {
        assert.deepStrictEqual(parseEnv('A="a\\\\b"').values, { A: 'a\\b' });
    });
});

suite('secrets · lines that are not assignments', () => {
    test('blank lines and comments are skipped without complaint', () => {
        const { values, warnings } = parseEnv('\n# a comment\n\n  # indented comment\nA=1\n');
        assert.deepStrictEqual(values, { A: '1' });
        assert.deepStrictEqual(warnings, []);
    });

    test('a line with no = is reported, not silently dropped', () => {
        // This is the case that matters: a mangled secret line otherwise looks
        // exactly like a workflow that simply never referenced the secret.
        const { values, warnings } = parseEnv('JUST_A_WORD\nA=1');
        assert.deepStrictEqual(values, { A: '1' });
        assert.strictEqual(warnings.length, 1);
        assert.ok(/line 1/.test(warnings[0]), warnings[0]);
        assert.ok(/missing '='/.test(warnings[0]), warnings[0]);
    });

    test('an invalid key is reported with the offending text', () => {
        const { warnings } = parseEnv('not-a-key=value\n9LEADING=1\n_ok=1\n');
        assert.strictEqual(warnings.length, 2);
        assert.ok(warnings[0].includes('not-a-key'), warnings[0]);
        assert.ok(warnings[1].includes('9LEADING'), warnings[1]);
    });

    test('an unterminated quote is reported and the value kept as far as it goes', () => {
        const { values, warnings } = parseEnv('A="never closed\n');
        assert.strictEqual(values.A, 'never closed\n');
        assert.ok(warnings.some((w) => /unterminated/.test(w)), JSON.stringify(warnings));
    });

    test('text after a closing quote is reported', () => {
        const { values, warnings } = parseEnv('A="v" trailing');
        assert.strictEqual(values.A, 'v');
        assert.ok(warnings.some((w) => /after quoted value/.test(w)), JSON.stringify(warnings));
    });

    test('a comment after a closing quote is fine', () => {
        const { values, warnings } = parseEnv('A="v" # note');
        assert.strictEqual(values.A, 'v');
        assert.deepStrictEqual(warnings, []);
    });

    test('CRLF line endings are handled', () => {
        assert.deepStrictEqual(parseEnv('A=1\r\nB=2\r\n').values, { A: '1', B: '2' });
    });
});

suite('secrets · loading from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-env-'));
    const file = path.join(dir, '.env');

    test('a missing file is reported as missing, not as empty', () => {
        // "no .env" and "an empty .env" mean different things to someone
        // debugging a missing secret, so the distinction has to survive.
        const result = loadEnvFile(path.join(dir, 'nope.env'));
        assert.strictEqual(result.exists, false);
        assert.deepStrictEqual(result.values, {});
    });

    test('a real file is read', () => {
        fs.writeFileSync(file, 'TOKEN=abc\nOTHER=xyz\n');
        const result = loadEnvFile(file);
        assert.strictEqual(result.exists, true);
        assert.deepStrictEqual(result.values, { TOKEN: 'abc', OTHER: 'xyz' });
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

suite('secrets · reference collection', () => {
    test('a secrets reference is found', () => {
        assert.deepStrictEqual(
            collectSecretReferences('token: ${{ secrets.DEPLOY_KEY }}'),
            ['DEPLOY_KEY']);
    });

    test('several references are all found, without duplicates', () => {
        assert.deepStrictEqual(
            collectSecretReferences('${{ secrets.A }} ${{ secrets.B }} ${{ secrets.A }}').sort(),
            ['A', 'B']);
    });

    test('whitespace inside the braces is tolerated', () => {
        assert.deepStrictEqual(
            collectSecretReferences('${{secrets.A}} ${{  secrets.B  }}').sort(), ['A', 'B']);
    });

    test('a vars reference is not counted as a secret', () => {
        // Conflating the two would mask every repository variable as a
        // missing secret in `aeroci check`.
        assert.deepStrictEqual(collectSecretReferences('${{ vars.REGION }}'), []);
        assert.deepStrictEqual(collectVarReferences('${{ vars.REGION }}'), ['REGION']);
    });

    test('a malformed dotted path still names the secret it tried to read', () => {
        // `secrets` is a string map, so `secrets.NPM_TOKEN.value` resolves to
        // nothing. Reporting the name anyway is what lets the checker point at
        // the mistake instead of letting it read as "no secret referenced".
        assert.deepStrictEqual(collectSecretReferences('${{ secrets.NPM_TOKEN.value }}'), ['NPM_TOKEN']);
    });

    test('an empty or missing reference list is empty, not an error', () => {
        assert.deepStrictEqual(collectSecretReferences(''), []);
        assert.deepStrictEqual(collectSecretReferences(null), []);
        assert.deepStrictEqual(collectSecretReferences(undefined), []);
        assert.deepStrictEqual(collectVarReferences(null), []);
    });

    test('the reference regex is not sticky between calls', () => {
        // A /g regex keeps lastIndex between calls, so a shared module-level
        // regex silently returns nothing on the second call. The first call
        // and the second must give the same answer.
        const text = '${{ secrets.A }} ${{ secrets.B }}';
        assert.deepStrictEqual(collectSecretReferences(text), collectSecretReferences(text));
        assert.strictEqual(collectSecretReferences(text).length, 2);
    });
});
