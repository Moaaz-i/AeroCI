/**
 * The sandbox.
 *
 * The property everything else rests on is that a step cannot reach the real
 * project. A sandbox that leaks makes a green run meaningless, so the tests
 * below check the leak directly — write a file from inside, look for it outside
 * — rather than inferring isolation from the absence of a complaint.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const { Sandbox } = require('../src/core/sandbox');
const { DEFAULTS } = require('../src/core/config');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** A throwaway project, with the given files created inside it. */
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sb-'));
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body, 'utf8');
    }
    return dir;
}

/** Sandbox with cleanup, whatever the test does. */
function sandbox(root, options) {
    const sb = Sandbox.create(root, options);
    return sb;
}

suite('sandbox · a real copy', () => {
    test('the project is not modified by creating a sandbox', () => {
        const root = project({ 'a.txt': 'one', 'src/b.txt': 'two' });
        try {
            const sb = sandbox(root, { exclude: ['.git'] });
            sb.dispose({ quiet: true });
            assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one');
            assert.deepStrictEqual(fs.readdirSync(root).sort(), ['a.txt', 'src']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a file written in the sandbox is invisible outside it', () => {
        // The whole point. Verified by looking for the file, not by trusting a
        // return value.
        const root = project({ 'a.txt': 'one' });
        try {
            const sb = sandbox(root, { exclude: [] });
            fs.writeFileSync(path.join(sb.dir, 'written-here'), 'x');
            assert.ok(fs.existsSync(path.join(sb.dir, 'written-here')));
            assert.ok(!fs.existsSync(path.join(root, 'written-here')),
                'the write reached the real project');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('editing a copied file does not change the original', () => {
        const root = project({ 'a.txt': 'original' });
        try {
            const sb = sandbox(root, { exclude: [] });
            fs.writeFileSync(path.join(sb.dir, 'a.txt'), 'changed');
            assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a nested directory is copied whole', () => {
        const root = project({ 'src/deep/deeper/x.txt': 'x', 'src/y.txt': 'y' });
        try {
            const sb = sandbox(root, { exclude: [] });
            assert.strictEqual(fs.readFileSync(path.join(sb.dir, 'src/deep/deeper/x.txt'), 'utf8'), 'x');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('sandbox · the executable bit', () => {
    test('a script keeps its permissions, so ./script.sh runs', () => {
        // Without this, `chmod +x` in the workflow is not the only way a step
        // can run a file, and a local result differs from a runner one for a
        // reason that has nothing to do with the workflow.
        const root = project({ 'run.sh': '#!/bin/sh\necho hi\n' });
        try {
            fs.chmodSync(path.join(root, 'run.sh'), 0o755);
            const sb = sandbox(root, { exclude: [] });
            const mode = fs.statSync(path.join(sb.dir, 'run.sh')).mode;
            assert.ok(mode & 0o111, `executable bit lost (mode ${mode.toString(8)})`);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a plain file does not become executable', () => {
        const root = project({ 'data.txt': 'x' });
        try {
            fs.chmodSync(path.join(root, 'data.txt'), 0o644);
            const sb = sandbox(root, { exclude: [] });
            const mode = fs.statSync(path.join(sb.dir, 'data.txt')).mode;
            assert.ok(!(mode & 0o111), `a data file became executable (${mode.toString(8)})`);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('sandbox · symlinks in the project', () => {
    test('a symlink is recreated as a symlink, not followed', () => {
        // Following it would copy the target's contents, which turns a link
        // into a duplicate — and a link pointing at a parent would recurse.
        const root = project({ 'real/inner.txt': 'inner' });
        try {
            fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
            const sb = sandbox(root, { exclude: [] });
            const link = path.join(sb.dir, 'link');
            assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link was resolved into a copy');
            assert.strictEqual(fs.readFileSync(path.join(link, 'inner.txt'), 'utf8'), 'inner');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a broken symlink does not abort the copy', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
            const sb = sandbox(root, { exclude: [] });
            assert.strictEqual(fs.readFileSync(path.join(sb.dir, 'a.txt'), 'utf8'), 'a');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('sandbox · the exclude list', () => {
    test('an excluded path is absent, not copied', () => {
        // On a real runner there is no node_modules until a step installs one,
        // so shipping the local copy would make a missing install look fine.
        const root = project({ 'a.txt': 'a', 'node_modules/dep/index.js': 'module.exports=1' });
        try {
            const sb = sandbox(root, { exclude: ['node_modules'] });
            assert.ok(!fs.existsSync(path.join(sb.dir, 'node_modules')));
            assert.strictEqual(sb.stats.linked, 0);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('an excluded name is honoured at any depth', () => {
        const root = project({ 'a.txt': 'a', 'packages/x/dist/bundle.js': 'b' });
        try {
            const sb = sandbox(root, { exclude: ['dist'] });
            assert.ok(fs.existsSync(path.join(sb.dir, 'packages/x')));
            assert.ok(!fs.existsSync(path.join(sb.dir, 'packages/x/dist')));
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('.env is excluded by the default list, with the real defaults', () => {
        // A runner has no `.env`: it feeds the `secrets` context and nothing
        // else. Copying it in put every secret a project owns — including the
        // ones its workflows never reference — one `cat` away from any step.
        const root = project({ '.env': 'TOKEN=hunter2', 'a.txt': 'a' });
        try {
            const sb = sandbox(root, { exclude: [...DEFAULTS.sandbox.exclude] });
            assert.ok(!fs.existsSync(path.join(sb.dir, '.env')), '.env was copied into the sandbox');
            assert.strictEqual(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'TOKEN=hunter2');
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('the exclude list adds to the defaults rather than replacing them', () => {
        // Otherwise adding one path silently un-excludes node_modules.
        const root = project({ 'a.txt': 'a', 'node_modules/dep/index.js': 'x', 'secrets/keys.txt': 'k' });
        try {
            const merged = [...new Set([...DEFAULTS.sandbox.exclude, 'secrets'])];
            const sb = sandbox(root, { exclude: merged });
            assert.ok(!fs.existsSync(path.join(sb.dir, 'node_modules')));
            assert.ok(!fs.existsSync(path.join(sb.dir, 'secrets')));
            assert.ok(fs.existsSync(path.join(sb.dir, 'a.txt')));
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite("sandbox · mode: 'link'", () => {
    test('an excluded path is a symlink to the real one', () => {
        const root = project({ 'a.txt': 'a', 'node_modules/dep/index.js': 'module.exports=1' });
        try {
            const sb = sandbox(root, { exclude: ['node_modules'], mode: 'link' });
            const linked = path.join(sb.dir, 'node_modules');
            assert.ok(fs.lstatSync(linked).isSymbolicLink(), 'the excluded path was not linked');
            assert.strictEqual(fs.readlinkSync(linked), path.join(root, 'node_modules'));
            // Usable, which is the reason to choose this mode.
            assert.strictEqual(fs.readFileSync(path.join(linked, 'dep/index.js'), 'utf8'), 'module.exports=1');
            assert.strictEqual(sb.stats.linked, 1);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a non-excluded file is still a private copy', () => {
        // The mode is about the excluded set. Linking everything would make the
        // sandbox useless; linking only the exclusions keeps the workflow's own
        // edits private.
        const root = project({ 'a.txt': 'a', 'node_modules/dep/index.js': 'x' });
        try {
            const sb = sandbox(root, { exclude: ['node_modules'], mode: 'link' });
            fs.writeFileSync(path.join(sb.dir, 'a.txt'), 'changed');
            assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a');
            assert.ok(!fs.lstatSync(path.join(sb.dir, 'a.txt')).isSymbolicLink());
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('anything else in the tree is still private', () => {
        // Stated plainly because the mode is a real trade-off: this is exactly
        // the hole a user opts into, and it should be impossible to widen it by
        // accident.
        const root = project({ 'a.txt': 'a', 'node_modules/dep/index.js': 'x' });
        try {
            const sb = sandbox(root, { exclude: ['node_modules'], mode: 'link' });
            const entries = fs.readdirSync(sb.dir).sort();
            const links = entries.filter((e) => fs.lstatSync(path.join(sb.dir, e)).isSymbolicLink());
            assert.deepStrictEqual(links, ['node_modules']);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('sandbox · failure modes', () => {
    test('a project root that does not exist is refused', () => {
        // An empty sandbox used to be created instead, and then every step
        // "passed" because there was nothing there.
        assert.throws(
            () => Sandbox.create(path.join(os.tmpdir(), 'aeroci-not-here-' + process.pid)),
            /does not exist/);
    });

    test('a project root that is a file is refused', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            assert.throws(() => Sandbox.create(path.join(root, 'a.txt')), /not a directory/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('an empty project produces an empty sandbox, and says so in its stats', () => {
        const root = project();
        try {
            const sb = sandbox(root, { exclude: [] });
            assert.strictEqual(sb.stats.files, 0);
            assert.deepStrictEqual(fs.readdirSync(sb.dir).filter((f) => !['tmp', '_temp', 'bin', 'externals', 'work'].includes(f)), []);
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('the runner directories exist, as they do on a real runner', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            const sb = sandbox(root, { exclude: [] });
            for (const dir of ['tmp', '_temp', 'bin', 'externals', 'work']) {
                assert.ok(fs.statSync(path.join(sb.dir, dir)).isDirectory(), `${dir} is missing`);
            }
            sb.dispose({ quiet: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('sandbox · cleanup', () => {
    test('dispose removes the directory', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            const sb = sandbox(root, { exclude: [] });
            const dir = sb.dir;
            assert.strictEqual(sb.dispose({ quiet: true }), true);
            assert.ok(!fs.existsSync(dir), 'the sandbox survived dispose');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('keep holds the directory and says where it is', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            const sb = sandbox(root, { exclude: [], keep: true });
            const dir = sb.dir;
            const said = [];
            sb.dispose({ log: (m) => said.push(m) });
            assert.ok(fs.existsSync(dir), 'a kept sandbox was removed anyway');
            assert.ok(said.some((m) => m.includes(dir)), `nothing said where it went: ${said}`);
            fs.rmSync(dir, { recursive: true, force: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('dispose twice is not an error', () => {
        const root = project({ 'a.txt': 'a' });
        try {
            const sb = sandbox(root, { exclude: [] });
            sb.dispose({ quiet: true });
            assert.strictEqual(sb.dispose({ quiet: true }), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('quiet suppresses the removal notice', () => {
        // A workflow builds a sandbox per job, so the notice would otherwise
        // repeat once per job and each line would overstate the truth.
        const root = project({ 'a.txt': 'a' });
        const said = [];
        try {
            const sb = sandbox(root, { exclude: [] });
            sb.dispose({ log: (m) => said.push(m) });
            sb.dispose({ log: (m) => said.push(m), quiet: true });
            assert.deepStrictEqual(said, []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
