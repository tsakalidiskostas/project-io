import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

export const MODEL = 'claude-opus-5-5';

const client = new Anthropic();

export interface LoopTool<S extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    inputSchema: Anthropic.Beta.BetaTool.InputSchema;
    schema: S;
    run(input: z.infer<S>): Promise<string>;
}

export type LoopEvent =
    | { type: 'text'; delta: string }
    | { type: 'tool'; name: string; input: unknown }
    | { type: 'tool_error'; name: string; error: string };

export interface LoopOptions {
    system: string;
    prompt: string;
    tools: LoopTool[];
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTurns: number;
    onEvent(event: LoopEvent): void;
    signal?: AbortSignal;
}

export async function runToolLoop(opts: LoopOptions): Promise<Anthropic.Beta.BetaMessage> {
    const tools: Anthropic.Beta.BetaTool[] = opts.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        eager_input_streaming: true,
    }));
    const byName = new Map(opts.tools.map(t => [t.name, t]));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opts.prompt }];
    let jsonRetries = 0;

    for (let turn = 0; turn < opts.maxTurns; turn++) {
        const stream = client.beta.messages.stream(
            {
                model: MODEL,
                max_tokens: 64000,
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
                cache_control: { type: 'ephemeral' },
                output_config: { effort: opts.effort },
                system: opts.system,
                tools,
                messages,
            },
            { signal: opts.signal },
        );
        stream.on('text', delta => opts.onEvent({ type: 'text', delta }));

        let message: Anthropic.Beta.BetaMessage;
        try {
            message = await stream.finalMessage();
            jsonRetries = 0;
        } catch (err) {
            // With eager input streaming an unparseable tool input rejects here; retry only that.
            if (err instanceof Anthropic.APIError || opts.signal?.aborted || jsonRetries++ >= 2) throw err;
            continue;
        }

        if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.');
        if (message.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: message.content });
            continue;
        }
        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) return message;
        if (message.stop_reason === 'max_tokens') throw new Error('A tool call was cut off at max_tokens.');

        messages.push({ role: 'assistant', content: message.content });
        const results = await Promise.all(toolUses.map(use => execute(byName.get(use.name), use, opts.onEvent)));
        messages.push({ role: 'user', content: results });
    }
    throw new Error(`Stopped after ${opts.maxTurns} turns without finishing.`);
}

async function execute(
    tool: LoopTool | undefined,
    use: Anthropic.Beta.BetaToolUseBlock,
    onEvent: LoopOptions['onEvent'],
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const fail = (error: string): Anthropic.Beta.BetaToolResultBlockParam => {
        onEvent({ type: 'tool_error', name: use.name, error });
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: error };
    };
    if (!tool) return fail(`Unknown tool: ${use.name}`);
    const parsed = tool.schema.safeParse(use.input);
    if (!parsed.success) return fail(`INVALID_INPUT: ${parsed.error.message}`);
    onEvent({ type: 'tool', name: use.name, input: parsed.data });
    try {
        return { type: 'tool_result', tool_use_id: use.id, content: await tool.run(parsed.data) };
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}

export function finalText(message: Anthropic.Beta.BetaMessage): string {
    return message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
}

export function defineTool<S extends z.ZodType>(tool: LoopTool<S>): LoopTool {
    return tool as unknown as LoopTool;
}
