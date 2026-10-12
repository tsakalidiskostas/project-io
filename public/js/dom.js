// Every node is built with DOM APIs and text nodes: analyses quote PR text that anyone can write, and
// script on this page can reach the self-edit endpoint.
export function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    append(node, children);
    return node;
}

export function append(node, children) {
    for (const child of [children].flat(Infinity)) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

export const $ = id => document.getElementById(id);

// Static, trusted path data only; never interpolate analysis text into these.
const PATHS = {
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v4a5 5 0 0 0 5 5h4.5"/><path d="M14 5h4v4"/><path d="M18 5l-6 6"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    nolink: '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4"/><path d="M12 19v4"/><path d="M1 12h4"/><path d="M19 12h4"/>',
    up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
};

export function icon(name, { size = 20, color = 'currentColor', label } = {}) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
        svg.setAttribute(k, v);
    }
    if (label) svg.setAttribute('aria-label', label);
    else svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = PATHS[name];
    return svg;
}

export const VERDICT = {
    delivered: { label: 'Delivered', cls: 'v-delivered' },
    partial: { label: 'Partial', cls: 'v-partial' },
    missing: { label: 'Missing', cls: 'v-missing' },
    unverifiable: { label: 'Can’t verify', cls: 'v-neutral' },
};

export const STATUS = {
    needs_attention: { label: 'Needs attention', cls: 'v-missing' },
    review: { label: 'Review', cls: 'v-partial' },
    aligned: { label: 'Aligned', cls: 'v-delivered' },
    no_linked_issue: { label: 'No linked issue', cls: 'v-unclaimed' },
    analyzing: { label: 'Analyzing', cls: 'v-cyan' },
    failed: { label: 'Failed', cls: 'v-missing' },
};

export function badge({ label, cls }, ...extra) {
    return h('span', { class: `badge ${cls}` }, ...extra, label);
}

export function statusLine(node, text, kind) {
    node.className = `status-line ${kind === 'ok' ? 'ok' : kind === 'error' ? 'error' : 'meta'}`;
    node.textContent = text;
}

export function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}
