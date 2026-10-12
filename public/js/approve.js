import { get, post } from './api.js';
import { $, h, icon, statusLine } from './dom.js';

// The floating Approve button on PR screens. Two clicks always: the first only opens the confirm panel.
let showing = null;

export function hideApprove() {
    showing = null;
    $('approve-dock').hidden = true;
}

function render(a, review) {
    const dock = $('approve-dock');
    if (!review.open) return hideApprove();

    const panel = h('section', { class: 'card approve-panel', 'aria-label': 'Approve pull request', hidden: true });
    const status = h('p', { class: 'status-line', role: 'status' });
    const comment = h('textarea', { rows: 3, placeholder: 'Optional comment, e.g. “Looks good, thanks.”', 'aria-label': 'Optional approval comment' });
    const confirm = h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
            confirm.disabled = true;
            statusLine(status, 'Approving…');
            try {
                const { review: updated } = await post(`/api/analyses/${encodeURIComponent(a.id)}/approve`, { body: comment.value });
                render(a, updated);
                $('approve-dock').querySelector('.approve-pill')?.focus();
            } catch (err) {
                statusLine(status, err.message, 'error');
                confirm.disabled = false;
            }
        },
    }, `Approve PR #${a.pr.number}`);
    const close = () => {
        panel.hidden = true;
        pill.setAttribute('aria-expanded', 'false');
    };
    panel.append(
        h('h3', null, icon('check', { size: 18 }), `Approve PR #${a.pr.number}`),
        h('p', { class: 'meta' }, `Submits an approving review on GitHub as ${review.viewer}. It does not merge.`),
        comment,
        h('div', { class: 'actions' }, confirm, h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel')),
        status,
    );

    const approved = review.mine === 'APPROVED';
    const pill = h('button', {
        type: 'button',
        class: `approve-pill${approved ? ' done' : ''}`,
        'aria-expanded': 'false',
        disabled: approved || review.ownPr,
        title: review.ownPr
            ? 'GitHub does not let you approve your own pull request'
            : approved
              ? `You approved PR #${a.pr.number}`
              : `Approve PR #${a.pr.number} on GitHub`,
        onclick: () => {
            panel.hidden = !panel.hidden;
            pill.setAttribute('aria-expanded', String(!panel.hidden));
            if (!panel.hidden) comment.focus();
        },
    }, icon('check', { size: 20 }), approved ? 'Approved' : 'Approve');

    panel.addEventListener('keydown', e => e.key === 'Escape' && (e.stopPropagation(), close()));
    dock.replaceChildren(panel, pill);
    dock.hidden = false;
}

export async function showApprove(a) {
    const token = (showing = a.id);
    $('approve-dock').hidden = true;
    try {
        const { review } = await get(`/api/analyses/${encodeURIComponent(a.id)}/review`);
        if (showing === token) render(a, review);
    } catch {
        // gh unavailable: no button rather than one that cannot work
        if (showing === token) hideApprove();
    }
}
