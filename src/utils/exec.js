/**
 * Process execution with real GitHub Actions semantics:
 *  - the child runs in its own process group so timeouts can kill the whole tree
 *  - stdout and stderr are captured separately and bounded
 *  - the caller decides how the shell is invoked (see core/shell.js)
 */

const { spawn } = require('child_process');

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024; // 4 MiB per stream
const KILL_GRACE_MS = 2000;

class BoundedBuffer {
    constructor(limit = MAX_CAPTURE_BYTES) {
        this.limit = limit;
        this.chunks = [];
        this.size = 0;
        this.truncated = false;
    }
    push(chunk) {
        if (this.size >= this.limit) { this.truncated = true; return; }
        const room = this.limit - this.size;
        if (chunk.length > room) {
            this.chunks.push(chunk.subarray(0, room));
            this.size = this.limit;
            this.truncated = true;
        } else {
            this.chunks.push(chunk);
            this.size += chunk.length;
        }
    }
    toString() { return Buffer.concat(this.chunks).toString('utf8'); }
}

/**
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string,
 *                    timedOut:boolean, durationMs:number, truncated:boolean, spawnError:Error|null}>}
 */
function run(command, args, options = {}) {
    const {
        cwd,
        env,
        timeoutMs = 0,
        onStdout,
        onStderr,
        inheritStdio = false
    } = options;

    const started = process.hrtime();
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env,
                // Own process group → we can signal the entire tree on timeout.
                detached: process.platform !== 'win32',
                stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });
        } catch (err) {
            return resolve({
                code: null, signal: null, stdout: '', stderr: '',
                timedOut: false, durationMs: 0, truncated: false, spawnError: err
            });
        }

        const out = new BoundedBuffer();
        const errBuf = new BoundedBuffer();
        let timedOut = false;
        let settled = false;
        let killTimer = null;
        let graceTimer = null;

        const cleanup = () => {
            if (killTimer) clearTimeout(killTimer);
            if (graceTimer) clearTimeout(graceTimer);
        };

        const killTree = (signal) => {
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    // Negative pid → the whole process group.
                    process.kill(-child.pid, signal);
                }
            } catch (_) {
                try { child.kill(signal); } catch (_2) {}
            }
        };

        if (timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                killTree('SIGTERM');
                graceTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
            }, timeoutMs);
        }

        child.stdout?.on('data', (c) => { out.push(c); onStdout?.(c.toString('utf8')); });
        child.stderr?.on('data', (c) => { errBuf.push(c); onStderr?.(c.toString('utf8')); });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                code: null, signal: null, stdout: out.toString(), stderr: errBuf.toString(),
                timedOut, durationMs: elapsed(started), truncated: out.truncated || errBuf.truncated,
                spawnError: err
            });
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                code, signal,
                stdout: out.toString(), stderr: errBuf.toString(),
                timedOut,
                durationMs: elapsed(started),
                truncated: out.truncated || errBuf.truncated,
                spawnError: null
            });
        });
    });
}

function elapsed(start) {
    const [s, ns] = process.hrtime(start);
    return s * 1000 + ns / 1e6;
}

module.exports = { run, BoundedBuffer, MAX_CAPTURE_BYTES };
