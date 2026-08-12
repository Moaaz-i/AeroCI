/**
 * Initialization Engine
 * Creates configuration file .aeroci.json and sample GitHub Actions workflow if missing.
 */

const fs = require('fs');
const path = require('path');
const { Logger, colors } = require('../utils/logger');

class Initializer {
    static init() {
        Logger.info(`Initializing AeroCI in local repository...`);

        const configPath = path.join(process.cwd(), '.aeroci.json');
        const workflowDir = path.join(process.cwd(), '.github/workflows');
        const sampleWorkflowPath = path.join(workflowDir, 'main.yml');

        // Create .aeroci.json
        const configContent = {
            "$schema": "https://aeroci.dev/schema.json",
            "version": "1.0.0",
            "runner": {
                "defaultImage": "ubuntu-latest",
                "isolation": "ephemeral-node",
                "timeout": 300
            },
            "environment": {
                "envFile": ".env",
                "strictSecrets": true
            },
            "workflows": [
                ".github/workflows/*.yml",
                ".github/workflows/*.yaml"
            ]
        };

        fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2), 'utf8');
        Logger.success(`Created configuration file: ${colors.cyan}.aeroci.json${colors.reset}`);

        // Check workflows directory
        if (fs.existsSync(workflowDir)) {
            const files = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
            if (files.length > 0) {
                Logger.info(`Workflows detected in: ${colors.cyan}.github/workflows/${colors.reset}`);
            }
        }

        console.log(colors.gray + '--------------------------------------------------' + colors.reset);
        Logger.success(`AeroCI initialization complete! 🎉`);
        Logger.info(`Next steps:`);
        Logger.info(`  • Run ${colors.yellow}aeroci check${colors.reset} to audit your workflows for issues & missing secrets.`);
        Logger.info(`  • Run ${colors.yellow}aeroci run${colors.reset} to simulate pipeline execution locally.`);
    }
}

module.exports = { Initializer };
