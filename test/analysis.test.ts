import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLinesByFile, buildExcerpt, deriveStatus, flowToMermaid, issueKeyFromLinearUrl, reviewSummary, type Analysis } from '../src/analysis.ts';

const claim = (id: string, verdict: Analysis['claims'][number]['verdict']) => ({
    id,
    title: `Claim ${id}`,
    sourceRefs: ['FRNT-1 #1'],
    claimed: 'x',
    verdict,
    codeDoes: 'y',
    evidence: [],
    excerpt: null,
    comment: null,
});

const base = (claims: Analysis['claims'], unclaimed: Analysis['unclaimed'] = [], issueKey = 'FRNT-1'): Analysis =>
    ({ issue: issueKey ? { key: issueKey, title: 't', url: '' } : null, claims, unclaimed }) as unknown as Analysis;

test('status: any missing claim needs attention', () => {
    assert.equal(deriveStatus(base([claim('C1', 'delivered'), claim('C2', 'missing'), claim('C3', 'partial')])), 'needs_attention');
});

test('status: partial or unclaimed means review, all delivered means aligned', () => {
    assert.equal(deriveStatus(base([claim('C1', 'partial')])), 'review');
    assert.equal(deriveStatus(base([claim('C1', 'delivered')], [{ title: 'u', path: 'a', line: 1, why: 'w', expected: false }])), 'review');
    assert.equal(deriveStatus(base([claim('C1', 'delivered')], [{ title: 'u', path: 'a', line: 1, why: 'w', expected: true }])), 'aligned');
});

test('status: no linked issue wins over the verdicts', () => {
    assert.equal(deriveStatus(base([claim('C1', 'missing')], [], '')), 'no_linked_issue');
});

test('finds added line numbers per file from a unified diff', () => {
    const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,3 +10,4 @@ class A {',
        ' keep',
        '-gone',
        '+new one',
        '+new two',
        ' keep',
        'diff --git a/b.ts b/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/b.ts',
        '@@ -0,0 +1,2 @@',
        '+first',
        '+second',
    ].join('\n');
    const added = addedLinesByFile(diff);
    assert.deepEqual([...added.get('src/a.ts')!], [11, 12]);
    assert.deepEqual([...added.get('b.ts')!], [1, 2]);
});

test('builds an excerpt from real file text, clamped and marked', () => {
    const file = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const ex = buildExcerpt(file, { path: 'a.ts', startLine: 95, endLine: 140, annotations: [{ lines: [96, 300], note: 'n' }] }, new Set([96]));
    assert.equal(ex.lines[0].n, 95);
    assert.equal(ex.lines.at(-1)!.n, 100);
    assert.equal(ex.lines.find(l => l.n === 96)!.added, true);
    assert.deepEqual(ex.annotations[0].lines, [96]);
});

test('caps an excerpt at 60 lines', () => {
    const file = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
    assert.equal(buildExcerpt(file, { path: 'a', startLine: 1, endLine: 400, annotations: [] }, new Set()).lines.length, 60);
});

test('renders flow graph data as Mermaid, styled by verdict and safe to embed', () => {
    const mermaid = flowToMermaid(
        {
            before: '',
            nodes: [
                { id: 'start', kind: 'start', label: 'Webhook "arrives"', claimId: '', unclaimedNote: '' },
                { id: 'retry?', kind: 'decision', label: 'attempt < 5', claimId: 'C2', unclaimedNote: '' },
                { id: 'send', kind: 'step', label: 'Send', claimId: 'C1', unclaimedNote: 'logs payloads' },
                { id: 'dlq', kind: 'step', label: 'Dead-letter', claimId: 'C3', unclaimedNote: '' },
            ],
            edges: [
                { from: 'start', to: 'retry?', label: '', note: '' },
                { from: 'retry?', to: 'send', label: 'yes', note: '429 lands here' },
                { from: 'retry?', to: 'dlq', label: 'no', note: '' },
            ],
        },
        { C1: 'delivered', C2: 'partial', C3: 'missing' },
    );
    assert.match(mermaid, /^flowchart TD/);
    assert.match(mermaid, /n_start\(\["Webhook #quot;arrives#quot;"\]\)/);
    assert.match(mermaid, /n_retry_\{"attempt &lt; 5"\}/);
    assert.match(mermaid, /class n_send delivered/);
    assert.match(mermaid, /class n_retry_ partial/);
    assert.match(mermaid, /class n_dlq missing/);
    assert.match(mermaid, /n_retry_ -->\|"yes · 429 lands here"\| n_send/);
    assert.match(mermaid, /n_retry_ -\.->\|"no"\| n_dlq/, 'the arrow into a missing step is dashed');
    assert.match(mermaid, /u_send\["logs payloads"\]:::unclaimed/);
    assert.match(mermaid, /u_send -\.- n_send/);
});

test('review summary lists every claim with its verdict and the unclaimed changes', () => {
    const a = {
        ...base([claim('C1', 'delivered'), claim('C2', 'missing')], [{ title: 'Logs bodies', path: 'a.ts', line: 3, why: 'PII', expected: false }]),
        pr: { number: 7 },
        verdict: { summary: 'Mostly there.' },
    } as unknown as Analysis;
    const md = reviewSummary(a);
    assert.match(md, /Mostly there\./);
    assert.match(md, /✅ \*\*Delivered\*\* — Claim C1/);
    assert.match(md, /❌ \*\*Missing\*\* — Claim C2/);
    assert.match(md, /Logs bodies.*`a\.ts:3`/);
});

test('extracts the issue key from a Linear URL', () => {
    assert.equal(issueKeyFromLinearUrl('https://linear.app/rikstoto/issue/FRNT-3057/altapay-flow-5'), 'FRNT-3057');
    assert.equal(issueKeyFromLinearUrl('https://github.com/o/r/pull/1'), null);
});

test('output schemas carry no $schema marker and are plain objects', async () => {
    const { toOutputSchema, IntentOutput, VerifyOutput } = await import('../src/analysis.ts');
    for (const schema of [toOutputSchema(IntentOutput), toOutputSchema(VerifyOutput)]) {
        assert.equal(schema.$schema, undefined);
        assert.equal(schema.type, 'object');
    }
});
