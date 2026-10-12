import { get, post } from './api.js';
import { badge, h, statusLine } from './dom.js';

const SERVER_STATUS = {
    connected: { label: 'Connected', cls: 'v-delivered' },
    'needs-auth': { label: 'Needs sign-in', cls: 'v-partial' },
    failed: { label: 'Failed', cls: 'v-missing' },
    unknown: { label: 'Unknown', cls: 'v-neutral' },
};

export async function renderSettings(root) {
    const auth = h('p', { class: 'meta', role: 'status' }, 'Checking…');
    const dir = h('code', null, '…');
    const servers = h('ul', { class: 'rows' }, h('li', { class: 'meta' }, 'Checking…'));
    const importArea = h('div', null, h('p', { class: 'meta' }, 'Checking…'));
    const importStatus = h('p', { class: 'status-line', role: 'status' });

    root.replaceChildren(
        h('h1', null, 'Settings'),
        h('section', { class: 'card', 'aria-label': 'Claude profile' },
            h('h2', { class: 'h2-yellow' }, 'Io’s Claude profile'),
            h('p', null, 'Io runs Claude Code in a profile of its own, whichever shell or profile you start it from. Its login and MCP servers live in ', dir, '. GitHub goes through the GitHub CLI (', h('code', null, 'gh auth login'), ').'),
            auth,
        ),
        h('section', { class: 'card', 'aria-label': 'MCP servers' },
            h('h2', { class: 'h2-green' }, 'MCP servers in Io'),
            servers,
            h('p', { class: 'meta' }, 'A server marked “needs sign-in”: run ', h('code', null, 'npm run claude'), ' in Io’s folder, type ', h('code', null, '/mcp'), ', pick the server and choose Authenticate.'),
        ),
        h('section', { class: 'card', 'aria-label': 'Import MCP servers' },
            h('h2', { class: 'h2-purple' }, 'Import from your other Claude profiles'),
            h('p', { class: 'meta' }, 'Copies a server’s definition into Io’s profile. Sign-ins don’t carry over, so servers that use OAuth need one sign-in in Io.'),
            importArea,
            importStatus,
        ),
    );

    let profile;
    try {
        profile = await get('/api/profile');
    } catch (err) {
        auth.textContent = `Could not read Io’s profile: ${err.message}`;
        return;
    }
    dir.textContent = profile.dir;
    auth.textContent = profile.auth.loggedIn
        ? `Signed in${profile.auth.email ? ` as ${profile.auth.email}` : ''} (${profile.auth.authMethod}).`
        : 'Not signed in. In Io’s folder, run:  npm run claude -- auth login';

    servers.replaceChildren(
        ...(profile.servers.length
            ? profile.servers.map(s => h('li', null, h('span', { class: 'row-name' }, s.name), h('span', { class: 'row-target' }, s.target), badge(SERVER_STATUS[s.status])))
            : [h('li', { class: 'meta' }, 'None yet. Import some below. Connectors from your claude.ai account are available too.')]),
    );

    importArea.replaceChildren();
    if (!profile.importable.length) importArea.append(h('p', { class: 'meta' }, 'No other Claude profiles with MCP servers were found.'));
    for (const p of profile.importable) {
        importArea.append(
            h('h3', { class: 'profile-label eyebrow' }, p.label),
            h('ul', { class: 'rows' },
                p.servers.map(s =>
                    h('li', null,
                        h('span', { class: 'row-name' }, s.name),
                        h('span', { class: 'row-target' }, `${s.target} · ${s.scope}`),
                        s.inIo
                            ? badge({ label: 'In Io', cls: 'v-neutral' })
                            : h('button', {
                                  type: 'button',
                                  class: 'btn btn-secondary accent-purple',
                                  'aria-label': `Import ${s.name} from ${p.label}`,
                                  onclick: async e => {
                                      e.currentTarget.disabled = true;
                                      statusLine(importStatus, `Importing ${s.name}…`);
                                      try {
                                          await post('/api/profile/import', { profile: p.label, name: s.name, scope: s.scope });
                                          await renderSettings(root);
                                      } catch (err) {
                                          statusLine(importStatus, `Could not import ${s.name}: ${err.message}`, 'error');
                                      }
                                  },
                              }, 'Import'),
                    ),
                ),
            ),
        );
    }
}
