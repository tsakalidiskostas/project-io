import { z } from 'zod';
import { defineTool, runToolLoop, type LoopEvent } from './agent-loop.ts';
import { fetchPullRequest, readRepoFile, searchRepoCode, type PrRef, type PullRequest } from './github.ts';
import { extractIssueKey, fetchLinearIssue, type LinearIssue } from './linear.ts';

// Roughly 150k tokens of diff. Past that the model reads the rest through read_file instead.
const DIFF_BUDGET_CHARS = 600_000;

export function budgetDiff(diff: string, maxChars: number): { text: string; omittedFiles: string[] } {
    if (diff.length <= maxChars) return { text: diff, omittedFiles: [] };
    const chunks = diff.split(/^(?=diff --git )/m).map(text => ({
        text,
        name: text.match(/^diff --git a\/(\S+)/)?.[1] ?? '(unknown)',
    }));
    const dropped = new Set<string>();
    let size = diff.length;
    for (const chunk of [...chunks].sort((a, b) => b.text.length - a.text.length)) {
        if (size <= maxChars) break;
        dropped.add(chunk.name);
        size -= chunk.text.length;
    }
    return {
        text: chunks.filter(c => !dropped.has(c.name)).map(c => c.text).join(''),
        omittedFiles: chunks.filter(c => dropped.has(c.name)).map(c => c.name),
    };
}

const SYSTEM = `You are Io, a reviewer's companion. You explain a GitHub pull request to an engineer who has to understand it — often a reviewer, sometimes the author months later.

You get the PR metadata, its commits, its diff, and — when the branch names one — the Linear issue it implements. You can read any file at the base or head commit and search the repository. Use them: a diff shows lines, not the flow they sit in, so read the callers and the surrounding code before you describe how behaviour changed. Do not write anything until you have finished investigating; your whole text output is the report.

Write the report in Markdown with exactly these sections:

## In one paragraph
What the PR does and why, for someone who will read nothing else.

## Why these changes
Group the changes by intent, not by file. For each group, the motivation — cite the issue, the PR text or a commit message when they state it, and say plainly when you are inferring it.

## Intended vs delivered
A table with columns: Goal | Status | Evidence. Goals come from the Linear issue's acceptance criteria when present, otherwise from the issue description, PR description and commits. Status is one of ✅ Done, 🟡 Partial, ❌ Missing, ❔ Can't tell. Evidence names files and functions.

## What is missing or at risk
Gaps against the stated goal, behaviour the PR changes that nobody asked for, untested paths, and anything a reviewer should check by hand. Say "nothing found" if so — do not invent issues.

## How the app flow changed
One or two Mermaid diagrams (\`\`\`mermaid fences) showing the affected flow before and after — sequence or flowchart, whichever fits. Keep node labels short and quote any label containing punctuation. Follow each diagram with two or three sentences on what a user or caller now experiences differently.

## Questions for the author
Only questions whose answer would change your assessment.

Be concrete and brief. Name real identifiers. When the PR text and the code disagree, say so — that is the most valuable thing you can find.`;

function describeIssue(issue: LinearIssue): string {
    const parent = issue.parent
        ? `\n\nParent issue ${issue.parent.identifier} — ${issue.parent.title}\n${issue.parent.description}`
        : '';
    const comments = issue.comments.length ? `\n\nComments:\n${issue.comments.map(c => `- ${c}`).join('\n')}` : '';
    return `Linear issue ${issue.identifier} — ${issue.title}\n${issue.url}\n\n${issue.description}${parent}${comments}`;
}

function buildPrompt(pr: PullRequest, issue: LinearIssue | null, issueNote: string): string {
    const { text: diff, omittedFiles } = budgetDiff(pr.diff, DIFF_BUDGET_CHARS);
    const omitted = omittedFiles.length
        ? `\n\nThese files were left out of the diff below to fit the budget; read them with read_file if they matter:\n${omittedFiles.join('\n')}`
        : '';
    return `<pull_request>
${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} — ${pr.title}
Author: ${pr.author} · State: ${pr.state}
${pr.headRefName} (${pr.headRefOid.slice(0, 7)}) → ${pr.baseRefName} (${pr.baseRefOid.slice(0, 7)})

${pr.body || '(no description)'}
</pull_request>

<intent_source>
${issue ? describeIssue(issue) : issueNote}
</intent_source>

<commits>
${pr.commits.map(c => `- ${c.messageHeadline}${c.messageBody ? `\n  ${c.messageBody.replaceAll('\n', '\n  ')}` : ''}`).join('\n')}
</commits>

<files_changed>
${pr.files.map(f => `${f.path} (+${f.additions} −${f.deletions})`).join('\n')}${omitted}
</files_changed>

<diff>
${diff}
</diff>

Explain this pull request.`;
}

function prTools(pr: PullRequest) {
    const shaFor = (side: 'base' | 'head') => (side === 'base' ? pr.baseRefOid : pr.headRefOid);
    return [
        defineTool({
            name: 'read_file',
            description: 'Read a file from the repository at the PR base (before) or head (after) commit.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, side: { type: 'string', enum: ['base', 'head'] } },
                required: ['path', 'side'],
            },
            schema: z.object({ path: z.string().min(1), side: z.enum(['base', 'head']) }),
            run: ({ path, side }) => readRepoFile(pr.ref, shaFor(side), path),
        }),
        defineTool({
            name: 'search_code',
            description:
                'GitHub code search within this repository (default branch only). Use it to find callers and usages, e.g. "logoutWithClientId".',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            schema: z.object({ query: z.string().min(1) }),
            run: ({ query }) => searchRepoCode(pr.ref, query),
        }),
    ];
}

export type ExplainEvent = LoopEvent | { type: 'context'; title: string; issue: string | null; omittedFiles: string[] };

export async function explainPullRequest(ref: PrRef, onEvent: (e: ExplainEvent) => void, signal?: AbortSignal) {
    const pr = await fetchPullRequest(ref);
    const key = extractIssueKey(pr.headRefName);
    const issue = key ? await fetchLinearIssue(key) : null;
    const issueNote = !key
        ? 'The branch names no Linear issue. Infer intent from the PR description and commits.'
        : `The branch names ${key}, but it could not be loaded${process.env.LINEAR_API_KEY ? '' : ' (LINEAR_API_KEY is not set)'}. Infer intent from the PR description and commits, and say so.`;

    onEvent({
        type: 'context',
        title: `${ref.owner}/${ref.repo}#${ref.number} — ${pr.title}`,
        issue: issue ? `${issue.identifier} — ${issue.title}` : null,
        omittedFiles: budgetDiff(pr.diff, DIFF_BUDGET_CHARS).omittedFiles,
    });

    await runToolLoop({
        system: SYSTEM,
        prompt: buildPrompt(pr, issue, issueNote),
        tools: prTools(pr),
        effort: 'high',
        maxTurns: 40,
        onEvent,
        signal,
    });
}
