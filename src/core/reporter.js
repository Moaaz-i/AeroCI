/**
 * AeroCI run reporter.
 *
 * Turns a finished run into the artefacts a human or another tool needs:
 *   json        the full machine-readable result
 *   markdown    a summary you can paste into a PR
 *   html        a self-contained page, safe to open from a file:// URL
 *   junit       a JUnit XML file for any CI that already collects them
 *   annotations ::error / ::warning lines GitHub renders inline
 *   reproducers a copy-pasteable command for each failure
 *
 * Statuses come from the engine (success / failure / skipped / cancelled /
 * timed_out / not_simulated) rather than from the exit code, because a skipped
 * step has exit code 0 and must not be reported as a pass.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');
const { VERSION } = require('../version');

/** Mirrors STATUS in engine.js without importing the engine. */
const STATUS = {
    SUCCESS: 'success',
    FAILURE: 'failure',
    SKIPPED: 'skipped',
    CANCELLED: 'cancelled',
    TIMED_OUT: 'timed_out',
    NOT_SIMULATED: 'not_simulated'
};

const FAILED_STATUSES = new Set([STATUS.FAILURE, STATUS.TIMED_OUT]);

const STATUS_LABEL = {
    [STATUS.SUCCESS]: 'pass',
    [STATUS.FAILURE]: 'fail',
    [STATUS.TIMED_OUT]: 'fail',
    [STATUS.SKIPPED]: 'skip',
    [STATUS.CANCELLED]: 'skip',
    [STATUS.NOT_SIMULATED]: 'skip'
};

/** A filesystem-safe name for a workflow, so two of them cannot collide. */
function slugify(value) {
    const slug = String(value || 'ci')
        .toLowerCase()
        .replace(/\.ya?ml$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'ci';
}

class Reporter {
    constructor({ workflowName = 'CI', workflowFile = '' } = {}) {
        this.workflowName = workflowName;
        this.workflowFile = workflowFile;
        this.slug = slugify(path.basename(workflowFile) || workflowName);
        this.steps = [];
        this.startTime = new Date().toISOString();
        this.endTime = null;
    }

    recordStep(data) {
        // Derive the status only when there is a result to derive it from.
        // `data.exitCode ? … : …` treated a missing exit code as 0, so a step
        // recorded with no outcome at all was reported as a pass. It is
        // reported as not simulated instead: no evidence of success is not
        // evidence of success.
        const status = data.status
            || (typeof data.exitCode === 'number'
                ? (data.exitCode === 0 ? STATUS.SUCCESS : STATUS.FAILURE)
                : STATUS.NOT_SIMULATED);
        this.steps.push({
            jobId: data.jobId,
            stepName: data.stepName || '(unnamed)',
            id: data.stepId || null,
            status,
            durationMs: data.durationMs || 0,
            exitCode: data.exitCode ?? null,
            script: data.script || null,
            uses: data.uses || null,
            outputs: data.outputs || {},
            warnings: data.warnings || [],
            errors: data.errors || [],
            notSimulated: !!data.notSimulated,
            log: data.log || [],
            index: this.steps.length + 1
        });
    }

    finalize() {
        // Never overwrite a known end time. Re-rendering a stored report calls
        // this too, and stamping the render time as the run's end time would be
        // a lie about when the workflow finished.
        if (!this.endTime) this.endTime = new Date().toISOString();
    }

    /**
     * Rebuild a reporter from a report this class wrote earlier.
     *
     * This is what makes `aeroci report` worth running: re-render a stored run
     * as a different format instead of executing the workflow again. The stored
     * shape is the shape `generateJSON` produced, so nothing has to be invented
     * on the way back in.
     */
    static fromJSON(report) {
        const meta = (report && report.meta) || {};
        const reporter = new Reporter({
            workflowName: meta.workflow || 'CI',
            workflowFile: meta.file || ''
        });
        reporter.startTime = meta.startTime || new Date().toISOString();
        reporter.endTime = meta.endTime || null;
        for (const step of (report && report.steps) || []) {
            reporter.recordStep(step);
        }
        return reporter;
    }

    // ── derived views ────────────────────────────────────────────────────────

    get failedSteps() { return this.steps.filter((s) => FAILED_STATUSES.has(s.status)); }
    get passedSteps() { return this.steps.filter((s) => s.status === STATUS.SUCCESS); }
    get skippedSteps() {
        return this.steps.filter((s) => s.status === STATUS.SKIPPED || s.status === STATUS.CANCELLED);
    }
    get notSimulatedSteps() { return this.steps.filter((s) => s.notSimulated); }
    get totalDurationMs() { return this.steps.reduce((sum, s) => sum + s.durationMs, 0); }
    get status() { return this.failedSteps.length ? STATUS.FAILURE : STATUS.SUCCESS; }

    // ── json ─────────────────────────────────────────────────────────────────

    /** @returns {string} the report body; the caller decides where it goes. */
    generateJSON() {
        const report = {
            meta: {
                generator: `AeroCI ${VERSION}`,
                workflow: this.workflowName,
                file: this.workflowFile,
                startTime: this.startTime,
                endTime: this.endTime,
                wallClockMs: this.endTime ? Date.parse(this.endTime) - Date.parse(this.startTime) : null,
                stepTimeMs: this.totalDurationMs,
                counts: {
                    total: this.steps.length,
                    passed: this.passedSteps.length,
                    failed: this.failedSteps.length,
                    skipped: this.skippedSteps.length,
                    notSimulated: this.notSimulatedSteps.length
                },
                status: this.status
            },
            steps: this.steps
        };
        return JSON.stringify(report, null, 2);
    }

    // ── markdown ─────────────────────────────────────────────────────────────

    /** @returns {string} */
    generateMarkdown() {
        const badge = this.status === STATUS.SUCCESS ? '✅' : '❌';
        const md = [];

        md.push(`# ${badge} ${this.workflowName}`, '');
        md.push(`| | |`, `|---|---|`);
        md.push(`| file | \`${this.workflowFile}\` |`);
        md.push(`| started | ${this.startTime} |`);
        md.push(`| wall clock | ${formatDuration(this.endTime ? Date.parse(this.endTime) - Date.parse(this.startTime) : 0)} |`);
        md.push(`| steps | ${this.passedSteps.length} passed · ${this.failedSteps.length} failed · ${this.skippedSteps.length} skipped |`);
        md.push('');

        md.push('## Steps', '');
        md.push('| # | Job | Step | Status | Time |', '|---|---|---|---|---|');
        for (const step of this.steps) {
            md.push(`| ${step.index} | \`${step.jobId}\` | ${mdCell(step.stepName)} `
                + `| ${STATUS_LABEL[step.status]} | ${formatDuration(step.durationMs)} |`);
        }
        md.push('');

        if (this.notSimulatedSteps.length) {
            md.push('## Not simulated', '');
            md.push('These steps counted as a success but their real effect was not reproduced locally:',
                '');
            for (const step of this.notSimulatedSteps) {
                md.push(`- \`${step.jobId}\` > ${mdCell(step.stepName)}`
                    + `${step.uses ? ` — \`${step.uses}\`` : ''}`);
            }
            md.push('');
        }

        if (this.failedSteps.length) {
            md.push('## Failures', '');
            for (const step of this.failedSteps) {
                md.push(`### \`${step.jobId}\` > ${mdCell(step.stepName)}`, '');
                md.push(`- status: \`${step.status}\`${step.exitCode === null ? '' : `, exit code \`${step.exitCode}\``}`);
                if (step.errors.length) for (const e of step.errors) md.push(`- error: ${mdCell(e)}`);
                if (step.warnings.length) for (const w of step.warnings) md.push(`- warning: ${mdCell(w)}`);
                if (step.script) md.push('', '```bash', step.script, '```');
                md.push('');
            }
        }

        md.push('---', `Generated by AeroCI ${VERSION}.`);
        return `${md.join('\n')}\n`;
    }

    // ── junit ────────────────────────────────────────────────────────────────

    /** @returns {string} */
    generateJUnit() {
        const seconds = (ms) => (ms / 1000).toFixed(3);
        const totalSeconds = seconds(this.totalDurationMs);
        const skipped = this.skippedSteps.length;

        const lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<testsuites name="AeroCI" time="${totalSeconds}" tests="${this.steps.length}"`
            + ` failures="${this.failedSteps.length}" errors="0" skipped="${skipped}">`,
            `  <testsuite name="${xml(this.workflowName)}" time="${totalSeconds}"`
            + ` tests="${this.steps.length}" failures="${this.failedSteps.length}"`
            + ` errors="0" skipped="${skipped}" timestamp="${this.startTime}">`
        ];

        // Group by job: a JUnit suite is a test class, and the job is the class.
        const byJob = new Map();
        for (const step of this.steps) {
            if (!byJob.has(step.jobId)) byJob.set(step.jobId, []);
            byJob.get(step.jobId).push(step);
        }

        for (const [jobId, steps] of byJob) {
            const jobTime = seconds(steps.reduce((sum, s) => sum + s.durationMs, 0));
            const jobFailed = steps.filter((s) => FAILED_STATUSES.has(s.status)).length;
            const jobSkipped = steps.filter((s) => STATUS_LABEL[s.status] === 'skip').length;
            lines.push(`    <testsuite name="${xml(jobId)}" time="${jobTime}" tests="${steps.length}"`
                + ` failures="${jobFailed}" errors="0" skipped="${jobSkipped}">`);

            for (const step of steps) {
                lines.push(`      <testcase name="${xml(step.stepName)}" classname="${xml(jobId)}"`
                    + ` time="${seconds(step.durationMs)}">`);
                if (FAILED_STATUSES.has(step.status)) {
                    const detail = [
                        step.exitCode === null ? null : `exit code: ${step.exitCode}`,
                        ...step.errors,
                        ...(step.script ? [step.script] : [])
                    ].filter(Boolean).join('\n');
                    lines.push(`        <failure message="${xml(`step ${step.status}`)}"`
                        + ` type="${xml(step.status)}">${xml(detail)}</failure>`);
                } else if (STATUS_LABEL[step.status] === 'skip') {
                    lines.push(`        <skipped message="${xml(step.status)}"/>`);
                }
                if (step.log.length) {
                    lines.push(`        <system-out>${xml(step.log.map((l) => l.line).join('\n'))}</system-out>`);
                }
                lines.push('      </testcase>');
            }
            lines.push('    </testsuite>');
        }

        lines.push('  </testsuite>', '</testsuites>', '');
        return `${lines.join('\n')}\n`;
    }

    // ── html ─────────────────────────────────────────────────────────────────

    /** @returns {string} */
    generateHTML() {
        const failed = this.failedSteps.length;
        const statusColour = failed === 0 ? 'var(--green)' : 'var(--red)';

        const rows = this.steps.map((step) => {
            const label = STATUS_LABEL[step.status];
            const log = step.log.length
                ? `<details><summary>${h(step.log.length)} output line(s)</summary><pre>${h(step.log.map((l) => l.line).join('\n'))}</pre></details>`
                : '';
            const notes = [...step.errors, ...step.warnings].map((n) => `<div class="note">${h(n)}</div>`).join('');
            return `<tr class="${label}">
      <td>${step.index}</td>
      <td><code>${h(step.jobId)}</code></td>
      <td>${h(step.stepName)}${notes}${log}</td>
      <td><span class="pill ${label}">${h(step.status)}</span></td>
      <td class="num">${h(formatDuration(step.durationMs))}</td>
      <td class="num">${step.exitCode === null ? '—' : step.exitCode}</td>
    </tr>`;
        }).join('\n');

        const cards = [
            ['Total', this.steps.length, 'var(--blue)'],
            ['Passed', this.passedSteps.length, 'var(--green)'],
            ['Failed', failed, 'var(--red)'],
            ['Skipped', this.skippedSteps.length, 'var(--muted)'],
            ['Not simulated', this.notSimulatedSteps.length, 'var(--yellow)'],
            ['Step time', formatDuration(this.totalDurationMs), 'var(--blue)']
        ].map(([label, value, colour]) =>
            `<div class="card"><div class="num" style="color:${colour}">${h(String(value))}</div>`
            + `<div class="label">${h(label)}</div></div>`).join('\n');

        const notSimulated = this.notSimulatedSteps.length
            ? `<section><h2>Not simulated</h2><p>These steps are reported as a success, but AeroCI did not reproduce
                 what they really do — do not treat a green run here as proof they work on a runner.</p>
               <ul>${this.notSimulatedSteps.map((s) => `<li><code>${h(s.jobId)}</code> &rarr; ${h(s.stepName)}`
                    + `${s.uses ? ` <code>${h(s.uses)}</code>` : ''}</li>`).join('')}</ul></section>`
            : '';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AeroCI report — ${h(this.workflowName)}</title>
<style>
:root{--bg:#0f1117;--card:#171a23;--border:#262a36;--text:#e6e9ef;--muted:#8b93a7;
--green:#3fb950;--red:#f85149;--blue:#58a6ff;--yellow:#d29922}
@media (prefers-color-scheme:light){:root{--bg:#fff;--card:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;padding:2rem;max-width:1100px;margin:auto}
h1{font-size:1.6rem;margin-bottom:.3rem}
h2{font-size:1.05rem;margin:2rem 0 .6rem}
.meta{color:var(--muted);margin-bottom:1.5rem}
.meta code{background:transparent}
.badge{display:inline-block;padding:.15rem .7rem;border-radius:999px;font-weight:600;font-size:.8rem;
background:color-mix(in srgb,${failed === 0 ? 'var(--green)' : 'var(--red)'} 18%,transparent);
color:${statusColour}}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.75rem;margin:1.5rem 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center}
.card .num{font-size:1.5rem;font-weight:700}
.card .label{color:var(--muted);font-size:.75rem;margin-top:.2rem}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
th{background:color-mix(in srgb,var(--border) 45%,transparent);padding:.6rem .8rem;text-align:left;
font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
td{padding:.55rem .8rem;border-top:1px solid var(--border);vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.fail{background:color-mix(in srgb,var(--red) 9%,transparent)}
tr.skip{color:var(--muted)}
.pill{font-size:.7rem;padding:.1rem .5rem;border-radius:999px;border:1px solid var(--border)}
.pill.pass{color:var(--green)}.pill.fail{color:var(--red)}.pill.skip{color:var(--muted)}
code{background:color-mix(in srgb,var(--border) 60%,transparent);padding:.05rem .3rem;border-radius:4px;font-size:.85em}
pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.6rem;overflow-x:auto;
white-space:pre-wrap;word-break:break-word;font-size:.8rem;margin-top:.4rem}
.note{color:var(--yellow);font-size:.85em;margin-top:.2rem}
footer{margin-top:2.5rem;color:var(--muted);font-size:.8rem;text-align:center}
ul{margin-left:1.2rem}
</style>
</head>
<body>
<h1>${h(this.workflowName)}</h1>
<p class="meta"><span class="badge">${h(this.status.toUpperCase())}</span> &nbsp;
 <code>${h(this.workflowFile)}</code> &nbsp; ${h(this.startTime)}</p>
<div class="cards">
${cards}
</div>
${notSimulated}
<table>
<thead><tr><th>#</th><th>Job</th><th>Step</th><th>Status</th><th>Time</th><th>Exit</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>Generated by AeroCI ${h(VERSION)} — ${h(new Date().toISOString())}</footer>
</body>
</html>
`;
        return html;
    }

    // ── github annotations ───────────────────────────────────────────────────

    /**
     * Emit `::error` / `::warning` workflow commands. GitHub renders these as
     * inline annotations, which is the point; on a normal terminal they are
     * noise, so the caller decides.
     */
    emitAnnotations({ slowStepMs = 30000 } = {}) {
        const file = this.workflowFile || '.github/workflows/ci.yml';
        for (const step of this.steps) {
            const title = encode(step.stepName);
            if (FAILED_STATUSES.has(step.status)) {
                const message = step.errors[0]
                    || `job "${step.jobId}" step "${step.stepName}" failed`
                        + (step.exitCode === null ? '' : ` with exit code ${step.exitCode}`);
                Logger.emit(`::error file=${file},title=${title}::${encode(message)}`);
            } else if (step.durationMs > slowStepMs) {
                Logger.emit(`::warning file=${file},title=${title}::`
                    + `${encode(`took ${(step.durationMs / 1000).toFixed(1)}s`)}`);
            }
        }
        for (const step of this.notSimulatedSteps) {
            Logger.emit(`::warning file=${file},title=${encode(step.stepName)}::`
                + `${encode(`not simulated locally${step.uses ? ` (${step.uses})` : ''}`)}`);
        }
    }

    // ── reproducers ──────────────────────────────────────────────────────────

    /**
     * A runnable command per failure. Two steps with the same script are the
     * same reproducer, so they are printed once — repeating a multi-line script
     * three times helps nobody.
     */
    printReproducers({ sandbox = null } = {}) {
        if (this.failedSteps.length === 0) return [];

        const byScript = new Map();
        for (const step of this.failedSteps) {
            if (!step.script) continue;
            if (!byScript.has(step.script)) byScript.set(step.script, []);
            byScript.get(step.script).push(step);
        }

        if (byScript.size === 0) {
            const actionSteps = this.failedSteps.filter((s) => s.uses);
            if (actionSteps.length) {
                Logger.note('The failures came from actions, not from scripts:');
                for (const step of actionSteps) {
                    Logger.note(`  ${colors.gray('•')} ${step.jobId} > ${step.stepName} ${colors.gray(`— ${step.uses}`)}`);
                }
                Logger.note('  Re-run with --debug to see the environment the action was given.');
            }
            return [];
        }

        Logger.emit(`\n${colors.bright}${colors.red}Reproduce a failure${colors.reset}`);
        Logger.emit(colors.gray('Each command runs the failing step in the same shell AeroCI used:') + '\n');

        const commands = [];
        let index = 0;
        for (const [script, steps] of byScript) {
            index++;
            const first = steps[0];
            const where = steps.length === 1
                ? `${first.jobId} > "${first.stepName}"`
                : `${steps.map((s) => s.jobId).join(', ')} (${steps.length} steps)`;

            Logger.emit(`  ${colors.yellow(`# ${index}`)} ${colors.gray(where)}`);
            if (sandbox) Logger.emit(`  ${colors.gray(`# sandbox: ${sandbox}`)}`);
            Logger.emit(shellBlock(script));
            Logger.emit('');
            commands.push({ locations: steps.map((s) => `${s.jobId}/${s.stepName}`), script });
        }
        return commands;
    }

    // ── all formats ──────────────────────────────────────────────────────────

    /**
     * Write every requested format for this workflow.
     *
     * `dir` is required, because two workflows in one run must not land on the
     * same file: the second would silently replace the first. The caller owns
     * the naming, the reporter only fills in the per-workflow slug.
     */
    generateAll({ formats = ['json', 'markdown', 'html', 'junit'], dir = null } = {}) {
        this.finalize();
        if (!dir) {
            Logger.warn('generateAll needs an output directory — nothing was written.');
            return {};
        }
        fs.mkdirSync(dir, { recursive: true });
        const outputs = {};
        const emit = (name, content, label) => {
            const file = path.join(dir, `${this.slug}.${name}`);
            write(file, content, label);
            outputs[name === 'md' ? 'markdown' : name === 'xml' ? 'junit' : name] = file;
        };
        if (formats.includes('json')) emit('json', this.generateJSON(), 'JSON run report');
        if (formats.includes('markdown')) emit('md', this.generateMarkdown(), 'Markdown summary');
        if (formats.includes('html')) emit('html', this.generateHTML(), 'HTML report');
        if (formats.includes('junit')) emit('xml', this.generateJUnit(), 'JUnit XML report');
        return outputs;
    }

    // ── static helpers ───────────────────────────────────────────────────────

    /** Structural difference between two workflow files. */
    static diff(fileA, fileB) {
        const load = (label) => {
            const full = path.resolve(process.cwd(), label);
            if (!fs.existsSync(full)) {
                Logger.error(`No such file: ${label}`);
                return null;
            }
            try {
                return yaml.load(fs.readFileSync(full, 'utf8'), { filename: full });
            } catch (err) {
                Logger.error(`${label}: ${err.message.split('\n')[0]}`);
                return null;
            }
        };

        const a = load(fileA);
        const b = load(fileB);
        if (!a || !b) return { changes: 0 };

        Logger.info(`Workflow diff ${colors.gray('·')} ${fileA} ${colors.gray('→')} ${fileB}\n`);

        const changes = [];
        const report = (kind, what) => {
            changes.push({ kind, what });
            const tag = kind === 'added' ? colors.green('+') : kind === 'removed' ? colors.red('-') : colors.yellow('~');
            Logger.emit(`  ${tag} ${what}`);
        };

        const triggersA = stableTriggers(a.on);
        const triggersB = stableTriggers(b.on);
        for (const t of triggersB.filter((t) => !triggersA.includes(t))) report('added', `trigger \`${t}\``);
        for (const t of triggersA.filter((t) => !triggersB.includes(t))) report('removed', `trigger \`${t}\``);

        const jobsA = new Set(Object.keys(a.jobs || {}));
        const jobsB = new Set(Object.keys(b.jobs || {}));

        for (const id of [...jobsB].filter((j) => !jobsA.has(j)).sort()) {
            const steps = (b.jobs[id].steps || []).length;
            report('added', `job \`${id}\` (${steps} step(s))`);
        }
        for (const id of [...jobsA].filter((j) => !jobsB.has(j)).sort()) {
            report('removed', `job \`${id}\``);
        }

        for (const id of [...jobsA].filter((j) => jobsB.has(j)).sort()) {
            const jobA = a.jobs[id] || {};
            const jobB = b.jobs[id] || {};

            if (JSON.stringify(jobA.needs || null) !== JSON.stringify(jobB.needs || null)) {
                report('changed', `job \`${id}\` needs: ${JSON.stringify(jobA.needs || null)} → ${JSON.stringify(jobB.needs || null)}`);
            }
            if (JSON.stringify(jobA['runs-on'] || null) !== JSON.stringify(jobB['runs-on'] || null)) {
                report('changed', `job \`${id}\` runs-on: ${JSON.stringify(jobA['runs-on'])} → ${JSON.stringify(jobB['runs-on'])}`);
            }
            if (JSON.stringify(jobA.strategy || null) !== JSON.stringify(jobB.strategy || null)) {
                report('changed', `job \`${id}\` strategy: ${JSON.stringify(jobA.strategy || null)} → ${JSON.stringify(jobB.strategy || null)}`);
            }
            if (JSON.stringify(jobA.permissions || null) !== JSON.stringify(jobB.permissions || null)) {
                report('changed', `job \`${id}\` permissions: ${JSON.stringify(jobA.permissions || null)} → ${JSON.stringify(jobB.permissions || null)}`);
            }

            const stepsA = (jobA.steps || []).map(describeStep);
            const stepsB = (jobB.steps || []).map(describeStep);
            for (const step of stepsB.filter((s) => !stepsA.includes(s))) report('added', `job \`${id}\` step ${step}`);
            for (const step of stepsA.filter((s) => !stepsB.includes(s))) report('removed', `job \`${id}\` step ${step}`);
        }

        if (changes.length === 0) {
            Logger.success('The two workflows are structurally identical.');
        } else {
            Logger.emit('');
            Logger.metric('Changes', String(changes.length));
        }
        return { changes: changes.length, details: changes };
    }

    /** Recent commits that touched the workflow directory. */
    static workflowHistory(dir = '.github/workflows', limit = 10) {
        const res = spawnSync('git', ['log', `--max-count=${limit}`, '--format=%h%x09%ad%x09%s', '--date=short', '--', dir], {
            encoding: 'utf8', timeout: 10000, stdio: 'pipe'
        });
        if (res.error || res.status !== 0) {
            return { ok: false, reason: res.error ? res.error.message : 'not a git repository', commits: [] };
        }
        const commits = res.stdout.split('\n').filter(Boolean).map((line) => {
            const [hash, date, ...subject] = line.split('\t');
            return { hash, date, subject: subject.join('\t') };
        });
        return { ok: true, commits };
    }

    /**
     * How much of the workflow actually ran.
     *
     * `expected` is the engine's own plan, with matrix combinations already
     * multiplied out — comparing against the raw YAML step count would report
     * more than 100% for any workflow that uses a matrix.
     *
     * `skipped` are the steps that were planned but not reached. They are split
     * by *why*, because "a step was skipped by its own `if:`" and "a step after
     * a failure never ran" are completely different things to a reader.
     */
    static printCoverage({ expected, executed, declared, skipped = [], combinations = 0, notSimulated = 0 }) {
        if (!expected) return;
        const pct = Math.max(0, Math.min(100, Math.round((executed / expected) * 100)));
        const filled = Math.round((pct / 100) * 24);
        const bar = '█'.repeat(filled) + '░'.repeat(24 - filled);

        Logger.emit('');
        Logger.metric('Step coverage', `${executed}/${expected} executed ${colors.gray(`(${pct}%)`)}`
            + (combinations ? colors.gray(` — ${declared} declared, ${combinations} matrix combination(s)`) : ''));
        Logger.emit(`  ${bar} ${colors.gray(`${pct}%`)}`);

        if (skipped.length) {
            const byGuard = skipped.filter((s) => /^if:/.test(s.reason || ''));
            const rest = skipped.filter((s) => !/^if:/.test(s.reason || ''));
            if (byGuard.length) {
                Logger.note(`${byGuard.length} step(s) skipped by their own \`if:\` — normal, that is what the guard is for.`);
            }
            if (rest.length) {
                Logger.warn(`${rest.length} step(s) were never reached: `
                    + rest.map((s) => `${s.jobId}/${s.name} (${s.reason || 'unknown'})`).join(', '));
                Logger.note('  Add `if: always()` to run them even when an earlier step failed.');
            }
        }
        if (notSimulated) {
            Logger.metric('Not simulated', colors.yellow(`${notSimulated} step(s) — a pass here is not a proof`));
        }
    }
}

// ── formatting helpers ──────────────────────────────────────────────────────

/** Escape for XML text and attribute values. */
function xml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        // Control characters are not representable in XML 1.0 at all.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Escape for HTML text and attribute values. */
function h(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escape a value for a GitHub workflow command property. */
function encode(value) {
    return String(value ?? '')
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A')
        .replace(/:/g, '%3A')
        .replace(/,/g, '%2C');
}

/** Keep a markdown table cell on one line without breaking the table. */
function mdCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function write(outPath, content, label) {
    const out = path.resolve(process.cwd(), outPath);
    fs.writeFileSync(out, content, 'utf8');
    Logger.success(`${label} → ${colors.cyan(path.relative(process.cwd(), out) || outPath)}${colors.reset}`);
    return out;
}

/**
 * A copy-pasteable command that runs the step in the same shell AeroCI used.
 * The heredoc is the copyable form; the single-line form is shown collapsed
 * because that is what belongs in an issue or a script.
 */
function shellBlock(script) {
    const oneLine = script.replace(/\s*\\\s*\n\s*/g, ' ')
        .replace(/\n/g, '; ')
        .replace(/'/g, `'\\''`)
        .replace(/; *$/, '')
        .trim();
    return `  ${colors.gray('$')} bash --noprofile --norc -eo pipefail <<'AEROCI_REPRO'\n`
        + script.split('\n').map((l) => `  ${l}`).join('\n')
        + `\n  AEROCI_REPRO\n`
        + colors.gray(`  # or: bash --noprofile --norc -eo pipefail -c '${oneLine}'`);
}

function describeStep(step) {
    if (step.name) return step.name;
    if (step.uses) return step.uses;
    if (typeof step.run === 'string') return `run: ${step.run.trim().split('\n')[0].slice(0, 60)}`;
    return '(empty step)';
}

function stableTriggers(on) {
    if (!on) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String).sort();
    if (typeof on === 'object') return Object.keys(on).sort();
    return [];
}

module.exports = { Reporter, STATUS, FAILED_STATUSES, escapeXml: xml, escapeHtml: h };
