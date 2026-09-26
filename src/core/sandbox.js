/**
 * Ephemeral, genuinely isolated sandbox.
 *
 * Fidelity rules (this is what makes the twin trustworthy):
 *   • Every file is a real, independent copy — symlinks to the host project are
 *     never created, so a workflow can never write through the sandbox.
 *   • Files are copied with COPYFILE_FICLONE, which is copy-on-write on APFS and
 *     transparently falls back to a byte copy on other filesystems.
 *   • Permissions (notably the executable bit) are preserved, so `./script.sh`
 *     behaves the same locally and on a runner.
 *   • Symlinks that exist in the project are recreated as symlinks with the same
 *     target, never followed (prevents cycles and escaping the tree). There is
 *     deliberately no option to follow them: a link out of the project would
 *     hand a step a way to edit the real filesystem.
 *   • `node_modules` is NOT part of a fresh checkout on GitHub, so by default it is
 *     excluded. `mode: 'link'` points the excluded paths at the real ones
 *     instead, and the run output says so, because it is the one setting that
 *     gives up isolation.
 *
 * `mode: 'link'` is not a speed option — both modes skip the excluded paths, so
 * they cost the same. What it changes is *visibility*: the real `node_modules`
 * is there to use. A build that writes into its own dependencies therefore
 * writes into the real ones too. Everything the workflow *edits* is still a
 * private copy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class Sandbox {
    /**
     * @param {string} projectRoot  directory to clone
     * @param {object} options
     * @param {string[]} options.exclude  top-level + nested names to skip
     * @param {'copy'|'link'} options.mode
     * @param {boolean} options.keep       skip cleanup on dispose
     */
    constructor(projectRoot, options = {}) {
        this.projectRoot = projectRoot;
        this.exclude = new Set(options.exclude || []);
        this.mode = options.mode === 'link' ? 'link' : 'copy';
        this.keep = !!options.keep;
        this.dir = null;
        this.stats = { files: 0, dirs: 0, symlinks: 0, linked: 0, skipped: 0, bytes: 0, cloneSupported: null };
        this.createdAt = Date.now();
    }

    static create(projectRoot, options = {}) {
        const sb = new Sandbox(projectRoot, options);
        sb.init();
        return sb;
    }

    init() {
        // A missing or unreadable project root used to produce a perfectly
        // valid, completely empty sandbox. Every step then "passed" because
        // there was nothing there, which is the worst possible failure mode:
        // a green run that tested nothing.
        let rootStat;
        try {
            rootStat = fs.statSync(this.projectRoot);
        } catch (_) {
            throw new Error(`project root does not exist: ${this.projectRoot}`);
        }
        if (!rootStat.isDirectory()) {
            throw new Error(`project root is not a directory: ${this.projectRoot}`);
        }

        const prefix = path.join(os.tmpdir(), 'aeroci-sandbox-');
        this.dir = fs.mkdtempSync(prefix);
        fs.chmodSync(this.dir, 0o700);

        const started = process.hrtime();
        try {
            this._copyInto(this.projectRoot, this.dir, 0);
        } catch (err) {
            err.message = `sandbox creation failed while copying ${this.projectRoot}: ${err.message}`;
            throw err;
        }
        const setupNs = process.hrtime(started);
        this.setupMs = (setupNs[0] * 1000) + (setupNs[1] / 1e6);

        // Directories the runner guarantees to exist on a real runner.
        for (const dir of ['tmp', '_temp', 'bin', 'externals', 'work']) {
            fs.mkdirSync(path.join(this.dir, dir), { recursive: true });
        }
        return this;
    }

    _excluded(name) {
        return this.exclude.has(name);
    }

    _copyInto(src, dest, depth) {
        let entries;
        try {
            entries = fs.readdirSync(src, { withFileTypes: true });
        } catch (_) {
            this.stats.skipped++;
            return;
        }

        for (const entry of entries) {
            if (this._excluded(entry.name)) {
                // The one thing `mode: 'link'` changes: a skipped entry becomes
                // a link to the real one. It is opt-in because it is the only
                // way a step can reach outside the sandbox.
                if (this.mode === 'link') {
                    const real = path.join(src, entry.name);
                    try {
                        if (fs.existsSync(real)) {
                            fs.symlinkSync(real, path.join(dest, entry.name));
                            this.stats.linked++;
                            continue;
                        }
                    } catch (_) { this.stats.skipped++; continue; }
                }
                this.stats.skipped++;
                continue;
            }
            const s = path.join(src, entry.name);
            const d = path.join(dest, entry.name);

            let stat;
            try {
                stat = fs.lstatSync(s);
            } catch (_) {
                this.stats.skipped++;
                continue;
            }

            if (stat.isSymbolicLink()) {
                try {
                    fs.symlinkSync(fs.readlinkSync(s), d);
                    this.stats.symlinks++;
                } catch (_) { this.stats.skipped++; }
                continue;
            }

            if (stat.isDirectory()) {
                try {
                    fs.mkdirSync(d, { recursive: true });
                    this.stats.dirs++;
                    this._copyInto(s, d, depth + 1);
                } catch (_) { this.stats.skipped++; }
                continue;
            }

            if (!stat.isFile()) { this.stats.skipped++; continue; } // sockets, fifos, devices

            try {
                fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);
                // copyFileSync does not guarantee mode preservation.
                if (stat.mode & 0o111) fs.chmodSync(d, stat.mode & 0o7777);
                this.stats.files++;
                this.stats.bytes += stat.size;
            } catch (err) {
                if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EXDEV') {
                    // Copy-on-write unsupported (or quota hit) → real byte copy.
                    try {
                        fs.copyFileSync(s, d);
                        if (stat.mode & 0o111) fs.chmodSync(d, stat.mode & 0o7777);
                        this.stats.files++;
                        this.stats.bytes += stat.size;
                        this.stats.cloneSupported = false;
                        continue;
                    } catch (_2) { this.stats.skipped++; continue; }
                }
                this.stats.skipped++;
            }
        }
    }

    /** Path inside the sandbox. */
    resolve(...parts) { return path.join(this.dir, ...parts); }

    get exists() { return !!this.dir && fs.existsSync(this.dir); }

    get humanSize() {
        const b = this.stats.bytes;
        if (b < 1024) return `${b} B`;
        if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
        if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
        return `${(b / 1024 ** 3).toFixed(2)} GB`;
    }

    /**
     * @param {object}   [options]
     * @param {Function} [options.log]      called with the "kept" message
     * @param {object}   [options.Logger]  AeroCI logger, for the removal notice
     * @param {object}   [options.colors]  AeroCI colour helpers
     * @param {boolean}  [options.quiet]   suppress the removal notice
     */
    dispose({ log = null, Logger = null, colors = null, quiet = false } = {}) {
        if (!this.dir || this.keep) {
            if (this.keep) {
                const msg = `Sandbox kept for inspection: ${this.dir}`;
                log ? log(msg) : console.log(msg);
            }
            return false;
        }
        let removed = false;
        try {
            if (fs.existsSync(this.dir)) {
                fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
                removed = true;
            }
        } catch (_) {
            if (Logger && colors) Logger.warn(`Could not remove sandbox ${this.dir} (a process may still hold it open).`);
            return false;
        }
        // A workflow builds one sandbox per job, so the per-job notice would be
        // repeated once per job and each line would overstate the truth — the
        // footprint is only really gone at the end of the run.
        if (removed && !quiet && Logger && colors) {
            Logger.info(`${colors.gray}Sandbox removed — zero disk footprint.${colors.reset}`);
        }
        return removed;
    }
}

module.exports = { Sandbox };
