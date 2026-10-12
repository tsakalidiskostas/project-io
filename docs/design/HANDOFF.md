# Intent Review — Design Handoff

Intent Review compares what a pull request **set out to do** (its linked Linear issue and the PR description) with **what the code actually does**. It reports a verdict per claim, flags changes no claim explains, draws the new behavior as a flow, and suggests PR comments.

This folder is the design source of truth:

| File | What it is |
|---|---|
| `HANDOFF.md` | This spec. Read it first. |
| `tokens.css` | Every color, font, size, radius and spacing value as CSS variables. Use these instead of raw hex values. |
| `reference/*.dc.html` | The approved screens as HTML reference markup. Open them to check exact structure, copy and spacing. They use a design-tool runtime (`<x-dc>`, `<sc-for>`, `<sc-if>`, `{{holes}}`, `class Component extends DCLogic`) that is **not** meant to run in the app. Treat them as visual reference and rebuild them in the app's own stack. |

Sample data in the references (PR #1287, ENG-412, file paths, numbers) is illustrative. Replace it with real data.

---

## 1. Core concepts (data model the UI expects)

- **PR**: number, title, repo, author, files changed, additions/deletions, linked issue (optional), status.
- **Source**: where intent came from: a Linear issue (acceptance criteria, numbered) and/or the PR description. Shown verbatim.
- **Claim**: one checkable statement extracted from the sources *before* the diff is read. Fields: id, title, source refs (e.g. `ENG-412 #2`, `PR description`), claimed text, verdict, "what the code does" text, evidence (file + line range), annotations, suggested comment.
- **Verdict**: `delivered` | `partial` | `missing`. (The UI may also need `unverifiable` later; give it the neutral style.)
- **Unclaimed change**: a diff change no claim explains. Fields: title, file + line, why it matters.
- **Annotation**: numbered note tied to one or more highlighted lines in a code excerpt.
- **Suggested comment**: kind (`request_changes` for partial/missing, optional `comment` for delivered), target (file + line), editable text.
- **PR status** (inbox): `needs_attention` (any missing), `review` (any partial), `aligned` (all delivered, no unclaimed), `no_linked_issue`.

## 2. Visual language

Monokai dark. Page `--ir-bg`, cards `--ir-surface` with 1px `--ir-border`, sunken areas `--ir-surface-sunk`.

**Titles are colorful on purpose:**
- Page titles (H1) are `--ir-cyan`, Montserrat 800.
- Section headings (H2) rotate between `--ir-yellow`, `--ir-green`, `--ir-purple` and `--ir-orange`, so each block stands out at a glance.

**Verdict colors are used the same way on every screen.**

| Meaning | Accent | Small text | Tint | Pattern |
|---|---|---|---|---|
| Delivered | `--ir-green` | `--ir-green` | `--ir-delivered-tint` | solid |
| Partial | `--ir-orange` | `--ir-orange` | `--ir-partial-tint` | solid |
| Missing | `--ir-pink` | `--ir-pink-text` | `--ir-missing-tint` | outline only (coverage bar), dashed (flow) |
| Unclaimed | `--ir-purple` | `--ir-purple-text` | — | dashed border |

Verdict is never shown by color alone. Always pair it with a text label.

**Badges** are pills: Roboto Condensed bold 12px, uppercase, letter-spacing .08em, 4px 10px padding, tint background with accent text.

**Buttons:**
- **Primary:** pill, `--ir-green` background, dark text, bold.
- **Secondary:** pill with a 1.5px border in the accent color and accent-colored text.
- **Ghost:** no border, plain text.
- **Size:** minimum height 44px.

## 3. Global chrome

There is no top bar. Content starts at the top of the page, under a small yellow "Intent Review" wordmark (inbox only).

**Floating app nav (bottom-right):** fixed 20px from the right and bottom edges. A vertical pill on `--ir-surface-sunk` with a border and `--ir-shadow-float`, holding three 44px circular icon links with tooltips and `aria-label`s:
1. List icon (cyan): all pull requests, the inbox. Gets a `--ir-surface-raised` background on the inbox.
2. Plus icon (green): analyze a new PR. Focuses the URL field on the inbox.
3. Gear icon (text color): settings, i.e. the GitHub and Linear connections.

**Chat launcher (top-right):** fixed 20px from the top and right edges. A 48px circle with a chat icon in `--ir-orange`. It opens the Claude sidebar (§8) and is hidden while the sidebar is open.

**PR sub-navigation:** on the three PR screens, tabs labelled Overview, Claims & code and Behavior flow sit under the title. The active tab is bold with a 3px `--ir-pink` underline. A "← All pull requests" link sits above the title.

Content width is at most `--ir-content-max`, with `--ir-page-pad` side padding and 96px bottom padding so the floating nav never covers content.

## 4. Screen 1: PR inbox (`reference/Main.dc.html`)

- **Header row:**
  - Left: the H1 "Pull requests" and the subtitle "Every PR checked against what its Linear issue and description said it would do."
  - Right: a labelled URL input ("Analyze a PR", placeholder "Paste a GitHub PR or Linear issue URL") and a primary "Analyze" button.
- **Layout:** a left filter sidebar (flex 1 1 200px, max 240px) next to the PR list (flex 999 1 560px). They wrap so the sidebar stacks above the list on narrow screens.
- **Filter sidebar:** a yellow "FILTER" label, then four full-width buttons. Each has an icon, a label and a count (filters should be URL params).

  | Filter | Icon | Icon color |
  |---|---|---|
  | All | layers | cyan |
  | Needs attention | warning triangle | pink |
  | Aligned | check circle | green |
  | No linked issue | broken link | purple |

  The active filter has a solid `--ir-cyan` background with dark text and icon. Buttons use `aria-pressed`.
- **PR list:** a card with a sunken header row. The columns are Pull request, Linked issue, Claims delivered, Unclaimed changes and Status.
  - **Pull request:** the title is a link to the report, with meta below (repo · #num · N files changed).
  - **Linked issue:** the issue key in `--ir-purple-text`, or muted text reading "None linked".
  - **Claims delivered:** a segmented 10px bar with segment widths proportional to the counts. Delivered and partial segments are solid green and orange; missing segments are a pink outline only. Under the bar is text such as "2 of 4 delivered, 1 partial, 1 missing".
  - **Unclaimed changes:** the count in purple, then "change(s)".
  - **Status:** a badge.
- **Empty state:** the text "No pull requests match this filter."
- A legend line sits under the table.

## 5. Screen 2: Intent report (`reference/Report.dc.html`)

1. **Header:**
   - H1 is the PR title.
   - The meta line reads: repo · PR # · opened by · files, with +additions in green, −deletions in pink, and a link to the linked issue.
   - Actions: "Open in GitHub", "Open in Linear" (secondary) and "Post review summary" (primary).
2. **Verdict panel:**
   - Left: a status badge and a one-to-two sentence plain-language verdict (Roboto 300, 22px).
   - Right: a 4-column grid of count tiles (Delivered, Partial, Missing, Unclaimed). Each has a 36px number in its accent color. The unclaimed tile has a dashed purple border.
3. **Two columns:**
   - **"What it set out to do"** (yellow H2): one card per source.
     - The Linear card has a purple "LINEAR" badge and the acceptance criteria as an ordered list, verbatim.
     - The GitHub card has a cyan "GITHUB" badge and the description quoted.
     - A muted footnote: "Claims are extracted from these sources before the diff is read…"
   - **"Claims vs. what the code does"** (green H2): one card per claim.
     - Card header: verdict badge, claim title and source refs.
     - Body: one paragraph on what the code does.
     - Evidence chips in a code font, cyan text on sunken background, then a link to the claim detail ("See the code →", or "See where it would go →" for missing claims).
4. **"Unclaimed changes"** (purple H2): a card per change with a dashed purple border. Each has a title, a file chip, a "why it matters" line and actions ("Ask author why", "Mark as expected").
5. **"Generated for this PR"** (orange H2): link cards for Behavior flow, Annotated code walkthrough and Review summary (Markdown for a PR comment).

## 6. Screen 3: Claims & code (`reference/Claim.dc.html`)

- **Layout:** a left claim list (flex 1 1 280px) and a detail area (flex 999 1 640px).
- **Claim list:** each claim is a button showing its badge and title. The selected claim gets a `--ir-surface` background and a 2px cyan border.
- **Detail card:** verdict badge and H2 title (colored by verdict), then two boxes side by side:
  - **"CLAIMED · source"** (purple label): the claim text verbatim.
  - **"WHAT THE CODE DOES"** (label and border in the verdict color): the explanation.
- **Code viewer:**
  - Header: file path in yellow, line range and "View on GitHub".
  - Body: 14px/24px monospace with 44px right-aligned line numbers and a 20px `+` gutter in green.
  - Added lines get the `--ir-code-added` background. Annotated key lines get `--ir-code-key` plus a 3px inset yellow left bar and a numbered yellow chip at the right end.
  - The body scrolls horizontally inside its box with a minimum width of 560px.
  - **Syntax colors (Monokai):**

    | Token | Color |
    |---|---|
    | Keywords and operators | pink |
    | Function calls | green |
    | Numbers, booleans, UPPER_CASE constants | purple |
    | Types | cyan italic |
    | Everything else | `--ir-text` |
- **Explanations** (beside the code; they wrap below on narrow screens): numbered cards with a yellow number circle, a "Line N" label and a sentence comparing the code to the claim.
- **Suggested PR comment** (cyan-bordered panel under the code):
  - Header: comment icon, the title "Suggested PR comment" and a kind badge ("Request changes" in pink, or "Comment · optional" in cyan).
  - Placement toggle: "Inline on <file> line N" or "General PR comment".
  - An editable monospace textarea, prefilled. Keep a separate draft per claim.
  - Actions: "Post to PR #N" (primary), "Copy" and "Rewrite".
  - After posting, show the status text "Posted · <where>" in green (`role="status"`).
- **Missing claims** show the place in the code where the missing behavior would naturally go, with one annotation explaining that.

## 7. Screen 4: Behavior flow (`reference/Flow.dc.html`)

- **Header:**
  - Green H2 "How a delivery flows after this PR" and a muted explainer.
  - Actions: "Export image" (yellow secondary), "Copy as Mermaid" (cyan secondary) and "Comment on PR" (primary).
- **Comment on PR** expands an inline green-bordered panel with an editable prefilled comment and the buttons "Post with image" and "Cancel". It posts the comment with the diagram attached as an image. When posted, show "Posted to PR #N with the diagram attached."
- **Diagram:** on a sunken panel, built from the diff rather than the description. It scrolls horizontally on small screens.
  - **Process step:** rounded card on `--ir-surface`. Border color:

    | Step | Border |
    |---|---|
    | Neutral | 1.5px cyan |
    | Fulfils a claim | 2px green, with the claim tag "Claim N · delivered" in green |
    | Missing step the issue promised | 2px dashed pink, with "Claim N · missing from code" |
    | Unclaimed change | dashed purple note attached to its step with a dashed purple line |

  - **Decision:** diamond. Neutral diamonds use `--ir-surface-raised`; partial ones use a dark orange fill (#5A3C17) with the orange claim tag.
  - **Arrows:** `--ir-text-muted`, 2px. The arrow into a missing step is dashed pink. Edge labels ("yes", "no", "attempt < 5") are 13px muted.
  - **Notes on edges:** an orange 13px note marks where the partial behavior goes wrong, e.g. "429 lands on 'no' here".
  - **Export:** the flow should also export as Mermaid. Generate it from the same graph data.
- **Below the diagram:** cards for "Before this PR" (yellow label) and "Reading the diagram" (cyan label; the color legend in words).

## 8. Claude chat sidebar (`reference/ChatPanel.dc.html`)

Shown on every screen; the app uses it to edit itself.

- **Panel:** fixed right, full height, 400px wide (100% on small screens), `--ir-surface-sunk`, left border and shadow.
  - **Header:** an orange sparkle icon, the orange H2 "Change this app", "On: <current screen>" in muted text, and a close button (44px, `aria-label="Close chat"`).
  - **Messages:** a scrolling area with `aria-live="polite"`.
    - User bubbles align right on `--ir-surface-raised`. Claude bubbles align left on `--ir-surface` with a border.
    - A message can carry a **pointer chip**: a yellow pill with a target icon and the pointed element's description.
    - A Claude reply that made a change shows the actions "Open PR" (primary), "View diff" and "Review it here".
  - **Composer:**
    - An optional attached-pointer chip (yellow, dashed border, removable).
    - A textarea with the placeholder "Describe a change, or point at something first".
    - "Point at it" (yellow outline, filled while active) and a round orange send button.
    - Footnote: "Changes are made in the app's repo and opened as a PR, which this app then reviews."
- **Point-at-it mode:**
  - While active, a yellow banner at the top centre reads "Click any part of the app to point at it" with a Cancel button.
  - A 2px dashed yellow outline (6px radius, faint yellow fill) follows the element under the cursor.
  - Clicking an element captures it instead of activating it (capture phase; `preventDefault` and `stopPropagation`). It is attached to the composer as `"<aria-label or text, max 40 chars>" in <nearest section/nav/aside aria-label>`. Its outline stays solid while the message is being written.
  - Clicks inside the chat UI itself are never captured.
  - Send the element's identity to the backend along with the message: the DOM path or a stable `data-` id, the label, the screen, and ideally a screenshot crop of its bounding box.
- **Backend intent:** the message plus the pointer context go to Claude Code working in this app's own repo. The result is a branch and PR, linked back in the chat. That PR then appears in the inbox and is analyzed like any other.

## 9. Interaction states (all screens)

| Element | State | Behavior |
|---|---|---|
| Links | hover | color shifts from cyan to green |
| Any button | focus-visible | 3px focus ring, `rgba(102,217,239,0.5)` |
| Filter / claim list item | selected | see the screen specs above; `aria-pressed="true"` |
| Analyze | loading | button disabled with a spinner; the new row appears at the top with a status of "Analyzing" |
| Post comment | posting / done / error | disabled while posting, then green status text; on error, pink status text and a Retry button |
| Analysis | failed | `--ir-missing-tint` panel with the reason and a "Re-analyze" button |
| Unclaimed change | "Mark as expected" | the card fades to muted and moves to a collapsed "Expected changes" group |

## 10. Responsive behavior

| Width | Changes |
|---|---|
| ≥ 1024px | Layouts as drawn: sidebars beside content, code annotations beside the code |
| 768–1023px | Explanations wrap under the code; verdict tiles wrap under the verdict text |
| < 768px | Filter sidebar and claim list stack above content; table rows wrap into stacked blocks; chat panel goes full width; the diagram scrolls horizontally |

All rows use `flex-wrap` with flex-basis values, so these breakpoints happen without media queries where possible.

## 11. Accessibility

- Use real `<button>`, `<a href>`, `<input>`/`<textarea>` and `<label>` elements everywhere. Icon-only controls need an `aria-label` and a `title`.
- Landmarks: `nav[aria-label="App"]`, `nav[aria-label="Filter"]`, `nav[aria-label="Report sections"]`, `nav[aria-label="Claims"]`, `aside[aria-label="Claude"]`, and labelled `section`s. Point-at-it relies on these labels to describe elements, so keep them meaningful.
- Status messages ("Posted…") use `role="status"`.
- Text contrast is at least 4.5:1. Use the `*-text` variants of pink and purple for small text.
- Focus order follows reading order, then the floating nav, then the chat launcher.
