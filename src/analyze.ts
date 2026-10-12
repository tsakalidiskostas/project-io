import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isReadOnlyToolName, runAgent, type LoopEvent } from './agent-loop.ts';
import { addedLinesByFile, buildExcerpt, IntentOutput, toOutputSchema, issueKeyFromLinearUrl, VerifyOutput, type Analysis } from './analysis.ts';
import { fetchPullRequest, findPrsForIssue, parsePrRef, readRepoFile, searchRepoCode, type PrRef, type PullRequest } from './github.ts';
import { extractIssueKey } from './linear.ts';
import { chooseExplainModel, INTENT_MODEL, resolveChoice } from './model-choice.ts';
import { analysisId, defaultStore } from './store.ts';

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

const INTENT_SYSTEM = `You extract what a pull request set out to do, before anyone reads its code. You get the PR title and description and, when the branch names one, an issue key. If you have issue-tracker tools such as Linear, load that issue and its parent; the issue's acceptance criteria are the yardstick. You have no code tools on purpose: claims come from the sources alone.

Return:
- issue: the loaded issue's key, title and URL; empty strings if none could be loaded.
- sources: the issue (kind "linear", criteria = its acceptance criteria verbatim and in order, text = its description only when it has no criteria) and the PR description (kind "github", ref "PR description", text verbatim).
- claims: every checkable statement of intended behaviour, ids C1, C2, … A claim is something code can be checked against ("Retries back off exponentially"), not an aim ("Improve reliability"). Merge a claim that appears in both sources and cite both, e.g. ["FRNT-3057 #2", "PR description"]. Skip process items (tests written, reviewed) unless they are acceptance criteria.`;

const VERIFY_SYSTEM = `You check a pull request against claims that were extracted from its issue and description before the diff was read. You get the claims, the PR metadata, its commits and its diff, and you can read any file at the base or head commit and search the repository. A diff shows lines, not the flow they sit in: read callers and surrounding code before you judge.

For every claim, same id and order:
- verdict: delivered (the code does what the claim says), partial (some of it, or with a gap that changes behaviour), missing (no code does it), unverifiable (code alone cannot settle it).
- codeDoes: one short paragraph on what the code actually does, naming real identifiers.
- evidence: head-side file and line ranges that support the verdict.
- excerpt: 10–40 head-side lines that best show it — for a missing claim, where the behaviour would naturally go — with one to three annotations, each tied to specific lines and comparing the code with the claim in a sentence. Line numbers must be real head-side numbers: read the file to get them.
- comment: for partial or missing, kind "request_changes" with a review comment the author can act on, anchored to a line inside the diff where possible. For delivered, kind "comment" only if something is worth saying; otherwise kind "none", empty body, path "" and line 0.

unclaimed: changes in the diff that no claim explains and a reviewer should know about — behaviour, not formatting or renames — each pointing at a head-side line.
verdict.summary: one or two plain sentences a reviewer reads first.
flow: the behaviour after this PR as a small graph of 5–14 nodes, built from the code rather than the description: start/end, steps, decisions. Set claimId on nodes that fulfil a claim, and add a node where each missing claim's step would sit, with its claimId, so the gap shows. Put unclaimedNote on the node an unclaimed change touches. Edge labels are "yes"/"no" or short conditions; an edge note marks where partial behaviour goes wrong. flow.before: two or three sentences on how it worked before.

Be concrete and brief. When the code and a claim disagree, say exactly how.`;

export type AnalyzeEvent =
    | LoopEvent
    | { type: 'phase'; phase: 'fetch' | 'intent' | 'verify' | 'excerpts'; label: string }
    | { type: 'pr'; id: string; title: string; repo: string; number: number; filesChanged: number; issueKey: string | null };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function repoTools(pr: PullRequest) {
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

// The intent phase may look things up in the user's own MCP servers; nothing may change state.
// ToolSearch only loads tool definitions, so it is safe to allow.
const intentTools: CanUseTool = async (name, input) =>
    name === 'ToolSearch' || (name.startsWith('mcp__') && isReadOnlyToolName(name))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Read-only lookups only.' };

// The verify phase sees only Io's repository tools, so intent cannot be revised after reading code.
const verifyTools: CanUseTool = async (name, input) =>
    name.startsWith('mcp__io__')
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Only the repository tools are available here.' };

async function scratchDir(): Promise<string> {
    const cwd = path.join(os.tmpdir(), 'project-io-analyze');
    await mkdir(cwd, { recursive: true });
    return cwd;
}

export async function resolvePrInput(input: string): Promise<PrRef> {
    const key = issueKeyFromLinearUrl(input);
    if (!key) return parsePrRef(input);
    const prs = await findPrsForIssue(key);
    if (prs.length === 0) throw new Error(`No pull request mentions ${key} in its title or description.`);
    if (prs.length > 1) {
        throw new Error(`Several pull requests mention ${key}; paste one of them:\n${prs.map(p => `${p.url} (${p.state})`).join('\n')}`);
    }
    return parsePrRef(prs[0].url);
}

export async function analyzePullRequest(input: string, onEvent: (e: AnalyzeEvent) => void, signal?: AbortSignal): Promise<Analysis> {
    onEvent({ type: 'phase', phase: 'fetch', label: 'Reading the pull request' });
    const ref = await resolvePrInput(input);
    const pr = await fetchPullRequest(ref);
    const id = analysisId(ref.owner, ref.repo, ref.number);
    const branchKey = extractIssueKey(pr.headRefName);
    onEvent({
        type: 'pr',
        id,
        title: pr.title,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        filesChanged: pr.changedFiles,
        issueKey: branchKey,
    });
    const cwd = await scratchDir();
    const models = defaultStore().modelSettings();
    const intentChoice = resolveChoice(INTENT_MODEL, models.intent);

    onEvent({ type: 'phase', phase: 'intent', label: 'Extracting claims from the issue and description' });
    // The model id Claude Code reports at session start, so a run records what actually ran.
    const ranModel = { intent: intentChoice.model as string, verify: '' };
    const intentRun = await runAgent({
        prompt: `<pull_request>\n${pr.title}\n${pr.url}\n\n${pr.body || '(no description)'}\n</pull_request>\n\n${
            branchKey
                ? `The branch names issue ${branchKey}. Load it, and its parent, with your issue-tracker tools before you answer; leave issue empty only if no tool can load it.`
                : 'The branch names no issue.'
        }`,
        choice: intentChoice,
        options: {
            cwd,
            systemPrompt: INTENT_SYSTEM,
            settingSources: [],
            tools: ['ToolSearch'],
            canUseTool: intentTools,
            outputFormat: { type: 'json_schema', schema: toOutputSchema(IntentOutput) },
            maxTurns: 15,
        },
        onEvent: e => {
            if (e.type === 'session') ranModel.intent = e.model;
            onEvent(e);
        },
        signal,
        waitForMcp: true,
    });
    const intent = IntentOutput.parse(intentRun.structured);

    const { text: diff, omittedFiles } = budgetDiff(pr.diff, DIFF_BUDGET_CHARS);
    const choice = resolveChoice(chooseExplainModel({ diffChars: pr.diff.length, files: pr.files.map(f => f.path) }), models.verify);
    onEvent({ type: 'phase', phase: 'verify', label: 'Checking each claim against the code' });
    const verifyRun = await runAgent({
        prompt: `<claims>\n${JSON.stringify(intent.claims, null, 1)}\n</claims>

<pull_request>
${ref.owner}/${ref.repo}#${ref.number} — ${pr.title}
${pr.headRefName} (${pr.headRefOid.slice(0, 7)}) → ${pr.baseRefName} (${pr.baseRefOid.slice(0, 7)})
</pull_request>

<commits>
${pr.commits.map(c => `- ${c.messageHeadline}${c.messageBody ? `\n  ${c.messageBody.replaceAll('\n', '\n  ')}` : ''}`).join('\n')}
</commits>

<files_changed>
${pr.files.map(f => `${f.path} (+${f.additions} −${f.deletions})`).join('\n')}${
            omittedFiles.length ? `\n\nLeft out of the diff below to fit; read with read_file if they matter:\n${omittedFiles.join('\n')}` : ''
        }
</files_changed>

<diff>
${diff}
</diff>`,
        choice,
        options: {
            cwd,
            systemPrompt: VERIFY_SYSTEM,
            settingSources: [],
            tools: [],
            mcpServers: { io: repoTools(pr) },
            canUseTool: verifyTools,
            outputFormat: { type: 'json_schema', schema: toOutputSchema(VerifyOutput) },
            maxTurns: 60,
        },
        onEvent: e => {
            if (e.type === 'session') ranModel.verify = e.model;
            onEvent(e);
        },
        signal,
    });
    const verify = VerifyOutput.parse(verifyRun.structured);

    onEvent({ type: 'phase', phase: 'excerpts', label: 'Fetching the code excerpts' });
    const added = addedLinesByFile(pr.diff);
    const files = new Map<string, Promise<string>>();
    const fileAtHead = (p: string) => {
        if (!files.has(p)) files.set(p, readRepoFile(ref, pr.headRefOid, p));
        return files.get(p)!;
    };
    const verified = new Map(verify.claims.map(c => [c.id, c]));

    const analysis: Analysis = {
        id,
        createdAt: new Date().toISOString(),
        model: `${intentChoice.model} → ${choice.model}`,
        runInfo: {
            intent: { model: ranModel.intent, effort: intentChoice.effort },
            verify: { model: ranModel.verify || choice.model, effort: choice.effort },
        },
        pr: {
            owner: ref.owner,
            repo: ref.repo,
            number: ref.number,
            title: pr.title,
            url: pr.url,
            author: pr.author,
            headRefOid: pr.headRefOid,
            filesChanged: pr.changedFiles,
            additions: pr.additions,
            deletions: pr.deletions,
        },
        issue: intent.issue.key ? intent.issue : null,
        sources: intent.sources,
        verdict: verify.verdict,
        claims: await Promise.all(
            intent.claims.map(async c => {
                const v = verified.get(c.id);
                if (!v) return { ...c, verdict: 'unverifiable' as const, codeDoes: 'Not assessed.', evidence: [], excerpt: null, comment: null };
                const source = await fileAtHead(v.excerpt.path);
                return {
                    ...c,
                    verdict: v.verdict,
                    codeDoes: v.codeDoes,
                    evidence: v.evidence,
                    excerpt: source.startsWith('ERROR:') ? null : buildExcerpt(source, v.excerpt, added.get(v.excerpt.path) ?? new Set()),
                    comment: v.comment.kind === 'none' || !v.comment.body ? null : { ...v.comment, kind: v.comment.kind },
                };
            }),
        ),
        unclaimed: verify.unclaimed.map(u => ({ ...u, expected: false })),
        flow: verify.flow,
        status: 'review',
    };
    defaultStore().save(analysis);
    return analysis;
}
