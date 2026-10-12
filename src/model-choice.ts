export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Aliases, not model IDs: the Claude Code CLI resolves them to the current generation.
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
