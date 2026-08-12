/**
  * CI-Drift Terminal Logger & Visual Utilities
  * Standard ANSI escape codes for reliable color output across all chalk versions.
  */

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    gray: "\x1b[90m"
};

class Logger {
    static banner() {
        console.log(`
${colors.cyan}${colors.bright}  ____ ___   ____  ____ _____ _____ _____ 
 / ___|_ _| |  _ \\|  _ \\_   _|_   _|_   _|
| |    | |  | | | | |_) || | | |_    | |  
| |___ | |  | |_| |  _ < | | |  _|   | |  
 \\____|___| |____/|_| \\_\\|_| |_|     |_|  ${colors.reset}
${colors.gray} Local Digital Twin & CI Pipeline Simulator v1.0.0${colors.reset}
        `);
    }

    static info(msg) {
        console.log(`${colors.cyan}ℹ [CI-Drift]${colors.reset} ${msg}`);
    }

    static success(msg) {
        console.log(`${colors.green}✔ [CI-Drift]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static warn(msg) {
        console.log(`${colors.yellow}⚠ [CI-Drift Warning]${colors.reset} ${msg}`);
    }

    static error(msg) {
        console.error(`${colors.red}✖ [CI-Drift Error]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static metric(label, value, extra = "") {
        console.log(`  ${colors.gray}•${colors.reset} ${colors.bright}${label.padEnd(24)}:${colors.reset} ${colors.cyan}${value}${colors.reset} ${colors.gray}${extra}${colors.reset}`);
    }
}

module.exports = { Logger, colors };
