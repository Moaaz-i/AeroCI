/**
 * Toolchain: version resolution, the runtime store, and refusing honestly.
 *
 * The parsing and resolution tests run against a checked-in slice of Node's real
 * release index rather than a hand-written one. A made-up index would happily
 * confirm whatever the parser does, including installing 26.10.0 for a workflow
 * that asked for 18.20.4 — which is exactly the bug this module was written to
 * remove, and exactly what it did before the pin case was fixed.
 *
 * Nothing here reaches the network. The index is written into the cache by hand,
 * which is also the arrangement the runtime uses in production once it has been
 * fetched once: a cached index resolves a version request with no connectivity
 * at all. The download path itself is exercised by the CLI end-to-end, so this
 * suite stays fast and offline.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { suite, test, asyncTest, assert } = require('./harness');
const {
    ensureNode, resolveFromIndex, parseRange, satisfies,
    parseVersion, compareVersions, normaliseSpec, currentPlatform,
    runtimesRoot, globalRoot, cacheRoot, readCachedIndex
} = require('../src/core/toolchain');
const { Sandbox } = require('../src/core/sandbox');

/** A slice of nodejs.org/dist/index.json, with the real shape and real versions. */
const INDEX = [
    { version: 'v26.10.0', date: '2026-09-21', lts: false, files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v26.9.0', date: '2026-09-02', lts: false, files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v24.21.0', date: '2026-08-11', lts: 'Krypton', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v22.23.3', date: '2026-07-02', lts: 'Jod', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v21.0.0-rc.1', date: '2023-10-01', lts: false, files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v21.0.0', date: '2023-10-17', lts: false, files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v20.20.2', date: '2026-06-05', lts: 'Iron', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v18.20.8', date: '2025-03-27', lts: 'Hydrogen', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v18.20.4', date: '2024-07-08', lts: 'Hydrogen', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v18.0.0', date: '2022-04-19', lts: false, files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v16.20.2', date: '2023-08-08', lts: 'Gallium', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v14.0.0', date: '2020-04-21', lts: false, files: ['linux-x64'] }
];

const HERE = currentPlatform() || 'linux-x64';

/** Does `spec` accept `version`? */
const accepts = (spec, version) => satisfies(parseVersion(version), parseRange(spec));

const resolveTo = (spec, platform = HERE) => {
    const hit = resolveFromIndex(INDEX, spec, platform);
    return hit ? hit.entry.version : null;
};

suite('toolchain · version ranges', () => {
    test('a bare major matches every release in that line', () => {
        assert.ok(accepts('18', '18.0.0'));
        assert.ok(accepts('18', '18.20.8'));
        assert.ok(!accepts('18', '19.0.0'));
        assert.ok(!accepts('18', '17.9.9'));
    });

    test('x and * are the same wildcard', () => {
        for (const spec of ['18.x', '18.*', '18']) {
            assert.ok(accepts(spec, '18.20.8'), spec);
            assert.ok(!accepts(spec, '20.1.0'), spec);
        }
    });

    test('a two-part spec is a range over the patch level', () => {
        assert.ok(accepts('18.20', '18.20.4'));
        assert.ok(accepts('18.20', '18.20.99'));
        assert.ok(!accepts('18.20', '18.21.0'));
    });

    // The regression this suite exists for: a full three-part spec read as ">="
    // resolves 18.20.4 to the newest release of all, 26.10.0.
    test('a full three-part spec is a pin, not a floor', () => {
        assert.ok(accepts('18.20.4', '18.20.4'));
        assert.ok(!accepts('18.20.4', '18.20.8'));
        assert.ok(!accepts('18.20.4', '26.10.0'));
        assert.ok(!accepts('=18.20.4', '18.20.8'));
        assert.strictEqual(resolveTo('18.20.4'), 'v18.20.4');
    });

    test('a leading v is accepted, and quoting is stripped', () => {
        assert.ok(accepts('v18.20.4', '18.20.4'));
        assert.strictEqual(normaliseSpec("'18'"), '18');
        assert.strictEqual(normaliseSpec('"18"'), '18');
        assert.strictEqual(normaliseSpec('  18  '), '18');
        assert.strictEqual(normaliseSpec(null), '');
    });

    test('caret stops at the next incompatible version', () => {
        assert.ok(accepts('^18.20.0', '18.20.8'));
        assert.ok(!accepts('^18.20.0', '19.0.0'));
        assert.ok(accepts('^0.2.3', '0.2.9'));
        assert.ok(!accepts('^0.2.3', '0.3.0'));
        assert.ok(accepts('^0.0.3', '0.0.3'));
        assert.ok(!accepts('^0.0.3', '0.0.4'));
    });

    test('tilde stops at the next minor', () => {
        assert.ok(accepts('~18.20.0', '18.20.9'));
        assert.ok(!accepts('~18.20.0', '18.21.0'));
        assert.ok(accepts('~18.20', '18.20.9'));
        assert.ok(!accepts('~18.20', '18.21.0'));
    });

    test('comparators and alternatives', () => {
        assert.ok(accepts('>=18 <21', '20.20.2'));
        assert.ok(!accepts('>=18 <21', '21.0.0'));
        assert.ok(accepts('>18.20.4', '18.20.8'));
        assert.ok(!accepts('>18.20.4', '18.20.4'));
        assert.ok(accepts('<=18.20.4', '18.20.4'));
        assert.ok(accepts('18 || 20', '20.20.2'));
        assert.ok(!accepts('18 || 20', '22.23.3'));
    });

    test('a range does not settle for a release candidate', () => {
        // 21.0.0-rc.1 is newer than 20.x and would win a naive "newest match".
        assert.ok(!accepts('21', '21.0.0-rc.1'));
        assert.strictEqual(resolveTo('21'), 'v21.0.0');
        assert.ok(accepts('>=21.0.0-rc.1 <21.0.0', '21.0.0-rc.1'));
        assert.ok(!accepts('>=21.0.0-rc.1 <21.0.0', '21.0.0'));
        assert.ok(!accepts('*', '21.0.0-rc.1'));
    });

    test('syntax it does not understand is refused, never guessed', () => {
        for (const spec of ['1.2.3 - 2.3.4', 'banana', 'node', '>x', '1.2.3.4', '', '  ']) {
            assert.strictEqual(parseRange(spec), null, `"${spec}" should not parse`);
        }
    });

    test('a release outranks its own release candidate', () => {
        const older = (a, b) => compareVersions(parseVersion(a), parseVersion(b));
        assert.ok(older('v21.0.0', 'v21.0.0-rc.1') > 0, 'the release is newer than its candidate');
        assert.ok(older('v18.20.8', 'v18.20.4') > 0);
        assert.ok(older('v18.0.0', 'v16.20.2') > 0);
        assert.ok(older('v21.0.0', 'v18.20.8') > 0, 'major dominates');
        assert.strictEqual(older('v18.20.8', 'v18.20.8'), 0);
    });
});

suite('toolchain · resolving against the release index', () => {
    test('a major resolves to the newest build in that line', () => {
        assert.strictEqual(resolveTo('18'), 'v18.20.8');
        assert.strictEqual(resolveTo('16'), 'v16.20.2');
        assert.strictEqual(resolveTo('26'), 'v26.10.0');
    });

    test('an LTS selector filters by codename, not by number', () => {
        assert.strictEqual(resolveTo('lts/*'), 'v24.21.0');
        assert.strictEqual(resolveTo('lts'), 'v24.21.0');
        assert.strictEqual(resolveTo('lts/hydrogen'), 'v18.20.8');
        assert.strictEqual(resolveTo('lts/HYDROGEN'), 'v18.20.8');
        assert.strictEqual(resolveTo('lts/iron'), 'v20.20.2');
        // A codename that exists but is spelled wrong must not fall back to "any".
        assert.strictEqual(resolveTo('lts/hydrogenx'), null);
    });

    test('a release with no build for this platform is passed over', () => {
        // v14.0.0 has no osx-arm64-tar in the fixture.
        assert.strictEqual(resolveTo('14', 'darwin-arm64'), null);
        assert.strictEqual(resolveTo('14', 'linux-x64'), 'v14.0.0');
    });

    test('a version nobody published resolves to nothing', () => {
        assert.strictEqual(resolveTo('99'), null);
        assert.strictEqual(resolveTo('18.20.99'), null);
        assert.strictEqual(resolveTo(''), null);
    });
});

suite('toolchain · the global tree', () => {
    test('runtimes and cache are siblings, not the same directory', () => {
        const saved = process.env.AERO_HOME;
        try {
            delete process.env.AERO_HOME;
            const home = path.join(os.homedir(), '.aeroci');
            assert.strictEqual(globalRoot(), home);
            assert.strictEqual(runtimesRoot(), path.join(home, 'runtimes'));
            assert.strictEqual(cacheRoot(), path.join(home, 'cache'));
            // A runtime is installed and checksum-verified; a cache may be
            // deleted at any moment. Sharing one directory would mean
            // `rm -rf cache` could take an install with it.
            assert.notStrictEqual(runtimesRoot(), cacheRoot());
        } finally {
            if (saved !== undefined) process.env.AERO_HOME = saved;
        }
    });

    test('AERO_HOME moves the whole tree, which is how these tests stay out of ~/', () => {
        const saved = process.env.AERO_HOME;
        process.env.AERO_HOME = path.join(os.tmpdir(), 'aeroci-fake-home');
        try {
            assert.strictEqual(globalRoot(), path.join(os.tmpdir(), 'aeroci-fake-home'));
            assert.strictEqual(runtimesRoot(), path.join(os.tmpdir(), 'aeroci-fake-home', 'runtimes'));
            assert.strictEqual(cacheRoot(), path.join(os.tmpdir(), 'aeroci-fake-home', 'cache'));
        } finally {
            if (saved === undefined) delete process.env.AERO_HOME;
            else process.env.AERO_HOME = saved;
        }
    });

    test('the sandbox never copies the runtime store, even from inside the project', () => {
        // A store that sits inside the repository used to be cloned into every
        // sandbox: 205 MB and 2340 files, on every run, for a runtime the run
        // then installs again.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sbxc-'));
        const project = path.join(root, 'proj');
        const home = path.join(project, '.aeroci');
        const runtimes = path.join(home, 'runtimes', 'node', '18.20.8', 'arm64', 'bin');
        fs.mkdirSync(runtimes, { recursive: true });
        fs.mkdirSync(path.join(project, 'src'), { recursive: true });
        fs.writeFileSync(path.join(project, 'src', 'a.txt'), 'a');
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(runtimes, `f${i}`), 'x');
        }

        const saved = process.env.AERO_HOME;
        process.env.AERO_HOME = home;
        try {
            const withIt = Sandbox.create(project, { exclude: [], excludePaths: [globalRoot()] });
            const copied = withIt.stats.files;
            const leaked = fs.existsSync(path.join(withIt.dir, '.aeroci'));
            const keptSrc = fs.existsSync(path.join(withIt.dir, 'src', 'a.txt'));
            withIt.dispose({ Logger: { info() {} }, quiet: true });

            assert.ok(!leaked, 'the runtime store must not be copied into the sandbox');
            assert.ok(keptSrc, 'the rest of the project must still be copied');
            assert.ok(copied < 10, `only the project should be copied, got ${copied} files`);
        } finally {
            if (saved === undefined) delete process.env.AERO_HOME;
            else process.env.AERO_HOME = saved;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('toolchain · refusing honestly', () => {
    // Every reason the requested version cannot be honoured has to reach the
    // caller as a distinct reason, because each one needs a different sentence
    // and a different remedy. A generic "could not set up Node" would hide the
    // difference between "you said no" and "there is no such version".
    //
    // The index is seeded by hand, so these never touch the network — which is
    // also how the refusal path is reached in production once the index has been
    // fetched at least once.
    const withHome = (contents, fn) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-tc-'));
        const home = path.join(dir, 'home');
        if (contents !== null) {
            fs.mkdirSync(path.join(home, 'cache', 'node'), { recursive: true });
            fs.writeFileSync(path.join(home, 'cache', 'node', 'index.json'), JSON.stringify(INDEX), 'utf8');
        }
        const saved = process.env.AERO_HOME;
        process.env.AERO_HOME = home;
        try {
            return fn();
        } finally {
            if (saved === undefined) delete process.env.AERO_HOME;
            else process.env.AERO_HOME = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    const reasonsFor = (spec) => withHome(INDEX, () => ensureNode(spec, { allowDownload: false }));

    /** Seed the cache with a custom index instead of the checked-in slice. */
    const withIndex = (raw, fn) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-tc-'));
        const home = path.join(dir, 'home');
        fs.mkdirSync(path.join(home, 'cache', 'node'), { recursive: true });
        fs.writeFileSync(path.join(home, 'cache', 'node', 'index.json'), JSON.stringify(raw), 'utf8');
        const saved = process.env.AERO_HOME;
        process.env.AERO_HOME = home;
        try {
            return fn();
        } finally {
            if (saved === undefined) delete process.env.AERO_HOME;
            else process.env.AERO_HOME = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    /** An index whose only entry is the Node this suite is running under. */
    const hostIndex = () => [{
        version: `v${process.versions.node}`, date: '2026-01-01', lts: false,
        files: ['osx-arm64-tar', 'linux-x64']
    }];

    asyncTest('a spec with no version behind it is "not found", not a crash', async () => {
        const result = await reasonsFor('99');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'not-found');
        assert.ok(result.message.includes('99'), result.message);
    });

    asyncTest('unparseable syntax is named as such', async () => {
        const result = await reasonsFor('node');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'unsupported-spec');
    });

    asyncTest('a refusal names the permission, not a network fault', async () => {
        // With downloads off, a version that is real and not installed must be
        // reported as refused. Calling that an offline error would send the user
        // to debug their network instead of their own choice.
        const result = await reasonsFor('18');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'denied');
        assert.ok(result.message.includes('18.20.8'), result.message);
        // The message states the reason only; wording the remedy is the caller's
        // job, so the two are not said twice.
        assert.ok(!/used instead/.test(result.message), result.message);
    });

    asyncTest('an empty spec never reaches the network', async () => {
        const result = await reasonsFor('');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'no-spec');
    });

    asyncTest('a cached index resolves a version with no network at all', async () => {
        // The promise AeroCI makes is that it never reaches the network without
        // permission. Reading the index is a network request like any other, so
        // with a cached copy and no permission the answer has to come from disk —
        // and it has to be the real resolution, not a shrug.
        const result = await reasonsFor('18');
        assert.strictEqual(result.reason, 'denied');
        assert.ok(result.message.includes('18.20.8'), 'resolved offline against the cache');
    });

    asyncTest('a fresh cached index is not flagged as stale', async () => {
        // The caller prints "cached copy, the network was not reached" only for a
        // copy past its six hours. A file written seconds ago is not a compromise;
        // flagging it would make the warning a lie.
        const result = await withIndex(hostIndex(), () => ensureNode(process.versions.node, { allowDownload: false }));
        assert.strictEqual(result.ok, true, JSON.stringify(result));
        assert.strictEqual(result.source, 'host');
        assert.strictEqual(result.staleIndex, false);
    });

    asyncTest('a stale cached index is flagged as stale when refreshing is not permitted', async () => {
        // Once the copy is older than six hours and the network is off, the stale
        // flag says loudly that the answer came from yesterday's list.
        const result = await withIndex(hostIndex(), () => {
            const file = path.join(process.env.AERO_HOME, 'cache', 'node', 'index.json');
            const old = new Date('2020-01-01');
            fs.utimesSync(file, old, old);
            return ensureNode(process.versions.node, { allowDownload: false });
        });
        assert.strictEqual(result.ok, true, JSON.stringify(result));
        assert.strictEqual(result.source, 'host');
        assert.strictEqual(result.staleIndex, true);
    });

    asyncTest('readCachedIndex tells a six-hour boundary apart from a fresh write', async () => {
        const fresh = await withIndex(hostIndex(), () => readCachedIndex());
        assert.strictEqual(fresh.stale, false);
        const aged = await withIndex(hostIndex(), () => {
            const file = path.join(process.env.AERO_HOME, 'cache', 'node', 'index.json');
            fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
            return readCachedIndex();
        });
        assert.strictEqual(aged.stale, true);
    });

    asyncTest('with no cached index and no permission, it says so instead of reaching out', async () => {
        // `null` here, not `false`: nobody has been asked, so the question is
        // asked. A non-interactive run cannot answer, and answering for it would
        // be the network access it never agreed to.
        const result = await withHome(null, () => ensureNode('18', {}));
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'no-index');
        assert.ok(/not authorized/.test(result.message), result.message);
        assert.ok(result.message.includes('18'), result.message);
    });
});
