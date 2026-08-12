/**
 * Interactive Debug Sandbox Engine
 * Spawns an interactive subshell configured with simulated GitHub Actions environment context.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Logger, colors } = require('../utils/logger');

class Debugger {
    static start(stepContext = {}) {
        Logger.info(`Spawning interactive CI Debug Sandbox environment...`);
        console.log(colors.gray + `Press Ctrl+D or type 'exit' to leave debug mode.\n` + colors.reset);

        const envFilePath = path.join(process.cwd(), '.env');
        const debugEnv = { 
            ...process.env, 
            CI: 'true', 
            GITHUB_ACTIONS: 'true', 
            DRIFT_DEBUG: '1',
            PS1: 'ci-drift-sandbox 🌀 \\W $ '
        };

        if (fs.existsSync(envFilePath)) {
            const envRaw = fs.readFileSync(envFilePath, 'utf8');
            envRaw.split('\n').forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const val = parts.slice(1).join('=').trim();
                    if (key && !key.startsWith('#')) {
                        debugEnv[key] = val;
                    }
                }
            });
        }

        Logger.success(`Sandbox environment ready. Context variables loaded:`);
        Logger.metric('CI', debugEnv.CI);
        Logger.metric('GITHUB_ACTIONS', debugEnv.GITHUB_ACTIONS);
        Logger.metric('Working Directory', process.cwd());
        console.log(colors.gray + '--------------------------------------------------' + colors.reset);

        const shell = process.env.SHELL || '/bin/zsh';
        spawnSync(shell, ['-i'], {
            cwd: process.cwd(),
            env: debugEnv,
            stdio: 'inherit'
        });

        Logger.info(`Exited debug sandbox mode.`);
    }
}

module.exports = { Debugger };
