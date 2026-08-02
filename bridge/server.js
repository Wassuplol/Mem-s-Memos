/**
 * MEM'S MEMOS — local bridge (OPTIONAL). Zero-dependency Node server on
 * 127.0.0.1:8787. Solves browser CORS for Qdrant / OpenAI-compatible lanes
 * and keeps API keys OUT of the browser (set them as env vars here instead).
 *
 *   node bridge/server.js
 *
 * Endpoints:
 *   GET  /health                → { ok, uptime }
 *   POST /qdrant/proxy?path=…   → forwards to QDRANT_URL (env QDRANT_URL, default http://localhost:6333)
 *   POST /embed                 → forwards to EMBED_URL/v1/embeddings (env EMBED_URL)
 *   POST /chat                  → forwards to CHAT_URL/v1/chat/completions (env CHAT_URL)
 *   POST /backup/export         → writes body to ./backups/<ts>.json, returns path
 *   POST /backup/import         → reads {path} and returns its contents
 *
 * Localhost-only: requests whose Origin is not localhost/127.0.0.1 are
 * still served (browsers enforce CORS themselves via the headers below),
 * but the server BINDS to 127.0.0.1 so it is unreachable from the network.
 */

import http from 'node:http';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.MM_BRIDGE_PORT || 8787);
const HOST = '127.0.0.1';
const QDRANT_URL = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/+$/, '');
const QDRANT_KEY = process.env.QDRANT_API_KEY || '';
const EMBED_URL = (process.env.EMBED_URL || 'http://localhost:11434').replace(/\/+$/, '');
const EMBED_KEY = process.env.EMBED_API_KEY || '';
const CHAT_URL = (process.env.CHAT_URL || 'http://localhost:11434').replace(/\/+$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const BACKUP_DIR = resolve(process.env.MM_BACKUP_DIR || './backups');
const startedAt = Date.now();

const CORS = {
    'Access-Control-Allow-Origin': '*', // bridge is localhost-bound; browsers still gate
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, api-key',
    'Access-Control-Max-Age': '600',
};

function send(res, status, body, headers = {}) {
    const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
    const data = isObj ? JSON.stringify(body) : body;
    res.writeHead(status, {
        ...CORS,
        'Content-Type': isObj ? 'application/json' : 'text/plain',
        ...headers,
    });
    res.end(data);
}

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 64 * 1024 * 1024) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolveBody(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function forward(targetUrl, { method = 'POST', headers = {}, body }) {
    const res = await fetch(targetUrl, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : body,
    });
    const text = await res.text();
    return { status: res.status, text };
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
            res.end();
            return;
        }

        if (url.pathname === '/health' && req.method === 'GET') {
            return send(res, 200, {
                ok: true,
                uptime: Math.round((Date.now() - startedAt) / 1000),
                qdrant: QDRANT_URL,
                embed: EMBED_URL,
                chat: CHAT_URL,
                keyed: { qdrant: !!QDRANT_KEY, embed: !!EMBED_KEY, chat: !!CHAT_KEY },
            });
        }

        if (url.pathname === '/qdrant/proxy' && req.method === 'POST') {
            const path = url.searchParams.get('path');
            if (!path || !path.startsWith('/')) return send(res, 400, { error: 'path query param required (must start with /)' });
            const body = await readBody(req);
            const out = await forward(`${QDRANT_URL}${path}`, {
                method: url.searchParams.get('method') || 'POST',
                headers: QDRANT_KEY ? { 'api-key': QDRANT_KEY } : {},
                body: body.length ? body : undefined,
            });
            return send(res, out.status, out.text, { 'Content-Type': 'application/json' });
        }

        if (url.pathname === '/embed' && req.method === 'POST') {
            const body = await readBody(req);
            const out = await forward(`${EMBED_URL}/v1/embeddings`, {
                headers: EMBED_KEY ? { Authorization: `Bearer ${EMBED_KEY}` } : {},
                body,
            });
            return send(res, out.status, out.text, { 'Content-Type': 'application/json' });
        }

        if (url.pathname === '/chat' && req.method === 'POST') {
            const body = await readBody(req);
            const out = await forward(`${CHAT_URL}/v1/chat/completions`, {
                headers: CHAT_KEY ? { Authorization: `Bearer ${CHAT_KEY}` } : {},
                body,
            });
            return send(res, out.status, out.text, { 'Content-Type': 'application/json' });
        }

        if (url.pathname === '/backup/export' && req.method === 'POST') {
            const body = await readBody(req);
            await mkdir(BACKUP_DIR, { recursive: true });
            const name = `mems-memos-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const file = join(BACKUP_DIR, name);
            await writeFile(file, body);
            return send(res, 200, { ok: true, path: file });
        }

        if (url.pathname === '/backup/import' && req.method === 'POST') {
            const body = await readBody(req);
            let parsed;
            try {
                parsed = JSON.parse(body.toString('utf8'));
            } catch {
                return send(res, 400, { error: 'expected JSON body {path}' });
            }
            const target = resolve(String(parsed.path || ''));
            if (!target.startsWith(BACKUP_DIR)) return send(res, 403, { error: 'imports are limited to the backups directory' });
            const data = await readFile(target);
            return send(res, 200, data, { 'Content-Type': 'application/json' });
        }

        return send(res, 404, { error: 'unknown endpoint', known: ['/health', '/qdrant/proxy', '/embed', '/chat', '/backup/export', '/backup/import'] });
    } catch (err) {
        return send(res, 500, { error: String(err?.message || err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[Mem's Memos bridge] listening on http://${HOST}:${PORT}`);
    console.log(`  qdrant → ${QDRANT_URL}${QDRANT_KEY ? ' (keyed)' : ''}`);
    console.log(`  embed  → ${EMBED_URL}/v1/embeddings${EMBED_KEY ? ' (keyed)' : ''}`);
    console.log(`  chat   → ${CHAT_URL}/v1/chat/completions${CHAT_KEY ? ' (keyed)' : ''}`);
    console.log(`  backups→ ${BACKUP_DIR}`);
});
