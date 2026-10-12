import { z } from 'zod';

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

const FlowNode = z.object({
    id: z.string(),
    kind: z.enum(['start', 'step', 'decision', 'end']),
    label: z.string(),
    claimId: z.string().describe('the claim this node fulfils or is missing for; "" if none'),
    unclaimedNote: z.string().describe('short note when this node carries an unclaimed change; "" if none'),
});
const FlowEdge = z.object({
    from: z.string(),
    to: z.string(),
    label: z.string(),
    note: z.string().describe('where partial behaviour goes wrong on this edge; "" if none'),
});
export const Flow = z.object({ before: z.string(), nodes: z.array(FlowNode), edges: z.array(FlowEdge) });
export type Flow = z.infer<typeof Flow>;

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
            comment: z.object({
                kind: z.enum(['request_changes', 'comment', 'none']),
                path: z.string(),
                line: z.number().int(),
                body: z.string(),
            }),
        }),
    ),
    unclaimed: z.array(z.object({ title: z.string(), path: z.string(), line: z.number().int(), why: z.string() })),
    flow: Flow,
});
export type VerifyOutput = z.infer<typeof VerifyOutput>;

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

export interface Analysis {
    id: string;
    createdAt: string;
    model: string;
    pr: {
        owner: string;
        repo: string;
        number: number;
        title: string;
        url: string;
        author: string;
        headRefOid: string;
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
        comment: { kind: 'request_changes' | 'comment'; path: string; line: number; body: string } | null;
    }[];
    unclaimed: { title: string; path: string; line: number; why: string; expected: boolean }[];
    flow: Flow;
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
// Mermaid labels are quoted; #quot; is Mermaid's own escape, and < > become entities so a label
// can never open markup in the rendered SVG.
const label = (text: string) => `"${text.replaceAll('"', '#quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`;

export function flowToMermaid(flow: Flow, verdicts: Record<string, Verdict>): string {
    const lines = ['flowchart TD'];
    const verdictOf = (claimId: string) => (claimId ? verdicts[claimId] : undefined);
    for (const node of flow.nodes) {
        const id = nodeId(node.id);
        const text = label(node.label);
        const shape =
            node.kind === 'decision' ? `{${text}}` : node.kind === 'start' || node.kind === 'end' ? `([${text}])` : `(${text})`;
        lines.push(`    ${id}${shape}`);
        const verdict = verdictOf(node.claimId);
        if (verdict) lines.push(`    class ${id} ${verdict}`);
        if (node.unclaimedNote) {
            const note = `u_${node.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
            lines.push(`    ${note}[${label(node.unclaimedNote)}]:::unclaimed`, `    ${note} -.- ${id}`);
        }
    }
    const missingIds = new Set(flow.nodes.filter(n => verdictOf(n.claimId) === 'missing').map(n => n.id));
    for (const edge of flow.edges) {
        const text = [edge.label, edge.note].filter(Boolean).join(' · ');
        const arrow = missingIds.has(edge.to) ? '-.->' : '-->';
        lines.push(`    ${nodeId(edge.from)} ${arrow}${text ? `|${label(text)}|` : ''} ${nodeId(edge.to)}`);
    }
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
