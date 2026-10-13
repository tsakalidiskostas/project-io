import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

// What one Claude Code session cost, summed over every model it touched (Claude Code also makes
// small internal calls on a helper model). costUsd is the SDK's estimate, not a bill: under a
// claude.ai plan it is a proxy for how much of the session limit a run used.
export interface SessionStats {
    durationMs: number;
    turns: number;
    costUsd: number;
    input: number;
    output: number;
    thinking: number;
    cacheRead: number;
    cacheWrite: number;
    models: string[];
}

export function sessionStats(result: { duration_ms: number; num_turns: number; total_cost_usd: number; modelUsage: Record<string, ModelUsage> }): SessionStats {
    const usage = Object.values(result.modelUsage);
    const sum = (pick: (u: ModelUsage) => number | undefined) => usage.reduce((n, u) => n + (pick(u) ?? 0), 0);
    return {
        durationMs: result.duration_ms,
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        input: sum(u => u.inputTokens),
        output: sum(u => u.outputTokens),
        thinking: sum(u => u.thinkingTokens),
        cacheRead: sum(u => u.cacheReadInputTokens),
        cacheWrite: sum(u => u.cacheCreationInputTokens),
        models: Object.keys(result.modelUsage),
    };
}

export function combineStats(all: SessionStats[]): SessionStats {
    const sum = (pick: (s: SessionStats) => number) => all.reduce((n, s) => n + pick(s), 0);
    return {
        durationMs: sum(s => s.durationMs),
        turns: sum(s => s.turns),
        costUsd: Math.round(sum(s => s.costUsd) * 1e6) / 1e6,
        input: sum(s => s.input),
        output: sum(s => s.output),
        thinking: sum(s => s.thinking),
        cacheRead: sum(s => s.cacheRead),
        cacheWrite: sum(s => s.cacheWrite),
        models: [...new Set(all.flatMap(s => s.models))],
    };
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const duration = (ms: number) => {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

export function describeStats(s: SessionStats): string {
    const read = s.input + s.cacheRead + s.cacheWrite;
    const cached = read ? Math.round((s.cacheRead / read) * 100) : 0;
    return `${duration(s.durationMs)} · ${s.turns} turns · ~$${s.costUsd.toFixed(2)} · ${tokens(read)} tokens read (${cached}% cached) · ${tokens(s.output)} written`;
}
