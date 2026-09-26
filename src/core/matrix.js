/**
 * Matrix strategy expansion, implementing the algorithm GitHub documents:
 *
 *  1. All combinations of the matrix values are generated ("original" values).
 *  2. `include` entries are applied: an entry's pairs are merged into every
 *     combination it does not conflict with (i.e. no original value may be
 *     overwritten). An entry that fits nowhere becomes a new combination.
 *  3. `exclude` entries remove any combination they fully match.
 *  4. `max-parallel` / `fail-fast` shape the execution order.
 */

const MAX_COMBINATIONS = 256;

function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function cartesian(keys, source, limit) {
    const results = [];
    const build = (index, current) => {
        if (results.length >= limit) return;
        if (index === keys.length) { results.push({ ...current }); return; }
        const key = keys[index];
        for (const value of asArray(source[key])) {
            build(index + 1, { ...current, [key]: value });
        }
    };
    build(0, {});
    return results;
}

/** Would applying `entry` overwrite a value produced by the matrix itself? */
function conflictsWithOriginal(entry, combination, originalKeys) {
    for (const [key, value] of Object.entries(entry)) {
        if (!originalKeys.has(key)) continue;          // new key → never a conflict
        if (!valuesEqual(combination[key], value)) return true;
    }
    return false;
}

function valuesEqual(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined) return b === null || b === undefined;
    if (typeof a === 'object' || typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return String(a) === String(b);
}

/**
 * @returns {{combinations: object[], truncated: boolean, maxParallel: number, failFast: boolean}}
 */
function expandMatrix(strategy = {}) {
    const matrix = strategy.matrix || {};
    const failFast = strategy['fail-fast'] !== false;
    const maxParallel = Number(strategy['max-parallel']) > 0 ? Number(strategy['max-parallel']) : Infinity;

    const include = asArray(matrix.include);
    const exclude = asArray(matrix.exclude);
    const original = {};
    for (const [k, v] of Object.entries(matrix)) {
        if (k === 'include' || k === 'exclude') continue;
        original[k] = v;
    }
    const originalKeys = new Set(Object.keys(original));

    let combinations;
    let truncated = false;

    if (originalKeys.size === 0) {
        // A matrix made only of `include` → each entry is its own job.
        combinations = include.map((entry) => ({ ...entry }));
        if (combinations.length === 0) combinations = [{}];
    } else {
        combinations = cartesian([...originalKeys], original, MAX_COMBINATIONS);
        truncated = combinations.length >= MAX_COMBINATIONS;

        for (const entry of include) {
            let merged = false;
            for (const combination of combinations) {
                if (conflictsWithOriginal(entry, combination, originalKeys)) continue;
                Object.assign(combination, entry);
                merged = true;
            }
            if (!merged) {
                combinations.push({ ...entry });
                if (combinations.length > MAX_COMBINATIONS) { truncated = true; break; }
            }
        }
    }

    if (exclude.length) {
        combinations = combinations.filter((combination) =>
            !exclude.some((ex) =>
                Object.keys(ex).length > 0 &&
                Object.entries(ex).every(([k, v]) => valuesEqual(combination[k], v)))
        );
    }

    return { combinations, truncated, maxParallel, failFast };
}

module.exports = { expandMatrix, MAX_COMBINATIONS };
