// Team prefixes are short (AI, BACK, FRNT); capping at six letters keeps `release-2024` from matching.
export function extractIssueKey(branch: string): string | null {
    const m = branch.match(/(?:^|[^A-Za-z])([A-Za-z]{2,6}-\d+)(?![\d])/);
    return m ? m[1].toUpperCase() : null;
}
