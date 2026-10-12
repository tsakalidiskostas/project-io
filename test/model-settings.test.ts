import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL_SETTINGS, ModelSettings, resolveChoice } from '../src/model-choice.ts';
import { openStore } from '../src/store.ts';

const auto = { model: 'sonnet', effort: 'medium', reason: 'small change' } as const;

test('auto model and auto effort keep the automatic choice', () => {
    assert.deepEqual(resolveChoice(auto, { model: 'auto', effort: 'auto' }), auto);
});

test('a chosen model keeps the automatic effort unless effort is chosen too', () => {
    assert.deepEqual(resolveChoice(auto, { model: 'opus', effort: 'auto' }), { model: 'opus', effort: 'medium', reason: 'set in Settings' });
    assert.deepEqual(resolveChoice(auto, { model: 'auto', effort: 'high' }), { model: 'sonnet', effort: 'high', reason: 'set in Settings' });
});

test('settings validation rejects unknown operations, models and efforts', () => {
    assert.ok(ModelSettings.safeParse(DEFAULT_MODEL_SETTINGS).success);
    assert.ok(!ModelSettings.safeParse({ ...DEFAULT_MODEL_SETTINGS, verify: { model: 'gpt', effort: 'auto' } }).success);
    assert.ok(!ModelSettings.safeParse({ ...DEFAULT_MODEL_SETTINGS, verify: { model: 'opus', effort: 'extreme' } }).success);
    assert.ok(!ModelSettings.safeParse({ ...DEFAULT_MODEL_SETTINGS, deploy: { model: 'opus', effort: 'auto' } }).success);
});

test('model settings persist in the store and default to all-auto', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'io-store-')), 'io.db');
    assert.deepEqual(openStore(file).modelSettings(), DEFAULT_MODEL_SETTINGS);
    openStore(file).saveModelSettings({ ...DEFAULT_MODEL_SETTINGS, intent: { model: 'haiku', effort: 'low' } });
    assert.deepEqual(openStore(file).modelSettings().intent, { model: 'haiku', effort: 'low' });
});
