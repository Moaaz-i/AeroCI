/**
 * GitHub Actions expression engine: `${{ … }}`.
 *
 * Implements the documented grammar:
 *   literals · contexts (github, env, matrix, job, jobs, steps, runner, secrets,
 *   strategy, needs, inputs, vars)
 *   postfix  .prop  [index]  [*]
 *   unary    !        relational  < <= > >=        equality  == !=
 *   logical  &&  ||            ternary  ? :
 *   functions contains startsWith endsWith format join toJSON fromJSON hashFiles
 *            success failure always cancelled
 *
 * Semantics that matter and are reproduced here:
 *   • string comparison is case-insensitive
 *   • truthiness follows Actions rules: false, 0, -0, '', null are falsy
 *   • values are loosely coerced when compared
 *   • `if:` is an expression on its own; `${{ }}` is optional there
 *   • unknown context paths evaluate to null (empty string when rendered)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Lexer ────────────────────────────────────────────────────────────────────

const PUNCT = ['&&', '||', '==', '!=', '>=', '<=', '(', ')', '[', ']', '.', ',', '?', ':', '>', '<', '!'];

function tokenize(input) {
    const tokens = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (/\s/.test(ch)) { i++; continue; }

        // number
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] || ''))) {
            const m = /^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(input.slice(i));
            tokens.push({ type: 'number', value: parseFloat(m[0]) });
            i += m[0].length;
            continue;
        }

        // string literal ('...' with '' escape, or "..." with \" escape)
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            let out = '';
            while (j < input.length) {
                if (input[j] === '\\' && ch === '"' && input[j + 1] === '"') { out += '"'; j += 2; continue; }
                if (input[j] === ch) {
                    if (input[j + 1] === ch) { out += ch; j += 2; continue; } // '' escape
                    j++;
                    break;
                }
                out += input[j++];
            }
            tokens.push({ type: 'string', value: out });
            i = j;
            continue;
        }

        // identifier / keyword
        if (/[A-Za-z_]/.test(ch)) {
            const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(input.slice(i));
            tokens.push({ type: 'ident', value: m[0] });
            i += m[0].length;
            continue;
        }

        // `*` (object filter) is only meaningful as a postfix operator
        if (ch === '*') { tokens.push({ type: 'star', value: '*' }); i++; continue; }

        const punct = PUNCT.find((p) => input.startsWith(p, i));
        if (punct) { tokens.push({ type: 'punct', value: punct }); i += punct.length; continue; }

        throw new SyntaxError(`unexpected character '${ch}' in expression`);
    }
    return tokens;
}

// ── Parser / evaluator ───────────────────────────────────────────────────────

class ExpressionError extends Error {}

class Evaluator {
    constructor(tokens, ctx) {
        this.tokens = tokens;
        this.pos = 0;
        this.ctx = ctx;
    }

    peek(offset = 0) { return this.tokens[this.pos + offset]; }
    next() { return this.tokens[this.pos++]; }

    isPunct(value, offset = 0) {
        const t = this.peek(offset);
        return !!t && t.type === 'punct' && t.value === value;
    }

    expectPunct(value) {
        if (!this.isPunct(value)) throw new ExpressionError(`expected '${value}'`);
        return this.next();
    }

    atEnd() { return this.pos >= this.tokens.length; }

    parse() {
        const value = this.parseTernary();
        if (!this.atEnd()) throw new ExpressionError(`unexpected trailing token`);
        return value;
    }

    parseTernary() {
        const condition = this.parseOr();
        if (this.isPunct('?')) {
            this.next();
            const whenTrue = this.parseTernary();
            this.expectPunct(':');
            const whenFalse = this.parseTernary();
            return isTruthy(condition) ? whenTrue : whenFalse;
        }
        return condition;
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.isPunct('||')) {
            this.next();
            const right = this.parseAnd();
            left = isTruthy(left) ? left : right;
        }
        return left;
    }

    parseAnd() {
        let left = this.parseEquality();
        while (this.isPunct('&&')) {
            this.next();
            const right = this.parseEquality();
            left = isTruthy(left) ? right : left;
        }
        return left;
    }

    parseEquality() {
        let left = this.parseRelational();
        while (this.isPunct('==') || this.isPunct('!=')) {
            const op = this.next().value;
            const right = this.parseRelational();
            const equal = looseEquals(left, right);
            left = op === '==' ? equal : !equal;
        }
        return left;
    }

    parseRelational() {
        let left = this.parseUnary();
        while (this.isPunct('<') || this.isPunct('>') || this.isPunct('<=') || this.isPunct('>=')) {
            const op = this.next().value;
            const right = this.parseUnary();
            const [a, b] = [toNumber(left), toNumber(right)];
            switch (op) {
                case '<': left = a < b; break;
                case '>': left = a > b; break;
                case '<=': left = a <= b; break;
                default: left = a >= b; break;
            }
        }
        return left;
    }

    parseUnary() {
        if (this.isPunct('!')) {
            this.next();
            return !isTruthy(this.parseUnary());
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let value = this.parsePrimary();
        for (;;) {
            if (this.isPunct('.')) {
                this.next();
                const name = this.next();
                if (name.type !== 'ident' && name.type !== 'number') {
                    throw new ExpressionError('expected a property name after "."');
                }
                value = readProperty(value, String(name.value));
                continue;
            }
            if (this.isPunct('[')) {
                this.next();
                const indexToken = this.next();
                let index = indexToken.value;
                if (indexToken.type === 'punct' && indexToken.value === '*') index = '*';
                this.expectPunct(']');
                if (index === '*') {
                    value = applyFilter(value);
                    continue;
                }
                value = readIndex(value, indexToken.type === 'number' ? indexToken.value : String(index));
                continue;
            }
            break;
        }
        return value;
    }

    parsePrimary() {
        const token = this.peek();
        if (!token) throw new ExpressionError('unexpected end of expression');

        if (token.type === 'number') { this.next(); return token.value; }
        if (token.type === 'string') { this.next(); return token.value; }

        if (token.type === 'star') { this.next(); return '*'; }

        if (token.type === 'punct' && token.value === '(') {
            this.next();
            const value = this.parseTernary();
            this.expectPunct(')');
            return value;
        }

        if (token.type === 'ident') {
            this.next();
            const name = token.value;

            if (name === 'true') return true;
            if (name === 'false') return false;
            if (name === 'null') return null;

            // function call
            if (this.isPunct('(')) {
                this.next();
                const args = [];
                if (!this.isPunct(')')) {
                    do {
                        if (this.isPunct(')')) break; // tolerate a trailing comma
                        args.push(this.parseTernary());
                    } while (this.isPunct(',') && (this.next(), true));
                }
                this.expectPunct(')');
                return callFunction(name, args, this.ctx);
            }

            if (!isKnownContext(this.ctx, name)) {
                throw new ExpressionError(
                    `Unrecognized named-value: '${name}'. Available contexts: ${knownContexts(this.ctx).join(', ')}`
                );
            }
            return readProperty(this.ctx.contexts, name, /* fromRoot */ true);
        }

        throw new ExpressionError(`unexpected token '${token.value}'`);
    }
}

// ── Coercion rules ───────────────────────────────────────────────────────────

function isPlainObj(v) {
    return v !== null && typeof v === 'object';
}

function isTruthy(value) {
    if (value === false || value === null || value === undefined) return false;
    if (value === 0) return false;
    if (value === '') return false;
    if (typeof value === 'string') return value !== '';
    if (typeof value === 'number') return !Number.isNaN(value) && value !== 0;
    return true;
}

function toNumber(value) {
    if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
}

/** Actions string coercion: case-insensitive, null/undefined → ''. */
function toComparableString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function looseEquals(a, b) {
    if (a === null || a === undefined) a = '';
    if (b === null || b === undefined) b = '';
    if (typeof a === 'object' || typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    if (typeof a === 'number' || typeof b === 'number') {
        if (typeof a === 'boolean' || typeof b === 'boolean') return toNumber(a) === toNumber(b);
        if (typeof a === 'number' && typeof b === 'number') return a === b;
    }
    return toComparableString(a).toLowerCase() === toComparableString(b).toLowerCase();
}

function readProperty(source, name, fromRoot = false) {
    const container = fromRoot ? source : source;
    if (container === null || container === undefined) return null;
    if (typeof container !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(container, name)) return container[name];
    if (Array.isArray(container) && /^\d+$/.test(name)) return container[Number(name)];
    return null;
}

function readIndex(source, index) {
    if (source === null || source === undefined) return null;
    if (Array.isArray(source)) {
        const n = Number(index);
        return Number.isNaN(n) ? null : (source[n] ?? null);
    }
    if (typeof source === 'object') {
        if (Object.prototype.hasOwnProperty.call(source, index)) return source[index];
        return null;
    }
    return null;
}

/** `needs.*.result` style object filters. */
function applyFilter(source) {
    if (!isPlainObj(source)) return source;
    const out = {};
    for (const [k, v] of Object.entries(source)) {
        if (isPlainObj(v)) out[k] = v;
    }
    return out;
}

// ── Contexts ─────────────────────────────────────────────────────────────────

const CONTEXT_NAMES = [
    'github', 'env', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy',
    'matrix', 'needs', 'inputs', 'vars', 'hashFiles'
];

function knownContexts(ctx) {
    return CONTEXT_NAMES.filter((n) => isKnownContext(ctx, n));
}

function isKnownContext(ctx, name) {
    if (ctx && Array.isArray(ctx.allowedContexts) && ctx.allowedContexts.length) {
        return ctx.allowedContexts.includes(name);
    }
    return CONTEXT_NAMES.includes(name) || !!(ctx && ctx.contexts && name in ctx.contexts);
}

// ── Functions ────────────────────────────────────────────────────────────────

function callFunction(name, args, ctx) {
    switch (name) {
        case 'contains': {
            const [haystack, needle] = args;
            if (Array.isArray(haystack)) {
                return haystack.some((item) => looseEquals(item, needle));
            }
            if (isPlainObj(haystack)) {
                return Object.prototype.hasOwnProperty.call(haystack, String(needle));
            }
            return toComparableString(haystack).toLowerCase()
                .includes(toComparableString(needle).toLowerCase());
        }
        case 'startsWith':
            return toComparableString(args[0]).toLowerCase()
                .startsWith(toComparableString(args[1]).toLowerCase());
        case 'endsWith':
            return toComparableString(args[0]).toLowerCase()
                .endsWith(toComparableString(args[1]).toLowerCase());
        case 'format':
            return formatString(toComparableString(args[0]), args.slice(1));
        case 'join': {
            const [arr, sep = ','] = args;
            if (arr === null || arr === undefined) return '';
            const list = Array.isArray(arr) ? arr : [arr];
            return list.map(toComparableString).join(toComparableString(sep));
        }
        case 'toJSON':
            return JSON.stringify(args[0] === undefined ? null : args[0]);
        case 'fromJSON': {
            try { return JSON.parse(toComparableString(args[0])); }
            catch (_) { throw new ExpressionError('fromJSON: invalid JSON input'); }
        }
        case 'hashFiles': {
            if (!ctx || typeof ctx.hashFiles !== 'function') return '';
            return ctx.hashFiles(args.map(toComparableString));
        }
        // Status functions resolve against the *execution* state, not a context object.
        case 'success': return ctx?.status?.success() ?? false;
        case 'failure': return ctx?.status?.failure() ?? false;
        case 'cancelled': return ctx?.status?.cancelled() ?? false;
        case 'always': return true;
        default:
            throw new ExpressionError(`Unrecognized function: '${name}'`);
    }
}

function formatString(template, values) {
    let out = String(template).replace(/\{\{/g, '\u0000');
    out = out.replace(/\{(\d+)\}/g, (match, index) => {
        const i = Number(index);
        return i < values.length ? toComparableString(values[i]) : match;
    });
    return out.replace(/\u0000/g, '{');
}

// ── hashFiles ────────────────────────────────────────────────────────────────

/** Minimal glob matcher supporting *, **, ? and character classes. */
function globToRegExp(pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                i++;
                if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; }
                else re += '.*';
            } else {
                re += '[^/]*';
            }
            continue;
        }
        if (c === '?') { re += '[^/]'; continue; }
        if (c === '[') {
            const end = pattern.indexOf(']', i);
            if (end === -1) { re += '\\['; continue; }
            re += `[${pattern.slice(i + 1, end)}]`;
            i = end;
            continue;
        }
        re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

function walkFiles(root, base, out, depth = 0) {
    if (depth > 24) return;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const full = path.join(root, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkFiles(full, rel, out, depth + 1);
        else if (entry.isFile()) out.push({ rel, full });
    }
}

/**
 * Reproduces the runner's algorithm: sha256 over each matching file, then
 * sha256 over the concatenated per-file hashes in path order.
 */
function createHashFiles(workspace) {
    return function hashFiles(patterns) {
        const files = [];
        walkFiles(workspace, '', files);
        files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

        const matchers = patterns.map(globToRegExp);
        const hashes = [];
        for (const file of files) {
            if (!matchers.some((m) => m.test(file.rel))) continue;
            try {
                const content = fs.readFileSync(file.full);
                hashes.push(crypto.createHash('sha256').update(content).digest('hex'));
            } catch (_) { /* unreadable file behaves as absent */ }
        }
        if (hashes.length === 0) return '';
        return crypto.createHash('sha256').update(hashes.join('')).digest('hex');
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\${{\s*([\s\S]*?)\s*}}/g;

/**
 * Replace every `${{ … }}` occurrence in a string.
 * Throws ExpressionError on malformed input so bad workflows fail loudly.
 */
function evaluateTemplate(template, ctx) {
    if (template === null || template === undefined) return template;
    const str = String(template);
    if (!str.includes('${{')) return str;

    const out = str.replace(TEMPLATE_RE, (_, expr) => stringify(evaluateExpression(expr, ctx)));

    // An opening marker with no closing one is a real authoring mistake, and
    // GitHub fails the step on it. Passing the text through silently would be
    // worse than the mistake: `${{ github.ref` renders as the literal string,
    // which looks exactly like a context that resolved to nothing.
    //
    // Counting markers rather than searching for a stray `}` keeps this from
    // misfiring on a shell `${VAR}` or a `{{ … }}` that never had a `$`.
    const opened = (str.match(/\$\{\{/g) || []).length;
    const closed = (str.match(/\}\}/g) || []).length;
    if (opened > closed) {
        const at = str.indexOf('${{');
        const seen = str.slice(at, at + 40);
        const elided = str.length - at > 40 ? '…' : '';
        throw new ExpressionError(
            `unterminated expression: "\${{" at offset ${at} is never closed with "}}" — got "${seen}${elided}"`
        );
    }
    return out;
}

/**
 * Evaluate a bare expression (used for `if:` and expression-valued YAML fields).
 * If the value is a template containing `${{ }}`, it is unwrapped first, which
 * is exactly how the runner treats `if:`.
 */
function evaluateExpression(input, ctx) {
    const str = String(input ?? '').trim();
    if (str.includes('${{')) {
        // A template in a value position: keep only the first expression's value.
        const m = /\${{\s*([\s\S]*?)\s*}}/.exec(str);
        if (m) return evaluateExpression(m[1], ctx);
    }
    if (str === '') return '';
    const tokens = tokenize(stripFenced(str));
    if (tokens.length === 0) return '';
    return new Evaluator(tokens, ctx).parse();
}

/** Remove stray `}}` / leading `{{` that YAML users sometimes leave behind. */
function stripFenced(str) {
    return str.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
}

/** Render a value the way the runner interpolates it into a string. */
function stringify(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
}

/**
 * Truthiness of an `if:` result. GitHub treats any non-empty, non-"false"
 * string as true because YAML scalars arrive as strings.
 */
function evaluateCondition(value, ctx) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return true;
        if (/^false$/i.test(trimmed)) return false;
        if (/^true$/i.test(trimmed)) return true;
    }
    return isTruthy(evaluateExpression(value, ctx));
}

module.exports = {
    evaluateTemplate,
    evaluateExpression,
    evaluateCondition,
    stringify,
    isTruthy,
    toNumber,
    toComparableString,
    looseEquals,
    createHashFiles,
    globToRegExp,
    CONTEXT_NAMES,
    ExpressionError
};
