# Contributing

## Setup

```bash
git clone https://github.com/Moaaz-i/AeroCI.git
cd AeroCI
npm install
npm link          # makes `aeroci` available on your PATH
aeroci --version
```

Node 18 or newer. There are three runtime dependencies — `commander`,
`js-yaml` and `velociradix` — and no build step.

## The gate

Two commands, both of which must pass before you open a pull request:

```bash
npm test        # every suite, each in its own process
npm run lint    # the quality gate
```

`npm test` discovers every `tests/*.test.js` and runs it in a separate process,
so a suite that leaks a global or a file handle cannot affect another. Pass
`--only <name>` to run one, `--verbose` for full names.

`npm run lint` (`scripts/lint.js`) checks what a reviewer would otherwise have
to:

- **duplicate keys** in object literals and YAML — a silent last-wins bug
- **unused requires and unreachable code**
- **ReDoS** — every regex is timed against a hostile input, in a worker so a
  hang cannot wedge the gate
- **static/instance mismatches** — a method called on its class that is not
  `static` is a `TypeError` waiting for the one code path that reaches it

That last check exists because `aeroci profile` shipped with exactly that bug
on its main path: `printObservations` was an instance method called as a static,
so the command threw as soon as a workflow had anything worth observing. It is
now mechanical rather than a thing to remember.

Run the gate clean. If it is flaky, that is a bug in the gate — fix it rather
than re-running until it passes.

## Layout

```
AeroCI/
├── bin/aeroci.js          entry point
├── scripts/
│   ├── lint.js            the quality gate
│   ├── static-audit.js    the static/instance check the gate calls
│   └── regex-scan-worker.js   ReDoS timing, in a worker process
├── src/
│   ├── cli.js             command definitions
│   ├── server.js          the read-only dashboard
│   ├── core/
│   │   ├── engine.js      the executor: sandbox, steps, actions, context
│   │   ├── sandbox.js     the isolated copy
│   │   ├── action-simulators.js  local implementations of `uses:` steps
│   │   ├── local-action.js       reading a local ./action from disk
│   │   ├── action-files.js       GITHUB_ENV / OUTPUT / PATH / STATE / SUMMARY
│   │   ├── expressions.js  ${{ }} evaluation
│   │   ├── matrix.js       strategy.matrix expansion
│   │   ├── graph.js        needs ordering, cycle detection
│   │   ├── event.js        git state and the github context
│   │   ├── secrets.js      .env parsing
│   │   ├── security.js     the audit rules
│   │   ├── checker.js      the pre-flight validation
│   │   ├── analyzer.js     structural intelligence
│   │   ├── profiler.js     timings, cost projection, history
│   │   ├── reporter.js     json / markdown / html / junit
│   │   ├── artifacts.js    upload-artifact storage
│   │   ├── workflow-commands.js  ::error / ::warning / ::add-mask
│   │   ├── shell.js        shell resolution
│   │   ├── runner.js       the `run` command's orchestration
│   │   ├── debugger.js     the debug shell
│   │   ├── initializer.js  `aeroci init`
│   │   ├── config.js       .aeroci.json
│   │   └── versions.js     action pinning and the remote check
│   └── utils/
│       ├── exec.js         process spawning and timeouts
│       └── logger.js       output, colours, tables
├── tests/                 one file per subsystem
├── docs/                  this site
└── package.json
```

## Writing tests

Tests use the harness in `tests/harness.js`:

```js
const { suite, test, asyncTest, assert } = require('./harness');

suite('the thing', () => {
    test('a synchronous fact', () => {
        assert.strictEqual(actual, expected);
    });

    asyncTest('something that spawns a process', async () => {
        // ...
    });
});
```

Two traps worth knowing before you lose an afternoon to them:

- **`test()` is synchronous.** Passing it an `async` function throws. Use
  `asyncTest()`.
- **Use `deepStrictEqual` for anything that has been through JSON.** A round
  trip through a report or a process boundary gives you a plain object, and
  `strictEqual` on two objects is reference equality — it will fail on content
  that is identical, which reads like a bug in your code and is not.

Prefer a test that fails for the right reason. A test asserting a return value
passes just as happily when the thing is not isolated; a test that writes a
file inside the sandbox and then looks for it *outside* only passes when the
isolation is real.

If you fix a bug, add the test that would have caught it. If a number appears
in the output, assert on it — and make sure it is a number you measured.

## Style

- English in code, comments and documentation.
- Four-space indent, semicolons, single quotes.
- Comments explain **why**, and say what the alternative was. A comment
  explaining what the next line does is noise.
- No new runtime dependencies without a reason in the pull request.
- No number in a message, a comment or a doc that you have not measured.

## Before you open a pull request

```bash
npm run lint && npm test
git status          # nothing generated should be staged
```

`.aeroci-artifacts/` is generated. It should never be committed.
