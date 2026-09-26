/**
 * Local actions: `uses: ./path/to/action`.
 *
 * Real support for the two runtimes that work without a container:
 *   • composite → its `run:` steps are inlined into the job, with
 *     `github.action_path` pointing at the action directory
 *   • node      → `main:` is executed with node when the bundle is present
 * Docker actions are reported as unsupported instead of silently passing.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CANDIDATE_FILES = ['action.yml', 'action.yaml'];

function findActionFile(root) {
    for (const name of CANDIDATE_FILES) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function parseLocalAction(actionPath) {
    const file = findActionFile(actionPath);
    if (!file) {
        return { valid: false, error: `no action.yml or action.yaml in ${actionPath}` };
    }
    let doc;
    try {
        doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return { valid: false, error: `${path.basename(file)} is not valid YAML: ${err.message}` };
    }
    if (!doc || !doc.runs) {
        return { valid: false, error: `${path.basename(file)} has no "runs" section` };
    }
    return {
        valid: true,
        file,
        dir: path.dirname(file),
        name: doc.name || path.basename(actionPath),
        description: doc.description || '',
        inputs: doc.inputs || {},
        outputs: doc.outputs || {},
        runs: doc.runs,
        branding: doc.branding || null
    };
}

/** Is the entry script present and runnable for a node/docker action? */
function entryExists(action) {
    const main = action.runs?.main;
    if (!main) return false;
    return fs.existsSync(path.join(action.dir, main));
}

module.exports = { parseLocalAction, findActionFile, entryExists, CANDIDATE_FILES };
