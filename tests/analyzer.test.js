/**
 * The analyzer's whole value is that its findings are true.
 *
 * A tool that reports a step as dead code when it runs, or as an unused output
 * when something reads it, is worse than no tool: you delete working CI to make
 * a warning go away. So most of what is here is a negative case — the workflow
 * that looks broken and is not, checked beside the one that is.
 *
 * Every test states the workflow as YAML and reads the finding back.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const yaml = require('js-yaml');
const { suite, test, assert, Logger } = require('./harness');
const { Analyzer } = require('../src/core/analyzer');

Logger.setQuiet(true);

/**
 * A GitHub expression, assembled from parts.
 *
 * `${{` inside a template literal opens an interpolation and the file will not
 * parse, so the workflow fixtures below build the marker instead of writing it.
 */
const expr = (body) => '$' + '{{ ' + body + ' }}';

/** Parse a workflow written as YAML, the way the file on disk is parsed. */
const doc = (text) => yaml.load(text);

/** The findings of one kind, as `jobId → label` so assertions read clearly. */
const labels = (findings) => findings.map((f) => `${f.jobId}/${f.step || f.name}`);

/** Only the steps that cannot run at all, as opposed to the step that ends the job. */
const unreachable = (findings) => labels(findings.filter((f) => f.kind === 'unreachable'));

suite('analyzer · dead steps', () => {
    test('a step after an unconditional failure is reported', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
      - run: echo "never"
`);
        const found = Analyzer.findDeadSteps(d.jobs);
        // Two findings, two different problems. The failing step is the *cause*
        // and it does affect the result — it ends the job. The step behind it is
        // the one that can never run. Reporting them under a single "can never
        // affect the result" heading was true of one and backwards for the other.
        assert.deepStrictEqual(labels(found), ['build/exit 1', 'build/echo "never"'],
            'the cause and the consequence are both reported, and in order');
        assert.deepStrictEqual(found.map((f) => f.kind), ['always-fails', 'unreachable']);
        assert.deepStrictEqual(unreachable(found), ['build/echo "never"']);
    });

    test('an `if:` override makes the step live again', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
      - run: echo "cleanup"
        if: always()
`);
        // The `exit 1` is still a finding: it fails the job every time. What it
        // no longer does is make the next step unreachable.
        assert.deepStrictEqual(unreachable(Analyzer.findDeadSteps(d.jobs)), [],
            'a step guarded by `if:` is not dead code');
        assert.deepStrictEqual(labels(Analyzer.findDeadSteps(d.jobs)), ['build/exit 1'],
            'the failing step itself is still reported');
    });

    test('continue-on-error makes the later steps live again', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
        continue-on-error: true
      - run: echo "still runs"
`);
        assert.deepStrictEqual(Analyzer.findDeadSteps(d.jobs), [],
            'continue-on-error means the job carries on, so nothing behind it is dead');
    });

    test('every step behind a failure is reported, not just the next one', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
      - run: echo one
      - run: echo two
      - run: echo three
`);
        assert.strictEqual(unreachable(Analyzer.findDeadSteps(d.jobs)).length, 3,
            'all three later steps are unreachable');
    });

    test('`continue-on-error: false` is a failure, not a tolerance', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
        continue-on-error: false
      - run: echo "never"
`);
        assert.strictEqual(unreachable(Analyzer.findDeadSteps(d.jobs)).length, 1,
            'the explicit `false` must not read as "not set"');
    });

    test('a conditional exit is not an unconditional failure', () => {
        // `if grep -q x; then exit 1; fi` may or may not fail. Calling that
        // unconditional would make every step behind it "dead" in a workflow
        // that usually works.
        const d = doc(`
jobs:
  build:
    steps:
      - run: |
          if grep -q x file; then exit 1; fi
      - run: echo "usually runs"
`);
        assert.deepStrictEqual(Analyzer.findDeadSteps(d.jobs), [],
            'a step that may pass is not a step that always fails');
    });

    test('a failing step with nothing after it is not a finding', () => {
        // It failed the job on purpose, or it is the last thing the job does.
        // Reporting it as "makes every later step dead code" when there are no
        // later steps is a finding about nothing.
        const d = doc(`
jobs:
  build:
    steps:
      - run: exit 1
`);
        assert.deepStrictEqual(Analyzer.findDeadSteps(d.jobs), [],
            'nothing is behind it, so nothing is dead');
    });

    test('a job with no steps produces no findings', () => {
        assert.deepStrictEqual(Analyzer.findDeadSteps({ build: {} }), []);
    });
});

suite('analyzer · duplicate steps', () => {
    const SHARED = 'echo "installing dependencies for the build"';

    test('a body repeated across jobs is reported once, listing both', () => {
        const d = doc(`
jobs:
  linux:
    steps:
      - run: ${SHARED}
  mac:
    steps:
      - run: ${SHARED}
`);
        const found = Analyzer.findDuplicateSteps(d.jobs);
        assert.strictEqual(found.length, 1, `one duplicate, got ${found.length}`);
        assert.deepStrictEqual(found[0].jobs.sort(), ['linux', 'mac']);
    });

    test('the same body twice in one job is not a cross-job duplicate', () => {
        // Extracting a "composite action" for two copies in the same job would
        // be the wrong advice, so it is not reported.
        const d = doc(`
jobs:
  build:
    steps:
      - run: ${SHARED}
      - run: ${SHARED}
`);
        assert.deepStrictEqual(Analyzer.findDuplicateSteps(d.jobs), [],
            'a repeat inside one job is a different problem');
    });

    test('a very short body is not reported', () => {
        // `echo ok` appearing in five jobs is a coincidence, not a shared action.
        const d = doc(`
jobs:
  a:
    steps:
      - run: echo ok
  b:
    steps:
      - run: echo ok
`);
        assert.deepStrictEqual(Analyzer.findDuplicateSteps(d.jobs), [],
            'a 6-character body is below the reporting threshold');
    });

    test('a `uses:` action repeated in every job is not a run-body duplicate', () => {
        const d = doc(`
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
  b:
    steps:
      - uses: actions/checkout@v4
`);
        assert.deepStrictEqual(Analyzer.findDuplicateSteps(d.jobs), [],
            'checkout everywhere is the normal case, not duplication to fix');
    });
});

suite('analyzer · unused outputs', () => {
    test('an output nothing reads is reported', () => {
        const d = doc(`
jobs:
  build:
    outputs:
      sha: ${expr('steps.b.outputs.sha')}
    steps:
      - id: b
        run: echo "sha=1" >> "$GITHUB_OUTPUT"
`);
        assert.deepStrictEqual(Analyzer.findUnusedOutputs(d), [
            { jobId: 'build', name: 'sha', reason: 'declared but never referenced through needs.<job>.outputs' }
        ]);
    });

    test('an output read by a later job is not reported', () => {
        const d = doc(`
jobs:
  build:
    outputs:
      sha: ${expr('steps.b.outputs.sha')}
    steps:
      - id: b
        run: echo "sha=1" >> "$GITHUB_OUTPUT"
  deploy:
    needs: build
    steps:
      - run: echo "${expr('needs.build.outputs.sha')}"
`);
        assert.deepStrictEqual(Analyzer.findUnusedOutputs(d), [],
            'a consumed output is not unused');
    });

    test('a step output read inside the job is not a job output', () => {
        // The distinction the two cases above exist to keep: a step output read
        // by a later step in the same job is live, and neither stands in for
        // nor silences a job-level output.
        const d = doc(`
jobs:
  build:
    outputs:
      final: ${expr('steps.c.outputs.final')}
    steps:
      - id: a
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - id: c
        run: echo "final=${expr('steps.a.outputs.x')}" >> "$GITHUB_OUTPUT"
`);
        assert.deepStrictEqual(labels(Analyzer.findUnusedOutputs(d)), ['build/final'],
            'the job output is unused even though a step output is read');
    });

    test('a workflow that declares no outputs produces no findings', () => {
        assert.deepStrictEqual(Analyzer.findUnusedOutputs({ jobs: { a: { steps: [] } } }), []);
    });
});

suite('analyzer · redundant jobs', () => {
    const STEPS = '      - run: npm ci\n      - run: npm test\n';

    test('two identical jobs are reported with a fix that names one of them', () => {
        const d = yaml.load(`jobs:
  first:
    steps:
${STEPS}  second:
    steps:
${STEPS}`);
        const found = Analyzer.findRedundantJobs(d.jobs);
        assert.strictEqual(found.length, 1, `one pair, got ${found.length}`);
        assert.deepStrictEqual(found[0].jobs.sort(), ['first', 'second']);
        assert.ok(/first|second/.test(found[0].fix), `the fix must name a job: ${found[0].fix}`);
    });

    test('jobs that differ by one step are not redundant', () => {
        const d = yaml.load(`jobs:
  first:
    steps:
${STEPS}  second:
    steps:
      - run: npm ci
      - run: npm run lint
`);
        assert.deepStrictEqual(Analyzer.findRedundantJobs(d.jobs), [],
            'one different step makes them different jobs');
    });

    test('jobs with different `needs` are not redundant', () => {
        // Same steps, different dependency position: the ordering is the point.
        const d = yaml.load(`jobs:
  setup:
    steps:
${STEPS}  test:
    needs: setup
    steps:
${STEPS}`);
        assert.deepStrictEqual(Analyzer.findRedundantJobs(d.jobs), [],
            'a job that must wait for another is not a duplicate of it');
    });

    test('a job with no steps is ignored', () => {
        assert.deepStrictEqual(Analyzer.findRedundantJobs({ placeholder: {} }), [],
            'an empty job is not half of a duplication');
    });
});

suite('analyzer · shells', () => {
    test('a Windows-only shell in a Linux job is high severity', () => {
        const d = doc(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: dir
        shell: cmd
`);
        const found = Analyzer.checkShells(d.jobs);
        assert.strictEqual(found.length, 1, 'cmd on ubuntu-latest is a finding');
        assert.strictEqual(found[0].severity, 'high');
    });

    test('`pwsh` is caught too', () => {
        // The default on `windows-latest`, and the one the list was missing.
        const d = doc(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: dir
        shell: pwsh
`);
        const found = Analyzer.checkShells(d.jobs);
        assert.strictEqual(found.length, 1, 'pwsh on ubuntu-latest cannot work');
        assert.strictEqual(found[0].shell, 'pwsh');
    });

    test('a Windows shell in a job pinned to Windows is not a finding', () => {
        // `runs-on` used to be ignored, so a correct Windows job was reported
        // as a bug — the reason text even said "probably not run on Windows"
        // without ever checking.
        const d = doc(`
jobs:
  build:
    runs-on: windows-latest
    steps:
      - run: dir
        shell: pwsh
`);
        assert.deepStrictEqual(Analyzer.checkShells(d.jobs), [],
            'this is the right shell on the right runner');
    });

    test('`runs-on` as a matrix or array still counts', () => {
        assert.strictEqual(Analyzer.runsOnWindows({ 'runs-on': ['ubuntu-latest', 'windows-latest'] }), true,
            'a runner list containing Windows is a Windows job');
        assert.strictEqual(Analyzer.runsOnWindows({ 'runs-on': '${{ matrix.os }}' }), false,
            'an expression is not known to be Windows');
        assert.strictEqual(Analyzer.runsOnWindows({}), false, 'no `runs-on` is not a claim of Windows');
    });

    test('`job.defaults.run.shell` is what a step inherits', () => {
        const d = doc(`
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: pwsh
    steps:
      - run: dir
`);
        const found = Analyzer.checkShells(d.jobs);
        assert.strictEqual(found.length, 1, `inherited shell not seen: ${JSON.stringify(found)}`);
        assert.strictEqual(found[0].shell, 'pwsh');
    });

    test('a step-level shell beats the job default', () => {
        const d = doc(`
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: pwsh
    steps:
      - run: ls
        shell: bash
`);
        assert.deepStrictEqual(Analyzer.checkShells(d.jobs), [],
            'bash is not a finding even when the job default is pwsh');
    });

    test('a custom non-bash shell is a low-severity note, not a failure', () => {
        // `bash -eo pipefail {0}` is deliberately *not* flagged: it is the shape
        // GitHub's own documentation recommends, and AeroCI runs it as bash.
        const bashish = Analyzer.checkShells(doc(`
jobs:
  build:
    steps:
      - run: ls
        shell: bash -eo pipefail {0}
`).jobs);
        assert.deepStrictEqual(bashish, [],
            'a bash customisation is the recommended pattern, not a finding');

        const other = Analyzer.checkShells(doc(`
jobs:
  build:
    steps:
      - run: ls
        shell: sh -c {0}
`).jobs);
        assert.strictEqual(other.length, 1, 'a non-bash custom shell is worth naming');
        assert.strictEqual(other[0].severity, 'low');
    });

    test('a `uses:` step has no shell and is not checked', () => {
        const d = doc(`
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
`);
        assert.deepStrictEqual(Analyzer.checkShells(d.jobs), [],
            'an action is not a shell');
    });
});

suite('analyzer · complexity', () => {
    /** A workflow of `count` jobs chained one behind the next. */
    const chain = (count) => {
        const ids = Array.from({ length: count }, (_, i) => `j${i}`);
        return doc(`jobs:\n${ids.map((id, i) =>
            `  ${id}:\n    needs: ${i ? `[${ids[i - 1]}]` : '[]'}\n    steps: []`).join('\n')}`);
    };

    test('a two-job workflow scores 100 and says why', () => {
        const c = Analyzer.computeComplexityScore(doc(`
jobs:
  a:
    steps:
      - run: echo 1
  b:
    steps:
      - run: echo 2
`));
        assert.strictEqual(c.score, 100, `expected no penalty, got ${JSON.stringify(c.penalties)}`);
        assert.strictEqual(c.rating, 'simple');
    });

    test('the score never leaves 0-100', () => {
        const c = Analyzer.computeComplexityScore(chain(14));
        assert.ok(c.score >= 0 && c.score <= 100, `score out of range: ${c.score}`);
        assert.ok(c.penalties.depth > 0, `a 14-deep chain has a depth penalty: ${JSON.stringify(c.penalties)}`);
        assert.ok(c.breakdown.maxDepth === 13, `depth counted as ${c.breakdown.maxDepth}`);
    });

    test('the penalties sum to the score that was printed', () => {
        // The number is only explainable if it is derivable from the breakdown.
        const c = Analyzer.computeComplexityScore(doc(`
jobs:
  a:
    steps:
      - run: echo ${expr('github.sha')}
      - shell: bash -e {0}
        run: echo 2
  b:
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo 3
        continue-on-error: true
`));
        const raw = Object.values(c.penalties).reduce((x, y) => x + y, 0);
        assert.strictEqual(c.score, Math.max(0, Math.min(100, Math.round(100 - raw))),
            'the score and its penalties disagree');
        assert.strictEqual(c.breakdown.matrixJobs, 1, `matrix job counted: ${c.breakdown.matrixJobs}`);
        assert.strictEqual(c.breakdown.customShells, 1, `custom shell counted: ${c.breakdown.customShells}`);
        assert.strictEqual(c.breakdown.continueOnError, 1, `continue-on-error counted: ${c.breakdown.continueOnError}`);
    });

    test('the expression threshold the docs state is the one the code uses', () => {
        // `features/analyzer.md` says 0.8 per expression beyond the fifth. If
        // the threshold moves, that sentence has to move with it, so the
        // numbers are derived here rather than restated.
        const build = (n) => Analyzer.computeComplexityScore(doc(
            `jobs:\n  a:\n    steps:\n${Array.from({ length: n }, () => `      - run: echo ${expr('x')}`).join('\n')}\n`
        ));
        assert.strictEqual(build(5).penalties.expressions, 0, 'five expressions are free');
        assert.strictEqual(build(6).penalties.expressions, 0.8, 'the sixth costs 0.8');
        assert.strictEqual(build(11).penalties.expressions, 0.8 * 6, 'and it is per expression after that');
        assert.strictEqual(build(11).breakdown.expressionCount, 11, 'every expression is counted');
    });
});

suite('analyzer · matrix', () => {
    const withMatrix = (strategy) => Analyzer.analyzeMatrices(
        doc(`jobs:\n  test:\n    strategy:\n${strategy}\n    steps:\n      - run: npm test\n`).jobs
    );

    test('a matrix is expanded to the number of combinations', () => {
        const found = withMatrix('      matrix:\n        node: [18, 20, 22]\n        os: [ubuntu, macos]');
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].combinations, 6, `3 × 2 = 6, got ${found[0].combinations}`);
        assert.deepStrictEqual(found[0].axes.sort(), ['node', 'os']);
    });

    test('`exclude` removes combinations', () => {
        const found = withMatrix('      matrix:\n        node: [18, 20]\n        os: [ubuntu, macos]\n        exclude:\n          - node: 18\n            os: macos');
        assert.strictEqual(found[0].combinations, 3, `4 − 1 excluded = 3, got ${found[0].combinations}`);
    });

    test('an axis that never varies is named as wasted', () => {
        // The commonest matrix bug: a second axis added but never varied, so
        // every combination is the same job run again.
        const found = withMatrix('      matrix:\n        node: [18, 20]\n        os: [ubuntu]');
        assert.deepStrictEqual(found[0].wasted, ['os'],
            `a constant axis is not flagged: ${JSON.stringify(found[0].wasted)}`);
    });

    test('a single-combination matrix does not call its axis wasted', () => {
        const found = withMatrix('      matrix:\n        os: [ubuntu]');
        assert.deepStrictEqual(found[0].wasted, [],
            'with one combination there is nothing to be constant about');
    });

    test('`max-parallel` is a number or null, never Infinity', () => {
        // `JSON.stringify(Infinity)` is `null`, so storing Infinity would make
        // the JSON mean "unlimited" for two different reasons. It is stored as
        // null on purpose and the printer renders it as `∞`.
        assert.strictEqual(withMatrix('      max-parallel: 3\n      matrix:\n        node: [18, 20]')[0].maxParallel, 3);
        assert.strictEqual(withMatrix('      matrix:\n        node: [18, 20]')[0].maxParallel, null);
    });

    test('a job with no matrix is not reported', () => {
        assert.deepStrictEqual(Analyzer.analyzeMatrices({ test: { steps: [] } }), []);
    });
});

suite('analyzer · concurrency groups', () => {
    /** One line per conflict, so a test can say which case it meant. */
    const conflicts = (yamlText) => {
        const d = doc(yamlText);
        return Analyzer.analyzeConcurrency(d).conflicts;
    };

    const twoJobs = (a, b) => `jobs:
  a:
    runs-on: ubuntu-latest
    concurrency:
${a}
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    concurrency:
${b}
    steps:
      - run: echo b
`;

    const SET = '      group: deploy\n';
    const SET_SAFE = '      group: deploy\n      cancel-in-progress: false\n';
    const SET_KILL = '      group: deploy\n      cancel-in-progress: true\n';

    test('a group held by one job is not a conflict', () => {
        assert.deepStrictEqual(conflicts(`jobs:
  a:
    concurrency:
      group: deploy
    steps:
      - run: echo a
`), [], 'one job in a group cannot collide with itself');
    });

    test('`cancel-in-progress: false` is not described as a cancellation risk', () => {
        // This is the case that was backwards. The old code tested
        // `cancel-in-progress` against the group's *name* — a string that can
        // never contain it — so the test was always false and every group was
        // reported as "cancel-in-progress unset, a waiting job cancels the
        // running one". That is precisely the setting that stops it. Advice
        // that calls a safe workflow unsafe sends the reader to break it.
        const found = conflicts(twoJobs(SET_SAFE, SET_SAFE));
        assert.strictEqual(found.length, 1);
        assert.ok(/cancel-in-progress: false/.test(found[0]), `got: ${found[0]}`);
        assert.ok(!/cancels the one already running/.test(found[0]),
            `the safe setting must not claim a running job is cancelled: ${found[0]}`);
    });

    test('`cancel-in-progress: true` says what is actually cancelled', () => {
        // With it set, the *newcomer* cancels the job already running. The old
        // wording — "a waiting job cancels the running one" — had the direction
        // of it backwards as well.
        const found = conflicts(twoJobs(SET_KILL, SET_KILL));
        assert.strictEqual(found.length, 1);
        assert.ok(/cancel-in-progress: true/.test(found[0]), `got: ${found[0]}`);
        assert.ok(/newer job cancels the one already running/.test(found[0]),
            `it must name the newcomer as the canceller: ${found[0]}`);
    });

    test('an unset setting says a *pending* job is dropped, not the running one', () => {
        const found = conflicts(twoJobs(SET, SET));
        assert.strictEqual(found.length, 1);
        assert.ok(/without cancel-in-progress/.test(found[0]), `got: ${found[0]}`);
        assert.ok(/pending job is dropped/.test(found[0]), `got: ${found[0]}`);
        assert.ok(!/cancels the one already running/.test(found[0]),
            'with it unset the running job is not cancelled: ' + found[0]);
    });

    test('one job setting true is enough, and it says how many', () => {
        const found = conflicts(twoJobs(SET_KILL, SET));
        assert.strictEqual(found.length, 1);
        assert.ok(/one sets/.test(found[0]), `it must count, not guess: ${found[0]}`);
    });

    test('a workflow-level group is named as serialising, not cancelling', () => {
        const found = conflicts(`concurrency: deploy
jobs:
  a:
    concurrency:
      group: deploy
    steps:
      - run: echo a
  b:
    concurrency:
      group: deploy
    steps:
      - run: echo b
`);
        assert.strictEqual(found.length, 1);
        assert.ok(/workflow-level/.test(found[0]), `got: ${found[0]}`);
        assert.ok(/one at a time, in order/.test(found[0]), `got: ${found[0]}`);
    });

    test('two different groups do not interact', () => {
        const found = conflicts(`jobs:
  a:
    concurrency:
      group: deploy
    steps:
      - run: echo a
  b:
    concurrency:
      group: release
    steps:
      - run: echo b
`);
        assert.deepStrictEqual(found, [], 'separate groups cannot cancel each other');
    });
});

suite('analyzer · the report --json hands out', () => {
    const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      sha: ${expr('steps.b.outputs.sha')}
      branch: ${expr('steps.b.outputs.branch')}
    steps:
      - uses: actions/checkout@v4
      - id: b
        run: echo "sha=1" >> "$GITHUB_OUTPUT"
      - run: exit 1
      - run: echo "never"
  notify:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        channel: [a, b]
    steps:
      - run: echo "${expr('needs.build.outputs.sha')}"
`;

    /** Analyze a throwaway project containing one workflow. */
    function report() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-an-'));
        const wf = path.join(dir, 'ci.yml');
        fs.writeFileSync(wf, WORKFLOW, 'utf8');
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            return Analyzer.analyze(wf);
        } finally {
            process.chdir(cwd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('every workflow appears, not just the score', () => {
        const r = report();
        assert.strictEqual(r.workflows.length, 1, `one workflow, got ${r.workflows.length}`);
        assert.ok(r.workflows[0].file.endsWith('ci.yml'), `file path: ${r.workflows[0].file}`);
    });

    test('the report survives JSON.parse with its content intact', () => {
        // A `Map` or a `Set` in the middle serialises to `{}` and the loss is
        // invisible until a script reads the field and finds nothing in it.
        const r = report();
        const round = JSON.parse(JSON.stringify(r));
        assert.deepStrictEqual(round.workflows[0].topology.order, ['build', 'notify'],
            'the execution order did not survive serialisation');
        assert.strictEqual(round.workflows[0].criticalPath.perJob.notify, 2,
            'perJob chain cost did not survive serialisation');
        assert.strictEqual(round.workflows[0].matrix[0].combinations, 2,
            'matrix combinations did not survive serialisation');
    });

    test('the JSON findings are the findings that were printed', () => {
        const w = report().workflows[0];
        assert.deepStrictEqual(labels(w.deadSteps), ['build/exit 1', 'build/echo "never"']);
        assert.deepStrictEqual(unreachable(w.deadSteps), ['build/echo "never"'],
            'the step behind `exit 1` is the one that can never run');
        // `sha` is read by `notify`; `branch` is not read by anything. The two
        // sit side by side in the fixture so the check cannot pass by finding
        // nothing.
        assert.deepStrictEqual(labels(w.unusedOutputs), ['build/branch']);
    });

    test('the summary counts equal the sum over the workflows', () => {
        const r = report();
        const w = r.workflows[0];
        assert.strictEqual(r.defects.deadSteps, w.deadSteps.length,
            'defects must not disagree with the detail they summarise');
        assert.strictEqual(r.defects.unusedOutputs, w.unusedOutputs.length);
    });

    test('an empty target reports zero rather than throwing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-an-'));
        try {
            const r = Analyzer.analyze(path.join(dir, 'nothing-here.yml'));
            assert.strictEqual(r.files, 0);
            assert.strictEqual(r.score, null, 'a score of zero would read as a real score');
            assert.deepStrictEqual(r.workflows, [], 'the key must exist, not just be undefined');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('analyzer · nothing here is a duration', () => {
    test('no analyzer method claims to estimate a time', () => {
        // The keyword table that used to answer "how long is `npm ci`?" is gone.
        // `estimateStepCost` returned 0 on every path while its name and its
        // comment promised a number, and the CLI help advertised a "cost" the
        // command never printed. This is the guard against it coming back.
        const methods = Object.getOwnPropertyNames(Analyzer)
            .filter((k) => typeof Analyzer[k] === 'function' && !k.startsWith('_'));
        const costish = methods.filter((k) => /cost|duration|estimate|seconds|latency|elapsed/i.test(k));
        assert.deepStrictEqual(costish, [],
            `these look like they estimate a duration: ${costish.join(', ')}`);
    });
});
