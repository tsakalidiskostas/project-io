import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { run, runOrThrow } from './run.ts';

// Io's own Claude Code profile: its Claude login and its MCP servers, whichever shell or
// profile Io was started from. Override with IO_CLAUDE_CONFIG_DIR.
export const IO_CLAUDE_DIR = process.env.IO_CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.io', 'claude');

export function ensureIoProfile(): string {
    mkdirSync(IO_CLAUDE_DIR, { recursive: true });
    return IO_CLAUDE_DIR;
}

// API keys are dropped so a key in the shell can never take over from the profile's login.
export function ioSessionEnv(dir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = base;
    return { ...rest, CLAUDE_CONFIG_DIR: dir };
}

// The binary the Agent SDK ships with, so setup commands run the same Claude Code version as sessions.
export function claudeExecutable(): string {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
}

function claude(args: string[]) {
    return run(claudeExecutable(), args, os.tmpdir(), ioSessionEnv(ensureIoProfile()));
}

export async function authStatus(): Promise<{ loggedIn: boolean; authMethod: string; email?: string }> {
    const result = await claude(['auth', 'status']);
    return JSON.parse(result.stdout);
}

export type ServerStatus = 'connected' | 'needs-auth' | 'failed' | 'unknown';

export function parseMcpList(out: string): { name: string; target: string; status: ServerStatus }[] {
    return out
        .split('\n')
        .map(line => line.trim().match(/^([^:\s][^:]*): (.+) - (.+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map(([, name, target, state]) => ({
            name,
            target,
            status: /connected/i.test(state)
                ? 'connected'
                : /auth/i.test(state)
                  ? 'needs-auth'
                  : /fail/i.test(state)
                    ? 'failed'
                    : 'unknown',
        }));
}

export async function listIoServers() {
    return parseMcpList((await claude(['mcp', 'list'])).stdout);
}

interface ServerConfig {
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
}

// What the UI may see of a server: never env or header values, which often hold tokens.
export function summariseServer(config: ServerConfig): { transport: string; target: string } {
    if (config.url) return { transport: config.type ?? 'http', target: config.url };
    return { transport: 'stdio', target: [config.command, ...(config.args ?? [])].join(' ') };
}

export interface DiscoveredServer {
    name: string;
    scope: string;
    transport: string;
    target: string;
    inIo: boolean;
}

export interface DiscoveredProfile {
    label: string;
    configFile: string;
    servers: DiscoveredServer[];
}

function readConfig(file: string): { mcpServers?: Record<string, ServerConfig>; projects?: Record<string, { mcpServers?: Record<string, ServerConfig> }> } {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function serverConfigs(file: string): { name: string; scope: string; config: ServerConfig }[] {
    const json = readConfig(file);
    const user = Object.entries(json.mcpServers ?? {}).map(([name, config]) => ({ name, scope: 'user', config }));
    const project = Object.entries(json.projects ?? {}).flatMap(([dir, p]) =>
        Object.entries(p.mcpServers ?? {}).map(([name, config]) => ({ name, scope: `project ${dir}`, config })),
    );
    return [...user, ...project];
}

// Claude Code keeps the default profile's config at ~/.claude.json and every other profile's at
// <CLAUDE_CONFIG_DIR>/.claude.json, so look for both shapes under the home directory.
export function discoverProfiles(home = os.homedir(), ioDir = IO_CLAUDE_DIR): DiscoveredProfile[] {
    const candidates = [{ label: '~/.claude', configFile: path.join(home, '.claude.json') }];
    for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.claude') || entry.name === '.claude') continue;
        candidates.push({ label: `~/${entry.name}`, configFile: path.join(home, entry.name, '.claude.json') });
    }
    const ioNames = new Set(Object.keys(readConfig(path.join(ioDir, '.claude.json')).mcpServers ?? {}));
    return candidates
        .filter(c => existsSync(c.configFile) && path.resolve(path.dirname(c.configFile)) !== path.resolve(ioDir))
        .map(c => ({
            ...c,
            servers: serverConfigs(c.configFile).map(({ name, scope, config }) => ({
                name,
                scope,
                ...summariseServer(config),
                inIo: ioNames.has(name),
            })),
        }))
        .filter(p => p.servers.length > 0);
}

// Copies the definition as-is into Io's profile at user scope. OAuth sign-ins do not carry over:
// those tokens belong to the source profile, so such servers need one /mcp sign-in in Io's.
export async function importServer(label: string, name: string, scope: string): Promise<void> {
    const profile = discoverProfiles().find(p => p.label === label);
    const match = profile && serverConfigs(profile.configFile).find(s => s.name === name && s.scope === scope);
    if (!match) throw new Error(`No MCP server "${name}" (${scope}) in ${label}.`);
    await runOrThrow(claudeExecutable(), ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(match.config)], os.tmpdir(), ioSessionEnv(ensureIoProfile()));
}
