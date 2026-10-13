import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePrefetch, isNoisePath, numbered, splitNoise } from '../src/diff-prep.ts';

test('recognises lockfiles, generated code, snapshots and binaries as noise', () => {
    for (const p of [
        'package-lock.json',
        'src/Web/yarn.lock',
        'pnpm-lock.yaml',
        'src/Web/@codegen/api.ts',
        'src/Api/Generated/Client.g.cs',
        'src/Tests/Production_webapi_signature.snapshot',
        'src/app/__snapshots__/view.test.ts.snap',
        'dist/app.min.js',
        'assets/logo.png',
    ]) assert.ok(isNoisePath(p), p);
    for (const p of ['src/app/cart.effects.ts', 'README.md', 'src/Api/Controllers/AccountApiController.cs', 'package.json']) {
        assert.ok(!isNoisePath(p), p);
    }
});

test('splits noise files out of a diff, keeping the rest whole', () => {
    const chunk = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`;
    const { diff, noise } = splitNoise(chunk('src/a.ts') + chunk('package-lock.json') + chunk('src/b.ts'));
    assert.deepEqual(noise, ['package-lock.json']);
    assert.equal(diff, chunk('src/a.ts') + chunk('src/b.ts'));
});

test('prefetches the most-changed files that fit, skipping oversized ones', () => {
    const files = [
        { path: 'small.ts', changes: 5, size: 1_000 },
        { path: 'busy.ts', changes: 300, size: 30_000 },
        { path: 'huge.ts', changes: 900, size: 500_000 },
        { path: 'mid.ts', changes: 40, size: 50_000 },
    ];
    assert.deepEqual(choosePrefetch(files, { budget: 60_000, perFile: 60_000 }), ['busy.ts', 'small.ts']);
});

test('numbers lines so the model can cite real line numbers', () => {
    assert.equal(numbered('a\nb'), '1: a\n2: b');
});
