import { get } from './api.js';
import { $, h } from './dom.js';

const POLL_MS = 120_000;

// Reset times arrive a fraction of a second before the minute (11:49:59.7); round to the nearest minute.
const nearestMinute = iso => new Date(Math.round(Date.parse(iso) / 60_000) * 60_000);
const time = iso => nearestMinute(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = iso => nearestMinute(iso).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Green until 70 %, orange until 90 %, pink beyond: the same verdict colours the rest of the app uses.
const level = percent => (percent >= 90 ? 'v-missing' : percent >= 70 ? 'v-partial' : 'v-delivered');

function render(usage) {
    const meter = $('usage-meter');
    if (!usage.available) return void (meter.hidden = true);
    const { session, week } = usage;
    const resets = session.resetsAt ? ` · resets ${time(session.resetsAt)}` : '';
    meter.className = `usage-meter ${level(session.percent)}`;
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(session.percent));
    meter.setAttribute('aria-label', `Claude session usage ${session.percent} percent${resets}`);
    meter.title = [
        `Session (5-hour window): ${session.percent}%${session.resetsAt ? `, resets ${time(session.resetsAt)}` : ''}`,
        week ? `Week: ${week.percent}%${week.resetsAt ? `, resets ${day(week.resetsAt)}` : ''}` : null,
        usage.plan ? `Plan: ${usage.plan}` : null,
    ].filter(Boolean).join('\n');
    meter.replaceChildren(
        h('span', { class: 'eyebrow' }, 'Session'),
        h('span', { class: 'usage-bar' }, h('span', { style: `width: ${session.percent}%` })),
        h('b', null, `${session.percent}%`),
        session.resetsAt && session.percent >= 70 ? h('span', { class: 'meta' }, `resets ${time(session.resetsAt)}`) : null,
    );
    meter.hidden = false;
}

async function refresh(fresh = false) {
    try {
        render((await get(`/api/usage${fresh ? '?fresh=1' : ''}`)).usage);
    } catch {
        $('usage-meter').hidden = true;
    }
}

export function initUsageMeter() {
    refresh();
    setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
    addEventListener('io:usage-changed', () => refresh(true));
    addEventListener('focus', () => refresh());
}
