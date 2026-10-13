import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentDisallowedTools } from '../src/mcp-trim.ts';

const inventory = [
    'mcp__claude_ai_Linear__get_issue',
    'mcp__claude_ai_Linear__list_comments',
    'mcp__claude_ai_Linear__save_issue',
    'mcp__claude_ai_Linear__merge_diff',
    'mcp__claude_ai_Slack__send_message',
    'mcp__claude_ai_Slack__search',
    'mcp__claude_ai_Figma__get_design',
    'mcp__linear-server__get_issue',
    'mcp__io__read_file',
];

test('keeps only the issue tracker read tools for the intent step', () => {
    const removed = intentDisallowedTools(inventory);
    assert.ok(removed.includes('mcp__claude_ai_Slack'), 'whole servers that are not issue trackers go by name');
    assert.ok(removed.includes('mcp__claude_ai_Figma'));
    assert.ok(removed.includes('mcp__claude_ai_Linear__save_issue'), 'writes go');
    assert.ok(removed.includes('mcp__claude_ai_Linear__merge_diff'));
    assert.ok(!removed.includes('mcp__claude_ai_Linear__get_issue'));
    assert.ok(!removed.includes('mcp__claude_ai_Linear__list_comments'));
    assert.ok(!removed.includes('mcp__linear-server__get_issue'));
    assert.ok(!removed.some(t => t.startsWith('mcp__io')), "Io's own tools are not the connectors' business");
});

test('removes nothing when nothing is known yet', () => {
    assert.deepEqual(intentDisallowedTools([]), []);
});
