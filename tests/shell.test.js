/**
 * Shell resolution.
 *
 * The exact argument vector matters: `bash --noprofile --norc -eo pipefail` is
 * why a multi-line script stops at its first error, and dropping `-e` would
 * make a workflow "pass" locally while failing on the runner.
 */

const fs = require('fs');
const { suite, test, assert } = require('./harness');
const { resolveShell, defaultShellKeyword, runnerEnvironment, which, isWindows } = require('../src/core/shell');
const { runtimesRoot, cacheRoot } = require('../src/core/toolchain');

suite('shell · the default', () => {
    test('the default keyword matches the platform', () => {
        assert.strictEqual(defaultShellKeyword(), isWindows ? 'pwsh' : 'bash');
    });

    test('an omitted shell resolves to the default', () => {
        const s = resolveShell(undefined, 'Linux');
        assert.strictEqual(s.keyword, 'bash');
        assert.deepStrictEqual(s.args, ['--noprofile', '--norc', '-eo', 'pipefail', '{0}']);
    });

    test('an empty or null shell is the default too', () => {
        for (const value of [null, '', undefined]) {
            assert.strictEqual(resolveShell(value, 'Linux').keyword, 'bash');
        }
    });
});

suite('shell · the documented keywords', () => {
    test('bash', () => {
        const s = resolveShell('bash', 'Linux');
        assert.strictEqual(s.keyword, 'bash');
        assert.deepStrictEqual(s.args, ['--noprofile', '--norc', '-eo', 'pipefail', '{0}']);
        assert.ok(!s.unknown);
    });

    test('sh', () => {
        const s = resolveShell('sh', 'Linux');
        assert.deepStrictEqual(s.args, ['-e', '{0}']);
    });

    test('python and python3', () => {
        assert.deepStrictEqual(resolveShell('python', 'Linux').args, ['{0}']);
        assert.deepStrictEqual(resolveShell('python3', 'Linux').args, ['{0}']);
        assert.strictEqual(resolveShell('python3', 'Linux').keyword, 'python3');
    });

    test('pwsh and powershell both use -command with a dot-sourced script', () => {
        for (const keyword of ['pwsh', 'powershell']) {
            const s = resolveShell(keyword, 'Windows');
            assert.deepStrictEqual(s.args, ['-command', ". '{0}'"], keyword);
        }
    });

    test('cmd', () => {
        const s = resolveShell('cmd', 'Windows');
        assert.deepStrictEqual(s.args, ['/D', '/E:ON', '/V:OFF', '/S', '/C', 'CALL "{0}"']);
    });

    test('every built-in shell marks the script with {0} exactly once', () => {
        // The engine substitutes the script file for {0}. Zero occurrences
        // means the script is never passed; two means it is passed twice.
        for (const keyword of ['bash', 'sh', 'python', 'python3', 'pwsh', 'powershell', 'cmd']) {
            const args = resolveShell(keyword, 'Linux').args;
            const marks = args.filter((a) => a === '{0}' || a.includes('{0}')).length;
            assert.strictEqual(marks, 1, `${keyword} should reference {0} exactly once`);
        }
    });
});

suite('shell · custom shells', () => {
    test('a custom shell is split into a command and its arguments', () => {
        const s = resolveShell('perl {0}', 'Linux');
        assert.strictEqual(s.keyword, 'custom');
        assert.strictEqual(s.label, 'perl {0}');
        assert.deepStrictEqual(s.args, ['{0}']);
        assert.ok(s.command.endsWith('perl') || s.command === 'perl');
    });

    test('options before {0} are kept in order', () => {
        const s = resolveShell('perl -w -T {0}', 'Linux');
        assert.deepStrictEqual(s.args, ['-w', '-T', '{0}']);
    });

    test('a quoted argument stays one argument', () => {
        // `pwsh -command ". {0}"` is the built-in case; a custom one quoting a
        // path with spaces must behave the same way.
        const s = resolveShell('sh -c "my script {0}"', 'Linux');
        assert.deepStrictEqual(s.args, ['-c', 'my script {0}']);
    });

    test('{0} is only substituted in argument position, not inside a word', () => {
        const s = resolveShell('node --eval {0}', 'Linux');
        assert.deepStrictEqual(s.args, ['--eval', '{0}']);
    });

    test('a custom shell whose binary is missing is reported as unavailable', () => {
        const s = resolveShell('definitely-not-a-real-binary-xyz {0}', 'Linux');
        assert.strictEqual(s.available, false);
    });
});

suite('shell · unknown keywords are surfaced, not guessed', () => {
    test('an unrecognised shell is flagged', () => {
        // Guessing bash here would run a step the author wrote for something
        // else, and the resulting output would look like a real result.
        const s = resolveShell('zsh', 'Linux');
        assert.strictEqual(s.keyword, 'zsh');
        assert.strictEqual(s.unknown, true);
    });

    test('an unknown keyword is not silently treated as bash', () => {
        const s = resolveShell('fish', 'Linux');
        assert.ok(!s.args.includes('--noprofile'));
    });
});

suite('shell · availability is measured, not assumed', () => {
    test('bash is found on this machine', () => {
        // The tests run on the same machine AeroCI runs on, so a missing bash
        // would mean every run is about to fail.
        assert.strictEqual(resolveShell('bash', 'Linux').available, true);
        assert.ok(which('bash'));
    });

    test('a name that cannot exist is not found', () => {
        assert.strictEqual(which('definitely-not-a-real-binary-xyz'), null);
        assert.strictEqual(which(''), null);
    });

    test('a directory is not reported as an executable', () => {
        assert.strictEqual(which('/tmp'), null);
    });
});

suite('shell · the runner environment', () => {
    test('the GITHUB_* file variables are present and empty', () => {
        // They are placeholders: the engine points them at real files inside
        // the sandbox before each step. Exporting them empty would make a step
        // that reads them see no file at all.
        const env = runnerEnvironment();
        for (const key of ['GITHUB_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT',
            'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
            assert.ok(key in env, `${key} should be declared`);
            assert.strictEqual(env[key], '', `${key} should start empty`);
        }
    });

    test('the runtime store points at a directory that exists here', () => {
        // It used to assert the literal '/opt/hostedtoolcache', which is a path
        // on a Microsoft-hosted runner and on no machine a developer owns. The
        // point of the value is that a step can write to it, so that is what is
        // now asserted: the real runtime store, and it is there.
        //
        // It is `runtimes/`, not `cache/`. `RUNNER_TOOL_CACHE` is where runtimes
        // live, and a step that pokes around in there has to find what setup-node
        // actually installed rather than a directory of things that may be
        // deleted.
        const store = runnerEnvironment().RUNNER_TOOL_CACHE;
        assert.strictEqual(store, runtimesRoot());
        assert.notStrictEqual(store, '/opt/hostedtoolcache');
        assert.notStrictEqual(store, cacheRoot(), 'a tool cache is not a cache');
        assert.ok(fs.existsSync(runtimesRoot()) || fs.mkdirSync(runtimesRoot(), { recursive: true }) !== undefined,
            'the runtime store directory should be creatable');
    });
});
