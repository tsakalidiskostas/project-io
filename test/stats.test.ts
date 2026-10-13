import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineStats, describeStats, sessionStats } from '../src/stats.ts';

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, thinking?: number) => ({
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    webSearchRequests: 0,
    costUSD: cost,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
});

test('sums a session across the models it used', () => {
    const s = sessionStats({ duration_ms: 90_000, num_turns: 7, total_cost_usd: 1.25, modelUsage: { 'claude-opus-5-5': usage(1000, 4000, 50_000, 8000, 1.2, 1500), 'claude-haiku-4-5': usage(200, 30, 0, 0, 0.05) } });
    assert.deepEqual(s, { durationMs: 90_000, turns: 7, costUsd: 1.25, input: 1200, output: 4030, thinking: 1500, cacheRead: 50_000, cacheWrite: 8000, models: ['claude-opus-5-5', 'claude-haiku-4-5'] });
});

test('combines phases into one run total', () => {
    const a = sessionStats({ duration_ms: 10_000, num_turns: 2, total_cost_usd: 0.1, modelUsage: { m: usage(10, 20, 30, 40, 0.1) } });
    const b = sessionStats({ duration_ms: 50_000, num_turns: 5, total_cost_usd: 0.4, modelUsage: { n: usage(1, 2, 3, 4, 0.4) } });
    assert.deepEqual(combineStats([a, b]), { durationMs: 60_000, turns: 7, costUsd: 0.5, input: 11, output: 22, thinking: 0, cacheRead: 33, cacheWrite: 44, models: ['m', 'n'] });
});

test('describes a run in one readable line', () => {
    const s = { durationMs: 372_000, turns: 38, costUsd: 1.84, input: 12_000, output: 21_400, thinking: 0, cacheRead: 1_150_000, cacheWrite: 60_000, models: [] };
    assert.equal(describeStats(s), '6m 12s · 38 turns · ~$1.84 · 1.22M tokens read (94% cached) · 21.4k written');
});
