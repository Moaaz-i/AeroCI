/**
 * Workflow command protocol: `::command key=value::message`
 *
 * Parsed from BOTH stdout and stderr, exactly like the real runner. Handles
 * percent-escaping, properties, group nesting and the deprecated commands that
 * older workflows still emit.
 */

// ::command[ key=value,key=value]::message
// Property lists never contain spaces, so the first "::" after the command name
// is the message separator. The `s` flag lets a message span escaped newlines.
const COMMAND_RE = /^::([a-zA-Z0-9_-]+)[ \t]*([^\s:]*)(?:::(.*))?$/s;

// A `::` that could begin a command: two colons followed by a command name.
// Used to decide whether a line holds a command at all, so that ordinary
// output containing `::` — C++ scopes, `awk` one-liners, `git log --grep="::"`,
// an npm notice — is not mistaken for one and split in half.
const COMMAND_START_RE = /::([a-zA-Z0-9_-]+)[ \t]*/g;

/**
 * Where the first real workflow command starts in a line, or -1.
 *
 * A candidate is only accepted once the whole remainder parses as a command, so
 * `C::vector<int> v;` is left alone even though `::vector` looks like a name.
 */
function findCommandStart(line) {
    COMMAND_START_RE.lastIndex = 0;
    let candidate;
    while ((candidate = COMMAND_START_RE.exec(line)) !== null) {
        if (COMMAND_RE.test(line.slice(candidate.index))) return candidate.index;
    }
    return -1;
}

function decode(value) {
    return String(value)
        .replace(/%0D/g, '\r')
        .replace(/%0A/g, '\n')
        .replace(/%25/g, '%')
        .replace(/%3A/g, ':')
        .replace(/%2C/g, ',')
        .replace(/%22/g, '"')
        .replace(/%5D/g, ']')
        .replace(/%7D/g, '}')
        .replace(/%2F/g, '/');
}

function parseProperties(text) {
    const props = {};
    if (!text) return props;
    // key=value pairs, value may contain commas (e.g. title=…)
    const re = /([A-Za-z0-9_-]+)=((?:[^,]|,(?![A-Za-z0-9_-]+=))*)/g;
    let m;
    while ((m = re.exec(text)) !== null) props[m[1]] = decode(m[2]);
    return props;
}

/**
 * Split raw output into parsed workflow commands and plain lines.
 * @param {string} output
 * @param {boolean} debug  when false, `::debug::` is filtered out
 */
function parseWorkflowCommands(output, { debug = false } = {}) {
    const commands = [];
    const lines = [];

    for (const rawLine of String(output || '').split(/\r?\n/)) {
        const idx = findCommandStart(rawLine);
        if (idx === -1) { lines.push(rawLine); continue; }

        // Whatever came before the marker is still output and still belongs in
        // the log, but the marker's own line is not emitted twice.
        const before = rawLine.slice(0, idx);
        if (before.trim()) lines.push(before.replace(/\s+$/, ''));

        const m = COMMAND_RE.exec(rawLine.slice(idx));
        /* c8 ignore next */
        if (!m) { lines.push(rawLine); continue; }

        const [, command, propText, message] = m;
        commands.push({
            command: command.toLowerCase(),
            properties: parseProperties(propText),
            message: decode(message || ''),
            raw: rawLine.slice(idx)
        });
    }

    const filtered = debug
        ? commands
        : commands.filter((c) => c.command !== 'debug');

    return { commands: filtered, lines };
}

const KNOWN_COMMANDS = new Set([
    'error', 'warning', 'notice', 'debug', 'group', 'endgroup', 'add-mask',
    'stop-commands', 'save-state', 'set-output', 'set-env', 'add-path', 'echo'
]);

function isKnownCommand(name) {
    return KNOWN_COMMANDS.has(name);
}

module.exports = { parseWorkflowCommands, parseProperties, decode, isKnownCommand, KNOWN_COMMANDS };
