/**
 * Local artifact store backing actions/upload-artifact & download-artifact.
 *
 * Uploads really archive the files (tar.gz), downloads really extract them, so
 * `needs: build` → upload → download → use is a working pattern locally.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../utils/exec');

class ArtifactStore {
    constructor(rootDir) {
        this.root = rootDir;
        fs.mkdirSync(this.root, { recursive: true });
    }

    _safeName(name) {
        return String(name || 'artifact').replace(/[^\w.-]/g, '_');
    }

    dir(name) { return path.join(this.root, this._safeName(name)); }

    list() {
        try {
            return fs.readdirSync(this.root, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch (_) { return []; }
    }

    exists(name) { return fs.existsSync(this.dir(name)); }

    async upload({ name, paths, workspace, retentionDays }) {
        const target = this.dir(name);
        fs.mkdirSync(target, { recursive: true });
        const clean = [...new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean))];
        const existing = clean.filter((p) => fs.existsSync(path.resolve(workspace, p)));
        const missing = clean.filter((p) => !fs.existsSync(path.resolve(workspace, p)));

        let fileCount = 0;
        for (const rel of existing) {
            const abs = path.resolve(workspace, rel);
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                fileCount += countFiles(abs);
            } else {
                fileCount++;
            }
        }

        if (existing.length === 0) {
            return { success: true, warning: 'no existing files matched the upload paths', fileCount: 0, missing };
        }

        // Tar the matched paths relative to the workspace.
        const tarball = path.join(target, 'artifact.tar.gz');
        const tarArgs = ['-czf', tarball, '-C', workspace, ...existing];
        const res = await run('tar', tarArgs, { cwd: workspace, timeoutMs: 120000 });

        fs.writeFileSync(path.join(target, 'artifact.json'), JSON.stringify({
            name, paths: existing, missing,
            retentionDays: retentionDays ?? 0,
            uploadedAt: new Date().toISOString(),
            fileCount
        }, null, 2));

        if (res.code !== 0) {
            return { success: false, error: res.stderr.trim() || 'tar failed', fileCount, missing };
        }
        return { success: true, fileCount, missing, sizeBytes: fs.statSync(tarball).size };
    }

    async download({ name, path: destRel, workspace }) {
        const source = this.dir(name);
        const tarball = path.join(source, 'artifact.tar.gz');
        if (!fs.existsSync(tarball)) {
            return { success: false, error: `artifact "${name}" was never uploaded in this run` };
        }
        const dest = path.resolve(workspace, destRel || '.');
        fs.mkdirSync(dest, { recursive: true });
        const res = await run('tar', ['-xzf', tarball, '-C', dest], { cwd: dest, timeoutMs: 120000 });
        if (res.code !== 0) {
            return { success: false, error: res.stderr.trim() || 'extract failed' };
        }
        return { success: true, destination: destRel || '.', fileCount: countFiles(dest) };
    }
}

function countFiles(dir, depth = 0) {
    if (depth > 20) return 0;
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return 0; }
    for (const e of entries) {
        if (e.isDirectory()) total += countFiles(path.join(dir, e.name), depth + 1);
        else total++;
    }
    return total;
}

module.exports = { ArtifactStore, countFiles };
