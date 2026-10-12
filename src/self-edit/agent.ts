import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, finalText, runToolLoop, type LoopEvent } from '../agent-loop.ts';
import { run } from '../run.ts';
import { resolveEditablePath, resolveReadablePath } from './guard.ts';
import { changedFiles, commitAll, discardAll, isClean, listFiles, SELF_EDIT_TRAILER } from './git.ts';

export type SelfEditEvent =
    | LoopEvent
    | { type: 'checks'; ok: boolean; output: string }
    | { type: 'committed'; sha: string; message: string; files: string[] }
    | { type: 'discarded'; reason: string };

export async function runChecks(root: string): Promise<{ ok: boolean; output: string }> {
    const tsc = await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], root);
    if (tsc.code !== 0) return { ok: false, output: `typecheck failed:\n${tsc.stdout}${tsc.stderr}` };
    const tests = await run(process.execPath, ['--test', 'test/**/*.test.ts'], root);
    const output = `${tests.stdout}${tests.stderr}`;
    return { ok: tests.code === 0, output: tests.code === 0 ? output.split('\n').slice(-12).join('\n') : output };
}

const SYSTEM = `You are modifying Project Io — the app you are running inside. The user asked for a change through the app's own UI.

Work like a careful engineer on a small TypeScript codebase: read CLAUDE.md and the files you will touch first, make the smallest change that does the job, match the surrounding style, and add or update tests under test/ when behaviour changes. Call run_checks before finishing and fix whatever it reports.

When you are done, call finish with a Conventional Commits message (type(scope): imperative summary, then a body saying why), then end your turn with a two-to-four sentence summary for the user.

Some paths are protected (the supervisor, the path guard, .git, .env, node_modules); a tool error will tell you. Do not try to work around that — tell the user instead. The server restarts after your commit, so a change that breaks startup is reverted only by hand: keep the server entry point working.`;

let running = false;

export async function selfEdit(root: string, request: string, onEvent: (e: SelfEditEvent) => void, signal?: AbortSignal) {
    if (running) throw new Error('A self-edit is already running.');
    if (!(await isClean(root))) throw new Error('The working tree has uncommitted changes. Commit or stash them first.');
    running = true;
    let commitMessage: string | null = null;

    const tools = [
        defineTool({
            name: 'list_files',
            description: 'List every tracked and untracked (non-ignored) file in the project.',
            inputSchema: { type: 'object', properties: {} },
            schema: z.object({}),
            run: async () => (await listFiles(root)).join('\n'),
        }),
        defineTool({
            name: 'read_file',
            description: 'Read a project file. Paths are relative to the project root.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            schema: z.object({ path: z.string().min(1) }),
            run: ({ path: p }) => readFile(resolveReadablePath(root, p), 'utf8'),
        }),
        defineTool({
            name: 'write_file',
            description: 'Create or overwrite a whole file. Prefer edit_file for changes to existing files.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
            },
            schema: z.object({ path: z.string().min(1), content: z.string() }),
            run: async ({ path: p, content }) => {
                const target = resolveEditablePath(root, p);
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, content);
                return `Wrote ${p}`;
            },
        }),
        defineTool({
            name: 'edit_file',
            description: 'Replace one exact, unique occurrence of old_string with new_string in a file.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
                required: ['path', 'old_string', 'new_string'],
            },
            schema: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
            run: async ({ path: p, old_string, new_string }) => {
                const target = resolveEditablePath(root, p);
                const text = await readFile(target, 'utf8');
                const count = text.split(old_string).length - 1;
                if (count !== 1) throw new Error(`old_string occurs ${count} times in ${p}; it must occur exactly once.`);
                await writeFile(target, text.replace(old_string, () => new_string));
                return `Edited ${p}`;
            },
        }),
        defineTool({
            name: 'delete_file',
            description: 'Delete a project file.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            schema: z.object({ path: z.string().min(1) }),
            run: async ({ path: p }) => {
                await rm(resolveEditablePath(root, p));
                return `Deleted ${p}`;
            },
        }),
        defineTool({
            name: 'run_checks',
            description: 'Run the typecheck and the test suite. Returns the failures, or a short pass summary.',
            inputSchema: { type: 'object', properties: {} },
            schema: z.object({}),
            run: async () => {
                const result = await runChecks(root);
                onEvent({ type: 'checks', ...result });
                return `${result.ok ? 'PASS' : 'FAIL'}\n${result.output}`;
            },
        }),
        defineTool({
            name: 'finish',
            description: 'Record the commit message for your change. Call once, after run_checks passes.',
            inputSchema: { type: 'object', properties: { commit_message: { type: 'string' } }, required: ['commit_message'] },
            schema: z.object({ commit_message: z.string().min(1) }),
            run: async ({ commit_message }) => {
                commitMessage = commit_message;
                return 'Recorded. End your turn with a short summary for the user.';
            },
        }),
    ];

    try {
        const final = await runToolLoop({
            system: SYSTEM,
            prompt: `Change requested by the user:\n\n${request}`,
            tools,
            effort: 'xhigh',
            maxTurns: 60,
            onEvent,
            signal,
        });

        const files = await changedFiles(root);
        if (files.length === 0) return { committed: false, summary: finalText(final) };

        const checks = await runChecks(root);
        onEvent({ type: 'checks', ...checks });
        if (!checks.ok || !commitMessage) {
            const reason = !checks.ok ? 'checks failed after the agent finished' : 'the agent did not call finish';
            await discardAll(root);
            onEvent({ type: 'discarded', reason });
            return { committed: false, summary: finalText(final) };
        }

        const message = `${commitMessage}\n\nRequested in Io: ${request}\n\n${SELF_EDIT_TRAILER}`;
        const sha = await commitAll(root, message);
        onEvent({ type: 'committed', sha, message: commitMessage, files });
        return { committed: true, summary: finalText(final) };
    } catch (err) {
        if ((await changedFiles(root)).length) {
            await discardAll(root);
            onEvent({ type: 'discarded', reason: err instanceof Error ? err.message : String(err) });
        }
        throw err;
    } finally {
        running = false;
    }
}
