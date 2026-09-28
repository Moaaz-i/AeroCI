/**
 * Network policy: the promise, the two decisions, and the enforcement.
 *
 * "AeroCI never uses the network without explicit permission" is easy to state
 * and easy to break, so these tests exist to pin the ways it was nearly broken:
 *
 *   1. the two decisions must not leak into each other. Answering yes to
 *      downloading a runtime is not consent for every workflow on the machine to
 *      reach the internet, and a tool that conflates them has no policy at all.
 *   2. a refusal must be an enforced refusal. Where the machine cannot enforce
 *      one, `enforced` is false and the run says so — the alternative is
 *      printing "network denied" while a step quietly opens a socket.
 *   3. a project must not be able to grant it. `.aeroci.json` arrives with a
 *      repository; a policy a repository can grant for itself is not a policy.
 *
 * The isolation probe is exercised for real on macOS (a live `sandbox-exec`, a
 * real `curl`, no network required to prove a denial) and through an injected
 * prober for the platforms CI cannot run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { suite, test, asyncTest, assert } = require('./harness');
const {
    globalRoot, globalConfigPath, runtimesRoot, cacheRoot, loadGlobalConfig,
    saveGlobalConfig, resolveRuntimeConsent, resolveWorkflowConsent, guard,
    probeIsolation, runtimeDownloadQuestion, requestLabel, DENY_PROFILE
} = require('../src/core/network');
const { Config } = require('../src/core/config');

/** Run `fn` with AERO_HOME pointed at a throwaway tree. */
function withHome(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-net-'));
    const saved = process.env.AERO_HOME;
    process.env.AERO_HOME = dir;
    try {
        return fn(dir);
    } finally {
        if (saved === undefined) delete process.env.AERO_HOME;
        else process.env.AERO_HOME = saved;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** As above, for async work. */
async function withHomeAsync(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-net-'));
    const saved = process.env.AERO_HOME;
    process.env.AERO_HOME = dir;
    try {
        return await fn(dir);
    } finally {
        if (saved === undefined) delete process.env.AERO_HOME;
        else process.env.AERO_HOME = saved;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Answer `n` questions without touching stdin, and say how many were asked. */
const answerWith = (value) => {
    const asked = [];
    const ask = async (question) => {
        asked.push(question);
        return value;
    };
    ask.asked = asked;
    return ask;
};

suite('network · the global tree', () => {
    test('the policy, the runtimes and the cache live under one root', () => {
        withHome(() => {
            assert.strictEqual(globalConfigPath(), path.join(globalRoot(), 'config.json'));
            assert.strictEqual(runtimesRoot(), path.join(globalRoot(), 'runtimes'));
            assert.strictEqual(cacheRoot(), path.join(globalRoot(), 'cache'));
        });
    });

    test('a missing config file is the normal case, not an error', () => {
        withHome((dir) => {
            assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
            const loaded = loadGlobalConfig();
            assert.deepStrictEqual(loaded.errors, []);
            assert.strictEqual(loaded.existed, false);
            assert.strictEqual(loaded.data.network.allowRuntimeDownloads, null);
            assert.strictEqual(loaded.data.network.allowWorkflowNetwork, null);
            // Reading must not litter the disk: the tree is created on first write.
            assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
        });
    });

    test('an unparseable file is reported and does not become a default of yes', () => {
        withHome((dir) => {
            fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8');
            const loaded = loadGlobalConfig();
            assert.strictEqual(loaded.errors.length, 1);
            assert.ok(/not valid JSON/.test(loaded.errors[0]), loaded.errors[0]);
            // Falls back to "undecided", which resolves to a refusal. Treating a
            // broken file as permission would be the worst possible reading.
            assert.strictEqual(loaded.data.network.allowWorkflowNetwork, null);
        });
    });

    test('a non-boolean policy value is named rather than coerced', () => {
        withHome((dir) => {
            fs.writeFileSync(
                path.join(dir, 'config.json'),
                JSON.stringify({ network: { allowWorkflowNetwork: 'yes please' } }),
                'utf8'
            );
            const loaded = loadGlobalConfig();
            assert.strictEqual(loaded.errors.length, 1);
            assert.ok(/allowWorkflowNetwork/.test(loaded.errors[0]), loaded.errors[0]);
            assert.strictEqual(loaded.data.network.allowWorkflowNetwork, null);
        });
    });

    test('saving one decision leaves the other one, and unrelated keys, alone', () => {
        withHome((dir) => {
            fs.writeFileSync(
                path.join(dir, 'config.json'),
                JSON.stringify({ network: { allowWorkflowNetwork: true }, myKey: 'keep me' }),
                'utf8'
            );
            assert.strictEqual(saveGlobalConfig('allowRuntimeDownloads', false), true);
            const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
            assert.strictEqual(written.network.allowRuntimeDownloads, false);
            assert.strictEqual(written.network.allowWorkflowNetwork, true, 'the other decision is untouched');
            assert.strictEqual(written.myKey, 'keep me');
        });
    });
});

suite('network · two decisions, not one', () => {
    asyncTest('allowing runtime downloads does not allow workflow network', async () => {
        // The whole point of the split. A workflow that needs its runtime
        // installed and has no business phoning home is an ordinary thing, and a
        // single key cannot express it.
        await withHomeAsync(async () => {
            const isTTY = process.stdin.isTTY;
            process.stdin.isTTY = true;
            try {
                const ask = answerWith(true);
                assert.strictEqual(
                    await resolveRuntimeConsent({ spec: '18', version: '18.20.8', ask }), true
                );
            } finally {
                process.stdin.isTTY = isTTY;
            }
            const { data } = loadGlobalConfig();
            assert.strictEqual(data.network.allowRuntimeDownloads, true, 'the answer was recorded');
            assert.strictEqual(
                data.network.allowWorkflowNetwork, null,
                'the workflow decision must still be undecided'
            );
        });
    });

    asyncTest('denying runtime downloads does not deny workflow network either', async () => {
        await withHomeAsync(async () => {
            saveGlobalConfig('allowRuntimeDownloads', false);
            saveGlobalConfig('allowWorkflowNetwork', true);
            const { data } = loadGlobalConfig();
            assert.strictEqual(data.network.allowRuntimeDownloads, false);
            assert.strictEqual(data.network.allowWorkflowNetwork, true);
            // And each resolver reads only its own key.
            assert.strictEqual(await resolveRuntimeConsent({ ask: answerWith(true) }), false);
            assert.strictEqual(await resolveWorkflowConsent({ ask: answerWith(false) }), true);
        });
    });

    asyncTest('a flag answers for one run and is written nowhere', async () => {
        await withHomeAsync(async (dir) => {
            const ask = answerWith(false);
            assert.strictEqual(await resolveWorkflowConsent({ explicit: true, ask }), true);
            assert.strictEqual(await resolveWorkflowConsent({ explicit: false, ask }), false);
            assert.strictEqual(ask.asked.length, 0, 'a flag must not ask anything');
            assert.ok(!fs.existsSync(path.join(dir, 'config.json')), 'a flag must not edit any file');
        });
    });

    asyncTest('a recorded answer is reused, and nothing is asked again', async () => {
        await withHomeAsync(async () => {
            for (const recorded of [true, false]) {
                saveGlobalConfig('allowWorkflowNetwork', recorded);
                const ask = answerWith(!recorded);
                assert.strictEqual(await resolveWorkflowConsent({ ask }), recorded);
                assert.strictEqual(ask.asked.length, 0, 'the second run must not ask again');
            }
        });
    });

    asyncTest('with no record and no terminal, the answer is no', async () => {
        // A CI job or a pipe cannot answer, so it is refused. Guessing yes would
        // be the network access it never agreed to.
        await withHomeAsync(async () => {
            const ask = answerWith(true);
            const isTTY = process.stdin.isTTY;
            process.stdin.isTTY = false;
            try {
                assert.strictEqual(await resolveWorkflowConsent({ ask }), false);
            } finally {
                process.stdin.isTTY = isTTY;
            }
            assert.strictEqual(ask.asked.length, 0, 'a non-terminal must not be prompted');
        });
    });

    asyncTest('a terminal is asked once, and the answer is recorded', async () => {
        await withHomeAsync(async () => {
            const ask = answerWith(true);
            const isTTY = process.stdin.isTTY;
            process.stdin.isTTY = true;
            try {
                assert.strictEqual(await resolveWorkflowConsent({ ask }), true);
            } finally {
                process.stdin.isTTY = isTTY;
            }
            assert.strictEqual(ask.asked.length, 1);
            assert.strictEqual(loadGlobalConfig().data.network.allowWorkflowNetwork, true);

            // A second call reads the record rather than asking again.
            const second = answerWith(false);
            assert.strictEqual(await resolveWorkflowConsent({ ask: second }), true);
            assert.strictEqual(second.asked.length, 0);
        });
    });
});

suite('network · a project cannot grant it', () => {
    test('a network key in .aeroci.json is refused, stripped, and named', () => {
        withHome(() => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-proj-'));
            try {
                fs.writeFileSync(
                    path.join(dir, '.aeroci.json'),
                    JSON.stringify({ version: 1, network: { allowWorkflowNetwork: true } }),
                    'utf8'
                );
                const config = new Config(dir).load();
                const complaint = config.errors.find((e) => /allowWorkflowNetwork/.test(e));
                assert.ok(complaint, `expected a refusal, got ${JSON.stringify(config.errors)}`);
                // It must say where the setting actually lives, not just that it
                // did not work. A user who typed this deserves a fix.
                assert.ok(complaint.includes(globalConfigPath()), complaint);
                // Reporting is not enough — it has to actually not reach anything.
                // The bug this catches: the key is complained about and then
                // merged in anyway.
                assert.strictEqual(config.raw.network, undefined, 'the key must not be merged in');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    test('the old toolchain.allowDownload key is reported as relocated', () => {
        withHome(() => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-proj-'));
            try {
                fs.writeFileSync(
                    path.join(dir, '.aeroci.json'),
                    JSON.stringify({ version: 1, toolchain: { allowDownload: true } }),
                    'utf8'
                );
                const config = new Config(dir).load();
                const complaint = config.errors.find((e) => /toolchain\.allowDownload/.test(e));
                assert.ok(complaint, `expected a relocation notice, got ${JSON.stringify(config.errors)}`);
                assert.ok(/allowRuntimeDownloads/.test(complaint), complaint);
                assert.strictEqual(config.raw.toolchain, undefined, 'it must be stripped too');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    test('a project with no network key says nothing at all', () => {
        withHome(() => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-proj-'));
            try {
                fs.writeFileSync(path.join(dir, '.aeroci.json'), JSON.stringify({ version: 1 }), 'utf8');
                assert.deepStrictEqual(new Config(dir).load().errors, []);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});

suite('network · the question it asks', () => {
    test('a range is named as a range, not as a runtime', () => {
        // "Node.js 18 is not installed locally" is not a true sentence: 18 is a
        // range, and the thing that is or is not installed is a build.
        assert.strictEqual(requestLabel('18'), '18.x');
        assert.strictEqual(requestLabel('18.x'), '18.x');
        assert.strictEqual(requestLabel('18.20'), '18.20.x');
        assert.strictEqual(requestLabel('18.20.4'), '18.20.4');
        assert.strictEqual(requestLabel('v22.23.3'), '22.23.3');
        // With no numbers to speak of, the concrete build is what is on offer.
        assert.strictEqual(requestLabel('lts/*', '24.21.0'), 'v24.21.0');
    });

    test('with a known build it names the file and where it lands', () => {
        const q = runtimeDownloadQuestion({ label: '18.x', version: '18.20.8', host: '26.9.0' });
        assert.ok(q.includes('AeroCI needs Node.js 18.x to execute this workflow.'), q);
        assert.ok(q.includes('Node.js 18.x is not installed locally.'), q);
        assert.ok(q.includes('Download it now?'), q);
        assert.ok(q.includes('[Y] Yes'), q);
        assert.ok(q.includes('[N] No'), q);
        assert.ok(q.includes('18.20.8'), q);
        assert.ok(q.includes(path.join(runtimesRoot(), 'node', '18.20.8')), q);
        // What No costs has to be visible before the answer, not discovered after.
        assert.ok(/fails/.test(q), q);
        assert.ok(/26\.9\.0 is not a substitute/.test(q), q);
    });

    test('with no build resolved yet it does not promise one', () => {
        // Turning "18" into "18.20.8" means reading nodejs.org, which is itself a
        // network request. Promising a specific file before having looked would be
        // a claim AeroCI has not earned, so the offer is worded for what is
        // actually on the table.
        const q = runtimeDownloadQuestion({ label: '18.x', version: '', host: '26.9.0' });
        assert.ok(!/18\.20\.8/.test(q), q);
        assert.ok(/reach nodejs\.org/.test(q), q);
    });

    test('a bare Enter is spelled out as a refusal', () => {
        // The promise is that nothing reaches the network without *explicit*
        // permission, and a keypress that expresses nothing is not permission.
        const q = runtimeDownloadQuestion({ label: '18.x', version: '18.20.8', host: '26.9.0' });
        assert.ok(/Enter means No/.test(q), q);
    });
});

suite('network · enforcement', () => {
    test('allowed means no wrapper at all', () => {
        const g = guard(true);
        assert.strictEqual(g.allowed, true);
        assert.strictEqual(g.command, null);
        assert.strictEqual(g.args.length, 0);
    });

    test('a platform with no mechanism is not enforced, and says why', () => {
        // Windows. There is no mechanism, so there is no claim of one. The
        // alternative — printing "denied" and doing nothing — is the failure this
        // whole design exists to prevent.
        const g = guard(false, { platform: 'win32', run: () => ({ status: 0 }) });
        assert.strictEqual(g.allowed, false);
        assert.strictEqual(g.enforced, false);
        assert.strictEqual(g.mechanism, null);
        assert.strictEqual(g.command, null);
        assert.ok(/win32 has no network-isolation mechanism/.test(g.reason), g.reason);
        assert.ok(/NOT enforced/.test(g.notice), g.notice);
    });

    test('a present-but-unusable unshare is not mistaken for a working one', () => {
        // `which unshare` reports this as installed. The probe runs it, because a
        // kernel without user namespaces, or a rootless container without the
        // capability, is the common case and looks identical from a PATH search.
        const g = guard(false, {
            platform: 'linux',
            run: (cmd) => ({ status: 1, error: cmd === 'unshare' ? { code: 'EPERM' } : undefined })
        });
        assert.strictEqual(g.enforced, false);
        assert.ok(/unshare --net --map-root-user failed/.test(g.reason), g.reason);
    });

    test('a missing unshare says it is missing, not that it failed', () => {
        const g = guard(false, {
            platform: 'linux',
            run: () => ({ status: null, error: { code: 'ENOENT' } })
        });
        assert.ok(/not installed/.test(g.reason), g.reason);
    });

    test('a working unshare is used with --map-root-user, so no root is needed', () => {
        const g = guard(false, { platform: 'linux', run: () => ({ status: 0 }) });
        assert.strictEqual(g.enforced, true);
        assert.strictEqual(g.mechanism, 'unshare');
        assert.deepStrictEqual(g.args, ['--net', '--map-root-user', '--']);
    });

    test('a denied run on macOS really is denied', () => {
        // The claim checked with a real network call, not a mocked one. A denied
        // request that still returned data would mean the promise is a lie, so
        // there is nothing to assert on a platform where the mechanism is absent
        // and the other tests cover the reporting instead.
        if (process.platform !== 'darwin') return;
        const g = guard(false);
        assert.strictEqual(g.enforced, true, g.reason || '');
        assert.strictEqual(g.mechanism, 'sandbox-exec');

        const res = spawnSync(g.command, [
            ...g.args,
            '/usr/bin/curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
            '--max-time', '10', 'https://registry.npmjs.org/left-pad'
        ], { encoding: 'utf8', timeout: 30000 });
        // `000` is curl's "no response was received". 200 would mean the denial
        // did not hold.
        assert.strictEqual((res.stdout || '').trim(), '000', `expected no response, got ${res.stdout}`);

        // And a raw socket is denied too, not just a resolved name: a policy that
        // only blocked DNS would be trivially routed around with an IP literal.
        const raw = spawnSync(g.command, [
            ...g.args,
            process.execPath, '-e',
            "const s=require('net').connect(80,'104.16.0.35');" +
            "s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});" +
            "s.on('error',e=>{console.log('ERR '+e.code);process.exit(0)});" +
            "setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},6000)"
        ], { encoding: 'utf8', timeout: 30000 });
        assert.ok(/^ERR /.test((raw.stdout || '').trim()), `expected a refusal, got ${raw.stdout}`);
    });

    test('the profile scopes the denial to leaving the machine', () => {
        // `(deny network*)` is the obvious spelling and it is wrong: `network*`
        // covers `network-bind`, so a step cannot even listen on a port, and a
        // workflow that starts a dev server and talks to it breaks for a reason
        // the user never agreed to. A real runner allows that.
        assert.ok(!/\(deny network\*\)/.test(DENY_PROFILE), `too blunt: ${DENY_PROFILE}`);
        const deny = DENY_PROFILE.indexOf('(deny network-outbound');
        const allow = DENY_PROFILE.indexOf('(allow network-outbound (remote ip "localhost:*"))');
        assert.ok(deny > -1, DENY_PROFILE);
        assert.ok(allow > -1, DENY_PROFILE);
        // Last-match-wins, so the exception has to come after the denial.
        assert.ok(allow > deny, 'the localhost exception must come after the denial');
        // And nothing may touch network-bind, or listening breaks again.
        assert.ok(!DENY_PROFILE.includes('network-bind'), DENY_PROFILE);
    });

    test('a step may still start a server and reach it', () => {
        // The case the profile above exists for, run for real: bind a port, then
        // connect to it from the same step. A profile that blocked this would
        // break ordinary workflows in a way that looks like a network fault.
        if (process.platform !== 'darwin') return;
        const g = guard(false);
        const probe = "const s=require('http').createServer((q,r)=>r.end('hi'))" +
            ".listen(46006,'127.0.0.1',()=>{require('http')" +
            ".get('http://127.0.0.1:46006/',r=>{let b='';r.on('data',c=>b+=c);" +
            "r.on('end',()=>{console.log('reached -> '+b);process.exit(0)})})" +
            ".on('error',e=>{console.log('ERR '+e.code);process.exit(0)})});" +
            "s.on('error',e=>{console.log('LISTEN ERR '+e.code);process.exit(0)})";
        const res = spawnSync(g.command, [...g.args, process.execPath, '-e', probe], {
            encoding: 'utf8', timeout: 30000
        });
        assert.ok(
            (res.stdout || '').includes('reached -> hi'),
            `loopback must work under a denial, got ${res.stdout} ${res.stderr}`
        );
    });

    test('the filesystem is not collateral damage', () => {
        // The guard is about the network. A profile that also blocked disk access
        // would break every workflow for a reason no user asked for.
        if (process.platform !== 'darwin') return;
        const g = guard(false);
        const res = spawnSync(g.command, [
            ...g.args, '/bin/sh', '-c', 'echo ok > "$TMPDIR/aeroci-guard-probe" && cat "$TMPDIR/aeroci-guard-probe"'
        ], { encoding: 'utf8', timeout: 30000 });
        assert.ok((res.stdout || '').includes('ok'), `expected a write to work, got ${res.stdout} ${res.stderr}`);
        try { fs.unlinkSync(path.join(os.tmpdir(), 'aeroci-guard-probe')); } catch (_) { /* best effort */ }
    });

    test('the probe reports this machine honestly', () => {
        const probe = probeIsolation();
        if (probe.mechanism) {
            assert.strictEqual(probe.reason, null);
            assert.ok(probe.command, 'a mechanism comes with something to run');
        } else {
            // An unenforced machine is a supported state, but it must say why.
            assert.ok(probe.reason && probe.reason.length > 10, JSON.stringify(probe));
            assert.strictEqual(probe.command, null);
        }
    });
});

suite('network · what a step actually experiences', () => {
    const { Engine } = require('../src/core/engine');
    const { Logger } = require('../src/utils/logger');
    Logger.setQuiet(true);

    /**
     * One step, one run, and the whole story.
     *
     * Everything above this suite tests the policy in isolation. These run real
     * steps through the real engine, because the claim is not "the function
     * returns a wrapper" — it is "a workflow could not reach the network", and
     * only a step can show that.
     */
    async function step(script, network) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-netrun-'));
        const wf = path.join(dir, '.github', 'workflows');
        fs.mkdirSync(wf, { recursive: true });
        fs.writeFileSync(
            path.join(wf, 'ci.yml'),
            'name: probe\non: [push]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n' +
            '      - name: probe\n        run: |\n' +
            script.split('\n').map((l) => `          ${l}`).join('\n') + '\n',
            'utf8'
        );
        try {
            const engine = new Engine({ cwd: dir, network, inheritEnv: false });
            const [result] = await engine.run([path.join(wf, 'ci.yml')]);
            const job = (result.jobs || [])[0];
            return {
                result,
                step: ((job && job.steps) || [])[0] || {},
                output: ((job && job.steps) || []).map((s) => (s.log || []).map((l) => l.line).join('\n')).join('\n')
            };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    asyncTest('a denied step cannot reach the internet', async () => {
        // The promise, checked the only way that means anything: a real request
        // from a real step. If this passes on a machine with no isolation
        // mechanism it proves nothing, so it is skipped rather than made to look
        // like a green check.
        if (!guard(false).enforced) return;
        const g = guard(false);
        const r = await step(
            'curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://registry.npmjs.org/left-pad || true',
            g
        );
        // `000` is curl's "no response was received". Anything else — including a
        // timeout reported as an empty string — would mean the denial did not hold.
        assert.ok(r.output.includes('000'), `expected no response, got: ${r.output}`);
    });

    asyncTest('a denied step can still start a server and reach it', async () => {
        if (!guard(false).enforced) return;
        const probe = "require('http').createServer((q,s)=>s.end('hi')).listen(46007,'127.0.0.1'," +
            "()=>require('http').get('http://127.0.0.1:46007/',r=>{let b='';r.on('data',c=>b+=c);" +
            "r.on('end',()=>{console.log('reached -> '+b);process.exit(0)})})" +
            ".on('error',e=>{console.log('ERR '+e.code);process.exit(1)}))";
        const r = await step(`node -e ${JSON.stringify(probe)}`, guard(false));
        assert.ok(r.output.includes('reached -> hi'), `loopback must survive a denial, got: ${r.output}`);
    });

    asyncTest('a failure under a denial says it might be the policy', async () => {
        // `exit 3` needs no network to fail, so this is about the note rather than
        // about the denial, and it holds whether or not this machine can enforce.
        const r = await step('exit 3', guard(false));
        assert.strictEqual(r.step.status, 'failure');
        const note = (r.step.warnings || []).find((w) => /policy/.test(w));
        assert.ok(note, `expected a policy note, got ${JSON.stringify(r.step.warnings)}`);
        assert.ok(/--allow-network/.test(note), note);
    });

    asyncTest('a failure with access allowed is not blamed on the policy', async () => {
        // The note has to mean something. Printed on every failure it is noise
        // that trains the reader to skip it.
        const r = await step('exit 3', guard(true));
        assert.strictEqual(r.step.status, 'failure');
        assert.ok(
            !(r.step.warnings || []).some((w) => /may be AeroCI|may have nothing/.test(w)),
            'no policy note when the network was allowed'
        );
    });

    asyncTest('the note is said once, not once per failing step', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-netrun-'));
        const wf = path.join(dir, '.github', 'workflows');
        fs.mkdirSync(wf, { recursive: true });
        fs.writeFileSync(
            path.join(wf, 'ci.yml'),
            'name: probe\non: [push]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n' +
            '      - run: exit 3\n      - run: exit 3\n      - run: exit 3\n',
            'utf8'
        );
        try {
            const engine = new Engine({ cwd: dir, network: guard(false), inheritEnv: false });
            const [result] = await engine.run([path.join(wf, 'ci.yml')]);
            const job = (result.jobs || [])[0];
            const notes = (job.steps || [])
                .flatMap((s) => s.warnings || [])
                .filter((w) => /policy/.test(w));
            assert.strictEqual(notes.length, 1, `expected exactly one note, got ${notes.length}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    asyncTest('an enforced denial and an unenforced one are worded differently', async () => {
        // "Denied" and "denied but doing nothing" are different facts, and a
        // reader who cannot tell them apart has been given nothing to act on. The
        // wording is what is under test here, so the two shapes are handed to the
        // note directly rather than faked into a whole run.
        const noteFor = (net) => {
            const record = { warnings: [] };
            new Engine({ network: net })._notePossiblePolicyCause(record);
            return record.warnings.join(' ');
        };
        const enforced = noteFor(guard(false, { platform: 'linux', run: () => ({ status: 0 }) }));
        const unenforced = noteFor(guard(false, { platform: 'win32', run: () => ({ status: 0 }) }));
        assert.ok(/may be AeroCI’s policy/.test(enforced), enforced);
        assert.ok(/may have nothing to do with the workflow/.test(unenforced), unenforced);
        // The unenforced one has to admit the policy did not apply, not merely
        // sound less certain.
        assert.ok(/could not be enforced/.test(unenforced), unenforced);
    });
});
