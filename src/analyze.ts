import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isReadOnlyToolName, runAgent, type LoopEvent } from './agent-loop.ts';
import { addedLinesByFile, buildExcerpt, cleanFlow, CommentsOutput, FlowOutput, IntentOutput, toOutputSchema, issueKeyFromLinearUrl, VerifyOutput, type Analysis } from './analysis.ts';
import { fetchPullRequest, findPrsForIssue, parsePrRef, readRepoFile, searchRepoCode, type PrRef, type PullRequest } from './github.ts';
import { extractIssueKey } from './linear.ts';
import { chooseExplainModel, COMMENTS_MODEL, INTENT_MODEL, resolveChoice } from './model-choice.ts';
import { analysisId, defaultStore } from './store.ts';
import { planUsage } from './usage.ts';

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

unclaimed: changes in the diff that no claim explains and a reviewer should know about — behaviour, not formatting or renames — each pointing at a head-side line.
verdict.summary: one or two plain sentences a reviewer reads first.

Be concrete and brief. When the code and a claim disagree, say exactly how.`;

const FLOW_SYSTEM = `You draw how a pull request changes behaviour, for a reviewer. You get the claims it was checked against, with their verdicts, the changes no claim explains, the PR metadata and its diff, and you can read any file at the base or head commit and search the repository.

flow: one graph of the behaviour this PR touches, before and after, 6–18 nodes, built from the code rather than the description: start/end, steps, decisions. Read the base side to see how it worked before.
- change on every node and edge: "added" exists only after this PR, "removed" only before, "changed" in both but behaves differently, else "unchanged".
- Set claimId on nodes that fulfil a claim, and add a node where each missing claim's step would sit, with its claimId, so the gap shows. Put unclaimedNote on the node an unclaimed change touches.
- codePath and codeLine: where the step is implemented, head side, or base side for a removed step; "" and 0 when no single place fits.
- Edge labels are "yes"/"no" or short conditions; an edge note marks where partial behaviour goes wrong.
- scenarios: the two to six paths a reviewer would want to compare, e.g. "Before · purchase succeeds", "After · purchase succeeds", "After · identity check denied". A before path uses only unchanged, changed and removed nodes; an after path only unchanged, changed and added ones. steps lists node ids from start to end, each consecutive pair joined by an edge.
flow.before: two or three sentences on how it worked before.

Be concrete and brief.`;

const COMMENTS_SYSTEM = `You draft pull request review comments from a finished review. For each claim you get its verdict, what the code does, and the excerpt it was judged on; lines marked "+" were added by the PR.

Return one comment per claim, same claimId:
- partial or missing: kind "request_changes", a comment the author can act on: what the claim asked, what the code does instead, and what would close the gap.
- delivered or unverifiable: kind "comment" only if something is worth raising; otherwise kind "none", empty body, path "" and line 0.
- Anchor path and line on an added ("+") line from the excerpt when one fits, so the comment can be placed inline; otherwise path "" and line 0.

Write as a colleague: direct, specific, courteous, no preamble.`;

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
    const sessionPercent = async () => {
        const usage = await planUsage({ fresh: true });
        return usage.available ? usage.session.percent : null;
    };
    const planBefore = await sessionPercent();
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
        stats: {
            phases: { intent: intentRun.stats, verify: verifyRun.stats },
            planBefore,
            planAfter: await sessionPercent(),
        },
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
            baseRefOid: pr.baseRefOid,
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
                if (!v) return { ...c, verdict: 'unverifiable' as const, codeDoes: 'Not assessed.', evidence: [], excerpt: null };
                const source = await fileAtHead(v.excerpt.path);
                return {
                    ...c,
                    verdict: v.verdict,
                    codeDoes: v.codeDoes,
                    evidence: v.evidence,
                    excerpt: source.startsWith('ERROR:') ? null : buildExcerpt(source, v.excerpt, added.get(v.excerpt.path) ?? new Set()),
                };
            }),
        ),
        unclaimed: verify.unclaimed.map(u => ({ ...u, expected: false })),
        status: 'review',
    };
    defaultStore().save(analysis);
    return analysis;
}

// ---- Built on demand ----

// One build of each kind per run at a time; a second request is told instead of starting another.
const building = new Set<string>();

async function onDemand<T>(key: string, build: () => Promise<T>): Promise<T> {
    if (building.has(key)) throw new Error('Already being built; it will appear when ready.');
    building.add(key);
    try {
        return await build();
    } finally {
        building.delete(key);
    }
}

function claimsForPrompt(a: Analysis): string {
    return JSON.stringify(
        a.claims.map(c => ({ id: c.id, title: c.title, claimed: c.claimed, verdict: c.verdict, codeDoes: c.codeDoes, evidence: c.evidence })),
        null,
        1,
    );
}

export type ExtraEvent = LoopEvent | { type: 'phase'; label: string };

export function buildFlow(id: string, run: number, onEvent: (e: ExtraEvent) => void, signal?: AbortSignal): Promise<Analysis> {
    return onDemand(`${id}#${run}#flow`, async () => {
        const store = defaultStore();
        const a = store.get(id, run);
        onEvent({ type: 'phase', label: 'Reading the pull request' });
        const live = await fetchPullRequest({ owner: a.pr.owner, repo: a.pr.repo, number: a.pr.number });
        // Read files at the commits this run analysed, even if the PR has moved on since.
        const pr = { ...live, headRefOid: a.pr.headRefOid, baseRefOid: a.pr.baseRefOid ?? live.baseRefOid };
        const { text: diff } = budgetDiff(pr.diff, DIFF_BUDGET_CHARS);
        const choice = resolveChoice(chooseExplainModel({ diffChars: pr.diff.length, files: pr.files.map(f => f.path) }), store.modelSettings().flow);
        onEvent({ type: 'phase', label: 'Drawing the before and after' });
        const result = await runAgent({
            prompt: `<claims>\n${claimsForPrompt(a)}\n</claims>

<unclaimed_changes>
${JSON.stringify(a.unclaimed.map(u => ({ title: u.title, path: u.path, line: u.line })), null, 1)}
</unclaimed_changes>

<pull_request>
${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} — ${pr.title}
${pr.headRefName} (${pr.headRefOid.slice(0, 7)}) → ${pr.baseRefName} (${pr.baseRefOid.slice(0, 7)})
</pull_request>

<diff>
${diff}
</diff>`,
            choice,
            options: {
                cwd: await scratchDir(),
                systemPrompt: FLOW_SYSTEM,
                settingSources: [],
                tools: [],
                mcpServers: { io: repoTools(pr) },
                canUseTool: verifyTools,
                outputFormat: { type: 'json_schema', schema: toOutputSchema(FlowOutput) },
                maxTurns: 40,
            },
            onEvent,
            signal,
        });
        const { flow } = FlowOutput.parse(result.structured);
        return store.update(id, x => {
            x.flow = cleanFlow(flow);
            x.stats = { phases: {}, planBefore: null, planAfter: null, ...x.stats };
            x.stats.phases.flow = result.stats;
        }, run);
    });
}

// Comments need no code tools: each claim's verdict, finding and real excerpt are already stored.
export function draftComments(id: string, run: number, onEvent: (e: ExtraEvent) => void, signal?: AbortSignal): Promise<Analysis> {
    return onDemand(`${id}#${run}#comments`, async () => {
        const store = defaultStore();
        const a = store.get(id, run);
        const excerpts = a.claims
            .filter(c => c.excerpt)
            .map(c => `<excerpt claim="${c.id}" path="${c.excerpt!.path}">\n${c.excerpt!.lines.map(l => `${l.added ? '+' : ' '}${l.n}: ${l.text}`).join('\n')}\n</excerpt>`)
            .join('\n\n');
        onEvent({ type: 'phase', label: 'Drafting suggested comments' });
        const result = await runAgent({
            prompt: `<claims>\n${claimsForPrompt(a)}\n</claims>\n\n${excerpts}`,
            choice: resolveChoice(COMMENTS_MODEL, store.modelSettings().comments),
            options: {
                cwd: await scratchDir(),
                systemPrompt: COMMENTS_SYSTEM,
                settingSources: [],
                tools: [],
                strictMcpConfig: true,
                outputFormat: { type: 'json_schema', schema: toOutputSchema(CommentsOutput) },
                maxTurns: 3,
            },
            onEvent,
            signal,
        });
        const { comments } = CommentsOutput.parse(result.structured);
        const byClaim = new Map(comments.map(c => [c.claimId, c]));
        return store.update(id, x => {
            for (const claim of x.claims) {
                const c = byClaim.get(claim.id);
                claim.comment = !c || c.kind === 'none' || !c.body ? null : { kind: c.kind, path: c.path, line: c.line, body: c.body };
            }
            x.commentsDrafted = true;
            x.stats = { phases: {}, planBefore: null, planAfter: null, ...x.stats };
            x.stats.phases.comments = result.stats;
        }, run);
    });
}
