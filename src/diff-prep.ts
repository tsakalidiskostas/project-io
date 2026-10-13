// Files whose diff costs tokens without telling a reviewer anything; they are listed by name instead.
const NOISE = [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|packages\.lock\.json)$/,
    /(^|\/)(@codegen|generated|__generated__)\//i,
    /\.(g|generated|designer)\.(ts|js|cs)$/i,
    /(^|\/)__snapshots__\//,
    /\.(snap|snapshot)$/i,
    /\.min\.(js|css)$/i,
    /\.map$/i,
    /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|pdf|zip)$/i,
];

export const isNoisePath = (path: string) => NOISE.some(re => re.test(path));

export function splitNoise(diff: string): { diff: string; noise: string[] } {
    const chunks = diff.split(/^(?=diff --git )/m).filter(Boolean);
    const kept: string[] = [];
    const noise: string[] = [];
    for (const chunk of chunks) {
        const path = chunk.match(/^diff --git a\/\S+ b\/(\S+)/)?.[1] ?? '';
        if (path && isNoisePath(path)) noise.push(path);
        else kept.push(chunk);
    }
    return { diff: kept.join(''), noise };
}

// Most-changed first, within a character budget; a file over perFile is left for read_file.
export function choosePrefetch(files: { path: string; changes: number; size: number }[], { budget, perFile }: { budget: number; perFile: number }): string[] {
    const chosen: string[] = [];
    let used = 0;
    for (const f of [...files].sort((a, b) => b.changes - a.changes)) {
        if (f.size > perFile || used + f.size > budget) continue;
        chosen.push(f.path);
        used += f.size;
    }
    return chosen;
}

export const numbered = (text: string) => text.split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join('\n');
