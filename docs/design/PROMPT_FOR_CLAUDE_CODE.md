Paste this into your Claude Code session after copying this folder into the repo (for example to `docs/design/`):

---

The approved UI design for this app is in `docs/design/`. Read `docs/design/HANDOFF.md` first; it is the source of truth for layout, colors, components, states and behavior.

1. Add `docs/design/tokens.css` to the app's styles (or map each variable into our styling setup). Use the tokens everywhere instead of raw values.
2. Use `docs/design/reference/*.dc.html` as visual reference for exact structure, copy and spacing. They use a design-tool runtime (`<x-dc>`, `<sc-for>`, `{{…}}`, `DCLogic`) that should not be copied into the app. Rebuild them in our stack.
3. Build in this order and stop for my review after each step:
   a. Global chrome: floating bottom-right nav, top-right chat launcher, page layout.
   b. PR inbox, with the left filter sidebar.
   c. Intent report.
   d. Claims & code, with the Monokai syntax highlighter, annotations and suggested PR comment.
   e. Behavior flow (render it from graph data; also export it as Mermaid).
   f. Claude chat sidebar, with point-at-it mode.
4. Before you start, tell me which data shapes from HANDOFF.md §1 already exist in the codebase and which you need to add.
