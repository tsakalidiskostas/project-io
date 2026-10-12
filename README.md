# Project Io

A local web app, powered by Claude, that explains pull requests — and can change its own code.

Give it a PR and it reports:

- **what** the PR does, in one paragraph
- **why** each group of changes was made, citing the issue, PR text or commits (and saying when it is guessing)
- **intended vs delivered** — a goal-by-goal table against the Linear issue's acceptance criteria, or the PR description when there is no issue
- **what is missing or at risk**
- **how the app flow changed** — before/after Mermaid diagrams
- **questions for the author**

Io reads more than the diff. It can open any file at the base or head commit and search the repository, so it describes behaviour in context rather than line by line.

## Running it

```bash
npm install
npm start                # http://localhost:4317
```

Needs Node 24+ (it runs TypeScript directly), [Claude Code](https://code.claude.com) logged in, and the
[GitHub CLI](https://cli.github.com/) logged in.

## No keys of its own

Io runs Claude through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which drives the
Claude Code binary on your machine. So:

- **Claude** uses whatever login `claude` already has, whether claude.ai or an API key. `CLAUDE_CONFIG_DIR` is respected.
- **MCP servers** are the ones you configured in Claude Code (`claude mcp add --scope user …`), plus your claude.ai
  connectors. Io shows which ones connected. While explaining a PR it may only call MCP tools whose names read as
  lookups (`get_*`, `list_*`, `search_*`, …), and it denies everything else.
- **GitHub** goes through your `gh` session, so Io can read any private repository you can.

## Where intent comes from

If the branch names an issue key (`BACK-1234/some-slug`) and you have an issue-tracker MCP server such as Linear,
Io loads the issue and its parent and measures the PR against the acceptance criteria. Otherwise it uses the PR
title, description and commits, and says so.

## Self-editing

On the **Change Io** tab, describe a change ("add a copy-as-markdown button"). Io then:

1. refuses to start unless the git working tree is clean
2. runs Claude Code with its file tools plus only `npm run check`, `npm test` and `git diff` in the shell. A hook enforces the path guard on every tool call
3. runs `npm run check` (typecheck + tests) itself, whatever the agent reported
4. on success, commits with a `Self-Edit: true` trailer and restarts through the supervisor
5. on failure, discards every change it made

**Undo last self-edit** reverts the newest commit, but only if it carries that trailer.

Some paths can't be written by the agent: `scripts/supervisor.ts` and `src/self-edit/guard.ts` (the safety net), `.git`, `.env*`, `node_modules`, `data/`.
The server listens on `127.0.0.1` only. It rejects foreign `Host` headers and any POST that lacks the `X-Io` header,
so a web page you visit can't tell it to rewrite itself.

## Layout

```
scripts/supervisor.ts   restarts the server after a self-edit (exit code 75)
src/server.ts           HTTP server and routes
src/explain.ts          PR explanation: prompt, tools, diff budgeting
src/agent-loop.ts       runs Claude Code through the Agent SDK and streams events
src/github.ts           gh CLI wrapper
src/linear.ts           issue-key extraction from branch names
src/self-edit/          the self-editing agent, its path guard and git helpers
public/                 the UI (no build step)
test/                   node:test suites
```

## Licence

MIT
