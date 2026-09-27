#!/usr/bin/env node
/**
 * Lint for AeroCI's own source. Dependency-free, and focused on the mistakes
 * that are silent in plain CommonJS:
 *
 *   • a file that does not parse — the gate used to pass unparseable code
 *   • duplicate object keys   — the second one silently wins
 *   • duplicate bindings      — a parameter or pattern named twice
 *   • unused requires         — dead code and dead dependencies
 *   • `process.exit()` in src — truncates buffered stdout
 *   • raw `console.log` in src — bypasses the quiet flag the logger promises
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
// The logger is where a raw write belongs. Anywhere else, `console.log` prints
// even when the caller has asked for silence — and `Logger.setQuiet(true)` is a
// promise to a library consumer that nothing is printed. 77 of them were doing
// exactly that while the flag existed.
const ALLOW_RAW_CONSOLE = new Set([path.join('src', 'utils', 'logger.js')]);

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
 * The two lines the wrapper adds above the source, so a reported line can be
 * mapped back to the file the reader opens.
 */
const WRAPPER_OFFSET = 2;

/**
 * Compile the file and report whatever is wrong with it.
 *
 * This used to be `checkDuplicateKeys`, and it had a hole shaped exactly like
 * the bug it was written for: every compile error that was not a duplicate was
 * discarded with a comment saying it was "not this rule's business". So a file
 * with a syntax error passed the gate — `src/core/analyzer.js` once sat with an
 * unescaped backtick while the linter reported `lint clean — 53 file(s)
 * checked`. A quality gate that certifies unparseable code is decoration.
 *
 * V8 also does *not* treat a duplicate object-literal key as an error in
 * either mode, so this cannot be the place duplicate keys are caught. The
 * compiler catches what it catches (duplicate parameters, duplicate
 * destructuring bindings); `checkDuplicateObjectKeys` covers the rest.
 */
function checkCompiles(file) {
    const source = fs.readFileSync(file, 'utf8');
    // A shebang is not JavaScript, and `vm.Script` does not strip one the way
    // Node's own loader does — so seven files with `#!/usr/bin/env node` came
    // back as "Invalid or unexpected token" on line 1. Replace it with a
    // comment rather than deleting it, so line numbers still line up.
    const body = source.startsWith('#!')
        ? `//${source.slice(2, source.indexOf('\n') < 0 ? source.length : source.indexOf('\n'))}${source.slice(source.indexOf('\n') < 0 ? source.length : source.indexOf('\n'))}`
        : source;
    const wrapped = `'use strict';\n(function (exports, require, module, __filename, __dirname) {\n${body}\n});`;
    let err;
    try {
        new vm.Script(wrapped, { filename: file });
    } catch (e) {
        err = e;
    }
    if (!err) return;

    // V8 puts `<filename>:<line>` on the first frame and the offending source
    // text on the second, so the line has to come from the first and the
    // wrapper's two lines have to be subtracted. Reading the number out of the
    // source text — which the old version did — produced a line number that
    // pointed at whichever digit happened to be in the code.
    const frame = (err.stack || '').split('\n')[0] || '';
    const match = /:(\d+)$/.exec(frame.trim());
    const line = match ? Math.max(1, Number(match[1]) - WRAPPER_OFFSET) : 0;

    if (/duplicate|already been declared/i.test(err.message)) {
        add(file, line, 'duplicate-binding', err.message);
    } else {
        add(file, line, 'parse-error', err.message.split('\n')[0]);
    }
}

/**
 * Keywords that hand whatever follows them to a value rather than to a binding,
 * so a `{` after one of these can open an object literal.
 */
const VALUE_KEYWORDS = new Set([
    'return', 'typeof', 'await', 'yield', 'throw', 'new', 'in', 'of',
    'case', 'do', 'else', 'void', 'delete', 'instanceof'
]);

/**
 * The punctuation that can precede a value. `(` and `,` are absent on purpose:
 * both are also where a destructuring parameter or assignment pattern starts, and
 * the two cannot be told apart without a parser.
 *
 * `>` is here for a real case — `x > {}` is valid JavaScript — and it means an
 * arrow body is scanned as though it were a literal. That was measured over ten
 * arrow shapes and 123 library files and changed no outcome, so the `=>` body is
 * not special-cased; a block has no depth-1 token that can repeat.
 */
const VALUE_PUNCT = new Set([
    '=', ':', '[', '?', '!', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^', '~'
]);

/**
 * Duplicate keys in an object literal.
 *
 * The second one silently wins, so `{ port: 3000, port: 8080 }` is a value you
 * wrote and a value you shipped, with nothing between them. The compiler will
 * not tell you: V8 accepts duplicate keys in both strict and sloppy mode, which
 * is why this rule exists rather than being folded into `checkCompiles`.
 *
 * Finding a literal's bounds without a parser is the hard part, and the first two
 * attempts at it were wrong in the expensive direction: one reported 63 findings
 * on 53 clean files, and another named lines that had nothing to do with the
 * match. A linter that blocks a build on a guess trains people to ignore it, so
 * the guess is removed instead of tuned.
 *
 * What does the work is one question asked of every `{`: is this a *value*?
 * A `{` after `=` or `return` or `:` is a literal. A `{` after `const` is a
 * pattern, after `=>` is a block, and after `(` or `,` could be either. Once
 * that is answered, the rest of the scan can stay naive, because a confirmed
 * literal has nothing in it that looks like a key except keys.
 *
 * There was also a second gate here — cut the region, hand it to `new
 * vm.Script` in parentheses, and skip anything that does not compile as an
 * expression. It was measurably dead: with the value test in front of it, the
 * two agreed on all 30 purpose-built stress snippets and on 123 real library
 * files. It is gone rather than left in as untested insurance.
 *
 * Keys that cannot be compared as text — computed `[name]:` and shorthand — are
 * not reported: a computed key needs evaluating to know its name, and a repeated
 * shorthand is a redeclaration the compiler already rejects.
 */
function checkDuplicateObjectKeys(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const literalLines = markTemplateLines(code);
    const rawLines = code.split('\n');

    // One text, plus a parallel array giving the source line of every character.
    // Line numbers are the whole point of a finding, and the first version
    // resolved them against a differently filtered string, so every message
    // pointed at unrelated code.
    //
    // Blanking template lines is what keeps this rule out of the sample
    // workflows, which are YAML in template literals: `matrix: { n: [1], n: [2] }`
    // is a duplicate to a YAML reader and a duplicate key to this one, and only
    // the second is a bug. The cost is that a line which happens to contain a
    // backtick is blanked whole, so a real duplicate on that line is missed —
    // the safe direction to be wrong in, and the reason this scan has no
    // backtick case of its own: a template can never reach it.
    let text = '';
    const lineOf = [];
    rawLines.forEach((lineText, i) => {
        // A line inside a template is content, not code — the sample workflow is
        // YAML and reads as `if: a == b`.
        const body = literalLines[i] ? '' : lineText;
        for (let c = 0; c < body.length; c++) lineOf.push(i + 1);
        lineOf.push(i + 1);
        text += body + '\n';
    });

    /** Skip a string or template literal starting at `i`; returns the index after it. */
    const skipString = (i) => {
        const quote = text[i];
        for (let k = i + 1; k < text.length; k++) {
            if (text[k] === '\\') { k++; continue; }
            if (text[k] === quote) return k + 1;
        }
        return text.length;
    };

    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;

        // Only a `{` in a *value* position can be an object literal, and that
        // single question is what separates a literal from a pattern: `{ a: x,
        // a: y }` reads as either, the text is identical, and reporting the
        // pattern version claims "the last one silently wins" about
        // `const { a: x, a: y } = src`, where both bindings are created and
        // nothing is overridden. A `{` after `const` is therefore a pattern.
        //
        // The cost is stated rather than hidden: a duplicate key in a literal
        // passed straight to a call, `f({ a: 1, a: 2 })`, is not reported. A
        // missed bug is recoverable; a message that says something false about
        // working code is how a gate gets ignored.
        let p = i - 1;
        while (p >= 0 && /\s/.test(text[p])) p--;
        if (p < 0) continue; // the start of the file
        const before = text[p];
        const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(0, p + 1));
        if (word) {
            if (!VALUE_KEYWORDS.has(word[1])) continue;
        } else if (!VALUE_PUNCT.has(before)) {
            continue;
        }

        // Cut the balanced-brace region, skipping over strings and templates.
        let depth = 1;
        let end = i + 1;
        for (; end < text.length && depth > 0; end++) {
            const c = text[end];
            if (c === '"' || c === "'" || c === '`') { end = skipString(end); continue; }
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
        if (depth !== 0) continue;
        end -= 1; // the closing brace

        // Note what is *not* done here: the scan does not jump past the region.
        // A literal nested inside a function body, a `try` block or an array is
        // reached because its own `{` is proposed on a later turn — and the first
        // version of this rule skipped the whole enclosing region instead, which
        // missed every literal in this codebase, because most of them live
        // inside a function.

        // Count the keys at depth 1.
        const seen = new Map();
        let d = 1;
        for (let k = i + 1; k < end; k++) {
            const c = text[k];
            if (c === '{' || c === '[' || c === '(') { d++; continue; }
            if (c === '}' || c === ']' || c === ')') { d--; continue; }
            if (d !== 1) continue;

            // A ternary's true-branch ends in ` : `, which is exactly the shape of
            // a key. `jobId: step ? step.jobId : ''` is a single `jobId` written
            // twice — once as a key, once as the end of a conditional — and reading
            // the second one as a key reported a duplicate in four files that have
            // none. So the branch is stepped over: to the `:` at the same bracket
            // depth, skipping strings and nested brackets on the way.
            if (c === '?' && text[k + 1] !== '.' && text[k + 1] !== '?') {
                let td = 0;
                for (let m = k + 1; m < end; m++) {
                    const t = text[m];
                    if (t === '"' || t === "'" || t === '`') { m = skipString(m) - 1; continue; }
                    if (t === '{' || t === '[' || t === '(') { td++; continue; }
                    if (t === '}' || t === ']' || t === ')') { if (td === 0) break; td--; continue; }
                    if (t === ':' && td === 0) { k = m; break; }
                }
                continue;
            }

            let key = null;
            if (c === '"' || c === "'") {
                // A string is a key only if a `:` follows it. Skipping every
                // string instead would have made `{ a: 'x', x: 1 }` look like a
                // duplicate — a value that happens to read like a later key.
                // Reading every string as a key instead would have missed
                // `{ 'x': 1, "x": 2 }`, a real duplicate across quote styles.
                const stop = skipString(k);
                const after = text.slice(stop).match(/^\s*:(?!:)/);
                if (after) key = text.slice(k + 1, stop - 1);
                k = stop - 1;
            } else {
                const m = /^([A-Za-z_$][\w$]*)\s*:(?!:)/.exec(text.slice(k));
                if (m) { key = m[1]; k += m[0].length - 1; }
            }
            if (key === null) continue;

            if (seen.has(key)) {
                add(file, lineOf[k], 'duplicate-key',
                    `key "${key}" is already set on line ${seen.get(key)} — the last one silently wins`);
            } else {
                seen.set(key, lineOf[k]);
            }
        }
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
            if (isSource && !ALLOW_RAW_CONSOLE.has(rel) && /\bconsole\.(?:log|error)\s*\(/.test(code)) {
                add(file, line, 'no-raw-console',
                    'use Logger.emit / Logger.emitErr — console.log ignores the quiet flag');
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
    checkCompiles(file);
    checkDuplicateObjectKeys(file);
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
