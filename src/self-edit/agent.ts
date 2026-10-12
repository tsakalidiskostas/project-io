import path from 'node:path';
import { createSdkMcpServer, tool, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runAgent, type LoopEvent } from '../agent-loop.ts';
import { SELF_EDIT_MODEL } from '../model-choice.ts';
import { run } from '../run.ts';
import { GuardError, resolveEditablePath, resolveReadablePath } from './guard.ts';
import { changedFiles, commitAll, discardAll, isClean, SELF_EDIT_TRAILER } from './git.ts';

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

const INSTRUCTIONS = `You are modifying Project Io — the app you are running inside. The user asked for a change through the app's own UI.

Make the smallest change that does the job, match the surrounding style, and add or update tests under test/ when behaviour changes. Run \`npm run check\` before finishing and fix whatever it reports.

When you are done, call the finish tool with a Conventional Commits message (type(scope): imperative summary, then a body saying why), then end with a two-to-four sentence summary for the user.

Some paths are protected (the supervisor, the path guard, .git, .env, node_modules); a tool denial will tell you. Do not work around that — tell the user instead. The server restarts after your commit, so keep its entry point working.`;

const FILE_TOOLS: Record<string, 'read' | 'write'> = {
    Read: 'read',
    Glob: 'read',
    Grep: 'read',
    Edit: 'write',
    Write: 'write',
    NotebookEdit: 'write',
};

// Runs on every tool call, whatever permission rules are loaded, so it is the one place the
// path guard is enforced.
function guardHook(root: string): HookCallback {
    return async input => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const access = FILE_TOOLS[input.tool_name];
        const target = (input.tool_input as { file_path?: string; notebook_path?: string; path?: string }) ?? {};
        const requested = target.file_path ?? target.notebook_path ?? target.path;
        if (!access || !requested) return {};
        const relative = path.relative(root, path.resolve(root, requested));
        if (relative === '' && access === 'read') return {};
        try {
            (access === 'write' ? resolveEditablePath : resolveReadablePath)(root, relative || '.');
            return {};
        } catch (err) {
            if (!(err instanceof GuardError)) throw err;
            return {
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: err.message },
            };
        }
    };
}

let running = false;

export async function selfEdit(root: string, request: string, onEvent: (e: SelfEditEvent) => void, signal?: AbortSignal) {
    if (running) throw new Error('A self-edit is already running.');
    if (!(await isClean(root))) throw new Error('The working tree has uncommitted changes. Commit or stash them first.');
    running = true;
    let commitMessage: string | null = null;

    const io = createSdkMcpServer({
        name: 'io',
        alwaysLoad: true,
        tools: [
            tool(
                'finish',
                'Record the commit message for your change. Call once, after `npm run check` passes.',
                { commit_message: z.string().min(1) },
                async ({ commit_message }) => {
                    commitMessage = commit_message;
                    return { content: [{ type: 'text', text: 'Recorded. End your turn with a short summary for the user.' }] };
                },
            ),
        ],
    });

    try {
        const summary = await runAgent({
            prompt: `Change requested by the user:\n\n${request}`,
            choice: SELF_EDIT_MODEL,
            options: {
                cwd: root,
                systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
                settingSources: ['project'],
                strictMcpConfig: true,
                mcpServers: { io },
                tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
                allowedTools: [
                    'Read',
                    'Glob',
                    'Grep',
                    'Edit',
                    'Write',
                    'mcp__io__finish',
                    'Bash(npm run check)',
                    'Bash(npm test)',
                    'Bash(npm run typecheck)',
                    'Bash(git status)',
                    'Bash(git diff:*)',
                ],
                permissionMode: 'dontAsk',
                hooks: { PreToolUse: [{ hooks: [guardHook(root)] }] },
                maxTurns: 80,
            },
            onEvent,
            signal,
        });

        const files = await changedFiles(root);
        if (files.length === 0) return { committed: false, summary };

        const checks = await runChecks(root);
        onEvent({ type: 'checks', ...checks });
        if (!checks.ok || !commitMessage) {
            const reason = !checks.ok ? 'checks failed after the agent finished' : 'the agent did not call finish';
            await discardAll(root);
            onEvent({ type: 'discarded', reason });
            return { committed: false, summary };
        }

        const message = `${commitMessage}\n\nRequested in Io: ${request}\n\n${SELF_EDIT_TRAILER}`;
        const sha = await commitAll(root, message);
        onEvent({ type: 'committed', sha, message: commitMessage, files });
        return { committed: true, summary };
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
