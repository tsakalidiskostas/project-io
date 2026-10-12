import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseExplainModel } from '../src/model-choice.ts';

test('docs-only PRs go to Haiku', () => {
    const c = chooseExplainModel({ diffChars: 8_000, files: ['README.md', 'docs/setup.md'] });
    assert.equal(c.model, 'haiku');
});

test('small code PRs go to Sonnet at medium effort', () => {
    const c = chooseExplainModel({ diffChars: 12_000, files: ['src/a.ts', 'src/b.ts', 'README.md'] });
    assert.deepEqual([c.model, c.effort], ['sonnet', 'medium']);
});

test('a small diff spread over many files still goes to Opus', () => {
    const c = chooseExplainModel({ diffChars: 12_000, files: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`) });
    assert.equal(c.model, 'opus');
});

test('large PRs go to Opus, and the largest at high effort', () => {
    assert.deepEqual(Object.values(chooseExplainModel({ diffChars: 80_000, files: ['src/a.ts'] })).slice(0, 2), ['opus', 'medium']);
    assert.deepEqual(Object.values(chooseExplainModel({ diffChars: 400_000, files: ['src/a.ts'] })).slice(0, 2), ['opus', 'high']);
});

test('every choice explains itself', () => {
    assert.ok(chooseExplainModel({ diffChars: 1, files: ['a.ts'] }).reason.length > 0);
});
