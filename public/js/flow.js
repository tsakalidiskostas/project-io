import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.es.mjs';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
import { analysisApi, post } from './api.js';
import { append, h, statusLine } from './dom.js';
import { commentComposer, prHeader } from './pr-shell.js';

const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let initialised = false;
function initMermaid() {
    if (initialised) return;
    initialised = true;
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        // SVG text labels, not HTML in foreignObject: the sanitiser strips foreignObject, and a canvas
        // export cannot draw it. Mermaid 11 reads the root setting; the flowchart one is legacy.
        htmlLabels: false,
        flowchart: { htmlLabels: false, curve: 'basis' },
        themeVariables: {
            darkMode: true,
            background: token('--ir-surface-sunk'),
            primaryColor: token('--ir-surface'),
            primaryBorderColor: token('--ir-cyan'),
            primaryTextColor: token('--ir-text'),
            secondaryColor: token('--ir-surface-raised'),
            tertiaryColor: token('--ir-surface-raised'),
            lineColor: token('--ir-text-muted'),
            textColor: token('--ir-text'),
            edgeLabelBackground: token('--ir-surface-sunk'),
            fontFamily: token('--ir-font-body'),
            fontSize: '14px',
        },
    });
}

async function exportPng(svg, name, status) {
    const box = svg.viewBox.baseVal;
    const scale = 2;
    const xml = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await image.decode();
    const canvas = h('canvas', { width: box.width * scale, height: box.height * scale });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = token('--ir-surface-sunk');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const link = h('a', { href: canvas.toDataURL('image/png'), download: name });
    link.click();
    statusLine(status, `Saved ${name}`, 'ok');
}

// With SVG text labels this Mermaid version escapes & < > " and then shows the entities literally
// ("a &amp; b"). Decode them through textContent, which never creates markup.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function decodeLabels(svg) {
    for (const el of svg.querySelectorAll('text, tspan')) {
        if (el.childElementCount === 0 && el.textContent.includes('&')) {
            el.textContent = el.textContent.replace(/&(?:amp|lt|gt|quot|#39);/g, m => ENTITIES[m]);
        }
    }
}

// Mirrors nodeId() in src/analysis.ts: the ids Mermaid puts on nodes and edges are built from it.
const mermaidId = id => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

const CHANGE_TEXT = { added: 'Added by this PR', removed: 'Removed by this PR', changed: 'Changed by this PR', unchanged: 'Unchanged' };
const OUTCOME_CLASS = { success: 'v-delivered', failure: 'v-missing', neutral: 'v-cyan' };
const VIEWS = [['diff', 'Diff'], ['before', 'Before'], ['after', 'After']];

function codeUrl(a, node) {
    const sha = node.change === 'removed' ? a.pr.baseRefOid : a.pr.headRefOid;
    return node.codePath && sha ? `https://github.com/${a.pr.owner}/${a.pr.repo}/blob/${sha}/${node.codePath}${node.codeLine ? `#L${node.codeLine}` : ''}` : null;
}

// Wires one rendered SVG: finds each node and edge Mermaid drew, so paths can be lit up and steps opened.
function wire(svg, a, tooltip, frame) {
    const nodes = new Map();
    for (const node of a.flow.nodes) {
        const el = svg.querySelector(`g.node[id^="flowchart-${mermaidId(node.id)}-"]`);
        if (el) nodes.set(node.id, el);
    }
    const paths = [...svg.querySelectorAll('.edgePaths path')];
    const labels = [...svg.querySelectorAll('.edgeLabels .edgeLabel')];
    const edgeFor = (from, to) => {
        const i = paths.findIndex(p => p.id.startsWith(`L_${mermaidId(from)}_${mermaidId(to)}_`));
        return i < 0 ? [] : [paths[i], labels[i]].filter(Boolean);
    };
    const verdicts = Object.fromEntries(a.claims.map(c => [c.id, c]));

    for (const node of a.flow.nodes) {
        const el = nodes.get(node.id);
        if (!el) continue;
        const url = codeUrl(a, node);
        const claim = node.claimId ? verdicts[node.claimId] : null;
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', url ? 'link' : 'img');
        el.setAttribute('aria-label', [node.label, CHANGE_TEXT[node.change ?? 'unchanged'], claim ? `${claim.id} ${claim.verdict}` : null, node.codePath ? `${node.codePath}${node.codeLine ? ` line ${node.codeLine}` : ''}` : null].filter(Boolean).join(', '));
        if (url) el.classList.add('has-code');
        const show = () => {
            tooltip.replaceChildren();
            append(tooltip, [
                h('b', null, node.label),
                h('span', null, CHANGE_TEXT[node.change ?? 'unchanged']),
                claim ? h('span', null, `${claim.id} · ${claim.title} · ${claim.verdict}`) : null,
                node.unclaimedNote ? h('span', { class: 'tip-unclaimed' }, `Unclaimed: ${node.unclaimedNote}`) : null,
                node.codePath ? h('code', null, `${node.codePath}${node.codeLine ? `:${node.codeLine}` : ''}`) : null,
                url ? h('span', { class: 'meta' }, 'Click to open on GitHub') : null,
            ]);
            const box = el.getBoundingClientRect();
            const host = frame.getBoundingClientRect();
            tooltip.style.left = `${box.right - host.left + frame.scrollLeft + 12}px`;
            tooltip.style.top = `${box.top - host.top + frame.scrollTop}px`;
            tooltip.hidden = false;
        };
        const hide = () => (tooltip.hidden = true);
        el.addEventListener('mouseenter', show);
        el.addEventListener('focus', show);
        el.addEventListener('mouseleave', hide);
        el.addEventListener('blur', hide);
        if (url) {
            el.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
            el.addEventListener('keydown', e => e.key === 'Enter' && window.open(url, '_blank', 'noopener'));
        }
    }

    return scenario => {
        svg.classList.toggle('dimmed', Boolean(scenario));
        for (const el of svg.querySelectorAll('.on')) el.classList.remove('on');
        if (!scenario) return;
        scenario.steps.forEach((id, i) => {
            nodes.get(id)?.classList.add('on');
            if (i > 0) for (const el of edgeFor(scenario.steps[i - 1], id)) el.classList.add('on');
        });
    };
}

export async function renderFlow(root, a) {
    initMermaid();
    const scenarios = a.flow.scenarios ?? [];
    const hasDiff = a.flow.nodes.some(n => n.change) && a.mermaidViews;
    let view = 'diff';
    let pinned = null;
    let highlight = () => undefined;
    let currentMermaid = a.mermaid;

    const frame = h('div', { class: 'diagram-frame' });
    const diagram = h('div', { class: 'diagram', role: 'group', 'aria-label': 'Behavior flow diagram' }, h('p', { class: 'meta' }, 'Drawing…'));
    const tooltip = h('div', { class: 'flow-tip', role: 'tooltip', hidden: true });
    frame.append(diagram, tooltip);
    const status = h('span', { class: 'status-line', role: 'status' });
    const commentHolder = h('div', { hidden: true });
    const chips = h('div', { class: 'path-chips', role: 'group', 'aria-label': 'Paths' });
    const pathNote = h('p', { class: 'meta path-note', role: 'status' });
    const viewToggle = h('div', { class: 'placement', role: 'group', 'aria-label': 'View' });

    const describe = s => (s ? `${s.label}: ${s.description}` : pinned ? '' : 'Hover a path to highlight it; click to keep it lit.');
    const light = s => {
        highlight(s);
        pathNote.textContent = describe(s ?? pinned);
    };

    function renderChips() {
        const visible = scenarios.filter(s => view === 'diff' || s.era === view);
        chips.replaceChildren(
            ...visible.map(s =>
                h('button', {
                    type: 'button',
                    class: `path-chip ${OUTCOME_CLASS[s.outcome]}`,
                    'aria-pressed': String(pinned === s),
                    onmouseenter: () => light(s),
                    onfocus: () => light(s),
                    onmouseleave: () => light(pinned),
                    onblur: () => light(pinned),
                    onclick: () => {
                        pinned = pinned === s ? null : s;
                        renderChips();
                        light(pinned);
                    },
                }, h('span', { class: 'dot', 'aria-hidden': 'true' }), s.label),
            ),
        );
        if (!visible.includes(pinned)) pinned = null;
    }

    async function draw() {
        currentMermaid = (hasDiff && a.mermaidViews[view]) || a.mermaid;
        try {
            const { svg } = await mermaid.render(`flow-${Date.now()}`, currentMermaid);
            diagram.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
            decodeLabels(diagram.querySelector('svg'));
            highlight = wire(diagram.querySelector('svg'), a, tooltip, frame);
            light(pinned);
        } catch (err) {
            diagram.replaceChildren(h('p', { class: 'error' }, `The diagram failed to render: ${err.message}`), h('pre', null, currentMermaid));
        }
    }

    viewToggle.append(
        ...VIEWS.map(([key, text]) =>
            h('button', {
                type: 'button',
                class: 'btn btn-secondary',
                'aria-pressed': String(key === view),
                onclick: e => {
                    view = key;
                    for (const b of viewToggle.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
                    renderChips();
                    draw();
                },
            }, text),
        ),
    );

    const openComment = () => {
        if (!commentHolder.hidden) return void (commentHolder.hidden = true);
        const { panel } = commentComposer({
            title: 'Comment on PR',
            accent: 'accent-cyan',
            text: `How the behaviour flows after this PR, built from the diff. Green steps deliver a claim, orange ones only partly, dashed pink ones are missing.`,
            postLabel: 'Post with diagram',
            // GitHub renders a mermaid code block as the diagram itself, so it travels as text.
            onPost: async body => {
                await post(analysisApi(a, '/comment'), { body: `${body}\n\n\`\`\`mermaid\n${currentMermaid}\n\`\`\``, placement: 'general' });
                return `Posted to PR #${a.pr.number} with the diagram attached.`;
            },
            onCancel: () => (commentHolder.hidden = true),
        });
        panel.style.setProperty('--accent', 'var(--ir-green)');
        commentHolder.replaceChildren(panel);
        commentHolder.hidden = false;
    };

    root.replaceChildren(
        prHeader(a, 'flow', { actions: false }),
        h('section', { class: 'flow-head', 'aria-label': 'Behavior flow' },
            h('div', null,
                h('h2', { class: 'h2-green' }, 'How it flows after this PR'),
                h('p', { class: 'meta' }, 'Built from the diff, not the description. Each step is tied to the claim it fulfils.'),
            ),
            h('div', { class: 'actions' },
                h('button', { type: 'button', class: 'btn btn-secondary accent-yellow', onclick: () => exportPng(diagram.querySelector('svg'), `pr-${a.pr.number}-flow-${view}.png`, status).catch(err => statusLine(status, err.message, 'error')) }, 'Export image'),
                h('button', { type: 'button', class: 'btn btn-secondary accent-cyan', onclick: async () => { await navigator.clipboard.writeText(currentMermaid); statusLine(status, 'Mermaid copied', 'ok'); } }, 'Copy as Mermaid'),
                h('button', { type: 'button', class: 'btn btn-primary', onclick: openComment }, 'Comment on PR'),
                status,
            ),
        ),
        commentHolder,
        hasDiff
            ? h('section', { class: 'flow-controls', 'aria-label': 'Flow controls' },
                  h('div', { class: 'flow-control-row' }, h('span', { class: 'eyebrow' }, 'View'), viewToggle),
                  scenarios.length ? h('div', { class: 'flow-control-row' }, h('span', { class: 'eyebrow' }, 'Paths'), chips) : null,
                  scenarios.length ? pathNote : null,
              )
            : h('p', { class: 'meta' }, 'Re-analyze this PR to get named paths and the before/after view.'),
        frame,
        h('div', { class: 'flow-notes' },
            h('div', { class: 'card' }, h('span', { class: 'eyebrow', style: 'color: var(--ir-yellow)' }, 'Before this PR'), h('p', null, a.flow.before)),
            h('div', { class: 'card' },
                h('span', { class: 'eyebrow', style: 'color: var(--ir-cyan)' }, 'Reading the diagram'),
                h('p', null, 'Borders show verdicts: green steps deliver a claim, an orange decision only part of one (its edge note says where it goes wrong), a dashed pink step is promised but missing, cyan steps are plain. Dashed purple notes are changes no claim explains.'),
                hasDiff ? h('p', null, 'In the Diff view, a green-tinted step marked + is new in this PR, a faded step marked − and its dashed arrows are gone, and a yellow-tinted step behaves differently. Hover a step for its code; click to open it.') : null,
            ),
        ),
    );

    renderChips();
    await draw();
}
