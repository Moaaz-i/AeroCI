/**
 * The security auditor.
 *
 * Two failure modes matter equally here and the tests are split between them:
 * a real hole that gets through, and a warning that is not real. A scanner
 * people stop reading is worth less than no scanner, and both failure modes
 * end the same way — the finding is ignored.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, assert } = require('./harness');
const { Security, LEVEL, countByLevel } = require('../src/core/security');
const { Logger } = require('../src/utils/logger');

Logger.setQuiet(true);

/** Audit one workflow written on the fly. */
function audit(yaml, { name = 'ci.yml', options = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sec-'));
    try {
        fs.writeFileSync(path.join(dir, name), yaml);
        return Security.audit(dir, options);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Findings of one rule. */
const byRule = (out, rule) => out.findings.filter((f) => f.rule === rule);
const atLevel = (out, level) => out.findings.filter((f) => f.level === level);

/** A workflow with the given jobs body, which is what most cases vary. */
const WF = (jobs, { on = 'push', extra = '' } = {}) => `
name: S
on: ${on}
${extra}jobs:
${jobs}
`;

const CLEAN_STEPS = '    steps:\n      - run: echo hi\n';

suite('security · template injection', () => {
    test('an issue title interpolated into a script is critical', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"`));
        const finding = byRule(out, 'template-injection')[0];
        assert.ok(finding, JSON.stringify(out.findings, null, 1));
        assert.strictEqual(finding.level, LEVEL.CRITICAL);
    });

    test('the finding names the value that has to move', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"`));
        const finding = byRule(out, 'template-injection')[0];
        assert.ok(/github\.event\.issue\.title/.test(finding.detail), finding.detail);
        assert.ok(/env:/.test(finding.fix), finding.fix);
    });

    test('a branch name is untrusted too', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.head_ref }}"`));
        assert.strictEqual(byRule(out, 'template-injection').length, 1, JSON.stringify(out.findings));
    });

    test('a trusted value in a script is not an injection', () => {
        // `github.repository` is set by the platform, not by a contributor. Flag
        // it and the rule stops being read.
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.repository }} \${{ github.sha }} \${{ runner.os }}"`));
        assert.deepStrictEqual(byRule(out, 'template-injection'), []);
    });

    test('a value bound to env and quoted in the script is accepted', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - name: Safe
        env:
          TITLE: \${{ github.event.issue.title }}
        run: echo "\$TITLE"`));
        assert.deepStrictEqual(byRule(out, 'template-injection'), []);
    });

    test('the same value unquoted in the script is still reported', () => {
        // Moving to `env:` is only half the fix; without the quotes the shell
        // re-splits whatever the contributor typed.
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - name: Still unsafe
        env:
          TITLE: \${{ github.event.issue.title }}
        run: echo \$TITLE`));
        assert.ok(byRule(out, 'template-injection').length > 0, JSON.stringify(out.findings));
    });

    test('an expression that merely mentions a trusted prefix is not flagged', () => {
        // `github.event` on its own is not in the untrusted list; only the
        // specific contributor-controlled fields are.
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event_name }}"`));
        assert.deepStrictEqual(byRule(out, 'template-injection'), []);
    });

    test('a function call wrapping an untrusted value is still caught', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('{0}', github.event.issue.title) }}"`));
        assert.strictEqual(byRule(out, 'template-injection').length, 1, JSON.stringify(out.findings));
    });

    test('a dynamic uses: is critical — it chooses the code that runs', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: \${{ github.event.issue.title }}`));
        const finding = byRule(out, 'template-injection')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(finding.level, LEVEL.CRITICAL);
    });
});

suite('security · pull_request_target', () => {
    const CHECKOUT_FORK = WF(`  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}`, { on: 'pull_request_target' });

    test('checking out the fork under pull_request_target is critical', () => {
        const out = audit(CHECKOUT_FORK);
        const finding = byRule(out, 'trigger-context')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(finding.level, LEVEL.CRITICAL);
    });

    test('the same checkout on pull_request is not reported', () => {
        // `pull_request` gets a read-only token and no secrets, so this is the
        // shape the fix recommends.
        const out = audit(WF(`  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}`, { on: 'pull_request' }));
        assert.deepStrictEqual(byRule(out, 'trigger-context'), []);
    });

    test('a checkout of the default branch is fine even under pull_request_target', () => {
        const out = audit(WF(`  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`, { on: 'pull_request_target' }));
        assert.deepStrictEqual(byRule(out, 'trigger-context'), []);
    });
});

suite('security · token permissions', () => {
    test('no permissions block is reported', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`));
        const finding = byRule(out, 'token-permissions')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.ok(/permissions:/.test(finding.fix), finding.fix);
    });

    test('write-all is reported harder than a missing block', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, { extra: 'permissions: write-all\n' }));
        const finding = byRule(out, 'token-permissions')[0];
        assert.strictEqual(finding.level, LEVEL.HIGH);
    });

    test('a read-only grant is not complained about', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, { extra: 'permissions:\n  contents: read\n' }));
        assert.deepStrictEqual(byRule(out, 'token-permissions'), []);
    });

    test('id-token: write is reported, because it mints a cloud credential', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, {
            extra: 'permissions:\n  contents: read\n  id-token: write\n'
        }));
        assert.ok(byRule(out, 'token-permissions').length > 0, JSON.stringify(out.findings));
    });
});

suite('security · supply chain', () => {
    test('an unversioned action is high', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout`));
        const finding = byRule(out, 'supply-chain')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(finding.level, LEVEL.HIGH);
    });

    test('a moving branch is high', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main`));
        assert.strictEqual(byRule(out, 'supply-chain')[0].level, LEVEL.HIGH);
    });

    test('a tag is a milder note, because a tag is a valid pin', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`));
        assert.strictEqual(byRule(out, 'supply-chain')[0].level, LEVEL.MEDIUM);
    });

    test('a full commit SHA is not reported at all', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${'a'.repeat(40)}`));
        assert.deepStrictEqual(byRule(out, 'supply-chain'), []);
    });

    test('a local action is not reported — it is versioned with the repository', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/build`));
        assert.deepStrictEqual(byRule(out, 'supply-chain'), []);
    });
});

suite('security · credentials in the file', () => {
    test('an AWS access key in a script is critical', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE`));
        const finding = byRule(out, 'hardcoded-credential')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(finding.level, LEVEL.CRITICAL);
    });

    test('the same key in env: is found', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          KEY: AKIAIOSFODNN7EXAMPLE`));
        assert.ok(byRule(out, 'hardcoded-credential').length > 0, JSON.stringify(out.findings));
    });

    test('the fix says to rotate, not just to move it', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`));
        assert.ok(/rotat/i.test(byRule(out, 'hardcoded-credential')[0].fix));
    });

    test('a secret reference is not a hardcoded credential', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: aws configure set aws_access_key_id \${{ secrets.AWS_KEY }}`));
        assert.deepStrictEqual(byRule(out, 'hardcoded-credential'), []);
    });
});

suite('security · shell hygiene', () => {
    test('a curl piped to a shell is reported', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sSL https://example.com/i.sh | bash`));
        assert.ok(byRule(out, 'script-hygiene').length > 0, JSON.stringify(out.findings));
    });

    test('a plain command is not reported', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci && npm test`));
        assert.deepStrictEqual(byRule(out, 'script-hygiene'), []);
    });
});

suite('security · findings, counts and the exit code', () => {
    test('a critical finding fails the audit', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"`));
        assert.strictEqual(out.exitCode, 1);
    });

    test('a medium finding does not fail the audit', () => {
        // A tag pin is worth knowing about and is not worth blocking on.
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`));
        assert.strictEqual(out.exitCode, 0, JSON.stringify(out.findings));
    });

    test('a clean workflow exits 0 and says there is nothing to fix', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci`, { extra: 'permissions:\n  contents: read\n' }));
        assert.strictEqual(out.exitCode, 0);
        assert.deepStrictEqual(out.findings, []);
    });

    test('the counts add up to the number of findings', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"`));
        const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
        assert.strictEqual(total, out.findings.length);
    });

    test('countByLevel counts what it is given', () => {
        const counts = countByLevel([{ level: 'high' }, { level: 'high' }, { level: 'low' }]);
        assert.strictEqual(counts.high, 2);
        assert.strictEqual(counts.low, 1);
        assert.strictEqual(counts.critical, 0);
    });

    test('no advisory identifier is invented for a finding', () => {
        // A made-up CVE or GHSA number is worse than no number: people go and
        // look it up.
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"
      - uses: actions/checkout@v4`));
        for (const finding of out.findings) {
            assert.ok(!/CVE-\d{4}-\d+/i.test(JSON.stringify(finding)), JSON.stringify(finding));
            assert.ok(!/GHSA-/i.test(JSON.stringify(finding)), JSON.stringify(finding));
        }
    });

    test('a workflow that cannot be parsed is reported, not skipped', () => {
        const out = audit('name: S\non: [push\njobs:\n  - broken\n');
        const finding = byRule(out, 'parse')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(finding.level, LEVEL.HIGH);
    });

    test('no workflows found is a warning and a pass, not a failure', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sec-empty-'));
        try {
            const out = Security.audit(dir);
            assert.strictEqual(out.exitCode, 0);
            assert.deepStrictEqual(out.findings, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('security · repeated findings', () => {
    const REPEATED = WF(`  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  c:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`);

    test('the same mistake in three jobs is reported once, with its locations', () => {
        const out = audit(REPEATED);
        const finding = byRule(out, 'supply-chain')[0];
        assert.ok(finding, JSON.stringify(out.findings));
        assert.strictEqual(out.repeats.length, 1, JSON.stringify(out.repeats));
        assert.strictEqual(out.repeats[0].count, 3);
        assert.strictEqual(out.repeats[0].locations.length, 3);
    });

    test('a finding that appears once is not listed as a repeat', () => {
        const out = audit(WF(`  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`));
        assert.deepStrictEqual(out.repeats, []);
    });

    test('the markdown report says so as well as listing every occurrence', () => {
        // The report is what gets pasted into an issue. Twenty identical blocks
        // with no summary reads as twenty problems.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroci-sec-md-'));
        const cwd = process.cwd();
        try {
            fs.writeFileSync(path.join(dir, 'ci.yml'), REPEATED);
            process.chdir(dir);
            const out = Security.audit('.', { report: true, reportPath: 'report.md' });
            const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
            assert.ok(/## Repeated findings/.test(md), md.slice(0, 400));
            assert.ok(/\*\*3×\*\*/.test(md), md.slice(0, 600));
            assert.strictEqual(out.repeats.length, 1);
        } finally {
            process.chdir(cwd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

suite('security · trigger normalisation', () => {
    test('the short and long spellings name the same trigger', () => {
        // `on: pull_request` and `on: { pull_request: … }` are the same trigger,
        // and the rules must not depend on which one the author typed.
        const short = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, { on: 'pull_request' }));
        const long = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, {
            on: '{ pull_request: { branches: [main] } }'
        }));
        assert.deepStrictEqual(byRule(short, 'trigger-context'), []);
        assert.deepStrictEqual(byRule(long, 'trigger-context'), []);
    });

    test('a list of triggers is all normalised', () => {
        const out = audit(WF(`  j:
    runs-on: ubuntu-latest
${CLEAN_STEPS}`, { on: '[push, pull_request, workflow_dispatch]' }));
        assert.strictEqual(byRule(out, 'trigger-context').length, 0);
    });
});
