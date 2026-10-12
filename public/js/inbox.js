import { get, post } from './api.js';
import { $, badge, h, icon, plural, STATUS } from './dom.js';

// Analyses in flight survive navigation: keyed by what was pasted, shown as rows at the top.
const pending = new Map();
let rerender = () => undefined;

const FILTERS = [
    { key: 'all', label: 'All', icon: 'layers', color: 'var(--ir-cyan)', test: () => true },
    { key: 'attention', label: 'Needs attention', icon: 'warning', color: 'var(--ir-pink)', test: s => s.status === 'needs_attention' || s.status === 'review' },
    { key: 'aligned', label: 'Aligned', icon: 'check', color: 'var(--ir-green)', test: s => s.status === 'aligned' },
    { key: 'nolink', label: 'No linked issue', icon: 'nolink', color: 'var(--ir-purple)', test: s => s.status === 'no_linked_issue' },
];

function describeStep(e) {
    if (e.type === 'phase') return e.label;
    if (e.type === 'tool') return `${e.name.replace(/^mcp__(io__)?/, '').replace(/__/g, ' · ')} ${e.input?.path ?? e.input?.query ?? ''}`.trim();
    if (e.type === 'model') return `${e.model} · ${e.effort} effort`;
    return null;
}

export function startAnalysis(input) {
    const key = input.trim();
    if (!key || [...pending.values()].some(p => p.input === key && !p.error)) return;
    const job = { input: key, title: key, meta: '', step: 'Starting…', error: null };
    pending.set(key, job);
    rerender();
    post('/api/analyze', { input: key }, e => {
        if (e.type === 'pr') {
            job.title = e.title;
            job.meta = `${e.repo} · #${e.number} · ${plural(e.filesChanged, 'file')} changed`;
            job.id = e.id;
        } else if (e.type === 'error') {
            job.error = e.error;
        } else if (e.type === 'done') {
            pending.delete(key);
            dispatchEvent(new Event('io:usage-changed'));
        } else {
            job.step = describeStep(e) ?? job.step;
        }
        rerender();
    }).catch(err => {
        job.error = err.message;
        rerender();
    });
}

function coverage(counts) {
    const total = counts.delivered + counts.partial + counts.missing + counts.unverifiable;
    const bar = h('div', { class: 'coverage', role: 'img', 'aria-label': 'Claim coverage' });
    for (const kind of ['delivered', 'partial', 'missing', 'unverifiable']) {
        if (counts[kind]) bar.append(h('span', { class: `seg-${kind}`, style: `flex: ${counts[kind]} 1 0` }));
    }
    const parts = [`${counts.delivered} of ${total} delivered`];
    if (counts.partial) parts.push(`${counts.partial} partial`);
    if (counts.missing) parts.push(`${counts.missing} missing`);
    if (counts.unverifiable) parts.push(`${counts.unverifiable} can’t verify`);
    return [bar, h('span', { class: 'meta' }, total ? parts.join(', ') : 'No claims found')];
}

function prRow(s, { dismissedView }) {
    const actions = dismissedView
        ? h('button', {
              type: 'button',
              class: 'icon-btn dismiss',
              title: 'Restore to the inbox',
              'aria-label': `Restore PR #${s.pr.number} to the inbox`,
              onclick: async () => {
                  await post(`/api/analyses/${encodeURIComponent(s.id)}/restore`);
                  rerender();
              },
          }, icon('restore'))
        : h('button', {
              type: 'button',
              class: 'icon-btn dismiss',
              title: 'Dismiss from the inbox',
              'aria-label': `Dismiss PR #${s.pr.number} from the inbox`,
              onclick: async () => {
                  await post(`/api/analyses/${encodeURIComponent(s.id)}/dismiss`);
                  rerender();
              },
          }, icon('archive'));
    return h('div', { class: 'pr-row' },
        h('div', { class: 'col-pr' },
            h('a', { href: `#pr/${s.id}` }, s.pr.title),
            h('span', { class: 'meta' }, `${s.pr.owner}/${s.pr.repo} · #${s.pr.number} · ${plural(s.pr.filesChanged, 'file')} changed`),
            s.stale && !dismissedView
                ? h('span', { class: 'stale' }, 'New commits since this analysis · ',
                      h('button', { type: 'button', onclick: () => startAnalysis(`https://github.com/${s.pr.owner}/${s.pr.repo}/pull/${s.pr.number}`) }, 'Re-analyze'))
                : null,
        ),
        h('div', { class: 'col-issue' }, s.issueKey ? h('span', { class: 'issue-key' }, s.issueKey) : h('span', { class: 'meta' }, 'None linked')),
        h('div', { class: 'col-claims' }, coverage(s.counts)),
        h('div', { class: 'col-unclaimed' }, h('span', { class: 'unclaimed-count' }, s.unclaimed), ' ', h('span', { class: 'meta' }, s.unclaimed === 1 ? 'change' : 'changes')),
        h('div', { class: 'col-status' },
            dismissedView ? h('span', { class: 'meta' }, s.dismissReason === 'merged' ? 'Merged' : 'Dismissed') : badge(STATUS[s.status]),
            actions,
        ),
    );
}

function pendingRow(job) {
    const status = job.error
        ? badge(STATUS.failed)
        : badge(STATUS.analyzing, h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    return h('div', { class: 'pr-row', style: job.error ? 'background: var(--ir-missing-tint)' : null },
        h('div', { class: 'col-pr' },
            h('b', null, job.title),
            job.meta ? h('span', { class: 'meta' }, job.meta) : null,
            job.error
                ? h('span', { class: 'error' }, job.error)
                : h('span', { class: 'analyzing-step', role: 'status' }, job.step),
        ),
        h('div', { class: 'col-status', style: 'flex: 0 1 auto' },
            status,
            job.error
                ? h('div', { class: 'actions' },
                      h('button', { type: 'button', class: 'btn btn-secondary accent-pink', onclick: () => { pending.delete(job.input); startAnalysis(job.input); } }, 'Re-analyze'),
                      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove this failed analysis', title: 'Remove', onclick: () => { pending.delete(job.input); rerender(); } }, icon('close')))
                : null,
        ),
    );
}

export async function renderInbox(root, params) {
    const filterKey = params.get('filter') ?? 'all';
    const dismissedView = filterKey === 'dismissed';

    const input = h('input', { id: 'pr-url', type: 'text', placeholder: 'Paste a GitHub PR or Linear issue URL', autocomplete: 'off', required: true });
    const form = h('form', { class: 'analyze', onsubmit: e => { e.preventDefault(); startAnalysis(input.value); input.value = ''; } },
        h('div', { class: 'field' }, h('label', { for: 'pr-url' }, 'Analyze a PR'), input),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Analyze'),
    );
    const filters = h('nav', { class: 'filters', 'aria-label': 'Filter' }, h('span', { class: 'eyebrow' }, 'Filter'));
    const table = h('section', { class: 'pr-table', 'aria-label': 'Pull requests' });
    const legend = h('p', { class: 'legend' });

    root.replaceChildren(
        h('div', { class: 'wordmark' }, icon('pr', { size: 18 }), h('span', null, 'Io')),
        h('section', { class: 'page-header', 'aria-label': 'Analyze' },
            h('div', { class: 'page-title' },
                h('h1', null, 'Pull requests'),
                h('p', { class: 'subtitle' }, 'Every PR checked against what its Linear issue and description said it would do.'),
            ),
            form,
        ),
        h('div', { class: 'inbox' }, filters, h('div', { class: 'inbox-main' }, table, legend)),
    );
    if (params.get('focus') === '1') input.focus();

    rerender = async () => {
        if (!root.isConnected || !table.isConnected) return;
        const [{ analyses }, dismissed] = await Promise.all([
            get('/api/analyses'),
            dismissedView ? get('/api/analyses?dismissed=1') : Promise.resolve({ analyses: [] }),
        ]);
        const active = FILTERS.find(f => f.key === filterKey) ?? FILTERS[0];

        filters.replaceChildren(h('span', { class: 'eyebrow' }, 'Filter'));
        for (const f of [...FILTERS, { key: 'dismissed', label: 'Dismissed', icon: 'archive', color: 'var(--ir-text-muted)' }]) {
            const count = f.test ? analyses.filter(f.test).length : null;
            const pressed = f.key === filterKey;
            filters.append(h('a', {
                href: f.key === 'all' ? '#inbox' : `#inbox?filter=${f.key}`,
                class: 'filter',
                'aria-current': pressed ? 'page' : null,
                style: 'text-decoration: none',
            }, icon(f.icon, { color: pressed ? 'currentColor' : f.color }), f.label, count === null ? null : h('span', { class: 'count' }, count)));
        }

        const rows = dismissedView ? dismissed.analyses : analyses.filter(active.test);
        table.replaceChildren(
            h('div', { class: 'pr-row pr-head', 'aria-hidden': 'true' },
                h('span', { class: 'col-pr' }, 'Pull request'),
                h('span', { class: 'col-issue' }, 'Linked issue'),
                h('span', { class: 'col-claims' }, 'Claims delivered'),
                h('span', { class: 'col-unclaimed' }, 'Unclaimed changes'),
                h('span', { class: 'col-status' }, dismissedView ? 'Why' : 'Status'),
            ),
            ...(dismissedView ? [] : [...pending.values()].map(pendingRow)),
            ...rows.map(s => prRow(s, { dismissedView })),
        );
        if (!rows.length && (dismissedView || !pending.size)) {
            table.append(h('p', { class: 'empty' }, analyses.length || dismissedView ? 'No pull requests match this filter.' : 'Nothing analyzed yet. Paste a PR above to start.'));
        }
        legend.replaceChildren(
            'Legend: ',
            h('span', null, h('span', { class: 'swatch', style: 'background: var(--ir-green)' }), 'delivered'),
            h('span', null, h('span', { class: 'swatch', style: 'background: var(--ir-orange)' }), 'partial'),
            h('span', null, h('span', { class: 'swatch', style: 'border: 1.5px solid var(--ir-pink)' }), 'missing'),
            h('span', null, 'Merged PRs leave the inbox on their own.'),
        );
    };
    await rerender();
}

export function focusAnalyze() {
    $('pr-url')?.focus();
}

