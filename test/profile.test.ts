import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProfiles, ioSessionEnv, parseMcpList, summariseServer } from '../src/profile.ts';

test('parses `claude mcp list` output, ignoring the progress line', () => {
    const out = [
        'Checking MCP server health…',
        '',
        'linear-server: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication',
        'files: npx -y @scope/files-mcp /tmp - ✓ Connected',
        'broken: https://x.example/mcp (HTTP) - ✗ Failed to connect',
    ].join('\n');
    assert.deepEqual(parseMcpList(out), [
        { name: 'linear-server', target: 'https://mcp.linear.app/mcp (HTTP)', status: 'needs-auth' },
        { name: 'files', target: 'npx -y @scope/files-mcp /tmp', status: 'connected' },
        { name: 'broken', target: 'https://x.example/mcp (HTTP)', status: 'failed' },
    ]);
});

test('summarises a server without exposing env or header values', () => {
    const http = summariseServer({ type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer SECRET' } });
    const stdio = summariseServer({ command: 'npx', args: ['-y', 'some-mcp'], env: { API_KEY: 'SECRET' } });
    assert.deepEqual(http, { transport: 'http', target: 'https://mcp.example/mcp' });
    assert.deepEqual(stdio, { transport: 'stdio', target: 'npx -y some-mcp' });
    assert.ok(!JSON.stringify([http, stdio]).includes('SECRET'));
});

test('discovers user- and project-scope servers across profiles, excluding Io’s own', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'io-home-'));
    writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({
            mcpServers: { github: { type: 'http', url: 'https://gh.example/mcp' } },
            projects: { 'C:/work/repo': { mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } } } },
        }),
    );
    mkdirSync(path.join(home, '.claude-personal'));
    writeFileSync(path.join(home, '.claude-personal', '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'notes-mcp' } } }));
    mkdirSync(path.join(home, '.claude-empty'));
    const ioDir = path.join(home, '.io', 'claude');
    mkdirSync(ioDir, { recursive: true });
    writeFileSync(path.join(ioDir, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example/mcp' } } }));

    const profiles = discoverProfiles(home, ioDir);
    assert.deepEqual(
        profiles.map(p => p.label),
        ['~/.claude', '~/.claude-personal'],
    );
    const servers = profiles.flatMap(p => p.servers.map(s => `${p.label}|${s.name}|${s.scope}|${s.inIo}`));
    assert.deepEqual(servers, [
        '~/.claude|github|user|true',
        '~/.claude|linear-server|project C:/work/repo|false',
        '~/.claude-personal|notes|user|false',
    ]);
});

test('sessions always run in Io’s profile, never on the shell’s profile or an API key', () => {
    const env = ioSessionEnv('/io/claude', { CLAUDE_CONFIG_DIR: '/shell/profile', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' });
    assert.equal(env.CLAUDE_CONFIG_DIR, '/io/claude');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.PATH, '/bin');
});
