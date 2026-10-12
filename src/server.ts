import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent-loop.ts';
import { flowToMermaid, reviewSummary, type Analysis } from './analysis.ts';
import { analyzePullRequest } from './analyze.ts';
import { fetchPrState, postInlineComment, postPrComment } from './github.ts';
import { authStatus, discoverProfiles, importServer, IO_CLAUDE_DIR, listIoServers } from './profile.ts';
import { runOrThrow } from './run.ts';
import { selfEdit } from './self-edit/agent.ts';
import { revertLastSelfEdit } from './self-edit/git.ts';
import { describeRun, modelDisplayName, ModelSettings, REWRITE_MODEL, resolveChoice } from './model-choice.ts';
import { defaultStore } from './store.ts';
import { planUsage } from './usage.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4317);
// The supervisor restarts the server when it exits with this code.
export const RESTART_EXIT_CODE = 75;

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Files under public/ by extension, plus tokens.css straight from the design handoff so there is one copy.
function staticFile(pathname: string): string | null {
    if (pathname === '/') return path.join(ROOT, 'public', 'index.html');
    if (pathname === '/tokens.css') return path.join(ROOT, 'docs', 'design', 'tokens.css');
    const file = path.resolve(ROOT, 'public', `.${decodeURIComponent(pathname)}`);
    const inside = file.startsWith(path.join(ROOT, 'public') + path.sep);
    return inside && TYPES[path.extname(file)] ? file : null;
}

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

function json(res: ServerResponse, data: object) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...data }));
}

function streamTo(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    return (event: object) => res.write(`${JSON.stringify(event)}\n`);
}

function restartSoon() {
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}

// Runs saved before runInfo existed only know the aliases, e.g. "sonnet → opus".
function runLabel(r: { model: string; runInfo: Analysis['runInfo'] }): string {
    if (r.runInfo) return describeRun(r.runInfo);
    const [intent, verify] = r.model.split(' → ');
    return `extracted claims with ${modelDisplayName(intent)}, claims vs code with ${modelDisplayName(verify ?? intent)}`;
}

function withViews(a: Analysis, run: number) {
    const verdicts = Object.fromEntries(a.claims.map(c => [c.id, c.verdict]));
    const runs = defaultStore().runs(a.id).map(r => ({ n: r.n, createdAt: r.createdAt, label: runLabel(r) }));
    return {
        ...a,
        mermaid: flowToMermaid(a.flow, verdicts),
        summaryMarkdown: reviewSummary(a),
        run,
        runs,
        runLabel: runs.find(r => r.n === run)?.label ?? '',
    };
}

const STATE_CHECK_EVERY_MS = 10 * 60_000;

// Records each open PR's state so merged PRs leave the inbox and new commits mark an analysis stale.
// A failed check is skipped silently and retried on a later inbox load.
async function syncPrStates() {
    const store = defaultStore();
    await Promise.all(
        store.dueForStateCheck(STATE_CHECK_EVERY_MS).map(async id => {
            const { owner, repo, number } = store.get(id).pr;
            try {
                const { state, headRefOid } = await fetchPrState({ owner, repo, number });
                store.recordPrState(id, state, headRefOid);
            } catch {
                // gh offline or the PR is gone; the row stays as it was
            }
        }),
    );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const analysisRoute = url.pathname.match(/^\/api\/analyses\/([\w.-]+)(\/.*)?$/);

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = staticFile(url.pathname);
        if (!file) return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
        res.end(await readFile(file));
        return;
    }

    if (route === 'GET /api/health') {
        const sha = (await runOrThrow('git', ['rev-parse', '--short', 'HEAD'], ROOT)).trim();
        return json(res, { sha });
    }

    if (route === 'GET /api/settings/models') return json(res, { models: defaultStore().modelSettings() });

    if (route === 'POST /api/settings/models') {
        const parsed = ModelSettings.safeParse((await readJson(req)).models);
        if (!parsed.success) throw new Error(`Invalid model settings: ${parsed.error.message}`);
        defaultStore().saveModelSettings(parsed.data);
        return json(res, { models: defaultStore().modelSettings() });
    }

    if (route === 'GET /api/usage') return json(res, { usage: await planUsage({ fresh: url.searchParams.get('fresh') === '1' }) });

    if (route === 'GET /api/profile') {
        const [auth, servers] = await Promise.all([authStatus(), listIoServers()]);
        return json(res, { dir: IO_CLAUDE_DIR, auth, servers, importable: discoverProfiles() });
    }

    if (route === 'POST /api/profile/import') {
        const { profile, name, scope } = await readJson(req);
        await importServer(String(profile), String(name), String(scope));
        return json(res, {});
    }

    if (route === 'POST /api/analyze') {
        const { input } = await readJson(req);
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const send = streamTo(res);
        try {
            const analysis = await analyzePullRequest(String(input ?? ''), send, abort.signal);
            send({ type: 'done', id: analysis.id });
        } catch (err) {
            send({ type: 'error', error: errorText(err) });
        }
        res.end();
        return;
    }

    if (route === 'GET /api/analyses') {
        const dismissed = url.searchParams.get('dismissed') === '1';
        if (!dismissed) await syncPrStates();
        return json(res, { analyses: defaultStore().list({ dismissed }) });
    }

    if (analysisRoute) {
        const [, id, rest = ''] = analysisRoute;
        const store = defaultStore();
        const latest = store.runs(id).at(-1)?.n ?? 1;
        const run = url.searchParams.has('run') ? Number(url.searchParams.get('run')) : latest;
        if (req.method === 'GET' && rest === '') return json(res, { analysis: withViews(store.get(id, run), run) });
        if (req.method === 'POST' && rest === '/dismiss') return json(res, (store.dismiss(id, 'manual'), {}));
        if (req.method === 'POST' && rest === '/restore') return json(res, (store.restore(id), {}));

        const unclaimed = rest.match(/^\/unclaimed\/(\d+)$/);
        if (req.method === 'POST' && unclaimed) {
            const { expected } = await readJson(req);
            const index = Number(unclaimed[1]);
            const updated = store.update(id, a => {
                if (!a.unclaimed[index]) throw new Error('No such unclaimed change.');
                a.unclaimed[index].expected = Boolean(expected);
            }, run);
            return json(res, { analysis: withViews(updated, run) });
        }

        // Posting is an explicit click in the UI; it writes to GitHub as the user's gh login.
        if (req.method === 'POST' && rest === '/comment') {
            const { body, placement, path: file, line } = await readJson(req);
            if (typeof body !== 'string' || !body.trim()) throw new Error('The comment is empty.');
            const a = store.get(id, run);
            const ref = { owner: a.pr.owner, repo: a.pr.repo, number: a.pr.number };
            const where =
                placement === 'inline'
                    ? await postInlineComment(ref, a.pr.headRefOid, String(file), Number(line), body)
                    : await postPrComment(ref, body);
            return json(res, { url: where });
        }
    }

    if (route === 'POST /api/rewrite') {
        const { text } = await readJson(req);
        const { text: rewritten } = await runAgent({
            prompt: `Rewrite this pull request review comment so it is clear, specific and courteous, keeps every technical point, and stays as short as it can be. Reply with the comment only.\n\n${String(text)}`,
            choice: resolveChoice(REWRITE_MODEL, defaultStore().modelSettings().rewrite),
            options: { cwd: os.tmpdir(), settingSources: [], tools: [], strictMcpConfig: true, maxTurns: 1 },
            onEvent: () => undefined,
        });
        return json(res, { text: rewritten.trim() });
    }

    if (route === 'POST /api/self-edit') {
        const { request, pointer } = await readJson(req);
        if (typeof request !== 'string' || !request.trim()) throw new Error('Describe the change you want.');
        const pointed =
            pointer && typeof pointer === 'object'
                ? `\n\nThe user pointed at this element while asking: ${JSON.stringify(pointer)}`
                : '';
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const send = streamTo(res);
        let committed = false;
        try {
            const result = await selfEdit(ROOT, request + pointed, send, abort.signal);
            committed = result.committed;
            send({ type: 'done', committed, summary: result.summary });
        } catch (err) {
            send({ type: 'error', error: errorText(err) });
        }
        res.end();
        if (committed) restartSoon();
        return;
    }

    const commit = url.pathname.match(/^\/api\/commit\/([0-9a-f]{7,40})$/);
    if (req.method === 'GET' && commit) {
        return json(res, { diff: await runOrThrow('git', ['show', '--stat', '--patch', '--format=%h %s%n', commit[1]], ROOT) });
    }

    if (route === 'POST /api/undo') {
        const sha = await revertLastSelfEdit(ROOT);
        json(res, { sha });
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
        res.end(JSON.stringify({ ok: false, error: errorText(err) }));
    });
}).listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Io listening on http://localhost:${PORT}\n`);
});
