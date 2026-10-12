export interface LinearIssue {
    identifier: string;
    title: string;
    description: string;
    url: string;
    parent: { identifier: string; title: string; description: string } | null;
    comments: string[];
}

// Team prefixes are short (AI, BACK, FRNT); capping at six letters keeps `release-2024` from matching.
export function extractIssueKey(branch: string): string | null {
    const m = branch.match(/(?:^|[^A-Za-z])([A-Za-z]{2,6}-\d+)(?![\d])/);
    return m ? m[1].toUpperCase() : null;
}

const QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier title description url
    parent { identifier title description }
    comments(first: 50) { nodes { body } }
  }
}`;

export async function fetchLinearIssue(key: string): Promise<LinearIssue | null> {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) return null;
    const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query: QUERY, variables: { id: key } }),
    });
    if (!res.ok) throw new Error(`Linear returned ${res.status} for ${key}`);
    const { data, errors } = await res.json();
    if (errors?.length || !data?.issue) return null;
    const issue = data.issue;
    return { ...issue, description: issue.description ?? '', comments: issue.comments.nodes.map((c: { body: string }) => c.body) };
}
