/**
 * Job graph: ordering, cycles and the dependency closure.
 *
 * The ordering decides what runs and in which order, and the closure decides
 * whether a job is allowed to run at all. Both have to be right or a workflow
 * "passes" locally and fails on the runner.
 */

const { suite, test, assert } = require('./harness');
const { orderJobs, normalizeNeeds, transitiveNeeds, detectCycles } = require('../src/core/graph');

suite('graph · normalizeNeeds', () => {
    test('a single string becomes a one-element list', () => {
        assert.deepStrictEqual(normalizeNeeds('build'), ['build']);
    });

    test('a list is passed through', () => {
        assert.deepStrictEqual(normalizeNeeds(['a', 'b']), ['a', 'b']);
    });

    test('nothing at all becomes an empty list', () => {
        assert.deepStrictEqual(normalizeNeeds(undefined), []);
        assert.deepStrictEqual(normalizeNeeds(null), []);
        assert.deepStrictEqual(normalizeNeeds(''), []);
    });

    test('a null entry inside a list is dropped', () => {
        // `needs: [build, ]` is valid YAML that produces a null hole, and
        // treating it as a job named "" would break the whole order.
        assert.deepStrictEqual(normalizeNeeds(['a', null, 'b']), ['a', 'b']);
    });
});

suite('graph · ordering', () => {
    test('independent jobs keep their declaration order', () => {
        const { order, cycles } = orderJobs({ a: {}, b: {}, c: {} });
        assert.deepStrictEqual(order, ['a', 'b', 'c']);
        assert.deepStrictEqual(cycles, []);
    });

    test('a dependency always comes before its dependent', () => {
        const { order } = orderJobs({ test: { needs: 'build' }, build: {} });
        assert.ok(order.indexOf('build') < order.indexOf('test'));
    });

    test('a chain resolves in dependency order', () => {
        const { order } = orderJobs({ c: { needs: 'b' }, b: { needs: 'a' }, a: {} });
        assert.deepStrictEqual(order, ['a', 'b', 'c']);
    });

    test('a diamond runs the shared dependency once, first', () => {
        const { order, cycles, deps } = orderJobs({
            left: { needs: 'base' },
            right: { needs: 'base' },
            base: {},
            join: { needs: ['left', 'right'] }
        });
        assert.deepStrictEqual(cycles, []);
        assert.strictEqual(order.filter((id) => id === 'base').length, 1);
        assert.strictEqual(order[0], 'base');
        assert.strictEqual(order[order.length - 1], 'join');
        assert.deepStrictEqual(deps.get('join').sort(), ['left', 'right']);
    });

    test('a need on a job that does not exist is ignored, not fatal', () => {
        // The checker reports this; ordering must still produce a usable order
        // so the run can show the author what happens.
        const { order, cycles } = orderJobs({ a: { needs: 'ghost' } });
        assert.deepStrictEqual(order, ['a']);
        assert.deepStrictEqual(cycles, []);
    });

    test('an empty graph orders to nothing', () => {
        assert.deepStrictEqual(orderJobs({}), { order: [], cycles: [], deps: new Map() });
    });

    test('ties are broken by declaration order, not hash order', () => {
        // Without this, two runs of the same file could execute siblings in a
        // different order and the reports would stop being comparable.
        const jobs = { zeta: {}, alpha: {}, mid: {} };
        const first = orderJobs(jobs).order;
        const second = orderJobs({ zeta: {}, alpha: {}, mid: {} }).order;
        assert.deepStrictEqual(first, ['zeta', 'alpha', 'mid']);
        assert.deepStrictEqual(first, second);
    });
});

suite('graph · cycles', () => {
    test('a two-job cycle is reported, once, with both ends named', () => {
        const cycles = detectCycles({ a: { needs: 'b' }, b: { needs: 'a' } });
        assert.strictEqual(cycles.length, 1);
        assert.ok(cycles[0].includes('a'));
        assert.ok(cycles[0].includes('b'));
    });

    test('a three-job cycle names the whole loop', () => {
        const cycles = detectCycles({
            a: { needs: 'c' },
            b: { needs: 'a' },
            c: { needs: 'b' }
        });
        assert.strictEqual(cycles.length, 1);
        assert.strictEqual(cycles[0].length, 4);      // a → b → c → a
        assert.strictEqual(cycles[0][0], cycles[0][3]);
    });

    test('a cycle does not hang the traversal', () => {
        // The whole point of marking nodes as in-progress. A recursive walk
        // without it recurses forever on a cycle, which is a workflow typo a
        // user will hit on their first bad `needs:`.
        const { order } = orderJobs({ a: { needs: 'b' }, b: { needs: 'a' } });
        assert.strictEqual(order.length, 2);
    });

    test('a diamond is not mistaken for a cycle', () => {
        assert.deepStrictEqual(
            detectCycles({ base: {}, l: { needs: 'base' }, r: { needs: 'base' }, j: { needs: ['l', 'r'] } }),
            []);
    });

    test('a self-dependency is a cycle of one', () => {
        const cycles = detectCycles({ a: { needs: 'a' } });
        assert.strictEqual(cycles.length, 1);
        assert.deepStrictEqual(cycles[0], ['a', 'a']);
    });

    test('an acyclic graph reports no cycles', () => {
        assert.deepStrictEqual(detectCycles({ a: {}, b: { needs: 'a' }, c: { needs: 'b' } }), []);
    });
});

suite('graph · transitive closure', () => {
    const jobs = {
        a: {},
        b: { needs: 'a' },
        c: { needs: 'b' },
        d: { needs: 'c' },
        unrelated: {}
    };
    const { deps } = orderJobs(jobs);

    test('a direct need is in the closure', () => {
        assert.ok(transitiveNeeds('b', deps).has('a'));
    });

    test('an indirect need is in the closure', () => {
        const closure = transitiveNeeds('d', deps);
        assert.ok(closure.has('a'));
        assert.ok(closure.has('b'));
        assert.ok(closure.has('c'));
    });

    test('the closure does not include unrelated jobs', () => {
        assert.ok(!transitiveNeeds('d', deps).has('unrelated'));
    });

    test('the closure does not include the job itself', () => {
        // success() walks the closure and compares against the running job's
        // own result; including it would make every job depend on itself.
        assert.ok(!transitiveNeeds('d', deps).has('d'));
    });

    test('a job with no needs has an empty closure', () => {
        assert.strictEqual(transitiveNeeds('a', deps).size, 0);
    });

    test('the closure of a cyclic graph terminates', () => {
        const cyclic = orderJobs({ a: { needs: 'b' }, b: { needs: 'a' } }).deps;
        const closure = transitiveNeeds('a', cyclic);
        assert.ok(closure.has('b'));
        assert.ok(closure.has('a') === false || closure.size <= 2);
    });
});
