import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareToolName, isReadOnlyToolName } from '../src/agent-loop.ts';

test('strips the MCP server prefix', () => {
    assert.equal(bareToolName('mcp__linear-server__get_issue'), 'get_issue');
    assert.equal(bareToolName('Read'), 'Read');
});

test('treats lookup tools as read-only', () => {
    for (const name of ['mcp__linear-server__get_issue', 'mcp__linear-server__list_comments', 'mcp__x__search_threads']) {
        assert.ok(isReadOnlyToolName(name), name);
    }
});

test('treats anything that could change state as not read-only', () => {
    for (const name of ['mcp__linear-server__save_issue', 'mcp__x__send_message', 'mcp__x__delete_label', 'mcp__x__forward']) {
        assert.ok(!isReadOnlyToolName(name), name);
    }
});
