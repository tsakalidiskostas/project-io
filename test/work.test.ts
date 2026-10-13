import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type WorkSessionRecord } from '../src/store.ts';
import { parseBranchStatus, parseWorktrees } from '../src/work/git.ts';
import { clip } from '../src/work/session.ts';

test('worktrees are read with their branches', () => {
    const porcelain = [
        'worktree C:/code/web',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/master',
        '',
        'worktree C:/code/web-pr-12',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/FRNT-1/fix-it',
        '',
        'worktree C:/code/web-detached',
        'HEAD 3333333333333333333333333333333333333333',
        'detached',
        '',
    ].join('\n');
    assert.deepEqual(parseWorktrees(porcelain), [
        { path: path.normalize('C:/code/web'), branch: 'master' },
        { path: path.normalize('C:/code/web-pr-12'), branch: 'FRNT-1/fix-it' },
        { path: path.normalize('C:/code/web-detached'), branch: null },
    ]);
});

test('branch status counts commits to push and uncommitted files', () => {
    assert.deepEqual(parseBranchStatus('## FRNT-1/fix...origin/FRNT-1/fix [ahead 2, behind 1]\n M a.ts\n?? b.ts\n'), {
        branch: 'FRNT-1/fix',
        upstream: 'origin/FRNT-1/fix',
        ahead: 2,
        behind: 1,
        changed: 2,
    });
    assert.deepEqual(parseBranchStatus('## io/pr-7\n'), { branch: 'io/pr-7', upstream: null, ahead: 0, behind: 0, changed: 0 });
    assert.equal(parseBranchStatus('## HEAD (no branch)\n').branch, null);
});

test('long tool inputs are clipped for the transcript', () => {
    const out = clip({ file_path: 'a.ts', content: 'x'.repeat(5000), nested: ['y'.repeat(10)] }, 100) as Record<string, unknown>;
    assert.equal(out.file_path, 'a.ts');
    assert.match(String(out.content), /^x{100}\n… 4900 more characters$/);
    assert.deepEqual(out.nested, ['y'.repeat(10)]);
});

test('work sessions keep their transcript in order and are forgotten whole', () => {
    const store = openStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'io-work-')), 'io.db'));
    const session: WorkSessionRecord = {
        id: '0123456789abcdef',
        createdAt: new Date().toISOString(),
        title: '#1 Fix',
        cwd: 'C:/code/web-pr-1',
        analysisId: 'o__r__1',
        pr: { owner: 'o', repo: 'r', number: 1, url: '', branch: 'fix' },
        claudeSessionId: null,
        mode: 'default',
    };
    store.saveWorkSession(session);
    assert.equal(store.appendWorkEvent(session.id, { type: 'user', text: 'hi' }), 1);
    assert.equal(store.appendWorkEvent(session.id, { type: 'assistant', text: 'hello' }), 2);
    assert.deepEqual(store.workEvents(session.id, 1).map(e => e.event.text), ['hello']);

    store.saveWorkSession({ ...session, mode: 'plan' });
    assert.equal(store.workSession(session.id).mode, 'plan');
    assert.equal(store.workSessions().length, 1);

    store.deleteWorkSession(session.id);
    assert.equal(store.workSessions().length, 0);
    assert.deepEqual(store.workEvents(session.id), []);
    assert.throws(() => store.workSession('../etc'), /Not a work session id/);
});

test('repo paths are keyed by lowercase owner/repo', () => {
    const store = openStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'io-repos-')), 'io.db'));
    store.saveRepoPath('NorskRikstoto/Beta', 'C:/code/beta');
    assert.deepEqual(store.repoPaths(), { 'norskrikstoto/beta': 'C:/code/beta' });
});

test('new work sessions start in auto mode unless Settings say otherwise', () => {
    const store = openStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'io-mode-')), 'io.db'));
    assert.equal(store.workMode(), 'auto');
    store.saveWorkMode('default');
    assert.equal(store.workMode(), 'default');
});
