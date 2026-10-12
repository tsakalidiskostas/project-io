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
    url: string;
    additions: number;
    deletions: number;
    changedFiles: number;
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
    const fields = 'title,body,url,additions,deletions,changedFiles,author,state,baseRefName,headRefName,baseRefOid,headRefOid,commits,files';
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

export async function postPrComment(ref: PrRef, body: string): Promise<string> {
    const out = await runOrThrow('gh', ['pr', 'comment', String(ref.number), '--repo', slug(ref), '--body', body]);
    return out.trim();
}

// Inline comments must target a line inside the diff; GitHub answers 422 otherwise.
export async function postInlineComment(ref: PrRef, commitId: string, path: string, line: number, body: string): Promise<string> {
    const out = await runOrThrow('gh', [
        'api',
        `repos/${slug(ref)}/pulls/${ref.number}/comments`,
        '-f', `body=${body}`,
        '-f', `commit_id=${commitId}`,
        '-f', `path=${path}`,
        '-F', `line=${line}`,
        '-f', 'side=RIGHT',
        '--jq', '.html_url',
    ]);
    return out.trim();
}

export async function fetchPrState(ref: PrRef): Promise<{ state: string; headRefOid: string }> {
    return JSON.parse(await runOrThrow('gh', ['pr', 'view', String(ref.number), '--repo', slug(ref), '--json', 'state,headRefOid']));
}

// Branch names are not searchable, so this finds PRs whose title or body names the issue key.
export async function findPrsForIssue(key: string): Promise<{ url: string; title: string; state: string }[]> {
    const out = await runOrThrow('gh', ['search', 'prs', key, '--limit', '10', '--json', 'url,title,state']);
    return JSON.parse(out);
}

interface ReviewView {
    state: string;
    reviewDecision: string;
    author: { login: string };
    latestReviews: { author: { login: string }; state: string; submittedAt: string }[];
}

export interface ReviewState {
    viewer: string;
    mine: string | null;
    open: boolean;
    ownPr: boolean;
    decision: string;
}

// GitHub logins are case-insensitive.
export function reviewState(viewer: string, view: ReviewView): ReviewState {
    const same = (login: string) => login.toLowerCase() === viewer.toLowerCase();
    const mine = view.latestReviews.filter(r => same(r.author.login)).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    return { viewer, mine: mine?.state ?? null, open: view.state === 'OPEN', ownPr: same(view.author.login), decision: view.reviewDecision };
}

export async function fetchReviewState(ref: PrRef): Promise<ReviewState> {
    const [viewer, view] = await Promise.all([
        runOrThrow('gh', ['api', 'user', '--jq', '.login']),
        runOrThrow('gh', ['pr', 'view', String(ref.number), '--repo', slug(ref), '--json', 'state,reviewDecision,author,latestReviews']),
    ]);
    return reviewState(viewer.trim(), JSON.parse(view));
}

// An approving review, as the user's gh login. Never merges.
export async function approvePr(ref: PrRef, body: string): Promise<void> {
    await runOrThrow('gh', ['pr', 'review', String(ref.number), '--repo', slug(ref), '--approve', ...(body.trim() ? ['--body', body] : [])]);
}
