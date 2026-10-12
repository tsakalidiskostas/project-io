import os from 'node:os';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ensureIoProfile, ioSessionEnv } from './profile.ts';

interface Window {
    utilization: number | null;
    resets_at: string | null;
}

interface RawUsage {
    subscription_type: string | null;
    rate_limits_available: boolean;
    rate_limits: { five_hour?: Window | null; seven_day?: Window | null } | null;
}

export type UsageSummary =
    | { available: false }
    | {
          available: true;
          plan: string | null;
          session: { percent: number; resetsAt: string | null };
          week: { percent: number; resetsAt: string | null } | null;
      };

const toWindow = (w: Window | null | undefined) =>
    w && w.utilization !== null ? { percent: Math.round(Math.min(100, Math.max(0, w.utilization))), resetsAt: w.resets_at } : null;

export function summariseUsage(raw: RawUsage): UsageSummary {
    const session = raw.rate_limits_available ? toWindow(raw.rate_limits?.five_hour) : null;
    if (!session) return { available: false };
    return { available: true, plan: raw.subscription_type, session, week: toWindow(raw.rate_limits?.seven_day) };
}

const CACHE_MS = 60_000;
let cached: { at: number; value: Promise<UsageSummary> } | null = null;

// Reads the plan's rate-limit windows through a Claude Code session that is never sent a prompt,
// so no model turn runs. The SDK marks this API experimental; any failure just hides the meter.
async function fetchUsage(): Promise<UsageSummary> {
    let close!: () => void;
    const closed = new Promise<void>(resolve => (close = resolve));
    async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
        await closed;
    }
    const abortController = new AbortController();
    const session = query({
        prompt: noPrompt(),
        options: {
            cwd: os.tmpdir(),
            persistSession: false,
            settingSources: [],
            tools: [],
            strictMcpConfig: true,
            abortController,
            env: ioSessionEnv(ensureIoProfile()),
        },
    });
    const drain = (async () => {
        try {
            for await (const _ of session);
        } catch {
            // ends with an abort when we close it below
        }
    })();
    try {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('usage timed out')), 15_000));
        const raw = await Promise.race([session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeout]);
        return summariseUsage(raw as RawUsage);
    } finally {
        close();
        abortController.abort();
        await drain;
    }
}

export function planUsage({ fresh = false } = {}): Promise<UsageSummary> {
    if (fresh || !cached || Date.now() - cached.at > CACHE_MS) {
        const value = fetchUsage().catch((): UsageSummary => ({ available: false }));
        cached = { at: Date.now(), value };
    }
    return cached.value;
}
