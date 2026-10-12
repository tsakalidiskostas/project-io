import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseUsage } from '../src/usage.ts';

test('reduces /usage data to the session and weekly windows', () => {
    const summary = summariseUsage({
        subscription_type: 'team',
        rate_limits_available: true,
        rate_limits: {
            five_hour: { utilization: 42.4, resets_at: '2026-10-12T11:50:00+00:00' },
            seven_day: { utilization: 15, resets_at: '2026-10-14T10:00:00+00:00' },
        },
    });
    assert.deepEqual(summary, {
        available: true,
        plan: 'team',
        session: { percent: 42, resetsAt: '2026-10-12T11:50:00+00:00' },
        week: { percent: 15, resetsAt: '2026-10-14T10:00:00+00:00' },
    });
});

test('reports unavailable for API-key sessions or missing windows', () => {
    assert.deepEqual(summariseUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { available: false });
    assert.deepEqual(summariseUsage({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: null } }), { available: false });
});

test('clamps odd percentages into 0–100', () => {
    const s = summariseUsage({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 104, resets_at: null } } });
    assert.equal(s.available && s.session.percent, 100);
    assert.equal(s.available && s.week, null);
});
