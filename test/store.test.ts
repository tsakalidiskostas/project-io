import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Analysis } from '../src/analysis.ts';
import { openStore } from '../src/store.ts';

function analysis(number: number, overrides: Partial<Analysis> = {}): Analysis {
    return {
        id: `o__r__${number}`,
        createdAt: new Date(2026, 9, number).toISOString(),
        model: 'sonnet → sonnet',
        pr: { owner: 'o', repo: 'r', number, title: `PR ${number}`, url: '', author: 'a', headRefOid: 'abc', filesChanged: 1, additions: 1, deletions: 0 },
        issue: { key: 'FRNT-1', title: '', url: '' },
        sources: [],
        verdict: { summary: '' },
        claims: [],
        unclaimed: [{ title: 'u', path: 'a', line: 1, why: 'w', expected: false }],
        flow: { before: '', nodes: [], edges: [] },
        status: 'review',
        ...overrides,
    };
}

const fresh = () => openStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'io-store-')), 'io.db'));

test('keeps analyses across reopening the database', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'io-store-')), 'io.db');
    openStore(file).save(analysis(1));
    assert.equal(openStore(file).get('o__r__1').pr.title, 'PR 1');
});

test('lists newest first and replaces an analysis on re-analyze', () => {
    const store = fresh();
    store.save(analysis(1));
    store.save(analysis(2));
    store.save(analysis(1, { createdAt: new Date(2026, 9, 9).toISOString(), verdict: { summary: 'again' } }));
    assert.deepEqual(store.list().map(s => s.id), ['o__r__1', 'o__r__2']);
    assert.equal(store.get('o__r__1').verdict.summary, 'again');
});

test('dismissing moves a PR out of the inbox; restoring brings it back', () => {
    const store = fresh();
    store.save(analysis(1));
    store.save(analysis(2));
    store.dismiss('o__r__1', 'manual');
    assert.deepEqual(store.list().map(s => s.id), ['o__r__2']);
    assert.deepEqual(store.list({ dismissed: true }).map(s => [s.id, s.dismissReason]), [['o__r__1', 'manual']]);
    store.restore('o__r__1');
    assert.equal(store.list().length, 2);
});

test('re-analyzing a dismissed PR puts it back in the inbox', () => {
    const store = fresh();
    store.save(analysis(1));
    store.dismiss('o__r__1', 'manual');
    store.save(analysis(1));
    assert.equal(store.list().length, 1);
});

test('summaries carry counts, status, and whether the PR moved on since analysis', () => {
    const store = fresh();
    store.save(analysis(1));
    store.recordPrState('o__r__1', 'OPEN', 'def');
    const [s] = store.list();
    assert.equal(s.unclaimed, 1);
    assert.equal(s.status, 'review');
    assert.equal(s.stale, true);
});

test('merged PRs are offloaded automatically', () => {
    const store = fresh();
    store.save(analysis(1));
    store.recordPrState('o__r__1', 'MERGED', 'abc');
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ dismissed: true })[0].dismissReason, 'merged');
});

test('only PRs not checked recently are due a state check', () => {
    const store = fresh();
    store.save(analysis(1));
    store.save(analysis(2));
    store.recordPrState('o__r__1', 'OPEN', 'abc');
    assert.deepEqual(store.dueForStateCheck(10 * 60_000), ['o__r__2']);
});

test('rejects ids that are not analysis ids', () => {
    assert.throws(() => fresh().get('../../etc'), /Not an analysis id/);
});

test('keeps every run of a PR; the inbox and plain get use the latest', () => {
    const store = fresh();
    store.save(analysis(1, { verdict: { summary: 'first' } }));
    store.save(analysis(1, { verdict: { summary: 'second' } }));
    assert.equal(store.get('o__r__1').verdict.summary, 'second');
    assert.equal(store.get('o__r__1', 1).verdict.summary, 'first');
    assert.deepEqual(store.runs('o__r__1').map(r => r.n), [1, 2]);
    assert.equal(store.list().length, 1);
});

test('changing an older run leaves the latest alone', () => {
    const store = fresh();
    store.save(analysis(1));
    store.save(analysis(1));
    store.update('o__r__1', a => (a.unclaimed[0].expected = true), 1);
    assert.equal(store.get('o__r__1', 1).unclaimed[0].expected, true);
    assert.equal(store.get('o__r__1').unclaimed[0].expected, false);
    store.update('o__r__1', a => (a.unclaimed[0].expected = true));
    assert.equal(store.get('o__r__1', 2).unclaimed[0].expected, true);
    assert.equal(store.list()[0].unclaimed, 0);
});

test('asking for a run that does not exist fails clearly', () => {
    const store = fresh();
    store.save(analysis(1));
    assert.throws(() => store.get('o__r__1', 5), /No run 5/);
});

test('analyses saved before run history become run 1', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'io-store-')), 'io.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE analyses (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, pr_state TEXT, head_oid TEXT, state_checked_at INTEGER, dismissed_at TEXT, dismiss_reason TEXT)');
    old.prepare('INSERT INTO analyses (id, json, created_at) VALUES (?, ?, ?)').run('o__r__1', JSON.stringify(analysis(1)), analysis(1).createdAt);
    old.close();
    assert.deepEqual(openStore(file).runs('o__r__1').map(r => r.n), [1]);
});
