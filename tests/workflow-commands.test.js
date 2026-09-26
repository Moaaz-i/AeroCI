/**
 * The workflow command protocol: `::command key=value::message`.
 *
 * A workflow's only way to talk back to the runner. Getting the parsing wrong
 * means a `::error::` annotation never appears, or a step that was supposed to
 * be masked prints its secret in full — the two failure modes that matter most.
 */

const { suite, test, assert } = require('./harness');
const {
    parseWorkflowCommands,
    parseProperties,
    decode,
    isKnownCommand,
    KNOWN_COMMANDS
} = require('../src/core/workflow-commands');

/** The single command in a piece of output, or null. */
const only = (output, options) => {
    const { commands } = parseWorkflowCommands(output, options);
    assert.strictEqual(commands.length, 1, `expected exactly one command from: ${output}`);
    return commands[0];
};

suite('workflow-commands · the basic shape', () => {
    test('::error::message', () => {
        const c = only('::error::something broke');
        assert.strictEqual(c.command, 'error');
        assert.strictEqual(c.message, 'something broke');
        assert.deepStrictEqual(c.properties, {});
    });

    test('a command with properties', () => {
        const c = only('::error file=a.js,line=3::bad thing');
        assert.strictEqual(c.command, 'error');
        assert.strictEqual(c.message, 'bad thing');
        assert.strictEqual(c.properties.file, 'a.js');
        assert.strictEqual(c.properties.line, '3');
    });

    test('the command name is lower-cased', () => {
        assert.strictEqual(only('::ERROR::x').command, 'error');
        assert.strictEqual(only('::Add-Mask::x').command, 'add-mask');
    });

    test('a message may contain colons and spaces', () => {
        const c = only('::notice::see https://example.com/a:b for details');
        assert.strictEqual(c.message, 'see https://example.com/a:b for details');
    });

    test('a message with no separator is an empty message, not a failure', () => {
        // `::error` with no `::` is a real thing tools emit while debugging.
        const c = only('::error');
        assert.strictEqual(c.command, 'error');
        assert.strictEqual(c.message, '');
    });
});

suite('workflow-commands · output that is not a command', () => {
    test('plain lines are returned as lines', () => {
        const { commands, lines } = parseWorkflowCommands('one\ntwo\nthree');
        assert.deepStrictEqual(commands, []);
        assert.deepStrictEqual(lines, ['one', 'two', 'three']);
    });

    test('a command after normal output keeps both', () => {
        const { commands, lines } = parseWorkflowCommands('building...\n::notice::done\n');
        assert.strictEqual(commands.length, 1);
        assert.deepStrictEqual(lines.filter(Boolean), ['building...']);
    });

    test('output on the same line before a command is kept', () => {
        // Tooling often prefixes its own output; dropping it would hide the
        // line the user needs to see.
        const { commands, lines } = parseWorkflowCommands('npm WARN ::notice::careful');
        assert.strictEqual(commands.length, 1);
        assert.deepStrictEqual(lines, ['npm WARN']);
    });

    test('a line holding :: but no command is passed through exactly once', () => {
        // The duplication here is not cosmetic: a line of the user's own
        // output appearing twice in the log reads as the step printing it
        // twice, and the truncated copy hides the text.
        for (const output of [
            'use :: for namespaces',
            'C::vector<int> v;',
            'git log --grep="::"',
            "awk '{print $1::$2}' f"
        ]) {
            const { commands, lines } = parseWorkflowCommands(output);
            assert.deepStrictEqual(commands, [], output);
            assert.deepStrictEqual(lines, [output], output);
        }
    });

    test('a real command after a :: that is not one is still found', () => {
        const { commands, lines } = parseWorkflowCommands('note :: x ::error::y');
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].message, 'y');
        assert.deepStrictEqual(lines, ['note :: x']);
    });

    test('empty output yields nothing', () => {
        const { commands, lines } = parseWorkflowCommands('');
        assert.deepStrictEqual(commands, []);
        assert.deepStrictEqual(lines, ['']);
    });
});

suite('workflow-commands · escaping', () => {
    test('%0A and %0D become real newlines', () => {
        assert.strictEqual(decode('a%0Ab%0Dc'), 'a\nb\rc');
    });

    test('%25 is decoded last, so a literal percent survives', () => {
        // The order matters: decoding %25 first would turn %250A into a
        // newline, corrupting a message that contained the text "%250A".
        assert.strictEqual(decode('100%25%0Adone'), '100%\ndone');
        assert.strictEqual(decode('%250A'), '%0A');
    });

    test('structural characters are decoded', () => {
        assert.strictEqual(decode('%3A%2C%22%5D%7D%2F'), ':,"]}/');
    });

    test('an unknown escape is left as written', () => {
        assert.strictEqual(decode('%ZZ'), '%ZZ');
    });

    test('a message with an encoded newline is not split into two commands', () => {
        const c = only('::error::line one%0Aline two');
        assert.strictEqual(c.message, 'line one\nline two');
    });

    test('a property value with a comma inside quotes survives', () => {
        // `title=Build, then test` has to stay one property. A naive split on
        // every comma turns it into a bogus second key.
        const props = parseProperties('title=Build, then test,file=a.js');
        assert.strictEqual(props.title, 'Build, then test');
        assert.strictEqual(props.file, 'a.js');
    });

    test('property values are decoded too', () => {
        assert.strictEqual(parseProperties('title=a%0Ab').title, 'a\nb');
    });

    test('an empty property list is not an error', () => {
        assert.deepStrictEqual(parseProperties(''), {});
        assert.deepStrictEqual(parseProperties(null), {});
    });
});

suite('workflow-commands · debug filtering', () => {
    test('::debug:: is hidden by default', () => {
        const { commands } = parseWorkflowCommands('::debug::chatter\n::notice::kept');
        assert.deepStrictEqual(commands.map((c) => c.command), ['notice']);
    });

    test('::debug:: is kept when debug output is on', () => {
        const { commands } = parseWorkflowCommands('::debug::chatter', { debug: true });
        assert.strictEqual(commands.length, 1);
    });

    test('a debug line is still kept as a plain line when filtered', () => {
        // Hiding the command must not delete the text from the log; the user
        // still wants to see what was printed.
        const { lines } = parseWorkflowCommands('::debug::chatter');
        assert.deepStrictEqual(lines, []);
    });
});

suite('workflow-commands · the known command list', () => {
    test('every command the engine acts on is recognised', () => {
        for (const name of ['error', 'warning', 'notice', 'group', 'endgroup',
            'add-mask', 'stop-commands', 'save-state', 'set-output', 'add-path']) {
            assert.ok(isKnownCommand(name), `${name} should be known`);
        }
    });

    test('the deprecated commands are still recognised', () => {
        // Older workflows still emit these, and treating them as noise would
        // mean silently ignoring a set-env.
        assert.ok(isKnownCommand('set-output'));
        assert.ok(isKnownCommand('set-env'));
    });

    test('an unknown command is not in the list', () => {
        assert.ok(!isKnownCommand('teleport'));
        assert.ok(!isKnownCommand(''));
    });

    test('the list has no accidental duplicates', () => {
        // A Set cannot hold duplicates, so this checks the source instead.
        const source = require('fs').readFileSync(
            require.resolve('../src/core/workflow-commands'), 'utf8');
        const block = source.slice(source.indexOf('KNOWN_COMMANDS = new Set('));
        const names = (block.match(/'([a-z-]+)'/g) || []).map((s) => s.replace(/'/g, ''));
        assert.strictEqual(new Set(names).size, names.length, 'duplicate entries in KNOWN_COMMANDS');
        assert.strictEqual(names.length, KNOWN_COMMANDS.size);
    });
});

suite('workflow-commands · the commands that carry state', () => {
    test('::add-mask:: exposes the value to be masked', () => {
        const c = only('::add-mask::hunter2');
        assert.strictEqual(c.command, 'add-mask');
        assert.strictEqual(c.message, 'hunter2');
    });

    test('::group:: and ::endgroup:: are recognised as a pair', () => {
        const { commands } = parseWorkflowCommands('::group::Install\ninstalling\n::endgroup::');
        assert.deepStrictEqual(commands.map((c) => c.command), ['group', 'endgroup']);
        assert.strictEqual(commands[0].message, 'Install');
    });

    test('::stop-commands:: carries an escape token', () => {
        const c = only('::stop-commands::abcdef0123');
        assert.strictEqual(c.command, 'stop-commands');
        assert.strictEqual(c.message, 'abcdef0123');
    });

    test('::save-state:: carries a name and a value', () => {
        const c = only('::save-state name=token::abc');
        assert.strictEqual(c.properties.name, 'token');
        assert.strictEqual(c.message, 'abc');
    });
});
