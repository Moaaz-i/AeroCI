/**
 * The GITHUB_* file protocol — how a step publishes outputs, env vars and
 * summaries. Implemented with the real format including the heredoc form:
 *
 *   KEY=value
 *   KEY<<EOF
 *   multi
 *   line
 *   EOF
 */

const fs = require('fs');
const path = require('path');

class CommandFile {
    constructor(filePath, kind) {
        this.path = filePath;
        this.kind = kind; // 'env' | 'output' | 'path' | 'state' | 'summary'
        this.pending = [];
        this.used = false;
    }

    reset() {
        this.pending = [];
        this.used = false;
    }

    /** Parse the whole file and hand back { key: value } in file order. */
    drain() {
        if (!this.path || !fs.existsSync(this.path)) return {};
        let content;
        try { content = fs.readFileSync(this.path, 'utf8'); }
        catch (_) { return {}; }

        const values = this._parse(content);
        try { fs.writeFileSync(this.path, ''); } catch (_) {}
        return values;
    }

    appendLine(text) {
        if (!this.path) return;
        try { fs.appendFileSync(this.path, text.endsWith('\n') ? text : text + '\n'); }
        catch (_) {}
    }

    appendSummary(markdown) {
        if (!this.path) return;
        try { fs.appendFileSync(this.path, markdown.endsWith('\n') ? markdown : markdown + '\n'); }
        catch (_) {}
    }

    _parse(content) {
        const out = {};
        const lines = content.split(/\r?\n/);
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            if (!line || !line.trim()) { i++; continue; }

            const heredoc = /^([A-Za-z_][A-Za-z0-9_-]*)<<(\S+)$/.exec(line);
            if (heredoc) {
                const [, key, delimiter] = heredoc;
                const body = [];
                i++;
                while (i < lines.length && lines[i] !== delimiter) {
                    body.push(lines[i]);
                    i++;
                }
                i++; // consume the delimiter line
                out[key] = body.join('\n');
                continue;
            }

            const eq = line.indexOf('=');
            if (eq === -1) { i++; continue; }
            const key = line.slice(0, eq).trim();
            out[key] = line.slice(eq + 1);
            i++;
        }
        return out;
    }
}

/** The set of files a step is allowed to publish through. */
class FileCommandSet {
    constructor(sandboxDir, runnerTemp) {
        this.dir = sandboxDir;
        this.runnerTemp = runnerTemp;
        this.env = new CommandFile(path.join(sandboxDir, '.aeroci', 'env'), 'env');
        this.output = new CommandFile(path.join(sandboxDir, '.aeroci', 'output'), 'output');
        this.state = new CommandFile(path.join(sandboxDir, '.aeroci', 'state'), 'state');
        this.path = new CommandFile(path.join(sandboxDir, '.aeroci', 'path'), 'path');
        this.summary = new CommandFile(path.join(sandboxDir, '.aeroci', 'summary'), 'summary');
        this.all = [this.env, this.output, this.state, this.path, this.summary];
        fs.mkdirSync(path.join(sandboxDir, '.aeroci'), { recursive: true });
        for (const f of this.all) f.reset();
        this.summary.appendSummary('## AeroCI run summary\n\n');
    }

    /** Called between jobs: the runner clears job-scoped state. */
    resetJobScoped() {
        for (const f of [this.env, this.output, this.state, this.path]) f.reset();
    }

    envVars() {
        const values = this.env.drain();
        const out = {};
        for (const [k, v] of Object.entries(values)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                process.emitWarning(`Ignoring invalid environment variable name from GITHUB_ENV: ${k}`);
                continue;
            }
            out[k] = v;
        }
        return out;
    }

    stepOutputs() { return this.output.drain(); }
    savedState() { return this.state.drain(); }
    addedPaths() { return this.path.drain(); }
}

module.exports = { CommandFile, FileCommandSet };
