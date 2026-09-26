/**
 * Job dependency graph: `needs:` ordering, cycle detection and the
 * success()/failure()/always() cascade that decides whether a job may run.
 */

/** Topological order with deterministic tie-breaking (declaration order). */
function orderJobs(jobs) {
    const ids = Object.keys(jobs);
    const deps = new Map();
    for (const id of ids) {
        const needs = normalizeNeeds(jobs[id].needs);
        deps.set(id, needs.filter((n) => ids.includes(n)));
    }

    const order = [];
    const state = new Map(); // id → 'visiting' | 'done'
    const cycles = [];

    const visit = (id, stack) => {
        const s = state.get(id);
        if (s === 'done') return;
        if (s === 'visiting') {
            const start = stack.indexOf(id);
            cycles.push([...stack.slice(start), id]);
            return;
        }
        state.set(id, 'visiting');
        for (const dep of deps.get(id) || []) visit(dep, [...stack, id]);
        state.set(id, 'done');
        order.push(id);
    };

    for (const id of ids) visit(id, []);

    return { order, cycles, deps };
}

function normalizeNeeds(needs) {
    if (!needs) return [];
    return Array.isArray(needs) ? needs.filter(Boolean) : [needs];
}

/** Every job a job depends on, transitively. */
function transitiveNeeds(id, deps, seen = new Set()) {
    for (const dep of deps.get(id) || []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        transitiveNeeds(dep, deps, seen);
    }
    return seen;
}

function detectCycles(jobs) {
    return orderJobs(jobs).cycles;
}

module.exports = { orderJobs, normalizeNeeds, transitiveNeeds, detectCycles };
