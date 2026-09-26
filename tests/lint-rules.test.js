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
    }
];

let failures = 0;

for (const testCase of CASES) {
    const fixture = makeModule(testCase.body);
    const res = fixture.run();
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const found = [...output.matchAll(/^\s{2}([a-z-]+) \(\d+\)/gm)].map((m) => m[1]);
    const unexpected = found.filter((rule) => !testCase.expect.includes(rule));
    const missing = testCase.expect.filter((rule) => !found.includes(rule));
    const ok = unexpected.length === 0 && missing.length === 0;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${testCase.name}`
        + (ok ? '' : `\n        expected [${testCase.expect}] got [${found}]`));
    fs.rmSync(fixture.dir, { recursive: true, force: true });
}

if (failures) {
    console.log(`\n${failures} of ${CASES.length} cases wrong`);
    process.exitCode = 1;
} else {
    console.log(`\nall ${CASES.length} cases correct`);
}
