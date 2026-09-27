/**
 * Toolchain: version resolution, the cache, and consent to download.
 *
 * The parsing and resolution tests run against a checked-in slice of Node's real
 * release index rather than a hand-written one. A made-up index would happily
 * confirm whatever the parser does, including installing 26.10.0 for a workflow
 * that asked for 18.20.4 — which is exactly the bug this module was written to
 * remove, and exactly what it did before the pin case was fixed.
 *
 * Nothing here reaches the network. The download path is exercised by the CLI
 * end-to-end, not by the unit tests, so the suite stays fast and offline.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { suite, test, asyncTest, assert } = require('./harness');
const {
    ensureNode, resolveConsent, resolveFromIndex, parseRange, satisfies,
    parseVersion, compareVersions, normaliseSpec, currentPlatform, cacheRoot
} = require('../src/core/toolchain');
const { Sandbox } = require('../src/core/sandbox');
const { Config } = require('../src/core/config');

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

suite('toolchain · the cache location', () => {
    test('it is global, so one download serves every project', () => {
        const saved = process.env.AERO_TOOLCACHE;
        try {
            delete process.env.AERO_TOOLCACHE;
            assert.strictEqual(cacheRoot(), path.join(os.homedir(), '.aeroci', 'toolcache'));
        } finally {
            if (saved !== undefined) process.env.AERO_TOOLCACHE = saved;
        }
    });

    test('the sandbox never copies the cache, even from inside the project', () => {
        // A cache that sits inside the repository used to be cloned into every
        // sandbox: 205 MB and 2340 files, on every run, for a runtime the run
        // then installs again.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sbxc-'));
        const project = path.join(root, 'proj');
        const cache = path.join(project, 'toolcache');
        fs.mkdirSync(path.join(cache, 'node', '18.20.8', 'arm64', 'bin'), { recursive: true });
        fs.mkdirSync(path.join(project, 'src'), { recursive: true });
        fs.writeFileSync(path.join(project, 'src', 'a.txt'), 'a');
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(cache, 'node', '18.20.8', 'arm64', 'bin', `f${i}`), 'x');
        }

        const saved = process.env.AERO_TOOLCACHE;
        process.env.AERO_TOOLCACHE = cache;
        try {
            const withIt = Sandbox.create(project, { exclude: [], excludePaths: [cacheRoot()] });
            const copied = withIt.stats.files;
            const leaked = fs.existsSync(path.join(withIt.dir, 'toolcache'));
            const keptSrc = fs.existsSync(path.join(withIt.dir, 'src', 'a.txt'));
            withIt.dispose({ Logger: { info() {} }, quiet: true });

            assert.ok(!leaked, 'the tool cache must not be copied into the sandbox');
            assert.ok(keptSrc, 'the rest of the project must still be copied');
            assert.ok(copied < 10, `only the project should be copied, got ${copied} files`);
        } finally {
            if (saved === undefined) delete process.env.AERO_TOOLCACHE;
            else process.env.AERO_TOOLCACHE = saved;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('toolchain · consent to download', () => {
    const tmpConfig = (contents) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-cfg-'));
        if (contents !== undefined) {
            fs.writeFileSync(path.join(dir, '.aeroci.json'), JSON.stringify(contents), 'utf8');
        }
        return dir;
    };

    asyncTest('a flag answers for this run and is not written to the project', async () => {
        const dir = tmpConfig({ version: 1, mySetting: 'keep me' });
        try {
            const config = new Config(dir).load();
            assert.strictEqual(await resolveConsent(config, { explicit: true }), true);
            assert.strictEqual(await resolveConsent(config, { explicit: false }), false);
            const written = JSON.parse(fs.readFileSync(path.join(dir, '.aeroci.json'), 'utf8'));
            assert.strictEqual(written.toolchain, undefined, 'a flag must not edit .aeroci.json');
            assert.strictEqual(written.mySetting, 'keep me');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    asyncTest('a recorded answer is reused, and nothing is asked', async () => {
        for (const recorded of [true, false]) {
            const dir = tmpConfig({ version: 1, toolchain: { allowDownload: recorded } });
            try {
                const config = new Config(dir).load();
                assert.strictEqual(config.allowDownload, recorded);
                assert.strictEqual(await resolveConsent(config), recorded);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    asyncTest('with no record and no terminal, nothing is downloaded', async () => {
        // A CI job or a pipe cannot answer a question, so the answer is no.
        // Guessing yes would pull forty megabytes a pipeline never agreed to.
        const dir = tmpConfig();
        try {
            const config = new Config(dir).load();
            assert.strictEqual(config.allowDownload, null, 'nobody has decided yet');
            const isTTY = process.stdin.isTTY;
            process.stdin.isTTY = false;
            try {
                assert.strictEqual(await resolveConsent(config), false);
            } finally {
                process.stdin.isTTY = isTTY;
            }
            assert.ok(!fs.existsSync(path.join(dir, '.aeroci.json')), 'nothing should be written');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('saving the answer keeps the user\'s own keys', () => {
        const dir = tmpConfig({ version: 1, vars: { DEPLOY: 'yes' } });
        try {
            const config = new Config(dir).load();
            assert.strictEqual(config.saveAllowDownload(true), true);
            const written = JSON.parse(fs.readFileSync(path.join(dir, '.aeroci.json'), 'utf8'));
            assert.strictEqual(written.toolchain.allowDownload, true);
            assert.deepStrictEqual(written.vars, { DEPLOY: 'yes' });
            assert.strictEqual(new Config(dir).load().allowDownload, true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('toolchain · refusing honestly', () => {
    // Every reason the requested version cannot be honoured has to reach the
    // caller as a distinct reason, because each one needs a different sentence
    // and a different remedy. A generic "could not set up Node" would hide the
    // difference between "you said no" and "there is no such version".
    const reasonsFor = async (spec) => {
        const saved = process.env.AERO_TOOLCACHE;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-tc-'));
        process.env.AERO_TOOLCACHE = path.join(dir, 'cache');
        try {
            const result = await ensureNode(spec, { allowDownload: false });
            return result;
        } finally {
            if (saved === undefined) delete process.env.AERO_TOOLCACHE;
            else process.env.AERO_TOOLCACHE = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

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
        // The message states the reason only; wording the fallback is the
        // caller's job, so the two are not said twice.
        assert.ok(!/used instead/.test(result.message), result.message);
    });

    asyncTest('an empty spec never reaches the network', async () => {
        const result = await reasonsFor('');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'no-spec');
    });
});
