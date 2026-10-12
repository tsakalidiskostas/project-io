import { run, runOrThrow } from './run.ts';

export interface PrRef {
    owner: string;
    repo: string;
    number: number;
}

export interface PullRequest {
    ref: PrRef;
    title: string;
    body: string;
    author: string;
    state: string;
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    commits: { messageHeadline: string; messageBody: string }[];
    files: { path: string; additions: number; deletions: number }[];
    diff: string;
}

export function parsePrRef(input: string): PrRef {
    const s = input.trim();
    const url = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const short = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    const m = url ?? short;
    if (!m) throw new Error('Expected a GitHub PR URL or owner/repo#number');
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const slug = (ref: PrRef) => `${ref.owner}/${ref.repo}`;

// `gh` rather than a token of our own: it already holds the user's GitHub login, private orgs included.
export async function fetchPullRequest(ref: PrRef): Promise<PullRequest> {
    const fields = 'title,body,author,state,baseRefName,headRefName,baseRefOid,headRefOid,commits,files';
    const [json, diff] = await Promise.all([
        runOrThrow('gh', ['pr', 'view', String(ref.number), '--repo', slug(ref), '--json', fields]),
        runOrThrow('gh', ['pr', 'diff', String(ref.number), '--repo', slug(ref)]),
    ]);
    const pr = JSON.parse(json);
    return { ...pr, ref, author: pr.author?.login ?? 'unknown', diff };
}

export async function readRepoFile(ref: PrRef, sha: string, filePath: string): Promise<string> {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const result = await run('gh', [
        'api',
        `repos/${slug(ref)}/contents/${encoded}?ref=${sha}`,
        '-H',
        'Accept: application/vnd.github.raw+json',
    ]);
    if (result.code !== 0) return `ERROR: could not read ${filePath} at ${sha.slice(0, 7)}: ${result.stderr.trim()}`;
    return result.stdout;
}

export async function searchRepoCode(ref: PrRef, query: string): Promise<string> {
    const result = await run('gh', ['search', 'code', query, '--repo', slug(ref), '--limit', '20', '--json', 'path,textMatches']);
    if (result.code !== 0) return `ERROR: search failed: ${result.stderr.trim()}`;
    const hits: { path: string; textMatches: { fragment: string }[] }[] = JSON.parse(result.stdout);
    if (hits.length === 0) return 'No matches (note: GitHub code search only indexes the default branch).';
    return hits.map(h => `${h.path}\n${h.textMatches.map(t => `  ${t.fragment.trim()}`).join('\n')}`).join('\n\n');
}
