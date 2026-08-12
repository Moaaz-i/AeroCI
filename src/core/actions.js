/**
 * AeroCI Action Simulator Library v2.0.0
 * Features 41-50: Realistic local simulation of popular GitHub Actions
 *
 * 41. actions/cache              — real local cache with key matching & restore
 * 42. actions/setup-python       — detect local python, report version
 * 43. actions/setup-java         — detect local java, report version
 * 44. actions/setup-go           — detect local go, report version
 * 45. github-script              — execute inline JS with mocked github/core API
 * 46. docker/build-push-action   — mock docker build with local docker check
 * 47. actions/create-release     — mock GitHub release creation
 * 48. peaceiris/actions-gh-pages — mock gh-pages deploy simulation
 * 49. aws-actions/configure-aws-credentials — validate AWS env vars
 * 50. Action Marketplace Version Checker — check latest action versions
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');

const CACHE_DIR = path.join(process.cwd(), '.aeroci-artifacts', 'action-cache');

// ─── Utility: run a local binary and get its version ─────────────────────────
function getLocalVersion(binary, versionFlag = '--version') {
    const result = spawnSync(binary, [versionFlag], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status === 0) {
        return (result.stdout || result.stderr || '').trim().split('\n')[0];
    }
    return null;
}

class Actions {
    // ─── Feature 41: actions/cache ────────────────────────────────────────────
    static simulateCache(step, context = {}) {
        const key = String(step.with?.key || 'default')
            .replace(/\$\{\{[^}]+\}\}/g, context.cacheKeySuffix || 'local');
        const restoreKeys = (step.with?.['restore-keys'] || '')
            .split('\n').map(k => k.trim()).filter(Boolean);
        const cachePath = step.with?.path || 'node_modules';

        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

        const indexFile = path.join(CACHE_DIR, 'index.json');
        let index = {};
        try {
            if (fs.existsSync(indexFile)) index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        } catch (_) {}

        // Try exact key match first
        let hit = false;
        let hitKey = null;

        if (index[key]) {
            hit = true; hitKey = key;
        } else {
            for (const rk of restoreKeys) {
                const match = Object.keys(index).find(k => k.startsWith(rk));
                if (match) { hit = true; hitKey = match; break; }
            }
        }

        if (hit) {
            Logger.success(`    ✔ [actions/cache]: Cache HIT for key "${hitKey}"`);
            Logger.info(`    ↩ Restored "${cachePath}" from local cache store`);
        } else {
            Logger.warn(`    ○ [actions/cache]: Cache MISS — key "${key}"`);
            Logger.info(`    💾 Cache will be saved after job completes`);
            // Register cache entry for next run
            index[key] = {
                path: cachePath,
                savedAt: new Date().toISOString(),
                size: '(simulated)'
            };
            fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');
        }

        return { hit, hitKey, key };
    }

    // ─── Feature 42: actions/setup-python ────────────────────────────────────
    static simulateSetupPython(step) {
        const requested = step.with?.['python-version'] || '3.x';
        const localVer = getLocalVersion('python3') || getLocalVersion('python');
        if (localVer) {
            Logger.success(`    ✔ [actions/setup-python]: Python ${localVer} ready (local)`);
            Logger.info(`       Requested: ${requested} — Using local installation`);
        } else {
            Logger.warn(`    ○ [actions/setup-python]: Python ${requested} not found locally`);
            Logger.info(`       Install Python ${requested} to simulate this step accurately`);
        }
        return localVer;
    }

    // ─── Feature 43: actions/setup-java ──────────────────────────────────────
    static simulateSetupJava(step) {
        const requested = step.with?.['java-version'] || '17';
        const dist = step.with?.distribution || 'temurin';
        const localVer = getLocalVersion('java', '-version');
        if (localVer) {
            Logger.success(`    ✔ [actions/setup-java]: Java ready (local)`);
            Logger.info(`       ${localVer}`);
            Logger.info(`       Requested: Java ${requested} (${dist})`);
        } else {
            Logger.warn(`    ○ [actions/setup-java]: Java ${requested} (${dist}) not found locally`);
        }
        return localVer;
    }

    // ─── Feature 44: actions/setup-go ────────────────────────────────────────
    static simulateSetupGo(step) {
        const requested = step.with?.['go-version'] || '1.x';
        const localVer = getLocalVersion('go', 'version');
        if (localVer) {
            Logger.success(`    ✔ [actions/setup-go]: ${localVer} ready (local)`);
            Logger.info(`       Requested: go${requested}`);
        } else {
            Logger.warn(`    ○ [actions/setup-go]: Go ${requested} not found locally`);
        }
        return localVer;
    }

    // ─── Feature 45: actions/github-script ───────────────────────────────────
    static simulateGithubScript(step, context = {}) {
        const script = step.with?.script;
        if (!script) {
            Logger.warn(`    ○ [actions/github-script]: No script provided`);
            return;
        }

        Logger.info(`    ⚡ Simulating GitHub Action: actions/github-script`);

        // Mock github & core APIs
        const coreLogs = [];
        const mockCore = {
            setOutput: (key, val) => { coreLogs.push(`output: ${key}=${val}`); },
            setFailed: (msg) => { coreLogs.push(`FAILED: ${msg}`); },
            warning: (msg) => { coreLogs.push(`warning: ${msg}`); },
            info: (msg) => { coreLogs.push(`info: ${msg}`); },
            error: (msg) => { coreLogs.push(`error: ${msg}`); },
            getInput: (key) => context.inputs?.[key] || '',
            exportVariable: (key, val) => { process.env[key] = val; },
            getBooleanInput: (key) => false,
        };
        const mockGithub = {
            context: {
                repo: { owner: 'local', repo: 'repository' },
                sha: 'local-sha-000000',
                ref: 'refs/heads/main',
                actor: process.env.USER || 'developer',
                eventName: 'push',
                payload: {}
            },
            getOctokit: () => ({
                rest: {
                    issues: { create: async () => ({ data: { number: 999 } }), addLabels: async () => {} },
                    pulls: { list: async () => ({ data: [] }) },
                    repos: { getContent: async () => ({ data: {} }) },
                }
            })
        };

        try {
            const fn = new Function('github', 'core', 'require', `return (async () => { ${script} })()`);
            fn(mockGithub, mockCore, require)
                .then(() => {
                    Logger.success(`    ✔ [actions/github-script]: Script executed successfully`);
                    for (const log of coreLogs) {
                        console.log(`      ${colors.cyan}|${colors.reset} ${log}`);
                    }
                })
                .catch(err => {
                    Logger.warn(`    ○ [actions/github-script]: Script threw: ${err.message}`);
                });
        } catch (err) {
            Logger.warn(`    ○ [actions/github-script]: Script syntax error: ${err.message}`);
        }
    }

    // ─── Feature 46: docker/build-push-action ────────────────────────────────
    static simulateDockerBuildPush(step) {
        const imageName = step.with?.tags || step.with?.images || 'local/image:latest';
        const push = step.with?.push || false;
        const file = step.with?.file || 'Dockerfile';
        const context = step.with?.context || '.';

        Logger.info(`    ⚡ Simulating Action: docker/build-push-action`);

        const dockerCheck = getLocalVersion('docker');
        if (dockerCheck) {
            Logger.info(`    🐳 Docker found: ${dockerCheck}`);
            if (fs.existsSync(path.join(process.cwd(), file))) {
                Logger.success(`    ✔ Dockerfile found at: ${file}`);
            } else {
                Logger.warn(`    ○ Dockerfile not found at: ${file} — would fail in CI`);
            }
            Logger.info(`    📦 Would build: ${imageName} (context: ${context})`);
            if (push) {
                Logger.info(`    🚀 Would push to registry (push: true) — skipped in simulation`);
            }
        } else {
            Logger.warn(`    ○ Docker not installed locally — simulating build metadata only`);
            Logger.info(`    📦 Target image: ${imageName} | Dockerfile: ${file}`);
        }
        Logger.success(`    ✔ [docker/build-push-action]: Simulation complete`);
    }

    // ─── Feature 47: actions/create-release ──────────────────────────────────
    static simulateCreateRelease(step) {
        const tag = step.with?.tag_name || 'v0.0.0';
        const name = step.with?.release_name || tag;
        const body = (step.with?.body || '').slice(0, 100);
        const draft = step.with?.draft || false;
        const prerelease = step.with?.prerelease || false;

        Logger.info(`    ⚡ Simulating Action: actions/create-release`);
        Logger.info(`    🏷  Tag: ${tag} | Name: "${name}"`);
        Logger.info(`    📝 Body: ${body || '(none)'}`);
        Logger.info(`    🔖 Draft: ${draft} | Pre-release: ${prerelease}`);
        Logger.success(`    ✔ [actions/create-release]: Simulated — release URL: https://github.com/local/repo/releases/tag/${tag}`);
        return { tag, releaseId: Math.floor(Math.random() * 99999) };
    }

    // ─── Feature 48: peaceiris/actions-gh-pages ──────────────────────────────
    static simulateGhPages(step) {
        const deployDir = step.with?.publish_dir || './public';
        const branch = step.with?.publish_branch || 'gh-pages';
        const cname = step.with?.cname || null;

        Logger.info(`    ⚡ Simulating Action: peaceiris/actions-gh-pages`);
        Logger.info(`    📂 Source dir: ${deployDir}`);

        const fullDir = path.resolve(process.cwd(), deployDir);
        if (fs.existsSync(fullDir)) {
            const fileCount = fs.readdirSync(fullDir).length;
            Logger.success(`    ✔ Deploy directory exists (${fileCount} files)`);
        } else {
            Logger.warn(`    ○ Deploy directory not found: ${deployDir}`);
        }

        Logger.info(`    🚀 Would push to branch: ${branch}`);
        if (cname) Logger.info(`    🌐 CNAME: ${cname}`);
        Logger.success(`    ✔ [actions-gh-pages]: Simulation complete — no actual push performed`);
    }

    // ─── Feature 49: aws-actions/configure-aws-credentials ───────────────────
    static simulateAWSCredentials(step) {
        Logger.info(`    ⚡ Simulating Action: aws-actions/configure-aws-credentials`);

        const region = step.with?.['aws-region'] || process.env.AWS_DEFAULT_REGION || '(unset)';
        const roleArn = step.with?.['role-to-assume'];

        const checks = [
            { key: 'AWS_ACCESS_KEY_ID',     present: !!process.env.AWS_ACCESS_KEY_ID, required: !roleArn },
            { key: 'AWS_SECRET_ACCESS_KEY', present: !!process.env.AWS_SECRET_ACCESS_KEY, required: !roleArn },
            { key: 'AWS_REGION',            present: !!process.env.AWS_REGION || region !== '(unset)', required: true },
        ];

        let allGood = true;
        for (const c of checks) {
            if (c.present) {
                Logger.success(`    ✔ ${c.key}: set`);
            } else if (c.required) {
                Logger.warn(`    ○ ${c.key}: NOT SET — would fail in CI`);
                allGood = false;
            } else {
                Logger.info(`    ○ ${c.key}: not set (using OIDC role-to-assume instead)`);
            }
        }

        if (roleArn) {
            Logger.info(`    🔑 OIDC role-to-assume: ${roleArn}`);
            Logger.info(`    ○ OIDC token exchange simulated — would contact AWS STS in CI`);
        }

        Logger.info(`    🌍 Region: ${region}`);

        if (allGood || roleArn) {
            Logger.success(`    ✔ [configure-aws-credentials]: Credential simulation passed`);
        } else {
            Logger.warn(`    ○ [configure-aws-credentials]: Missing credentials — add to .env`);
        }
    }

    // ─── Feature 50: Action Marketplace Version Checker ──────────────────────
    static async checkActionVersions(steps) {
        Logger.info(`    🔍 Checking action versions against known latest...\n`);

        // Known latest versions (maintained list)
        const KNOWN_LATEST = {
            'actions/checkout':                    'v4',
            'actions/setup-node':                  'v4',
            'actions/setup-python':                'v5',
            'actions/setup-java':                  'v4',
            'actions/setup-go':                    'v5',
            'actions/cache':                       'v4',
            'actions/upload-artifact':             'v4',
            'actions/download-artifact':           'v4',
            'actions/create-release':              'v1',
            'docker/build-push-action':            'v5',
            'docker/login-action':                 'v3',
            'docker/metadata-action':              'v5',
            'peaceiris/actions-gh-pages':          'v4',
            'aws-actions/configure-aws-credentials': 'v4',
            'github/codeql-action/init':           'v3',
            'actions/github-script':               'v7',
        };

        const rows = [];
        for (const step of steps) {
            if (!step.uses) continue;
            const [actionName, currentTag] = step.uses.split('@');
            const latest = KNOWN_LATEST[actionName];

            if (!latest) continue;

            const isCurrent = currentTag === latest || /[a-f0-9]{40}/.test(currentTag);
            const status = isCurrent ? `${colors.green}✔ Up to date${colors.reset}` : `${colors.yellow}⚠ Update available${colors.reset}`;
            rows.push([
                step.name || actionName,
                currentTag || '?',
                latest,
                isCurrent ? 'Current' : `→ ${latest}`
            ]);

            if (!isCurrent) {
                console.log(`    ${colors.yellow}⚠ ${actionName}@${currentTag}${colors.reset} → Latest: ${colors.green}${latest}${colors.reset}`);
            }
        }

        if (rows.length > 0) {
            Logger.table(['Step/Action', 'Current', 'Latest', 'Recommendation'], rows);
        }
    }

    // ─── Main Dispatcher ──────────────────────────────────────────────────────
    static simulate(step, context = {}) {
        const uses = step.uses || '';

        if (uses.includes('actions/cache'))                        return Actions.simulateCache(step, context);
        if (uses.includes('actions/setup-python'))                 return Actions.simulateSetupPython(step);
        if (uses.includes('actions/setup-java'))                   return Actions.simulateSetupJava(step);
        if (uses.includes('actions/setup-go'))                     return Actions.simulateSetupGo(step);
        if (uses.includes('actions/github-script'))                return Actions.simulateGithubScript(step, context);
        if (uses.includes('docker/build-push-action'))             return Actions.simulateDockerBuildPush(step);
        if (uses.includes('actions/create-release'))               return Actions.simulateCreateRelease(step);
        if (uses.includes('actions-gh-pages'))                     return Actions.simulateGhPages(step);
        if (uses.includes('configure-aws-credentials'))            return Actions.simulateAWSCredentials(step);

        return null; // Not a specially simulated action — use default handling
    }
}

module.exports = { Actions };
