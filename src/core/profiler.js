/**
 * AeroCI Performance Profiler v2.0.0
 * Features 11-20: Timing, cost estimation, run history & trend analysis
 *
 * 11. Per-Step Timing Table       — rich table of ms per step after run
 * 12. Slowest Step Highlighter    — highlight the worst offender
 * 13. CI Cost Estimator           — GitHub Actions billable minutes saved
 * 14. Run History Logger          — .aeroci-artifacts/history.jsonl
 * 15. Trend Analyzer              — compare vs last 5 runs, detect regressions
 * 16. Parallel vs Sequential      — show which jobs could run in parallel
 * 17. Cache Hit Simulator         — actions/cache key matching simulation
 * 18. Network I/O Estimator       — estimated MB downloaded per step
 * 19. Memory Usage Tracker        — Node.js heap during simulation
 * 20. Pipeline Efficiency Score   — 0-100 score (parallelism + caching + speed)
 */

const fs = require('fs');
const path = require('path');
const { Logger, colors } = require('../utils/logger');

const HISTORY_DIR = path.join(process.cwd(), '.aeroci-artifacts');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.jsonl');

// GitHub Actions pricing: $0.008/min (ubuntu-latest)
const GITHUB_COST_PER_MIN = 0.008;

class Profiler {
    constructor(workflowName) {
        this.workflowName = workflowName;
        this.runs = []; // { jobId, stepName, durationMs, exitCode }
        this.jobStartTimes = {};
        this.memorySnapshots = [];
        this._memInterval = null;
        this.cacheStore = this._loadCacheStore();
    }

    // ─── Feature 19: Memory Tracker ──────────────────────────────────────────
    startMemoryTracking() {
        this._memInterval = setInterval(() => {
            const mem = process.memoryUsage();
            this.memorySnapshots.push({
                time: Date.now(),
                heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
                rssMB: (mem.rss / 1024 / 1024).toFixed(2)
            });
        }, 500);
    }

    stopMemoryTracking() {
        if (this._memInterval) clearInterval(this._memInterval);
    }

    get peakMemoryMB() {
        if (this.memorySnapshots.length === 0) return 0;
        return Math.max(...this.memorySnapshots.map(s => parseFloat(s.heapUsedMB)));
    }

    // ─── Step Recording ───────────────────────────────────────────────────────
    recordStep(jobId, stepName, durationMs, exitCode = 0, stepMeta = {}) {
        this.runs.push({ jobId, stepName, durationMs, exitCode, ...stepMeta });
    }

    startJob(jobId) {
        this.jobStartTimes[jobId] = Date.now();
    }

    endJob(jobId) {
        const elapsed = Date.now() - (this.jobStartTimes[jobId] || Date.now());
        return elapsed;
    }

    // ─── Feature 11: Per-Step Timing Table ───────────────────────────────────
    printTimingTable() {
        if (this.runs.length === 0) return;

        const maxDuration = Math.max(...this.runs.map(r => r.durationMs));
        const rows = this.runs.map(r => {
            const bar = this._miniBar(r.durationMs, maxDuration, 12);
            const status = r.exitCode === 0 ? `${colors.green}✔${colors.reset}` : `${colors.red}✖${colors.reset}`;
            const durationStr = r.durationMs >= 1000
                ? `${(r.durationMs / 1000).toFixed(2)}s`
                : `${r.durationMs}ms`;
            const isSlowest = r.durationMs === maxDuration && maxDuration > 100;
            const stepLabel = isSlowest
                ? `${colors.yellow}${colors.bright}${r.stepName} ◀ slowest${colors.reset}`
                : r.stepName;
            return [status, r.jobId, stepLabel, durationStr, bar];
        });

        console.log(`\n${colors.bright}${colors.cyan}⏱  Per-Step Timing Breakdown${colors.reset}`);
        Logger.table(['', 'Job', 'Step', 'Duration', 'Relative'], rows);
    }

    _miniBar(value, max, width) {
        if (max === 0) return '';
        const filled = Math.round((value / max) * width);
        return colors.cyan + '█'.repeat(filled) + colors.gray + '░'.repeat(width - filled) + colors.reset;
    }

    // ─── Feature 12: Slowest Step Highlighter ────────────────────────────────
    getSlowestStep() {
        if (this.runs.length === 0) return null;
        return this.runs.reduce((a, b) => a.durationMs > b.durationMs ? a : b);
    }

    // ─── Feature 13: CI Cost Estimator ───────────────────────────────────────
    computeCostSaving() {
        const totalMs = this.runs.reduce((sum, r) => sum + r.durationMs, 0);
        const localMs = totalMs;
        // GitHub Actions has 1-min rounding + overhead (~30s setup per job)
        const jobCount = new Set(this.runs.map(r => r.jobId)).size;
        const githubOverheadMs = jobCount * 30000; // 30s setup per job
        const githubMs = totalMs + githubOverheadMs;

        const githubMins = githubMs / 60000;
        const costSavedUSD = githubMins * GITHUB_COST_PER_MIN;

        return {
            localMs,
            githubMs,
            timeSavedMs: githubMs - localMs,
            githubMins: githubMins.toFixed(2),
            costSavedUSD: costSavedUSD.toFixed(4),
            speedupFactor: (githubMs / Math.max(localMs, 1)).toFixed(1)
        };
    }

    printCostReport() {
        const cost = this.computeCostSaving();
        console.log(`\n${colors.bright}${colors.green}💰 CI Cost & Time Savings${colors.reset}`);
        Logger.metric('Local Execution Time',  `${(cost.localMs / 1000).toFixed(2)}s`);
        Logger.metric('Est. GitHub Actions Time', `${(cost.githubMs / 1000).toFixed(2)}s (incl. runner setup)`);
        Logger.metric('Time Saved',            `${(cost.timeSavedMs / 1000).toFixed(2)}s (${cost.speedupFactor}x faster)`);
        Logger.metric('Est. Billable Minutes', `${cost.githubMins} min`);
        Logger.metric('Est. Cost Saved',       `$${cost.costSavedUSD} USD`);
    }

    // ─── Feature 14: Run History Logger ──────────────────────────────────────
    saveToHistory() {
        try {
            if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
            const entry = {
                timestamp: new Date().toISOString(),
                workflow: this.workflowName,
                steps: this.runs,
                totalMs: this.runs.reduce((s, r) => s + r.durationMs, 0),
                peakMemoryMB: this.peakMemoryMB,
                passedSteps: this.runs.filter(r => r.exitCode === 0).length,
                failedSteps: this.runs.filter(r => r.exitCode !== 0).length,
            };
            fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
        } catch (_) {}
    }

    // ─── Feature 15: Trend Analyzer ──────────────────────────────────────────
    static analyzeTrends(workflowName) {
        if (!fs.existsSync(HISTORY_FILE)) return null;

        try {
            const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
            const relevant = lines
                .map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(e => e && e.workflow === workflowName)
                .slice(-6); // last 6 runs

            if (relevant.length < 2) return null;

            const latest = relevant[relevant.length - 1];
            const previous = relevant.slice(0, -1);
            const avgPrev = previous.reduce((s, r) => s + r.totalMs, 0) / previous.length;

            const delta = latest.totalMs - avgPrev;
            const pct = ((delta / avgPrev) * 100).toFixed(1);
            const trend = delta > 0 ? '📈 Slower' : delta < 0 ? '📉 Faster' : '➡️ Same';

            return {
                runs: relevant.length,
                latest: latest.totalMs,
                avgPrevious: avgPrev.toFixed(0),
                delta: delta.toFixed(0),
                percent: pct,
                trend,
                history: relevant.map(r => ({
                    time: r.timestamp,
                    totalMs: r.totalMs,
                    passed: r.passedSteps,
                    failed: r.failedSteps
                }))
            };
        } catch (_) {
            return null;
        }
    }

    printTrendReport() {
        const trends = Profiler.analyzeTrends(this.workflowName);
        if (!trends) return;

        console.log(`\n${colors.bright}${colors.magenta}📊 Run Trend Analysis (last ${trends.runs} runs)${colors.reset}`);
        Logger.metric('Current Run', `${(trends.latest / 1000).toFixed(2)}s`);
        Logger.metric('Avg Previous Runs', `${(parseInt(trends.avgPrevious) / 1000).toFixed(2)}s`);
        Logger.metric('Δ Change', `${parseInt(trends.delta) > 0 ? '+' : ''}${(parseInt(trends.delta) / 1000).toFixed(2)}s (${trends.percent}%)`);
        Logger.metric('Trend', `${trends.trend}`);

        // Sparkline of last runs
        const times = trends.history.map(h => h.totalMs);
        const sparkMax = Math.max(...times);
        const spark = times.map(t => {
            const ratio = t / sparkMax;
            if (ratio < 0.25) return '▁';
            if (ratio < 0.5)  return '▃';
            if (ratio < 0.75) return '▅';
            return '▇';
        }).join('');
        console.log(`  ${colors.gray}•${colors.reset} ${'Timeline'.padEnd(26)}: ${colors.cyan}${spark}${colors.reset}`);
    }

    // ─── Feature 16: Parallel vs Sequential Analyzer ─────────────────────────
    static analyzeParallelism(jobs) {
        const results = [];
        const jobNames = Object.keys(jobs);

        for (const jobId of jobNames) {
            const job = jobs[jobId];
            const needs = Array.isArray(job.needs) ? job.needs : (job.needs ? [job.needs] : []);
            const canRunWith = jobNames.filter(
                other => other !== jobId &&
                !needs.includes(other) &&
                !(Array.isArray(jobs[other]?.needs) ? jobs[other].needs : [jobs[other]?.needs]).includes(jobId)
            );
            results.push({ jobId, needs, canRunWith });
        }

        return results;
    }

    // ─── Feature 17: Cache Hit Simulator ─────────────────────────────────────
    _loadCacheStore() {
        const cacheFile = path.join(HISTORY_DIR, 'cache-store.json');
        try {
            if (fs.existsSync(cacheFile)) {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            }
        } catch (_) {}
        return {};
    }

    _saveCacheStore() {
        const cacheFile = path.join(HISTORY_DIR, 'cache-store.json');
        try {
            if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify(this.cacheStore, null, 2), 'utf8');
        } catch (_) {}
    }

    simulateCacheStep(step, matrixCtx = {}) {
        if (!step.uses?.includes('actions/cache')) return null;
        const key = String(step.with?.key || 'default').replace(/\$\{\{[^}]+\}\}/g, 'resolved');
        const restoreKeys = step.with?.['restore-keys']?.split('\n').map(k => k.trim()).filter(Boolean) || [];

        let hit = false;
        let hitKey = null;

        if (this.cacheStore[key]) {
            hit = true; hitKey = key;
        } else {
            for (const rk of restoreKeys) {
                const partialMatch = Object.keys(this.cacheStore).find(k => k.startsWith(rk));
                if (partialMatch) { hit = true; hitKey = partialMatch; break; }
            }
        }

        // Always save key for future runs
        this.cacheStore[key] = { savedAt: new Date().toISOString() };
        this._saveCacheStore();

        return { key, hit, hitKey, restoreKeys };
    }

    // ─── Feature 18: Network I/O Estimator ───────────────────────────────────
    static estimateNetworkIO(steps) {
        let totalMB = 0;
        const breakdown = [];

        const patterns = [
            { pattern: /npm (install|ci)/, mb: 15, label: 'npm packages' },
            { pattern: /pip install/, mb: 8, label: 'pip packages' },
            { pattern: /cargo (build|fetch)/, mb: 50, label: 'cargo crates' },
            { pattern: /apt-get install/, mb: 20, label: 'apt packages' },
            { pattern: /brew install/, mb: 100, label: 'homebrew packages' },
            { pattern: /curl|wget/, mb: 5, label: 'network download' },
            { pattern: /docker pull/, mb: 200, label: 'docker image' },
            { pattern: /go (get|install|mod download)/, mb: 25, label: 'go modules' },
        ];

        for (const step of steps) {
            if (!step.run) continue;
            for (const { pattern, mb, label } of patterns) {
                if (pattern.test(step.run)) {
                    totalMB += mb;
                    breakdown.push({ step: step.name || '(unnamed)', label, mb });
                }
            }
        }

        return { totalMB, breakdown };
    }

    // ─── Feature 20: Pipeline Efficiency Score ────────────────────────────────
    static computeEfficiencyScore(jobs, profilerRuns = []) {
        let score = 100;
        const deductions = [];

        // Check parallelism
        const parallelism = Profiler.analyzeParallelism(jobs);
        const jobsWithNoParallel = parallelism.filter(j => j.canRunWith.length === 0 && j.needs.length === 0);
        if (Object.keys(jobs).length > 2 && jobsWithNoParallel.length === Object.keys(jobs).length) {
            score -= 15;
            deductions.push('-15: All jobs run sequentially (no parallelism)');
        }

        // Check caching
        const allSteps = Object.values(jobs).flatMap(j => j.steps || []);
        const hasNpmInstall = allSteps.some(s => s.run && /npm (install|ci)/.test(s.run));
        const hasCache = allSteps.some(s => s.uses && s.uses.includes('actions/cache'));
        if (hasNpmInstall && !hasCache) {
            score -= 20;
            deductions.push('-20: npm install without actions/cache');
        }

        // Check timeouts
        const hasTimeout = Object.values(jobs).some(j => j['timeout-minutes']);
        if (!hasTimeout) {
            score -= 5;
            deductions.push('-5: No job timeout-minutes set');
        }

        // Check step count per job
        for (const [jobId, job] of Object.entries(jobs)) {
            if ((job.steps || []).length > 15) {
                score -= 10;
                deductions.push(`-10: Job "${jobId}" has ${job.steps.length} steps (consider splitting)`);
                break;
            }
        }

        // Slow steps bonus deduction
        if (profilerRuns.length > 0) {
            const slowSteps = profilerRuns.filter(r => r.durationMs > 30000);
            if (slowSteps.length > 0) {
                score -= Math.min(slowSteps.length * 5, 20);
                deductions.push(`-${Math.min(slowSteps.length * 5, 20)}: ${slowSteps.length} step(s) > 30s`);
            }
        }

        return {
            score: Math.max(score, 0),
            deductions,
            rating: score >= 85 ? '🟢 Excellent' : score >= 65 ? '🟡 Good' : score >= 40 ? '🟠 Needs Work' : '🔴 Poor'
        };
    }

    printEfficiencyReport(jobs) {
        const eff = Profiler.computeEfficiencyScore(jobs, this.runs);
        console.log(`\n${colors.bright}${colors.cyan}🏆 Pipeline Efficiency Score${colors.reset}`);
        Logger.metric('Score', `${eff.score}/100 ${eff.rating}`);
        if (eff.deductions.length > 0) {
            console.log(`  ${colors.gray}Deductions:${colors.reset}`);
            for (const d of eff.deductions) {
                console.log(`    ${colors.yellow}${d}${colors.reset}`);
            }
        }
        const parallelism = Profiler.analyzeParallelism(jobs);
        if (parallelism.some(j => j.canRunWith.length > 0)) {
            console.log(`\n  ${colors.gray}Parallelism opportunities:${colors.reset}`);
            for (const j of parallelism) {
                if (j.canRunWith.length > 0) {
                    console.log(`    ${colors.cyan}${j.jobId}${colors.reset} can run in parallel with: ${j.canRunWith.join(', ')}`);
                }
            }
        }
    }

    // ─── Dump Full Profile Report ─────────────────────────────────────────────
    printFullReport(jobs = {}) {
        this.printTimingTable();
        this.printCostReport();
        this.printTrendReport();
        this.printEfficiencyReport(jobs);

        const slowest = this.getSlowestStep();
        if (slowest) {
            console.log(`\n  ${colors.gray}Slowest step:${colors.reset} ${colors.yellow}${colors.bright}"${slowest.stepName}"${colors.reset} in job ${slowest.jobId} (${slowest.durationMs}ms)`);
        }
    }

    // ─── CLI Entry: aeroci profile ─────────────────────────────────────────────
    static showHistory() {
        if (!fs.existsSync(HISTORY_FILE)) {
            Logger.warn('No run history found. Run `aeroci run` first to record history.');
            return;
        }

        const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
        const entries = lines
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean)
            .slice(-20);

        Logger.info(`📊 Run History (last ${entries.length} run(s)):\n`);
        const rows = entries.map(e => [
            new Date(e.timestamp).toLocaleString(),
            e.workflow || 'unknown',
            `${(e.totalMs / 1000).toFixed(2)}s`,
            `${e.passedSteps || 0}/${(e.passedSteps || 0) + (e.failedSteps || 0)}`,
            `${e.peakMemoryMB || 0}MB`
        ]);
        Logger.table(['Timestamp', 'Workflow', 'Duration', 'Steps Pass', 'Peak Mem'], rows);
    }
}

module.exports = { Profiler };
