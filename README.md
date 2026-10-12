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
cp .env.example .env     # add ANTHROPIC_API_KEY, and LINEAR_API_KEY if you use Linear
npm start                # http://localhost:4317
```

Needs Node 24+ (it runs TypeScript directly) and the [GitHub CLI](https://cli.github.com/), logged in. Io uses
your `gh` session for GitHub access, so it can read any private repository you can.

## Where intent comes from

1. A Linear issue key in the branch name (`BACK-1234/some-slug`, `back-1234`). Io loads that issue, its parent and its comments.
2. Otherwise, the PR title, description and commit messages.

## Self-editing

On the **Change Io** tab, describe a change ("add a copy-as-markdown button"). Io then:

1. refuses to start unless the git working tree is clean
2. runs an agent with read/write tools confined to this repository
3. runs `npm run check` (typecheck + tests), letting the agent fix any failures
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
src/agent-loop.ts       shared Claude tool-use loop
src/github.ts           gh CLI wrapper
src/linear.ts           Linear issue lookup
src/self-edit/          the self-editing agent, its path guard and git helpers
public/                 the UI (no build step)
test/                   node:test suites
```
