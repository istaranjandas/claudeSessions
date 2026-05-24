# Claude Sessions

A private, in-browser dashboard for your Claude Code transcripts. Pick your `.claude/projects` folder and browse every session, prompt, reply, and tool call — with search, stats, and timelines.

**Nothing is uploaded.** Files are read directly by your browser via the File System Access API (or `<input webkitdirectory>` on Firefox/Safari). Close the tab and the data is gone.

## Use it

1. Open the site.
2. Click **Open your `.claude/projects` folder**.
3. Navigate to the folder Claude Code stores transcripts in:
   - macOS / Linux: `~/.claude/projects`
   - Windows: `C:\Users\<you>\.claude\projects`
4. Browse.

Chrome / Edge / Arc will remember the folder between visits (you grant permission once). Firefox and Safari ask you to re-pick each visit.

## What you get

- **Stats**: total tokens, tool frequency, prompts/day, duration distribution, top files touched.
- **Projects**: every project Claude Code has been used in, sortable and filterable.
- **Project detail**: every session in that project, sortable columns.
- **Session timeline**: every prompt, assistant reply, tool call, and tool result — with a prompts table of contents on the side.
- **Global search**: across every prompt, reply, and tool input. Filter by project, tool, date, or errors.

## Deploy your own copy

Want to host this for friends? The whole thing is four static files (`index.html`, `styles.css`, `core.js`, `app.js`) — no build step, no backend.

**GitHub Pages (free):**
1. Push this folder to a public GitHub repo.
2. Repo → Settings → Pages → Source: `main` branch, root.
3. Wait ~30 seconds. Your site is at `https://<your-username>.github.io/<repo-name>/`.

**Anywhere else (Vercel / Netlify / Cloudflare Pages):** drag the folder onto their dashboard. Done.

> The File System Access API requires HTTPS. GitHub Pages / Vercel / Netlify all serve HTTPS by default. Don't run from `file://` or plain HTTP for the best experience.

## Local development

```sh
python -m http.server 8765
# open http://localhost:8765
```

`localhost` counts as a secure context, so the folder picker works fine.

## Privacy

- All parsing runs in your browser.
- No analytics, no cookies, no tracking, no network calls except CDN fetches for Tailwind / Chart.js / Google Fonts.
- The IndexedDB store only holds the folder *handle* (so Chromium can remember which folder you picked) — never your transcript content.
