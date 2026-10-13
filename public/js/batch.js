import { $, h, icon, statusLine } from './dom.js';
import { workOnPr } from './work.js';

// Findings collected per PR and handed to its work session as one message. Kept in sessionStorage so the
// batch survives moving between the PR's screens and a reload after Io restarts.
const KEY = 'io-batch';
const CHANGED = 'io:batch-changed';
let showing = null;

function load() {
    try {
        return JSON.parse(sessionStorage.getItem(KEY)) ?? {};
    } catch {
        return {};
    }
}

function save(all) {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(all));
    } catch {
        // storage blocked; the batch lasts until the page reloads
    }
    dispatchEvent(new Event(CHANGED));
}

let batches = load();
const itemsOf = id => batches[id] ?? [];

function setItems(id, items) {
    if (items.length) batches[id] = items;
    else delete batches[id];
    save(batches);
}

// One message for the whole batch; each finding is committed on its own so the history stays reviewable.
export function batchMessage(items) {
    return [
        `Work through these ${items.length === 1 ? 'finding' : `${items.length} findings`} on this PR one at a time. For each, make the change, run the relevant checks, and commit it on its own, unless its note says otherwise. If one is unclear, ask before changing anything for it.`,
        ...items.map((item, i) => `${i + 1}. ${item.label}\n${item.text.trim()}`),
    ].join('\n\n');
}

// A toggle for one finding. `item` is a function so text the user is still editing is read at click time.
export function batchButton(a, key, item, { className = 'btn btn-secondary accent-orange', onError } = {}) {
    const has = () => itemsOf(a.id).some(i => i.key === key);
    const button = h('button', {
        type: 'button',
        class: className,
        onclick: () => {
            if (has()) return setItems(a.id, itemsOf(a.id).filter(i => i.key !== key));
            const { label, text } = item();
            if (!text.trim()) return onError?.('Write what needs doing first.');
            setItems(a.id, [...itemsOf(a.id), { key, label, text }]);
        },
    });
    const sync = () => {
        if (!button.isConnected && button.dataset.synced) return removeEventListener(CHANGED, sync);
        button.dataset.synced = '1';
        button.textContent = has() ? '✓ In batch' : 'Batch to agent';
        button.setAttribute('aria-pressed', String(has()));
        button.title = has() ? 'Remove from the batch for this PR’s work session' : 'Add to the batch for this PR’s work session';
    };
    sync();
    addEventListener(CHANGED, sync);
    return button;
}

export function hideBatch() {
    showing = null;
    $('batch-dock').hidden = true;
}

export function showBatch(a) {
    showing = a;
    render();
}

addEventListener(CHANGED, () => showing && render());

function render() {
    const a = showing;
    const dock = $('batch-dock');
    const items = itemsOf(a.id);
    if (!items.length) return void (dock.hidden = true);
    const wasOpen = dock.querySelector('.batch-panel:not([hidden])') !== null;

    const status = h('p', { class: 'status-line', role: 'status' });
    const panel = h('section', { class: 'card batch-panel', 'aria-label': 'Batch for the agent', hidden: !wasOpen });
    const start = h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
            start.disabled = true;
            statusLine(status, 'Opening the work session…');
            try {
                await workOnPr(a.id, batchMessage(itemsOf(a.id)));
                setItems(a.id, []);
            } catch (err) {
                statusLine(status, err.message, 'error');
                start.disabled = false;
            }
        },
    }, `Start work on ${items.length === 1 ? '1 finding' : `${items.length} findings`}`);
    panel.append(
        h('h3', null, `Batch for PR #${a.pr.number}`),
        h('p', { class: 'meta' }, 'Sent to this PR’s work session as one message. Each finding becomes its own commit. Nothing is posted to GitHub.'),
        h('ol', { class: 'batch-items' },
            items.map(item => {
                const area = h('textarea', { rows: 3, 'aria-label': `Instruction: ${item.label}` });
                area.value = item.text;
                // Saved without re-rendering, so typing keeps its focus.
                area.addEventListener('input', () => {
                    item.text = area.value;
                    batches[a.id] = items;
                    try {
                        sessionStorage.setItem(KEY, JSON.stringify(batches));
                    } catch {
                        // kept in memory
                    }
                });
                return h('li', null,
                    h('div', { class: 'batch-item-head' },
                        h('b', null, item.label),
                        h('button', { type: 'button', class: 'icon-btn', title: 'Remove from the batch', onclick: () => setItems(a.id, items.filter(i => i !== item)) },
                            icon('close', { size: 16, label: `Remove ${item.label}` })),
                    ),
                    area,
                );
            }),
        ),
        h('div', { class: 'actions' },
            start,
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => setItems(a.id, []) }, 'Clear'),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => (panel.hidden = true) }, 'Close'),
        ),
        status,
    );
    panel.addEventListener('keydown', e => e.key === 'Escape' && (e.stopPropagation(), (panel.hidden = true)));
    const pill = h('button', {
        type: 'button',
        class: 'batch-pill',
        onclick: () => {
            panel.hidden = !panel.hidden;
            pill.setAttribute('aria-expanded', String(!panel.hidden));
        },
        'aria-expanded': String(wasOpen),
    }, icon('layers', { size: 20 }), 'Start batch work', h('span', { class: 'batch-count' }, items.length));
    dock.replaceChildren(panel, pill);
    dock.hidden = false;
}
