import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.es.mjs';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
import { analysisApi, post } from './api.js';
import { h, statusLine } from './dom.js';
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

export async function renderFlow(root, a) {
    initMermaid();
    const diagram = h('div', { class: 'diagram', role: 'img', 'aria-label': 'Behavior flow diagram' }, h('p', { class: 'meta' }, 'Drawing…'));
    const status = h('span', { class: 'status-line', role: 'status' });
    const commentHolder = h('div', { hidden: true });

    const openComment = () => {
        if (!commentHolder.hidden) return void (commentHolder.hidden = true);
        const { panel } = commentComposer({
            title: 'Comment on PR',
            accent: 'accent-cyan',
            text: `How the behaviour flows after this PR, built from the diff. Green steps deliver a claim, orange ones only partly, dashed pink ones are missing.`,
            postLabel: 'Post with diagram',
            // GitHub renders a mermaid code block as the diagram itself, so it travels as text.
            onPost: async body => {
                await post(analysisApi(a, '/comment'), { body: `${body}\n\n\`\`\`mermaid\n${a.mermaid}\n\`\`\``, placement: 'general' });
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
                h('button', { type: 'button', class: 'btn btn-secondary accent-yellow', onclick: () => exportPng(diagram.querySelector('svg'), `pr-${a.pr.number}-flow.png`, status).catch(err => statusLine(status, err.message, 'error')) }, 'Export image'),
                h('button', { type: 'button', class: 'btn btn-secondary accent-cyan', onclick: async () => { await navigator.clipboard.writeText(a.mermaid); statusLine(status, 'Mermaid copied', 'ok'); } }, 'Copy as Mermaid'),
                h('button', { type: 'button', class: 'btn btn-primary', onclick: openComment }, 'Comment on PR'),
                status,
            ),
        ),
        commentHolder,
        diagram,
        h('div', { class: 'flow-notes' },
            h('div', { class: 'card' }, h('span', { class: 'eyebrow', style: 'color: var(--ir-yellow)' }, 'Before this PR'), h('p', null, a.flow.before)),
            h('div', { class: 'card' },
                h('span', { class: 'eyebrow', style: 'color: var(--ir-cyan)' }, 'Reading the diagram'),
                h('p', null, 'Green borders are steps that deliver a claim. An orange decision delivers only part of one, with a note on the edge where it goes wrong. A dashed pink step is one the issue promised and the code does not have. Dashed purple notes are changes no claim explains. Cyan borders are plain steps.'),
            ),
        ),
    );

    try {
        const { svg } = await mermaid.render(`flow-${Date.now()}`, a.mermaid);
        diagram.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    } catch (err) {
        diagram.replaceChildren(h('p', { class: 'error' }, `The diagram failed to render: ${err.message}`), h('pre', null, a.mermaid));
    }
}
