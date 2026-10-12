import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.es.mjs';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

// Reports quote PR text, which anyone can write. Sanitise everything before it reaches the DOM:
// script on this page could call the self-edit endpoint.
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
        darkMode: true,
        background: token('--ir-surface-sunk'),
        primaryColor: token('--ir-surface'),
        primaryBorderColor: token('--ir-cyan'),
        primaryTextColor: token('--ir-text'),
        lineColor: token('--ir-text-muted'),
        textColor: token('--ir-text'),
        actorBkg: token('--ir-surface'),
        actorBorder: token('--ir-cyan'),
        noteBkgColor: token('--ir-surface-raised'),
        noteTextColor: token('--ir-text'),
        fontFamily: token('--ir-font-body'),
    },
});

const $ = id => document.getElementById(id);

// Hash routes: #inbox (default), #analyze (inbox with the URL field focused), #settings.
function route() {
    const hash = location.hash.slice(1) || 'inbox';
    const screen = hash === 'settings' ? 'settings' : 'inbox';
    for (const page of document.querySelectorAll('.page')) page.hidden = page.id !== `screen-${screen}`;
    for (const link of document.querySelectorAll('.app-nav a')) {
        if (link.dataset.nav === screen) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
    $('chat-screen').textContent = `On: ${$(`screen-${screen}`).dataset.screen}`;
    if (hash === 'analyze') $('pr').focus();
}
addEventListener('hashchange', route);
route();

function setChatOpen(open) {
    $('chat').hidden = !open;
    $('chat-launcher').hidden = open;
    (open ? $('request') : $('chat-launcher')).focus();
}
$('chat-launcher').addEventListener('click', () => setChatOpen(true));
$('chat-close').addEventListener('click', () => setChatOpen(false));
addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('chat').hidden) setChatOpen(false);
});

async function post(url, body, onEvent) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Io': '1' },
        body: JSON.stringify(body),
    });
    if (!res.headers.get('content-type')?.includes('ndjson')) {
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        return data;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line) onEvent(JSON.parse(line));
    }
}

function renderMarkdown(target, markdown) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
}

async function renderDiagrams(target) {
    const blocks = target.querySelectorAll('code.language-mermaid');
    for (const [i, code] of blocks.entries()) {
        const holder = document.createElement('div');
        holder.className = 'diagram';
        try {
            const { svg } = await mermaid.render(`m${Date.now()}${i}`, code.textContent);
            holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        } catch (err) {
            holder.textContent = `Diagram failed to render: ${err.message}`;
            holder.append(code.cloneNode(true));
        }
        code.parentElement.replaceWith(holder);
    }
}

function describeModel(e) {
    return `${e.model[0].toUpperCase()}${e.model.slice(1)}, ${e.effort} effort (${e.reason})`;
}

function describeSession(e) {
    const servers = e.mcpServers
        .filter(s => s.name !== 'io')
        .map(s => `${s.name} ${s.status === 'connected' ? '✓' : `(${s.status})`}`);
    return `via ${e.auth}${servers.length ? ` · MCP: ${servers.join(', ')}` : ''}`;
}

function describeTool(e) {
    const input = e.input ?? {};
    const shown = input.file_path ?? input.path;
    return `${e.name.replace(/^mcp__io__/, '')}${shown ? ` ${input.side ? `${input.side}:` : ''}${shown}` : input.query ? ` “${input.query}”` : input.command ? ` ${input.command}` : ''}`;
}

$('explain-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    const report = $('report');
    const activity = $('explain-activity');
    const steps = activity.querySelector('ol');
    report.innerHTML = '<p class="meta">Reading the pull request…</p>';
    steps.innerHTML = '';
    activity.hidden = true;
    $('explain-context').textContent = '';
    button.disabled = true;

    let text = '';
    let frame = 0;
    try {
        await post('/api/explain', { pr: $('pr').value }, e => {
            if (e.type === 'context') {
                $('explain-context').textContent =
                    `${e.title} · ${e.issue ? `Branch names ${e.issue}` : 'No issue key in the branch'}` +
                    (e.omittedFiles.length ? ` · ${e.omittedFiles.length} large file(s) left out of the diff` : '');
                report.innerHTML = '<p class="meta">Investigating…</p>';
            } else if (e.type === 'model') {
                $('explain-context').textContent += ` · ${describeModel(e)}`;
            } else if (e.type === 'session') {
                $('explain-context').textContent += ` · ${describeSession(e)}`;
                $('settings-session').textContent = `Last session: ${describeSession(e)}`;
            } else if (e.type === 'tool') {
                activity.hidden = false;
                const li = document.createElement('li');
                li.textContent = describeTool(e);
                steps.append(li);
                text = '';
            } else if (e.type === 'text') {
                text += e.delta;
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() => renderMarkdown(report, text));
            } else if (e.type === 'error') {
                throw new Error(e.error);
            }
        });
        cancelAnimationFrame(frame);
        renderMarkdown(report, text);
        await renderDiagrams(report);
    } catch (err) {
        report.insertAdjacentHTML('beforeend', '<p class="error"></p>');
        report.lastElementChild.textContent = err.message;
    } finally {
        button.disabled = false;
    }
});

function logLine(text, cls) {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    $('change-log').append(li);
    return li;
}

async function waitForRestart(previousSha) {
    logLine('Restarting…', 'step');
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            const health = await (await fetch('/api/health')).json();
            if (health.sha !== previousSha) return location.reload();
        } catch {
            // server is down mid-restart
        }
    }
    logLine('The server did not come back. Check the terminal running `npm start`.', 'error');
}

$('change-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    logLine($('request').value, 'bubble-user');
    const before = (await (await fetch('/api/health')).json()).sha;
    let restart = false;
    let narration = null;
    try {
        await post('/api/self-edit', { request: $('request').value }, e => {
            if (e.type === 'text') {
                narration ??= logLine('', 'bubble-claude');
                narration.textContent += e.delta;
                return;
            }
            narration = null;
            if (e.type === 'tool') logLine(`→ ${describeTool(e)}`, 'step');
            else if (e.type === 'model') logLine(describeModel(e), 'step');
            else if (e.type === 'session') logLine(describeSession(e), 'step');
            else if (e.type === 'checks') logLine(e.ok ? '✓ checks pass' : `✗ checks fail\n${e.output}`, e.ok ? 'ok' : 'error');
            else if (e.type === 'committed') logLine(`Committed ${e.sha}: ${e.message}`, 'ok');
            else if (e.type === 'discarded') logLine(`Discarded the attempt — ${e.reason}`, 'error');
            else if (e.type === 'done') restart = e.committed;
            else if (e.type === 'error') logLine(e.error, 'error');
        });
        if (restart) await waitForRestart(before);
        else $('request').value = '';
    } finally {
        button.disabled = false;
    }
});

$('undo').addEventListener('click', async () => {
    const before = (await (await fetch('/api/health')).json()).sha;
    try {
        const { sha } = await post('/api/undo', {});
        logLine(`Reverted in ${sha}`, 'ok');
        await waitForRestart(before);
    } catch (err) {
        logLine(err.message, 'error');
    }
});

const health = await (await fetch('/api/health')).json();
$('version').textContent = `Running ${health.sha}.`;
