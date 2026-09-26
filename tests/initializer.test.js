/**
 * `aeroci init` — the first thing a new user runs.
 *
 * A setup command that overwrites somebody's real `.gitignore` or replaces a
 * workflow they already had is worse than one that does nothing, so most of
 * what is checked here is about restraint: what it writes, what it leaves alone,
 * and what it does the second time you run it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const { Initializer, SAMPLE_WORKFLOW } = require('../src/core/initializer');
const { Checker } = require('../src/core/checker');
const { CONFIG_NAME, DEFAULTS } = require('../src/core/config');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** A throwaway project directory. */
function project() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-init-'));
}

const read = (dir, ...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8');
const exists = (dir, ...parts) => fs.existsSync(path.join(dir, ...parts));

suite('initializer · a fresh project', () => {
    test('writes a config, a sample workflow, an env example and a gitignore', () => {
        const dir = project();
        try {
            const out = Initializer.init({ cwd: dir });
            assert.ok(exists(dir, CONFIG_NAME));
            assert.ok(exists(dir, '.github', 'workflows', 'aeroci-demo.yml'));
            assert.ok(exists(dir, '.env.example'));
            assert.ok(exists(dir, '.gitignore'));
            assert.ok(out.written.length >= 4, JSON.stringify(out));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the config it writes parses and matches the real defaults', () => {
        // A hand-written copy of the schema drifts. The point of reading the
        // defaults is that it cannot.
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const config = JSON.parse(read(dir, CONFIG_NAME));
            // Compared by value: the file has been through JSON, so nothing in
            // it is the same object as the in-memory default any more.
            assert.strictEqual(config.version, DEFAULTS.version);
            assert.deepStrictEqual(config.workflows, DEFAULTS.workflows);
            assert.strictEqual(config.envFile, DEFAULTS.envFile);
            assert.strictEqual(config.sandbox.mode, DEFAULTS.sandbox.mode);
            assert.deepStrictEqual(config.sandbox.exclude, DEFAULTS.sandbox.exclude);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the sample workflow is one the checker accepts', () => {
        // Shipping a sample that fails your own pre-flight would be an
        // unremarkable way to lose every new user at the first command.
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const out = Checker.check(path.join(dir, '.github', 'workflows'));
            assert.deepStrictEqual(out.errors, 0, JSON.stringify(out.findings, null, 1));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the sample workflow is valid YAML with the keys it needs', () => {
        const yaml = require('js-yaml').load(SAMPLE_WORKFLOW);
        assert.ok(yaml.name);
        assert.ok(yaml.on);
        assert.ok(yaml.jobs && Object.keys(yaml.jobs).length > 0);
        assert.ok(yaml.permissions, 'the sample should demonstrate permissions');
    });

    test('the env example never contains a value that looks like a real secret', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const body = read(dir, '.env.example');
            const active = body.split('\n')
                .filter((l) => /^\s*[A-Z_]+=/.test(l) && !/^\s*#/.test(l));
            assert.deepStrictEqual(active, [], `unexpected active assignment: ${active}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('initializer · it does not touch what is already there', () => {
    test('a second run overwrites nothing', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const config = read(dir, CONFIG_NAME);
            const gitignore = read(dir, '.gitignore');
            const out = Initializer.init({ cwd: dir });
            assert.strictEqual(read(dir, CONFIG_NAME), config);
            assert.strictEqual(read(dir, '.gitignore'), gitignore);
            assert.ok(out.written.length === 0, JSON.stringify(out.written));
            assert.ok(out.skipped.includes(CONFIG_NAME), JSON.stringify(out.skipped));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an existing workflow is not replaced by the sample', () => {
        const dir = project();
        try {
            const mine = path.join(dir, '.github', 'workflows', 'ci.yml');
            fs.mkdirSync(path.dirname(mine), { recursive: true });
            fs.writeFileSync(mine, 'name: Mine\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n'
                + '    steps:\n      - run: echo hi\n');
            const out = Initializer.init({ cwd: dir });
            assert.ok(read(mine).includes('name: Mine'), 'the existing workflow was overwritten');
            assert.ok(!exists(dir, '.github', 'workflows', 'aeroci-demo.yml'),
                'the sample was written next to a real workflow');
            assert.ok(!out.written.includes('.github/workflows/aeroci-demo.yml'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an existing gitignore is appended to, not rewritten', () => {
        const dir = project();
        try {
            fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\n');
            Initializer.init({ cwd: dir });
            const body = read(dir, '.gitignore');
            assert.ok(body.startsWith('node_modules\ndist'), body);
            assert.ok(body.includes('node_modules'), 'the original entries were lost');
            assert.ok(body.includes('.env'), 'the secret entry was not added');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a gitignore that is already complete gains nothing', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const first = read(dir, '.gitignore');
            const out = Initializer.init({ cwd: dir });
            assert.strictEqual(read(dir, '.gitignore'), first);
            assert.ok(!out.written.includes('.gitignore'), JSON.stringify(out.written));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('adding to a gitignore is idempotent, entry by entry', () => {
        const dir = project();
        try {
            fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
            Initializer.init({ cwd: dir });
            const body = read(dir, '.gitignore');
            const envLines = body.split('\n').filter((l) => l.trim() === '.env');
            assert.strictEqual(envLines.length, 1, `".env" appears ${envLines.length} times`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a gitignore without a trailing newline is still appended to correctly', () => {
        const dir = project();
        try {
            fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
            Initializer.init({ cwd: dir });
            const body = read(dir, '.gitignore');
            assert.ok(body.startsWith('node_modules\n'), JSON.stringify(body.slice(0, 60)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('force replaces the config but still leaves a hand-written workflow alone', () => {
        // `--force` is about the files `init` owns. Somebody else's workflow is
        // not one of them, and a flag that deletes it is a footgun.
        const dir = project();
        try {
            const mine = path.join(dir, '.github', 'workflows', 'ci.yml');
            fs.mkdirSync(path.dirname(mine), { recursive: true });
            fs.writeFileSync(mine, 'name: Mine\non: [push]\njobs: {}\n');
            Initializer.init({ cwd: dir, force: true });
            assert.ok(read(mine).includes('name: Mine'), 'the existing workflow was overwritten');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('initializer · options', () => {
    test('the sample can be declined', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir, sample: false });
            assert.ok(!exists(dir, '.github', 'workflows', 'aeroci-demo.yml'));
            assert.ok(exists(dir, CONFIG_NAME));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the env example can be declined', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir, env: false });
            assert.ok(!exists(dir, '.env.example'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the gitignore entries cover the files the tool actually writes', () => {
        // The list is a claim about what is safe to commit. If a generated file
        // is missing from it, the claim is wrong.
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const body = read(dir, '.gitignore');
            const entries = body.split('\n').map((l) => l.trim()).filter(Boolean);
            for (const required of ['.env', '.aeroci-artifacts/', 'security-report.md']) {
                assert.ok(entries.includes(required), `.gitignore is missing ${required}: ${entries.join(' ')}`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('verify reports on what init just wrote', () => {
        const dir = project();
        try {
            Initializer.init({ cwd: dir });
            const out = Initializer.verify(dir);
            assert.strictEqual(out.errors, 0, JSON.stringify(out.findings, null, 1));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
