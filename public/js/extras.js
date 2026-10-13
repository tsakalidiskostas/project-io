import { analysisApi, post } from './api.js';

// Builds that run once per run, the first time their screen is opened: 'flow' and 'comments'.
// A job outlives the screen that started it; whichever screen is showing listens for progress.
const jobs = new Map();

const describe = e => {
    if (e.type === 'phase') return e.label;
    if (e.type === 'tool') return `${e.name.replace(/^mcp__io__/, '')} ${e.input?.path ?? e.input?.query ?? ''}`.trim();
    if (e.type === 'model') return `${e.model}, ${e.effort} effort`;
    return null;
};

export function extraJob(a, kind) {
    const key = `${a.id}#${a.run}#${kind}`;
    let job = jobs.get(key);
    if (job) return job;
    job = { status: 'Starting…', error: null, listeners: new Set() };
    const notify = () => job.listeners.forEach(fn => fn(job));
    job.done = post(analysisApi(a, `/${kind}`), {}, e => {
        if (e.type === 'error') job.error = e.error;
        job.status = describe(e) ?? job.status;
        notify();
    }).then(() => {
        if (job.error) throw new Error(job.error);
        dispatchEvent(new Event('io:usage-changed'));
    }).catch(err => {
        jobs.delete(key); // so the screen can offer a retry
        job.error = err.message;
        notify();
        throw err;
    });
    jobs.set(key, job);
    return job;
}
