# Contributing to AeroCI

Thank you for your interest in contributing to **AeroCI**! ✈️

---

## Development Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/Moaaz-i/AeroCI.git
   cd AeroCI
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Link the package locally:
   ```bash
   npm link
   ```

4. Verify installation:
   ```bash
   aeroci --version
   ```

---

## Running Tests

Run the integration test suite:

```bash
npm test
```

---

## Project Structure

```
AeroCI/
├── bin/
│   └── aeroci.js        # Executable entry point
├── src/
│   ├── cli.js           # Commander CLI routes
│   ├── server.js        # VelociRadix Web UI server
│   ├── core/
│   │   ├── runner.js    # Sub-millisecond execution engine
│   │   ├── checker.js   # Pre-flight static audit engine
│   │   ├── analyzer.js  # Deep workflow intelligence (Features 1-10)
│   │   ├── profiler.js  # Performance profiler (Features 11-20)
│   │   ├── security.js  # Security hardening engine (Features 21-30)
│   │   ├── reporter.js  # Multi-format reporter (Features 31-40)
│   │   ├── actions.js   # Action simulator library (Features 41-50)
│   │   ├── debugger.js  # Interactive debug sandbox
│   │   └── initializer.js # Config & workflow initializer
│   └── utils/
│       └── logger.js    # Logger & visual table formatter
├── docs/                # Comprehensive documentation
├── tests/               # Test suites
└── package.json
```

---

## Submitting Pull Requests

1. Create a feature branch (`git checkout -b feature/my-feature`).
2. Ensure all tests pass (`npm test`).
3. Commit your changes (`git commit -m "feat: add awesome feature"`).
4. Push to your branch and open a Pull Request.
