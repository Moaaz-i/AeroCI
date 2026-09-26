#!/usr/bin/env node
/**
 * Cross-module static/instance method mismatches.
 *
 * A `static` method called on the class and an instance method are the same
 * name in the source and a `TypeError` at runtime. `aeroci profile` shipped
 * with one of these on its main path, so they are worth finding mechanically
 * rather than by running every command by hand.
 *
 *   node scripts/static-audit.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Every .js file under src/. */
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
    });
}

const files = walk(SRC);

/** class name -> { statics:Set, instance:Set } */
const table = new Map();

for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^class\s+(\w+)/gm)) {
        const name = m[1];
        if (!table.has(name)) table.set(name, { statics: new Set(), instance: new Set(), file });
        const entry = table.get(name);
        // `static async run(` has to match too, or every async static method
        // looks like it does not exist and the report fills with noise.
        for (const s of src.matchAll(/^    static\s+(?:async\s+)?(\w+)\s*\(/gm)) entry.statics.add(s[1]);
        for (const s of src.matchAll(/^    (?:async\s+)?(\w+)\s*\(/gm)) entry.instance.add(s[1]);
        // `Class.method = function …` after the class body is still a static.
        for (const s of src.matchAll(new RegExp(`^${name}\\.(\\w+)\\s*=`, 'gm'))) entry.statics.add(s[1]);
    }
}

/**
 * Blank out comments while keeping every newline, so a line reported as
 * broken is the line a reader will find broken. Deleting the comment text
 * outright shifted every report down by the length of the doc comment above
 * it, which is worse than useless.
 */
function blankComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/gm, (line, lead) => lead + ' '.repeat(line.length - lead.length));
}

const problems = [];

// Call sites of the form `ClassName.method(` across every file.
for (const file of files) {
    // Comments describe the API in prose and use the same `Class.method()`
    // shape, so a doc comment must not read as a broken call site.
    const lines = blankComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
        for (const m of line.matchAll(/\b([A-Z]\w+)\.(\w+)\s*\(/g)) {
            const [, cls, method] = m;
            const entry = table.get(cls);
            if (!entry) continue;
            // The constructor is called with `new`, never as Class.method().
            if (method === 'constructor') continue;
            if (entry.statics.has(method)) continue;
            const isInstance = entry.instance.has(method);
            problems.push({
                file: path.relative(ROOT, file),
                line: i + 1,
                text: line.trim().slice(0, 90),
                verdict: isInstance ? 'INSTANCE' : 'MISSING',
                cls
            });
        }
    });
}

const real = problems.filter((p) => p.verdict === 'INSTANCE');
const missing = problems.filter((p) => p.verdict === 'MISSING');

// The other direction: `this.foo()` from an *instance* method where `foo` is
// static. `this` is the instance, so the lookup misses — the same crash, the
// other way round, and the one the `Class.method(` scan above cannot see
// because there is no class name at the call site. It is what broke
// `aeroci run --profile`: `printObservations` was static, `printAll` reached it
// through `this`, and the command threw after printing every table.
//
// Inside a `static` method `this` is the class, so `this.foo()` is correct
// there. The enclosing method's kind is tracked per line to tell the two apart.
for (const [name, entry] of table) {
    if (entry.statics.size === 0) continue;
    const file = entry.file;
    const lines = blankComments(fs.readFileSync(file, 'utf8')).split('\n');
    let inStatic = false;
    lines.forEach((line, i) => {
        // A method header at this indent starts a new body. Getters and
        // one-liners do not open one, and neither do assignments.
        const header = /^    (static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/.exec(line);
        if (header) inStatic = !!header[1];
        // `this` inside a static method is the class, where a static resolves.
        if (inStatic) return;
        for (const m of line.matchAll(/\bthis\.(\w+)\s*\(/g)) {
            const method = m[1];
            if (!entry.statics.has(method)) continue;
            // A name that is both static and instance resolves to the instance
            // one through `this`. Not a bug.
            if (entry.instance.has(method)) continue;
            real.push({
                file: path.relative(ROOT, file),
                line: i + 1,
                text: line.trim().slice(0, 90),
                verdict: 'INSTANCE',
                cls: name
            });
        }
    });
}

for (const p of real) {
    console.log(`INSTANCE  ${p.file}:${p.line}  ${p.cls}.<method> is not static`);
    console.log(`          ${p.text}`);
}

// A `MISSING` is usually a subclass method or a plain object of helpers, so
// they are only reported as a count to keep the signal readable.
console.log(`\n${real.length} static/instance mismatch(es); `
    + `${missing.length} call(s) to a method not declared on the class (helpers/subclasses).`);

process.exitCode = real.length === 0 ? 0 : 1;
