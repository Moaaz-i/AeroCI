/**
 * AeroCI profiler.
 *
 * Everything printed here is measured. Where a number cannot be measured — the
 * wall-clock a GitHub-hosted runner would take, the bytes a step downloads — it
 * is either left out or shown as an explicitly-labelled projection together with
 * the formula that produced it.
 *
 * What is measured:
 *   per-step and per-job durations
 *   the process's own peak heap during the run
 *   run history, so a regression against your own previous runs is visible
 *
 * What is deliberately not claimed: a "speedup factor" or "money saved". A local
 * run is not the same work a hosted runner does, so comparing the two and calling
 * the difference a saving would be a made-up number.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger, colors } = require('../utils/logger');
const { VERSION } = require('../version');

/**
 * GitHub-hosted runner list prices, USD per minute. macOS/Windows runners cost
 * more than the Linux rate and are billed per-minute for private repos.
 * Source: github.com/billing — update when the price changes.
 */
const PRICE_PER_MIN = {
    linux: 0.008,
    windows: 0.016,
    macos: 0.08
};

const BILLING_MINUTE_MS = 60000;

const STATUS = { SUCCESS: 'success', FAILURE: 'failure', SKIPPED: 'skipped', CANCELLED: 'cancelled', TIMED_OUT: 'timed_out' };

class Profiler {
    constructor(workflowName, { historyDir } = {}) {
        this.workflowName = workflowName;
        this.historyDir = historyDir || path.join(process.cwd(), '.aeroci-artifacts');
        this.historyFile = path.join(this.historyDir, 'history.jsonl');
        this.runs = [];
        this.jobs = new Map();
        this._memInterval = null;
        this._baselineHeapMB = process.memoryUsage().heapUsed / (1024 * 1024);
        this._peakHeapMB = this._baselineHeapMB;
    }

    // ── measurement ──────────────────────────────────────────────────────────

    /**
     * Sample the heap while the run is in progress. `unref()` matters: an
     * interval that is still armed when the run ends would keep the process
     * alive forever.
     */
    startMemoryTracking(intervalMs = 250) {
        if (this._memInterval) return;
        this._memInterval = setInterval(() => {
            const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
            if (heapMB > this._peakHeapMB) this._peakHeapMB = heapMB;
        }, intervalMs);
        if (typeof this._memInterval.unref === 'function') this._memInterval.unref();
    }

    stopMemoryTracking() {
        if (!this._memInterval) return;
        clearInterval(this._memInterval);
        this._memInterval = null;
        const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
        if (heapMB > this._peakHeapMB) this._peakHeapMB = heapMB;
    }

    get peakMemoryMB() { return this._peakHeapMB; }
    get heapGrowthMB() { return this._peakHeapMB - this._baselineHeapMB; }

    recordStep(jobId, stepName, durationMs, exitCode = 0, meta = {}) {
        this.runs.push({
            jobId,
            stepName: stepName || '(unnamed)',
            durationMs: Math.max(0, durationMs || 0),
            exitCode: exitCode ?? null,
            status: meta.status || (exitCode ? STATUS.FAILURE : STATUS.SUCCESS)
        });
    }

    startJob(jobId) {
        this.jobs.set(jobId, { jobId, startedAt: Date.now(), durationMs: 0, steps: 0 });
    }

    endJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return 0;
        job.durationMs = Date.now() - job.startedAt;
        return job.durationMs;
    }

    get slowestStep() {
        let slowest = null;
        for (const run of this.runs) {
            if (run.status === STATUS.SKIPPED) continue;
            if (!slowest || run.durationMs > slowest.durationMs) slowest = run;
        }
        return slowest;
    }

    /** Sum of the step durations, per job. Not wall clock — steps are serial within a job. */
    get measuredStepTimeMs() {
        return this.runs.reduce((sum, r) => sum + r.durationMs, 0);
    }

    // ── output ───────────────────────────────────────────────────────────────

    printTimingTable({ top = 10 } = {}) {
        const measured = this.runs.filter((r) => r.status !== STATUS.SKIPPED);
        if (measured.length === 0) return;

        const sorted = [...measured].sort((a, b) => b.durationMs - a.durationMs);
        const max = sorted[0].durationMs;
        const shown = sorted.slice(0, top);

        console.log(`\n${colors.bright}${colors.cyan}⏱  Slowest steps${colors.reset}`);
        Logger.table(
            ['Job', 'Step', 'Time', 'Share', ''],
            shown.map((run) => {
                const share = max ? Math.round((run.durationMs / max) * 100) : 0;
                const bar = max ? '█'.repeat(Math.max(1, Math.round((run.durationMs / max) * 10))) : '';
                return [
                    run.jobId,
                    run.stepName,
                    formatDuration(run.durationMs),
                    `${share}%`,
                    colors.cyan(bar)
                ];
            })
        );

        if (measured.length > top) {
            Logger.note(`${measured.length - top} faster step(s) not shown; total measured step time `
                + `${formatDuration(this.measuredStepTimeMs)}.`);
        }
    }

    /**
     * What this run would cost on a GitHub-hosted runner.
     *
     * The formula is stated because it is a projection, not a measurement:
     *   billable = sum over jobs of ceil(job step time / 1 minute) × price
     * GitHub rounds each job up to a whole minute, so a 4-second job bills as
     * one minute. The number is only as good as the assumption that your hosted
     * runner would spend the same time in these steps as this machine did —
     * hosted runners are typically slower, so treat it as a floor.
     */
    printBillingProjection({ runner = 'ubuntu-latest' } = {}) {
        const byJob = new Map();
        for (const run of this.runs) {
            if (run.status === STATUS.SKIPPED) continue;
            byJob.set(run.jobId, (byJob.get(run.jobId) || 0) + run.durationMs);
        }
        if (byJob.size === 0) return;

        const kind = /macos/i.test(runner) ? 'macos' : /windows/i.test(runner) ? 'windows' : 'linux';
        const price = PRICE_PER_MIN[kind];

        const rows = [...byJob.entries()].map(([jobId, ms]) => {
            const minutes = Math.max(1, Math.ceil(ms / BILLING_MINUTE_MS));
            return { jobId, ms, minutes, cost: minutes * price };
        });
        const totalMs = rows.reduce((s, r) => s + r.ms, 0);
        const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
        const totalCost = rows.reduce((s, r) => s + r.cost, 0);

        console.log(`\n${colors.bright}💵 Cost on a GitHub-hosted ${runner}${colors.reset}`);
        Logger.metric('Measured step time', formatDuration(totalMs));
        Logger.metric('Billable minutes', `${totalMinutes} ${colors.gray(`(each job rounds up to 1 minute · $${price}/min)`)}`);
        Logger.metric('Projected cost', `$${totalCost.toFixed(3)}`);
        console.log(colors.gray(`     This is a projection from the durations measured above, not a measurement of a `));
        console.log(colors.gray(`     hosted run. Real time is usually higher, so treat it as a lower bound.`));
        void rows;
    }

    printTrendReport() {
        const trend = Profiler.trends(this.workflowName, { historyFile: this.historyFile });
        if (!trend) return;

        console.log(`\n${colors.bright}${colors.magenta}📊 Compared with your last ${trend.baseline.runs} run(s)${colors.reset}`);
        Logger.metric('This run', formatDuration(trend.latest));
        Logger.metric('Average before', `${formatDuration(trend.baseline.average)} ${colors.gray('(median ' + formatDuration(trend.baseline.median) + ')')}`);
        const delta = trend.latest - trend.baseline.median;
        // The word carries the direction and the number carries the size. It
        // used to be the other way round, so a run 2ms under the median printed
        // "2ms (-4%) faster" — a minus sign in front of the word that already
        // says which way it moved.
        const pct = trend.baseline.median > 0
            ? ` (${Math.round((Math.abs(delta) / trend.baseline.median) * 100)}%)`
            : '';
        const word = delta > 0 ? colors.yellow('slower') : delta < 0 ? colors.green('faster') : '';
        Logger.metric('Change vs median', `${formatDuration(Math.abs(delta))}${pct} ${word}`.trim());

        const times = trend.history.map((h) => h.totalMs);
        const max = Math.max(...times);
        const spark = times.map((t) => {
            const ratio = t / max;
            if (ratio < 0.3) return '▁';
            if (ratio < 0.55) return '▃';
            if (ratio < 0.8) return '▅';
            return '▇';
        }).join('');
        console.log(`  ${colors.cyan(spark)} ${colors.gray(`${trend.history.length} most recent runs`)}`);
    }

    // ── observations (not a score) ───────────────────────────────────────────

    /**
     * Concrete things worth knowing about the pipeline, each derived from the
     * workflow or from this run. Deliberately not a 0-100 number: a score would
     * hide which of these actually matter for a given repository.
     */
    static observations(doc, runs = []) {
        const notes = [];
        const jobs = doc.jobs || {};
        const allSteps = Object.values(jobs).flatMap((job) => (Array.isArray(job.steps) ? job.steps : []));

        const jobIds = Object.keys(jobs);
        const serialChain = longestChain(jobs);
        if (jobIds.length > 1 && serialChain === jobIds.length) {
            notes.push({
                level: 'warn',
                text: `every job is on one dependency chain (${serialChain} deep), so none of them overlap — `
                    + 'if they do not actually depend on each other\'s output, drop the `needs:`'
            });
        }

        const installs = allSteps.filter((step) => step.run && /\b(npm|yarn|pnpm)\s+(ci|install)\b/.test(String(step.run)));
        const caches = allSteps.filter((step) => typeof step.uses === 'string' && /actions\/cache/.test(step.uses));
        if (installs.length && !caches.length) {
            notes.push({
                level: 'warn',
                text: `${installs.length} step(s) run a package install and no step uses actions/cache — `
                    + 'every run re-downloads the same dependencies'
            });
        }

        if (!Object.values(jobs).some((job) => job && job['timeout-minutes'])) {
            notes.push({
                level: 'info',
                text: 'no job sets `timeout-minutes`, so a hung step waits for the 6-hour platform limit'
            });
        }

        const slow = runs.filter((r) => r.durationMs > 30000 && r.status !== STATUS.SKIPPED);
        if (slow.length) {
            notes.push({
                level: 'info',
                text: `${slow.length} measured step(s) took over 30s: ${slow.slice(0, 3).map((r) => r.stepName).join(', ')}`
            });
        }

        const withoutIf = allSteps.filter((step) => step && !step.if
            && (step.uses || step.run) && /test|lint|check/.test(String(step.name || step.uses || '')).length);
        if (withoutIf > 0) {
            notes.push({
                level: 'info',
                text: `${withoutIf} step(s) that look like tests or checks have no \`if:\` guard, so a failing `
                    + 'earlier step leaves them unreachable — add \`if: always()\` or \`if: failure()\` if you want them to run anyway'
            });
        }

        return notes;
    }

    static printObservations(notes) {
        if (!notes || notes.length === 0) return;
        console.log(`\n${colors.bright}${colors.cyan}🔎 Worth knowing${colors.reset}`);
        for (const note of notes) {
            const tag = note.level === 'warn' ? colors.yellow('!') : colors.gray('·');
            console.log(`  ${tag} ${note.text}`);
        }
    }

    // ── history ──────────────────────────────────────────────────────────────

    saveToHistory() {
        try {
            fs.mkdirSync(this.historyDir, { recursive: true });
            const entry = {
                timestamp: new Date().toISOString(),
                generator: `AeroCI ${VERSION}`,
                host: `${os.platform()}-${os.arch()} node ${process.versions.node}`,
                workflow: this.workflowName,
                totalMs: this.measuredStepTimeMs,
                wallClockMs: this.measuredStepTimeMs,
                peakMemoryMB: Number(this.peakMemoryMB.toFixed(1)),
                passed: this.runs.filter((r) => r.status === STATUS.SUCCESS).length,
                failed: this.runs.filter((r) => r.status === STATUS.FAILURE || r.status === STATUS.TIMED_OUT).length,
                skipped: this.runs.filter((r) => r.status === STATUS.SKIPPED || r.status === STATUS.CANCELLED).length,
                steps: this.runs
            };
            fs.appendFileSync(this.historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
            return true;
        } catch (err) {
            Logger.warn(`Could not record history: ${err.message}`);
            return false;
        }
    }

    /**
     * Compare the newest run against the ones before it.
     *
     * The median is the baseline rather than the mean: one slow run (a cold
     * `npm ci`, a busy laptop) would otherwise drag the average and hide a
     * regression. The newest entry is excluded from its own baseline.
     */
    static trends(workflowName, { historyFile, limit = 12 } = {}) {
        const file = historyFile || path.join(process.cwd(), '.aeroci-artifacts', 'history.jsonl');
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (_) {
            return null;
        }

        const entries = raw.split('\n').filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
            .filter((e) => e && e.workflow === workflowName && typeof e.totalMs === 'number');

        if (entries.length < 2) return null;

        const latest = entries[entries.length - 1];
        const previous = entries.slice(0, -1).slice(-limit);
        const times = previous.map((e) => e.totalMs).sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        const average = times.reduce((a, b) => a + b, 0) / times.length;

        return {
            latest: latest.totalMs,
            baseline: { runs: times.length, median, average },
            history: entries.slice(-limit).map((e) => ({ totalMs: e.totalMs, timestamp: e.timestamp }))
        };
    }

    static showHistory({ historyFile, limit = 20 } = {}) {
        const file = historyFile || path.join(process.cwd(), '.aeroci-artifacts', 'history.jsonl');
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (_) {
            Logger.warn('No run history yet — run `aeroci run` to record one.');
            return [];
        }

        const entries = raw.split('\n').filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
            .filter(Boolean)
            .slice(-limit);

        if (entries.length === 0) {
            Logger.warn('Run history is empty.');
            return [];
        }

        Logger.info(`Run history — last ${entries.length} of ${raw.split('\n').filter(Boolean).length}\n`);
        Logger.table(
            ['When', 'Workflow', 'Step time', 'Pass', 'Fail', 'Heap'],
            entries.map((e) => [
                new Date(e.timestamp).toLocaleString(),
                e.workflow || 'unknown',
                formatDuration(e.totalMs || 0),
                String(e.passed ?? '—'),
                String(e.failed ?? '—'),
                e.peakMemoryMB ? `${e.peakMemoryMB}MB` : '—'
            ])
        );
        return entries;
    }

    /** One place that prints everything the profiler has. */
    printAll({ doc = {}, runner = 'ubuntu-latest' } = {}) {
        this.printTimingTable();
        this.printBillingProjection({ runner });
        this.printTrendReport();
        Profiler.printObservations(Profiler.observations(doc, this.runs));
        Logger.metric('Peak heap', `${this.peakMemoryMB.toFixed(1)}MB ${colors.gray(`(+${Math.max(0, this.heapGrowthMB).toFixed(1)}MB during the run)`)}`);
    }
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < BILLING_MINUTE_MS) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / BILLING_MINUTE_MS)}m ${Math.round((ms % BILLING_MINUTE_MS) / 1000)}s`;
}

/** Depth of the longest `needs:` chain — the number of jobs that must run in order. */
function longestChain(jobs) {
    const ids = Object.keys(jobs);
    const needsOf = (id) => {
        const value = jobs[id] && jobs[id].needs;
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    };
    const depth = new Map();
    const visit = (id, seen) => {
        if (depth.has(id)) return depth.get(id);
        if (seen.has(id)) return 0;
        seen.add(id);
        const parents = needsOf(id).filter((p) => jobs[p]);
        const value = parents.length ? Math.max(...parents.map((p) => visit(p, seen))) + 1 : 1;
        depth.set(id, value);
        return value;
    };
    for (const id of ids) visit(id, new Set());
    return depth.size ? Math.max(...depth.values()) : 0;
}

module.exports = { Profiler, PRICE_PER_MIN, formatDuration };
