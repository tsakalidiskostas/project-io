import { get, post, stream } from './api.js';
import { append, badge, h, icon, statusLine } from './dom.js';

// Work: Claude Code sessions in a checkout, driven from here instead of a terminal. A PR's session runs
// in a worktree on the PR's branch; commits stay local until the user pushes.

const PENDING = 'io-work-pending';
const MODES = [
    ['default', 'Ask before changes'],
    ['acceptEdits', 'Accept edits'],
    ['plan', 'Plan only'],
    ['auto', 'Auto'],
];
const QUICK = [
    { label: 'Check review comments', pr: true, text: 'Read the review comments on this PR with gh, both review threads and general comments. List the ones that are still unresolved and propose how to address each. Do not change code yet.' },
    { label: 'Run the checks', text: 'Run the tests and lint that cover the files changed on this branch, and report what fails.' },
    { label: 'Commit', text: 'Commit the work done so far, following this repository’s commit conventions.' },
];

const readPending = () => {
    try {
        return JSON.parse(sessionStorage.getItem(PENDING));
    } catch {
        return null;
    }
};

// Opens the PR's session, starting one (and its worktree) if needed, and optionally sends a first message.
// A repository Io has no local clone for sends the user to the setup form first.
export async function workOnPr(analysisId, text) {
    try {
        const { session } = await post('/api/work', { analysisId });
        if (text) await post(`/api/work/${session.id}/message`, { text });
        location.hash = `#work/${session.id}`;
    } catch (err) {
        if (!err.data?.needsRepo) throw err;
        try {
            sessionStorage.setItem(PENDING, JSON.stringify({ analysisId, text, slug: err.data.needsRepo }));
        } catch {
            // storage blocked; the setup form just won't know which PR to continue with
        }
        location.hash = '#work';
    }
}

export async function renderWork(root, id) {
    if (id) return renderSession(root, id);
    return renderList(root);
}

const STATE = s =>
    s.waiting.length ? { label: 'Waiting for you', cls: 'v-partial' } : s.busy ? { label: 'Working', cls: 'v-cyan' } : s.live ? { label: 'Idle', cls: 'v-neutral' } : null;

async function renderList(root) {
    const [{ sessions }, { analyses }] = await Promise.all([get('/api/work'), get('/api/analyses')]);
    const pending = readPending();
    const status = h('p', { class: 'status-line', role: 'status' });

    const setup = pending
        ? (() => {
              const input = h('input', { class: 'input mono', id: 'repo-path', placeholder: 'C:\\code\\my-repo', required: true });
              return h('form', {
                  class: 'card accent-orange work-setup',
                  'aria-label': 'Local clone',
                  onsubmit: async e => {
                      e.preventDefault();
                      statusLine(status, 'Checking the clone and preparing a worktree…');
                      try {
                          await post('/api/settings/repos', { slug: pending.slug, path: input.value.trim() });
                          sessionStorage.removeItem(PENDING);
                          await workOnPr(pending.analysisId, pending.text);
                      } catch (err) {
                          statusLine(status, err.message, 'error');
                      }
                  },
              },
                  h('h2', { class: 'h2-orange' }, `Where is ${pending.slug} cloned?`),
                  h('p', { class: 'meta' }, 'Io works on a PR in a git worktree beside your clone, on the PR’s branch, so your own checkout is left alone. It asks once per repository.'),
                  h('label', { for: 'repo-path', class: 'visually-hidden' }, 'Path to the local clone'),
                  h('div', { class: 'actions' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save and start'),
                      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { sessionStorage.removeItem(PENDING); renderList(root); } }, 'Cancel')),
              );
          })()
        : null;

    const prSelect = h('select', { class: 'select', id: 'work-pr' },
        analyses.map(a => h('option', { value: a.id }, `${a.pr.owner}/${a.pr.repo} #${a.pr.number} · ${a.pr.title}`)));
    const folder = h('input', { class: 'input mono', id: 'work-folder', placeholder: 'C:\\code\\some-repo' });
    const start = async (button, action) => {
        button.disabled = true;
        statusLine(status, 'Starting…');
        try {
            await action();
        } catch (err) {
            statusLine(status, err.message, 'error');
            button.disabled = false;
        }
    };

    root.replaceChildren();
    append(root, [
        h('h1', null, 'Work'),
        h('p', { class: 'meta' }, 'Claude Code sessions in a checkout: ask for fixes, answer its permission prompts here, review its commits, then push.'),
        setup,
        h('section', { class: 'card', 'aria-label': 'New session' },
            h('h2', { class: 'h2-green' }, 'New session'),
            analyses.length
                ? h('div', { class: 'work-new' },
                      h('label', { for: 'work-pr', class: 'eyebrow' }, 'On a pull request'),
                      h('div', { class: 'actions' }, prSelect,
                          h('button', { type: 'button', class: 'btn btn-primary', onclick: e => start(e.currentTarget, () => workOnPr(prSelect.value)) }, 'Start')))
                : null,
            h('div', { class: 'work-new' },
                h('label', { for: 'work-folder', class: 'eyebrow' }, 'In a folder'),
                h('div', { class: 'actions' }, folder,
                    h('button', {
                        type: 'button',
                        class: 'btn btn-secondary accent-green',
                        onclick: e => start(e.currentTarget, async () => {
                            const { session } = await post('/api/work', { cwd: folder.value.trim() });
                            location.hash = `#work/${session.id}`;
                        }),
                    }, 'Start'))),
            status,
        ),
        h('section', { class: 'card', 'aria-label': 'Sessions' },
            h('h2', { class: 'h2-yellow' }, 'Sessions'),
            sessions.length
                ? h('ul', { class: 'rows' }, sessions.map(s => sessionRow(root, s)))
                : h('p', { class: 'meta' }, 'None yet.'),
        ),
    ]);
}

function sessionRow(root, s) {
    const state = STATE(s.state);
    let armed = false;
    return h('li', null,
        h('a', { class: 'row-name', href: `#work/${s.id}` }, s.title),
        h('span', { class: 'row-target' }, s.cwd),
        state ? badge(state) : null,
        h('button', {
            type: 'button',
            class: 'btn btn-ghost',
            title: 'Forget this session’s transcript. The checkout and its commits stay.',
            onclick: async e => {
                if (!armed) {
                    armed = true;
                    e.currentTarget.textContent = 'Forget?';
                    return;
                }
                await post(`/api/work/${s.id}/delete`, {});
                renderList(root);
            },
        }, icon('close', { size: 16, label: 'Forget session' })),
    );
}

// ---- One session ----

function shortPath(p, cwd) {
    return typeof p === 'string' && p.toLowerCase().startsWith(cwd.toLowerCase()) ? p.slice(cwd.length).replace(/^[\\/]/, '') : p;
}

function describeTool(ev, cwd) {
    const i = ev.input ?? {};
    const target = i.file_path ?? i.notebook_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? i.query ?? '';
    const text = `${ev.name.replace(/^mcp__(.+?)__/, '$1 · ')} ${shortPath(String(target), cwd)}`.trim();
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function preview(ev, cwd) {
    const i = ev.input ?? {};
    if (ev.tool === 'Bash') return [i.description && i.description !== ev.description ? h('p', { class: 'meta' }, i.description) : null, h('pre', null, i.command)];
    if (ev.tool === 'Edit' || ev.tool === 'MultiEdit') {
        const edits = i.edits ?? [i];
        return [h('code', null, shortPath(i.file_path, cwd)),
            h('pre', null, edits.map(e => [
                String(e.old_string ?? '').split('\n').map(l => h('span', { class: 'del' }, `- ${l}\n`)),
                String(e.new_string ?? '').split('\n').map(l => h('span', { class: 'add' }, `+ ${l}\n`)),
            ]))];
    }
    if (ev.tool === 'Write') return [h('code', null, shortPath(i.file_path, cwd)), h('pre', null, String(i.content ?? '').split('\n').slice(0, 60).join('\n'))];
    return h('pre', null, JSON.stringify(i, null, 2));
}

function questionForm(ev, answer) {
    const picks = new Map();
    const others = new Map();
    const form = h('div', { class: 'questions' },
        (ev.input.questions ?? []).map(q => {
            picks.set(q.question, new Set());
            const other = h('input', { class: 'input', placeholder: 'Or type an answer', 'aria-label': `Other answer to: ${q.question}` });
            others.set(q.question, other);
            return h('fieldset', null,
                h('legend', null, q.question),
                h('div', { class: 'actions' },
                    q.options.map(o =>
                        h('button', {
                            type: 'button',
                            class: 'btn btn-secondary',
                            title: o.description ?? '',
                            'aria-pressed': 'false',
                            onclick: e => {
                                const set = picks.get(q.question);
                                if (!q.multiSelect) {
                                    set.clear();
                                    for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', 'false');
                                }
                                if (set.has(o.label)) set.delete(o.label);
                                else set.add(o.label);
                                e.currentTarget.setAttribute('aria-pressed', String(set.has(o.label)));
                            },
                        }, o.label)),
                ),
                other,
            );
        }),
        h('div', { class: 'actions' },
            h('button', {
                type: 'button',
                class: 'btn btn-primary',
                onclick: () => {
                    const answers = {};
                    for (const [question, set] of picks) answers[question] = others.get(question).value.trim() || [...set].join(', ');
                    answer('allow', { answers });
                },
            }, 'Answer'),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => answer('deny') }, 'Skip'),
        ),
    );
    return form;
}

function permissionCard(sessionId, ev, cwd) {
    const status = h('span', { class: 'status-line', role: 'status' });
    const reason = h('input', { class: 'input', placeholder: 'Optional: what to do instead', 'aria-label': 'What Claude should do instead' });
    const card = h('li', { class: 'card permission' });
    const answer = async (decision, extra = {}) => {
        for (const b of card.querySelectorAll('button')) b.disabled = true;
        try {
            await post(`/api/work/${sessionId}/permission`, { requestId: ev.requestId, decision, message: reason.value, ...extra });
        } catch (err) {
            statusLine(status, err.message, 'error');
            for (const b of card.querySelectorAll('button')) b.disabled = false;
        }
    };
    const question = ev.tool === 'AskUserQuestion';
    append(card, [
        h('h3', null, question ? 'Claude has a question' : ev.title ?? `Claude wants to use ${ev.tool}`),
        ev.description ? h('p', { class: 'meta' }, ev.description) : null,
        question ? questionForm(ev, answer) : preview(ev, cwd),
        question
            ? null
            : h('div', { class: 'actions' },
                  h('button', { type: 'button', class: 'btn btn-primary', onclick: () => answer('allow') }, 'Allow'),
                  ev.canAlways ? h('button', { type: 'button', class: 'btn btn-secondary accent-green', title: 'Allow this kind of call for the rest of the session', onclick: () => answer('always') }, 'Always allow') : null,
                  h('button', { type: 'button', class: 'btn btn-secondary accent-pink', onclick: () => answer('deny') }, 'Deny'),
                  reason,
              ),
        status,
    ]);
    return {
        card,
        settle(text) {
            card.classList.add('settled');
            for (const b of card.querySelectorAll('button, input')) b.disabled = true;
            statusLine(status, text, text.startsWith('Denied') || text.startsWith('No longer') ? 'error' : 'ok');
        },
    };
}

const DECISION = { allow: 'Allowed', always: 'Allowed for the rest of the session', deny: 'Denied' };

async function renderSession(root, id) {
    const { session } = await get(`/api/work/${id}`);
    const cwd = session.cwd;
    const log = h('ol', { class: 'chat-messages work-log', 'aria-live': 'polite' });
    const tools = new Map();
    const permissions = new Map();
    let liveBubble = null;
    let lastSeq = 0;
    let replayed = false;

    const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 160;
    const add = node => {
        const stick = !replayed || nearBottom();
        log.append(node);
        if (stick && replayed) node.scrollIntoView({ block: 'end' });
        return node;
    };

    // ---- Toolbar ----
    const mode = h('select', {
        class: 'select',
        id: 'work-mode',
        onchange: e => post(`/api/work/${id}/mode`, { mode: e.target.value }).catch(err => statusLine(toolbarStatus, err.message, 'error')),
    }, MODES.map(([v, label]) => h('option', { value: v }, label)));
    mode.value = session.mode;
    const activity = h('span', { class: 'meta work-activity', role: 'status' });
    const toolbarStatus = h('span', { class: 'status-line' });
    const gitText = h('span', { class: 'meta mono' }, 'Checking git…');
    const pushButton = h('button', { type: 'button', class: 'btn btn-secondary accent-orange', hidden: true });
    const stop = h('button', { type: 'button', class: 'btn btn-secondary accent-pink', hidden: true, onclick: () => post(`/api/work/${id}/interrupt`, {}) }, 'Stop');

    let git = null;
    let armTimer = null;
    async function refreshGit() {
        try {
            git = (await get(`/api/work/${id}/git`)).git;
        } catch (err) {
            gitText.textContent = err.message;
            return;
        }
        gitText.textContent = [
            git.branch ?? 'detached HEAD',
            git.ahead ? `↑${git.ahead} to push` : 'nothing to push',
            git.behind ? `↓${git.behind} behind` : null,
            git.changed ? `${git.changed} uncommitted` : null,
        ].filter(Boolean).join(' · ');
        gitText.title = git.recent.join('\n');
        pushButton.hidden = !git.ahead || !git.branch || git.branch.startsWith('io/pr-');
        pushButton.textContent = `Push ${git.ahead === 1 ? '1 commit' : `${git.ahead} commits`}`;
        delete pushButton.dataset.armed;
    }
    pushButton.addEventListener('click', async () => {
        if (!pushButton.dataset.armed) {
            pushButton.dataset.armed = '1';
            pushButton.textContent = `Confirm: push to origin/${git.branch}`;
            clearTimeout(armTimer);
            armTimer = setTimeout(refreshGit, 6000);
            return;
        }
        clearTimeout(armTimer);
        pushButton.disabled = true;
        statusLine(toolbarStatus, 'Pushing…');
        try {
            await post(`/api/work/${id}/push`, {});
            statusLine(toolbarStatus, `Pushed to origin/${git.branch}`, 'ok');
        } catch (err) {
            statusLine(toolbarStatus, err.message, 'error');
        } finally {
            pushButton.disabled = false;
            refreshGit();
        }
    });

    // ---- Composer ----
    const input = h('textarea', { id: 'work-input', rows: 3, placeholder: 'Ask Claude to change something. Enter sends, Shift+Enter for a new line.' });
    const sendMessage = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        try {
            await post(`/api/work/${id}/message`, { text });
        } catch (err) {
            input.value = text;
            statusLine(toolbarStatus, err.message, 'error');
        }
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendMessage();
        }
    });
    const composer = h('form', { class: 'composer work-composer', onsubmit: e => { e.preventDefault(); sendMessage(); } },
        h('div', { class: 'actions quick' },
            QUICK.filter(q => !q.pr || session.pr).map(q =>
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { input.value = q.text; input.focus(); } }, q.label)),
        ),
        h('label', { for: 'work-input', class: 'visually-hidden' }, 'Message to Claude'),
        input,
        h('div', { class: 'composer-actions' },
            h('span', { class: 'footnote' }, 'Runs Claude Code in this folder with the repository’s own CLAUDE.md, settings and skills.'),
            h('button', { type: 'submit', class: 'send', 'aria-label': 'Send', title: 'Send' }, icon('up')),
        ),
    );

    root.replaceChildren(
        h('a', { class: 'back', href: '#work' }, '← All work'),
        h('h1', null, session.title),
        h('p', { class: 'meta' },
            h('code', null, cwd),
            session.pr ? [' · ', h('a', { href: session.pr.url, target: '_blank', rel: 'noopener' }, `PR #${session.pr.number}`)] : null,
            session.analysisId ? [' · ', h('a', { href: `#pr/${session.analysisId}` }, 'Io’s analysis')] : null,
        ),
        h('div', { class: 'work-toolbar' },
            h('label', { for: 'work-mode', class: 'visually-hidden' }, 'Permission mode'),
            mode, activity, stop, h('span', { class: 'spacer' }), gitText, pushButton, toolbarStatus,
        ),
        log,
        composer,
    );
    refreshGit();

    function applyState(s) {
        stop.hidden = !s.busy;
        activity.replaceChildren(...(s.waiting.length ? ['Waiting for you'] : s.busy ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Working…'] : []));
        for (const [requestId, p] of permissions) {
            if (!p.done && !s.waiting.includes(requestId)) {
                p.done = true;
                p.settle('No longer waiting: the session ended before an answer.');
            }
        }
    }

    function render(ev) {
        if (ev.type !== 'delta' && ev.type !== 'state') liveBubble = null;
        switch (ev.type) {
            case 'user':
                add(h('li', { class: 'bubble-user' }, ev.text));
                break;
            case 'delta':
                liveBubble ??= add(h('li', { class: 'bubble-claude' }));
                liveBubble.textContent += ev.text;
                break;
            case 'assistant': {
                const last = log.lastElementChild;
                if (last?.dataset.live) {
                    last.textContent = ev.text;
                    delete last.dataset.live;
                } else add(h('li', { class: 'bubble-claude' }, ev.text));
                break;
            }
            case 'tool': {
                const out = h('pre', { class: 'tool-out', hidden: true });
                const details = h('details', { class: 'tool' },
                    h('summary', null, `→ ${describeTool(ev, cwd)}`),
                    h('pre', null, JSON.stringify(ev.input, null, 2)),
                    out);
                tools.set(ev.id, { details, out });
                add(h('li', { class: 'step' }, details));
                break;
            }
            case 'tool_result': {
                const t = tools.get(ev.id);
                if (!t) break;
                t.out.hidden = false;
                t.out.textContent = ev.text;
                if (ev.error) t.details.classList.add('failed');
                break;
            }
            case 'permission': {
                const p = permissionCard(id, ev, cwd);
                permissions.set(ev.requestId, p);
                add(p.card);
                break;
            }
            case 'permission_answer': {
                const p = permissions.get(ev.requestId);
                if (p && !p.done) {
                    p.done = true;
                    p.settle(ev.answers ? 'Answered' : DECISION[ev.decision]);
                }
                break;
            }
            case 'result':
                add(h('li', { class: ev.ok ? 'step done' : 'error' }, ev.ok ? `Done · ${ev.summary}` : `Stopped: ${ev.error}`));
                if (replayed) {
                    refreshGit();
                    dispatchEvent(new Event('io:usage-changed'));
                }
                break;
            case 'notice':
                add(h('li', { class: 'step' }, ev.text));
                break;
            case 'error':
                add(h('li', { class: 'error' }, ev.text));
                break;
            case 'state':
                applyState(ev);
                if (!replayed) {
                    replayed = true;
                    scrollTo(0, document.documentElement.scrollHeight);
                    input.focus();
                }
                break;
        }
        if (ev.type === 'delta' && liveBubble) liveBubble.dataset.live = '1';
    }

    // One stream per visit: the transcript so far, then live events. It reconnects after Io restarts.
    const abort = new AbortController();
    const route = location.hash;
    addEventListener('hashchange', () => location.hash !== route && abort.abort(), { signal: abort.signal });
    (async () => {
        while (!abort.signal.aborted) {
            try {
                await stream(`/api/work/${id}/events?after=${lastSeq}`, ({ seq, event }) => {
                    if (seq !== null) {
                        if (seq <= lastSeq) return;
                        lastSeq = seq;
                    }
                    render(event);
                }, abort.signal);
            } catch {
                // the server went away; retry below unless the page moved on
            }
            if (abort.signal.aborted) return;
            activity.textContent = 'Reconnecting…';
            await new Promise(r => setTimeout(r, 2000));
        }
    })();
}
