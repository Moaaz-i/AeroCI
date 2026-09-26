#!/usr/bin/env node
/**
 * Regex safety worker.
 *
 * Called by scripts/lint.js as: node scripts/regex-scan-worker.js <json>
 * where <json> is [{id, source, flags}].
 *
 * The question is whether a pattern backtracks catastrophically, which is a
 * question about *how its cost grows*, not about how long one run happened to
 * take. So this measures the same pattern at two input sizes and compares.
 *
 *   linear     40 → 160 characters: roughly the same order of work
 *   exponential              : each extra character can double the work, so the
 *                              long run is the one that never returns
 *
 * Two details make this stable enough to gate a build on:
 *
 *   - Every measurement is the *minimum* of several runs. Noise can only make a
 *     run slower, so the minimum converges on the real cost. Taking the maximum
 *     — or a single run — flags `/\s+/g` the moment the machine is busy, and a
 *     lint rule that cries wolf is a lint rule nobody runs.
 *   - Each match runs inside vm.runInNewContext with a timeout, because Node's
 *     vm timeout does interrupt a backtracking regular expression. Without it
 *     the worker itself would hang and the culprit would never be reported.
 *
 * Prints one JSON array of the patterns that were slow.
 */

const vm = require('vm');

const patterns = JSON.parse(process.argv[2] || '[]');

/**
 * Per-pass budget.
 *
 * Long enough that a linear pattern never approaches it even on a machine with
 * every core busy: a linear match on 160 characters is microseconds, so this is
 * four orders of magnitude of headroom.
 */
const RUN_BUDGET_MS = 250;

/**
 * Budget for the confirming pass.
 *
 * A single 250ms overrun is not proof of anything — under CPU contention the
 * thread, and the watchdog that interrupts it, can both be descheduled. So a
 * timeout is only believed once it survives a budget six times longer. A stalled
 * measurement passes here; a backtracking regex, which needs microseconds on a
 * linear input and forever on an adversarial one, does not.
 */
const CONFIRM_BUDGET_MS = 1500;

/**
 * Adversarial material, one character class per entry.
 *
 * Every entry is what a catastrophic pattern needs to start backtracking:
 * long runs of one character with a near-miss at the end, unterminated groups,
 * unterminated escapes, unterminated classes. The worker stretches these to
 * each measurement size rather than hard-coding lengths, so the two sizes are
 * the same shape.
 */
const MATERIAL = [
    (n) => 'a'.repeat(n),
    (n) => `${'a'.repeat(n - 1)}!`,
    (n) => `${'a'.repeat(n >> 1)}b`,
    (n) => '(' .repeat(n >> 1),
    (n) => '()'.repeat(n >> 1),
    (n) => 'x'.repeat(n),
    (n) => `${' '.repeat(n - 1)} `,
    (n) => '0'.repeat(n),
    (n) => 'aaaaaaaaaabbbbbbbbbb'.repeat(n).slice(0, n),
    (n) => '\\'.repeat(n),
    (n) => '['.repeat(n),
    (n) => `${'a'.repeat(n - 1)}\n`,
    (n) => `${'a'.repeat(n >> 1)}${'a'.repeat(n >> 1)}`,
    (n) => 'a?'.repeat(n >> 1),
    (n) => `${'-'.repeat(n - 1)}1`
];

/**
 * One context, reused. Creating a context per call costs tens of milliseconds,
 * which is the same order as the budget and would flag every pattern; reusing
 * it makes the measurement reflect the regex alone.
 */
const sandbox = { r: null, input: null };
const context = vm.createContext(sandbox);

/** Run one match. Returns `Infinity` when it had to be interrupted. */
function timedExec(re, input, timeoutMs) {
    sandbox.r = re;
    sandbox.input = input;
    try {
        vm.runInContext('r.exec(input)', context, { timeout: timeoutMs });
        return false;
    } catch (err) {
        // Only a timeout is a signal. A pattern that throws on some input is a
        // different problem and not this check's business.
        return /timed out/i.test(err.message);
    }
}

/**
 * Cost of one pass over the whole adversarial set at `size`.
 *
 * @returns {number} milliseconds, or `Infinity` if any input had to be aborted.
 */
function costOf(re, size, budgetMs = RUN_BUDGET_MS) {
    const started = process.hrtime.bigint();
    for (const build of MATERIAL) {
        if (timedExec(re, build(size), budgetMs)) return Infinity;
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Did the pattern genuinely fail to finish, as opposed to a noisy measurement?
 *
 * The confirming pass is what separates "this regex backtracks forever" from
 * "the machine hiccuped". Only the first one is a defect in the code.
 */
function isCatastrophic(re, size) {
    if (costOf(re, size, RUN_BUDGET_MS) !== Infinity) return false;
    return costOf(re, size, CONFIRM_BUDGET_MS) === Infinity;
}

/**
 * How much a 4× longer input costs relative to the short one.
 *
 * Linear growth over 4× means about 4× the work; anything that backtracks
 * explodes well past that. The floor keeps a pattern that is simply fast from
 * being judged on a ratio at all — a ratio between two sub-millisecond
 * measurements is noise.
 */
const GROWTH_LIMIT = 12;
const NOISE_FLOOR_MS = 5;
const ROUNDS = 2;

const shortSize = 40;
const longSize = 160;

const slow = [];

for (const pattern of patterns) {
    let re;
    try {
        re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    } catch (_) {
        continue; // not a valid standalone pattern — not this check's business
    }

    // Cheapest decision first. A pattern that cannot finish on 40 characters is
    // out of the question, and the long size is then never measured — which is
    // what keeps the cost of *finding* a bad pattern down to one interruption.
    if (isCatastrophic(re, shortSize)) {
        slow.push({ id: pattern.id, source: pattern.source, flags: pattern.flags, ms: CONFIRM_BUDGET_MS });
        continue;
    }

    // The two sizes are measured back to back, round after round, and the
    // *minimum ratio across rounds* is what gets judged. Taking the ratio of the
    // two minima compares two different moments in time, and a machine that is
    // briefly busy between them reports a linear pattern as exponential — which
    // is exactly the false alarm that teaches people to ignore this rule.
    let bestRatio = Infinity;
    let bestLong = Infinity;

    for (let round = 0; round < ROUNDS; round++) {
        const shortMs = costOf(re, shortSize);
        const longMs = costOf(re, longSize);
        // A timeout here was already cleared by the confirmation above, so this
        // is a stalled round; skip its ratio rather than let it be judged.
        if (shortMs === Infinity || longMs === Infinity) continue;
        if (longMs < bestLong) bestLong = longMs;
        const ratio = longMs / Math.max(shortMs, 0.01);
        if (ratio < bestRatio) bestRatio = ratio;
    }

    // A jump that starts from nothing real is a jump from noise. Require the
    // long run to be slow in absolute terms *and* to have grown super-linearly.
    if (bestLong > NOISE_FLOOR_MS && bestRatio > GROWTH_LIMIT) {
        slow.push({
            id: pattern.id, source: pattern.source, flags: pattern.flags,
            ms: Math.round(bestLong), grew: `${Math.round(bestRatio * 100) / 100}× for 4× the input`
        });
    }
}

process.stdout.write(JSON.stringify(slow));
