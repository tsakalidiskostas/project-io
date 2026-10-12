import { run, runOrThrow } from '../run.ts';

export const SELF_EDIT_TRAILER = 'Self-Edit: true';

export async function isClean(root: string): Promise<boolean> {
    return (await runOrThrow('git', ['status', '--porcelain'], root)).trim() === '';
}

export async function changedFiles(root: string): Promise<string[]> {
    const out = await runOrThrow('git', ['status', '--porcelain'], root);
    return out.split('\n').filter(Boolean).map(line => line.slice(3));
}

export async function listFiles(root: string): Promise<string[]> {
    const out = await runOrThrow('git', ['ls-files', '--cached', '--others', '--exclude-standard'], root);
    return out.split('\n').filter(Boolean);
}

export async function commitAll(root: string, message: string): Promise<string> {
    await runOrThrow('git', ['add', '-A'], root);
    const result = await run('git', ['commit', '-q', '-m', message], root);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return (await runOrThrow('git', ['rev-parse', '--short', 'HEAD'], root)).trim();
}

// Safe only because a self-edit refuses to start on a dirty tree: everything this drops is the agent's.
export async function discardAll(root: string): Promise<void> {
    await runOrThrow('git', ['restore', '--staged', '--worktree', '.'], root);
    await runOrThrow('git', ['clean', '-fdq'], root);
}

export async function revertLastSelfEdit(root: string): Promise<string> {
    const body = await runOrThrow('git', ['log', '-1', '--format=%B'], root);
    if (!body.includes(SELF_EDIT_TRAILER)) throw new Error('The last commit is not a self-edit, so there is nothing to undo.');
    await runOrThrow('git', ['revert', '--no-edit', 'HEAD'], root);
    return (await runOrThrow('git', ['rev-parse', '--short', 'HEAD'], root)).trim();
}
