/**
 * GitHub Actions shell resolution.
 *
 * The runner picks a shell per step and invokes it with an exact argument
 * vector. Reproducing this is what makes multi-line scripts fail on the first
 * error (bash's `-e`) instead of silently continuing.
 *
 *   bash      →  bash --noprofile --norc -eo pipefail {0}
 *   sh        →  sh -e {0}
 *   python    →  python {0}
 *   pwsh      →  pwsh -command ". '{0}'"
 *   custom    →  command [options] {0}
 *   default   →  bash on POSIX, pwsh on Windows
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';

/** GitHub's default when `shell:` is omitted. */
function defaultShellKeyword() {
    return isWindows ? 'pwsh' : 'bash';
}

/**
 * @param {string|undefined} declared  the workflow's `shell:` value
 * @param {string} runnerOs           simulated RUNNER_OS
 * @returns {{command:string, args:string[], keyword:string, label:string, available:boolean}}
 */
function resolveShell(declared, runnerOs = isWindows ? 'Windows' : 'Linux') {
    const windows = runnerOs === 'Windows';
    const value = (declared === undefined || declared === null || declared === '')
        ? defaultShellKeyword()
        : String(declared);

    // Custom shell: "command [options…] {0}"
    if (value.includes('{0}')) {
        const tokenized = tokenizeShellLine(value);
        const command = tokenized.shift();
        const args = tokenized.map((a) => (a === '{0}' ? '{0}' : a));
        return {
            command, args, keyword: 'custom', label: value,
            available: !!findExecutable(command)
        };
    }

    switch (value) {
        case 'bash': {
            const bin = findExecutable('bash');
            return {
                command: bin || 'bash',
                args: ['--noprofile', '--norc', '-eo', 'pipefail', '{0}'],
                keyword: 'bash', label: 'bash', available: !!bin
            };
        }
        case 'sh': {
            const bin = findExecutable('sh');
            return {
                command: bin || 'sh',
                args: ['-e', '{0}'],
                keyword: 'sh', label: 'sh', available: !!bin
            };
        }
        case 'python': {
            const bin = findExecutable('python3') || findExecutable('python');
            return {
                command: bin || 'python',
                args: ['{0}'],
                keyword: 'python', label: 'python', available: !!bin
            };
        }
        case 'python3': {
            const bin = findExecutable('python3') || findExecutable('python');
            return {
                command: bin || 'python3',
                args: ['{0}'],
                keyword: 'python3', label: 'python3', available: !!bin
            };
        }
        case 'pwsh': {
            const bin = findExecutable('pwsh') || findExecutable('powershell');
            return {
                command: bin || 'pwsh',
                args: ['-command', ". '{0}'"],
                keyword: 'pwsh', label: 'pwsh', available: !!bin
            };
        }
        case 'powershell': {
            const bin = findExecutable('pwsh') || findExecutable('powershell');
            return {
                command: bin || 'pwsh',
                args: ['-command', ". '{0}'"],
                keyword: 'powershell', label: 'powershell', available: !!bin
            };
        }
        case 'cmd': {
            const bin = findExecutable('cmd');
            return {
                command: bin || 'cmd',
                args: ['/D', '/E:ON', '/V:OFF', '/S', '/C', 'CALL "{0}"'],
                keyword: 'cmd', label: 'cmd', available: !!bin
            };
        }
        default:
            // An unknown keyword is a workflow error; surface it instead of guessing.
            return {
                command: value, args: ['{0}'], keyword: value, label: value,
                available: !!findExecutable(value), unknown: true
            };
    }
}

function tokenizeShellLine(line) {
    const out = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) { quote = null; continue; }
            current += c;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (/\s/.test(c)) {
            if (current) { out.push(current); current = ''; }
            continue;
        }
        current += c;
    }
    if (current) out.push(current);
    return out;
}

const execCache = new Map();
function findExecutable(name) {
    if (!name) return null;
    if (execCache.has(name)) return execCache.get(name);
    const found = which(name);
    execCache.set(name, found);
    return found;
}

function which(bin) {
    if (bin.includes('/') || bin.includes(path.sep)) {
        return isExecutableFile(bin) ? bin : null;
    }
    const pathVar = process.env.PATH || '';
    for (const dir of pathVar.split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, bin);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

function isExecutableFile(p) {
    try {
        const stat = fs.statSync(p);
        if (!stat.isFile()) return false;
        if (isWindows) return true;
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch (_) {
        return false;
    }
}

/** Environment additions every GitHub-hosted runner exports. */
function runnerEnvironment() {
    // The real tool cache, not /opt/hostedtoolcache: that path exists on a
    // Microsoft-hosted runner and nowhere else, so on a laptop it named a
    // directory that had never been created.
    const toolCache = require('./toolchain').cacheRoot();
    const base = {
        AGENT_TOOLSDIRECTORY: toolCache,
        GITHUB_PATH: '',
        GITHUB_ENV: '',
        GITHUB_OUTPUT: '',
        GITHUB_STATE: '',
        GITHUB_STEP_SUMMARY: '',
        RUNNER_TOOL_CACHE: toolCache,
        ImageOS: isWindows ? 'windows22' : (os.release() || 'linux'),
        ImageVersion: 'local'
    };
    return base;
}

module.exports = { resolveShell, defaultShellKeyword, runnerEnvironment, which, isWindows };
