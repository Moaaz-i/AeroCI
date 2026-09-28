/**
 * `aeroci init` — set up AeroCI in a project.
 *
 * Nothing is overwritten without saying so, and every file that gets written is
 * derived from the real configuration schema in ./config.js rather than a
 * hand-written copy that can drift away from what the code reads.
 */

const fs = require('fs');
const path = require('path');
const { Logger, colors } = require('../utils/logger');
const { Checker } = require('./checker');
const { DEFAULTS, CONFIG_NAME } = require('./config');
const { VERSION } = require('../version');

/** A workflow that actually exercises the features AeroCI simulates. */
const SAMPLE_WORKFLOW = `name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Read the workflow's own context
        id: context
        run: |
          echo "commit=\${GITHUB_SHA}" >> "$GITHUB_OUTPUT"
          echo "branch=\${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"
          echo "repo=\${GITHUB_REPOSITORY}" >> "$GITHUB_OUTPUT"

      - name: Fail on purpose
        # Delete this step once you have seen AeroCI catch a failure.
        if: github.event_name == 'workflow_dispatch'
        run: |
          echo "This step fails so you can check the failure output." >&2
          exit 1

      - name: Summarise
        if: always()
        run: |
          {
            echo "## \${{ steps.context.outputs.commit }}"
            echo "- branch: \${GITHUB_REF_NAME}"
            echo "- repository: \${GITHUB_REPOSITORY}"
          } >> "$GITHUB_STEP_SUMMARY"

  check:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        task: [lint, test]
    steps:
      - uses: actions/checkout@v4
      - name: \${{ matrix.task }}
        # Pass the matrix value through the environment. Writing \${{ matrix.task }}
        # straight into the script also works, but then a value containing a
        # space or a quote is injected as shell syntax.
        env:
          TASK: \${{ matrix.task }}
        run: |
          echo "Replace this with: npm run \\"$TASK\\""
`;

const SAMPLE_ENV = `# Copy to .env and fill in. AeroCI reads .env for \`secrets.*\` and \`vars.*\`.
# .env must never be committed — add it to .gitignore.
# AeroCI masks every value in .env from the log, exactly like a repository secret.

# MY_TOKEN=replace-me
`;

class Initializer {
    /**
     * @param {object} options
     * @param {boolean} options.force  overwrite existing files
     * @param {boolean} options.sample write the sample workflow
     * @param {boolean} options.env    write .env.example
     */
    static init(options = {}) {
        const cwd = path.resolve(options.cwd || process.cwd());
        const written = [];
        const skipped = [];

        Logger.info(`Setting up AeroCI ${VERSION} in ${path.relative(process.cwd(), cwd) || '.'}\n`);

        // ── .aeroci.json ───────────────────────────────────────────────────
        const configPath = path.join(cwd, CONFIG_NAME);
        if (fs.existsSync(configPath) && !options.force) {
            Logger.warn(`${CONFIG_NAME} already exists — left untouched (use --force to replace it).`);
            skipped.push(CONFIG_NAME);
        } else {
            fs.writeFileSync(configPath, `${JSON.stringify(sampleConfig(), null, 2)}\n`, 'utf8');
            written.push(CONFIG_NAME);
            Logger.success(`Created ${colors.cyan(CONFIG_NAME)}`);
        }

        // ── sample workflow ─────────────────────────────────────────────────
        if (options.sample !== false) {
            const workflowDir = path.join(cwd, '.github', 'workflows');
            const samplePath = path.join(workflowDir, 'aeroci-demo.yml');
            fs.mkdirSync(workflowDir, { recursive: true });

            const existing = existingWorkflows(workflowDir);
            if (existing.length && !options.force) {
                Logger.info(`Found ${existing.length} existing workflow(s) — no sample written.`);
            } else if (fs.existsSync(samplePath) && !options.force) {
                skipped.push('.github/workflows/aeroci-demo.yml');
            } else {
                fs.writeFileSync(samplePath, SAMPLE_WORKFLOW, 'utf8');
                written.push('.github/workflows/aeroci-demo.yml');
                Logger.success(`Created ${colors.cyan('.github/workflows/aeroci-demo.yml')}`);
            }
        }

        // ── .env.example ───────────────────────────────────────────────────
        if (options.env !== false) {
            const envExample = path.join(cwd, '.env.example');
            if (fs.existsSync(envExample) && !options.force) {
                skipped.push('.env.example');
            } else {
                fs.writeFileSync(envExample, SAMPLE_ENV, 'utf8');
                written.push('.env.example');
                Logger.success(`Created ${colors.cyan('.env.example')}`);
            }
        }

        // ── .gitignore ─────────────────────────────────────────────────────
        const gitignoreResult = ensureGitignore(cwd);
        if (gitignoreResult.added.length) {
            written.push('.gitignore');
            Logger.success(`Added to ${colors.cyan('.gitignore')}: ${gitignoreResult.added.join(', ')}`);
        }

        // ── report ─────────────────────────────────────────────────────────
        if (written.length === 0) {
            Logger.warn('Nothing to do — AeroCI is already set up here.');
        }

        const existing = existingWorkflows(path.join(cwd, '.github', 'workflows'));
        if (existing.length) {
            Logger.note(`Workflows found: ${existing.join(', ')}`);
        }

        Logger.emit(colors.gray + '─'.repeat(64) + colors.reset);
        if (existing.length) {
            Logger.success('Ready. Next:');
            Logger.info(`  ${colors.cyan('aeroci check')}      audit the workflows for defects and missing secrets`);
            Logger.info(`  ${colors.cyan('aeroci run')}       execute them in an isolated sandbox`);
        } else {
            Logger.success('Ready, but there are no workflows yet. Create one under .github/workflows/,');
            Logger.info(`or keep the sample: ${colors.cyan('aeroci run .github/workflows/aeroci-demo.yml')}`);
        }
        if (skipped.length) {
            Logger.note(`Left alone: ${skipped.join(', ')}`);
        }

        return { written, skipped, cwd };
    }

    /** Run the checker so `init` ends with something actionable. */
    static verify(cwd = process.cwd()) {
        const result = Checker.check(path.join(cwd, '.github/workflows'));
        return result;
    }
}

/** The config written by `init`, built from the real defaults. */
function sampleConfig() {
    return {
        version: DEFAULTS.version,
        // Where `aeroci run` looks when given no path.
        workflows: DEFAULTS.workflows,
        // Secrets and `vars` are read from this file.
        envFile: DEFAULTS.envFile,
        // Treat a referenced secret with no local value as an error.
        strictSecrets: DEFAULTS.strictSecrets,
        // `vars` can also be set here instead of in .env.
        vars: {
            NODE_ENV: 'test'
        },
        runner: {
            // null uses GitHub's default shell for the platform.
            shell: DEFAULTS.runner.shell,
            timeoutMinutes: DEFAULTS.runner.timeoutMinutes,
            maxOutputLines: DEFAULTS.runner.maxOutputLines
        },
        sandbox: {
            // 'copy' leaves the excluded paths out, which is what a fresh
            // checkout looks like. 'link' points them at your real
            // directories instead: not faster, but a step can use your
            // installed node_modules. Opt in only if you accept that a step
            // writing into them edits the real files.
            mode: DEFAULTS.sandbox.mode,
            exclude: DEFAULTS.sandbox.exclude,
            keep: DEFAULTS.sandbox.keep
        }
        // No `network` key, and there never will be one. Whether AeroCI and your
        // workflows may reach the network is a decision about the machine, so it
        // is recorded in ~/.aeroci/config.json — a file a repository cannot carry
        // and therefore cannot grant for itself. AeroCI asks once and writes it
        // there; you never have to edit this file to be asked.
    };
}

function existingWorkflows(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
    } catch (_) {
        return [];
    }
}

/**
 * Make sure generated files cannot be committed by accident.
 *
 * `.env` holds secrets. The reports are build output that would otherwise show
 * up in every diff. Neither belongs in a commit, so both are added.
 */
const IGNORED = ['.env', '.aeroci-artifacts/', 'aeroci-run.json', 'aeroci-report.html',
    'aeroci-report.xml', 'aeroci-summary.md', 'security-report.md'];

function ensureGitignore(cwd) {
    const file = path.join(cwd, '.gitignore');
    let content = '';
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (_) {
        fs.writeFileSync(file, `${IGNORED.join('\n')}\n`, 'utf8');
        return { added: [...IGNORED], created: true };
    }

    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const added = IGNORED.filter((entry) => !present.has(entry));
    if (added.length === 0) return { added: [], created: false };

    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    const header = present.size ? '\n# AeroCI\n' : '';
    fs.writeFileSync(file, `${content}${separator}${header}${added.join('\n')}\n`, 'utf8');
    return { added, created: false };
}

module.exports = { Initializer, SAMPLE_WORKFLOW };
