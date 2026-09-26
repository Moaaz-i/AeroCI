/**
 * GitHub event + `github` context payloads.
 *
 * A digital twin is only useful if the context is real, so this module reads the
 * actual local git repository (HEAD sha, branch, last commit, remote, author) and
 * synthesises an event payload shaped exactly like the one GitHub sends.
 * `--event <name>` (or `.aeroci.json`) selects which event to synthesise.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ZERO_SHA = '0000000000000000000000000000000000000000';

function git(cwd, args, fallback = null) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    if (res.status !== 0 || res.error) return fallback;
    const out = (res.stdout || '').trim();
    return out === '' ? fallback : out;
}

function readGitState(cwd) {
    const isRepo = git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
    if (!isRepo) {
        return {
            isRepo: false, sha: ZERO_SHA, shortSha: '0000000', ref: 'refs/heads/main',
            refName: 'main', refType: 'branch', defaultBranch: 'main',
            commitMessage: 'local simulation', commitAuthor: 'aeroci',
            authorName: 'aeroci', authorEmail: 'aeroci@localhost',
            remoteUrl: '', repository: 'local/aeroci-simulation', owner: 'local',
            repo: 'aeroci-simulation', dirty: false, changedFiles: 0, commitCount: 0
        };
    }

    const sha = git(cwd, ['rev-parse', 'HEAD'], ZERO_SHA);
    const refName = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 'main');
    const remote = git(cwd, ['remote', 'get-url', 'origin'], '')
        || git(cwd, ['config', '--get', 'remote.origin.url'], '');

    let owner = 'local', repo = 'aeroci-simulation';
    const remoteMatch = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(remote || '');
    if (remoteMatch) { owner = remoteMatch[1]; repo = remoteMatch[2]; }

    const commitCount = Number(git(cwd, ['rev-list', '--count', 'HEAD'], '1')) || 1;
    const changedFiles = Number(git(cwd, ['status', '--porcelain'], '') ?
        git(cwd, ['status', '--porcelain'], '').split('\n').filter(Boolean).length : 0);

    return {
        isRepo: true,
        sha,
        shortSha: sha.slice(0, 7),
        ref: `refs/heads/${refName}`,
        refName,
        refType: 'branch',
        defaultBranch: git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 'main')
            .replace(/^origin\//, '') || 'main',
        commitMessage: git(cwd, ['log', '-1', '--pretty=%s'], 'local simulation'),
        commitBody: git(cwd, ['log', '-1', '--pretty=%b'], ''),
        commitAuthor: git(cwd, ['log', '-1', '--pretty=%an'], 'aeroci'),
        authorName: git(cwd, ['config', 'user.name'], 'aeroci'),
        authorEmail: git(cwd, ['config', 'user.email'], 'aeroci@localhost'),
        remoteUrl: remote,
        repository: `${owner}/${repo}`,
        owner,
        repo,
        dirty: changedFiles > 0,
        changedFiles,
        commitCount
    };
}

/** Deterministic pseudo-number so repeated runs are reproducible. */
function seededInt(seed, min, max) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const span = max - min + 1;
    return min + (Math.abs(h) % span);
}

function buildCommits(state, count) {
    const commits = [];
    for (let i = 0; i < count; i++) {
        commits.push({
            id: i === 0 ? state.sha : `${state.sha.slice(0, 30)}${i}`.padEnd(40, '0'),
            tree_id: '0'.repeat(40),
            distinct: i > 0,
            message: i === 0 ? state.commitMessage : `simulated commit ${i}`,
            timestamp: `2026-01-0${(i % 9) + 1}T10:00:00+00:00`,
            url: `https://github.com/${state.repository}/commit/${state.sha}`,
            author: { name: state.commitAuthor, email: state.authorEmail, username: state.owner },
            committer: { name: state.commitAuthor, email: state.authorEmail, username: state.owner },
            added: [], removed: [], modified: []
        });
    }
    return commits;
}

function buildRepositoryObject(state) {
    return {
        id: seededInt(state.repository, 100000, 999999),
        node_id: 'R_kgDAB' + state.repository.replace(/\W/g, ''),
        name: state.repo,
        full_name: state.repository,
        private: false,
        owner: {
            login: state.owner,
            id: seededInt(state.owner, 1000, 9999),
            type: 'User',
            html_url: `https://github.com/${state.owner}`
        },
        html_url: `https://github.com/${state.repository}`,
        description: 'Local AeroCI digital twin repository',
        fork: false,
        url: `https://api.github.com/repos/${state.repository}`,
        default_branch: state.defaultBranch,
        language: null,
        visibility: 'public',
        clone_url: state.remoteUrl || `https://github.com/${state.repository}.git`,
        ssh_url: `git@github.com:${state.repository}.git`
    };
}

function buildUser(login) {
    return {
        login,
        id: seededInt(login, 1000, 9999),
        type: 'User',
        html_url: `https://github.com/${login}`
    };
}

function buildActorObject(state) {
    return {
        ...buildUser(state.owner),
        site_admin: false
    };
}

/**
 * Build the event payload for a trigger name.
 * Mirrors the shape of the real webhook bodies documented at docs.github.com.
 */
function buildEventPayload(eventName, state, inputs = {}) {
    const repo = buildRepositoryObject(state);
    const sender = buildActorObject(state);
    const number = seededInt(`${eventName}${state.sha}`, 1, 240);

    switch (eventName) {
        case 'pull_request':
        case 'pull_request_target': {
            const pr = {
                url: `https://api.github.com/repos/${state.repository}/pulls/${number}`,
                id: seededInt(state.sha, 1000000, 9999999),
                number,
                state: 'open',
                locked: false,
                title: `${state.commitMessage} (simulated pull request)`,
                user: sender,
                body: 'Simulated pull request body for local CI preview.',
                created_at: '2026-01-01T10:00:00Z',
                updated_at: '2026-01-02T10:00:00Z',
                closed_at: null,
                merged_at: null,
                labels: [{ id: 1, name: 'aeroci', color: 'ededed' }],
                milestone: null,
                active_lock_reason: null,
                draft: false,
                base: {
                    ref: state.defaultBranch, sha: state.sha,
                    repo, user: sender, label: state.defaultBranch
                },
                head: {
                    ref: state.refName, sha: state.sha,
                    repo, user: sender, label: state.owner + ':' + state.refName
                },
                mergeable: true,
                mergeable_state: 'clean',
                merged: false,
                merge_commit_sha: null,
                comments: 0,
                review_comments: 0,
                commits: 1,
                additions: 12, deletions: 3, changed_files: 2,
                author_association: 'OWNER',
                _links: {}
            };
            return eventName === 'pull_request'
                ? { action: 'opened', number, pull_request: pr, repository: repo, sender, installation: null }
                : { action: 'opened', number, pull_request: pr, repository: repo, sender, installation: null };
        }
        case 'workflow_dispatch':
            return { inputs, workflow: '', ref: state.ref, repository: repo, sender, enterprise: null };
        case 'schedule':
            return { schedule: '0 0 * * *', repository: repo, sender, organization: {}, enterprise: null };
        case 'release':
            return {
                action: 'published',
                release: {
                    url: `https://api.github.com/repos/${state.repository}/releases/${number}`,
                    id: number, tag_name: `v1.0.${seededInt(state.sha, 1, 40)}`,
                    name: 'Simulated release', draft: false, prerelease: false,
                    published_at: '2026-01-01T10:00:00Z', body: '', html_url: 'https://github.com'
                },
                repository: repo, sender
            };
        case 'issue_comment':
            return {
                action: 'created',
                issue: {
                    number, title: 'Simulated issue', body: 'Simulated issue body',
                    user: sender, state: 'open', labels: [], comments: 1,
                    html_url: `https://github.com/${state.repository}/issues/${number}`
                },
                comment: {
                    id: number, body: 'Simulated comment body', user: sender,
                    created_at: '2026-01-01T10:00:00Z', html_url: 'https://github.com'
                },
                repository: repo, sender
            };
        case 'push':
        default:
            return {
                ref: state.ref,
                before: ZERO_SHA,
                after: state.sha,
                created: false,
                deleted: false,
                forced: false,
                base_ref: null,
                compare: `https://github.com/${state.repository}/compare/${ZERO_SHA}...${state.sha}`,
                commits: buildCommits(state, Math.min(state.commitCount, 3)),
                head_commit: {
                    id: state.sha,
                    tree_id: '0'.repeat(40),
                    message: state.commitMessage,
                    timestamp: '2026-01-01T10:00:00Z',
                    author: { name: state.commitAuthor, email: state.authorEmail, username: state.owner },
                    committer: { name: state.commitAuthor, email: state.authorEmail, username: state.owner },
                    url: `https://github.com/${state.repository}/commit/${state.sha}`
                },
                repository: repo,
                pusher: sender,
                sender
            };
    }
}

/** The `github` context — same keys the runner exposes. */
function buildGithubContext(state, eventName, payload, { workflowFile, workflowName, runId, runNumber, workspace, jobId = '', matrix = null }) {
    const repository = state.repository;
    const base = state.isRepo ? state.ref : `refs/heads/${state.defaultBranch}`;
    const github = {
        token: 'local-simulation-token',
        job: jobId,
        ref: base,
        ref_name: state.refName,
        ref_protected: state.refName === state.defaultBranch,
        ref_type: state.refType,
        // The workflow's `name:`, falling back to the file name — which is what
        // GitHub does when a workflow has no name. Using the file name
        // unconditionally made `if: github.workflow == 'CI'` false here and true
        // on the runner.
        workflow: workflowName || workflowFile,
        workspace,
        action: '',
        action_path: '',
        action_ref: '',
        action_repository: '',
        actor: state.owner,
        triggering_actor: state.owner,
        api_url: 'https://api.github.com',
        server_url: 'https://github.com',
        graphql_url: 'https://api.github.com/graphql',
        head_ref: '',
        base_ref: '',
        event_name: eventName,
        event_path: '',
        event: payload,
        repository,
        repository_owner: state.owner,
        repositoryUrl: `git+https://github.com/${repository}.git`,
        run_id: String(runId),
        run_number: String(runNumber),
        run_attempt: '1',
        secret_source: 'None',
        sha: state.sha,
        server: 'local-digital-twin',
        retention_days: '90',
        path: '.',
        env: 'aeroci-local'
    };
    return github;
}

module.exports = { readGitState, buildEventPayload, buildGithubContext, ZERO_SHA };
