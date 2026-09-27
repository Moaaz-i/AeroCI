#!/usr/bin/env node
/**
 * Verifies that scripts/lint.js's template-literal tracking is correct: a line
 * inside a template literal is not JavaScript and must not be judged as such,
 * while a line outside one still must be.
 *
 * Run: node tests/lint-rules.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LINT = path.resolve(__dirname, '..', 'scripts', 'lint.js');

/** A file inside src/ so the code rules apply, plus the case under test. */
function makeModule(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-lint-'));
    const src = path.join(dir, 'src', 'sample.js');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, body, 'utf8');

    // The linter reads TARGETS relative to the repo root, so point it at a
    // throwaway copy of the project layout instead.
    const pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: 'lint-fixture', version: '0.0.0' }), 'utf8');
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(LINT, path.join(scripts, 'lint.js'));
    fs.copyFileSync(path.resolve(__dirname, '..', 'scripts', 'regex-scan-worker.js'),
        path.join(scripts, 'regex-scan-worker.js'));
    return { dir, run: () => spawnSync(process.execPath, [path.join(scripts, 'lint.js')], { encoding: 'utf8' }) };
}

const CASES = [
    {
        name: 'YAML inside a template literal is not JavaScript',
        body: 'const y = `\n  steps:\n    - if: a == b\n`;\nmodule.exports = y;\n',
        expect: []
    },
    {
        name: 'real loose equality outside a template literal is caught',
        body: 'const a = 1, b = 2;\nconst same = a == b;\nmodule.exports = same;\n',
        expect: ['no-loose-equality']
    },
    {
        name: 'loose equality after the template closes is caught',
        body: 'const y = `\n  if: a == b\n`;\nconst same = 1 == 2;\nmodule.exports = { y, same };\n',
        expect: ['no-loose-equality']
    },
    {
        name: 'process.exit inside a template literal is a string, not a call',
        body: 'const doc = `\n  run: process.exit(1)\n`;\nmodule.exports = doc;\n',
        expect: []
    },
    {
        name: 'process.exit as a real call is caught',
        body: 'function bail() { process.exit(1); }\nmodule.exports = bail;\n',
        expect: ['no-process-exit']
    },
    {
        name: 'an escaped backtick does not toggle the literal state',
        body: 'const t = `a \\` b`;\nconst same = 1 != 2;\nmodule.exports = { t, same };\n',
        expect: ['no-loose-equality']
    },
    {
        name: 'a template literal reopened after a closed one is tracked',
        body: 'const a = `x == y`;\nconst b = `p == q`;\nmodule.exports = { a, b };\n',
        expect: []
    },
    // ── does the file even compile? ────────────────────────────────────────
    //
    // The rule used to be `checkDuplicateKeys`, and it caught only duplicate
    // bindings — every other compile error was discarded with a comment saying
    // it was "not this rule's business". So a file with a syntax error passed
    // the gate: `src/core/analyzer.js` once sat with an unescaped backtick while
    // the linter printed `lint clean — 53 file(s) checked`. A gate that certifies
    // unparseable code is decoration.
    {
        name: 'a file that does not parse is reported, not passed',
        body: '// 1\n// 2\n// 3\n// 4\nconst bad = ( ;\n// 6\nmodule.exports = bad;\n',
        expect: ['parse-error'],
        at: { 'parse-error': 5 }
    },
    {
        name: 'a shebang is not a syntax error',
        // Node's own loader strips it and `vm.Script` does not, so seven real
        // files came back as "Invalid or unexpected token" on line 1 until the
        // shebang was replaced with a comment rather than deleted.
        body: '#!/usr/bin/env node\nconst a = 1;\nmodule.exports = a;\n',
        expect: []
    },
    {
        name: 'the reported line is the line that is broken',
        // The old rule read the line number out of the *source text* of the
        // stack frame, so it pointed at whichever digit happened to be in the
        // code. A finding that names the wrong line sends the reader to the
        // wrong place, which is the same as not reporting it.
        body: '// 1\n// 2\n// 3\n// 4\nconst bad = ( ;\n// 6\nmodule.exports = bad;\n',
        expect: ['parse-error'],
        at: { 'parse-error': 5 }
    },
    {
        name: 'a duplicate function parameter is reported as a binding',
        body: 'function f(x, x) { return x; }\nmodule.exports = f;\n',
        expect: ['duplicate-binding'],
        at: { 'duplicate-binding': 1 }
    },

    // ── duplicate object keys ──────────────────────────────────────────────
    //
    // V8 accepts these in both strict and sloppy mode, so the compiler will
    // never mention them: the second one silently wins and the value you wrote
    // is not the value you shipped.
    {
        name: 'a duplicate object key is caught',
        body: 'const p = { port: 3000, port: 8080 };\nmodule.exports = p;\n',
        expect: ['duplicate-key'],
        at: { 'duplicate-key': 1 }
    },
    {
        name: 'a duplicate key inside a function is caught',
        // Most object literals in this codebase live inside a function, and the
        // first version of this rule missed every one of them: a function body
        // does not compile as an expression, and the scan skipped past it
        // instead of proposing the inner `{` on its own turn.
        body: 'function f() { return { r: 1, r: 2 }; }\nmodule.exports = f;\n',
        expect: ['duplicate-key'],
        at: { 'duplicate-key': 1 }
    },
    {
        name: 'a duplicate key in a nested object is caught',
        body: 'const n = { ok: 1, deep: { fine: 1, fine: 2 } };\nmodule.exports = n;\n',
        expect: ['duplicate-key']
    },
    {
        name: 'a duplicate key in a nested object is reported once, not twice',
        // The outer literal and the inner one both contain the clash as far as a
        // naive depth test is concerned, and a linter that says the same thing
        // twice is one people stop reading. Only the inner literal owns the key.
        body: 'const n = { ok: 1, deep: { fine: 1, fine: 2 } };\nmodule.exports = n;\n',
        expect: ['duplicate-key'],
        count: { 'duplicate-key': 1 }
    },
    {
        name: 'a duplicate key inside a `try` block is caught',
        body: 'try { risky(); } catch (e) { const x = { c: 1, c: 2 }; }\nmodule.exports = 1;\n',
        expect: ['duplicate-key']
    },
    {
        name: 'a duplicate key across quote styles is caught',
        body: 'const b = { \'x\': 1, "x": 2 };\nmodule.exports = b;\n',
        expect: ['duplicate-key']
    },
    {
        name: 'the duplicate is reported on the later line, naming the earlier one',
        body: 'const a = 1;\nconst b = 2;\nconst p = {\n    port: 3000,\n    other: 1,\n    port: 8080\n};\nmodule.exports = { a, b, p };\n',
        expect: ['duplicate-key'],
        at: { 'duplicate-key': 6 }
    },
    {
        name: 'a ternary is not a repeated key',
        // `jobId: step ? step.jobId : ''` writes `jobId` twice — once as a key,
        // once as the end of a conditional. Reading the second as a key produced
        // four false positives on files that have no duplicate keys at all, and
        // a linter that reports clean code as broken is ignored.
        body: 'const c = { jobId: step ? step.jobId : 1, n: 2 };\nmodule.exports = c;\n',
        expect: []
    },
    {
        name: 'a nested ternary is not a repeated key',
        body: 'const c = { f: a ? b : (c ? d : e) };\nmodule.exports = c;\n',
        expect: []
    },
    {
        name: 'a string value that reads like a later key is not a duplicate',
        body: 'const d = { a: \'x\', x: 1 };\nmodule.exports = d;\n',
        expect: []
    },
    {
        name: 'a duplicate key written inside a template literal is not code',
        body: 'const t = `steps:\n  - if: a\n  - if: a`;\nmodule.exports = t;\n',
        expect: []
    },
    {
        name: 'YAML braces inside a template literal are not read as an object',
        // `{ n: [1], n: [2] }` is a duplicate key to JavaScript and a duplicate
        // to a YAML reader, and the sample workflows in this codebase live in
        // template literals. Reading the YAML produced 13 findings on one line of
        // content that is not code at all.
        body: 'const t = `strategy: { n: [1], n: [2] }`;\nmodule.exports = t;\n',
        expect: []
    },
    {
        name: 'YAML braces spread over several template lines are not read as an object',
        body: 'const t = `\n  jobs: {\n    build: {},\n    build: {}\n  }\n`;\nmodule.exports = t;\n',
        expect: []
    },
    {
        name: 'a colon inside a string is not a key',
        // Two strings that each contain `x: 1` would be counted as the key `x`
        // twice if the scan walked into string contents.
        body: 'module.exports = { a: "x: 1", b: "x: 2", c: 3 };\n',
        expect: []
    },
    {
        name: 'a duplicate key in a regular expression is not code',
        body: 'const re = /key: 1, key: 2/;\nmodule.exports = re;\n',
        expect: []
    },
    {
        name: 'a duplicate key in a comment is not code',
        body: '// { dup: 1, dup: 2 }\nmodule.exports = 1;\n',
        expect: []
    },
    {
        name: 'distinct keys are left alone',
        body: 'const a = { x: 1, y: 2, z: 3 };\nmodule.exports = a;\n',
        expect: []
    },
    {
        name: 'a `switch` and its `case` labels are not object literals',
        body: 'function pick(k) { switch (k) { case \'a\': return 1; default: return 2; } }\nmodule.exports = pick;\n',
        expect: []
    },
    {
        name: 'a `case` whose value is the string "default" is not a duplicate key',
        // `case 'default':` and `default:` are two depth-1 tokens ending in a
        // colon, which is the exact shape of a key. Reading them as a duplicate
        // would name a duplicate that is not there.
        body: 'function p(k) { switch (k) { case \'default\': return 1; default: return 2; } }\nmodule.exports = p;\n',
        expect: []
    },
    {
        name: 'a destructuring pattern is not an object literal',
        // `{ a: x, a: y }` compiles as an expression and as a pattern, and the
        // text is identical either way — so the compile check alone cannot tell
        // them apart, and reading the pattern as a literal reported "the last
        // one silently wins" about code where both bindings are created and
        // nothing is overridden.
        body: 'const { a: x, a: y } = src;\nmodule.exports = { x, y };\n',
        expect: []
    },
    {
        name: 'a destructured parameter is not an object literal',
        body: 'function f({ a: x, a: y }) { return x; }\nmodule.exports = f;\n',
        expect: []
    },
    {
        name: 'a parenthesised assignment pattern is not an object literal',
        body: 'let x, y;\n({ a: x, a: y } = src);\nmodule.exports = { x, y };\n',
        expect: []
    },
    {
        name: 'a destructured `catch` binding is not an object literal',
        body: 'try { f(); } catch ({ a: x, a: y }) { x = y; }\nmodule.exports = 1;\n',
        expect: []
    },
    {
        name: 'a duplicate key in a literal after `?` is still caught',
        body: 'const t = flag ? { t: 1, t: 2 } : null;\nmodule.exports = t;\n',
        expect: ['duplicate-key']
    },
    {
        name: 'a duplicate key in a literal after `:` is still caught',
        body: 'const n = { ok: 1, deep: { fine: 1, fine: 2 } };\nmodule.exports = n;\n',
        expect: ['duplicate-key']
    }
];

let failures = 0;

/**
 * Read the findings out of a lint run.
 *
 * The output is a heading per rule followed by one indented line per finding:
 *
 *     duplicate-key (2)
 *       src/sample.js:6 — key "port" is already set on line 4 …
 *
 * The heading carries the rule and a total, so matching headings alone counts
 * each rule once no matter how many findings it has — which is how a rule that
 * fires twice on one problem passed as correct. The finding lines are what carry
 * the line numbers, so both come from the same walk.
 */
function readFindings(output) {
    const findings = [];
    let rule = null;
    for (const text of output.split('\n')) {
        const heading = /^\s{2}([a-z-]+) \(\d+\)\s*$/.exec(text);
        if (heading) { rule = heading[1]; continue; }
        const finding = /^\s{4}\S+:(\d+) — /.exec(text);
        if (finding) findings.push({ rule, line: Number(finding[1]) });
    }
    return findings;
}

for (const testCase of CASES) {
    const fixture = makeModule(testCase.body);
    const res = fixture.run();
    const findings = readFindings(`${res.stdout || ''}${res.stderr || ''}`);
    const found = [...new Set(findings.map((f) => f.rule))];
    const unexpected = found.filter((r) => !testCase.expect.includes(r));
    const missing = testCase.expect.filter((r) => !found.includes(r));

    // How many times, not just whether. A rule that fires twice on one problem
    // is still wrong — it trains the reader to skim.
    const miscounted = [];
    for (const [rule, times] of Object.entries(testCase.count || {})) {
        const actual = findings.filter((f) => f.rule === rule).length;
        if (actual !== times) {
            miscounted.push(`${rule} reported ${actual} time(s), expected ${times}`);
        }
    }

    // A finding has to name the line that is actually wrong, or the reader is
    // sent somewhere else entirely.
    const misplaced = [];
    for (const [rule, line] of Object.entries(testCase.at || {})) {
        const lines = findings.filter((f) => f.rule === rule).map((f) => f.line);
        if (!lines.includes(line)) {
            misplaced.push(`${rule} should be on line ${line}, reported [${lines.join(', ')}]`);
        }
    }

    const ok = unexpected.length === 0 && missing.length === 0
        && misplaced.length === 0 && miscounted.length === 0;
    if (!ok) failures++;
    const problems = [];
    if (unexpected.length) problems.push(`unexpected [${unexpected}]`);
    if (missing.length) problems.push(`missing [${missing}]`);
    if (misplaced.length) problems.push(misplaced.join('; '));
    if (miscounted.length) problems.push(miscounted.join('; '));
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${testCase.name}`
        + (ok ? '' : `\n        expected [${testCase.expect}] got [${found}]${problems.length ? ` — ${problems.join('; ')}` : ''}`));
    fs.rmSync(fixture.dir, { recursive: true, force: true });
}

if (failures) {
    console.log(`\n${failures} of ${CASES.length} cases wrong`);
    process.exitCode = 1;
} else {
    console.log(`\nall ${CASES.length} cases correct`);
}
