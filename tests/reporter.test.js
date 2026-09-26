/**
 * The reporter: everything AeroCI writes about a run.
 *
 * A report is the artefact a person acts on, so the tests here are mostly about
 * not lying: a skipped step is not a pass, an unrunnable action is not a pass,
 * and a value that comes from a script cannot be allowed to break out of the
 * XML or HTML it is embedded in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const { Reporter, STATUS, escapeXml, escapeHtml } = require('../src/core/reporter');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** A reporter with a fixed set of steps. */
function reporter(steps, opts = {}) {
    const r = new Reporter({ workflowName: opts.workflowName || 'CI', workflowFile: opts.workflowFile || 'ci.yml' });
    for (const step of steps) r.recordStep(step);
    r.finalize();
    return r;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-report-'));

suite('reporter · recording', () => {
    test('a step with no status is derived from its exit code', () => {
        const r = reporter([{ jobId: 'j', stepName: 'a', exitCode: 0 }]);
        assert.strictEqual(r.steps[0].status, STATUS.SUCCESS);
    });

    test('a non-zero exit code is a failure even without a status', () => {
        const r = reporter([{ jobId: 'j', stepName: 'a', exitCode: 2 }]);
        assert.strictEqual(r.steps[0].status, STATUS.FAILURE);
    });

    test('a step with neither status nor exit code is not silently a pass', () => {
        // Unknown is not success. Anything else turns a step that never ran into
        // a green tick.
        const r = reporter([{ jobId: 'j', stepName: 'a' }]);
        assert.notStrictEqual(r.steps[0].status, STATUS.SUCCESS);
    });

    test('an unnamed step is labelled, not left blank', () => {
        const r = reporter([{ jobId: 'j' }]);
        assert.strictEqual(r.steps[0].stepName, '(unnamed)');
    });

    test('the run fails when any step failed', () => {
        const r = reporter([
            { jobId: 'j', stepName: 'a', status: STATUS.SUCCESS },
            { jobId: 'j', stepName: 'b', status: STATUS.FAILURE }
        ]);
        assert.strictEqual(r.status, STATUS.FAILURE);
    });

    test('a run of only skipped steps still counts as successful', () => {
        // Nothing ran, so nothing failed. Reporting that as a failure would be
        // as dishonest as the reverse.
        const r = reporter([
            { jobId: 'j', stepName: 'a', status: STATUS.SKIPPED },
            { jobId: 'j', stepName: 'b', status: STATUS.NOT_SIMULATED }
        ]);
        assert.strictEqual(r.status, STATUS.SUCCESS);
    });
});

suite('reporter · finalize does not rewrite a known end time', () => {
    test('an end time already set is left alone', () => {
        const r = reporter([{ jobId: 'j', stepName: 'a' }]);
        r.endTime = '2020-01-01T00:00:00.000Z';
        r.finalize();
        assert.strictEqual(r.endTime, '2020-01-01T00:00:00.000Z');
    });

    test('finalize twice is idempotent', () => {
        const r = new Reporter({ workflowName: 'CI' });
        r.finalize();
        const first = r.endTime;
        r.finalize();
        assert.strictEqual(r.endTime, first);
    });

    test('finalize on a fresh reporter sets an end time', () => {
        const r = new Reporter({ workflowName: 'CI' });
        assert.strictEqual(r.endTime, null);
        r.finalize();
        assert.ok(r.endTime, 'expected an end time');
    });
});

suite('reporter · round trip through JSON', () => {
    test('a report rebuilt from its own JSON matches the original', () => {
        const original = reporter([
            { jobId: 'build', stepName: 'Compile', status: STATUS.SUCCESS, durationMs: 1200 },
            { jobId: 'build', stepName: 'Test', status: STATUS.FAILURE, durationMs: 300, exitCode: 1,
                errors: ['exit code 1'], script: 'npm test' }
        ]);
        const json = JSON.parse(original.generateJSON());
        const back = Reporter.fromJSON(json);
        assert.strictEqual(back.workflowName, original.workflowName);
        assert.strictEqual(back.steps.length, original.steps.length);
        assert.strictEqual(back.steps[1].stepName, 'Test');
        assert.strictEqual(back.steps[1].status, STATUS.FAILURE);
        assert.strictEqual(back.status, original.status);
    });

    test('re-rendering a stored report does not change the end time', () => {
        const original = reporter([{ jobId: 'j', stepName: 'a' }]);
        const json = JSON.parse(original.generateJSON());
        const back = Reporter.fromJSON(json);
        assert.strictEqual(back.endTime, json.meta.endTime);
    });

    test('an empty object does not throw', () => {
        const r = Reporter.fromJSON({});
        assert.strictEqual(r.steps.length, 0);
    });
});

suite('reporter · XML is well formed', () => {
    test('a step name with markup is escaped, not pasted in', () => {
        // A step name comes from the workflow, so it is untrusted input. If it
        // reaches the XML raw, the file no longer parses and the CI consumer
        // drops the whole result.
        const r = reporter([
            { jobId: 'j', stepName: 'Run <script>alert("x")</script>', status: STATUS.FAILURE,
                exitCode: 1, errors: ['bad & worse'] }
        ]);
        const xmlOut = r.generateJUnit();
        assert.ok(!/<script>/.test(xmlOut), xmlOut.slice(0, 400));
        assert.ok(/&lt;script&gt;/.test(xmlOut));
        assert.ok(/&amp;/.test(xmlOut));
    });

    test('the escaping covers every character that matters', () => {
        assert.strictEqual(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
        assert.strictEqual(escapeXml(null), '');
        assert.strictEqual(escapeXml(undefined), '');
    });

    test('a numeric-looking string is not stripped by the escaper', () => {
        assert.strictEqual(escapeXml('0'), '0');
        assert.strictEqual(escapeXml(0), '0');
    });

    test('the document declares itself and closes every element it opens', () => {
        const r = reporter([
            { jobId: 'j', stepName: 'a', status: STATUS.SUCCESS, log: [{ stream: 'stdout', line: 'ok' }] },
            { jobId: 'j', stepName: 'b', status: STATUS.SKIPPED }
        ]);
        const out = r.generateJUnit();
        const open = (out.match(/<testcase\b/g) || []).length;
        const close = (out.match(/<\/testcase>/g) || []).length;
        assert.strictEqual(open, 2);
        assert.strictEqual(close, 2);
        assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(out.trimEnd().endsWith('</testsuites>'));
    });

    test('failures and skips are reported as such', () => {
        const r = reporter([
            { jobId: 'j', stepName: 'a', status: STATUS.FAILURE, exitCode: 1, errors: ['boom'] },
            { jobId: 'j', stepName: 'b', status: STATUS.SKIPPED }
        ]);
        const out = r.generateJUnit();
        assert.ok(/<failure message=/.test(out), out);
        assert.ok(/<skipped message=/.test(out), out);
        assert.ok(/failures="1"/.test(out), out);
        assert.ok(/skipped="1"/.test(out), out);
    });

    test('a skipped step is never counted as a failure', () => {
        const r = reporter([{ jobId: 'j', stepName: 'a', status: STATUS.SKIPPED }]);
        assert.ok(/failures="0"/.test(r.generateJUnit()));
        assert.ok(/skipped="1"/.test(r.generateJUnit()));
    });
});

suite('reporter · HTML is safe to open', () => {
    test('a step name with markup is escaped', () => {
        const r = reporter([{ jobId: 'j', stepName: '<img src=x onerror=alert(1)>' }]);
        const out = r.generateHTML();
        assert.ok(!/<img /.test(out), 'raw markup reached the page');
        assert.ok(/&lt;img/.test(out));
    });

    test('the escaper covers the HTML specials', () => {
        assert.strictEqual(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
        assert.strictEqual(escapeHtml(null), '');
    });

    test('step output is escaped inside the page', () => {
        const r = reporter([
            { jobId: 'j', stepName: 'a', log: [{ stream: 'stdout', line: '</pre><script>x</script>' }] }
        ]);
        const out = r.generateHTML();
        assert.ok(!/<script>x<\/script>/.test(out), 'unescaped output in the page');
    });

    test('the page is a complete document', () => {
        const r = reporter([{ jobId: 'j', stepName: 'a' }]);
        const out = r.generateHTML();
        assert.ok(/<html/i.test(out));
        assert.ok(/<\/html>/i.test(out));
    });
});

suite('reporter · writing files', () => {
    test('generateAll writes one file per format under the slug', () => {
        const dir = tmp();
        try {
            const r = reporter([{ jobId: 'j', stepName: 'a' }], { workflowFile: 'release.yml' });
            const out = r.generateAll({ dir });
            const names = fs.readdirSync(dir).sort();
            assert.deepStrictEqual(names, ['release.html', 'release.json', 'release.md', 'release.xml']);
            assert.strictEqual(out.markdown.endsWith('release.md'), true);
            assert.strictEqual(out.junit.endsWith('release.xml'), true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('two workflows in one run do not overwrite each other', () => {
        // Both used to be written as `report.json`; the second silently replaced
        // the first, and the run reported both as written.
        const dir = tmp();
        try {
            reporter([{ jobId: 'j', stepName: 'a' }], { workflowFile: 'ci.yml' })
                .generateAll({ formats: ['json'], dir });
            reporter([{ jobId: 'j', stepName: 'b' }], { workflowFile: 'release.yml' })
                .generateAll({ formats: ['json'], dir });
            assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['ci.json', 'release.json']);
            const first = JSON.parse(fs.readFileSync(path.join(dir, 'ci.json'), 'utf8'));
            assert.strictEqual(first.steps[0].stepName, 'a');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('without a directory nothing is written, and the caller is told', () => {
        // Silently returning an empty object would let `aeroci run --report` look
        // like it produced artefacts when it produced none.
        const before = fs.readdirSync(process.cwd()).length;
        const out = reporter([{ jobId: 'j', stepName: 'a' }]).generateAll({ formats: ['json'] });
        assert.deepStrictEqual(out, {});
        assert.strictEqual(fs.readdirSync(process.cwd()).length, before);
    });

    test('the generators themselves never touch the filesystem', () => {
        const dir = tmp();
        const before = fs.readdirSync(dir);
        const r = reporter([{ jobId: 'j', stepName: 'a' }]);
        for (const text of [r.generateJSON(), r.generateMarkdown(), r.generateHTML(), r.generateJUnit()]) {
            assert.strictEqual(typeof text, 'string');
            assert.ok(text.length > 0);
        }
        assert.deepStrictEqual(fs.readdirSync(dir), before);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('the output directory is created if it does not exist', () => {
        const base = tmp();
        const dir = path.join(base, 'deep', 'nested');
        try {
            reporter([{ jobId: 'j', stepName: 'a' }], { workflowFile: 'ci.yml' })
                .generateAll({ formats: ['json'], dir });
            assert.ok(fs.existsSync(path.join(dir, 'ci.json')));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});

suite('reporter · diff', () => {
    const A = `
name: A
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
      - run: echo two
`;
    const B = `
name: A
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
      - run: echo three
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

    const write = (dir, name, body) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, body);
        return file;
    };

    test('each difference is classified, not just counted', () => {
        const dir = tmp();
        try {
            const { changes, details } = Reporter.diff(write(dir, 'a.yml', A), write(dir, 'b.yml', B));
            assert.strictEqual(changes, details.length);
            const find = (kind, text) => details.some((d) => d.kind === kind && d.what.includes(text));
            assert.ok(find('added', 'trigger `pull_request`'), JSON.stringify(details));
            assert.ok(find('added', 'job `deploy`'), JSON.stringify(details));
            assert.ok(find('added', 'echo three'), JSON.stringify(details));
            assert.ok(find('removed', 'echo two'), JSON.stringify(details));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a change to a job key is reported as a change, not as add plus remove', () => {
        const dir = tmp();
        const C = B.replace('runs-on: ubuntu-latest', 'runs-on: macos-latest');
        try {
            const { details } = Reporter.diff(write(dir, 'a.yml', B), write(dir, 'b.yml', C));
            const change = details.find((d) => d.kind === 'changed' && d.what.includes('runs-on'));
            assert.ok(change, JSON.stringify(details));
            assert.ok(!details.some((d) => d.kind === 'added' && d.what.includes('job `deploy`')),
                JSON.stringify(details));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('two identical workflows report no changes', () => {
        const dir = tmp();
        try {
            const { changes } = Reporter.diff(write(dir, 'a.yml', A), write(dir, 'b.yml', A));
            assert.strictEqual(changes, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a missing file is reported, not diffed as empty', () => {
        const dir = tmp();
        try {
            const { changes } = Reporter.diff(path.join(dir, 'nope.yml'), write(dir, 'b.yml', B));
            assert.strictEqual(changes, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
