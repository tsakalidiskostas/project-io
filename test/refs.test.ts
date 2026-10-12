import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrRef } from '../src/github.ts';
import { extractIssueKey } from '../src/linear.ts';

test('parses a PR URL', () => {
    assert.deepEqual(parsePrRef('https://github.com/NorskRikstoto/beta.rikstoto.no/pull/11975'), {
        owner: 'NorskRikstoto',
        repo: 'beta.rikstoto.no',
        number: 11975,
    });
});

test('parses a PR URL with a trailing tab path', () => {
    assert.equal(parsePrRef('https://github.com/o/r/pull/7/files').number, 7);
});

test('parses owner/repo#number shorthand', () => {
    assert.deepEqual(parsePrRef(' o/r#12 '), { owner: 'o', repo: 'r', number: 12 });
});

test('rejects anything else', () => {
    assert.throws(() => parsePrRef('https://gitlab.com/o/r/pull/1'));
    assert.throws(() => parsePrRef('12'));
});

test('extracts a Linear key from the branch, normalised to upper case', () => {
    assert.equal(extractIssueKey('BACK-3619/send-client-id-on-logout'), 'BACK-3619');
    assert.equal(extractIssueKey('back-2920'), 'BACK-2920');
    assert.equal(extractIssueKey('feature/AI-12-thing'), 'AI-12');
});

test('returns null when the branch carries no key', () => {
    assert.equal(extractIssueKey('master'), null);
    assert.equal(extractIssueKey('release-2024'), null);
});
