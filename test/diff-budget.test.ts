import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDiff } from '../src/explain.ts';

const file = (name: string, size: number) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${'+'.repeat(size)}\n`;

test('keeps a diff that fits untouched', () => {
    const diff = file('a.ts', 10) + file('b.ts', 10);
    assert.deepEqual(budgetDiff(diff, 10_000), { text: diff, omittedFiles: [] });
});

test('drops whole files, largest first, and names them', () => {
    const diff = file('small.ts', 10) + file('huge.lock', 5_000) + file('mid.ts', 200);
    const result = budgetDiff(diff, 1_000);
    assert.deepEqual(result.omittedFiles, ['huge.lock']);
    assert.ok(result.text.includes('small.ts') && result.text.includes('mid.ts'));
    assert.ok(!result.text.includes('huge.lock'));
});
