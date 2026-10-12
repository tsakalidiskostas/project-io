import { getAnalysis } from './js/api.js';
import { initChat, setChatScreen } from './js/chat.js';
import { $, h } from './js/dom.js';
import { renderInbox } from './js/inbox.js';
import { renderSettings } from './js/settings.js';
import { initUsageMeter } from './js/usage-meter.js';

// Hash routes:
//   #inbox[?filter=attention|aligned|nolink|dismissed][&focus=1]   the PR inbox
//   #pr/<id>                    intent report (Overview)
//   #pr/<id>/claims[/<claim>]   claims & code
//   #pr/<id>/flow               behavior flow
//   #settings                   Io's Claude profile and MCP servers
async function route() {
    const [path, query = ''] = location.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    const root = $('app');
    const [screen, id, tab, claimId] = (path || 'inbox').split('/');

    const navKey = screen === 'settings' ? 'settings' : 'inbox';
    for (const link of document.querySelectorAll('.app-nav a')) {
        if (link.dataset.nav === navKey) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
    root.classList.toggle('pr-screen', screen === 'pr');

    try {
        if (screen === 'settings') {
            setChatScreen('Settings');
            await renderSettings(root);
        } else if (screen === 'pr' && id) {
            const run = Number(params.get('run')) || undefined;
            const analysis = await getAnalysis(id, { run });
            const label = { claims: 'Claims & code', flow: 'Behavior flow' }[tab] ?? 'Overview';
            setChatScreen(`PR #${analysis.pr.number} · ${label}`);
            if (tab === 'claims') (await import('./js/claims.js')).renderClaims(root, analysis, claimId);
            else if (tab === 'flow') await (await import('./js/flow.js')).renderFlow(root, analysis);
            else (await import('./js/report.js')).renderReport(root, analysis);
        } else {
            setChatScreen('Pull requests');
            await renderInbox(root, params);
        }
    } catch (err) {
        root.replaceChildren(
            h('a', { class: 'back', href: '#inbox' }, '← All pull requests'),
            h('section', { class: 'card', style: 'background: var(--ir-missing-tint)' }, h('h2', { class: 'error' }, 'Something went wrong'), h('p', null, err.message)),
        );
    }
    if (!location.hash.includes('/claims/')) scrollTo(0, 0);
}

addEventListener('hashchange', route);
await initChat();
initUsageMeter();
await route();
