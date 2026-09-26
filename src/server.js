/**
 * AeroCI local dashboard.
 *
 * Serves a read-only view of the workflows in the current project over
 * Velociradix. Everything the API returns is read from disk on each request —
 * there are no cached counters, no pre-set totals and no claims about money or
 * time saved, because none of those can be derived from a workflow file.
 *
 * The server binds to the loopback interface by default. It exposes the
 * contents of your project to whoever can reach it, so making that a conscious
 * decision (`--host 0.0.0.0`) is part of the design rather than an option you
 * have to remember.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { Logger, colors } = require('./utils/logger');
const { Checker } = require('./core/checker');
const { Analyzer } = require('./core/analyzer');
const { Security, countByLevel } = require('./core/security');
const { VERSION } = require('./version');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

class Server {
    /**
     * @param {object} options
     * @param {number} options.port
     * @param {string} options.host  defaults to 127.0.0.1
     * @param {string} options.cwd   the project the dashboard describes
     */
    static async start(options = {}) {
        const { createApp } = await import('velociradix');
        const port = Number(options.port) || 3500;
        const host = options.host || '127.0.0.1';
        const cwd = path.resolve(options.cwd || process.cwd());

        if (host !== '127.0.0.1' && host !== 'localhost') {
            Logger.warn(`Binding to ${host} — anyone who can reach this address can read your workflow files.`);
        }

        const app = createApp();

        app.get('/', (ctx) => {
            const indexPath = path.join(PUBLIC_DIR, 'index.html');
            if (fs.existsSync(indexPath)) {
                return ctx.set({ 'cache-control': 'no-store' }).html(fs.readFileSync(indexPath, 'utf8'));
            }
            return ctx.html(fallbackPage(cwd));
        });

        if (fs.existsSync(PUBLIC_DIR)) {
            app.serveStatic('/', PUBLIC_DIR);
        }

        app.get('/api/status', (ctx) => ctx.json(describeProject(cwd)));

        app.get('/api/workflows', (ctx) => {
            const { workflows } = describeProject(cwd);
            return ctx.json({ workflows });
        });

        app.get('/api/workflow', (ctx) => {
            const name = ctx.query('file');
            if (!name) return ctx.status(400).json({ error: 'pass ?file=.github/workflows/ci.yml' });
            const full = resolveInside(cwd, name);
            if (!full) return ctx.status(400).json({ error: 'file is outside the project' });
            if (!fs.existsSync(full)) return ctx.status(404).json({ error: 'no such workflow' });
            return ctx.json(analyseOne(cwd, full));
        });

        app.get('/api/history', (ctx) => {
            const file = path.join(cwd, '.aeroci-artifacts', 'history.jsonl');
            let raw = '';
            try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { /* no history yet */ }
            const runs = raw.split('\n').filter(Boolean)
                .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
                .filter(Boolean)
                .slice(-50);
            return ctx.json({ runs });
        });

        app.get('/api/health', (ctx) => ctx.json({
            status: 'ok',
            version: VERSION,
            node: process.versions.node,
            uptimeSeconds: Math.round(process.uptime())
        }));

        app.notFound((ctx) => ctx.status(404).json({ error: 'not found' }));

        app.onError((err, ctx) => ctx.status(500).json({ error: err.message }));

        return new Promise((resolve) => {
            app.listen(port, host, () => {
                Logger.banner();
                Logger.success(`AeroCI dashboard ${colors.cyan(`http://${host}:${port}`)}`);
                Logger.note(`  serving ${path.relative(process.cwd(), cwd) || '.'}`);
                Logger.note(`  workflows in ${colors.cyan('.github/workflows')}`);
                Logger.note('  press Ctrl+C to stop');
                resolve({ app, port, host, close: () => app.close() });
            });
        });
    }
}

/** Read everything the dashboard shows from disk. No invented numbers. */
function describeProject(cwd) {
    const files = Checker.collectFiles(path.join(cwd, '.github/workflows'));
    const workflows = [];
    let parseErrors = 0;

    for (const file of files) {
        const rel = path.relative(cwd, file);
        let doc = null;
        let error = null;
        try {
            doc = yaml.load(fs.readFileSync(file, 'utf8'), { filename: file });
        } catch (err) {
            parseErrors++;
            error = err.message.split('\n')[0];
        }

        const jobIds = doc && doc.jobs ? Object.keys(doc.jobs) : [];
        workflows.push({
            file: rel,
            name: (doc && doc.name) || path.basename(file),
            jobs: jobIds.length,
            steps: jobIds.reduce((n, id) => n + ((doc.jobs[id].steps || []).length), 0),
            triggers: triggerList(doc && doc.on),
            matrixJobs: jobIds.filter((id) => doc.jobs[id].strategy && doc.jobs[id].strategy.matrix).length,
            parseError: error
        });
    }

    return {
        name: path.basename(cwd),
        root: cwd,
        aeroci: VERSION,
        node: process.versions.node,
        host: `${os.platform()} ${os.arch()}`,
        workflows,
        counts: {
            workflows: workflows.length,
            jobs: workflows.reduce((n, w) => n + w.jobs, 0),
            steps: workflows.reduce((n, w) => n + w.steps, 0),
            parseErrors
        }
    };
}

function analyseOne(cwd, full) {
    const rel = path.relative(cwd, full);
    let doc;
    try {
        doc = yaml.load(fs.readFileSync(full, 'utf8'), { filename: full });
    } catch (err) {
        return { file: rel, error: err.message.split('\n')[0] };
    }
    if (!doc || !doc.jobs) return { file: rel, error: 'no jobs' };

    const analysis = Analyzer.analyzeWorkflow(doc);
    const security = Security.auditWorkflow(doc, rel);
    const deduped = dedupeSecurity(security);

    return {
        file: rel,
        name: doc.name || path.basename(full),
        complexity: analysis.complexity,
        topology: analysis.topology,
        deadSteps: analysis.deadSteps,
        unusedOutputs: analysis.unusedOutputs,
        redundantJobs: analysis.redundantJobs || [],
        matrices: analysis.matrix,
        security: { findings: deduped, counts: countByLevel(deduped) }
    };
}

/** Same de-duplication the security module applies before printing. */
function dedupeSecurity(findings) {
    const seen = new Map();
    for (const finding of findings) {
        const key = [finding.file, finding.rule, finding.location, finding.title].join('|');
        if (!seen.has(key)) seen.set(key, finding);
    }
    return [...seen.values()];
}

function triggerList(on) {
    if (!on) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String);
    if (typeof on === 'object') return Object.keys(on);
    return [];
}

/** Resolve a request path inside the project, or null if it escapes. */
function resolveInside(root, relative) {
    const full = path.resolve(root, relative);
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return full === root || full.startsWith(withSep) ? full : null;
}

function fallbackPage(cwd) {
    const { workflows, counts } = describeProject(cwd);
    const rows = workflows.map((w) => `<tr><td><code>${w.file}</code></td><td>${w.name}</td>`
        + `<td>${w.jobs}</td><td>${w.steps}</td><td>${w.triggers.map((t) => `<code>${t}</code>`).join(' ')}</td></tr>`).join('\n');

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>AeroCI ${VERSION}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:.4rem .6rem;text-align:left}
th{background:#f6f8fa}code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}</style></head><body>
<h1>AeroCI</h1>
<p>${counts.workflows} workflow(s) · ${counts.jobs} job(s) · ${counts.steps} step(s)${counts.parseErrors ? ` · <strong>${counts.parseErrors} parse error(s)</strong>` : ''}</p>
<table><thead><tr><th>File</th><th>Name</th><th>Jobs</th><th>Steps</th><th>Triggers</th></tr></thead>
<tbody>${rows}</tbody></table>
<p><a href="/api/status">/api/status</a> · <a href="/api/workflows">/api/workflows</a> · <a href="/api/history">/api/history</a></p>
</body></html>`;
}

module.exports = { Server, describeProject };
