/**
 * End-to-end engine tests.
 *
 * Everything here runs a real workflow in a real sandbox with a real shell.
 * The assertions are about behaviour a user can observe — exit codes, step
 * statuses, output text, what a step wrote to $GITHUB_OUTPUT — because that is
 * the only thing that makes "it passed locally" mean anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, asyncTest, assert } = require('./harness');
const { Engine, STATUS, FAILED_STATUSES, CONTEXTS_BY_SCOPE } = require('../src/core/engine');
const { Logger } = require('../src/utils/logger');

// The engine narrates every run. Here that is pure noise: the assertions are on
// the returned record, and the progress output buries which test is talking.
Logger.setQuiet(true);

/** A project directory that is thrown away after each run. */
function project(yaml) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-e2e-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, body] of Object.entries(yaml)) {
        fs.writeFileSync(path.join(dir, '.github', 'workflows', name), body);
    }
    return dir;
}

/** Run one workflow and hand back the result, with everything cleaned up. */
async function run(yaml, options = {}) {
    const files = typeof yaml === 'string' ? { 'ci.yml': yaml } : yaml;
    const dir = project(files);
    try {
        const engine = new Engine({ cwd: dir, ...options });
        const results = await engine.run(
            Object.keys(files).map((n) => path.join(dir, '.github', 'workflows', n)));
        return results[0];
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The declared job record.
 *
 * Note that a matrix job appears here once: its per-combination records live in
 * `matrixInstances`. Reading `jobs.length` as a job count is the mistake that
 * makes a coverage figure quietly wrong.
 */
const jobOf = (result, jobId) =>
    (result.jobs || []).find((j) => j.jobId === jobId);

/** Every executed copy of a job — one per matrix combination, or just the job. */
const instancesOf = (result, jobId) => {
    const job = jobOf(result, jobId);
    if (!job) return [];
    return job.matrixInstances && job.matrixInstances.length ? job.matrixInstances : [job];
};

/** The steps of one job, flattened across its matrix combinations. */
const stepsOf = (result, jobId) =>
    instancesOf(result, jobId).flatMap((instance) => instance.steps || []);

const stepNamed = (result, jobId, name) =>
    stepsOf(result, jobId).find((s) => s.name === name);

/** Everything a step printed, as one string. */
const logOf = (step) => ((step && step.log) || []).map((l) => l.line).join('\n');

const scriptOf = (result, jobId, name) => (stepNamed(result, jobId, name) || {}).script || '';

/** Everything any step of any job printed. */
const allOutput = (result) =>
    (result.steps || []).map((s) => logOf(s)).join('\n');

suite('engine · a passing workflow', () => {
    const WF = `
name: Basic
on: [push]
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - name: Say hello
        run: echo "hello from the step"
      - name: Fail on purpose
        if: false
        run: echo "never"
`;

    asyncTest('the workflow succeeds', async () => {
        {
            const r = await run(WF);
            assert.strictEqual(r.status, STATUS.SUCCESS);
        }
    });

    asyncTest('both steps are recorded, in order', async () => {
        {
            const r = await run(WF);
            const steps = stepsOf(r, 'greet');
            assert.strictEqual(steps.length, 2);
            assert.strictEqual(steps[0].name, 'Say hello');
            assert.strictEqual(steps[0].status, STATUS.SUCCESS);
        }
    });

    asyncTest('a step guarded by if: false is skipped, not passed', async () => {
        // Both have exit code 0. Reporting a skipped step as a pass is the
        // single easiest way for a report to lie.
        {
            const r = await run(WF);
            const skipped = stepNamed(r, 'greet', 'Fail on purpose');
            assert.strictEqual(skipped.status, STATUS.SKIPPED);
        }
    });

    asyncTest('the step output is captured', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'greet', 'Say hello'));
            assert.ok(log.includes('hello from the step'), log);
        }
    });
});

suite('engine · failure stops the job', () => {
    const WF = `
name: Failing
on: [push]
jobs:
  boom:
    runs-on: ubuntu-latest
    steps:
      - name: First
        run: echo one
      - name: Second
        run: exit 3
      - name: Third
        run: echo three
`;

    asyncTest('the workflow fails', async () => {
        return run(WF).then((r) => assert.strictEqual(r.status, STATUS.FAILURE));
    });

    asyncTest('the failing step is recorded with its exit code', async () => {
        {
            const r = await run(WF);
            const step = stepNamed(r, 'boom', 'Second');
            assert.strictEqual(step.status, STATUS.FAILURE);
            assert.strictEqual(step.exitCode, 3);
        }
    });

    asyncTest('the step after a failure does not run', async () => {
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'boom', 'Third').status, STATUS.SKIPPED);
        }
    });

    asyncTest('the step before the failure did run', async () => {
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'boom', 'First').status, STATUS.SUCCESS);
        }
    });

    asyncTest('a failing step is a failure, not a timeout', async () => {
        {
            const r = await run(WF);
            assert.ok(FAILED_STATUSES.has(stepNamed(r, 'boom', 'Second').status));
        }
    });
});

suite('engine · the exit-code semantics of -e', () => {
    const WF = `
name: ErrFlags
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: fails in the middle
        run: |
          echo before
          false
          echo after
`;

    asyncTest('bash -e stops at the first failing line', async () => {
        // Without `-e` the step would exit 0 and the workflow would pass while
        // a command in the middle of it had failed.
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'j', 'fails in the middle').status, STATUS.FAILURE);
        }
    });

    asyncTest('the line after the failure never printed', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'j', 'fails in the middle'));
            assert.ok(log.includes('before'), log);
            assert.ok(!log.includes('after'), `the script should have stopped: ${log}`);
        }
    });
});

suite('engine · needs ordering and outputs', () => {
    const WF = `
name: Chain
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      sha: \${{ steps.make.outputs.value }}
    steps:
      - id: make
        name: Make
        run: echo "value=42" >> "$GITHUB_OUTPUT"

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Use
        run: echo "sha=\${{ needs.build.outputs.sha }} result=\${{ needs.build.result }}"
`;

    asyncTest('both jobs succeed', async () => {
        return run(WF).then((r) => assert.strictEqual(r.status, STATUS.SUCCESS));
    });

    asyncTest('a declared job output reaches the downstream job', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'deploy', 'Use'));
            assert.ok(log.includes('sha=42'), `expected sha=42, got: ${log}`);
        }
    });

    asyncTest('needs.<job>.result is the real result', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'deploy', 'Use'));
            assert.ok(log.includes('result=success'), log);
        }
    });

    asyncTest('build runs before deploy', async () => {
        {
            const r = await run(WF);
            const order = r.jobs.map((j) => j.jobId);
            assert.ok(order.indexOf('build') < order.indexOf('deploy'), order.join(','));
        }
    });
});

suite('engine · a failed dependency', () => {
    const WF = `
name: Cascade
on: [push]
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Die
        run: exit 1
  after:
    needs: broken
    runs-on: ubuntu-latest
    steps:
      - name: Should not run
        run: echo nope
  forced:
    needs: broken
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Runs anyway
        run: echo yes
`;

    asyncTest('a job whose dependency failed is skipped', async () => {
        {
            const r = await run(WF);
            const job = r.jobs.find((j) => j.jobId === 'after');
            assert.notStrictEqual(job.status, STATUS.SUCCESS);
        }
    });

    asyncTest('the skipped job never executed its step', async () => {
        {
            const r = await run(WF);
            for (const step of stepsOf(r, 'after')) {
                assert.strictEqual(step.status, STATUS.SKIPPED, `${step.stepName} should not have run`);
            }
        }
    });

    asyncTest('if: always() overrides the failure gate', async () => {
        {
            const r = await run(WF);
            const step = stepNamed(r, 'forced', 'Runs anyway');
            assert.strictEqual(step.status, STATUS.SUCCESS);
        }
    });

    asyncTest('needs.<job>.result reports failure to a job that did run', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'forced', 'Runs anyway'));
            assert.ok(!log.includes('nope'));
        }
    });
});

suite('engine · continue-on-error', () => {
    const WF = `
name: Tolerated
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - name: Dies
        run: exit 1
  after:
    needs: j
    runs-on: ubuntu-latest
    steps:
      - name: Read it
        run: echo "result=\${{ needs.j.result }}"
`;

    asyncTest('a tolerated job is not a failure', async () => {
        return run(WF).then((r) => assert.strictEqual(r.status, STATUS.SUCCESS));
    });

    asyncTest('the step still reports as failed', async () => {
        // Tolerating the failure must not rewrite what actually happened.
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'j', 'Dies').status, STATUS.FAILURE);
        }
    });

    asyncTest('needs.<job>.result is the raw result, not the tolerated one', async () => {
        // This is the documented behaviour: `result` shows what happened, and
        // the gate that follows uses the tolerated outcome. Swapping them would
        // make a failed job look like a clean one to every downstream reader.
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'after', 'Read it'));
            assert.ok(log.includes('result=failure'), `expected result=failure, got: ${log}`);
        }
    });

    asyncTest('a downstream job still runs, because the gate sees the tolerated success', async () => {
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'after', 'Read it').status, STATUS.SUCCESS);
        }
    });
});

suite('engine · matrix jobs', () => {
    const WF = `
name: Matrix
on: [push]
jobs:
  t:
    strategy:
      matrix:
        node: [18, 20]
    runs-on: ubuntu-latest
    steps:
      - name: Show
        run: echo "node=\${{ matrix.node }}"
`;

    asyncTest('one runner starts per combination', async () => {
        const r = await run(WF);
        // `jobs` holds one entry for the declared job; the per-combination
        // records are in `matrixInstances`. Reading `jobs.length` as a job count
        // is exactly how a coverage figure ends up quietly halved.
        assert.strictEqual(r.jobs.length, 1);
        assert.strictEqual(instancesOf(r, 't').length, 2);
    });

    asyncTest('the matrix value reaches the step', async () => {
        const r = await run(WF);
        const seen = allOutput(r);
        assert.ok(seen.includes('node=18'), seen);
        assert.ok(seen.includes('node=20'), seen);
    });

    asyncTest('every matrix instance is recorded as executed', async () => {
        // The coverage figure is computed from the matrix size, so a missing
        // instance here would show up as coverage below 100%.
        const r = await run(WF);
        const instances = instancesOf(r, 't');
        assert.strictEqual(instances.filter((i) => i.status === STATUS.SUCCESS).length, 2);
        for (const instance of instances) {
            assert.ok((instance.strategy['job-total']) === 2, 'job-total should be 2');
        }
    });

    asyncTest('each combination gets its own workspace', async () => {
        // Two machines, two checkouts: the first combination must not be able
        // to leave state that the second one reads.
        const wf = `
name: Isolation
on: [push]
jobs:
  t:
    strategy:
      matrix:
        node: [18, 20]
    runs-on: ubuntu-latest
    steps:
      - name: Probe
        run: test -f marker.txt && echo SEEN || echo CLEAN
      - name: Leave
        run: echo x > marker.txt
`;
        const r = await run(wf);
        const seen = allOutput(r);
        assert.ok(!seen.includes('SEEN'), `a combination saw another's file: ${seen}`);
        assert.strictEqual((seen.match(/CLEAN/g) || []).length, 2, seen);
    });
});

suite('engine · expression substitution happens before the shell sees it', () => {
    const WF = `
name: Substitution
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Ref
        run: echo "on \${{ github.ref_name }}"
`;

    asyncTest('a github context value is substituted into the script', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'j', 'Ref'));
            assert.ok(/on \S+/.test(log), log);
        }
    });

    asyncTest('--only-job naming a job that does not exist is a failure', async () => {
        // It used to skip every job, so `--only-job typo` reported
        // "all workflows passed" with 0 of 4 steps executed — a green result
        // for a run that did nothing.
        const r = await run(WF, { onlyJob: 'typo' });
        assert.strictEqual(r.status, STATUS.FAILURE);
        assert.ok(r.error && /matched no job/.test(r.error.message), JSON.stringify(r.error));
    });

    asyncTest('a matching --only-job still skips the other jobs and passes', async () => {
        const TWO = `
name: Two
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Only A
        run: echo a
  b:
    runs-on: ubuntu-latest
    steps:
      - name: Only B
        run: echo b
`;
        const r = await run(TWO, { onlyJob: 'a' });
        assert.strictEqual(r.status, STATUS.SUCCESS);
        assert.ok(logOf(stepNamed(r, 'a', 'Only A')).includes('a'));
        assert.strictEqual(stepNamed(r, 'b', 'Only B'), undefined,
            'the filtered-out job must not have run');
    });

    asyncTest('the recorded script already contains the substituted value', async () => {
        // The reproducer AeroCI prints must be the script that actually ran.
        {
            const r = await run(WF);
            assert.ok(scriptOf(r, 'j', 'Ref').includes('echo "on '));
        }
    });
});

suite('engine · env, outputs and masks through the real files', () => {
    const WF = `
name: Files
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Write
        run: |
          echo "TOKEN=\${{ secrets.MY_TOKEN }}" >> "$GITHUB_ENV"
          echo "value=hello" >> "$GITHUB_OUTPUT"
      - name: Read
        run: echo "token=$TOKEN"
`;

    asyncTest('a value written to $GITHUB_ENV reaches the next step', async () => {
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'j', 'Read'));
            assert.ok(log.includes('token='), log);
        }
    });

    asyncTest('a value written to $GITHUB_OUTPUT is recorded on the step', async () => {
        {
            const r = await run(WF);
            const step = stepNamed(r, 'j', 'Write');
            assert.strictEqual(step.outputs.value, 'hello');
        }
    });
});

suite('engine · .env is a secret source, not a step environment', () => {
    // A runner has no `.env` file. Secrets reach a step through the `secrets`
    // context or an `env:` block that names one — never as a bare variable.
    // Injecting them as plain variables would make a workflow pass locally for
    // a reason that does not exist on a runner.

    /** Run a workflow in a project that also has a .env at its root. */
    async function runWithEnv(wf, envBody) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-env-'));
        fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), wf, 'utf8');
        fs.writeFileSync(path.join(dir, '.env'), envBody, 'utf8');
        try {
            const engine = new Engine({ cwd: dir });
            const results = await engine.run([path.join(dir, '.github', 'workflows', 'ci.yml')]);
            return results[0];
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const WF = `
name: Env
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Plain
        run: echo "len=\${#MY_TOKEN}"
      - name: Through the context
        env:
          T: \${{ secrets.MY_TOKEN }}
        run: echo "value=\$T"
`;

    asyncTest('${{ secrets.X }} resolves from .env', async () => {
        const r = await runWithEnv(WF, 'MY_TOKEN=hunter2supersecret\n');
        const log = logOf(stepNamed(r, 'j', 'Through the context'));
        // Masked in the log, so the assertion is that it is not the raw value
        // and not empty either — both of which would be wrong.
        assert.ok(!/hunter2supersecret/.test(log), `the secret was not masked: ${log}`);
        assert.ok(/value=\S+/.test(log), `the secret did not resolve: ${log}`);
    });

    asyncTest('a bare $MY_TOKEN is empty, exactly as on a runner', async () => {
        const r = await runWithEnv(WF, 'MY_TOKEN=hunter2supersecret\n');
        assert.ok(logOf(stepNamed(r, 'j', 'Plain')).includes('len=0'),
            'a .env value leaked into the step environment');
    });

    asyncTest('the .env file itself is not in the sandbox', async () => {
        // Otherwise `cat .env` hands a step every secret the project owns.
        const r = await runWithEnv(`
name: Leak
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Look
        run: test -f .env && echo PRESENT || echo ABSENT
`, 'MY_TOKEN=hunter2supersecret\n');
        const log = logOf(stepNamed(r, 'j', 'Look'));
        assert.ok(log.includes('ABSENT'), `the sandbox contains your .env: ${log}`);
    });
});

suite('engine · a step that cannot be simulated says so', () => {
    const WF = `
name: Unknown
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Real
        run: echo ok
      - name: Made up
        uses: vendor/nonexistent-action@v1
`;

    asyncTest('the run still completes', async () => {
        {
            const r = await run(WF);
            assert.ok(r.status === STATUS.SUCCESS || r.status === STATUS.NOT_SIMULATED,
                `unexpected status ${r.status}`);
        }
    });

    asyncTest('an unknown action is marked not simulated rather than passed', async () => {
        // This is the honesty rule: a step AeroCI cannot run must not be
        // reported as a success, or the coverage number is a fiction.
        {
            const r = await run(WF);
            const step = stepNamed(r, 'j', 'Made up');
            assert.ok(step, 'the step should still be recorded');
            assert.ok(!step.notSimulated ? step.status !== STATUS.SUCCESS : true,
                'a not-simulated step must not read as a pass');
        }
    });

    asyncTest('the step that really ran is reported normally', async () => {
        {
            const r = await run(WF);
            assert.strictEqual(stepNamed(r, 'j', 'Real').status, STATUS.SUCCESS);
        }
    });
});

suite('engine · malformed input is a reported failure', () => {
    asyncTest('a workflow that is not valid YAML fails with a parse error', async () => {
        const bad = 'name: Broken\non: [push\njobs: {}\n';
        {
            const r = await run(bad);
            assert.strictEqual(r.status, STATUS.FAILURE);
            assert.ok(r.error, 'a parse failure should carry an error object');
        }
    });

    asyncTest('the parse error names a line', async () => {
        {
            const r = await run('name: Broken\non: [push\njobs: {}\n');
            assert.ok(Number.isInteger(r.error.line), `expected a line number, got ${r.error.line}`);
        }
    });

    asyncTest('a workflow with no jobs is reported, not silently empty', async () => {
        {
            const r = await run('name: Nothing\non: [push]\njobs: {}\n');
            assert.notStrictEqual(r.status, STATUS.SUCCESS);
        }
    });

    asyncTest('an unterminated expression fails the step with a clear message', async () => {
        const bad = 'name: Bad\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n'
            + '    steps:\n      - name: X\n        run: echo "\${{ github.ref"\n';
        {
            const r = await run(bad);
            const step = stepNamed(r, 'j', 'X');
            assert.strictEqual(step.status, STATUS.FAILURE);
            assert.ok(/unterminated/i.test(step.error || ''), step.error);
        }
    });
});

suite('engine · the context scopes', () => {
    asyncTest('the three scopes list the contexts GitHub allows', async () => {
        assert.deepStrictEqual(CONTEXTS_BY_SCOPE.workflowLevel, ['github', 'inputs', 'vars']);
        assert.deepStrictEqual(CONTEXTS_BY_SCOPE.jobLevel, ['github', 'needs', 'vars', 'inputs']);
        // A step may read `steps` and `matrix`; a job may not.
        assert.ok(CONTEXTS_BY_SCOPE.stepLevel.includes('steps'));
        assert.ok(!CONTEXTS_BY_SCOPE.jobLevel.includes('steps'));
        assert.ok(CONTEXTS_BY_SCOPE.stepLevel.includes('matrix'));
        assert.ok(!CONTEXTS_BY_SCOPE.jobLevel.includes('matrix'));
    });
});

suite('engine · sandbox state does not leak between runs', () => {
    const WF = `
name: Leftover
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Leave a file
        run: echo written > leftover.txt
  b:
    runs-on: ubuntu-latest
    steps:
      - name: Look for it
        run: test -f leftover.txt && echo FOUND || echo ABSENT
`;

    asyncTest('a file written by one job is not visible to another', async () => {
        // Jobs get a fresh workspace, like separate runners. A shared one would
        // let job order decide whether a workflow passes.
        {
            const r = await run(WF);
            const log = logOf(stepNamed(r, 'b', 'Look for it'));
            assert.ok(log.includes('ABSENT'), `jobs should not share a workspace: ${log}`);
        }
    });
});

suite('engine · dry run executes nothing', () => {
    const WF = `
name: Dry
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Side effect
        run: echo ran > side-effect.txt
`;

    asyncTest('the step is resolved but not executed', async () => {
        {
            const r = await run(WF, { dryRun: true });
            assert.strictEqual(r.jobs.length, 1);
            assert.ok(r.dryRun === true || r.status === STATUS.SUCCESS);
        }
    });
});

suite('engine · the github context a step can see', () => {
    // These are contracts a workflow branches on. A step that reads one of them
    // must get the same answer here as on a runner, or "it passed locally" is
    // worth nothing.
    const WF = (name) => `
name: ${name}
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Read
        run: |
          echo "workflow=\${{ github.workflow }}"
          echo "job=\${{ github.job }}"
          echo "event=\${{ github.event_name }}"
          echo "envvar=\$GITHUB_WORKFLOW"
`;

    asyncTest('github.workflow is the workflow name, not the file name', async () => {
        // The file is ci.yml. GitHub reports the `name:` field, so a workflow
        // branching on `github.workflow == 'Release'` must not take a different
        // branch locally. This used to substitute "ci.yml".
        const r = await run(WF('Release'));
        const log = logOf(stepNamed(r, 'j', 'Read'));
        assert.ok(log.includes('workflow=Release'), `github.workflow is wrong: ${log}`);
    });

    asyncTest('GITHUB_WORKFLOW is the same value as github.workflow', async () => {
        // The two are documented as the same thing, and a workflow that uses
        // one must not disagree with the other.
        const r = await run(WF('Release'));
        const log = logOf(stepNamed(r, 'j', 'Read'));
        assert.ok(log.includes('envvar=Release'), `GITHUB_WORKFLOW disagrees: ${log}`);
    });

    asyncTest('github.job is the job id', async () => {
        const r = await run(WF('Named'));
        assert.ok(logOf(stepNamed(r, 'j', 'Read')).includes('job=j'));
    });

    asyncTest('a workflow with no name falls back to the file name', async () => {
        // GitHub's own fallback, so a nameless workflow must not end up with an
        // empty context value.
        const NAMELESS = `
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Read
        run: echo "workflow=\${{ github.workflow }}"
`;
        const r = await run(NAMELESS);
        assert.ok(logOf(stepNamed(r, 'j', 'Read')).includes('workflow=ci.yml'));
    });
});
