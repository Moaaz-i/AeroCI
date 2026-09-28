/**
 * .aeroci.json configuration loader.
 *
 * Every knob has a safe default so an absent or partial file still works, and an
 * unknown/invalid field never crashes the CLI.
 *
 * This file configures a *project*. It deliberately cannot configure the network
 * policy: a `network` key written here is refused, with a message naming the file
 * that can. `.aeroci.json` is content that arrives with a repository, and a
 * repository is exactly the thing that must not be able to grant itself the
 * ability to reach the network — see `network.js`. Silently ignoring the key
 * would be its own dishonesty, so it is reported instead.
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
    }
};

/**
 * Keys that used to live here and now do not.
 *
 * These are reported rather than ignored, because somebody upgrading will have
 * this in their file and a silent no-op looks exactly like a bug. Each entry says
 * where the setting went, so the message is a fix and not just a complaint.
 */
function whereItLives() {
    return require('./network').configPathLabel();
}

const RELOCATED = {
    network: 'a project cannot grant network access to itself',
    toolchain: 'now "network"',
    allowDownload: 'now "network.allowRuntimeDownloads"',
    'network.allowRuntimeDownloads': 'a project cannot grant it',
    'network.allowWorkflowNetwork': 'a project cannot grant it',
    'toolchain.allowDownload': 'now "network.allowRuntimeDownloads"'
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
            // Stripped before the merge, so a project cannot widen its own reach
            // by writing keys this loader happens to understand.
            this._rejectRelocated(parsed);
            this.data = deepMerge(DEFAULTS, parsed);
        } catch (err) {
            this.errors.push(`${CONFIG_NAME} is not valid JSON: ${err.message}`);
        }
        return this;
    }

    /**
     * Strip the network policy out of the project file, and say so.
     *
     * Reporting without stripping would be the worst of both: the user is told
     * the key was ignored while `deepMerge` quietly hands it to the rest of the
     * program. The keys are deleted from the parsed object *before* the merge, so
     * the policy in `~/.aeroci/config.json` stands whatever this file claims.
     *
     * The message names the file that does hold the setting, because a user who
     * just typed `"network": { "allowWorkflowNetwork": true }` deserves to be
     * told where to put it rather than only that it did not work.
     *
     * @param {object} parsed the file as read from disk, modified in place
     * @returns {string[]} the full paths that were removed
     */
    _rejectRelocated(parsed) {
        // Collected before anything is deleted. Deleting the `network` container
        // first would erase the evidence of the key inside it, and the message
        // would name a container instead of the thing the user actually typed.
        const found = [];
        const drop = [];
        for (const key of Object.keys(parsed)) {
            if (Object.prototype.hasOwnProperty.call(RELOCATED, key)) found.push(key);
        }
        for (const container of ['network', 'toolchain']) {
            const nested = parsed[container];
            if (!isPlainObject(nested)) continue;
            for (const key of Object.keys(nested)) {
                const full = `${container}.${key}`;
                if (Object.prototype.hasOwnProperty.call(RELOCATED, full)) found.push(full);
            }
        }
        for (const key of found) {
            const parts = key.split('.');
            if (parts.length === 2) {
                const [container, leaf] = parts;
                if (parsed[container] && isPlainObject(parsed[container])) {
                    delete parsed[container][leaf];
                }
            } else if (parts.length === 1) {
                drop.push(parts[0]);
            }
        }
        for (const container of drop) delete parsed[container];

        if (!found.length) return found;
        const where = whereItLives();
        const detail = found.map((key) => `${key} (${RELOCATED[key]})`).join(', ');
        this.errors.push(
            `${CONFIG_NAME} cannot set ${detail} — the network policy is a decision about this ` +
            `machine, not about the repository, and it lives in ${where}. ` +
            'Those keys were ignored; the recorded answer still stands.'
        );
        return found;
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
