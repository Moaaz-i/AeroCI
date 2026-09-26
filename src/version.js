/**
 * Single source of truth for the engine version.
 * Every user-facing surface reads from here so the reported version can never
 * drift away from package.json again.
 */

const path = require('path');

let cached = null;

function load() {
    if (cached) return cached;
    try {
        const pkg = require(path.join(__dirname, '..', 'package.json'));
        cached = { version: pkg.version || '0.0.0', name: pkg.name || 'aeroci' };
    } catch (_) {
        cached = { version: '0.0.0', name: 'aeroci' };
    }
    return cached;
}

const VERSION = load().version;
const NAME = load().name;

module.exports = { VERSION, NAME, banner: `${NAME} v${VERSION}` };
