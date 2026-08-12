/**
 * AeroCI Rich Reporter v2.0.0
 * Features 31-40: Multi-format reporting engine
 *
 * 31. JUnit XML Report         — aeroci-report.xml for CI integration
 * 32. Markdown Summary         — aeroci-summary.md with emoji status table
 * 33. JSON Run Report          — aeroci-run.json with full step metadata
 * 34. GitHub Annotations       — ::error file=... annotations for IDEs
 * 35. Exit Code Tracker        — record all step exit codes
 * 36. Failed Step Reproducer   — exact shell command to re-run a failed step
 * 37. Diff Reporter            — structural diff between two workflow files
 * 38. Changelog Generator      — detect workflow changes via git diff
 * 39. Coverage Reporter        — % of steps actually executed
 * 40. HTML Report Generator    — self-contained aeroci-report.html
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { Logger, colors } = require('../utils/logger');

class Reporter {
    constructor({ workflowName = 'CI', workflowFile = '' } = {}) {
        this.workflowName = workflowName;
        this.workflowFile = workflowFile;
        this.steps = []; // { jobId, stepName, durationMs, exitCode, script, uses }
        this.startTime = new Date().toISOString();
        this.endTime = null;
        this.totalSteps = 0;
    }

    // ─── Feature 35: Exit Code Tracker ───────────────────────────────────────
    recordStep(data) {
        this.steps.push({
            jobId: data.jobId,
            stepName: data.stepName || '(unnamed)',
            durationMs: data.durationMs || 0,
            exitCode: data.exitCode ?? 0,
            script: data.script || null,
            uses: data.uses || null,
            index: this.steps.length + 1
        });
    }

    finalize() {
        this.endTime = new Date().toISOString();
    }

    get passedSteps() { return this.steps.filter(s => s.exitCode === 0); }
    get failedSteps() { return this.steps.filter(s => s.exitCode !== 0); }
    get totalDurationMs() { return this.steps.reduce((s, r) => s + r.durationMs, 0); }

    // ─── Feature 31: JUnit XML Report ────────────────────────────────────────
    generateJUnit(outPath = 'aeroci-report.xml') {
        const totalMs = this.totalDurationMs;
        const failures = this.failedSteps.length;
        const tests = this.steps.length;
        const duration = (totalMs / 1000).toFixed(3);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<testsuites name="AeroCI" time="${duration}" tests="${tests}" failures="${failures}">\n`;
        xml += `  <testsuite name="${this._escape(this.workflowName)}" time="${duration}" tests="${tests}" failures="${failures}" timestamp="${this.startTime}">\n`;

        for (const step of this.steps) {
            const stepDuration = (step.durationMs / 1000).toFixed(3);
            xml += `    <testcase name="${this._escape(step.stepName)}" classname="${this._escape(step.jobId)}" time="${stepDuration}">\n`;
            if (step.exitCode !== 0) {
                xml += `      <failure message="Step exited with code ${step.exitCode}" type="StepFailure">\n`;
                xml += `        Script: ${this._escape(step.script || step.uses || 'N/A')}\n`;
                xml += `        Exit Code: ${step.exitCode}\n`;
                xml += `      </failure>\n`;
            }
            xml += `    </testcase>\n`;
        }

        xml += `  </testsuite>\n</testsuites>\n`;

        const out = path.join(process.cwd(), outPath);
        fs.writeFileSync(out, xml, 'utf8');
        Logger.success(`JUnit XML report → ${colors.cyan}${outPath}${colors.reset}`);
        return out;
    }

    _escape(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ─── Feature 32: Markdown Summary Generator ──────────────────────────────
    generateMarkdown(outPath = 'aeroci-summary.md') {
        const now = new Date().toISOString();
        const passed = this.passedSteps.length;
        const failed = this.failedSteps.length;
        const total = this.steps.length;
        const totalDur = (this.totalDurationMs / 1000).toFixed(2);
        const statusEmoji = failed === 0 ? '✅' : '❌';

        let md = `# ${statusEmoji} AeroCI Run Summary\n\n`;
        md += `> **Workflow:** \`${this.workflowName}\`  \n`;
        md += `> **File:** \`${this.workflowFile}\`  \n`;
        md += `> **Started:** ${this.startTime}  \n`;
        md += `> **Duration:** ${totalDur}s\n\n`;

        md += `## Step Results\n\n`;
        md += `| # | Job | Step | Status | Duration |\n`;
        md += `|---|-----|------|--------|----------|\n`;

        for (const step of this.steps) {
            const status = step.exitCode === 0 ? '✅ Pass' : `❌ Fail (${step.exitCode})`;
            const dur = step.durationMs >= 1000
                ? `${(step.durationMs / 1000).toFixed(2)}s`
                : `${step.durationMs}ms`;
            md += `| ${step.index} | \`${step.jobId}\` | ${step.stepName} | ${status} | ${dur} |\n`;
        }

        md += `\n## Summary\n\n`;
        md += `- **Total Steps:** ${total}\n`;
        md += `- **Passed:** ${passed} ✅\n`;
        md += `- **Failed:** ${failed} ❌\n`;
        md += `- **Total Duration:** ${totalDur}s\n\n`;

        if (failed > 0) {
            md += `## Failed Steps\n\n`;
            for (const step of this.failedSteps) {
                md += `### ❌ \`${step.jobId}\` > ${step.stepName}\n\n`;
                md += `- Exit code: \`${step.exitCode}\`\n`;
                if (step.script) md += `- Script:\n\`\`\`sh\n${step.script}\n\`\`\`\n`;
            }
        }

        md += `\n---\n*Generated by AeroCI v2.0.0*\n`;

        const out = path.join(process.cwd(), outPath);
        fs.writeFileSync(out, md, 'utf8');
        Logger.success(`Markdown summary → ${colors.cyan}${outPath}${colors.reset}`);
        return out;
    }

    // ─── Feature 33: JSON Run Report ─────────────────────────────────────────
    generateJSON(outPath = 'aeroci-run.json') {
        const report = {
            meta: {
                engine: 'AeroCI v2.0.0',
                workflow: this.workflowName,
                file: this.workflowFile,
                startTime: this.startTime,
                endTime: this.endTime,
                totalDurationMs: this.totalDurationMs,
                totalSteps: this.steps.length,
                passedSteps: this.passedSteps.length,
                failedSteps: this.failedSteps.length,
                status: this.failedSteps.length === 0 ? 'success' : 'failure'
            },
            steps: this.steps
        };

        const out = path.join(process.cwd(), outPath);
        fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
        Logger.success(`JSON run report → ${colors.cyan}${outPath}${colors.reset}`);
        return out;
    }

    // ─── Feature 34: GitHub Annotations Emitter ──────────────────────────────
    emitAnnotations() {
        for (const step of this.failedSteps) {
            const file = this.workflowFile || '.github/workflows/main.yml';
            console.log(`::error file=${file},title=Step Failed — ${step.stepName}::` +
                `Job "${step.jobId}" step "${step.stepName}" failed with exit code ${step.exitCode}`);
        }

        for (const step of this.steps) {
            if (step.durationMs > 30000) {
                console.log(`::warning title=Slow Step — ${step.stepName}::` +
                    `Step took ${(step.durationMs / 1000).toFixed(1)}s in job "${step.jobId}"`);
            }
        }
    }

    // ─── Feature 36: Failed Step Reproducer ──────────────────────────────────
    printReproducers() {
        if (this.failedSteps.length === 0) return;

        console.log(`\n${colors.bright}${colors.red}🔁 Failed Step Reproducers${colors.reset}`);
        console.log(`${colors.gray}Run these commands locally to reproduce failures:${colors.reset}\n`);

        for (const step of this.failedSteps) {
            console.log(`  ${colors.yellow}# ${step.jobId} > "${step.stepName}"${colors.reset}`);
            if (step.script) {
                console.log(`  ${colors.gray}$${colors.reset} CI=true GITHUB_ACTIONS=true bash -c '${step.script.replace(/'/g, "'\\''")}'`);
            } else if (step.uses) {
                console.log(`  ${colors.gray}# This is a GitHub Action (${step.uses}) — use 'aeroci debug' to inspect env${colors.reset}`);
            }
            console.log();
        }
    }

    // ─── Feature 37: Workflow Diff Reporter ──────────────────────────────────
    static diff(fileA, fileB) {
        const loadWorkflow = (f) => {
            const full = path.resolve(process.cwd(), f);
            if (!fs.existsSync(full)) { Logger.error(`File not found: ${f}`); return null; }
            return yaml.load(fs.readFileSync(full, 'utf8'));
        };

        const a = loadWorkflow(fileA);
        const b = loadWorkflow(fileB);
        if (!a || !b) return;

        Logger.info(`📝 Workflow Diff: ${fileA} ↔ ${fileB}\n`);

        // Compare jobs
        const jobsA = new Set(Object.keys(a.jobs || {}));
        const jobsB = new Set(Object.keys(b.jobs || {}));

        const addedJobs = [...jobsB].filter(j => !jobsA.has(j));
        const removedJobs = [...jobsA].filter(j => !jobsB.has(j));
        const commonJobs = [...jobsA].filter(j => jobsB.has(j));

        if (addedJobs.length > 0) console.log(`  ${colors.green}+ Added jobs: ${addedJobs.join(', ')}${colors.reset}`);
        if (removedJobs.length > 0) console.log(`  ${colors.red}- Removed jobs: ${removedJobs.join(', ')}${colors.reset}`);

        for (const jobId of commonJobs) {
            const stepsA = (a.jobs[jobId].steps || []).map(s => s.name || s.run || s.uses || '');
            const stepsB = (b.jobs[jobId].steps || []).map(s => s.name || s.run || s.uses || '');

            const added = stepsB.filter(s => !stepsA.includes(s));
            const removed = stepsA.filter(s => !stepsB.includes(s));

            if (added.length > 0 || removed.length > 0) {
                console.log(`\n  ${colors.bright}Job: ${jobId}${colors.reset}`);
                for (const s of added) console.log(`    ${colors.green}+ ${s.slice(0, 60)}${colors.reset}`);
                for (const s of removed) console.log(`    ${colors.red}- ${s.slice(0, 60)}${colors.reset}`);
            }
        }

        // Trigger diff
        const triggersA = JSON.stringify(a.on || {});
        const triggersB = JSON.stringify(b.on || {});
        if (triggersA !== triggersB) {
            console.log(`\n  ${colors.yellow}⚠ Trigger (on:) changed:${colors.reset}`);
            console.log(`    ${colors.red}- ${triggersA}${colors.reset}`);
            console.log(`    ${colors.green}+ ${triggersB}${colors.reset}`);
        }
    }

    // ─── Feature 38: Changelog Generator ─────────────────────────────────────
    static generateChangelog() {
        Logger.info('📋 Workflow Changelog (from git history):');

        const result = spawnSync('git', ['log', '--oneline', '--follow', '--', '.github/workflows/'], {
            cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe'
        });

        if (result.status !== 0 || !result.stdout.trim()) {
            Logger.warn('No git history found for .github/workflows/');
            return;
        }

        const lines = result.stdout.trim().split('\n').slice(0, 10);
        console.log();
        for (const line of lines) {
            const [hash, ...rest] = line.split(' ');
            console.log(`  ${colors.gray}${hash}${colors.reset}  ${rest.join(' ')}`);
        }

        // Show last diff summary
        const diffResult = spawnSync('git', ['diff', 'HEAD~1', 'HEAD', '--stat', '--', '.github/workflows/'], {
            cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe'
        });

        if (diffResult.stdout?.trim()) {
            console.log(`\n  ${colors.cyan}Last change summary:${colors.reset}`);
            diffResult.stdout.trim().split('\n').forEach(l =>
                console.log(`  ${colors.gray}${l}${colors.reset}`)
            );
        }
    }

    // ─── Feature 39: Coverage Reporter ───────────────────────────────────────
    static computeCoverage(allStepsInWorkflow, executedSteps) {
        const total = allStepsInWorkflow;
        const executed = executedSteps;
        const pct = total === 0 ? 100 : Math.min(100, Math.max(0, Math.round((executed / total) * 100)));
        const filled = Math.min(20, Math.max(0, Math.round(pct / 5)));
        const empty = Math.max(0, 20 - filled);
        const bar = '█'.repeat(filled) + '░'.repeat(empty);

        console.log(`\n${colors.bright}📈 Step Execution Coverage${colors.reset}`);
        Logger.metric('Steps Executed', `${executed}/${total}`);
        Logger.metric('Coverage', `${pct}%`);
        console.log(`  ${colors.gray}•${colors.reset} ${'Progress'.padEnd(26)}: ${colors.cyan}${bar}${colors.reset} ${pct}%`);

        if (pct < 100) {
            Logger.info(`Tip: Use matrix builds or run all jobs to achieve full step coverage.`);
        }
    }

    // ─── Feature 40: HTML Report Generator ───────────────────────────────────
    generateHTML(outPath = 'aeroci-report.html') {
        const passed = this.passedSteps.length;
        const failed = this.failedSteps.length;
        const total = this.steps.length;
        const totalDur = (this.totalDurationMs / 1000).toFixed(2);
        const statusColor = failed === 0 ? '#22c55e' : '#ef4444';
        const statusText = failed === 0 ? 'SUCCESS' : 'FAILURE';

        const stepsHTML = this.steps.map(step => {
            const status = step.exitCode === 0;
            const dur = step.durationMs >= 1000
                ? `${(step.durationMs / 1000).toFixed(2)}s`
                : `${step.durationMs}ms`;
            return `
            <tr class="${status ? 'pass' : 'fail'}">
                <td>${step.index}</td>
                <td><code>${step.jobId}</code></td>
                <td>${step.stepName}</td>
                <td class="status">${status ? '✅' : '❌'}</td>
                <td>${dur}</td>
                <td>${step.exitCode}</td>
            </tr>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AeroCI Report — ${this.workflowName}</title>
    <style>
        :root { --bg: #0f0f13; --card: #1a1a24; --border: #2a2a3a; --text: #e2e8f0; --muted: #64748b;
                --green: #22c55e; --red: #ef4444; --blue: #60a5fa; --yellow: #fbbf24; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; padding: 2rem; }
        h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
        .badge { display: inline-block; padding: 0.3rem 1rem; border-radius: 999px;
                 background: ${statusColor}22; color: ${statusColor}; font-weight: bold; font-size: 0.85rem; }
        .meta { color: var(--muted); font-size: 0.85rem; margin: 0.5rem 0 2rem; }
        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.2rem;
                text-align: center; }
        .card .num { font-size: 2rem; font-weight: bold; }
        .card .label { color: var(--muted); font-size: 0.8rem; margin-top: 0.3rem; }
        .card.green .num { color: var(--green); }
        .card.red .num { color: var(--red); }
        .card.blue .num { color: var(--blue); }
        table { width: 100%; border-collapse: collapse; background: var(--card);
                border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #252535; padding: 0.8rem 1rem; text-align: left; font-size: 0.8rem;
             text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
        td { padding: 0.75rem 1rem; border-top: 1px solid var(--border); font-size: 0.9rem; }
        tr.pass { border-left: 3px solid var(--green); }
        tr.fail { border-left: 3px solid var(--red); background: #ef444408; }
        code { background: #ffffff10; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.85em; }
        .footer { margin-top: 2rem; text-align: center; color: var(--muted); font-size: 0.8rem; }
    </style>
</head>
<body>
    <h1>AeroCI Run Report</h1>
    <span class="badge">${statusText}</span>
    <p class="meta">
        Workflow: <strong>${this.workflowName}</strong> &nbsp;|&nbsp;
        File: <code>${this.workflowFile}</code> &nbsp;|&nbsp;
        ${this.startTime}
    </p>

    <div class="cards">
        <div class="card blue"><div class="num">${total}</div><div class="label">Total Steps</div></div>
        <div class="card green"><div class="num">${passed}</div><div class="label">Passed</div></div>
        <div class="card red"><div class="num">${failed}</div><div class="label">Failed</div></div>
        <div class="card blue"><div class="num">${totalDur}s</div><div class="label">Total Duration</div></div>
    </div>

    <table>
        <thead>
            <tr><th>#</th><th>Job</th><th>Step</th><th>Status</th><th>Duration</th><th>Exit Code</th></tr>
        </thead>
        <tbody>${stepsHTML}</tbody>
    </table>

    <p class="footer">Generated by AeroCI v2.0.0 — ${new Date().toISOString()}</p>
</body>
</html>`;

        const out = path.join(process.cwd(), outPath);
        fs.writeFileSync(out, html, 'utf8');
        Logger.success(`HTML report → ${colors.cyan}${outPath}${colors.reset}`);
        return out;
    }

    // ─── Convenience: Generate All Reports ───────────────────────────────────
    generateAll({ formats = ['json', 'markdown', 'html', 'junit'] } = {}) {
        this.finalize();
        const outputs = {};
        if (formats.includes('junit'))    outputs.junit    = this.generateJUnit();
        if (formats.includes('markdown')) outputs.markdown = this.generateMarkdown();
        if (formats.includes('json'))     outputs.json     = this.generateJSON();
        if (formats.includes('html'))     outputs.html     = this.generateHTML();
        this.printReproducers();
        return outputs;
    }
}

module.exports = { Reporter };
