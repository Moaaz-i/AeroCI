/**
 * The pre-flight checker.
 *
 * Its value is entirely in what it catches before a run, so the cases below
 * focus on the mistakes that a real runner rejects or silently mishandles — and
 * on not crying wolf on valid workflows.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const { Checker, SEVERITY } = require('../src/core/checker');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** Write a one-off workflow and check it. */
function check(yaml, { name = 'ci.yml', dir = null, options = {} } = {}) {
    const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-check-'));
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml);
    try {
        return Checker.check(file, options);
    } finally {
        if (!dir) fs.rmSync(root, { recursive: true, force: true });
    }
}

/** Findings of one rule, for a compact assertion. */
const byRule = (out, rule) => out.findings.filter((f) => f.rule === rule);
const errorsOf = (out, rule) => byRule(out, rule).filter((f) => f.severity === SEVERITY.ERROR);
const warningsOf = (out, rule) => byRule(out, rule).filter((f) => f.severity === SEVERITY.WARNING);

const MINIMAL = (steps) => `
name: C
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

suite('checker · the result shape', () => {
    test('a clean workflow is valid with no errors', () => {
        const out = check(MINIMAL('      - run: echo hi\n'));
        assert.strictEqual(out.valid, true);
        assert.deepStrictEqual(errorsOf(out).length, 0, JSON.stringify(out.findings, null, 1));
    });

    test('valid is decided by errors, not by warnings', () => {
        // A missing `permissions:` block is worth a warning, not a failed
        // pre-flight: the workflow still runs.
        const out = check(MINIMAL('      - run: echo hi\n'));
        assert.ok(warningsOf(out, 'permissions').length > 0, 'expected a permissions warning');
        assert.strictEqual(out.valid, true);
    });

    test('an error makes the workflow invalid', () => {
        const out = check(MINIMAL('      - name: nothing\n'));
        assert.strictEqual(out.valid, false);
    });

    test('a missing path is an error, and there is a finding behind it', () => {
        // A summary that says "1 error" with an empty finding list is worse
        // than either: it looks like a bug in the tool and hides the real one.
        const ghost = path.join(os.tmpdir(), 'aeroci-no-such-workflow-xyz.yml');
        const out = Checker.check(ghost);
        assert.strictEqual(out.valid, false);
        assert.strictEqual(out.errors, 1);
        assert.strictEqual(out.findings.length, 1);
        assert.ok(/no such file or directory/.test(out.findings[0].message), out.findings[0].message);
    });

    test('an existing directory with no workflows says so, distinctly', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-check-empty-'));
        try {
            const out = Checker.check(dir);
            assert.strictEqual(out.findings.length, 1);
            assert.ok(/no \.yml or \.yaml workflow files/.test(out.findings[0].message), out.findings[0].message);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('checker · job structure', () => {
    test('a job with no steps is flagged', () => {
        const out = check(`
name: C
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
`);
        assert.ok(byRule(out, 'structure').some((f) => /no steps/.test(f.message)), JSON.stringify(out.findings));
    });

    test('a job with neither run nor uses is an error', () => {
        const out = check(MINIMAL('      - name: empty\n        with:\n          a: b\n'));
        assert.ok(errorsOf(out, 'schema').some((f) => /neither `run` nor `uses`/.test(f.message)));
    });

    test('a step with both run and uses is an error', () => {
        const out = check(MINIMAL('      - run: echo hi\n        uses: actions/checkout@v4\n'));
        assert.ok(errorsOf(out, 'schema').some((f) => /both `run` and `uses`/.test(f.message)));
    });

    test('a step key GitHub does not know is flagged, with a typo hint', () => {
        // GitHub ignores unknown step keys silently, so a typo is invisible
        // until the behaviour you configured simply does not happen.
        const out = check(MINIMAL('      - run: echo hi\n        continute-on-error: true\n'));
        const finding = byRule(out, 'schema').find((f) => /unrecognised key "continute-on-error"/.test(f.message));
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/typo/i.test(finding.fix || ''), finding.fix);
    });

    test('a quoted false in run: is not read as a boolean', () => {
        // `run: false` parses as YAML false; the author meant the string.
        const out = check(MINIMAL('      - run: false\n'));
        assert.ok(errorsOf(out, 'schema').some((f) => /parsed as a boolean/.test(f.message)));
    });

    test('a quoted run: "false" is fine', () => {
        const out = check(MINIMAL('      - run: "false"\n'));
        assert.ok(!errorsOf(out, 'schema').some((f) => /parsed as a boolean/.test(f.message)));
    });
});

suite('checker · job outputs', () => {
    const READ = (expr) => `
name: C
on: [push]
jobs:
  producer:
    runs-on: ubuntu-latest
    outputs:
      sha: \${{ steps.make.outputs.value }}
    steps:
      - id: make
        run: echo "value=1" >> "$GITHUB_OUTPUT"
  consumer:
    needs: producer
    runs-on: ubuntu-latest
    steps:
      - run: echo "${expr}"
`;

    test('a declared output read from a real step is not flagged', () => {
        const out = check(READ('needs.producer.outputs.sha'));
        assert.deepStrictEqual(errorsOf(out, 'outputs'), []);
        assert.deepStrictEqual(warningsOf(out, 'outputs'), []);
    });

    test('the bracket spelling is not flagged either', () => {
        const out = check(READ("needs['producer']['outputs']['sha']"));
        assert.deepStrictEqual(errorsOf(out, 'outputs'), []);
    });

    test('reading an output that was never declared is an error', () => {
        // This resolves to an empty string on the runner, so a deployment step
        // gets a blank value and the workflow still goes green.
        const out = check(READ('needs.producer.outputs.nothere'));
        assert.ok(errorsOf(out, 'outputs').some((f) => /nothere/.test(f.message)), JSON.stringify(out.findings));
    });

    test('a script reading a step id no step carries is an error', () => {
        // `steps` is built from the `id:` of the steps in the same job. A name
        // that is not there is unconditionally empty, and nothing on the real
        // runner complains — the value is just blank.
        const yaml = `
name: C
on: [push]
jobs:
  consumer:
    runs-on: ubuntu-latest
    steps:
      - run: echo "sha=\${{ steps.make.outputs.value }}"
`;
        const out = check(yaml);
        const finding = errorsOf(out, 'outputs').find((f) => /make/.test(f.message));
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/no step in job "consumer"/.test(finding.message), finding.message);
    });

    test('the same missing id read twice in one step is one finding', () => {
        const yaml = `
name: C
on: [push]
jobs:
  consumer:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ steps.make.outputs.a }} \${{ steps.make.outputs.b }}"
`;
        const out = check(yaml);
        assert.strictEqual(errorsOf(out, 'outputs').length, 1, JSON.stringify(out.findings, null, 1));
    });

    test('an output read from a step id that does not exist is an error', () => {
        const yaml = `
name: C
on: [push]
jobs:
  producer:
    runs-on: ubuntu-latest
    outputs:
      sha: \${{ steps.nosuch.outputs.value }}
    steps:
      - id: make
        run: echo hi
`;
        const out = check(yaml);
        assert.ok(errorsOf(out, 'outputs').some((f) => /nosuch/.test(f.message)), JSON.stringify(out.findings));
    });

    test('a step conclusion that no step produces is an error', () => {
        const yaml = `
name: C
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ steps.build.conclusion }}"
`;
        const out = check(yaml);
        assert.ok(errorsOf(out, 'outputs').some((f) => /build/.test(f.message)), JSON.stringify(out.findings));
    });

    test('the message names the step that has to carry the id', () => {
        const yaml = `
name: C
on: [push]
jobs:
  producer:
    runs-on: ubuntu-latest
    outputs:
      sha: \${{ steps.nosuch.outputs.value }}
    steps:
      - name: Make
        run: echo hi
`;
        const out = check(yaml);
        const finding = errorsOf(out, 'outputs')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/id: nosuch/.test(finding.fix || ''), finding.fix);
    });
});

suite('checker · secrets', () => {
    test('reading a property of a secret is an error', () => {
        // `secrets` maps names to strings, so this is always empty.
        const out = check(MINIMAL('      - run: echo "${{ secrets.NPM_TOKEN.value }}"\n'));
        assert.ok(errorsOf(out, 'secrets').some((f) => /NPM_TOKEN/.test(f.message)), JSON.stringify(out.findings));
    });

    test('the bracket spelling is caught too', () => {
        const out = check(MINIMAL("      - run: echo \"${{ secrets['TOK']['name'] }}\"\n"));
        assert.ok(errorsOf(out, 'secrets').length > 0, JSON.stringify(out.findings));
    });

    test('a plain secret read is not flagged', () => {
        const out = check(MINIMAL('      - run: echo "${{ secrets.TOKEN }}"\n'));
        assert.deepStrictEqual(errorsOf(out, 'secrets'), []);
    });

    test('a secret read at workflow level is caught', () => {
        const out = check(`
name: C
on: [push]
env:
  X: \${{ secrets.FOO.bar }}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
        assert.ok(errorsOf(out, 'secrets').some((f) => /FOO/.test(f.message)), JSON.stringify(out.findings));
    });

    test('a referenced secret with no local value is reported as missing', () => {
        const out = check(MINIMAL('      - run: echo "${{ secrets.NOSUCHVALUE }}"\n'));
        const finding = byRule(out, 'secrets').find((f) => /no local value/.test(f.message));
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/NOSUCHVALUE/.test(finding.message));
    });
});

suite('checker · matrix', () => {
    test('a valid matrix is not flagged', () => {
        const out = check(`
name: C
on: [push]
jobs:
  j:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
        assert.deepStrictEqual(byRule(out, 'matrix'), []);
    });

    test('an axis with a single value is flagged as pointless', () => {
        const out = check(`
name: C
on: [push]
jobs:
  j:
    strategy:
      matrix:
        node: [20]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
        assert.ok(byRule(out, 'matrix').length > 0, JSON.stringify(out.findings));
    });

    test('an empty axis is flagged, because it removes every job', () => {
        const out = check(`
name: C
on: [push]
jobs:
  j:
    strategy:
      matrix:
        node: []
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
        assert.ok(byRule(out, 'matrix').length > 0, JSON.stringify(out.findings));
    });
});

suite('checker · actions', () => {
    test('an action pinned to a tag gets a note about the SHA', () => {
        const out = check(MINIMAL('      - uses: actions/checkout@v4\n'));
        const finding = byRule(out, 'actions').find((f) => /tag/.test(f.message));
        assert.ok(finding, JSON.stringify(out.findings));
        // An advisory, not an error: a tag is a perfectly valid pin.
        assert.strictEqual(finding.severity, SEVERITY.INFO);
    });

    test('an action pinned to a full SHA is confirmed, not complained about', () => {
        // Silence would leave a reader unsure whether the rule even ran, so the
        // good case is stated too.
        const sha = 'a'.repeat(40);
        const out = check(MINIMAL(`      - uses: actions/checkout@${sha}\n`));
        const findings = byRule(out, 'actions');
        assert.strictEqual(findings.length, 1, JSON.stringify(out.findings));
        assert.ok(/good practice/i.test(findings[0].message), findings[0].message);
        assert.strictEqual(findings[0].severity, SEVERITY.INFO);
    });

    test('an action with no version at all is an error, not a note', () => {
        const out = check(MINIMAL('      - uses: actions/checkout\n'));
        const finding = errorsOf(out, 'schema').find((f) => /has no version/.test(f.message));
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/actions\/checkout@v4/.test(finding.fix || ''), finding.fix);
    });

    test('a short SHA is still accepted, with a lighter note', () => {
        const out = check(MINIMAL('      - uses: actions/checkout@abc1234\n'));
        assert.strictEqual(errorsOf(out, 'schema').length, 0, JSON.stringify(out.findings));
    });

    test('a local action path is accepted', () => {
        const out = check(MINIMAL('      - uses: ./.github/actions/build\n'));
        assert.deepStrictEqual(errorsOf(out, 'actions'), []);
    });
});

suite('checker · scripts', () => {
    test('sudo is noted, because it is a no-op on a hosted runner', () => {
        const out = check(MINIMAL('      - run: sudo apt-get install -y jq\n'));
        assert.ok(byRule(out, 'permissions').some((f) => /sudo/.test(f.message)), JSON.stringify(out.findings));
    });

    test('an unknown shell is flagged with the list of real ones', () => {
        const out = check(MINIMAL('      - run: echo hi\n        shell: ksh\n'));
        const finding = byRule(out, 'shell')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/bash/.test(finding.fix || ''), finding.fix);
    });

    test('a custom shell containing {0} is accepted', () => {
        const out = check(MINIMAL('      - run: echo hi\n        shell: perl {0}\n'));
        assert.deepStrictEqual(byRule(out, 'shell'), []);
    });
});

suite('checker · collecting files', () => {
    test('a directory of workflows yields every yml and yaml file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-collect-'));
        fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
        const wf = path.join(dir, '.github', 'workflows');
        fs.writeFileSync(path.join(wf, 'a.yml'), 'name: A\n');
        fs.writeFileSync(path.join(wf, 'b.yaml'), 'name: B\n');
        fs.writeFileSync(path.join(wf, 'readme.md'), 'not a workflow\n');
        try {
            // A project root is the common target, and its workflows live one
            // level down where GitHub keeps them.
            const names = Checker.collectFiles(dir).map((f) => path.basename(f)).sort();
            assert.deepStrictEqual(names, ['a.yml', 'b.yaml']);
            assert.deepStrictEqual(
                Checker.collectFiles(wf).map((f) => path.basename(f)).sort(), ['a.yml', 'b.yaml']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a glob target still works', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-collect-'));
        const wf = path.join(dir, 'flows');
        fs.mkdirSync(wf, { recursive: true });
        fs.writeFileSync(path.join(wf, 'a.yml'), 'name: A\n');
        fs.writeFileSync(path.join(wf, 'b.yaml'), 'name: B\n');
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            const names = Checker.collectFiles('flows/*.y*l').map((f) => path.basename(f));
            assert.deepStrictEqual(names, ['a.yml', 'b.yaml']);
        } finally {
            process.chdir(cwd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a single file is accepted as a target', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-collect-'));
        const file = path.join(dir, 'one.yml');
        fs.writeFileSync(file, 'name: A\n');
        try {
            assert.deepStrictEqual(Checker.collectFiles(file), [file]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a single non-workflow file is not collected as one', () => {
        // Otherwise AeroCI parses notes.txt and reports its contents as a
        // malformed workflow, which answers a question nobody asked.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-collect-'));
        const file = path.join(dir, 'notes.txt');
        fs.writeFileSync(file, 'hello\n');
        try {
            assert.deepStrictEqual(Checker.collectFiles(file), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a non-workflow file is not collected as one', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-collect-'));
        const file = path.join(dir, 'notes.txt');
        fs.writeFileSync(file, 'hello\n');
        try {
            assert.deepStrictEqual(Checker.collectFiles(file), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
