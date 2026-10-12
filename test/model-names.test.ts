import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRun, modelDisplayName } from '../src/model-choice.ts';

test('turns model ids into short names', () => {
    assert.equal(modelDisplayName('claude-sonnet-5-5'), 'Sonnet 5.5');
    assert.equal(modelDisplayName('claude-opus-5'), 'Opus 5');
    assert.equal(modelDisplayName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.equal(modelDisplayName('claude-haiku-4-5'), 'Haiku 4.5');
    assert.equal(modelDisplayName('sonnet'), 'Sonnet');
    assert.equal(modelDisplayName('something-else'), 'something-else');
});

test('describes the models a run used', () => {
    assert.equal(
        describeRun({ intent: { model: 'claude-sonnet-5-5', effort: 'low' }, verify: { model: 'claude-opus-5-5', effort: 'medium' } }),
        'extracted claims with Sonnet 5.5 low, claims vs code with Opus 5.5 medium',
    );
});
