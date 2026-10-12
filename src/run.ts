import { execFile } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

// execFile, never a shell: arguments come from model output and PR metadata.
export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, stdout, stderr: stderr || (error && !stdout ? error.message : stderr) });
        });
    });
}

export async function runOrThrow(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await run(cmd, args, cwd, env);
    if (result.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
}
