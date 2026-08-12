/**
 * CI-Drift Advanced Terminal Logger & Visual Utilities v1.5.0
 */

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    gray: "\x1b[90m",
    bgCyan: "\x1b[46m",
    whiteBold: "\x1b[1m\x1b[37m"
};

class Logger {
    static banner() {
        console.log(`
${colors.cyan}${colors.bright}  ____ ___   ____  ____ _____ _____ _____ 
 / ___|_ _| |  _ \\|  _ \\_   _|_   _|_   _|
| |    | |  | | | | |_) || | | |_    | |  
| |___ | |  | |_| |  _ < | | |  _|   | |  
 \\____|___| |____/|_| \\_\\|_| |_|     |_|  ${colors.reset}
${colors.gray} Local Digital Twin & CI Pipeline Simulator v1.5.0 (50+ Enterprise Features)${colors.reset}
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

    static security(msg) {
        console.log(`${colors.magenta}🛡️ [Security Guard]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static metric(label, value, extra = "") {
        console.log(`  ${colors.gray}•${colors.reset} ${colors.bright}${label.padEnd(26)}:${colors.reset} ${colors.cyan}${value}${colors.reset} ${colors.gray}${extra}${colors.reset}`);
    }

    static table(headers, rows) {
        const colWidths = headers.map((h, i) => {
            const maxRowLen = rows.reduce((max, r) => Math.max(max, String(r[i] || '').length), 0);
            return Math.max(h.length, maxRowLen) + 3;
        });

        const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;
        
        console.log('\n' + colors.gray + '┌' + '─'.repeat(totalWidth) + '┐' + colors.reset);
        const headerStr = headers.map((h, i) => ' ' + h.padEnd(colWidths[i] - 1)).join('');
        console.log(`${colors.gray}│${colors.reset}${colors.whiteBold}${headerStr}${colors.reset}${colors.gray}│${colors.reset}`);
        console.log(colors.gray + '├' + '─'.repeat(totalWidth) + '┤' + colors.reset);
        for (const row of rows) {
            const rowStr = row.map((r, i) => ' ' + String(r || '').padEnd(colWidths[i] - 1)).join('');
            console.log(`${colors.gray}│${colors.reset}${colors.cyan}${rowStr}${colors.reset}${colors.gray}│${colors.reset}`);
        }
        console.log(colors.gray + '└' + '─'.repeat(totalWidth) + '┘' + colors.reset + '\n');
    }
}

module.exports = { Logger, colors };
