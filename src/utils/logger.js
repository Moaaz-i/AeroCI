/**
 * AeroCI Advanced Terminal Logger & Visual Utilities v2.0.1
 */

const colors = {
    reset:     "\x1b[0m",
    bright:    "\x1b[1m",
    dim:       "\x1b[2m",
    cyan:      "\x1b[36m",
    magenta:   "\x1b[35m",
    green:     "\x1b[32m",
    yellow:    "\x1b[33m",
    red:       "\x1b[31m",
    gray:      "\x1b[90m",
    blue:      "\x1b[34m",
    bgCyan:    "\x1b[46m",
    whiteBold: "\x1b[1m\x1b[37m"
};

class Logger {
    static banner() {
        console.log(`
${colors.cyan}${colors.bright}    _                 ____ ___ 
   / \   ___ _ __ ___/ ___|_ _|
  / _ \ / _ \ '__/ _ \___ \| | 
 / ___ \  __/ | | (_) |__) | | 
/_/   \_\___|_|  \___/____/___| ${colors.reset}
${colors.gray} Local Digital Twin & CI Pipeline Simulator v2.0.1 (100+ Enterprise Features)${colors.reset}
        `);
    }

    static info(msg) {
        console.log(`${colors.cyan}ℹ [AeroCI]${colors.reset} ${msg}`);
    }

    static success(msg) {
        console.log(`${colors.green}✔ [AeroCI]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static warn(msg) {
        console.log(`${colors.yellow}⚠ [AeroCI Warning]${colors.reset} ${msg}`);
    }

    static error(msg) {
        console.error(`${colors.red}✖ [AeroCI Error]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static security(msg) {
        console.log(`${colors.magenta}🛡️ [Security Guard]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
    }

    static metric(label, value, extra = "") {
        console.log(`  ${colors.gray}•${colors.reset} ${colors.bright}${label.padEnd(26)}:${colors.reset} ${colors.cyan}${value}${colors.reset} ${colors.gray}${extra}${colors.reset}`);
    }

    // ── Progress Bar ───────────────────────────────────────────────────────────
    static progressBar(current, total, label = '', width = 20) {
        const pct = total === 0 ? 100 : Math.round((current / total) * 100);
        const filled = Math.round((pct / 100) * width);
        const bar = colors.cyan + '█'.repeat(filled) + colors.gray + '░'.repeat(width - filled) + colors.reset;
        process.stdout.write(`\r  ${colors.gray}•${colors.reset} ${label.padEnd(20)} ${bar} ${pct}% (${current}/${total})`);
        if (current >= total) process.stdout.write('\n');
    }

    // ── Timing Annotation ─────────────────────────────────────────────────────
    static timing(label, ms) {
        const dur = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
        const color = ms > 30000 ? colors.red : ms > 5000 ? colors.yellow : colors.green;
        console.log(`  ${colors.gray}•${colors.reset} ${label.padEnd(26)}: ${color}${dur}${colors.reset}`);
    }

    // ── Step Counter ──────────────────────────────────────────────────────────
    static stepHeader(current, total, name, jobId) {
        const fraction = `${colors.gray}[${current}/${total}]${colors.reset}`;
        console.log(`\n  ${colors.cyan}${colors.bright}↳ Step ${fraction}:${colors.reset} ${colors.bright}${name}${colors.reset}  ${colors.gray}(${jobId})${colors.reset}`);
    }

    // ── Table ─────────────────────────────────────────────────────────────────
    static table(headers, rows) {
        const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
        const colWidths = headers.map((h, i) => {
            const maxRowLen = rows.reduce((max, r) => Math.max(max, stripAnsi(r[i] || '').length), 0);
            return Math.max(stripAnsi(h).length, maxRowLen) + 3;
        });

        const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;

        console.log('\n' + colors.gray + '┌' + '─'.repeat(totalWidth) + '┐' + colors.reset);
        const headerStr = headers.map((h, i) => ' ' + h.padEnd(colWidths[i] - 1)).join('');
        console.log(`${colors.gray}│${colors.reset}${colors.whiteBold}${headerStr}${colors.reset}${colors.gray}│${colors.reset}`);
        console.log(colors.gray + '├' + '─'.repeat(totalWidth) + '┤' + colors.reset);
        for (const row of rows) {
            const rowStr = row.map((r, i) =>
                ' ' + String(r || '').padEnd(colWidths[i] - 1 + (String(r || '').length - stripAnsi(r || '').length))
            ).join('');
            console.log(`${colors.gray}│${colors.reset}${rowStr}${colors.gray}│${colors.reset}`);
        }
        console.log(colors.gray + '└' + '─'.repeat(totalWidth) + '┘' + colors.reset + '\n');
    }
}

module.exports = { Logger, colors };
