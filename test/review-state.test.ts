import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewState } from '../src/github.ts';

const review = (login: string, state: string, submittedAt: string) => ({ author: { login }, state, submittedAt });

test('finds the viewer’s latest review, ignoring other reviewers', () => {
    const state = reviewState('me', {
        state: 'OPEN',
        reviewDecision: 'REVIEW_REQUIRED',
        author: { login: 'author' },
        latestReviews: [review('someone', 'APPROVED', '2026-10-12T10:00:00Z'), review('me', 'CHANGES_REQUESTED', '2026-10-12T09:00:00Z')],
    });
    assert.deepEqual(state, { viewer: 'me', mine: 'CHANGES_REQUESTED', open: true, ownPr: false, decision: 'REVIEW_REQUIRED' });
});

test('reports no review of mine, a closed PR, and my own PR', () => {
    assert.equal(reviewState('me', { state: 'OPEN', reviewDecision: '', author: { login: 'x' }, latestReviews: [] }).mine, null);
    assert.equal(reviewState('me', { state: 'MERGED', reviewDecision: 'APPROVED', author: { login: 'x' }, latestReviews: [] }).open, false);
    assert.equal(reviewState('me', { state: 'OPEN', reviewDecision: '', author: { login: 'Me' }, latestReviews: [] }).ownPr, true);
});
