import { post } from './api.js';
import { h, plural, statusLine } from './dom.js';
import { startAnalysis } from './inbox.js';

const TABS = [
    { key: 'overview', label: 'Overview', path: '' },
    { key: 'claims', label: 'Claims & code', path: '/claims' },
    { key: 'flow', label: 'Behavior flow', path: '/flow' },
];

export function prHeader(a, active, { actions = true } = {}) {
    const pr = a.pr;
    const meta = h('p', { class: 'meta' },
        `${pr.owner}/${pr.repo} · PR #${pr.number} · opened by ${pr.author} · ${plural(pr.filesChanged, 'file')}, `,
        h('span', { class: 'add' }, `+${pr.additions}`), ' ', h('span', { class: 'del' }, `−${pr.deletions}`),
        a.issue ? [' · linked to ', a.issue.url ? h('a', { href: a.issue.url, target: '_blank', rel: 'noopener' }, a.issue.key) : a.issue.key] : ' · no linked issue',
    );
    const summaryPanel = h('div', { hidden: true });
    const actionRow = actions
        ? h('div', { class: 'actions' },
              h('a', { class: 'btn btn-secondary accent-cyan', href: pr.url, target: '_blank', rel: 'noopener' }, 'Open in GitHub'),
              a.issue?.url ? h('a', { class: 'btn btn-secondary accent-purple', href: a.issue.url, target: '_blank', rel: 'noopener' }, 'Open in Linear') : null,
              h('button', { type: 'button', class: 'btn btn-ghost', title: 'Run the analysis again', onclick: () => { startAnalysis(pr.url); location.hash = '#inbox'; } }, 'Re-analyze'),
              h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openSummary(a, summaryPanel) }, 'Post review summary'),
          )
        : null;
    return h('section', { class: 'pr-header', 'aria-label': 'Pull request' },
        h('a', { class: 'back', href: '#inbox' }, '← All pull requests'),
        h('div', { class: 'pr-title-row' }, h('div', null, h('h1', null, pr.title), meta), actionRow),
        summaryPanel,
        h('nav', { class: 'tabs', 'aria-label': 'Report sections' },
            TABS.map(t => h('a', { href: `#pr/${a.id}${t.path}`, 'aria-current': t.key === active ? 'page' : null }, t.label)),
        ),
    );
}

export function commentComposer({ title, kind, text, onPost, postLabel, placement, accent = 'accent-cyan', onCancel }) {
    const area = h('textarea', { class: 'mono', rows: 6, 'aria-label': 'Edit before posting', placeholder: 'Nothing to raise here. Write a comment if you want one.' });
    area.value = text;
    const status = h('span', { class: 'status-line', role: 'status' });
    let where = placement?.initial ?? 'general';
    const placementGroup = placement
        ? h('div', { class: 'placement', role: 'group', 'aria-label': 'Where to post' },
              placement.inline
                  ? h('button', { type: 'button', class: 'btn btn-secondary', 'aria-pressed': String(where === 'inline'), onclick: e => pick('inline', e) }, `Inline on ${placement.inline}`)
                  : null,
              h('button', { type: 'button', class: 'btn btn-secondary', 'aria-pressed': String(where === 'general'), onclick: e => pick('general', e) }, 'General PR comment'),
          )
        : null;
    function pick(value, e) {
        where = value;
        for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        placement.onChange?.(value);
    }
    const postButton = h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
            postButton.disabled = true;
            statusLine(status, 'Posting…');
            try {
                const result = await onPost(area.value, where);
                statusLine(status, result, 'ok');
                postButton.textContent = 'Posted';
            } catch (err) {
                statusLine(status, err.message, 'error');
                postButton.disabled = false;
                postButton.textContent = 'Retry';
            }
        },
    }, postLabel);
    const panel = h('section', { class: `card composer-panel ${accent}`, 'aria-label': title },
        h('h3', null, title, kind ? h('span', { class: `badge ${kind.cls}` }, kind.label) : null),
        placementGroup,
        area,
        h('div', { class: 'actions' },
            postButton,
            h('button', { type: 'button', class: 'btn btn-secondary', onclick: async () => { await navigator.clipboard.writeText(area.value); statusLine(status, 'Copied', 'ok'); } }, 'Copy'),
            h('button', {
                type: 'button',
                class: 'btn btn-secondary',
                onclick: async e => {
                    const button = e.currentTarget;
                    button.disabled = true;
                    statusLine(status, 'Rewriting with Claude…');
                    try {
                        area.value = (await post('/api/rewrite', { text: area.value })).text;
                        area.dispatchEvent(new Event('input'));
                        statusLine(status, 'Rewritten. Check it before posting.', 'ok');
                    } catch (err) {
                        statusLine(status, err.message, 'error');
                    } finally {
                        button.disabled = false;
                    }
                },
            }, 'Rewrite'),
            onCancel ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: onCancel }, 'Cancel') : null,
            status,
        ),
    );
    return { panel, area };
}

function openSummary(a, holder) {
    if (!holder.hidden) return void (holder.hidden = true);
    const { panel } = commentComposer({
        title: 'Review summary',
        text: a.summaryMarkdown,
        postLabel: `Post to PR #${a.pr.number}`,
        onPost: async body => {
            await post(`/api/analyses/${encodeURIComponent(a.id)}/comment`, { body, placement: 'general' });
            return `Posted · PR #${a.pr.number} conversation`;
        },
        onCancel: () => (holder.hidden = true),
    });
    holder.replaceChildren(panel);
    holder.hidden = false;
}
