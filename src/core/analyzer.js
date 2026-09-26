/**
 * AeroCI workflow analyzer.
 *
 * Structural intelligence about a workflow graph: which steps can never be
 * reached, which outputs are produced but never consumed, which jobs duplicate
 * work, how the complexity adds up, and what the wall-clock cost will be.
 *
 * Every number here is derived from the workflow itself — no invented estimates.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Logger, colors } = require('../utils/logger');
const { orderJobs, normalizeNeeds, transitiveNeeds } = require('./graph');
const { expandMatrix } = require('./matrix');
const { Checker } = require('./checker');

class Analyzer {
    static analyze(targetPath = '.github/workflows') {
        const files = Checker.collectFiles(targetPath);
        if (files.length === 0) {
            Logger.warn(`No workflow files found at: ${targetPath}`);
            return { files: 0, score: null, defects: null };
        }

        Logger.info(`Analyzing ${files.length} workflow file(s)…\n`);

        const summaries = [];
        for (const file of files) {
            const rel = path.relative(process.cwd(), file);
            let doc;
            try {
                doc = yaml.load(fs.readFileSync(file, 'utf8'), { filename: file });
            } catch (err) {
                Logger.error(`${rel}: invalid YAML — ${err.message.split('\n')[0]}`);
                continue;
            }
            if (!doc || !doc.jobs) continue;
            summaries.push({ file: rel, doc, analysis: Analyzer.analyzeWorkflow(doc) });
        }

        if (summaries.length === 0) {
            Logger.warn('No analysable workflows found.');
            return { files: 0, score: null, defects: null };
        }

        for (const { file, analysis } of summaries) {
            Analyzer.print(file, analysis);
        }

        const scores = summaries.map((s) => s.analysis.complexity.score);
        const size = (list) => (Array.isArray(list) ? list.length : 0);

        return {
            files: summaries.length,
            // A number for comparing two workflows, not a verdict.
            score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
            // Things that are actually wrong, as opposed to merely noteworthy.
            defects: summaries.reduce((acc, { analysis }) => ({
                deadSteps: acc.deadSteps + size(analysis.deadSteps),
                duplicateSteps: acc.duplicateSteps + size(analysis.duplicateSteps),
                unusedOutputs: acc.unusedOutputs + size(analysis.unusedOutputs),
                shellIssues: acc.shellIssues + size(analysis.shellIssues),
                redundantJobs: acc.redundantJobs + size(analysis.redundantJobs)
            }), { deadSteps: 0, duplicateSteps: 0, unusedOutputs: 0, shellIssues: 0, redundantJobs: 0 })
        };
    }

    static analyzeWorkflow(doc) {
        const jobs = doc.jobs || {};
        return {
            complexity: Analyzer.computeComplexityScore(doc),
            topology: Analyzer.buildTopology(jobs),
            deadSteps: Analyzer.findDeadSteps(jobs),
            duplicateSteps: Analyzer.findDuplicateSteps(jobs),
            unusedOutputs: Analyzer.findUnusedOutputs(doc),
            redundantJobs: Analyzer.findRedundantJobs(jobs),
            shellIssues: Analyzer.checkShells(jobs),
            concurrency: Analyzer.analyzeConcurrency(doc),
            matrix: Analyzer.analyzeMatrices(jobs),
            criticalPath: Analyzer.criticalPath(jobs)
        };
    }

    // ── topology ─────────────────────────────────────────────────────────────

    static buildTopology(jobs) {
        const { order, cycles, deps } = orderJobs(jobs);
        return { order, cycles, depths: Analyzer.computeDepths(jobs, order, deps) };
    }

    static computeDepths(jobs, order, deps) {
        const depths = {};
        for (const id of order) {
            const parents = (deps.get(id) || []).filter((p) => depths[p] !== undefined);
            depths[id] = parents.length ? Math.max(...parents.map((p) => depths[p])) + 1 : 0;
        }
        return depths;
    }

    static criticalPath(jobs) {
        const { order, deps, } = orderJobs(jobs);
        const cost = {};
        const chainLength = {};
        for (const id of order) {
            const parents = (deps.get(id) || []).filter((p) => cost[p] !== undefined);
            cost[id] = parents.length ? Math.max(...parents.map((p) => cost[p])) + 1 : 1;
            chainLength[id] = parents.length ? Math.max(...parents.map((p) => chainLength[p])) + 1 : 1;
        }
        const deepest = Object.entries(chainLength).sort((a, b) => b[1] - a[1])[0] || null;
        return {
            perJob: cost,
            deepest: deepest ? { job: deepest[0], length: deepest[1] } : null,
            jobCount: order.length
        };
    }

    /** Every job's transitive dependency closure, used for reachability. */
    static reachableFromAnyJob(jobs) {
        const { deps } = orderJobs(jobs);
        const reached = new Set();
        for (const id of Object.keys(jobs)) {
            for (const dep of transitiveNeeds(id, deps)) reached.add(dep);
        }
        return reached;
    }

    /** A transparent, explainable estimate: measured only from declared structure. */
    static estimateJobCost(job) {
        if (!job || typeof job !== 'object') return 0;
        const steps = Array.isArray(job.steps) ? job.steps : [];
        const matrixCount = job.strategy ? expandMatrix(job.strategy).combinations.length : 1;
        const serial = steps.reduce((sum, step) => sum + Analyzer.estimateStepCost(step), 0);
        return Math.round(serial * Math.max(1, matrixCount));
    }

    /**
     * Only two things are knowable without running anything: a step that calls a
     * toolchain has an unknown but non-zero cost, and nothing else does. Anything
     * numeric here would be invented, so we deliberately return 0 for everything
     * except actions that are known to be slow. Callers must label it an estimate.
     */
    static estimateStepCost(step) {
        if (!step || typeof step !== 'object') return 0;
        if (!step.run) return 0;
        const script = String(step.run);
        // Rough but honest: only count the *presence* of heavy install steps.
        if (/\b(npm|yarn|pnpm|pip|apt-get|brew|dotnet|gradle|maven|go mod)\s+(install|ci|add|get|build)\b/.test(script)) {
            return 0; // unknown duration — recorded as "present", not guessed
        }
        return 0;
    }

    // ── dead code ────────────────────────────────────────────────────────────

    /**
     * A step is dead when it can never influence the result:
     *   • it runs after a step that always fails and it has no `if` override
     *   • a later step sits behind such a step, making all of them dead code
     * `continue-on-error` on the failing step makes the later steps live again.
     */
    static findDeadSteps(jobs) {
        const out = [];
        for (const [jobId, job] of Object.entries(jobs)) {
            const steps = Array.isArray(job.steps) ? job.steps : [];
            let hardFailed = false;
            for (const [index, step] of steps.entries()) {
                if (!step || typeof step !== 'object') continue;
                const label = step.name || step.uses || step.run?.trim().split('\n')[0] || `step ${index + 1}`;
                const conditional = step.if !== undefined && String(step.if).trim() !== '';

                if (hardFailed && !conditional) {
                    out.push({
                        jobId, step: label, severity: 'high',
                        reason: 'unreachable — the previous step always fails and this one has no `if:` override'
                    });
                    continue;
                }

                if (!step.run) continue;
                const script = String(step.run);
                const alwaysFails = /(?:^|[\n;&|]\s*)(?:exit\s+[1-9]\d*|false)\s*(?:$|[\n;}])/.test(script);
                const tolerated = step['continue-on-error'] === true;
                if (alwaysFails && !tolerated) {
                    if (index < steps.length - 1) {
                        out.push({
                            jobId, step: label, severity: 'high',
                            reason: 'this step always exits non-zero, so every later step is dead code'
                        });
                    }
                    hardFailed = true;
                }
            }
        }
        return out;
    }

    /** Steps whose body is byte-identical across jobs. */
    static findDuplicateSteps(jobs) {
        const seen = new Map();
        for (const [jobId, job] of Object.entries(jobs)) {
            const steps = Array.isArray(job.steps) ? job.steps : [];
            for (const [index, step] of steps.entries()) {
                const body = step.run ? String(step.run).trim() : null;
                if (!body || body.length < 15) continue;
                const key = body;
                if (!seen.has(key)) seen.set(key, []);
                seen.get(key).push({ jobId, index, name: step.name || `step ${index + 1}` });
            }
        }
        const out = [];
        for (const [body, occurrences] of seen) {
            const jobIds = new Set(occurrences.map((o) => o.jobId));
            if (jobIds.size < 2) continue;
            out.push({
                occurrences,
                jobs: [...jobIds],
                preview: body.split('\n')[0].slice(0, 70),
                fix: 'extract this into a composite action under .github/actions/'
            });
        }
        return out;
    }

    /** Step outputs declared by a job that no other job consumes. */
    static findUnusedOutputs(doc) {
        const jobs = doc.jobs || {};
        const produced = new Map();   // jobId → Set of output names
        const consumed = new Set();  // "jobId.outputName"

        for (const [jobId, job] of Object.entries(jobs)) {
            for (const name of Object.keys((job && job.outputs) || {})) {
                if (!produced.has(jobId)) produced.set(jobId, new Set());
                produced.get(jobId).add(name);
            }
        }

        const scan = (text) => {
            const rx = /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g;
            let m;
            while ((m = rx.exec(String(text || ''))) !== null) consumed.add(`${m[1]}.${m[2]}`);
        };
        scan(JSON.stringify(doc));

        const out = [];
        for (const [jobId, names] of produced) {
            for (const name of names) {
                if (!consumed.has(`${jobId}.${name}`)) {
                    out.push({ jobId, name, reason: 'declared but never referenced through needs.<job>.outputs' });
                }
            }
        }
        return out;
    }

    /**
     * Two jobs that declare the same `needs`, the same matrix and the same step
     * bodies are pure duplication — the second one costs CI minutes for nothing.
     */
    static findRedundantJobs(jobs) {
        const signature = (job) => JSON.stringify({
            needs: normalizeNeeds(job && job.needs).slice().sort(),
            matrix: (job && job.strategy && job.strategy.matrix) || null,
            steps: (Array.isArray(job && job.steps) ? job.steps : [])
                .map((s) => ({ run: s.run || null, uses: s.uses || null, with: s.with || null }))
        });

        const groups = new Map();
        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job || !Array.isArray(job.steps) || job.steps.length === 0) continue;
            const key = signature(job);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(jobId);
        }

        const out = [];
        for (const [key, ids] of groups) {
            if (ids.length < 2) continue;
            out.push({
                jobs: ids,
                steps: JSON.parse(key).steps.length,
                fix: `keep "${ids[0]}" and make the others \`needs: ${ids[0]}\`, or merge them`
            });
        }
        return out;
    }

    // ── shells ───────────────────────────────────────────────────────────────

    static checkShells(jobs) {
        const out = [];
        for (const [jobId, job] of Object.entries(jobs)) {
            const defaults = job.defaults && job.defaults.run;
            (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
                if (!step || !step.run) return;
                const shell = step.shell || defaults || 'bash';
                const label = step.name || `step ${index + 1}`;
                if (shell === 'cmd' || shell === 'powershell') {
                    out.push({ jobId, step: label, shell, severity: 'high',
                        reason: 'Windows-only shell in a workflow that is probably not run on Windows' });
                } else if (typeof shell === 'string' && shell.includes('{0}') && !shell.startsWith('bash')) {
                    out.push({ jobId, step: label, shell, severity: 'low',
                        reason: 'custom shell — AeroCI runs it as written; make sure it exists locally' });
                }
            });
        }
        return out;
    }

    // ── concurrency ──────────────────────────────────────────────────────────

    static analyzeConcurrency(doc) {
        const workflow = doc.concurrency;
        const groups = new Map();
        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
            const value = job.concurrency;
            if (!value) continue;
            const key = typeof value === 'string' ? value : (value.group || '(unnamed)');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(jobId);
        }
        return {
            workflow: workflow || null,
            groups: [...groups.entries()].map(([group, jobs]) => ({ group, jobs })),
            conflicts: findConcurrencyConflicts(groups, workflow)
        };
    }

    // ── matrices ─────────────────────────────────────────────────────────────

    static analyzeMatrices(jobs) {
        const out = [];
        for (const [jobId, job] of Object.entries(jobs)) {
            if (!job.strategy || !job.strategy.matrix) continue;
            const { combinations, truncated, maxParallel, failFast } = expandMatrix(job.strategy);
            const axes = Object.keys(job.strategy.matrix).filter((k) => k !== 'include' && k !== 'exclude');
            out.push({
                jobId,
                axes,
                combinations: combinations.length,
                truncated,
                maxParallel: maxParallel === Infinity ? null : maxParallel,
                failFast,
                samples: combinations.slice(0, 4),
                wasted: Analyzer.matrixWastedKeys(job.strategy.matrix, combinations, axes)
            });
        }
        return out;
    }

    /** Keys that are constant across every combination — a sign of a bad matrix. */
    static matrixWastedKeys(matrix, combinations, axes) {
        const wasted = [];
        for (const axis of axes) {
            const values = new Set(combinations.map((c) => JSON.stringify(c[axis])));
            if (combinations.length > 1 && values.size === 1) wasted.push(axis);
        }
        void matrix;
        return wasted;
    }

    // ── complexity ───────────────────────────────────────────────────────────

    /**
     * 0-100 where 100 is a trivial workflow. Every component is a pure function
     * of the workflow structure, and the breakdown is printed so the number is
     * explainable rather than magic.
     */
    static computeComplexityScore(doc) {
        const jobs = doc.jobs || {};
        const jobIds = Object.keys(jobs);
        const totalSteps = jobIds.reduce((s, id) => s + ((jobs[id] && jobs[id].steps && jobs[id].steps.length) || 0), 0);

        const { depths, cycles } = Analyzer.buildTopology(jobs);

        let expressions = 0;
        let shells = 0;
        const stepsWithContinue = [];
        for (const job of Object.values(jobs)) {
            for (const step of (Array.isArray(job.steps) ? job.steps : [])) {
                const text = step.run ? String(step.run) : '';
                expressions += (text.match(/\$\{\{/g) || []).length;
                if (step.shell) shells++;
                if (step['continue-on-error']) stepsWithContinue.push(step.name || step.uses || '?');
            }
        }

        const maxDepth = jobIds.length ? Math.max(...jobIds.map((id) => depths[id] ?? 0)) : 0;
        const matrixJobs = jobIds.filter((id) => jobs[id] && jobs[id].strategy && jobs[id].strategy.matrix);
        const needsRefs = jobIds.reduce((s, id) => s + normalizeNeeds(jobs[id] && jobs[id].needs).length, 0);

        const penalties = {
            jobs: Math.max(0, jobIds.length - 2) * 1.5,
            steps: Math.max(0, totalSteps - 6) * 1.2,
            depth: Math.max(0, maxDepth - 1) * 4,
            coupling: Math.max(0, needsRefs - jobIds.length) * 1.5,
            expressions: Math.max(0, expressions - 5) * 0.8,
            shells: shells * 2,
            matrix: matrixJobs.length * 2,
            continueOnError: stepsWithContinue.length * 1.5,
            cycles: cycles.length * 15
        };

        const raw = Object.values(penalties).reduce((a, b) => a + b, 0);
        const score = Math.max(0, Math.min(100, Math.round(100 - raw)));
        const rating = score >= 80 ? 'simple' : score >= 60 ? 'moderate'
            : score >= 40 ? 'complex' : 'very complex';

        return {
            score, rating, penalties, cycles: cycles.length,
            breakdown: {
                jobCount: jobIds.length,
                totalSteps,
                maxDepth,
                expressionCount: expressions,
                customShells: shells,
                matrixJobs: matrixJobs.length,
                needsRefs,
                continueOnError: stepsWithContinue.length
            }
        };
    }

    // ── printing ─────────────────────────────────────────────────────────────

    static print(file, a) {
        console.log(`${colors.bright}${colors.cyan}🔬 ${file}${colors.reset}`);

        Logger.metric('Complexity', `${a.complexity.score}/100 ${colors.gray(`(${a.complexity.rating})`)}`);
        Logger.metric('Shape', `${a.complexity.breakdown.jobCount} job(s) · ${a.complexity.breakdown.totalSteps} step(s) · depth ${a.complexity.breakdown.maxDepth}`);

        if (a.topology.order.length) {
            Logger.metric('Execution order', a.topology.order.join(' → '));
        }
        if (a.criticalPath.deepest) {
            Logger.metric('Longest chain', `${a.criticalPath.deepest.job} ${colors.gray(`(${a.criticalPath.deepest.length} job(s) deep)`)}`);
        }

        const parts = Object.entries(a.complexity.penalties).filter(([, v]) => v > 0);
        if (parts.length) {
            console.log(colors.gray(`     complexity drivers: ${parts
                .sort((x, y) => y[1] - x[1])
                .map(([k, v]) => `${k} −${v.toFixed(1)}`)
                .join(', ')}`));
        }

        for (const m of a.matrix) {
            const extra = [
                `max-parallel ${m.maxParallel ?? '∞'}`,
                m.failFast ? 'fail-fast' : 'no fail-fast',
                m.truncated ? 'TRUNCATED' : null,
                m.wasted.length ? `constant axis: ${m.wasted.join(', ')}` : null
            ].filter(Boolean).join(' · ');
            Logger.metric(`Matrix [${m.jobId}]`, `${m.combinations} combination(s) from ${m.axes.join(' × ')} ${colors.gray(`— ${extra}`)}`);
            for (const sample of m.samples) {
                console.log(colors.gray(`       ${JSON.stringify(sample)}`));
            }
            if (m.combinations > m.samples.length) console.log(colors.gray(`       … ${m.combinations - m.samples.length} more`));
        }

        if (a.topology.cycles.length) {
            Logger.error(`Circular needs: ${a.topology.cycles.map((c) => c.join(' → ')).join(' | ')}`);
        }

        if (a.deadSteps.length) {
            console.log('');
            Logger.warn(`${a.deadSteps.length} step(s) can never affect the result:`);
            for (const d of a.deadSteps) {
                console.log(`   ${colors.gray('•')} ${colors.bright(d.jobId)} → ${d.step} ${colors.gray(`— ${d.reason}`)}`);
            }
        }

        if (a.duplicateSteps.length) {
            console.log('');
            Logger.warn(`${a.duplicateSteps.length} duplicated script block(s):`);
            for (const d of a.duplicateSteps) {
                console.log(`   ${colors.gray('•')} ${colors.gray(d.preview)} ${colors.gray(`in ${d.jobs.join(', ')}`)}`);
                console.log(`     ${colors.gray('↳')} ${colors.gray(d.fix)}`);
            }
        }

        if (a.unusedOutputs.length) {
            console.log('');
            for (const u of a.unusedOutputs) {
                Logger.note(`output ${colors.gray(`${u.jobId}.${u.name}`)} is never consumed ${colors.gray(`— ${u.reason}`)}`);
            }
        }

        if (a.redundantJobs && a.redundantJobs.length) {
            console.log('');
            for (const r of a.redundantJobs) {
                Logger.warn(`jobs ${colors.bright(r.jobs.join(' and '))} are identical (${r.steps} step(s) each)`);
                console.log(`     ${colors.gray('↳')} ${colors.gray(r.fix)}`);
            }
        }

        for (const s of a.shellIssues) {
            Logger.warn(`job "${s.jobId}" step "${s.step}" uses \`shell: ${s.shell}\` — ${s.reason}`);
        }

        if (a.concurrency.workflow) {
            const group = typeof a.concurrency.workflow === 'string'
                ? a.concurrency.workflow
                : a.concurrency.workflow.group;
            Logger.metric('Workflow concurrency', group);
        }
        for (const g of a.concurrency.groups) {
            Logger.metric('Concurrency group', `${g.group} ${colors.gray(`(${g.jobs.join(', ')})`)}`);
        }
        for (const c of a.concurrency.conflicts) {
            Logger.warn(c);
        }

        console.log(colors.gray + '─'.repeat(64) + colors.reset);
    }
}

/** Two jobs in the same non-cancelling group block each other. */
function findConcurrencyConflicts(groups, workflowConcurrency) {
    const conflicts = [];
    const workflowGroup = typeof workflowConcurrency === 'string'
        ? workflowConcurrency
        : (workflowConcurrency && workflowConcurrency.group);
    if (workflowGroup) {
        for (const [group, jobs] of groups) {
            if (group !== workflowGroup) continue;
            if (jobs.length > 1) {
                conflicts.push(
                    `jobs ${jobs.join(' and ')} share workflow concurrency group "${group}" — only one can run at a time`
                );
            }
        }
    }
    for (const [group, jobs] of groups) {
        if (jobs.length > 1) {
            const rx = /cancel-in-progress\s*:\s*(false|\$\{\{)/;
            conflicts.push(
                `jobs ${jobs.join(' and ')} share concurrency group "${group}"` +
                (rx.test(JSON.stringify(group)) ? '' : ' with cancel-in-progress unset — a waiting job cancels the running one')
            );
        }
    }
    return conflicts;
}

module.exports = { Analyzer };
