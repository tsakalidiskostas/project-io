import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveEditablePath, resolveReadablePath } from '../src/self-edit/guard.ts';

const root = path.resolve('/tmp/io-root');

test('resolves an ordinary source path inside the root', () => {
    assert.equal(resolveEditablePath(root, 'src/explain.ts'), path.join(root, 'src', 'explain.ts'));
});

test('rejects paths that escape the root', () => {
    assert.throws(() => resolveEditablePath(root, '../outside.ts'), /escapes/);
    assert.throws(() => resolveEditablePath(root, path.resolve('/etc/passwd')), /escapes/);
    assert.throws(() => resolveEditablePath(root, 'src/../../x'), /escapes/);
});

test('rejects writes to protected paths, whatever the casing or separator', () => {
    for (const p of [
        '.git/config',
        '.env',
        '.env.local',
        'node_modules/zod/index.js',
        'scripts/supervisor.ts',
        'src/self-edit/guard.ts',
        'SRC\\Self-Edit\\Guard.ts',
    ]) {
        assert.throws(() => resolveEditablePath(root, p), /protected/, p);
    }
});

test('allows reading protected source files but never secrets or .git', () => {
    assert.equal(resolveReadablePath(root, 'src/self-edit/guard.ts'), path.join(root, 'src', 'self-edit', 'guard.ts'));
    assert.throws(() => resolveReadablePath(root, '.env'), /protected/);
    assert.throws(() => resolveReadablePath(root, '.git/HEAD'), /protected/);
});
