import { z } from 'zod';
import type { SessionStats } from './stats.ts';

// Shapes from docs/design/HANDOFF.md §1. Optional strings are '' rather than null to keep the
// JSON schemas the sessions must satisfy simple.

// Claude Code validates --json-schema against draft-7 and rejects Zod's default 2020-12 `$schema` marker.
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
    const { $schema: _marker, ...rest } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
    return rest;
}

export const Verdict = z.enum(['delivered', 'partial', 'missing', 'unverifiable']);
export type Verdict = z.infer<typeof Verdict>;

// Phase 1: what the PR set out to do, from the issue and the description only.
export const IntentOutput = z.object({
    issue: z.object({ key: z.string(), title: z.string(), url: z.string() }).describe('key is "" when no issue could be loaded'),
    sources: z.array(
        z.object({
            kind: z.enum(['linear', 'github']),
            ref: z.string().describe('e.g. "FRNT-3057" or "PR description"'),
            title: z.string(),
            url: z.string(),
            criteria: z.array(z.string()).describe('acceptance criteria, verbatim and in order; [] if none'),
            text: z.string().describe('the description, verbatim; "" if criteria carry everything'),
        }),
    ),
    claims: z.array(
        z.object({
            id: z.string().describe('C1, C2, …'),
            title: z.string().describe('short, e.g. "Retries back off exponentially"'),
            sourceRefs: z.array(z.string()).describe('e.g. ["FRNT-3057 #2", "PR description"]'),
            claimed: z.string().describe('the claim as stated in the source'),
        }),
    ),
});
export type IntentOutput = z.infer<typeof IntentOutput>;

const ExcerptSpec = z.object({
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    annotations: z.array(z.object({ lines: z.array(z.number().int()), note: z.string() })),
});
export type ExcerptSpec = z.infer<typeof ExcerptSpec>;

const Change = z.enum(['unchanged', 'added', 'removed', 'changed']).describe('added: only after this PR; removed: only before; changed: in both but behaves differently');

const FlowNode = z.object({
    id: z.string(),
    kind: z.enum(['start', 'step', 'decision', 'end']),
    label: z.string(),
    claimId: z.string().describe('the claim this node fulfils or is missing for; "" if none'),
    unclaimedNote: z.string().describe('short note when this node carries an unclaimed change; "" if none'),
    change: Change,
    codePath: z.string().describe('file that implements this step: head side, or base side for a removed step; "" if none'),
    codeLine: z.number().int().describe('line in codePath; 0 if none'),
});
const FlowEdge = z.object({
    from: z.string(),
    to: z.string(),
    label: z.string(),
    note: z.string().describe('where partial behaviour goes wrong on this edge; "" if none'),
    change: Change,
});
const Scenario = z.object({
    id: z.string(),
    label: z.string().describe('e.g. "Before · purchase succeeds", "After · identity denied"'),
    era: z.enum(['before', 'after']),
    outcome: z.enum(['success', 'failure', 'neutral']),
    description: z.string().describe('one sentence'),
    steps: z.array(z.string()).describe('node ids in order, start to end, each consecutive pair joined by an edge'),
});
export const Flow = z.object({ before: z.string(), nodes: z.array(FlowNode), edges: z.array(FlowEdge), scenarios: z.array(Scenario) });
export type Flow = z.infer<typeof Flow>;
export type FlowView = 'diff' | 'before' | 'after';

// Paths that name a step the graph does not have cannot be highlighted, so they are dropped.
export function cleanFlow(flow: Flow): Flow {
    const ids = new Set(flow.nodes.map(n => n.id));
    return { ...flow, scenarios: flow.scenarios.filter(s => s.steps.length > 1 && s.steps.every(id => ids.has(id))) };
}

// Phase 2: what the code actually does, claim by claim.
export const VerifyOutput = z.object({
    verdict: z.object({ summary: z.string().describe('one or two plain sentences') }),
    claims: z.array(
        z.object({
            id: z.string(),
            verdict: Verdict,
            codeDoes: z.string(),
            evidence: z.array(z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int() })),
            excerpt: ExcerptSpec.describe('head-side lines to show; for a missing claim, where it would naturally go'),
        }),
    ),
    unclaimed: z.array(z.object({ title: z.string(), path: z.string(), line: z.number().int(), why: z.string() })),
});
export type VerifyOutput = z.infer<typeof VerifyOutput>;

// Built on demand, the first time someone opens the flow or the claims of a run.
export const FlowOutput = z.object({ flow: Flow });
export const CommentsOutput = z.object({
    comments: z.array(
        z.object({
            claimId: z.string(),
            kind: z.enum(['request_changes', 'comment', 'none']),
            path: z.string(),
            line: z.number().int(),
            body: z.string(),
        }),
    ),
});

export interface ExcerptLine {
    n: number;
    text: string;
    added: boolean;
}

export interface Excerpt {
    path: string;
    lines: ExcerptLine[];
    annotations: { lines: number[]; note: string }[];
}

export type Status = 'needs_attention' | 'review' | 'aligned' | 'no_linked_issue';

export interface RunModel {
    model: string;
    effort: string;
}

export interface Analysis {
    id: string;
    createdAt: string;
    model: string;
    // The model each phase actually ran, as Claude Code reported it. Absent on runs saved before
    // this was recorded; `model` then holds only the aliases.
    runInfo?: { intent: RunModel; verify: RunModel };
    // What each phase cost, and the plan's session meter around the run. Absent on runs saved before
    // this was measured; the meter readings are whole percents and include anything else running.
    stats?: { phases: Record<string, SessionStats>; planBefore: number | null; planAfter: number | null };
    pr: {
        owner: string;
        repo: string;
        number: number;
        title: string;
        url: string;
        author: string;
        headRefOid: string;
        // Absent on analyses saved before flows linked removed steps to the base commit.
        baseRefOid?: string;
        filesChanged: number;
        additions: number;
        deletions: number;
    };
    issue: { key: string; title: string; url: string } | null;
    sources: IntentOutput['sources'];
    verdict: { summary: string };
    claims: {
        id: string;
        title: string;
        sourceRefs: string[];
        claimed: string;
        verdict: Verdict;
        codeDoes: string;
        evidence: { path: string; startLine: number; endLine: number }[];
        excerpt: Excerpt | null;
        // Undefined until comments are drafted for the run; null when there is nothing to say.
        comment?: { kind: 'request_changes' | 'comment'; path: string; line: number; body: string } | null;
    }[];
    unclaimed: { title: string; path: string; line: number; why: string; expected: boolean }[];
    // Undefined until someone opens the run's flow.
    flow?: Flow;
    commentsDrafted?: boolean;
    status: Status;
}

export function deriveStatus(a: Pick<Analysis, 'issue' | 'claims' | 'unclaimed'>): Status {
    if (!a.issue) return 'no_linked_issue';
    if (a.claims.some(c => c.verdict === 'missing')) return 'needs_attention';
    const open = a.unclaimed.some(u => !u.expected);
    if (open || a.claims.some(c => c.verdict !== 'delivered')) return 'review';
    return 'aligned';
}

export function addedLinesByFile(diff: string): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>();
    let current: Set<number> | null = null;
    let line = 0;
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('+++ ')) {
            const path = raw.slice(4).replace(/^b\//, '');
            current = path === '/dev/null' ? null : new Set();
            if (current) result.set(path, current);
        } else if (raw.startsWith('@@')) {
            line = Number(raw.match(/\+(\d+)/)?.[1] ?? 0);
        } else if (current && raw.startsWith('+')) {
            current.add(line++);
        } else if (current && !raw.startsWith('-') && !raw.startsWith('\\') && !raw.startsWith('diff ')) {
            line++;
        }
    }
    return result;
}

const MAX_EXCERPT_LINES = 60;

export function buildExcerpt(fileText: string, spec: ExcerptSpec, added: Set<number>): Excerpt {
    const all = fileText.split(/\r?\n/);
    const start = Math.max(1, Math.min(spec.startLine, all.length));
    const end = Math.min(all.length, Math.max(start, spec.endLine), start + MAX_EXCERPT_LINES - 1);
    const lines = all.slice(start - 1, end).map((text, i) => ({ n: start + i, text, added: added.has(start + i) }));
    const inRange = (n: number) => n >= start && n <= end;
    return {
        path: spec.path,
        lines,
        annotations: spec.annotations
            .map(a => ({ note: a.note, lines: a.lines.filter(inRange) }))
            .filter(a => a.lines.length > 0),
    };
}

const nodeId = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
// Labels are quoted, with #quot; (Mermaid's own escape) for quotes. Mermaid escapes the rest itself at
// securityLevel strict, and the UI sanitises the SVG, so < and > stay as written.
const label = (text: string) => `"${text.replaceAll('"', '#quot;')}"`;

// Full-width plus: Mermaid parses a label starting "+ " as a Markdown list item and draws nothing.
const DIFF_PREFIX = { added: '＋ ', removed: '− ', changed: '', unchanged: '' } as const;

// Flows saved before change markers existed have none; treat every part as unchanged.
export function flowToMermaid(flow: Flow, verdicts: Record<string, Verdict>, view: FlowView = 'diff'): string {
    const lines = ['flowchart TD'];
    const changeOf = (x: { change?: string }) => (x.change ?? 'unchanged') as keyof typeof DIFF_PREFIX;
    const hidden = (x: { change?: string }) => (view === 'before' && changeOf(x) === 'added') || (view === 'after' && changeOf(x) === 'removed');
    const nodes = flow.nodes.filter(n => !hidden(n));
    const shown = new Set(nodes.map(n => n.id));
    const edges = flow.edges.filter(e => !hidden(e) && shown.has(e.from) && shown.has(e.to));
    const verdictOf = (claimId: string) => (claimId ? verdicts[claimId] : undefined);
    // linkStyle addresses links by the order they are written, unclaimed-note links included.
    let link = 0;
    const fadedLinks: number[] = [];

    for (const node of nodes) {
        const id = nodeId(node.id);
        const text = label(`${view === 'diff' ? DIFF_PREFIX[changeOf(node)] : ''}${node.label}`);
        const shape =
            node.kind === 'decision' ? `{${text}}` : node.kind === 'start' || node.kind === 'end' ? `([${text}])` : `(${text})`;
        lines.push(`    ${id}${shape}`);
        const verdict = verdictOf(node.claimId);
        if (verdict) lines.push(`    class ${id} ${verdict}`);
        if (view === 'diff' && changeOf(node) !== 'unchanged') lines.push(`    class ${id} ${changeOf(node)}`);
        if (node.unclaimedNote) {
            const note = `u_${node.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
            lines.push(`    ${note}[${label(node.unclaimedNote)}]:::unclaimed`, `    ${note} -.- ${id}`);
            link++;
        }
    }
    const missingIds = new Set(nodes.filter(n => verdictOf(n.claimId) === 'missing').map(n => n.id));
    for (const edge of edges) {
        const text = [edge.label, edge.note].filter(Boolean).join(' · ');
        const removed = view === 'diff' && changeOf(edge) === 'removed';
        const arrow = missingIds.has(edge.to) || removed ? '-.->' : '-->';
        lines.push(`    ${nodeId(edge.from)} ${arrow}${text ? `|${label(text)}|` : ''} ${nodeId(edge.to)}`);
        if (removed) fadedLinks.push(link);
        link++;
    }
    for (const i of fadedLinks) lines.push(`    linkStyle ${i} stroke:#A6A28C,stroke-dasharray:4 4,opacity:0.6`);
    lines.push(
        // Fills match the code viewer: added lines green-tinted, key lines yellow-tinted.
        '    classDef added fill:#26301C',
        '    classDef changed fill:#49451F',
        '    classDef removed fill:#1E1F1C,stroke:#A6A28C,stroke-dasharray:3 3,color:#A6A28C',
    );
    lines.push(
        '    classDef delivered stroke:#A6E22E,stroke-width:2px',
        '    classDef partial fill:#5A3C17,stroke:#FD971F,stroke-width:2px',
        '    classDef missing stroke:#F92672,stroke-width:2px,stroke-dasharray:6 4',
        '    classDef unverifiable stroke:#A6A28C,stroke-width:1.5px',
        '    classDef unclaimed fill:#2F302A,stroke:#AE81FF,stroke-dasharray:4 3,color:#C4A3FF',
    );
    return lines.join('\n');
}

const VERDICT_LINE: Record<Verdict, string> = {
    delivered: '✅ **Delivered**',
    partial: '🟡 **Partial**',
    missing: '❌ **Missing**',
    unverifiable: '❔ **Can’t verify**',
};

export function reviewSummary(a: Analysis): string {
    const claims = a.claims.map(c => `- ${VERDICT_LINE[c.verdict]} — ${c.title}: ${c.codeDoes}`);
    const unclaimed = a.unclaimed.filter(u => !u.expected).map(u => `- ${u.title} (\`${u.path}:${u.line}\`): ${u.why}`);
    return [
        `**Intent review**${a.issue ? ` against ${a.issue.key}` : ''}`,
        '',
        a.verdict.summary,
        '',
        ...claims,
        ...(unclaimed.length ? ['', '**Changes no claim explains**', ...unclaimed] : []),
    ].join('\n');
}

export function issueKeyFromLinearUrl(input: string): string | null {
    const m = input.trim().match(/^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z]{2,6}-\d+)/);
    return m ? m[1].toUpperCase() : null;
}
