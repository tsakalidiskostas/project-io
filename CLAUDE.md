# Project Io

Read by Claude Code, and by Io's own self-edit agent (`src/self-edit/agent.ts`), before changing anything.

## Stack

- Node 24 runs the `.ts` files directly through type stripping. There is no build step. Import with the
  `.ts` extension, and use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Dependencies stay minimal: `@anthropic-ai/sdk` and `zod`. The server is `node:http`, and the UI is plain ES modules
  loaded from pinned CDN URLs.
- `npm run check` runs the typecheck and the tests. It must pass before any commit.

## Rules

- Spawn external commands with `run()`/`runOrThrow()` from `src/run.ts`, which uses `execFile`. Never use a shell:
  arguments come from PR metadata and model output.
- Pass every piece of HTML built from model or PR text through `DOMPurify.sanitize` in `public/app.js`. Script on
  this page can reach the self-edit endpoint.
- Never commit PR content, explanations or anything under `data/`. They can quote private code.
- The model is `claude-opus-5-5` (`MODEL` in `src/agent-loop.ts`), with server-side refusal fallbacks enabled.
- Commits follow Conventional Commits: `type(scope): imperative summary`. The types are
  build, ci, docs, feat, fix, perf, refactor, test.
- Comments say why, in at most three lines.

## Self-edit safety

`scripts/supervisor.ts` and `src/self-edit/guard.ts` are write-protected from the agent. Change them only by hand.
If the server fails to start after a self-edit, the supervisor says so. Recover with `git revert --no-edit HEAD`.
