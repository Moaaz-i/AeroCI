/**
 * AeroCI Terminal Logger
 *
 * Colour handling is TTY aware and honours NO_COLOR / FORCE_COLOR so that piped
 * or captured output stays clean and greppable.
 */

const SUPPORTS_COLOR = (() => {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
    if (process.env.TERM === 'dumb') return false;
    return !!process.stdout.isTTY;
})();

/**
 * Colours are callable *and* usable as a template prefix:
 *   colors.red('boom')        → "\x1b[31mboom\x1b[0m"
 *   `a ${colors.red}b`        → "a \x1b[31mb"
 * The second form keeps the existing `${colors.gray}…${colors.reset}` style in
 * the rest of the codebase working.
 */
const wrap = (open, prefix) => {
    const fn = (text) => (SUPPORTS_COLOR ? `\x1b[${open}m${text}\x1b[0m` : String(text));
    Object.defineProperty(fn, 'toString', {
        value: () => (SUPPORTS_COLOR ? prefix ?? `\x1b[${open}m` : ''),
        enumerable: false
    });
    return fn;
};

const colors = {
    enabled: SUPPORTS_COLOR,
    reset:     wrap(0, ''),
    bright:    wrap(1),
    dim:       wrap(2),
    underline: wrap(4),
    cyan:      wrap(36),
    magenta:   wrap(35),
    green:     wrap(32),
    yellow:    wrap(33),
    red:       wrap(31),
    gray:      wrap(90),
    blue:      wrap(34),
    whiteBold: wrap('1;37', SUPPORTS_COLOR ? '\x1b[1m\x1b[37m' : ''),
    strip: (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
};

const ICONS = {
    info: 'ℹ',
    success: '✔',
    warn: '⚠',
    error: '✖',
    security: '🛡️',
    step: '↳',
    job: '▶',
    debug: '⚙'
};

class Logger {
    static setDebug(on) { this._debug = !!on; }
    static get debug() { return !!this._debug; }

    /**
     * Suppress every line AeroCI prints.
     *
     * Used when the code is running as a library — the test suite drives
     * `Engine.run()` directly and asserts on the returned record, so the
     * engine's own progress output is noise that hides which test is talking.
     * The result object is unaffected.
     */
    static setQuiet(on) { this._quiet = !!on; }
    static get quiet() { return !!this._quiet; }

    static emit(text) { if (!this._quiet) console.log(text); }
    static emitErr(text) { if (!this._quiet) console.error(text); }

    static banner(subtitle = '') {
        const v = require('../version').banner;
        const art = [
            '    _                 ____ ___ ',
            '   / \\   ___ _ __ ___/ ___|_ _|',
            '  / _ \\ / _ \\ \'__/ _ \\___ \\| | ',
            ' / ___ \\  __/ | | (_) |__) | | ',
            '/_/   \\_\\___|_|  \\___/____/___|'
        ].join('\n');
        this.emit(`\n${SUPPORTS_COLOR ? '\x1b[36m\x1b[1m' : ''}${art}${colors.reset}`);
        this.emit(`${colors.gray} ${v}${subtitle ? ` — ${subtitle}` : ''}${colors.reset}\n`);
    }

    static info(msg)    { this.emit(`${colors.cyan}${ICONS.info} [AeroCI]${colors.reset} ${msg}`); }
    static success(msg) { this.emit(`${colors.green}${ICONS.success} [AeroCI]${colors.reset} ${colors.bright(msg)}`); }
    static warn(msg)    { this.emit(`${colors.yellow}${ICONS.warn} [AeroCI Warning]${colors.reset} ${msg}`); }
    static error(msg)   { this.emitErr(`${colors.red}${ICONS.error} [AeroCI Error]${colors.reset} ${colors.bright(msg)}`); }
    static security(msg){ this.emit(`${colors.magenta}${ICONS.security} [Security Guard]${colors.reset} ${colors.bright(msg)}`); }
    static step(msg)    { this.emit(`  ${colors.cyan}${ICONS.step}${colors.reset} ${msg}`); }
    static job(msg)     { this.emit(`${colors.magenta}${colors.bright(ICONS.job)}${colors.reset} ${msg}`); }
    static note(msg)    { this.emit(`  ${colors.gray}${msg}${colors.reset}`); }

    static debug(msg) {
        if (!this._debug) return;
        this.emit(`${colors.gray}${ICONS.debug} [debug] ${msg}${colors.reset}`);
    }

    static blank() { this.emit(''); }

    static metric(label, value, extra = '') {
        this.emit(`  ${colors.gray}•${colors.reset} ${colors.bright(String(label).padEnd(26))}:${colors.reset} ${colors.cyan(value)}${colors.reset}${extra ? ` ${colors.gray(extra)}` : ''}`);
    }

    static timing(label, ms) {
        const dur = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
        const color = ms > 30000 ? colors.red : ms > 5000 ? colors.yellow : colors.green;
        this.emit(`  ${colors.gray}•${colors.reset} ${String(label).padEnd(26)}: ${color(dur)}${colors.reset}`);
    }

    /**
     * Render an aligned table. Widths are computed on the ANSI-stripped text so
     * coloured cells line up correctly.
     */
    static table(headers, rows) {
        if (!rows || rows.length === 0) return;
        const colWidths = headers.map((h, i) => {
            const max = rows.reduce((m, r) => Math.max(m, colors.strip(r[i]).length), 0);
            return Math.max(colors.strip(h).length, max) + 2;
        });

        const rule = (l, m) => colors.gray(l + colWidths.map(w => '─'.repeat(w)).join('') + m);
        const row = (cells, style) => {
            const pad = (cell, w) => {
                const raw = String(cell ?? '');
                return ' ' + raw + ' '.repeat(Math.max(0, w - 2 - colors.strip(raw).length)) + ' ';
            };
            const body = cells.map((c, i) => pad(c, colWidths[i])).join('');
            return `${colors.gray}${style.left}${colors.reset}` +
                (style.bold ? colors.whiteBold(body) : body) +
                `${colors.gray}${style.right}${colors.reset}`;
        };

        this.emit('');
        this.emit(rule('┌', '┐'));
        this.emit(row(headers, { left: '│', right: '│', bold: true }));
        this.emit(rule('├', '┤'));
        for (const r of rows) this.emit(row(r, { left: '│', right: '│' }));
        this.emit(rule('└', '┘'));
        this.emit('');
    }
}

module.exports = { Logger, colors };
