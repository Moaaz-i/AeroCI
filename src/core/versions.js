/**
 * `aeroci versions` — what your workflows actually reference.
 *
 * Two questions, answered honestly:
 *
 *   1. How is each action pinned? SHA, tag, branch, or nothing at all. This is
 *      read from the workflow, so it is always true.
 *   2. Does AeroCI simulate it? Also read from the code, so also always true.
 *
 * Comparing against "the latest release" is a different matter. A hand-kept
 * table of latest versions goes stale without anyone noticing and then reports
 * "up to date" for something that is not, so it is not used. `--check-remote`
 * asks GitHub instead, and says so when it cannot reach it.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Logger, colors } = require('../utils/logger');
const { MATCHERS } = require('./action-simulators');
const { Checker } = require('./checker');

/** The four ways an action reference can be pinned, worst first. */
const PIN_KINDS = {
    none: { rank: 0, label: 'no version', severity: 'high' },
    branch: { rank: 1, label: 'moving branch', severity: 'high' },
    tag: { rank: 2, label: 'tag', severity: 'medium' },
    sha: { rank: 3, label: 'commit SHA', severity: 'ok' }
};

function classifyPin(uses) {
    if (/^\.\//.test(uses) || uses.startsWith('../')) {
        return { kind: 'local', label: 'local action', severity: 'ok' };
    }
    if (uses.startsWith('docker://')) return { kind: 'image', label: 'container image', severity: 'ok' };

    const at = uses.lastIndexOf('@');
    if (at === -1) return { kind: 'none', label: PIN_KINDS.none.label, severity: PIN_KINDS.none.severity };

    const ref = uses.slice(at + 1);
    if (/^[0-9a-f]{40}$/i.test(ref)) return { kind: 'sha', label: PIN_KINDS.sha.label, severity: 'ok' };
    if (/^[0-9a-f]{7,39}$/i.test(ref)) {
        return { kind: 'sha-short', label: 'short SHA', severity: 'medium' };
    }
    if (/^(main|master|latest|develop|HEAD)$/i.test(ref) || ref.includes('/')) {
        return { kind: 'branch', label: PIN_KINDS.branch.label, severity: 'high' };
    }
    return { kind: 'tag', label: PIN_KINDS.tag.label, severity: 'medium' };
}

function hasSimulator(uses) {
    if (/^\.\//.test(uses)) return { simulated: true, why: 'local action, read from the repository' };
    return MATCHERS.some(([name]) => uses.startsWith(name))
        ? { simulated: true, why: 'AeroCI has a simulator for this action' }
        : { simulated: false, why: 'AeroCI reports this step as not simulated' };
}

class Versions {
    /**
     * @param {string} target  file, directory or project root
     * @returns {{references:Array, counts:object, exitCode:number}}
     */
    static inspect(target = '.github/workflows') {
        const files = Checker.collectFiles(target);
        if (files.length === 0) {
            Logger.warn(`No workflow files found at: ${target}`);
            return { references: [], counts: { total: 0 }, exitCode: 1 };
        }

        const references = [];
        for (const file of files) {
            const rel = path.relative(process.cwd(), file);
            let doc;
            try {
                doc = require('js-yaml').load(fs.readFileSync(file, 'utf8'), { filename: file });
            } catch (err) {
                Logger.error(`${rel}: ${err.message.split('\n')[0]}`);
                continue;
            }
            if (!doc || typeof doc !== 'object') continue;

            for (const [jobId, job] of Object.entries(doc.jobs || {})) {
                if (!job || !Array.isArray(job.steps)) continue;
                for (const step of job.steps) {
                    if (typeof step.uses !== 'string') continue;
                    const pin = classifyPin(step.uses);
                    const sim = hasSimulator(step.uses);
                    references.push({
                        file: rel,
                        jobId,
                        stepName: step.name || step.uses,
                        uses: step.uses,
                        action: step.uses.startsWith('@') || step.uses.startsWith('docker://')
                            || step.uses.startsWith('.')
                            ? step.uses
                            : step.uses.slice(0, step.uses.lastIndexOf('@')),
                        ref: step.uses.slice(step.uses.lastIndexOf('@') + 1),
                        ...pin,
                        ...sim
                    });
                }
            }
        }

        return { references, counts: Versions.summarise(references), exitCode: 0 };
    }

    static summarise(references) {
        const counts = {
            total: references.length,
            unique: new Set(references.map((r) => r.action)).size,
            sha: 0, shaShort: 0, tag: 0, branch: 0, none: 0, local: 0, image: 0, other: 0,
            simulated: 0,
            notSimulated: 0
        };
        // `classifyPin` returns a hyphenated `kind`; the counts are camelCase so
        // they read as keys in the output. A mismatch drops a whole pinning
        // style into `other`, where it disappears from the table entirely.
        const keyOf = (kind) => kind.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        for (const ref of references) {
            const key = keyOf(ref.kind);
            if (key in counts) counts[key]++;
            else counts.other++;
            if (ref.simulated) counts.simulated++;
            else counts.notSimulated++;
        }
        return counts;
    }

    static print(report) {
        const { references, counts } = report;
        if (references.length === 0) {
            Logger.success('No `uses:` references found.');
            return;
        }

        // One row per distinct action, listing where it appears.
        const byAction = new Map();
        for (const ref of references) {
            if (!byAction.has(ref.action)) byAction.set(ref.action, []);
            byAction.get(ref.action).push(ref);
        }

        console.log(`${colors.bright}${colors.cyan}🔖 Action references${colors.reset}\n`);
        Logger.table(
            ['Action', 'Reference', 'Pinned as', 'Simulated', 'Used in'],
            [...byAction.entries()].map(([action, uses]) => {
                // The same action can be pinned differently in different jobs.
                // Showing only the first one would hide the weaker references,
                // which are exactly the ones worth changing.
                const distinct = [...new Set(uses.map((u) => (u.kind === 'local' ? '(local)' : u.ref)))];
                const kinds = [...new Set(uses.map((u) => u.kind))];
                const worst = kinds.sort((a, b) => rankOf(a) - rankOf(b))[0];
                const pinColour = severityColour(worst);
                return [
                    action,
                    distinct.length === 1
                        ? `@${shortRef(distinct[0])}`
                        : `${distinct.length} different refs`,
                    pinColour(labelsFor(worst, kinds.length > 1)),
                    uses[0].simulated ? colors.green('yes') : colors.yellow('no'),
                    uses.length === 1
                        ? `${uses[0].jobId}`
                        : `${uses[0].jobId} +${uses.length - 1}`
                ];
            })
        );

        console.log('');
        Logger.metric('References', `${counts.total} in ${counts.unique} distinct action(s)`);
        Logger.metric('Pinned to a SHA', `${counts.sha} ${colors.gray('· the form that cannot change under you')}`);
        if (counts.tag) Logger.metric('Pinned to a tag', colors.yellow(`${counts.tag} ${colors.gray('· a tag can be repointed')}`));
        if (counts.shaShort) Logger.metric('Pinned to a short SHA', colors.yellow(`${counts.shaShort} ${colors.gray('· a commit, but a prefix of it')}`));
        if (counts.branch) Logger.metric('On a moving branch', colors.red(`${counts.branch}`));
        if (counts.none) Logger.metric('No version at all', colors.red(`${counts.none}`));
        if (counts.notSimulated) {
            Logger.metric('Not simulated', colors.yellow(`${counts.notSimulated} reference(s) — `
                + 'a local pass does not verify these'));
        }

        if (counts.branch || counts.none) {
            console.log('');
            Logger.note('aeroci security explains what each pinning style means for supply-chain risk.');
        }
    }

    /**
     * Ask GitHub for the newest release tag of each action. Explicitly opt-in,
     * because it needs the network and the answer is only as current as the
     * moment it was fetched.
     */
    static async checkRemote(references, { timeoutMs = 8000, token = process.env.GITHUB_TOKEN } = {}) {
        const targets = [...new Set(references
            .map((r) => r.action)
            .filter((a) => /^[\w.-]+\/[\w.-]+$/.test(a)))].sort();

        if (targets.length === 0) {
            Logger.warn('No published actions to look up (local actions have no upstream).');
            return [];
        }

        console.log(`${colors.bright}🌐 Latest release per action${colors.reset}`);
        Logger.note(`  fetching from api.github.com${token ? ' (authenticated)' : ' (unauthenticated — rate limited)'}`);
        console.log('');

        // Bounded concurrency rather than one request after another: with a dead
        // network a sequential loop is N × the timeout of silence, which reads
        // as a hung command. Six at a time keeps a 20-action project to a couple
        // of seconds and stays well inside the unauthenticated rate limit.
        const CONCURRENCY = 6;
        const latestFor = new Map();
        let cursor = 0;
        const worker = async () => {
            while (cursor < targets.length) {
                const action = targets[cursor++];
                latestFor.set(action, await Versions._latestRelease(action, { timeoutMs, token }));
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

        const rows = targets.map((action) => {
            const latest = latestFor.get(action);
            const uses = references.filter((r) => r.action === action);
            const current = [...new Set(uses.map((u) => u.ref))];
            const currentLabels = current.join(', ');

            if (latest === null) {
                return [action, currentLabels, colors.gray('unavailable')];
            }
            // A SHA-pinned reference cannot be compared to a tag without a
            // network lookup of the commit, so say what it is rather than guess.
            const behind = current.some((c) => /^v?\d/.test(c)) && current.every((c) => c !== latest);
            return [
                action,
                currentLabels,
                behind ? colors.yellow(`${latest} available`) : colors.green('current')
            ];
        });

        Logger.table(['Action', 'You use', 'Latest release'], rows);
        console.log('');
        Logger.note('A SHA-pinned action is shown as current because the tag number does not apply to it.');
        Logger.note('Fetched just now from the GitHub API; run it again later for a fresh answer.');
        return rows;
    }

    static _latestRelease(action, { timeoutMs, token }) {
        return new Promise((resolve) => {
            const request = https.get({
                hostname: 'api.github.com',
                path: `/repos/${action}/releases/latest`,
                headers: {
                    'user-agent': 'AeroCI',
                    accept: 'application/vnd.github+json',
                    ...(token ? { authorization: `Bearer ${token}` } : {})
                },
                timeout: timeoutMs
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(null);
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed.tag_name || null);
                    } catch (_) {
                        resolve(null);
                    }
                });
            });
            request.on('timeout', () => { request.destroy(); resolve(null); });
            request.on('error', () => resolve(null));
        });
    }
}

function shortRef(ref) {
    const value = String(ref || '');
    if (/^[0-9a-f]{40}$/i.test(value)) return value.slice(0, 7);
    return value || '?';
}

const RANK = { none: 0, branch: 1, 'tag': 2, 'sha-short': 3, sha: 4, local: 5, image: 5 };
const SEVERITY = { none: 'high', branch: 'high', tag: 'medium', 'sha-short': 'medium', sha: 'ok', local: 'ok', image: 'ok' };
const LABEL = {
    none: 'no version', branch: 'moving branch', tag: 'tag',
    'sha-short': 'short SHA', sha: 'commit SHA', local: 'local action', image: 'container image'
};

function rankOf(kind) { return RANK[kind] ?? 0; }
function severityColour(kind) {
    const severity = SEVERITY[kind] || 'ok';
    return severity === 'ok' ? colors.green : severity === 'medium' ? colors.yellow : colors.red;
}
function labelsFor(kind, mixed) {
    return mixed ? `${LABEL[kind] || kind} at best` : (LABEL[kind] || kind);
}

module.exports = { Versions, classifyPin, hasSimulator, PIN_KINDS };
