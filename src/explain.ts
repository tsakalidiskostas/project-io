import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isReadOnlyToolName, runAgent, type LoopEvent } from './agent-loop.ts';
import { chooseExplainModel } from './model-choice.ts';
import { fetchPullRequest, readRepoFile, searchRepoCode, type PrRef, type PullRequest } from './github.ts';
import { extractIssueKey } from './linear.ts';

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

You get the PR metadata, its commits and its diff. You can read any file at the base or head commit and search the repository, and you may have the user's own tools for issue trackers such as Linear. When the branch names an issue and you have a tool that can load it, load it — and its parent — before judging intent; its acceptance criteria are the yardstick. Use your tools: a diff shows lines, not the flow they sit in, so read the callers and the surrounding code before you describe how behaviour changed. Do not write anything until you have finished investigating; your whole text output is the report.

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

function buildPrompt(pr: PullRequest, issueKey: string | null): string {
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
${
    issueKey
        ? `The branch names issue ${issueKey}. Load it with your issue-tracker tools if you have them; if you cannot, say the intent comes from the PR text alone.`
        : 'The branch names no issue. Infer intent from the PR description and commits.'
}
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


const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function prToolServer(pr: PullRequest) {
    const shaFor = (side: 'base' | 'head') => (side === 'base' ? pr.baseRefOid : pr.headRefOid);
    return createSdkMcpServer({
        name: 'io',
        alwaysLoad: true,
        tools: [
            tool(
                'read_file',
                'Read a file from the repository at the PR base (before) or head (after) commit.',
                { path: z.string().min(1), side: z.enum(['base', 'head']) },
                async ({ path: p, side }) => text(await readRepoFile(pr.ref, shaFor(side), p)),
            ),
            tool(
                'search_code',
                'GitHub code search within this repository (default branch only). Use it to find callers and usages.',
                { query: z.string().min(1) },
                async ({ query }) => text(await searchRepoCode(pr.ref, query)),
            ),
        ],
    });
}

// Io's own tools always run; the user's MCP tools may look things up but never change anything.
const readOnly: CanUseTool = async (name, input) =>
    name.startsWith('mcp__io__') || (name.startsWith('mcp__') && isReadOnlyToolName(name))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Io is read-only while explaining a pull request.' };

export type ExplainEvent = LoopEvent | { type: 'context'; title: string; issue: string | null; omittedFiles: string[] };

export async function explainPullRequest(ref: PrRef, onEvent: (e: ExplainEvent) => void, signal?: AbortSignal) {
    const pr = await fetchPullRequest(ref);
    const issueKey = extractIssueKey(pr.headRefName);
    onEvent({
        type: 'context',
        title: `${ref.owner}/${ref.repo}#${ref.number} — ${pr.title}`,
        issue: issueKey,
        omittedFiles: budgetDiff(pr.diff, DIFF_BUDGET_CHARS).omittedFiles,
    });

    // An empty scratch directory, so nothing Claude Code loads from its working directory leaks in.
    const cwd = path.join(os.tmpdir(), 'project-io-explain');
    await mkdir(cwd, { recursive: true });

    await runAgent({
        prompt: buildPrompt(pr, issueKey),
        choice: chooseExplainModel({ diffChars: pr.diff.length, files: pr.files.map(f => f.path) }),
        options: {
            cwd,
            systemPrompt: SYSTEM,
            settingSources: [],
            tools: [],
            mcpServers: { io: prToolServer(pr) },
            canUseTool: readOnly,
            maxTurns: 40,
        },
        onEvent,
        signal,
    });
}
