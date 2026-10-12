import { get, post } from './api.js';
import { $, h, icon } from './dom.js';

// The conversation lives in sessionStorage because a committed change restarts Io and reloads the page.
const STORE = 'io-chat';
const state = load();
let pointer = null;
let pointed = null;
let picking = false;

function load() {
    try {
        return JSON.parse(sessionStorage.getItem(STORE)) ?? { open: false, messages: [] };
    } catch {
        return { open: false, messages: [] };
    }
}

function save() {
    try {
        sessionStorage.setItem(STORE, JSON.stringify({ ...state, messages: state.messages.slice(-80) }));
    } catch {
        // storage blocked; the chat still works for this page load
    }
}

function renderMessage(m) {
    if (m.kind === 'committed') {
        const diff = h('div');
        return h('li', { class: 'bubble-claude' },
            h('span', null, `Committed ${m.sha}: ${m.text}`),
            h('div', { class: 'actions' },
                h('button', {
                    type: 'button',
                    class: 'btn btn-primary',
                    onclick: async e => {
                        if (diff.childElementCount) return void diff.replaceChildren();
                        e.currentTarget.disabled = true;
                        try {
                            diff.replaceChildren(h('pre', null, (await get(`/api/commit/${m.sha}`)).diff));
                        } finally {
                            e.currentTarget.disabled = false;
                        }
                    },
                }, 'View diff'),
                h('button', { type: 'button', class: 'btn btn-secondary accent-pink', onclick: undo }, 'Undo'),
            ),
            diff,
        );
    }
    return h('li', { class: m.cls },
        m.pointer ? h('span', { class: 'pointer-chip' }, icon('target', { size: 14 }), m.pointer) : null,
        m.text,
    );
}

function add(message) {
    state.messages.push(message);
    save();
    const node = renderMessage(message);
    $('change-log').append(node);
    node.scrollIntoView({ block: 'end' });
    return { node, message };
}

function setOpen(open) {
    state.open = open;
    save();
    $('chat').hidden = !open;
    $('chat-launcher').hidden = open || picking;
    if (open) $('request').focus();
}

export function setChatScreen(label) {
    $('chat-screen').textContent = `On: ${label}`;
    state.screen = label;
}

// ---- Point at it ----

function describe(el) {
    const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
    const region = el.closest('section[aria-label], nav[aria-label], aside[aria-label]')?.getAttribute('aria-label');
    return `“${label}”${region ? ` in ${region}` : ''}`;
}

function domPath(el) {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
        const siblings = [...(node.parentElement?.children ?? [])].filter(s => s.tagName === node.tagName);
        parts.unshift(`${node.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
    }
    return parts.join(' > ');
}

const insideChat = el => el.closest('#chat, #point-banner');

function outlineOn(el, locked) {
    const box = $('point-outline');
    if (!el) return void (box.hidden = true);
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    box.classList.toggle('locked', locked);
    box.hidden = false;
}

function onMove(e) {
    if (!insideChat(e.target)) outlineOn(e.target, false);
}

function onPick(e) {
    if (insideChat(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    pointed = e.target;
    pointer = { label: describe(pointed), screen: state.screen, domPath: domPath(pointed), html: pointed.outerHTML.slice(0, 600) };
    stopPicking();
    $('attached-label').textContent = pointer.label;
    $('attached').hidden = false;
    outlineOn(pointed, true);
    $('request').focus();
}

function startPicking() {
    picking = true;
    $('point-btn').setAttribute('aria-pressed', 'true');
    $('point-banner').hidden = false;
    $('chat-launcher').hidden = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPick, true);
}

function stopPicking() {
    picking = false;
    $('point-btn').setAttribute('aria-pressed', 'false');
    $('point-banner').hidden = true;
    $('chat-launcher').hidden = state.open;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPick, true);
    if (!pointed) outlineOn(null);
}

function clearPointer() {
    pointer = null;
    pointed = null;
    $('attached').hidden = true;
    outlineOn(null);
}

// ---- Sending ----

async function waitForRestart(previousSha) {
    add({ cls: 'step', text: 'Restarting…' });
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            if ((await get('/api/health')).sha !== previousSha) return location.reload();
        } catch {
            // the server is down mid-restart
        }
    }
    add({ cls: 'error', text: 'Io did not come back. Check the terminal running npm start.' });
}

async function undo() {
    const before = (await get('/api/health')).sha;
    try {
        const { sha } = await post('/api/undo', {});
        add({ cls: 'ok', text: `Reverted in ${sha}` });
        await waitForRestart(before);
    } catch (err) {
        add({ cls: 'error', text: err.message });
    }
}

const describeTool = e => {
    const input = e.input ?? {};
    return `${e.name.replace(/^mcp__io__/, '')} ${input.file_path ?? input.path ?? input.command ?? ''}`.trim();
};

async function send(e) {
    e.preventDefault();
    const request = $('request').value.trim();
    if (!request) return;
    const button = $('send');
    button.disabled = true;
    add({ cls: 'bubble-user', text: request, pointer: pointer?.label });
    const sentPointer = pointer;
    clearPointer();
    $('request').value = '';
    const before = (await get('/api/health')).sha;
    let restart = false;
    let narration = null;
    try {
        await post('/api/self-edit', { request, pointer: sentPointer }, ev => {
            if (ev.type === 'text') {
                narration ??= add({ cls: 'bubble-claude', text: '' });
                narration.message.text += ev.delta;
                narration.node.lastChild.textContent = narration.message.text;
                save();
                return;
            }
            narration = null;
            if (ev.type === 'tool') add({ cls: 'step', text: `→ ${describeTool(ev)}` });
            else if (ev.type === 'model') add({ cls: 'step', text: `${ev.model}, ${ev.effort} effort` });
            else if (ev.type === 'checks') add({ cls: ev.ok ? 'ok' : 'error', text: ev.ok ? '✓ checks pass' : `✗ checks fail\n${ev.output}` });
            else if (ev.type === 'committed') add({ kind: 'committed', sha: ev.sha, text: ev.message });
            else if (ev.type === 'discarded') add({ cls: 'error', text: `Discarded the attempt — ${ev.reason}` });
            else if (ev.type === 'done') restart = ev.committed;
            else if (ev.type === 'error') add({ cls: 'error', text: ev.error });
        });
        if (restart) await waitForRestart(before);
    } finally {
        button.disabled = false;
    }
}

export async function initChat() {
    $('chat-launcher').addEventListener('click', () => setOpen(true));
    $('chat-close').addEventListener('click', () => setOpen(false));
    $('point-btn').addEventListener('click', () => (picking ? stopPicking() : startPicking()));
    $('point-cancel').addEventListener('click', stopPicking);
    $('attached-remove').addEventListener('click', clearPointer);
    $('change-form').addEventListener('submit', send);
    addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (picking) stopPicking();
        else if (state.open) setOpen(false);
    });
    addEventListener('scroll', () => pointed && outlineOn(pointed, true), true);
    addEventListener('hashchange', clearPointer);

    for (const m of state.messages) $('change-log').append(renderMessage(m));
    setOpen(state.open);
    try {
        $('version').textContent = `Running ${(await get('/api/health')).sha}.`;
    } catch {
        // the footnote just omits the version
    }
}
