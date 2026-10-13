import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, runOrThrow } from '../run.ts';

export interface Worktree {
    path: string;
    branch: string | null;
}

// `git worktree list --porcelain`: blank-line separated blocks of "worktree <path>", "branch refs/heads/<name>".
export function parseWorktrees(porcelain: string): Worktree[] {
    return porcelain
        .split(/\r?\n\r?\n/)
        .map(block => {
            const lines = block.split(/\r?\n/);
            const wt = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length);
            const branch = lines.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
            return wt ? { path: path.normalize(wt), branch } : null;
        })
        .filter((w): w is Worktree => w !== null);
}

export interface BranchStatus {
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    changed: number;
}

// `git status --porcelain=v1 -b`: "## main...origin/main [ahead 1, behind 2]" then one line per changed file.
export function parseBranchStatus(porcelain: string): BranchStatus {
    const [head = '', ...files] = porcelain.split(/\r?\n/).filter(Boolean);
    const m = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
    const branch = m && !m[1].startsWith('HEAD (no branch)') ? m[1] : null;
    const counts = m?.[3] ?? '';
    return {
        branch,
        upstream: m?.[2] ?? null,
        ahead: Number(counts.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(counts.match(/behind (\d+)/)?.[1] ?? 0),
        changed: files.length,
    };
}

export async function originSlug(repoPath: string): Promise<string | null> {
    const r = await run('git', ['remote', 'get-url', 'origin'], repoPath);
    const m = r.stdout.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export interface PrHead {
    number: number;
    headRefName: string;
    isCrossRepository: boolean;
}

// The branch a fork's PR, or one whose branch is gone, is fetched into; Io cannot push those back.
export const forkBranch = (n: number) => `io/pr-${n}`;

// A checkout of the PR's branch that leaves the user's own working copy alone: an existing worktree on
// that branch if there is one, otherwise a new worktree beside the clone.
export async function prepareWorktree(repoPath: string, pr: PrHead): Promise<{ cwd: string; created: boolean }> {
    // A merged PR's branch is often deleted; its head is still reachable read-only, like a fork's.
    const fetchable = !pr.isCrossRepository && (await run('git', ['ls-remote', '--exit-code', '--heads', 'origin', pr.headRefName], repoPath)).code === 0;
    if (!fetchable) pr = { ...pr, isCrossRepository: true };
    const branch = pr.isCrossRepository ? forkBranch(pr.number) : pr.headRefName;
    const existing = parseWorktrees(await runOrThrow('git', ['worktree', 'list', '--porcelain'], repoPath)).find(w => w.branch === branch);
    if (existing) return { cwd: existing.path, created: false };

    const target = `${path.resolve(repoPath)}-pr-${pr.number}`;
    if (existsSync(target)) throw new Error(`${target} already exists but is not a worktree on ${branch}. Move it aside and try again.`);

    if (pr.isCrossRepository) {
        await runOrThrow('git', ['fetch', 'origin', `pull/${pr.number}/head:${branch}`], repoPath);
        await runOrThrow('git', ['worktree', 'add', target, branch], repoPath);
    } else {
        await runOrThrow('git', ['fetch', 'origin', branch], repoPath);
        const local = (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)).code === 0;
        await runOrThrow('git', local ? ['worktree', 'add', target, branch] : ['worktree', 'add', '--track', '-b', branch, target, `origin/${branch}`], repoPath);
    }
    return { cwd: target, created: true };
}

export async function branchStatus(cwd: string): Promise<BranchStatus & { recent: string[] }> {
    const [status, log] = await Promise.all([
        runOrThrow('git', ['status', '--porcelain=v1', '-b'], cwd),
        run('git', ['log', '--format=%h %s', '-5'], cwd),
    ]);
    return { ...parseBranchStatus(status), recent: log.stdout.split(/\r?\n/).filter(Boolean) };
}

// Pushes the checked-out branch to the same-named branch on origin, so a PR branch updates its PR.
export async function pushBranch(cwd: string): Promise<string> {
    const { branch } = parseBranchStatus(await runOrThrow('git', ['status', '--porcelain=v1', '-b'], cwd));
    if (!branch) throw new Error('Nothing to push: the checkout is not on a branch.');
    if (branch.startsWith('io/pr-')) throw new Error('This checkout is the PR’s head fetched read-only (a fork, or a deleted branch), so Io cannot push it.');
    const r = await run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], cwd);
    if (r.code !== 0) throw new Error(`git push failed: ${r.stderr.trim()}`);
    return `${r.stdout}${r.stderr}`.trim();
}
