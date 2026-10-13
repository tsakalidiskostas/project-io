import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { query, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { fetchPrHead } from '../github.ts';
import { MODEL_IDS, modelDisplayName, resolveChoice, WORK_MODEL } from '../model-choice.ts';
import { ensureIoProfile, ioSessionEnv } from '../profile.ts';
import { describeStats, sessionStats } from '../stats.ts';
import { defaultStore, type WorkSessionRecord } from '../store.ts';
import { originSlug, prepareWorktree } from './git.ts';

// A work session is an interactive Claude Code session in a checkout, driven from the browser instead
// of a terminal: the user's messages stream in, permission prompts are answered on the page.

export type WorkEvent = Record<string, unknown> & { type: string };
type Listener = (seq: number | null, event: WorkEvent) => void;

export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type Mode = (typeof MODES)[number];

// Raised when a PR's repository has no known local clone; the UI asks for its path.
export class NeedsRepoError extends Error {
    readonly slug: string;
    constructor(slug: string) {
        super(`Where is ${slug} cloned on this machine?`);
        this.slug = slug;
    }
}

interface Pending {
    resolve(result: PermissionResult): void;
    input: Record<string, unknown>;
    suggestions?: PermissionUpdate[];
}

interface Live {
    query: Query;
    input: ReturnType<typeof inputQueue>;
    pending: Map<string, Pending>;
    busy: boolean;
    idleTimer: NodeJS.Timeout | null;
    ready: Promise<void>;
}

const live = new Map<string, Live>();
const listeners = new Map<string, Set<Listener>>();

// An idle session's Claude Code process is closed; the next message resumes the conversation.
const IDLE_CLOSE_MS = 15 * 60_000;
// claude.ai connectors take about 4s to connect, and a first message sent sooner runs without them.
const MCP_STARTUP_WAIT_MS = 5_000;
const CLIP = 4_000;

function inputQueue() {
    const items: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    return {
        push(text: string) {
            items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
            wake?.();
        },
        close() {
            closed = true;
            wake?.();
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
            for (;;) {
                while (items.length) yield items.shift()!;
                if (closed) return;
                await new Promise<void>(r => (wake = r));
                wake = null;
            }
        },
    };
}

// Tool inputs can carry whole files (Write); the transcript keeps enough to read, not everything.
export function clip(value: unknown, max = CLIP): unknown {
    if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}\n… ${value.length - max} more characters` : value;
    if (Array.isArray(value)) return value.map(v => clip(v, max));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
    return value;
}

function emit(id: string, event: WorkEvent, persist = true) {
    const seq = persist ? defaultStore().appendWorkEvent(id, event) : null;
    for (const fn of listeners.get(id) ?? []) fn(seq, event);
}

export function subscribe(id: string, fn: Listener): () => void {
    let set = listeners.get(id);
    if (!set) listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
}

export function sessionState(id: string) {
    const l = live.get(id);
    return { live: Boolean(l), busy: l?.busy ?? false, waiting: [...(l?.pending.keys() ?? [])] };
}

const emitState = (id: string) => emit(id, { type: 'state', ...sessionState(id) }, false);

const newId = () => randomBytes(8).toString('hex');

export async function createWorkSession(from: { analysisId: string } | { cwd: string }): Promise<WorkSessionRecord> {
    const store = defaultStore();
    let record: WorkSessionRecord;
    if ('analysisId' in from) {
        const { pr } = store.get(from.analysisId);
        const slug = `${pr.owner}/${pr.repo}`.toLowerCase();
        const repoPath = store.repoPaths()[slug];
        if (!repoPath) throw new NeedsRepoError(slug);
        const head = await fetchPrHead({ owner: pr.owner, repo: pr.repo, number: pr.number });
        const cwd = realpathSync.native((await prepareWorktree(repoPath, { number: pr.number, ...head })).cwd);
        const existing = store.workSessions().find(s => s.analysisId === from.analysisId && s.cwd.toLowerCase() === cwd.toLowerCase());
        if (existing) return existing;
        record = {
            id: newId(),
            createdAt: new Date().toISOString(),
            title: `#${pr.number} ${head.title}`,
            cwd,
            analysisId: from.analysisId,
            pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: head.url, branch: head.headRefName },
            claudeSessionId: null,
            mode: 'default',
        };
    } else {
        if (!from.cwd.trim() || !existsSync(from.cwd) || !statSync(from.cwd).isDirectory()) throw new Error(`${from.cwd || 'That'} is not a folder.`);
        const cwd = realpathSync.native(from.cwd);
        record = { id: newId(), createdAt: new Date().toISOString(), title: path.basename(cwd), cwd, analysisId: null, pr: null, claudeSessionId: null, mode: 'default' };
    }
    store.saveWorkSession(record);
    emit(record.id, { type: 'notice', text: `Working in ${record.cwd}` });
    return record;
}

// Checks the folder really is a clone of the repository before Io creates worktrees from it.
export async function rememberRepo(slug: string, repoPath: string): Promise<void> {
    const resolved = path.resolve(repoPath);
    const origin = await originSlug(resolved);
    if (origin !== slug.toLowerCase()) {
        throw new Error(origin ? `${resolved} is a clone of ${origin}, not ${slug}.` : `${resolved} is not a git clone of ${slug}.`);
    }
    defaultStore().saveRepoPath(slug, resolved);
}

function instructions(s: WorkSessionRecord): string {
    const pr = s.pr
        ? `\nThis is a checkout of ${s.pr.owner}/${s.pr.repo} pull request #${s.pr.number} (${s.pr.url}), branch ${s.pr.branch}. The GitHub CLI (gh) is signed in as the user; use it to read the PR, its review comments and its checks.`
        : '';
    return `You are running inside Io, a local web app, instead of a terminal. The user reads your replies in a browser and answers permission prompts there.${pr}

When a change is done and the repository's checks pass, commit it following the repository's own conventions. Never push and never post to GitHub unless the user asks in this conversation: the user pushes from Io after reviewing your commits.`;
}

function start(s: WorkSessionRecord): Live {
    const choice = resolveChoice(WORK_MODEL, defaultStore().modelSettings().work);
    const input = inputQueue();
    const pending = new Map<string, Pending>();
    const q = query({
        prompt: input,
        options: {
            cwd: s.cwd,
            model: MODEL_IDS[choice.model],
            effort: choice.effort,
            includePartialMessages: true,
            systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions(s) },
            // Io's profile for login and MCP servers, plus the repository's own CLAUDE.md, settings and skills.
            settingSources: ['user', 'project', 'local'],
            permissionMode: s.mode,
            resume: s.claudeSessionId ?? undefined,
            env: ioSessionEnv(ensureIoProfile()),
            canUseTool: (tool, toolInput, opts) =>
                new Promise<PermissionResult>(resolve => {
                    const requestId = opts.toolUseID;
                    pending.set(requestId, { resolve, input: toolInput, suggestions: opts.suggestions });
                    opts.signal.addEventListener('abort', () => {
                        if (pending.delete(requestId)) resolve({ behavior: 'deny', message: 'Cancelled.' });
                    }, { once: true });
                    emit(s.id, {
                        type: 'permission',
                        requestId,
                        tool,
                        title: opts.title ?? null,
                        description: opts.description ?? null,
                        input: clip(toolInput),
                        canAlways: Boolean(opts.suggestions?.length) && !opts.suppressAlwaysAllowRule,
                    });
                    emitState(s.id);
                }),
        },
    });
    const l: Live = { query: q, input, pending, busy: false, idleTimer: null, ready: new Promise(r => setTimeout(r, MCP_STARTUP_WAIT_MS)) };
    live.set(s.id, l);
    emit(s.id, { type: 'notice', text: `${s.claudeSessionId ? 'Resumed' : 'Started'} Claude Code · ${modelDisplayName(MODEL_IDS[choice.model])}, ${choice.effort} effort` });
    consume(s.id, l);
    return l;
}

async function consume(id: string, l: Live) {
    try {
        for await (const message of l.query) handle(id, l, message);
    } catch (err) {
        emit(id, { type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
        if (l.idleTimer) clearTimeout(l.idleTimer);
        for (const p of l.pending.values()) p.resolve({ behavior: 'deny', message: 'The session ended.' });
        if (live.get(id) === l) live.delete(id);
        emitState(id);
    }
}

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n');
    return '';
}

function handle(id: string, l: Live, message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init') {
        const store = defaultStore();
        const record = store.workSession(id);
        if (record.claudeSessionId !== message.session_id) store.saveWorkSession({ ...record, claudeSessionId: message.session_id });
    } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const e = message.event;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') emit(id, { type: 'delta', text: e.delta.text }, false);
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) emit(id, { type: 'assistant', text: block.text });
            else if (block.type === 'tool_use') emit(id, { type: 'tool', id: block.id, name: block.name, input: clip(block.input) });
        }
    } else if (message.type === 'user' && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
            if (block.type === 'tool_result') {
                emit(id, { type: 'tool_result', id: block.tool_use_id, error: Boolean(block.is_error), text: clip(toolResultText(block.content), 2_000) });
            }
        }
    } else if (message.type === 'result') {
        const ok = message.subtype === 'success' && !message.is_error;
        const stats = sessionStats(message);
        emit(id, {
            type: 'result',
            ok,
            stats,
            summary: describeStats(stats),
            error: ok ? null : message.subtype === 'success' ? message.result : message.errors.join('; ') || message.subtype,
        });
        l.busy = false;
        emitState(id);
        l.idleTimer = setTimeout(() => {
            if (!l.busy && !l.pending.size) l.input.close();
        }, IDLE_CLOSE_MS);
    }
}

export async function sendMessage(id: string, text: string): Promise<void> {
    const record = defaultStore().workSession(id);
    const l = live.get(id) ?? start(record);
    if (l.idleTimer) clearTimeout(l.idleTimer);
    emit(id, { type: 'user', text });
    l.busy = true;
    emitState(id);
    await l.ready;
    l.input.push(text);
}

export function answerPermission(
    id: string,
    requestId: string,
    answer: { decision: 'allow' | 'always' | 'deny'; message?: string; answers?: Record<string, string> },
) {
    const p = live.get(id)?.pending.get(requestId);
    if (!p) throw new Error('That request is no longer waiting. The session may have ended.');
    live.get(id)!.pending.delete(requestId);
    if (answer.decision === 'deny') {
        p.resolve({ behavior: 'deny', message: answer.message?.trim() || 'The user declined this.' });
    } else {
        p.resolve({
            behavior: 'allow',
            updatedInput: answer.answers ? { ...p.input, answers: answer.answers } : p.input,
            updatedPermissions: answer.decision === 'always' ? p.suggestions : undefined,
        });
    }
    emit(id, { type: 'permission_answer', requestId, decision: answer.decision, answers: answer.answers ?? null });
    emitState(id);
}

export async function interrupt(id: string): Promise<void> {
    const l = live.get(id);
    if (!l?.busy) return;
    await l.query.interrupt();
    emit(id, { type: 'notice', text: 'Interrupted.' });
}

export async function setMode(id: string, mode: Mode): Promise<void> {
    const store = defaultStore();
    store.saveWorkSession({ ...store.workSession(id), mode });
    await live.get(id)?.query.setPermissionMode(mode);
    emit(id, { type: 'notice', text: `Permission mode: ${mode}` });
}

export function endSession(id: string, { forget = false } = {}) {
    const l = live.get(id);
    if (l) {
        l.query.close();
        live.delete(id);
    }
    if (forget) defaultStore().deleteWorkSession(id);
    else emitState(id);
}
