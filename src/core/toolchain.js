/**
 * Toolchain manager: real, versioned runtimes for the sandbox.
 *
 * `actions/setup-node` used to print a warning and then keep using whatever
 * Node the host happened to have. A workflow pinned to Node 18 therefore ran its
 * entire test suite on Node 26 and finished green — a passing run that
 * verified nothing the workflow asked for. Quietly substituting one runtime for
 * another is worse than refusing, so this module makes the request real:
 *
 *   1. resolve the requested spec against nodejs.org's official release index,
 *      so `18` means a concrete build such as 18.20.8 and not the string "18";
 *   2. download that exact build for this platform;
 *   3. verify it against the SHASUMS256.txt published beside it;
 *   4. unpack it into a cache under the user's home directory, so the next run
 *      of the same workflow costs nothing.
 *
 * The install is global on purpose. Node 18 is the same forty megabytes whoever
 * asks for it, so a per-project copy would re-download it for every repository
 * and would also vanish on `rm -rf node_modules`. It lands in
 * `~/.aeroci/runtimes/node/`, with everything else AeroCI keeps between runs.
 *
 * Downloading reaches the network, so it never happens silently. The decision is
 * asked once and recorded in `~/.aeroci/config.json` — see `network.js`, which
 * owns that decision and every other one about the network.
 *
 * When it is refused the caller is told, and the step fails. The whole point of
 * installing a real runtime is that the job then runs on the one the workflow
 * asked for; running it on a different one and reporting success is the exact
 * lie this module was written to remove.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const DIST = 'https://nodejs.org/dist';
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 5;

/**
 * How this host maps onto a nodejs.org artifact.
 *
 * The `token` is the name used inside index.json's `files` array, which is not
 * the same string as the artifact itself: the index calls macOS "osx" while the
 * download is called "darwin". Getting this wrong downloads a file that does not
 * exist, so the two names are kept apart on purpose.
 */
const PLATFORMS = {
    'darwin-arm64': { token: 'osx-arm64-tar', dist: 'darwin-arm64', ext: 'tar.gz', alias: 'arm64' },
    'darwin-x64': { token: 'osx-x64-tar', dist: 'darwin-x64', ext: 'tar.gz', alias: 'x64' },
    'linux-x64': { token: 'linux-x64', dist: 'linux-x64', ext: 'tar.gz', alias: 'x64' },
    'linux-arm64': { token: 'linux-arm64', dist: 'linux-arm64', ext: 'tar.gz', alias: 'arm64' },
    'linux-arm': { token: 'linux-armv7l', dist: 'linux-armv7l', ext: 'tar.gz', alias: 'arm' },
    'linux-ppc64': { token: 'linux-ppc64le', dist: 'linux-ppc64le', ext: 'tar.gz', alias: 'ppc64le' },
    'linux-s390x': { token: 'linux-s390x', dist: 'linux-s390x', ext: 'tar.gz', alias: 's390x' },
    'win-x64': { token: 'win-x64-zip', dist: 'win-x64', ext: 'zip', alias: 'x64' },
    'win-arm64': { token: 'win-arm64-zip', dist: 'win-arm64', ext: 'zip', alias: 'arm64' }
};

/** The platform entry for the machine AeroCI is running on, or null. */
function currentPlatform() {
    const p = process.platform;
    const a = process.arch;
    if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : (a === 'x64' ? 'darwin-x64' : null);
    if (p === 'win32') return a === 'x64' ? 'win-x64' : (a === 'arm64' ? 'win-arm64' : null);
    if (p === 'linux') {
        if (a === 'x64') return 'linux-x64';
        if (a === 'arm64') return 'linux-arm64';
        if (a === 'arm') return 'linux-arm';
        if (a === 'ppc64') return 'linux-ppc64';
        if (a === 's390x') return 'linux-s390x';
    }
    return null;
}

// ── versions ──────────────────────────────────────────────────────────────────

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A spec arrives from YAML, from a file, or from a flag, and may be any of
 *  those in any of their absent forms. Every parser funnels through here so
 *  `node-version:` with no value cannot become a crash. */
function asText(value) {
    return value === null || value === undefined ? '' : String(value).trim();
}

function parseVersion(value) {
    const m = VERSION_RE.exec(asText(value));
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

function v(major, minor, patch, pre = null) {
    return { major, minor, patch, pre };
}

/**
 * Order two prerelease suffixes. A missing suffix is the newest thing there is:
 * 1.2.3 outranks 1.2.3-rc.1, which is what keeps a range from settling for a
 * release candidate when it asked for a release.
 */
function comparePrerelease(a, b) {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const as = a.split('.');
    const bs = b.split('.');
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const x = as[i];
        const y = bs[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            const d = Number(x) - Number(y);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

function compareVersions(a, b) {
    for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    return comparePrerelease(a.pre, b.pre);
}

// ── ranges ────────────────────────────────────────────────────────────────────
//
// The supported grammar is a documented subset of semver, and it is deliberately
// strict: a spec this parser does not fully understand is reported as
// unsupported rather than guessed at, because a wrong guess would silently
// install the wrong runtime — exactly the bug this module exists to remove.

const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const WILDCARD = /^[xX*]$/;

function toNumber(token) {
    if (token === undefined || token === null || WILDCARD.test(token)) return null;
    return Number(token);
}

/** The version a `^` range stops before. */
function caretCeiling(major, minor, patch) {
    if (patch !== null) {
        if (major !== 0) return v(major + 1, 0, 0);
        if (minor !== 0) return v(0, minor + 1, 0);
        return v(0, 0, patch + 1);
    }
    if (minor !== null) {
        if (major !== 0) return v(major + 1, 0, 0);
        return v(0, minor + 1, 0);
    }
    if (major !== 0) return v(major + 1, 0, 0);
    return v(0, 1, 0);
}

/** Expand one comparator into the [op, version] pairs it really means. */
function expandComparator(op, major, minor, patch, pre) {
    if (minor === null) {
        // `18`, `18.x`, `^18`, `~18`
        if (op === '>' || op === '>=') {
            if (op === '>' && pre === undefined) return [['>=', v(major + 1, 0, 0)]];
            return [['>=', v(major, 0, 0, pre ?? null)]];
        }
        if (op === '<' || op === '<=') {
            return [['<', v(major, 0, 0)]];
        }
        return [['>=', v(major, 0, 0)], ['<', v(major + 1, 0, 0)]];
    }

    if (patch === null) {
        // `18.20`, `~18.20`, `^18.20`
        if (op === '^') return [['>=', v(major, minor, 0)], ['<', caretCeiling(major, minor, null)]];
        if (op === '>' && pre === undefined) return [['>=', v(major, minor + 1, 0)]];
        if (op === '>=') return [['>=', v(major, minor, 0, pre ?? null)]];
        if (op === '<' || op === '<=') return [['<', v(major, minor, 0)]];
        return [['>=', v(major, minor, 0)], ['<', v(major, minor + 1, 0)]];
    }

    const exact = v(major, minor, patch, pre ?? null);
    if (op === '^') return [['>=', exact], ['<', caretCeiling(major, minor, patch)]];
    if (op === '~') return [['>=', exact], ['<', v(major, minor + 1, 0)]];
    if (op === '>') return [['>', exact]];
    if (op === '>=') return [['>=', exact]];
    if (op === '<') return [['<', exact]];
    if (op === '<=') return [['<=', exact]];
    // A bare spec with all three components is a pin, not a floor. Reading it as
    // `>=` is how "18.20.4" ends up installing 26.10.0.
    return [['>=', exact], ['<=', exact]];
}

/**
 * Parse a spec into OR-groups of comparators.
 *
 * @param {string} spec
 * @returns {Array<Array<[string, object]>>|null} null when the syntax is not
 *   understood — never a best guess.
 */
function parseRange(spec) {
    const specText = asText(spec);
    if (!specText) return null;
    // Hyphen ranges ("1.2.3 - 2.3.4") are legal semver but are not accepted
    // here; saying so beats half-matching them.
    if (/\s+-\s+/.test(specText)) return null;

    const groups = [];
    for (const alternative of specText.split('||')) {
        const tokens = alternative.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return null;
        const pairs = [];
        for (const token of tokens) {
            const m = COMPARATOR_RE.exec(token);
            if (!m) return null;
            const op = m[1] || '';
            const major = toNumber(m[2]);
            const minor = toNumber(m[3]);
            const patch = toNumber(m[4]);
            if (major === null) {
                // A bare `*`/`x`, or `^x`/`~x`, matches any release.
                if (op && op !== '^' && op !== '~') return null;
                if (minor !== null || patch !== null) return null;
                continue;
            }
            for (const pair of expandComparator(op, major, minor, patch, m[5])) pairs.push(pair);
        }
        groups.push(pairs);
    }
    return groups.length ? groups : null;
}

function testPair(version, [op, ref]) {
    const c = compareVersions(version, ref);
    switch (op) {
        case '>': return c > 0;
        case '>=': return c >= 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        default: return c >= 0;
    }
}

/**
 * Does a version satisfy a parsed range?
 *
 * A prerelease only matches when the range names a prerelease on the same
 * [major, minor, patch] tuple, which is the semver rule and stops `21` from
 * resolving to `21.0.0-rc.1` the week a release candidate is published.
 */
function satisfies(version, groups) {
    if (!groups) return false;
    return groups.some((pairs) => {
        if (!pairs.every((pair) => testPair(version, pair))) return false;
        if (!version.pre) return true;
        return pairs.some(([, ref]) => ref.pre
            && ref.major === version.major && ref.minor === version.minor && ref.patch === version.patch);
    });
}

// ── resolution ────────────────────────────────────────────────────────────────

/** Strip the quoting YAML often leaves around a version. */
function normaliseSpec(raw) {
    return asText(raw).replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Find the newest release in `index` that satisfies `spec` and has a build for
 * this platform.
 *
 * @returns {{entry: object, ltsName: string}|null}
 */
function resolveFromIndex(index, spec, platform) {
    if (!Array.isArray(index) || !index.length) return null;
    const { token } = PLATFORMS[platform];
    const text = normaliseSpec(spec);
    if (!text) return null;

    const ltsMatch = /^lts\/(.+)$/i.exec(text);
    let ltsFilter = null;
    // An LTS selector constrains the codename, not the numbers, so the numeric
    // half of the range is "any release" — not the literal text "lts/hydrogen",
    // which no range parser could read.
    let rangeText = '*';
    if (/^lts$/i.test(text) || /^lts\/\*$/i.test(text)) {
        ltsFilter = 'any';
    } else if (ltsMatch) {
        ltsFilter = ltsMatch[1].toLowerCase();
    } else {
        rangeText = text;
    }

    const groups = parseRange(rangeText);
    if (!groups) return null;

    for (const entry of index) {
        if (!entry || typeof entry.version !== 'string') continue;
        if (!Array.isArray(entry.files) || !entry.files.includes(token)) continue;
        if (ltsFilter === 'any') {
            if (entry.lts === false || !entry.lts) continue;
        } else if (ltsFilter) {
            if (String(entry.lts || '').toLowerCase() !== ltsFilter) continue;
        } else {
            const parsed = parseVersion(entry.version);
            if (!parsed || !satisfies(parsed, groups)) continue;
        }
        return { entry, ltsName: entry.lts && entry.lts !== false ? String(entry.lts) : '' };
    }
    return null;
}

// ── http ──────────────────────────────────────────────────────────────────────

/**
 * Start a GET and hand back the live response, after following redirects.
 *
 * The response stream is the caller's to consume. Returning it rather than a
 * finished body is what lets a download be *awaited*: an earlier version
 * resolved as soon as the response headers arrived, which meant the checksum was
 * computed against a file that was still being written.
 */
function request(url, { timeout = 30000, redirects = MAX_REDIRECTS } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'user-agent': 'AeroCI' } }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) { reject(new Error(`too many redirects for ${url}`)); return; }
                const next = new URL(res.headers.location, url).toString();
                resolve(request(next, { timeout, redirects: redirects - 1 }));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`HTTP ${status} for ${url}`));
                return;
            }
            resolve(res);
        });
        req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout}ms: ${url}`)));
        req.on('error', reject);
    });
}

/** @returns {Promise<Buffer>} */
async function httpGetBuffer(url, { timeout = 30000 } = {}) {
    const res = await request(url, { timeout });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/**
 * Stream a URL to disk and resolve only once the last byte is on the platter.
 *
 * @param {string} url
 * @param {string} dest
 * @returns {Promise<number>} bytes written
 */
async function httpGetToFile(url, dest, { timeout = DOWNLOAD_TIMEOUT_MS, onProgress } = {}) {
    const res = await request(url, { timeout });
    const total = Number(res.headers['content-length'] || 0);
    let seen = 0;
    let lastPercent = -1;
    // Counting in a Transform keeps backpressure intact; listening to `data`
    // alongside a pipe would defeat it and turn a 40 MB download into memory.
    const counter = new Transform({
        transform(chunk, _encoding, next) {
            seen += chunk.length;
            if (onProgress && total) {
                const percent = Math.floor((seen / total) * 100);
                if (percent >= lastPercent + 10) { lastPercent = percent; onProgress(percent, seen, total); }
            }
            next(null, chunk);
        }
    });
    await pipeline(res, counter, fs.createWriteStream(dest));
    return seen;
}

// ── the global tree ────────────────────────────────────────────────────────────
//
// The paths live in `network.js` so the policy file, the runtimes and the caches
// are described in one place and cannot drift apart. A runtime and a cache are
// different kinds of thing: the first is installed and verified against a
// published checksum, the second may be deleted at any moment without anything
// being wrong. Keeping them under one root with names that say which is which is
// what makes `rm -rf ~/.aeroci/cache` a safe thing to suggest to somebody.

const { runtimesRoot, cacheRoot, globalRoot } = require('./network');

function versionDir(version) { return path.join(runtimesRoot(), 'node', version); }

/** The install root, laid out like a real hosted tool cache:
 *  `node/<version>/<arch>/bin`. */
function installDir(version, alias) {
    return path.join(versionDir(version), alias);
}

function binDir(dir) {
    return path.join(dir, process.platform === 'win32' ? '' : 'bin');
}

const MARKER = '.aeroci-complete';

/** A directory counts as installed only if a previous run left its marker. */
function isComplete(dir) {
    try { return fs.statSync(path.join(dir, MARKER)).isFile(); } catch (_) { return false; }
}

// ── the release index ─────────────────────────────────────────────────────────
//
// The index is a network resource like any other, and the promise is that nothing
// reaches out without permission. So it is read from the cache first and only
// fetched once the caller has said yes — `ensureNode` is the one that asks, and
// it asks with the concrete version in hand whenever the cache already knows it.

function indexCacheFile() { return path.join(cacheRoot(), 'node', 'index.json'); }

/**
 * The cached release index, or null when there is nothing usable.
 *
 * Never touches the network. A stale copy is still worth having: resolving
 * against yesterday's list produces the right runtime far more often than falling
 * back to the host does, and the caller is told the list was stale.
 *
 * @returns {{index: object[], stale: boolean}|null}
 */
function readCachedIndex() {
    const file = indexCacheFile();
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
    if (!Array.isArray(parsed) || !parsed.length) return null;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (_) { /* keep Infinity */ }
    return { index: parsed, stale: age >= INDEX_TTL_MS };
}

/**
 * Fetch the official release index and cache it for six hours.
 *
 * The caller has already established that reaching nodejs.org is permitted; this
 * function assumes it and does not ask again.
 *
 * @returns {Promise<{index: object[], stale: boolean}>}
 */
async function fetchIndex() {
    const file = indexCacheFile();
    try {
        const body = await httpGetBuffer(`${DIST}/index.json`, { timeout: 30000 });
        const index = JSON.parse(body.toString('utf8'));
        if (!Array.isArray(index) || !index.length) throw new Error('index.json was not a list of releases');
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(index));
        } catch (_) { /* a cache we cannot write is only a slower run */ }
        return { index, stale: false };
    } catch (err) {
        const cached = readCachedIndex();
        if (cached) return { index: cached.index, stale: true };
        throw new Error(`could not read the Node release index: ${err.message}`);
    }
}

// ── install ───────────────────────────────────────────────────────────────────

function sha256(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(1 << 16);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read <= 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/** The published checksum for one file, from the SHASUMS256.txt beside it. */
async function publishedChecksum(version, filename) {
    const body = await httpGetBuffer(`${DIST}/v${version}/SHASUMS256.txt`, { timeout: 30000 });
    for (const line of body.toString('utf8').split('\n')) {
        const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
        if (m && m[2] === filename) return m[1].toLowerCase();
    }
    throw new Error(`SHASUMS256.txt has no entry for ${filename}`);
}

function extract(archive, dest, ext) {
    fs.mkdirSync(dest, { recursive: true });
    // bsdtar reads gzip and zip by extension, so one `tar` covers both formats
    // and needs no dependency. The zip branch is only reachable on Windows,
    // where tar.exe ships with the OS.
    const args = ext === 'zip' ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest];
    const res = spawnSync('tar', args, { encoding: 'utf8', timeout: 300000 });
    if (res.error) throw new Error(`tar could not be run: ${res.error.message}`);
    if (res.status !== 0) {
        throw new Error(`tar failed (exit ${res.status}): ${(res.stderr || '').trim() || 'no output'}`);
    }
}

/**
 * Download, verify and unpack one Node release.
 *
 * The unpacking happens in a scratch directory that is renamed into place only
 * after the checksum matches, so an interrupted run can never leave a
 * half-extracted runtime that a later run would mistake for a good install.
 *
 * @returns {Promise<{dir:string, bin:string}>}
 */
async function installNode(entry, platform, { onProgress } = {}) {
    const { dist, ext, alias } = PLATFORMS[platform];
    const version = entry.version.replace(/^v/, '');
    const filename = `node-v${version}-${dist}.${ext}`;
    const target = installDir(version, alias);
    const targetBin = binDir(target);
    if (isComplete(target)) return { dir: target, bin: targetBin };

    const url = `${DIST}/v${version}/${filename}`;
    const expected = await publishedChecksum(version, filename);
    const staging = path.join(cacheRoot(), 'downloads');
    fs.mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, filename);
    const part = `${archive}.part`;

    try {
        await httpGetToFile(url, part, {
            timeout: DOWNLOAD_TIMEOUT_MS,
            onProgress
        });

        const actual = sha256(part);
        if (actual !== expected) {
            throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
        }

        const unpacked = path.join(staging, `unpack-${process.pid}`);
        fs.rmSync(unpacked, { recursive: true, force: true });
        extract(part, unpacked, ext);
        fs.rmSync(part, { force: true });

        // The archive holds a single top-level `node-vX-dist/` directory.
        const roots = fs.readdirSync(unpacked).filter((n) => !n.startsWith('.'));
        if (roots.length !== 1) throw new Error(`unexpected archive layout: ${roots.join(', ') || '(empty)'}`);
        const source = path.join(unpacked, roots[0]);
        if (process.platform !== 'win32' && !fs.existsSync(path.join(source, 'bin', 'node'))) {
            throw new Error('the unpacked archive has no bin/node');
        }

        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
        fs.writeFileSync(path.join(target, MARKER), `${version} ${dist} ${expected}\n`, 'utf8');
        // A real runner also exposes the install under the other architecture's
        // name, so a workflow that hardcodes `x64` works on an arm64 host.
        const other = alias === 'x64' ? 'arm64' : 'x64';
        const link = path.join(versionDir(version), other);
        if (!fs.existsSync(link)) {
            try { fs.symlinkSync(target, link, 'dir'); } catch (_) { /* a name collision is not fatal */ }
        }
        linkVersionAliases();
        fs.rmSync(unpacked, { recursive: true, force: true });
    } catch (err) {
        fs.rmSync(part, { force: true });
        throw err;
    }

    return { dir: target, bin: targetBin };
}

/** Whether a version directory holds a real, complete install under any of the
 *  architecture names this platform map knows about. */
function hasInstall(nodeDir, version) {
    return Object.values(PLATFORMS)
        .map((p) => p.alias)
        .some((alias) => isComplete(path.join(nodeDir, version, alias)));
}

/**
 * Point `node/18` and `node/18.20` at the newest installed build they cover.
 *
 * The concrete directory is the real one — `18.20.8` names a build you can point
 * at and get that build. The short names are symlinks onto it, so `ls
 * ~/.aeroci/runtimes/node` reads the way a person expects while nothing stays
 * ambiguous about which directory is which.
 *
 * The aliases are recomputed from what is on disk rather than written once,
 * because "newest" changes: installing 18.20.9 has to move `18`, and deleting a
 * runtime by hand must not leave `18` pointing at nothing. The comparison uses
 * `readlink` rather than `realpath` for exactly that reason — `realpath` throws
 * on a dangling link, which is the one case that most needs fixing.
 */
function linkVersionAliases() {
    const nodeDir = path.join(runtimesRoot(), 'node');
    let entries;
    try {
        entries = fs.readdirSync(nodeDir);
    } catch (_) {
        return;
    }

    const installed = entries
        .map((name) => ({ name, parsed: parseVersion(name) }))
        .filter(({ name, parsed }) => parsed && hasInstall(nodeDir, name));
    if (!installed.length) return;

    // For each `18` and each `18.20`, the newest install it covers.
    const newest = new Map();
    for (const { name, parsed } of installed) {
        for (const alias of [`${parsed.major}`, `${parsed.major}.${parsed.minor}`]) {
            const held = newest.get(alias);
            if (!held || compareVersions(parsed, held.parsed) > 0) newest.set(alias, { name, parsed });
        }
    }

    for (const [alias, { name }] of newest) {
        if (alias === name) continue;
        const link = path.join(nodeDir, alias);
        const target = path.join(nodeDir, name);
        try {
            if (fs.lstatSync(link, { throwIfNoEntry: false })) {
                let current = null;
                try { current = fs.readlinkSync(link); } catch (_) { current = null; }
                if (current === target) continue;
                fs.unlinkSync(link);
            }
            fs.symlinkSync(target, link, 'dir');
        } catch (_) { /* a link that will not take is not a broken install */ }
    }
}

/** Run the freshly unpacked binary and report what it claims to be. A runtime
 *  that cannot start is not an install, however correct its checksum was. */
function probeVersion(bin) {
    const exe = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
    const res = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (res.error || res.status !== 0) return null;
    const text = `${res.stdout || ''}${res.stderr || ''}`.trim();
    const m = /v?(\d+\.\d+\.\d+)/.exec(text);
    return m ? m[1] : null;
}

// ── public surface ────────────────────────────────────────────────────────────

/**
 * @typedef {{ok: true, spec: string, version: string, bin: string|null,
 *   source: 'host'|'cache'|'downloaded', lts: string, staleIndex: boolean}
 *   | {ok: false, spec: string, reason: string, message: string}} NodeResult
 *
 * On failure `message` states the reason only — never the remedy, and never what
 * will be used instead. The caller knows the host version and has one place to
 * word the warning, which is what keeps the two from being said twice.
 */

/**
 * Make the requested Node version real for this job.
 *
 * On success the caller gets a `bin` directory to put on PATH; `bin` is null
 * when the host runtime already is the requested version, which needs no
 * download and no PATH change. On failure `reason` says why, so the caller can
 * report a substitution instead of pretending the request was met.
 *
 * @param {string} spec
 * @param {object} options
 * @param {boolean|null} options.allowDownload true, false, or null to ask
 * @param {Function} [options.onProgress]
 * @param {Function} [options.decide] called as decide(requested, resolvedVersion)
 *   when `allowDownload` is null. `resolvedVersion` is the concrete build when
 *   the cached index already knows it and `''` when AeroCI would first have to
 *   reach nodejs.org to find out. Returns true, false, or null to abstain.
 * @returns {Promise<NodeResult>}
 */
async function ensureNode(spec, { allowDownload = null, onProgress, decide } = {}) {
    const requested = normaliseSpec(spec);
    const hostVersion = process.versions.node;

    if (!requested) {
        return { ok: false, spec: requested, reason: 'no-spec', message: 'no node-version was given' };
    }

    const platform = currentPlatform();
    if (!platform) {
        return {
            ok: false, spec: requested, reason: 'unsupported-platform',
            message: `nodejs.org publishes no build for ${process.platform}-${process.arch}`
        };
    }

    // One decision, asked at most once per call, covering both the index lookup
    // and the archive: they are the same permission — reaching nodejs.org — and
    // asking twice about one download would be two questions for one decision.
    let decided = null;
    const permitted = async (version) => {
        if (allowDownload === true || allowDownload === false) return allowDownload;
        if (decided !== null) return decided;
        if (typeof decide !== 'function') return null;
        const answer = await decide(requested, version);
        decided = answer === true || answer === false ? answer : null;
        return decided;
    };

    const noIndex = () => ({
        ok: false, spec: requested, reason: 'no-index',
        message: 'the Node release index is not cached and network access was not authorized, ' +
                 `so "${requested}" cannot be resolved to a build`
    });

    // Turning "18" into "18.20.8" needs nodejs.org's release index, so the index is
    // read even when the host happens to match: without it there is no way to know
    // what the spec resolves to, and a silent substitution is what this module
    // exists to stop. A cached copy answers without reaching out at all, which is
    // why a run that has done this before needs no permission to resolve a version.
    const cached = readCachedIndex();
    let index;
    let staleIndex = false;
    if (cached) {
        index = cached.index;
        staleIndex = true;
    } else {
        if (!(await permitted(''))) return noIndex();
        try {
            ({ index, staleIndex } = await fetchIndex());
        } catch (err) {
            return { ok: false, spec: requested, reason: 'offline', message: err.message };
        }
    }

    const resolved = resolveFromIndex(index, requested, platform);
    if (!resolved) {
        const range = parseRange(requested);
        const reason = range === null ? 'unsupported-spec' : 'not-found';
        const message = reason === 'unsupported-spec'
            ? `"${requested}" is not a version spec this simulator understands`
            : `no published Node release matches "${requested}" for ${platform}`;
        return { ok: false, spec: requested, reason, message };
    }

    const version = resolved.entry.version.replace(/^v/, '');

    // Already on this machine, and the spec really does mean this machine.
    if (version === hostVersion) {
        return {
            ok: true, spec: requested, version, bin: null, source: 'host',
            lts: resolved.ltsName, staleIndex
        };
    }

    const dir = installDir(version, PLATFORMS[platform].alias);
    if (isComplete(dir)) {
        const bin = binDir(dir);
        const running = probeVersion(bin);
        if (running === version) {
            return {
                ok: true, spec: requested, version, bin, source: 'cache',
                lts: resolved.ltsName, staleIndex
            };
        }
        // A damaged or half-removed install: drop it so the next attempt is clean.
        fs.rmSync(dir, { recursive: true, force: true });
    }

    if (!(await permitted(version))) {
        return {
            ok: false, spec: requested, reason: 'denied',
            message: `downloading Node ${version} was not permitted`
        };
    }

    let installed;
    try {
        installed = await installNode(resolved.entry, platform, { onProgress });
    } catch (err) {
        return {
            ok: false, spec: requested, reason: 'download-failed',
            message: `Node ${version} could not be installed: ${err.message}`
        };
    }

    const running = probeVersion(installed.bin);
    if (running !== version) {
        return {
            ok: false, spec: requested, reason: 'unusable',
            message: running
                ? `the installed Node reports ${running} where ${version} was expected`
                : 'the installed Node did not run'
        };
    }

    return {
        ok: true, spec: requested, version, bin: installed.bin, source: 'downloaded',
        lts: resolved.ltsName, staleIndex
    };
}

module.exports = {
    ensureNode,
    // Re-exported so callers that already depend on the toolchain do not have to
    // know that the layout moved. The paths themselves are owned by `network.js`.
    runtimesRoot,
    cacheRoot,
    globalRoot,
    currentPlatform,
    resolveFromIndex,
    parseRange,
    satisfies,
    parseVersion,
    compareVersions,
    normaliseSpec,
    PLATFORMS
};
