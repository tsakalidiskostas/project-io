import path from 'node:path';

// The supervisor and this guard are what make a bad self-edit recoverable, so the agent may read
// them but never rewrite them — a guardrail the agent can edit is not a guardrail.
const WRITE_PROTECTED = ['scripts/supervisor.ts', 'src/self-edit/guard.ts', 'package-lock.json'];
const NEVER_TOUCH = ['.git', '.env', 'node_modules', 'data'];

export class GuardError extends Error {}

function resolveInside(root: string, requested: string): { absolute: string; relative: string } {
    const absolute = path.resolve(root, requested.replaceAll('\\', '/'));
    const relative = path.relative(root, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new GuardError(`path escapes the project root: ${requested}`);
    }
    return { absolute, relative: relative.split(path.sep).join('/').toLowerCase() };
}

function isUnder(relative: string, entries: string[]): boolean {
    return entries.some(e => relative === e || relative.startsWith(`${e}/`) || relative.startsWith(`${e}.`));
}

export function resolveReadablePath(root: string, requested: string): string {
    const { absolute, relative } = resolveInside(root, requested);
    if (isUnder(relative, NEVER_TOUCH)) throw new GuardError(`path is protected: ${requested}`);
    return absolute;
}

export function resolveEditablePath(root: string, requested: string): string {
    const absolute = resolveReadablePath(root, requested);
    const { relative } = resolveInside(root, requested);
    if (WRITE_PROTECTED.includes(relative)) throw new GuardError(`path is protected: ${requested}`);
    return absolute;
}
