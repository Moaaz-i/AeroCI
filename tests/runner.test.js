/**
 * Automated Verification Suite for CI-Drift
 */

const { Checker } = require('../src/core/checker');
const { Runner } = require('../src/core/runner');
const { Initializer } = require('../src/core/initializer');
const { Logger } = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

Logger.banner();
Logger.info("Starting CI-Drift Automated Verification Suite...\n");

// Test 1: Initialization Test
Logger.info("Test 1: Testing Initializer engine...");
Initializer.init();
if (fs.existsSync(path.join(process.cwd(), '.drift.json'))) {
    Logger.success("Test 1 Passed: .drift.json configuration generated.");
} else {
    Logger.error("Test 1 Failed: .drift.json missing!");
    process.exit(1);
}

// Test 2: Checker Engine Test
Logger.info("\nTest 2: Testing Checker pre-flight engine...");
const checkResult = Checker.check('.github/workflows/main.yml');
if (checkResult.valid) {
    Logger.success("Test 2 Passed: Pre-flight audit engine verified.");
} else {
    Logger.error("Test 2 Failed!");
    process.exit(1);
}

// Test 3: Simulation Runner Test
Logger.info("\nTest 3: Testing Runner simulation engine...");
Runner.run('.github/workflows/main.yml');
Logger.success("Test 3 Passed: Pipeline simulation completed successfully.");

console.log("\n");
Logger.success("ALL 3 CI-DRIFT INTEGRATION TESTS PASSED PERFECTLY! ✨\n");
