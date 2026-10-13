import { analysisApi, post, prLink, setCachedAnalysis } from './api.js';
import { badge, h, STATUS, VERDICT } from './dom.js';
import { commentComposer, prHeader } from './pr-shell.js';
import { batchButton } from './batch.js';

const range = e => (e.startLine === e.endLine ? `L${e.startLine}` : `L${e.startLine}–${e.endLine}`);

function verdictPanel(a) {
    const count = v => a.claims.filter(c => c.verdict === v).length;
    const open = a.unclaimed.filter(u => !u.expected).length;
    const tile = (n, label, cls) => h('div', { class: `tile ${cls}` }, h('b', null, n), h('span', null, label));
    return h('section', { class: 'card verdict-panel', 'aria-label': 'Verdict' },
        h('div', { class: 'verdict-text' }, badge(STATUS[a.status]), h('p', null, a.verdict.summary)),
        h('div', { class: 'tiles' },
            tile(count('delivered'), 'Delivered', 'v-delivered'),
            tile(count('partial'), 'Partial', 'v-partial'),
            tile(count('missing'), 'Missing', 'v-missing'),
            tile(open, 'Unclaimed', 'v-unclaimed'),
        ),
    );
}

function sourceCard(s) {
    const head = h('div', { class: 'source-head' },
        s.kind === 'linear' ? badge({ label: 'Linear', cls: 'v-unclaimed' }) : badge({ label: 'GitHub', cls: 'v-cyan' }),
        h('span', null, s.kind === 'linear' ? `${s.ref} · ${s.criteria.length ? 'Acceptance criteria' : s.title}` : s.ref),
    );
    return h('div', { class: 'card source' },
        head,
        s.criteria.length ? h('ol', null, s.criteria.map(c => h('li', null, c))) : null,
        s.text ? h('blockquote', null, `“${s.text.trim()}”`) : null,
    );
}

function claimItem(c) {
    const where = c.evidence.length ? `\nRelated code: ${c.evidence.map(e => `${e.path} ${range(e)}`).join(', ')}` : '';
    return {
        label: `${VERDICT[c.verdict].label} claim: ${c.title}`,
        text: `Claimed (${c.sourceRefs.join(', ')}): ${c.claimed}\nIo’s check found: ${c.codeDoes}${where}`,
    };
}

function claimCard(a, c) {
    const v = VERDICT[c.verdict];
    const actionable = c.verdict === 'partial' || c.verdict === 'missing';
    return h('article', { class: `card claim-card ${v.cls}` },
        h('div', { class: 'claim-card-head' }, badge(v), h('h3', null, c.title), h('span', { class: 'refs' }, c.sourceRefs.join(' · '))),
        h('p', null, c.codeDoes),
        h('div', { class: 'chips' },
            c.evidence.length ? c.evidence.map(e => h('code', { class: 'chip' }, `${e.path} ${range(e)}`)) : h('code', { class: 'chip' }, 'No matching code'),
            h('a', { href: prLink(a, `/claims/${c.id}`) }, c.verdict === 'missing' ? 'See where it would go →' : 'See the code →'),
            actionable ? batchButton(a, `claim:${c.id}`, () => claimItem(c), { className: 'btn btn-secondary accent-orange agent-btn' }) : null,
        ),
    );
}

function unclaimedCard(a, u, index, rerender) {
    const composer = h('div', { hidden: true });
    const toggle = async () => {
        const { analysis } = await post(analysisApi(a, `/unclaimed/${index}`), { expected: !u.expected });
        setCachedAnalysis(analysis);
        rerender(analysis);
    };
    const ask = () => {
        if (!composer.hidden) return void (composer.hidden = true);
        let placement = 'inline';
        const { panel } = commentComposer({
            title: 'Ask the author',
            accent: 'accent-purple',
            text: `This changes ${u.title.charAt(0).toLowerCase()}${u.title.slice(1)}, which neither the issue nor the description mentions. Is it intended? ${u.why}`,
            postLabel: `Post to PR #${a.pr.number}`,
            placement: { inline: `${u.path} line ${u.line}`, initial: 'inline', onChange: v => (placement = v) },
            onPost: async (body, where) => {
                await post(analysisApi(a, '/comment'), { body, placement: where ?? placement, path: u.path, line: u.line });
                return where === 'inline' ? `Posted · ${u.path} line ${u.line}` : `Posted · PR #${a.pr.number} conversation`;
            },
            onCancel: () => (composer.hidden = true),
        });
        composer.replaceChildren(panel);
        composer.hidden = false;
    };
    return h('article', { class: `card unclaimed-card${u.expected ? ' expected' : ''}` },
        h('h3', null, u.title),
        h('code', { class: 'chip', style: 'align-self: flex-start' }, `${u.path} L${u.line}`),
        h('p', null, u.why),
        h('div', { class: 'actions' },
            u.expected
                ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: toggle }, 'Not expected after all')
                : [
                      h('button', { type: 'button', class: 'btn btn-secondary accent-purple', onclick: ask }, 'Ask author why'),
                      batchButton(a, `unclaimed:${index}`, () => ({
                          label: `Unclaimed change: ${u.title}`,
                          text: `${u.path} line ${u.line}, which neither the issue nor the description mentions. ${u.why}\nFind out why it changed. Revert it only if it looks unintended; if it is needed, explain why and change nothing.`,
                      })),
                      h('button', { type: 'button', class: 'btn btn-ghost', onclick: toggle }, 'Mark as expected'),
                  ],
        ),
        composer,
    );
}

export function renderReport(root, a) {
    const rerender = updated => renderReport(root, updated);
    const open = a.unclaimed.map((u, i) => [u, i]).filter(([u]) => !u.expected);
    const expected = a.unclaimed.map((u, i) => [u, i]).filter(([u]) => u.expected);

    root.replaceChildren(
        prHeader(a, 'overview'),
        verdictPanel(a),
        h('div', { class: 'two-col' },
            h('aside', { class: 'sources', 'aria-label': 'Stated intent' },
                h('h2', { class: 'h2-yellow' }, 'What it set out to do'),
                a.sources.map(sourceCard),
                h('p', { class: 'footnote' }, 'Claims are extracted from these sources before the diff is read, so the code can’t reshape what the PR was supposed to do.'),
            ),
            h('section', { class: 'claims-col', 'aria-label': 'Claims' },
                h('h2', { class: 'h2-green' }, 'Claims vs. what the code does'),
                a.claims.length ? a.claims.map(c => claimCard(a, c)) : h('p', { class: 'meta' }, 'No checkable claims were found in the sources.'),
            ),
        ),
        h('section', { class: 'section-head', 'aria-label': 'Unclaimed changes', style: 'gap: var(--ir-space-4)' },
            h('div', { class: 'section-head' },
                h('h2', { class: 'h2-purple' }, 'Unclaimed changes'),
                h('p', { class: 'meta' }, 'Code in the diff that no claim from the issue or description explains.'),
            ),
            open.length ? h('div', { class: 'unclaimed-grid' }, open.map(([u, i]) => unclaimedCard(a, u, i, rerender))) : h('p', { class: 'meta' }, 'None open.'),
            expected.length
                ? h('details', { class: 'expected-group' },
                      h('summary', null, `Expected changes (${expected.length})`),
                      h('div', { class: 'unclaimed-grid' }, expected.map(([u, i]) => unclaimedCard(a, u, i, rerender))))
                : null,
        ),
        h('section', { class: 'section-head', 'aria-label': 'Generated artifacts', style: 'gap: var(--ir-space-4)' },
            h('h2', { class: 'h2-orange' }, 'Generated for this PR'),
            h('div', { class: 'artifacts' },
                h('a', { class: 'artifact', href: prLink(a, '/flow') }, h('b', null, 'Behavior flow'), h('span', null, a.flow ? 'Before and after, with each step tied to a claim.' : 'Before and after, with each step tied to a claim. Built when you first open it.')),
                h('a', { class: 'artifact', href: prLink(a, '/claims') }, h('b', null, 'Annotated code walkthrough'), h('span', null, 'The key lines for each claim, explained.')),
                h('a', {
                    class: 'artifact',
                    href: prLink(a),
                    onclick: e => { e.preventDefault(); root.querySelector('.pr-title-row .btn-primary')?.click(); scrollTo({ top: 0, behavior: 'smooth' }); },
                }, h('b', null, 'Review summary'), h('span', null, 'Markdown ready to post as a PR comment.')),
            ),
        ),
    );
}
