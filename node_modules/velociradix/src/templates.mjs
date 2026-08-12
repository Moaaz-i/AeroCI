import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const postmanTemplate = readFileSync(resolve(__dirname, "./postman.html"), "utf8");
const swaggerTemplate = readFileSync(resolve(__dirname, "./swagger.html"), "utf8");

function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function getPostmanDocHtml(collection) {
  const requestListItems = collection.item.map((item, idx) => `
        <div class="request-item" onclick="scrollToReq('req-${idx}')">
          <span class="badge badge-${item.request.method.toLowerCase()}">${item.request.method}</span>
          <span>${escapeHtml(item.name)}</span>
        </div>
      `).join('');

  const requestCards = collection.item.map((item, idx) => `
      <div class="request-card" id="req-${idx}">
        <div class="request-card-header">
          <span class="badge badge-${item.request.method.toLowerCase()}">${item.request.method}</span>
          <span class="request-card-title">${escapeHtml(item.name)}</span>
        </div>
        <div class="url-bar">
          <strong style="color: var(--method-${item.request.method.toLowerCase()})">${item.request.method}</strong>
          <span>${escapeHtml(item.request.url.raw)}</span>
        </div>
        ${item.request.description ? `<div class="request-card-desc">${escapeHtml(item.request.description)}</div>` : ''}

        ${item.request.header && item.request.header.length > 0 ? `
          <div class="section-title">Headers</div>
          <table>
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              ${item.request.header.map(h => `<tr><td><code>${escapeHtml(h.key)}</code></td><td><code>${escapeHtml(h.value)}</code></td></tr>`).join('')}
            </tbody>
          </table>
        ` : ''}

        ${item.request.body && item.request.body.raw ? `
          <div class="section-title">Body (JSON Raw)</div>
          <pre class="code-block">${escapeHtml(item.request.body.raw)}</pre>
        ` : ''}

        ${item.response && item.response.length > 0 ? item.response.map(resp => `
          <div class="section-title">Response Example: ${escapeHtml(resp.name)} (${resp.code})</div>
          <pre class="code-block">${escapeHtml(resp.body)}</pre>
        `).join('') : ''}
      </div>
    `).join('');

  return postmanTemplate
    .replace(/\{\{\s*TITLE\s*\}\}/g, escapeHtml(collection.info.name))
    .replace(/\{\{\s*DESCRIPTION\s*\}\}/g, escapeHtml(collection.info.description || ''))
    .replace(/\{\{\s*REQUEST_LIST_ITEMS\s*\}\}/g, requestListItems)
    .replace(/\{\{\s*REQUEST_CARDS\s*\}\}/g, requestCards)
    .replace(/\/\*\s*\{\{\s*COLLECTION_JSON\s*\}\}\s*\*\/\s*\{\}/g, JSON.stringify(collection, null, 2))
    .replace(/\{\{\s*COLLECTION_JSON\s*\}\}/g, JSON.stringify(collection, null, 2))
    .replace(/\{\{\s*DOWNLOAD_FILENAME\s*\}\}/g, `${collection.info.name.replace(/\s+/g, '_')}_postman_collection.json`);
}

export function getSwaggerHtml(spec) {
  return swaggerTemplate
    .replace(/\{\{\s*TITLE\s*\}\}/g, "Velociradix API Docs")
    .replace(/\/\*\s*\{\{\s*SPEC_JSON\s*\}\}/g, "")
    .replace(/\{\{\s*SPEC_JSON\s*\}\}/g, JSON.stringify(spec, null, 2));
}
