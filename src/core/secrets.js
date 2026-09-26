/**
 * Secret / variable loading for the local twin.
 *
 * Supports a real dotenv dialect: `KEY=value`, `export KEY=value`, single or
 * double quoted values, `#` comments, escaped newlines and blank lines.
 * Quoted values may span multiple lines.
 */

const fs = require('fs');

// A reference ends at the first `}}` or at a `.` / `]`, so a malformed path
// like `secrets.TOKEN.value` still names the secret it is trying to read. The
// checker reports the shape separately; this only has to name the secret.
const SECRET_REFERENCE = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const VAR_REFERENCE = /\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expand escapes in a double-quoted value.
 *
 * Single-quoted values are deliberately NOT passed through this: the dotenv
 * convention is that single quotes are literal, and a private key pasted in as
 * `KEY='-----BEGIN...\\n-----END...'` has to keep its backslashes.
 */
function unescape(value) {
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\(['"\\])/g, '$1');
}

/** Index of the closing quote in a quoted value, honouring backslash escapes. */
function findClosingQuote(s, quote) {
    for (let i = 1; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === quote) return i;
    }
    return -1;
}

/**
 * @returns {{values: Record<string,string>, warnings: string[]}}
 */
function parseEnv(content) {
    const values = {};
    const warnings = [];
    const lines = String(content).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const withoutExport = line.replace(/^export\s+/, '');
        const eq = withoutExport.indexOf('=');
        if (eq === -1) {
            warnings.push(`line ${i + 1}: missing '=' → ignored (${line.slice(0, 40)})`);
            continue;
        }

        const key = withoutExport.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            warnings.push(`line ${i + 1}: invalid key "${key}" → ignored`);
            continue;
        }

        let rest = withoutExport.slice(eq + 1);

        const quote = rest[0];
        if (quote === '"' || quote === "'") {
            // Only a double-quoted value has its escapes expanded.
            const read = (raw) => (quote === '"' ? unescape(raw) : raw);
            const closing = findClosingQuote(rest, quote);
            if (closing !== -1) {
                values[key] = read(rest.slice(1, closing));
                const trailer = rest.slice(closing + 1).trim();
                if (trailer && !trailer.startsWith('#')) {
                    warnings.push(`line ${i + 1}: unexpected text after quoted value → ignored`);
                }
                continue;
            }

            // Unterminated on this line → multi-line quoted value.
            let acc = rest.slice(1);
            let closed = false;
            while (i + 1 < lines.length) {
                i++;
                acc += '\n' + lines[i];
                const found = findClosingQuote(acc, quote);
                if (found !== -1) { acc = acc.slice(0, found); closed = true; break; }
            }
            values[key] = read(acc);
            if (!closed) warnings.push(`line ${i + 1}: unterminated ${quote} quote for "${key}"`);
            continue;
        }

        // Unquoted: strip inline comment (a '#' preceded by whitespace).
        const commentAt = rest.search(/\s#/);
        if (commentAt !== -1) rest = rest.slice(0, commentAt);
        values[key] = rest.trim();
    }

    return { values, warnings };
}

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return { values: {}, warnings: [], exists: false };
    try {
        const { values, warnings } = parseEnv(fs.readFileSync(filePath, 'utf8'));
        return { values, warnings, exists: true };
    } catch (err) {
        return { values: {}, warnings: [`unable to read ${filePath}: ${err.message}`], exists: false };
    }
}

function collectSecretReferences(text) {
    const names = new Set();
    let m;
    SECRET_REFERENCE.lastIndex = 0;
    while ((m = SECRET_REFERENCE.exec(String(text || ''))) !== null) names.add(m[1]);
    return [...names];
}

function collectVarReferences(text) {
    const names = new Set();
    let m;
    VAR_REFERENCE.lastIndex = 0;
    while ((m = VAR_REFERENCE.exec(String(text || ''))) !== null) names.add(m[1]);
    return [...names];
}

module.exports = { parseEnv, loadEnvFile, collectSecretReferences, collectVarReferences };
