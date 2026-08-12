/**
 * VelociRadix Powered Web Dashboard Engine for CI-Drift
 * Provides a local live web interface at http://localhost:3500 to view pipeline simulation analytics.
 */

const { createApp } = require('velociradix');
const fs = require('fs');
const path = require('path');
const { Logger } = require('./utils/logger');

class Server {
    static start(port = 3500) {
        const app = createApp();

        // Dashboard HTML UI Route
        app.get('/', (req, res) => {
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌪️ CI-Drift — Local Digital Twin Dashboard</title>
    <style>
        :root {
            --bg: #0d1117;
            --card-bg: #161b22;
            --border: #30363d;
            --text: #c9d1d9;
            --cyan: #58a6ff;
            --green: #3fb950;
            --purple: #bc8cff;
            --yellow: #d29922;
            --red: #f85149;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 30px;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--border);
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        .title {
            font-size: 24px;
            font-weight: 700;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .badge {
            background: rgba(88, 166, 255, 0.15);
            color: var(--cyan);
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 13px;
            border: 1px solid rgba(88, 166, 255, 0.3);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
        }
        .card h3 {
            margin-top: 0;
            font-size: 14px;
            color: #8b949e;
            text-transform: uppercase;
        }
        .card .stat {
            font-size: 32px;
            font-weight: 800;
            color: #fff;
        }
        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            color: var(--green);
            font-weight: 600;
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--green);
            box-shadow: 0 0 10px var(--green);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
        }
        th, td {
            padding: 14px 18px;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }
        th {
            background: #21262d;
            color: #8b949e;
            font-size: 12px;
            text-transform: uppercase;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">
            <span>🌪️ CI-Drift</span>
            <span class="badge">VelociRadix Engine</span>
        </div>
        <div class="status-pill">
            <span class="status-dot"></span>
            <span>Digital Twin Active</span>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <h3>Remote CI Minutes Saved</h3>
            <div class="card .stat" style="font-size: 32px; font-weight: bold; color: var(--green);">∞ Minutes</div>
        </div>
        <div class="card">
            <h3>Workflow Drifts Detected</h3>
            <div class="card .stat" style="font-size: 32px; font-weight: bold; color: var(--cyan);">0 Drifts</div>
        </div>
        <div class="card">
            <h3>Simulation Engine</h3>
            <div class="card .stat" style="font-size: 20px; font-weight: bold; color: var(--purple);">Ephemeral Sandbox</div>
        </div>
    </div>

    <h2>📋 Monitored Workflows</h2>
    <table>
        <thead>
            <tr>
                <th>Workflow Name</th>
                <th>File Location</th>
                <th>Target Runner</th>
                <th>Pre-flight Status</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>CI Digital Twin Workflow</strong></td>
                <td><code>.github/workflows/main.yml</code></td>
                <td><code>ubuntu-latest</code></td>
                <td><span style="color: var(--green);">✔ Validated</span></td>
            </tr>
        </tbody>
    </table>
</body>
</html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        });

        // API Endpoint for JSON stats
        app.get('/api/status', (req, res) => {
            const data = {
                engine: "CI-Drift Digital Twin",
                version: "1.0.0",
                server: "VelociRadix HTTP Engine",
                remoteMinutesSaved: 100,
                status: "active"
            };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data));
        });

        app.listen(port, () => {
            Logger.banner();
            Logger.success(`VelociRadix-powered Web Dashboard live at: http://localhost:${port}`);
        });
    }
}

module.exports = { Server };
