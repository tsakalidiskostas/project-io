import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelChoice } from './model-choice.ts';
import { ensureIoProfile, ioSessionEnv } from './profile.ts';

export type LoopEvent =
    | ({ type: 'model' } & ModelChoice)
    | { type: 'session'; auth: string; mcpServers: { name: string; status: string }[] }
    | { type: 'text'; delta: string }
    | { type: 'tool'; name: string; input: unknown };

export interface AgentRun {
    prompt: string;
    choice: ModelChoice;
    options: Omit<Options, 'model' | 'effort'>;
    onEvent(event: LoopEvent): void;
    signal?: AbortSignal;
}

export interface AgentResult {
    text: string;
    structured: unknown;
}

// Io never calls the Claude API itself: the Agent SDK spawns the Claude Code CLI as a subprocess and
// streams its output. The session runs in Io's own profile, so its login and MCP servers are Io's.
export async function runAgent({ prompt, choice, options, onEvent, signal }: AgentRun): Promise<AgentResult> {
    onEvent({ type: 'model', ...choice });
    const abortController = new AbortController();
    signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const messages = query({
        prompt,
        options: {
            model: choice.model,
            effort: choice.effort,
            includePartialMessages: true,
            persistSession: false,
            abortController,
            env: { ...ioSessionEnv(ensureIoProfile()), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
            ...options,
        },
    });

    for await (const message of messages) {
        const result = handle(message, onEvent);
        if (result !== undefined) return result;
    }
    throw new Error('Claude Code exited without a result.');
}

function handle(message: SDKMessage, onEvent: (e: LoopEvent) => void): AgentResult | undefined {
    if (message.type === 'system' && message.subtype === 'init') {
        onEvent({
            type: 'session',
            auth: message.apiKeySource === 'none' ? 'Claude login' : message.apiKeySource,
            mcpServers: message.mcp_servers.map(s => ({ name: s.name, status: s.status })),
        });
    } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const e = message.event;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') onEvent({ type: 'text', delta: e.delta.text });
    } else if (message.type === 'assistant') {
        if (message.error === 'authentication_failed') {
            throw new Error("Io's Claude profile is not signed in. Run `npm run claude -- auth login` in Io's folder, then try again.");
        }
        for (const block of message.message.content) {
            if (block.type === 'tool_use' && message.parent_tool_use_id === null) {
                onEvent({ type: 'tool', name: block.name, input: block.input });
            }
        }
    } else if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
            const detail = message.subtype === 'success' ? message.result : message.errors.join('; ') || message.subtype;
            throw new Error(`Claude stopped: ${detail}`);
        }
        return { text: message.result, structured: message.structured_output };
    }
    return undefined;
}

// Strips the `mcp__<server>__` prefix so tool names read naturally in the UI and in policy checks.
export function bareToolName(name: string): string {
    return name.replace(/^mcp__.+?__/, '');
}

// Explanations may use the user's own MCP servers, but only to look things up. Judged by name
// because a permission callback does not see the server's readOnly annotation.
export function isReadOnlyToolName(name: string): boolean {
    return /^(get|list|search|read|query|fetch|find|view|describe|retrieve|lookup)/i.test(bareToolName(name));
}
