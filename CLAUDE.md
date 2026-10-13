# Project Io

Read by Claude Code, and by Io's own self-edit agent (`src/self-edit/agent.ts`), before changing anything.

## Stack

- Node 24 runs the `.ts` files directly through type stripping. There is no build step. Import with the
  `.ts` extension, and use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Dependencies stay minimal: `@anthropic-ai/claude-agent-sdk` and `zod`. The server is `node:http`, and the UI is plain ES modules
  loaded from pinned CDN URLs.
- `npm run check` runs the typecheck and the tests. It must pass before any commit.

## Rules

- Spawn external commands with `run()`/`runOrThrow()` from `src/run.ts`, which uses `execFile`. Never use a shell:
  arguments come from PR metadata and model output.
- Pass every piece of HTML built from model or PR text through `DOMPurify.sanitize` in `public/app.js`. Script on
  this page can reach the self-edit endpoint.
- Never commit PR content, explanations or anything under `data/`. They can quote private code.
- Io never calls the Claude API from its own process. Every model call is a Claude Code CLI session spawned through
  the Agent SDK (`src/agent-loop.ts`). Never add `@anthropic-ai/sdk`, an API key or a token.
- Sessions always run in Io's own Claude Code profile (`src/profile.ts`, `~/.io/claude`). Its login and MCP servers
  belong to Io, not to the shell that started it. Build every session's env with `ioSessionEnv()`.
- Never send MCP `env` or `headers` values to the browser. They often hold tokens. `summariseServer()` is the only
  shape the UI gets.
- The model and effort for each session come from `src/model-choice.ts`: the cheapest model that still produces a
  trustworthy result. Choices use the short names (`haiku`, `sonnet`, `opus`); `MODEL_IDS` maps them to
  explicit model ids, because the bundled Claude Code's own aliases lag a generation behind.
- Commits follow Conventional Commits: `type(scope): imperative summary`. The types are
  build, ci, docs, feat, fix, perf, refactor, test.
- Comments say why, in at most three lines.

## UI design

`docs/design/HANDOFF.md` is the source of truth for the UI, and `docs/design/tokens.css` holds every value.
The `reference/*.dc.html` files are visual reference only; never copy their design-tool runtime. The app departs
from the handoff deliberately in three places:

- The product is called **Io**, not "Intent Review".
- The chat sidebar ("Change this app") commits straight to `main` once checks pass, then restarts. It does not open
  a PR, so its footnote and post-change actions describe that instead.
- The reference screens had `ds/rikstoto/…` design-system links. They were removed and must not come back: this
  repository is public and unrelated to that design system.

## Work sessions

The Work screen (`src/work/`) runs interactive Claude Code sessions in a checkout, with the CLI's own permission
prompts answered in the browser. A PR's session runs in a git worktree beside the user's clone, never in the clone
itself. Pushing happens only on an explicit two-step click in the UI; the session's instructions tell Claude not to
push or post to GitHub unless the user asks in the conversation. Never add a path that pushes or posts on its own.

## Self-edit safety

`scripts/supervisor.ts` and `src/self-edit/guard.ts` are write-protected from the agent. Change them only by hand.
If the server fails to start after a self-edit, the supervisor says so. Recover with `git revert --no-edit HEAD`.
