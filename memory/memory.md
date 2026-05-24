# Claude Sessions — Project Memory

> Jelly Boot_Ingest target. Read this on every first turn when working inside `Claude Sessions/`.

---

## Project identity

- **Name**: Claude Sessions (NOT "Projects" — that's just the parent folder)
- **Type**: Personal/shareable web app (NOT a Salesforce project — kernel's default vectors do not apply)
- **Root**: `c:\Users\istaranjan.das\Desktop\Projects\Claude Sessions`
- **What it is**: Privacy-preserving, browser-only dashboard for visualising Claude Code transcripts. Reads `~/.claude/projects/*/<session>.jsonl` directly via File System Access API. Zero network calls. Designed to be hostable as static files for sharing with friends.

## Tech stack

- Vanilla JS + HTML + CSS (no framework, no build step)
- CDN: Tailwind, Chart.js 4.4.1, marked 12.0.2, highlight.js 11.9.0, lunr 2.3.9
- Browser APIs: File System Access (Chrome/Edge/Arc), `webkitdirectory` fallback (Firefox/Safari), drag-drop via `getAsFileSystemHandle` / `webkitGetAsEntry`
- IndexedDB: `claude-sessions-fs` (folder handle persistence), `claude-sessions-cache` (parsed-session cache keyed by `slug/sessionId:size:mtime`)
- Web Worker for indexing
- Service Worker for offline shell
- PWA manifest

## File layout

- `index.html` — entry + CDN links + favicon (data: SVG sparkle)
- `core.js` — `Picker`, `IndexerClient`, main-thread `Indexer` fallback
- `worker.js` — Full indexing + IndexedDB cache logic (~520 lines)
- `app.js` — Routes, render functions, state mgmt (~1680 lines)
- `styles.css` — Design tokens + components (~574 lines)
- `sw.js` — Service worker
- `manifest.webmanifest` — PWA manifest

---

## Closed decisions (do NOT undo without asking)

1. **NO pricing/cost calculation anywhere**. User is on Claude subscription, not per-token billing. Previous calc was wrong (~$200 vs actual ~$190); user explicitly removed it.
2. **NO `position: sticky`** on table thead, `.timeline-bar`, or `.session-toc`. Chrome's sticky-on-table-cells has unfixable rendering quirks (bleed-through bug). Only `.app-header` keeps sticky.
3. **History tab** aggregates prompts from session JSONLs first; merges `history.jsonl` only as orphans for sessions not in the loaded folder. Claude Code truncates the global `history.jsonl`, so don't rely on it as primary.
4. **Timestamps** drop year when current year (e.g., "May 23, 10:02 PM"). See `fmtDate` and `fmtHistoryTime` in `app.js`.
5. **Chart.js** requires `.chart-box { position: relative; height: 180px }` wrapper with `maintainAspectRatio: false`. Without fixed-height parent, canvases explode to fill viewport.
6. **Favicon** = white 8-pointed sparkle (4 long N/E/S/W + 4 short diagonals) on purple gradient `#818cf8 → #c4b5fd`. Same SVG reused for `.brand-dot` (18px) and PWA manifest icon (192px). DO NOT revert to plain gradient square.
7. **Activity heatmap** = fixed 11px cells in `inline-grid` with `grid-auto-flow: column`, wrapped in `.heatmap-wrap { overflow-x: auto }`. Lives at the BOTTOM of Stats page (smaller/cleaner than first iteration).
8. **Every KPI/card has a `title=""` tooltip** explaining the metric to non-technical users. Maintain this when adding new cards.

---

## Working principles learned this project (extend Jelly kernel locally)

### 1. UI verification protocol (extends `Zero_Latency_Verification`)
Before [FINALIZE] on UI work, mentally simulate: **empty state, loading, error, narrow viewport, hover/focus, 2 edge inputs** (very long string, zero items). The kernel's CLI-focused verify is insufficient for frontend.

### 2. Reality trumps formula
When a user-observed value contradicts a computed output (the $190 actual vs $200 calc incident), the **formula is wrong, not the user**. Halt formula defense; investigate the underlying assumption.

### 3. Image ingestion
User often shares screenshots. [RECON] MUST reference specific visible elements ("header bleeds at row 3", "PM and project name overlap"), not handwave.

### 4. Visual cohesion sweep
On brand/visual edits (icon, button style, color token), `grep -rn` for all occurrences across HTML/CSS/JS before [FINALIZE]. Single-surface updates leak inconsistency (e.g., favicon update also requires `.brand-dot` + manifest icon).

### 5. Platform-quirk pivot trigger
If a CSS/browser quirk forces ≥2 fix attempts on the same symptom (sticky-thead bleed-through), [PIVOT] to **design change**. Don't chase platform-specific hacks.

### 6. Subscription default for AI SaaS
For Claude/ChatGPT/Copilot/etc., default billing assumption = **subscription**. Never auto-compute dollars from token counts unless user explicitly says "API key" or "per-token".

### 7. Bug-hunt depth heuristics
On exhaustive scans ("100% sure no bugs"), sweep for:
- Operator precedence (`||` vs `+` — see fix at `app.js:569`)
- Dead conditionals (`x ? a : a` — see fix at `app.js:814`)
- Async/await leaks (unawaited promises in event handlers)
- Race conditions in `setTimeout` closures (e.g., `state.searchIndex` rebuild across folder switches)
- XSS in template literals (verify every `${...}` is `escapeHtml`'d or `renderMarkdown`'d)
- `JSON.parse` without try/catch

### 8. Privacy-by-default for shareables
Default architecture = **browser-only, no telemetry, no upload**. Confirm explicitly before introducing any network call. Existing CDN deps (Tailwind, Chart.js, marked, hljs, lunr) are loaded passively; adding new ones requires user nod.

### 9. Beginner-friendly tooltips
When user requests hover help, write as if explaining to a non-technical person. Already applied across Stats page KPI cards — maintain that tone.

### 10. Surgical Edit over Write
Files here range 500–1700 lines. Prefer `Edit` (diff-only) over `Write` (full rewrite) — Write causes expensive token streaming for trivial changes.

---

## Open items / Future ideas (not committed)

- **Cost-per-session** (idea #6 from brainstorm). User asked "will it be accurate?". Three options offered:
  - API list-price equivalent ("≈ list price, not your actual bill" tooltip)
  - Relative cost weight ("this session burned X% of this month's tokens")
  - Cache-savings ratio (% saved by prompt caching)
  - **No commitment yet** — wait for user pick before implementing. Do NOT silently reintroduce dollar amounts.
- Extensions tab (agents/commands/skills/plugins inventory from `.claude/`)
- Memory tab (visualise project `memory/` subfolders — meta!)
- Settings/hooks viewer
- Tool-input intelligence (frequent file paths, repeated bash commands, etc.)
- Branch/repo heatmap

---

## Recent bug fixes (reference)

- `app.js:569` — operator precedence: `(acc) + Number(v) || 0` parsed as `((acc) + Number(v)) || 0`, wiping accumulation when `Number(v)` is `NaN`. Fixed to `(acc) + (Number(v) || 0)`.
- `app.js:814` — dead ternary `col === "started_at" ? "desc" : "desc"` collapsed to `"desc"`.

---

## Edge cases noted but not fixed (acceptable)

- Chart.js memory: instances accumulate refs on stats re-render. GC reclaims via canvas dereference; no observable leak in normal usage.
- Brief stale-`searchIndex` window if user switches folders within 50ms of first load. Auto-corrects on second `setTimeout` fire.
- Date filter `to + "T23:59:59"` excludes the final millisecond of the target day. Negligible.
- Mobile heatmap (`max-width: 720px`) override is partial — first 26 cols are `1fr`, remaining are still 11px. Renders correctly but layout is suboptimal. User hasn't flagged.
