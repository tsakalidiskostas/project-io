// Every POST carries X-Io: the server rejects posts without it, which a foreign page cannot add
// without a CORS preflight the server never answers.
export async function post(url, body, onEvent) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Io': '1' },
        body: JSON.stringify(body ?? {}),
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

export async function get(url) {
    const data = await (await fetch(url)).json();
    if (!data.ok) throw new Error(data.error);
    return data;
}

// Only explicit runs are cached: "latest" changes whenever the PR is re-analyzed.
const cache = new Map();

export async function getAnalysis(id, { run, fresh = false } = {}) {
    const url = `/api/analyses/${encodeURIComponent(id)}${run ? `?run=${run}` : ''}`;
    if (!run) return (await get(url)).analysis;
    const key = `${id}#${run}`;
    if (fresh || !cache.has(key)) cache.set(key, get(url).then(d => d.analysis));
    try {
        return await cache.get(key);
    } catch (err) {
        cache.delete(key);
        throw err;
    }
}

export function setCachedAnalysis(analysis) {
    cache.set(`${analysis.id}#${analysis.run}`, Promise.resolve(analysis));
}

// The run's query suffix for links; empty for the latest run, so links stay short.
export function runQuery(a) {
    return a.run && a.run !== a.runs?.at(-1)?.n ? `?run=${a.run}` : '';
}

export function prLink(a, path = '') {
    return `#pr/${a.id}${path}${runQuery(a)}`;
}

// API calls always name the run, so an action applies to the run on screen.
export function analysisApi(a, path) {
    return `/api/analyses/${encodeURIComponent(a.id)}${path}?run=${a.run}`;
}
