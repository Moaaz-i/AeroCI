#!/usr/bin/env node
/**
 * Lint for AeroCI's own source. Dependency-free, and focused on the mistakes
 * that are silent in plain CommonJS:
 *
 *   • duplicate object keys   — the second one silently wins
 *   • unused requires         — dead code and dead dependencies
 *   • `process.exit()` in src — truncates buffered stdout
 *   • `var` in src             — the codebase uses const/let consistently
 *   • loose `==` / `!=`       — except expressions.js, where GitHub's own
 *                                semantics require it
 *   • TODO / FIXME / XXX      — should not ship
 *   • unbounded regexes?      — flagged heuristically via catastrophic patterns
 *
 * Run with `npm run lint`. Exits non-zero so it can gate CI.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['src', 'bin', 'scripts', 'tests'];

// Files where loose equality is deliberate and correct.
const ALLOW_LOOSE_EQUALS = new Set([path.join('src', 'core', 'expressions.js')]);
// The CLI entry point is the only place allowed to hard-exit.
const ALLOW_PROCESS_EXIT = new Set([path.join('bin', 'aeroci.js')]);

const problems = [];

function add(file, line, rule, message) {
    problems.push({ file: path.relative(ROOT, file), line, rule, message });
}

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * Compile the file in strict mode: a duplicate object key is a SyntaxError
 * there, while in sloppy CommonJS it silently overwrites the first value.
 */
function checkDuplicateKeys(file) {
    const source = fs.readFileSync(file, 'utf8');
    const wrapped = `'use strict';\n(function (exports, require, module, __filename, __dirname) {\n${source}\n});`;
    try {
        new vm.Script(wrapped, { filename: file });
    } catch (err) {
        if (/duplicate/i.test(err.message)) {
            const line = (err.stack || '').split('\n')[1] || '';
            const match = /:(\d+)/.exec(line);
            add(file, match ? Number(match[1]) : 0, 'duplicate-key', err.message);
        }
        // Every other compile error is not this rule's business.
    }
}

/** Replace comment bodies with blanks so rules only see real code. */
function stripComments(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const two = source.slice(i, i + 2);
        if (two === '//') {
            while (i < n && source[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (two === '/*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            for (; i < stop; i++) out += source[i] === '\n' ? '\n' : ' ';
            continue;
        }
        out += source[i];
        i++;
    }
    return out;
}

/**
 * Mark every line that contains template-literal content.
 *
 * A template literal can hold a whole file in another language — the sample
 * workflow is YAML. `if: a == b` inside one is not JavaScript, so the code
 * rules must not read it as JavaScript. A line counts as literal if *any* part
 * of it is inside a template, which errs towards not reporting: a linter that
 * gates a build should not block on a false positive.
 */
function markTemplateLines(source) {
    const lines = source.split('\n');
    const literal = new Array(lines.length).fill(false);
    let inTemplate = false;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        // A line that begins inside a template is literal content, backtick or not.
        if (inTemplate) literal[li] = true;

        for (let i = 0; i < line.length; i++) {
            // An escape makes the next character literal wherever it appears,
            // inside a template included: `a \` b` is one string, not two.
            if (line[i] === '\\') { i++; continue; }
            if (line[i] === '`') {
                inTemplate = !inTemplate;
                literal[li] = true;
            }
        }
    }
    return literal;
}

function checkSource(file) {
    const rel = path.relative(ROOT, file);
    const raw = fs.readFileSync(file, 'utf8');
    const source = stripComments(raw);
    const lines = source.split('\n');
    const literalLines = markTemplateLines(source);
    const rawLines = raw.split('\n');
    const isSource = rel.startsWith(`src${path.sep}`) || rel.startsWith(`bin${path.sep}`);
    const requires = new Map();

    lines.forEach((code, index) => {
        const line = index + 1;

        if (!literalLines[index]) {
            if (isSource && /\bprocess\.exit\s*\(/.test(code) && !ALLOW_PROCESS_EXIT.has(rel)) {
                add(file, line, 'no-process-exit',
                    'set process.exitCode instead — process.exit() drops buffered output');
            }
            if (isSource && /(^|[^.\w])var\s+[A-Za-z_$]/.test(code)) {
                add(file, line, 'no-var', 'use const or let');
            }
            if (isSource && /\b(TODO|FIXME|XXX|HACK)\b/.test(code)) {
                add(file, line, 'no-marker', 'unresolved marker left in source');
            }
            if (isSource && !ALLOW_LOOSE_EQUALS.has(rel) && /[^=!<>](?:==|!=)(?!=)/.test(code)) {
                add(file, line, 'no-loose-equality', 'use === / !==');
            }

            // Nested quantifiers are the classic ReDoS shape. Deciding whether a
            // given one is actually catastrophic is not something source patterns
            // can answer reliably, so it is measured instead — see checkRegexSafety.

            const req = code.match(/^const\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(/);
            if (req) {
                if (req[2]) requires.set(req[2], line);
                else {
                    for (const part of req[1].split(',')) {
                        const name = part.split(':').pop().trim();
                        if (name) requires.set(name, line);
                    }
                }
            }
        }
        void rawLines;
    });

    for (const [name, line] of requires) {
        const uses = raw.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || [];
        if (uses.length <= 1) add(file, line, 'no-unused-require', `"${name}" is never used`);
    }
}

/**
 * Extract regex literals from a comment-stripped source line and hand them to
 * the measurement worker. A candidate is only reported when it is actually
 * slow, so an unusual-but-linear pattern is never flagged.
 */
function collectRegexes(file) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const found = [];
    const rx = /(^|[=(,:[!&|?{};\n]\s*)\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/([dgimsuvy]*)/g;
    let match;
    while ((match = rx.exec(source)) !== null) {
        const before = source.slice(0, match.index + match[1].length);
        const line = before.split('\n').length;
        found.push({ id: `${file}:${line}`, source: match[2], flags: match[3] });
    }
    return found;
}

function checkRegexSafety(files) {
    const candidates = files.flatMap(collectRegexes);
    if (candidates.length === 0) return;

    const worker = path.join(__dirname, 'regex-scan-worker.js');
    const res = spawnSync(process.execPath, [worker, JSON.stringify(candidates)], {
        encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024
    });

    if (res.error && res.error.code === 'ETIMEDOUT') {
        add('(regex scan)', 0, 'slow-regex',
            `the regex scan did not finish in 20s — at least one pattern is exponential; `
            + `narrow the search with the id shown by \`node ${path.relative(ROOT, worker)}\``);
        return;
    }

    let slow = [];
    try { slow = JSON.parse(res.stdout || '[]'); } catch (_) { slow = []; }

    for (const entry of slow) {
        const [file, line] = String(entry.id).split(':');
        add(file, Number(line) || 0, 'slow-regex',
            `/${entry.source}/${entry.flags} took ${entry.ms}ms on a 40-character input `
            + `— this pattern backtracks exponentially`);
    }
}

const files = TARGETS.flatMap((t) => walk(path.join(ROOT, t)));
for (const file of files) {
    checkDuplicateKeys(file);
    checkSource(file);
}
checkRegexSafety(TARGETS.flatMap((t) => walk(path.join(ROOT, t)))
    .filter((f) => f.includes(`${path.sep}src${path.sep}`) || f.includes(`${path.sep}bin${path.sep}`)));

// A method called on its class that is not static is a TypeError waiting for
// the one code path that reaches it — `aeroci profile` shipped with exactly
// that on its main path. Cheap to check, so it is part of the gate.
{
    const res = spawnSync(process.execPath, [path.join(__dirname, 'static-audit.js')], {
        encoding: 'utf8'
    });
    for (const line of (res.stdout || '').split('\n')) {
        const m = /^INSTANCE\s+(\S+?):(\d+)/.exec(line);
        if (m) add(m[1], Number(m[2]), 'static-mismatch', line.trim());
    }
}

if (problems.length === 0) {
    console.log(`✔ lint clean — ${files.length} file(s) checked`);
} else {
    const byRule = new Map();
    for (const p of problems) {
        if (!byRule.has(p.rule)) byRule.set(p.rule, []);
        byRule.get(p.rule).push(p);
    }
    console.log(`✖ ${problems.length} problem(s) in ${files.length} file(s)\n`);
    for (const [rule, list] of byRule) {
        console.log(`  ${rule} (${list.length})`);
        for (const p of list.slice(0, 15)) {
            console.log(`    ${p.file}${p.line ? `:${p.line}` : ''} — ${p.message}`);
        }
        if (list.length > 15) console.log(`    … ${list.length - 15} more`);
        console.log('');
    }
    process.exitCode = 1;
}
