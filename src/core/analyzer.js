/**
 * AeroCI Deep Workflow Analyzer v2.0.0
 * Features 1-10: Intelligent static analysis of GitHub Actions workflows
 *
 * 1.  Step Dependency Graph         — map steps that consume outputs of others
 * 2.  Dead Step Detector            — steps that can never execute
 * 3.  Duplicate Step Detector       — identical run: blocks across jobs
 * 4.  Long-Running Step Estimator   — heuristic duration estimate per step
 * 5.  Shell Compatibility Checker   — bash-only syntax inside sh steps
 * 6.  Secret Injection Analyzer     — trace secrets through env → run
 * 7.  Artifact Lifecycle Tracker    — match upload ↔ download pairs
 * 8.  Circular Job Dependency       — detect needs: cycles
 * 9.  Concurrency Group Analyzer    — conflicting concurrency groups
 * 10. Workflow Complexity Score     — composite 0-100 score
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Logger, colors } = require('../utils/logger');

class Analyzer {
    // ─── Feature 1: Step Dependency Graph ────────────────────────────────────
    static buildStepDependencyGraph(job) {
        const graph = [];
        const steps = job.steps || [];
        const outputProducers = {}; // stepId → [keys]

        for (const step of steps) {
            if (step.id) {
                // Collect steps that set outputs
                if (step.run && step.run.includes('>> $GITHUB_OUTPUT')) {
                    const matches = [...step.run.matchAll(/^([A-Z_a-z0-9]+)=/gm)];
                    outputProducers[step.id] = matches.map(m => m[1]);
                }
            }
        }

        for (const step of steps) {
            const deps = [];
            const stepStr = JSON.stringify(step);
            const refs = [...stepStr.matchAll(/steps\.([a-zA-Z0-9_-]+)\.outputs\./g)];
            for (const ref of refs) {
                if (!deps.includes(ref[1])) deps.push(ref[1]);
            }
            if (deps.length > 0) {
                graph.push({ step: step.name || step.id || '(unnamed)', dependsOn: deps });
            }
        }
        return graph;
    }

    // ─── Feature 2: Dead Step Detector ───────────────────────────────────────
    static findDeadSteps(job) {
        const dead = [];
        const steps = job.steps || [];
        const IMPOSSIBLE_CONDITIONS = [
            'false', '1 == 2', '0 == 1', "'' == 'x'",
            'failure() && success()', 'cancelled() && success()'
        ];

        for (const step of steps) {
            if (!step.if) continue;
            const cond = String(step.if).trim().toLowerCase();
            if (IMPOSSIBLE_CONDITIONS.some(ic => cond === ic.toLowerCase())) {
                dead.push({
                    step: step.name || step.id || step.run?.split('\n')[0] || '(unnamed)',
                    condition: step.if
                });
            }
            // Contradictory: success() && failure()
            if (cond.includes('success()') && cond.includes('failure()') && cond.includes('&&')) {
                dead.push({
                    step: step.name || step.id || '(unnamed)',
                    condition: step.if
                });
            }
        }
        return dead;
    }

    // ─── Feature 3: Duplicate Step Detector ──────────────────────────────────
    static findDuplicateSteps(jobs) {
        const seen = new Map(); // normalized script → [{jobId, stepName}]
        const duplicates = [];

        for (const [jobId, job] of Object.entries(jobs)) {
            for (const step of (job.steps || [])) {
                if (!step.run) continue;
                const normalized = step.run.replace(/\s+/g, ' ').trim();
                if (seen.has(normalized)) {
                    const existing = seen.get(normalized);
                    duplicates.push({
                        script: normalized.slice(0, 80) + (normalized.length > 80 ? '…' : ''),
                        locations: [...existing, { jobId, step: step.name || '(unnamed)' }]
                    });
                } else {
                    seen.set(normalized, [{ jobId, step: step.name || '(unnamed)' }]);
                }
            }
        }
        return duplicates;
    }

    // ─── Feature 4: Long-Running Step Estimator ──────────────────────────────
    static estimateStepDuration(step) {
        if (step.uses) return { ms: 200, reason: 'Action invoke overhead' };
        if (!step.run) return { ms: 0, reason: 'No-op' };

        const script = step.run;
        let ms = 50; // base
        const reasons = [];

        if (/npm (install|ci)/.test(script)) { ms += 15000; reasons.push('npm install'); }
        if (/pip install/.test(script)) { ms += 8000; reasons.push('pip install'); }
        if (/cargo build/.test(script)) { ms += 45000; reasons.push('cargo build'); }
        if (/docker build/.test(script)) { ms += 30000; reasons.push('docker build'); }
        if (/npm (run )?(build|test)/.test(script)) { ms += 5000; reasons.push('npm build/test'); }
        if (/go build/.test(script)) { ms += 10000; reasons.push('go build'); }
        if (/mvn (package|install)/.test(script)) { ms += 20000; reasons.push('maven'); }
        if (/gradle/.test(script)) { ms += 18000; reasons.push('gradle'); }
        if (/curl|wget/.test(script)) { ms += 2000; reasons.push('network I/O'); }
        if (/sleep\s+\d+/.test(script)) {
            const m = script.match(/sleep\s+(\d+)/);
            if (m) { ms += parseInt(m[1]) * 1000; reasons.push(`sleep ${m[1]}s`); }
        }

        return { ms, reason: reasons.join(', ') || 'shell commands' };
    }

    // ─── Feature 5: Shell Compatibility Checker ───────────────────────────────
    static checkShellCompatibility(steps) {
        const issues = [];
        const BASH_ONLY = [
            { pattern: /\[\[.*\]\]/, desc: '[[ ]] — bash double-bracket test' },
            { pattern: /<<</, desc: '<<< herestring — bash only' },
            { pattern: /\$\((.+)\)/, desc: 'Command substitution (POSIX ok but check nesting)' },
            { pattern: /\bsource\b/, desc: 'source builtin — use . in sh' },
            { pattern: /\bpipefail\b/, desc: 'set -o pipefail — bash only' },
            { pattern: /\bPIPESTATUS\b/, desc: '$PIPESTATUS — bash only' },
            { pattern: /declare\s+-[aA]/, desc: 'declare -a/-A arrays — bash only' },
            { pattern: /mapfile|readarray/, desc: 'mapfile/readarray — bash only' },
        ];

        for (const step of steps) {
            if (!step.run) continue;
            const shell = step.shell || 'bash'; // default is bash in GHA
            if (shell === 'sh') {
                for (const { pattern, desc } of BASH_ONLY) {
                    if (pattern.test(step.run)) {
                        issues.push({
                            step: step.name || '(unnamed)',
                            issue: desc,
                            shell
                        });
                    }
                }
            }
        }
        return issues;
    }

    // ─── Feature 6: Secret Injection Analyzer ────────────────────────────────
    static analyzeSecretFlow(jobs) {
        const secretMap = {}; // secretName → [{jobId, stepName, via}]

        for (const [jobId, job] of Object.entries(jobs)) {
            // Check job-level env
            const jobEnvSecrets = Object.entries(job.env || {})
                .filter(([, v]) => /\$\{\{\s*secrets\./.test(String(v)))
                .map(([k]) => k);

            for (const step of (job.steps || [])) {
                const allContent = JSON.stringify(step);
                const matches = [...allContent.matchAll(/secrets\.([A-Z0-9_a-z]+)/g)];
                for (const m of matches) {
                    const name = m[1];
                    if (!secretMap[name]) secretMap[name] = [];
                    secretMap[name].push({
                        jobId,
                        step: step.name || step.id || '(unnamed)',
                        via: step.env ? 'env block' : (step.with ? 'with block' : 'direct')
                    });
                }
            }
        }
        return secretMap;
    }

    // ─── Feature 7: Artifact Lifecycle Tracker ───────────────────────────────
    static trackArtifactLifecycle(jobs) {
        const uploads = [];   // { name, jobId, stepName }
        const downloads = []; // { name, jobId, stepName }

        for (const [jobId, job] of Object.entries(jobs)) {
            for (const step of (job.steps || [])) {
                if (!step.uses) continue;
                if (step.uses.includes('upload-artifact')) {
                    uploads.push({
                        name: step.with?.name || '(unnamed)',
                        jobId,
                        step: step.name || '(unnamed)'
                    });
                }
                if (step.uses.includes('download-artifact')) {
                    downloads.push({
                        name: step.with?.name || '*',
                        jobId,
                        step: step.name || '(unnamed)'
                    });
                }
            }
        }

        const orphanUploads = uploads.filter(u =>
            !downloads.some(d => d.name === '*' || d.name === u.name)
        );
        const orphanDownloads = downloads.filter(d =>
            d.name !== '*' && !uploads.some(u => u.name === d.name)
        );

        return { uploads, downloads, orphanUploads, orphanDownloads };
    }

    // ─── Feature 8: Circular Job Dependency Detector ─────────────────────────
    static detectCircularDependencies(jobs) {
        const cycles = [];
        const visited = new Set();

        const dfs = (jobId, chain) => {
            if (chain.includes(jobId)) {
                cycles.push([...chain, jobId]);
                return;
            }
            if (visited.has(jobId)) return;
            const job = jobs[jobId];
            if (!job) return;
            const needs = Array.isArray(job.needs) ? job.needs : (job.needs ? [job.needs] : []);
            for (const dep of needs) {
                dfs(dep, [...chain, jobId]);
            }
            visited.add(jobId);
        };

        for (const jobId of Object.keys(jobs)) {
            dfs(jobId, []);
        }
        return cycles;
    }

    // ─── Feature 9: Concurrency Group Analyzer ───────────────────────────────
    static analyzeConcurrencyGroups(jobs, workflowConcurrency) {
        const groups = {};
        if (workflowConcurrency) {
            const g = workflowConcurrency.group || workflowConcurrency;
            if (!groups[g]) groups[g] = [];
            groups[g].push({ level: 'workflow', cancelInProgress: !!workflowConcurrency['cancel-in-progress'] });
        }
        for (const [jobId, job] of Object.entries(jobs)) {
            if (job.concurrency) {
                const g = job.concurrency.group || job.concurrency;
                if (!groups[g]) groups[g] = [];
                groups[g].push({ level: `job:${jobId}`, cancelInProgress: !!job.concurrency['cancel-in-progress'] });
            }
        }
        const conflicts = Object.entries(groups)
            .filter(([, entries]) => entries.length > 1)
            .map(([group, entries]) => ({ group, entries }));
        return { groups, conflicts };
    }

    // ─── Feature 10: Workflow Complexity Score ────────────────────────────────
    static computeComplexityScore(doc) {
        let score = 0;
        const jobs = doc.jobs || {};
        const jobCount = Object.keys(jobs).length;
        let totalSteps = 0;
        let matrixCount = 0;
        let hasNeeds = false;
        let conditionCount = 0;
        let secretCount = 0;

        for (const job of Object.values(jobs)) {
            const steps = job.steps || [];
            totalSteps += steps.length;
            if (job.strategy?.matrix) matrixCount++;
            if (job.needs) hasNeeds = true;
            for (const step of steps) {
                if (step.if) conditionCount++;
                const content = JSON.stringify(step);
                secretCount += (content.match(/secrets\./g) || []).length;
            }
        }

        // Scoring rubric
        score += Math.min(jobCount * 5, 20);        // up to 20pts for job count
        score += Math.min(totalSteps * 2, 25);      // up to 25pts for steps
        score += matrixCount * 8;                    // 8pts per matrix
        score += hasNeeds ? 10 : 0;                 // 10pts for job dependencies
        score += Math.min(conditionCount * 3, 15);  // up to 15pts for conditions
        score += Math.min(secretCount * 2, 10);     // up to 10pts for secrets

        return {
            score: Math.min(score, 100),
            breakdown: { jobCount, totalSteps, matrixCount, hasNeeds, conditionCount, secretCount },
            rating: score < 20 ? '🟢 Simple' : score < 50 ? '🟡 Moderate' : score < 75 ? '🟠 Complex' : '🔴 Very Complex'
        };
    }

    // ─── Main Entry Point ─────────────────────────────────────────────────────
    static analyze(targetPath = '.github/workflows') {
        const fullPath = path.resolve(process.cwd(), targetPath);
        let files = [];
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                files = fs.readdirSync(fullPath)
                    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
                    .map(f => path.join(fullPath, f));
            } else {
                files = [fullPath];
            }
        }

        if (files.length === 0) {
            Logger.warn('No workflow files found to analyze.');
            return;
        }

        Logger.info(`🧠 Deep Workflow Analyzer v2.0.0 — scanning ${files.length} file(s)...\n`);

        for (const file of files) {
            const relPath = path.relative(process.cwd(), file);
            console.log(`${colors.bright}${colors.magenta}🔬 Analyzing: ${relPath}${colors.reset}\n`);

            let doc;
            try {
                doc = yaml.load(fs.readFileSync(file, 'utf8'));
            } catch (e) {
                Logger.error(`YAML parse error: ${e.message}`);
                continue;
            }
            if (!doc) continue;

            const jobs = doc.jobs || {};
            const allSteps = Object.values(jobs).flatMap(j => j.steps || []);

            // ① Complexity Score
            const complexity = Analyzer.computeComplexityScore(doc);
            Logger.metric('Complexity Score', `${complexity.score}/100 ${complexity.rating}`);
            Logger.metric('Jobs', String(complexity.breakdown.jobCount));
            Logger.metric('Total Steps', String(complexity.breakdown.totalSteps));
            console.log();

            // ② Step Dependency Graph
            let depFound = false;
            for (const [jobId, job] of Object.entries(jobs)) {
                const graph = Analyzer.buildStepDependencyGraph(job);
                if (graph.length > 0) {
                    if (!depFound) { Logger.info('① Step Dependency Graph:'); depFound = true; }
                    for (const node of graph) {
                        console.log(`   ${colors.cyan}${node.step}${colors.reset} → depends on steps: ${colors.yellow}${node.dependsOn.join(', ')}${colors.reset}`);
                    }
                }
            }
            if (!depFound) Logger.success('① No cross-step output dependencies found.');

            // ③ Dead Steps
            let deadFound = false;
            for (const [jobId, job] of Object.entries(jobs)) {
                const dead = Analyzer.findDeadSteps(job);
                for (const d of dead) {
                    if (!deadFound) { Logger.warn('② Dead Steps Detected (can never run):'); deadFound = true; }
                    console.log(`   ${colors.red}✖ "${d.step}"${colors.reset} — if: ${colors.gray}${d.condition}${colors.reset}`);
                }
            }
            if (!deadFound) Logger.success('② No dead steps detected.');

            // ④ Duplicate Steps
            const dupes = Analyzer.findDuplicateSteps(jobs);
            if (dupes.length > 0) {
                Logger.warn(`③ Duplicate Steps (${dupes.length}):`);
                for (const d of dupes) {
                    console.log(`   ${colors.yellow}Script:${colors.reset} "${d.script}"`);
                    for (const loc of d.locations) {
                        console.log(`     → job:${loc.jobId} > "${loc.step}"`);
                    }
                }
            } else {
                Logger.success('③ No duplicate steps found.');
            }

            // ⑤ Step Duration Estimates
            Logger.info('④ Step Duration Estimates:');
            const rows = [];
            for (const [jobId, job] of Object.entries(jobs)) {
                for (const step of (job.steps || [])) {
                    const est = Analyzer.estimateStepDuration(step);
                    if (est.ms > 1000) {
                        rows.push([
                            jobId,
                            (step.name || step.id || '(unnamed)').slice(0, 35),
                            est.ms >= 60000
                                ? `~${(est.ms/60000).toFixed(1)}min`
                                : `~${(est.ms/1000).toFixed(0)}s`,
                            est.reason
                        ]);
                    }
                }
            }
            if (rows.length > 0) {
                Logger.table(['Job', 'Step', 'Est. Duration', 'Reason'], rows);
            } else {
                console.log(`   ${colors.gray}(All steps estimated < 1s)${colors.reset}\n`);
            }

            // ⑥ Shell Compatibility
            const shellIssues = Analyzer.checkShellCompatibility(allSteps);
            if (shellIssues.length > 0) {
                Logger.warn(`⑤ Shell Compatibility Issues (${shellIssues.length}):`);
                for (const i of shellIssues) {
                    console.log(`   ${colors.yellow}Step "${i.step}" [shell:${i.shell}]:${colors.reset} ${i.issue}`);
                }
            } else {
                Logger.success('⑤ No shell compatibility issues detected.');
            }

            // ⑦ Secret Flow Map
            const secretMap = Analyzer.analyzeSecretFlow(jobs);
            const secretNames = Object.keys(secretMap);
            if (secretNames.length > 0) {
                Logger.info(`⑥ Secret Flow Map (${secretNames.length} secret(s)):`);
                for (const [name, usages] of Object.entries(secretMap)) {
                    console.log(`   ${colors.yellow}secrets.${name}${colors.reset} used in:`);
                    for (const u of usages) {
                        console.log(`     → job:${u.jobId} > "${u.step}" (${u.via})`);
                    }
                }
                console.log();
            }

            // ⑧ Artifact Lifecycle
            const artifacts = Analyzer.trackArtifactLifecycle(jobs);
            if (artifacts.orphanUploads.length > 0) {
                Logger.warn(`⑦ Orphan Uploads (no matching download):`);
                for (const u of artifacts.orphanUploads) {
                    console.log(`   ${colors.yellow}"${u.name}"${colors.reset} uploaded in job:${u.jobId}`);
                }
            }
            if (artifacts.orphanDownloads.length > 0) {
                Logger.warn(`⑦ Orphan Downloads (no matching upload):`);
                for (const d of artifacts.orphanDownloads) {
                    console.log(`   ${colors.red}"${d.name}"${colors.reset} downloaded in job:${d.jobId} — never uploaded!`);
                }
            }
            if (artifacts.orphanUploads.length === 0 && artifacts.orphanDownloads.length === 0) {
                if (artifacts.uploads.length > 0 || artifacts.downloads.length > 0) {
                    Logger.success(`⑦ Artifact lifecycle balanced (${artifacts.uploads.length} upload(s) ↔ ${artifacts.downloads.length} download(s)).`);
                }
            }

            // ⑨ Circular Job Dependencies
            const cycles = Analyzer.detectCircularDependencies(jobs);
            if (cycles.length > 0) {
                Logger.warn(`⑧ Circular Job Dependencies:`);
                for (const cycle of cycles) {
                    console.log(`   ${colors.red}${cycle.join(' → ')}${colors.reset}`);
                }
            } else {
                Logger.success('⑧ No circular job dependencies.');
            }

            // ⑩ Concurrency Groups
            const concurrency = Analyzer.analyzeConcurrencyGroups(jobs, doc.concurrency);
            if (concurrency.conflicts.length > 0) {
                Logger.warn(`⑨ Concurrency Group Conflicts:`);
                for (const c of concurrency.conflicts) {
                    console.log(`   Group "${c.group}" defined at: ${c.entries.map(e => e.level).join(', ')}`);
                }
            }

            console.log(colors.gray + '\n--------------------------------------------------' + colors.reset);
        }
    }
}

module.exports = { Analyzer };
