import { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// The aliases Io's bundled Claude Code resolves lag behind: "sonnet" gives Sonnet 5 and "haiku"
// Haiku 4.5. Sessions are sent these explicit ids instead; settings and the UI keep the short names.
export const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } as const;

export interface ModelChoice {
    model: 'haiku' | 'sonnet' | 'opus';
    effort: Effort;
    reason: string;
}

const DOCS = /\.(md|mdx|txt|rst|adoc)$/i;

// Cheapest model that still produces a trustworthy report. The thresholds are a first guess,
// to be tuned against real PRs.
export function chooseExplainModel({ diffChars, files }: { diffChars: number; files: string[] }): ModelChoice {
    if (files.length > 0 && files.every(f => DOCS.test(f)) && diffChars <= 50_000) {
        return { model: 'haiku', effort: 'low', reason: 'documentation-only change' };
    }
    if (diffChars <= 20_000 && files.length <= 8) {
        return { model: 'sonnet', effort: 'medium', reason: `small change (${files.length} files, ${kb(diffChars)})` };
    }
    if (diffChars <= 200_000) {
        return { model: 'opus', effort: 'medium', reason: `${files.length} files, ${kb(diffChars)}: needs cross-file reasoning` };
    }
    return { model: 'opus', effort: 'high', reason: `large change (${files.length} files, ${kb(diffChars)})` };
}

// Self-edits rewrite the running app, and a wrong edit costs more than the tokens saved by a smaller model.
export const SELF_EDIT_MODEL: ModelChoice = { model: 'opus', effort: 'high', reason: 'editing Io itself' };

const kb = (chars: number) => `${Math.round(chars / 1000)}k chars of diff`;

// Extracting claims reads a description and an issue, never code: Sonnet at low effort is plenty.
export const INTENT_MODEL: ModelChoice = { model: 'sonnet', effort: 'low', reason: 'extracting claims from the issue and description' };

// Rewriting a review comment is a short, low-stakes edit.
export const REWRITE_MODEL: ModelChoice = { model: 'haiku', effort: 'low', reason: 'rewriting a comment' };

// Per-operation overrides chosen in Settings; 'auto' keeps the choice above.
export const OPERATIONS = ['intent', 'verify', 'flow', 'comments', 'selfEdit', 'rewrite'] as const;
export type Operation = (typeof OPERATIONS)[number];

const Override = z.object({
    model: z.enum(['auto', 'haiku', 'sonnet', 'opus']),
    effort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
});
export const ModelSettings = z.strictObject(Object.fromEntries(OPERATIONS.map(op => [op, Override])) as Record<Operation, typeof Override>);
export type ModelSettings = z.infer<typeof ModelSettings>;

export const DEFAULT_MODEL_SETTINGS: ModelSettings = Object.fromEntries(
    OPERATIONS.map(op => [op, { model: 'auto', effort: 'auto' }]),
) as ModelSettings;

export function resolveChoice(auto: ModelChoice, override: z.infer<typeof Override>): ModelChoice {
    if (override.model === 'auto' && override.effort === 'auto') return auto;
    return {
        model: override.model === 'auto' ? auto.model : override.model,
        effort: override.effort === 'auto' ? auto.effort : override.effort,
        reason: 'set in Settings',
    };
}

// "claude-sonnet-5-5" → "Sonnet 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "sonnet" → "Sonnet".
export function modelDisplayName(id: string): string {
    const m = id.match(/^(?:claude-)?(haiku|sonnet|opus|fable|mythos)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?$/);
    if (!m) return id;
    const family = m[1][0].toUpperCase() + m[1].slice(1);
    return [family, m[2] && (m[3] ? `${m[2]}.${m[3]}` : m[2])].filter(Boolean).join(' ');
}

export function describeRun(info: { intent: { model: string; effort: string }; verify: { model: string; effort: string } }): string {
    const part = (p: { model: string; effort: string }) => `${modelDisplayName(p.model)} ${p.effort}`;
    return `extracted claims with ${part(info.intent)}, claims vs code with ${part(info.verify)}`;
}

// Drafting comments from findings already made needs no code reading: Sonnet at low effort.
export const COMMENTS_MODEL: ModelChoice = { model: 'sonnet', effort: 'low', reason: 'drafting comments from the findings' };
