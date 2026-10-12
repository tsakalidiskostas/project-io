import { post } from './api.js';
import { badge, h, icon, VERDICT } from './dom.js';
import { highlight } from './highlight.js';
import { commentComposer, prHeader } from './pr-shell.js';

// One draft per claim, kept while Io is open, so switching claims never loses an edit.
const drafts = new Map();

function codeViewer(a, excerpt) {
    const keyLines = new Map();
    excerpt.annotations.forEach((note, i) => note.lines.forEach(n => keyLines.has(n) || keyLines.set(n, i + 1)));
    const first = excerpt.lines[0]?.n ?? 0;
    const last = excerpt.lines.at(-1)?.n ?? 0;
    const github = `https://github.com/${a.pr.owner}/${a.pr.repo}/blob/${a.pr.headRefOid}/${excerpt.path}#L${first}-L${last}`;
    return h('div', { class: 'code-viewer' },
        h('div', { class: 'code-head' },
            h('code', null, excerpt.path),
            h('span', { class: 'meta' }, `Lines ${first}–${last}`),
            h('a', { href: github, target: '_blank', rel: 'noopener' }, 'View on GitHub'),
        ),
        h('div', { class: 'code-body' },
            h('div', { class: 'code-lines' },
                excerpt.lines.map(line => {
                    const note = keyLines.get(line.n);
                    return h('div', { class: `code-line${line.added ? ' added' : ''}${note ? ' key' : ''}` },
                        h('span', { class: 'num' }, line.n),
                        h('span', { class: 'mark' }, line.added ? '+' : ''),
                        h('span', null, highlight(line.text).map(([cls, text]) => (cls ? h('span', { class: cls }, text) : text))),
                        note ? h('span', { class: 'note-chip', 'aria-label': `Explanation ${note}` }, note) : h('span'),
                    );
                }),
            ),
        ),
    );
}

function explanations(excerpt) {
    return h('ol', { class: 'explanations', 'aria-label': 'Explanations' },
        excerpt.annotations.map((note, i) => {
            const first = Math.min(...note.lines);
            const last = Math.max(...note.lines);
            return h('li', null,
                h('span', { class: 'n' }, i + 1),
                h('span', null, h('b', null, first === last ? `Line ${first}` : `Lines ${first}–${last}`), note.note),
            );
        }),
    );
}

function suggestedComment(a, c) {
    const key = `${a.id}:${c.id}`;
    const suggestion = c.comment;
    const inline = suggestion?.path && suggestion.line > 0 ? `${suggestion.path} line ${suggestion.line}` : null;
    const kind = suggestion?.kind === 'request_changes'
        ? { label: 'Request changes', cls: 'v-missing' }
        : { label: 'Comment · optional', cls: 'v-cyan' };
    const { panel, area } = commentComposer({
        title: 'Suggested PR comment',
        kind,
        text: drafts.get(key) ?? suggestion?.body ?? '',
        postLabel: `Post to PR #${a.pr.number}`,
        placement: { inline, initial: inline ? 'inline' : 'general' },
        onPost: async (body, where) => {
            await post(`/api/analyses/${encodeURIComponent(a.id)}/comment`, { body, placement: where, path: suggestion?.path, line: suggestion?.line });
            return where === 'inline' ? `Posted · ${inline}` : `Posted · PR #${a.pr.number} conversation`;
        },
    });
    area.addEventListener('input', () => drafts.set(key, area.value));
    panel.querySelector('h3').prepend(icon('comment'));
    return panel;
}

export function renderClaims(root, a, claimId) {
    const selected = a.claims.find(c => c.id === claimId) ?? a.claims[0];
    if (!selected) {
        root.replaceChildren(prHeader(a, 'claims'), h('p', { class: 'meta' }, 'No checkable claims were found in the sources.'));
        return;
    }
    const v = VERDICT[selected.verdict];
    root.replaceChildren(
        prHeader(a, 'claims', { actions: false }),
        h('div', { class: 'claims-layout' },
            h('nav', { class: 'claim-list', 'aria-label': 'Claims' },
                h('span', { class: 'eyebrow' }, 'Claims'),
                a.claims.map(c =>
                    h('button', {
                        type: 'button',
                        class: 'claim-pick',
                        'aria-pressed': String(c === selected),
                        onclick: () => (location.hash = `#pr/${a.id}/claims/${c.id}`),
                    }, badge(VERDICT[c.verdict]), h('span', null, c.title)),
                ),
            ),
            h('section', { class: `claim-detail ${v.cls}`, 'aria-label': 'Selected claim' },
                h('div', { class: 'claim-card-head' }, badge(v), h('h2', null, selected.title)),
                h('div', { class: 'compare' },
                    h('div', { class: 'claimed' }, h('span', { class: 'eyebrow' }, `Claimed · ${selected.sourceRefs.join(' · ')}`), h('p', null, selected.claimed)),
                    h('div', { class: 'actual' }, h('span', { class: 'eyebrow' }, 'What the code does'), h('p', null, selected.codeDoes)),
                ),
                selected.excerpt
                    ? h('div', { class: 'code-area' }, codeViewer(a, selected.excerpt), explanations(selected.excerpt))
                    : h('p', { class: 'meta' }, 'No code excerpt for this claim.'),
                suggestedComment(a, selected),
            ),
        ),
    );
}
