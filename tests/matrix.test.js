/**
 * Matrix expansion.
 *
 * GitHub's algorithm has a specific order of operations — cartesian product,
 * then `include` merged in, then `exclude` — and the `include` step is the part
 * people get wrong. These cases are the ones from the documented examples plus
 * the boundary cases that decide whether the coverage numbers are honest.
 */

const { suite, test, assert } = require('./harness');
const { expandMatrix, MAX_COMBINATIONS } = require('../src/core/matrix');

/** A stable, order-independent view of the expansion, for comparison. */
const shape = (strategy) => expandMatrix(strategy).combinations
    .map((c) => JSON.stringify(c))
    .sort();

suite('matrix · the cartesian product', () => {
    test('one axis produces one combination per value', () => {
        const { combinations, truncated } = expandMatrix({
            matrix: { os: ['ubuntu-latest', 'macos-latest'] }
        });
        assert.strictEqual(combinations.length, 2);
        assert.strictEqual(truncated, false);
    });

    test('two axes multiply, in declaration order', () => {
        const { combinations } = expandMatrix({
            matrix: {
                os: ['ubuntu-latest', 'macos-latest'],
                node: [18, 20]
            }
        });
        assert.strictEqual(combinations.length, 4);
        assert.deepStrictEqual(combinations[0], { os: 'ubuntu-latest', node: 18 });
        assert.deepStrictEqual(combinations[3], { os: 'macos-latest', node: 20 });
    });

    test('three axes multiply again', () => {
        const { combinations } = expandMatrix({
            matrix: { a: [1, 2], b: [3, 4], c: [5, 6] }
        });
        assert.strictEqual(combinations.length, 8);
    });

    test('a scalar axis is treated as a one-value axis', () => {
        const { combinations } = expandMatrix({
            matrix: { os: 'ubuntu-latest', node: [18, 20] }
        });
        assert.strictEqual(combinations.length, 2);
    });

    test('a numeric axis keeps its numbers, not strings', () => {
        const { combinations } = expandMatrix({ matrix: { node: [18, 20] } });
        assert.strictEqual(combinations[0].node, 18);
        assert.strictEqual(typeof combinations[0].node, 'number');
    });

    test('an empty axis value list produces nothing at all', () => {
        // Zero combinations means zero jobs, and the step count has to follow
        // or coverage is reported as more than 100%.
        const { combinations } = expandMatrix({ matrix: { os: [] } });
        assert.strictEqual(combinations.length, 0);
    });

    test('a matrix with no axes produces a single combination', () => {
        const { combinations } = expandMatrix({ matrix: {} });
        assert.strictEqual(combinations.length, 1);
        assert.deepStrictEqual(combinations[0], {});
    });

    test('no strategy at all produces a single combination', () => {
        assert.strictEqual(expandMatrix({}).combinations.length, 1);
        assert.strictEqual(expandMatrix().combinations.length, 1);
    });
});

suite('matrix · include', () => {
    test('an include that adds a new key is merged into every combination', () => {
        // This is the documented example: `experimental` appears on all four.
        const { combinations } = expandMatrix({
            matrix: {
                fruit: ['apple', 'pear'],
                animal: ['cat', 'dog'],
                include: [{ experimental: true }]
            }
        });
        assert.strictEqual(combinations.length, 4);
        for (const combination of combinations) {
            assert.strictEqual(combination.experimental, true);
        }
    });

    test('an include that matches one original value is merged only there', () => {
        // The documented example: colour: green can be added only to the
        // combination it does not contradict, so it lands on apple/cat alone.
        const { combinations } = expandMatrix({
            matrix: {
                fruit: ['apple', 'pear'],
                animal: ['cat', 'dog'],
                include: [{ colour: 'green', fruit: 'apple', animal: 'cat' }]
            }
        });
        assert.strictEqual(combinations.length, 4);
        const withColour = combinations.filter((c) => c.colour === 'green');
        assert.strictEqual(withColour.length, 1);
        assert.deepStrictEqual(withColour[0], { fruit: 'apple', animal: 'cat', colour: 'green' });
    });

    test('an include adding a brand-new key goes on every combination', () => {
        // `colour` is not an original matrix key, so it cannot conflict with
        // anything and is added everywhere. The result is still 2 jobs, not 3.
        const { combinations } = expandMatrix({
            matrix: {
                fruit: ['apple', 'pear'],
                include: [{ colour: 'purple' }]
            }
        });
        assert.strictEqual(combinations.length, 2);
        for (const combination of combinations) {
            assert.strictEqual(combination.colour, 'purple');
        }
    });

    test('an include that contradicts every original value becomes a new combination', () => {
        // `banana` is neither apple nor pear, so it conflicts with both and
        // cannot be merged anywhere. It becomes a third job.
        const { combinations } = expandMatrix({
            matrix: {
                fruit: ['apple', 'pear'],
                include: [{ fruit: 'banana' }]
            }
        });
        assert.strictEqual(combinations.length, 3);
        assert.ok(combinations.some((c) => c.fruit === 'banana' && c.colour === undefined));
        assert.ok(combinations.some((c) => c.fruit === 'apple' && c.colour === undefined));
    });

    test('a later include overwrites an earlier one on the same new key', () => {
        const { combinations } = expandMatrix({
            matrix: {
                os: ['a', 'b'],
                include: [{ extra: 'first' }, { extra: 'second' }]
            }
        });
        // Both entries are free to merge everywhere, so the second wins.
        for (const combination of combinations) {
            assert.strictEqual(combination.extra, 'second');
        }
    });

    test('an original key is never overwritten by include', () => {
        const { combinations } = expandMatrix({
            matrix: {
                os: ['a', 'b'],
                include: [{ os: 'a' }]
            }
        });
        // `os: a` fits the first combination only, and must not change the
        // second one's os.
        assert.deepStrictEqual(combinations.map((c) => c.os), ['a', 'b']);
    });

    test('a matrix made only of include gives one combination per entry', () => {
        const { combinations } = expandMatrix({
            matrix: { include: [{ a: 1 }, { a: 2, b: 3 }] }
        });
        assert.strictEqual(combinations.length, 2);
        assert.deepStrictEqual(shape({ matrix: { include: [{ a: 1 }, { a: 2, b: 3 }] } }).length, 2);
    });

    test('an empty include list changes nothing', () => {
        const withIt = expandMatrix({ matrix: { os: ['a', 'b'], include: [] } });
        const without = expandMatrix({ matrix: { os: ['a', 'b'] } });
        assert.deepStrictEqual(withIt.combinations, without.combinations);
    });
});

suite('matrix · exclude', () => {
    test('a full match removes the combination', () => {
        const { combinations } = expandMatrix({
            matrix: { os: ['a', 'b', 'c'], exclude: [{ os: 'b' }] }
        });
        assert.strictEqual(combinations.length, 2);
        assert.ok(!combinations.some((c) => c.os === 'b'));
    });

    test('an exclude matches only the keys it names, and drops every variant', () => {
        // Excluding `{os: a}` drops both node variants of os=a. This is the
        // documented rule: an exclusion only has to match partially to apply,
        // and the keys it does not mention are ignored.
        const { combinations } = expandMatrix({
            matrix: { os: ['a', 'b'], node: [18, 20], exclude: [{ os: 'a' }] }
        });
        assert.deepStrictEqual(combinations, [{ os: 'b', node: 18 }, { os: 'b', node: 20 }]);
    });

    test('an exclude naming more keys removes nothing when one of them differs', () => {
        const { combinations } = expandMatrix({
            matrix: { os: ['a', 'b'], node: [18, 20], exclude: [{ os: 'a', node: 99 }] }
        });
        assert.strictEqual(combinations.length, 4);
    });

    test('exclude runs after include, so it can remove an included combination', () => {
        const { combinations } = expandMatrix({
            matrix: {
                fruit: ['apple', 'pear'],
                include: [{ fruit: 'apple', colour: 'red' }],
                exclude: [{ fruit: 'apple', colour: 'red' }]
            }
        });
        assert.ok(!combinations.some((c) => c.colour === 'red'));
    });

    test('an empty exclude object removes nothing', () => {
        // `exclude: [{}]` is a real authoring mistake and must not delete
        // every job in the matrix.
        const { combinations } = expandMatrix({
            matrix: { os: ['a', 'b'], exclude: [{}] }
        });
        assert.strictEqual(combinations.length, 2);
    });

    test('excluding by a numeric value works', () => {
        const { combinations } = expandMatrix({
            matrix: { node: [18, 20, 22], exclude: [{ node: 20 }] }
        });
        assert.deepStrictEqual(combinations.map((c) => c.node), [18, 22]);
    });

    test('excluding by a string version of a number also matches', () => {
        // YAML authors write both, and the language compares them loosely.
        const { combinations } = expandMatrix({
            matrix: { node: [18, 20], exclude: [{ node: '20' }] }
        });
        assert.strictEqual(combinations.length, 1);
    });

    test('excluding more than exists empties the matrix rather than going negative', () => {
        const { combinations } = expandMatrix({
            matrix: { os: ['a'], exclude: [{ os: 'a' }, { os: 'b' }] }
        });
        assert.strictEqual(combinations.length, 0);
    });
});

suite('matrix · truncation is reported, never hidden', () => {
    test('a matrix at the cap is flagged as truncated', () => {
        const values = [];
        for (let i = 0; i < MAX_COMBINATIONS + 10; i++) values.push(i);
        const { combinations, truncated } = expandMatrix({ matrix: { i: values } });
        assert.strictEqual(truncated, true);
        assert.strictEqual(combinations.length, MAX_COMBINATIONS);
    });

    test('a matrix just under the cap is not flagged', () => {
        const values = [];
        for (let i = 0; i < 8; i++) values.push(i);   // 2^3 = 8
        const { truncated } = expandMatrix({ matrix: { a: values.slice(0, 2), b: values.slice(2, 4), c: values.slice(4, 6) } });
        assert.strictEqual(truncated, false);
    });
});

suite('matrix · scheduling keys', () => {
    test('fail-fast defaults to true and is only false when written', () => {
        assert.strictEqual(expandMatrix({}).failFast, true);
        assert.strictEqual(expandMatrix({ 'fail-fast': true }).failFast, true);
        assert.strictEqual(expandMatrix({ 'fail-fast': false }).failFast, false);
    });

    test('max-parallel is a number when given and unlimited otherwise', () => {
        assert.strictEqual(expandMatrix({}).maxParallel, Infinity);
        assert.strictEqual(expandMatrix({ 'max-parallel': 2 }).maxParallel, 2);
        assert.strictEqual(expandMatrix({ 'max-parallel': '3' }).maxParallel, 3);
    });

    test('a nonsense max-parallel falls back to unlimited instead of blocking everything', () => {
        assert.strictEqual(expandMatrix({ 'max-parallel': 0 }).maxParallel, Infinity);
        assert.strictEqual(expandMatrix({ 'max-parallel': -1 }).maxParallel, Infinity);
        assert.strictEqual(expandMatrix({ 'max-parallel': 'many' }).maxParallel, Infinity);
    });
});
