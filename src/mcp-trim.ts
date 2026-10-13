// Every tool a session can see is sent with every turn: the claude.ai connectors alone measured about
// 95k tokens of definitions (Linear brings 76 tools). The intent step needs only an issue tracker's
// read tools, so everything else is removed by name. Names come from a previous session's inventory,
// since they are not known before a session starts.
const ISSUE_TRACKER = /linear|jira|atlassian|youtrack|shortcut/i;
const READ_TOOL = /^(get_issue|list_comments|get_project|get_issue_status|get_milestone|get_document)$/;

export function intentDisallowedTools(inventory: string[]): string[] {
    const removed = new Set<string>();
    for (const name of inventory) {
        const m = name.match(/^mcp__(.+?)__(.+)$/);
        if (!m || m[1] === 'io') continue;
        const [, server, tool] = m;
        if (!ISSUE_TRACKER.test(server)) removed.add(`mcp__${server}`);
        else if (!READ_TOOL.test(tool)) removed.add(name);
    }
    return [...removed];
}
