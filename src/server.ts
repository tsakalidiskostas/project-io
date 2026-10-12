import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainPullRequest } from './explain.ts';
import { parsePrRef } from './github.ts';
import { selfEdit } from './self-edit/agent.ts';
import { revertLastSelfEdit } from './self-edit/git.ts';
import { runOrThrow } from './run.ts';
import { authStatus, discoverProfiles, importServer, IO_CLAUDE_DIR, listIoServers } from './profile.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4317);
// The supervisor restarts the server when it exits with this code.
export const RESTART_EXIT_CODE = 75;

// Paths relative to the repo root. tokens.css is served from the design handoff so there is one copy.
const STATIC: Record<string, string> = {
    '/': 'public/index.html',
    '/app.js': 'public/app.js',
    '/style.css': 'public/style.css',
    '/tokens.css': 'docs/design/tokens.css',
};
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// This server can rewrite its own code, so refuse anything a web page could forge: a foreign
// Host (DNS rebinding) or a POST without the custom header (which forces a CORS preflight we never answer).
function isTrusted(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1') return false;
    return req.method === 'GET' || req.headers['x-io'] === '1';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of req) body += chunk;
    return JSON.parse(body || '{}');
}

function streamTo(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    return (event: object) => res.write(`${JSON.stringify(event)}\n`);
}

function restartSoon() {
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
        res.end(await readFile(path.join(ROOT, file)));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
        const sha = (await runOrThrow('git', ['rev-parse', '--short', 'HEAD'], ROOT)).trim();
        const log = await runOrThrow('git', ['log', '-10', '--format=%h%x09%s'], ROOT);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sha, recent: log.trim().split('\n') }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/profile') {
        const [auth, servers] = await Promise.all([authStatus(), listIoServers()]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dir: IO_CLAUDE_DIR, auth, servers, importable: discoverProfiles() }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/profile/import') {
        const { profile, name, scope } = await readJson(req);
        await importServer(String(profile), String(name), String(scope));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/explain') {
        const { pr } = await readJson(req);
        const ref = parsePrRef(String(pr ?? ''));
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const send = streamTo(res);
        try {
            await explainPullRequest(ref, send, abort.signal);
            send({ type: 'done' });
        } catch (err) {
            send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        }
        res.end();
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/self-edit') {
        const { request } = await readJson(req);
        if (typeof request !== 'string' || !request.trim()) throw new Error('Describe the change you want.');
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const send = streamTo(res);
        let committed = false;
        try {
            const result = await selfEdit(ROOT, request, send, abort.signal);
            committed = result.committed;
            send({ type: 'done', committed, summary: result.summary });
        } catch (err) {
            send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        }
        res.end();
        if (committed) restartSoon();
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/undo') {
        const sha = await revertLastSelfEdit(ROOT);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sha }));
        restartSoon();
        return;
    }

    res.writeHead(404).end();
}

createServer((req, res) => {
    if (!isTrusted(req)) {
        res.writeHead(403).end();
        return;
    }
    handle(req, res).catch(err => {
        if (res.headersSent) return res.end();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
}).listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Io listening on http://localhost:${PORT}\n`);
});
