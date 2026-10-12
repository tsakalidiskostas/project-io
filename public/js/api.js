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

const cache = new Map();

export async function getAnalysis(id, { fresh = false } = {}) {
    if (fresh || !cache.has(id)) cache.set(id, get(`/api/analyses/${encodeURIComponent(id)}`).then(d => d.analysis));
    try {
        return await cache.get(id);
    } catch (err) {
        cache.delete(id);
        throw err;
    }
}

export function setCachedAnalysis(analysis) {
    cache.set(analysis.id, Promise.resolve(analysis));
}
