/**
 * .aeroci.json configuration loader.
 *
 * Every knob has a safe default so an absent or partial file still works, and an
 * unknown/invalid field never crashes the CLI.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_NAME = '.aeroci.json';

const DEFAULTS = {
    version: 1,
    workflows: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
    envFile: '.env',
    strictSecrets: true,
    vars: {},
    secrets: {},
    runner: {
        shell: null,          // null → GitHub's default (bash on posix, pwsh on Windows)
        timeoutMinutes: 10,
        maxOutputLines: 200
    },
    sandbox: {
        // 'copy' drops the excluded paths entirely, which is what a real
        // checkout looks like. 'link' symlinks them to the real ones instead:
        // not faster — the copy skips them either way — but it lets a step use
        // your installed node_modules, at the cost of a step that writes into
        // them editing the real files.
        //
        // `.env` is in the list because a runner has no `.env`: it feeds the
        // `secrets` context and nothing else. Copying it in put every secret
        // you own — including the ones this workflow never references — one
        // `cat` away from any step, and one `upload-artifact` away from a
        // report you were about to share. `mode: 'link'` is the way to have it
        // present again, and the run announces that it has done so.
        mode: 'copy',
        exclude: ['.git', 'node_modules', '.aeroci-artifacts', '.next', 'dist', 'build',
                  'target', 'vendor', '.venv', '__pycache__', 'coverage', '.env'],
        keep: false           // keep the sandbox after the run (debugging)
    },
    toolchain: {
        // Downloading a runtime (Node and friends) is the one thing AeroCI does
        // that reaches the network during a run, so it never happens on its own.
        // null means the user has not been asked yet; the first time a workflow
        // needs a version this machine does not have, AeroCI asks once and
        // records the answer here. `--allow-download` / `--no-download` override
        // it for a single run without touching this file.
        allowDownload: null
    }
};

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
    if (!isPlainObject(override)) return base;
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(override)) {
        out[k] = (isPlainObject(v) && isPlainObject(base?.[k])) ? deepMerge(base[k], v) : v;
    }
    return out;
}

class Config {
    constructor(cwd) {
        this.cwd = cwd;
        this.path = path.join(cwd, CONFIG_NAME);
        this.loaded = false;
        this.errors = [];
        this.data = deepMerge(DEFAULTS, {});
    }

    load() {
        if (this.loaded) return this;
        this.loaded = true;
        if (!fs.existsSync(this.path)) return this;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
            if (!isPlainObject(parsed)) {
                this.errors.push(`${CONFIG_NAME} must contain a JSON object`);
                return this;
            }
            this.data = deepMerge(DEFAULTS, parsed);
        } catch (err) {
            this.errors.push(`${CONFIG_NAME} is not valid JSON: ${err.message}`);
        }
        return this;
    }

    get raw() { return this.data; }

    get workflowGlobs() {
        const g = this.data.workflows;
        return Array.isArray(g) && g.length ? g : DEFAULTS.workflows;
    }

    get envFile() {
        return path.resolve(this.cwd, this.data.envFile || '.env');
    }

    get strictSecrets() { return this.data.strictSecrets !== false; }

    get runner() { return this.data.runner || DEFAULTS.runner; }

    get sandbox() { return this.data.sandbox || DEFAULTS.sandbox; }

    get toolchain() { return this.data.toolchain || DEFAULTS.toolchain; }

    /**
     * Whether a runtime may be downloaded, or null when nobody has decided yet.
     * @returns {boolean|null}
     */
    get allowDownload() {
        const value = this.toolchain.allowDownload;
        return value === true || value === false ? value : null;
    }

    /**
     * Record the answer to "may AeroCI download a runtime?" so the question is
     * asked once. The rest of the file is preserved: this rewrites the whole
     * document, so a user's own keys and comments' neighbours must survive.
     *
     * A file that cannot be written is not an error the run should die on — the
     * answer is still in effect for this run.
     *
     * @param {boolean} allowed
     * @returns {boolean} whether it reached disk
     */
    saveAllowDownload(allowed) {
        this.data.toolchain = { ...this.toolchain, allowDownload: !!allowed };
        try {
            fs.writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
            return true;
        } catch (err) {
            this.errors.push(`could not save ${CONFIG_NAME}: ${err.message}`);
            return false;
        }
    }

    get vars() { return isPlainObject(this.data.vars) ? this.data.vars : {}; }

    get secrets() { return isPlainObject(this.data.secrets) ? this.data.secrets : {}; }

    /** Default exclude list, merged with user additions. */
    get sandboxExcludes() {
        const extra = Array.isArray(this.sandbox.exclude) ? this.sandbox.exclude : [];
        return [...new Set([...DEFAULTS.sandbox.exclude, ...extra])];
    }
}

function loadConfig(cwd = process.cwd()) {
    return new Config(cwd).load();
}

module.exports = { Config, loadConfig, DEFAULTS, CONFIG_NAME };
