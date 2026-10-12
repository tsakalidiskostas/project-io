import { spawn } from 'node:child_process';
import { claudeExecutable, ensureIoProfile, ioSessionEnv } from '../src/profile.ts';

// Claude Code in Io's own profile, for the interactive steps Io cannot do itself:
//   npm run claude -- auth login     sign Io in to Claude
//   npm run claude                   then /mcp to sign in to MCP servers such as Linear
const dir = ensureIoProfile();
process.stdout.write(`Claude Code with Io's profile (${dir})\n`);
const child = spawn(claudeExecutable(), process.argv.slice(2), { stdio: 'inherit', env: ioSessionEnv(dir) });
child.on('exit', code => process.exit(code ?? 0));
