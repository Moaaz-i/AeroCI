/**
 * `aeroci debug` is the command you reach for when a run failed, so the one
 * thing it must get right is the *environment*: a shell that differs from the
 * one the step had sends you looking for the wrong reason. Two bugs of exactly
 * that shape shipped here — the sandbox was created with no exclusion list at
 * all (so your `.env` and `node_modules` were in it), and `.env` values were
 * exported as plain variables, which a runner never does.
 *
 * The debugger spawns an interactive shell, so these tests drive it with a
 * piped script and read back what the shell saw.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { suite, test, assert } = require('./harness');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** A throwaway project. */
function project(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-dbg-'));
    for (const [name, body] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf8');
    }
    return dir;
}

/**
 * Run the debug shell with `script` piped in, and hand back everything it
 * printed. The shell is bash with a here-doc of the commands, so the output is
 * deterministic.
 */
function debugShell(dir, script, options = {}) {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'aeroci.js'), 'debug'], {
        cwd: dir,
        input: `${script}\nexit 0\n`,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NO_COLOR: '1', ...(options.env || {}) }
    }).stdout || '';
}

/** Strip the shell prompt so an assertion cannot match the command echo. */
function outputOf(text) {
    return text.split('\n')
        .filter((l) => !/^% /.test(l))
        .join('\n');
}

suite('debugger · the sandbox it builds', () => {
    test('node_modules is excluded too, so the two sandboxes really match', () => {
        // The exclusion list used to be omitted here, so `Sandbox` fell back to
        // an empty set and the debug shell had the project's `node_modules` and
        // `.env` in it while the failing step had neither. The `node_modules`
        // case is the one a user notices first: a step that fails because
        // `npm ci` is missing would "work" in the shell that had the packages
        // already there.
        const dir = project({ 'node_modules/dep/index.js': 'module.exports = 1;\n' });
        try {
            const out = outputOf(debugShell(dir,
                'echo "nm=$(test -d node_modules && echo PRESENT || echo ABSENT)"'));
            assert.ok(/nm=ABSENT/.test(out), `the debug sandbox had node_modules: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('debugger · what the shell can see', () => {
    test('.env is not in the debug sandbox, same as a run', () => {
        const dir = project({
            '.env': 'TOKEN=hunter2supersecret\n',
            'a.txt': 'source file\n'
        });
        try {
            const out = debugShell(dir, 'echo "env=$(test -f .env && echo PRESENT || echo ABSENT)"');
            assert.ok(/env=ABSENT/.test(outputOf(out)),
                `the debug sandbox handed the shell your .env: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a real project file is in the debug sandbox', () => {
        // The counterpart to the assertion above: excluding the secret must not
        // have turned the sandbox into an empty directory, which would make
        // every command "pass" for the wrong reason.
        const dir = project({ 'a.txt': 'source file\n' });
        try {
            const out = debugShell(dir, 'echo "src=$(test -f a.txt && echo PRESENT || echo ABSENT)"');
            assert.ok(/src=PRESENT/.test(outputOf(out)), `the sandbox is empty: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('.env values are not exported as plain variables by default', () => {
        // A runner exposes a secret only through the `secrets` context. The
        // debugger used to spread them into the environment, so `$TOKEN` was set
        // in the shell and empty in the run it was supposed to reproduce.
        const dir = project({ '.env': 'TOKEN=hunter2supersecret\n' });
        try {
            const out = debugShell(dir, 'echo "len=${#TOKEN}"');
            assert.ok(/len=0/.test(outputOf(out)),
                `a .env value leaked into the debug shell: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--expose-env opts in, and the length shows it worked', () => {
        const dir = project({ '.env': 'TOKEN=hunter2supersecret\n' });
        try {
            const res = spawnSync(process.execPath,
                [path.join(__dirname, '..', 'bin', 'aeroci.js'), 'debug', '--expose-env'],
                { cwd: dir, input: 'echo "len=${#TOKEN}"\nexit 0\n', encoding: 'utf8', timeout: 30000 });
            const out = outputOf(res.stdout || '');
            assert.ok(/len=18/.test(out), `--expose-env did not export the value: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the CI environment is present in the shell', () => {
        const dir = project({ 'a.txt': 'x\n' });
        try {
            const out = outputOf(debugShell(dir,
                'echo "ci=$CI actions=$GITHUB_ACTIONS ws=${GITHUB_WORKSPACE##*/}"'));
            assert.ok(/ci=true/.test(out), `CI is not set: ${out}`);
            assert.ok(/actions=true/.test(out), `GITHUB_ACTIONS is not set: ${out}`);
            assert.ok(/ws=aeroci-sandbox-/.test(out), `GITHUB_WORKSPACE is not the sandbox: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the file commands point at real files', () => {
        // A workflow step's file commands have to work by hand, or the debug
        // shell cannot test the one thing people open it to test.
        const dir = project({ 'a.txt': 'x\n' });
        try {
            const out = outputOf(debugShell(dir, [
                'echo "value=hello" >> "$GITHUB_OUTPUT"',
                'echo "T=1" >> "$GITHUB_ENV"',
                'echo "summary line" >> "$GITHUB_STEP_SUMMARY"',
                'echo "out=$(cat "$GITHUB_OUTPUT")"',
                'echo "env=$(cat "$GITHUB_ENV")"',
                'echo "sum=$(cat "$GITHUB_STEP_SUMMARY")"'
            ].join('\n')));
            assert.ok(/out=value=hello/.test(out), `$GITHUB_OUTPUT is not writable: ${out}`);
            assert.ok(/env=T=1/.test(out), `$GITHUB_ENV is not writable: ${out}`);
            assert.ok(/sum=summary line/.test(out), `$GITHUB_STEP_SUMMARY is not writable: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('debugger · cleanup', () => {
    test('the sandbox is removed when the session ends', () => {
        // `keep` used to be hard-coded true, so every `aeroci debug` leaked a
        // full copy of the project into the temp directory.
        const dir = project({ 'a.txt': 'x\n' });
        try {
            const out = debugShell(dir, 'true');
            const m = out.match(/aeroci-sandbox-[A-Za-z0-9]+/);
            assert.ok(m, `no sandbox path in the output: ${out}`);
            assert.ok(!fs.existsSync(m[0]), `the sandbox was left behind: ${m[0]}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--keep leaves exactly one sandbox behind, and says where', () => {
        const dir = project({ 'a.txt': 'x\n' });
        try {
            const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('aeroci-sandbox-'));
            const res = spawnSync(process.execPath,
                [path.join(__dirname, '..', 'bin', 'aeroci.js'), 'debug', '--keep'],
                { cwd: dir, input: 'exit 0\n', encoding: 'utf8', timeout: 30000 });
            const out = res.stdout || '';
            const m = out.match(/Sandbox kept for inspection:\s*(\S+)/);
            assert.ok(m, `--keep did not report the path: ${out}`);
            assert.ok(fs.existsSync(m[1]), `the kept sandbox does not exist: ${m[1]}`);
            const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('aeroci-sandbox-'));
            assert.strictEqual(after.length - before.length, 1,
                `--keep left ${after.length - before.length} sandboxes, expected 1`);
            fs.rmSync(m[1], { recursive: true, force: true });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('debugger · outside a git repository it says so', () => {
    test('GITHUB_SHA is the all-zero placeholder and the report names it', () => {
        // Printing `Commit 0000000 on main` reads like a real commit. A user
        // comparing it against the remote is comparing against nothing.
        const dir = project({ 'a.txt': 'x\n' });
        try {
            const out = outputOf(debugShell(dir, 'echo "sha=$GITHUB_SHA"'));
            assert.ok(/not a git repository/.test(out), `the report does not say why: ${out}`);
            assert.ok(/sha=0{40}/.test(out), `GITHUB_SHA is not the placeholder: ${out}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
