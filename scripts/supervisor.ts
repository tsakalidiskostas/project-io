import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept dependency-free and outside src/ on purpose: when a self-edit breaks the server, this
// is the process still standing. Must match RESTART_EXIT_CODE in src/server.ts.
const RESTART_EXIT_CODE = 75;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let child: ReturnType<typeof spawn>;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));

function start(afterRestart: boolean) {
    const startedAt = Date.now();
    child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.ts'], { cwd: root, stdio: 'inherit' });
    child.on('exit', code => {
        if (code === RESTART_EXIT_CODE) {
            process.stdout.write('Io: restarting to load a self-edit…\n');
            start(true);
            return;
        }
        if (afterRestart && Date.now() - startedAt < 15_000) {
            process.stderr.write('Io: the server died right after a self-edit. Undo it with `git revert --no-edit HEAD`, then `npm start`.\n');
        }
        process.exit(code ?? 1);
    });
}

start(false);
