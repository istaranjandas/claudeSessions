# 🌟 Claude Sessions

A gorgeous, private, **fully in-browser dashboard** for your Claude Code transcripts. Simply pick your local `.claude` (or `.claude/projects`) folder to instantly browse every session, prompt, reply, tool call, and timeline — all with rich analytics, fast fuzzy search, and keyboard navigation.

> 🔒 **100% Private & Local:** Nothing is ever uploaded. All log parsing, indexing, and rendering runs locally in your browser sandbox context using modern browser APIs. Close the tab and your data is gone.

---

## ✨ Features

- **📊 Advanced Analytics Dashboard:**
  - **KPI Cards:** Track total tokens consumed, session counts, active projects, total turns, and full token usage breakdown (Input, Output, Cache Create, Cache Read).
  - **Model Breakdown:** View interactive stacked bar charts showing daily token consumption categorized by model (e.g., `claude-3-5-sonnet` etc.).
  - **Tool Frequency:** See which tools (e.g., `Read`, `Edit`, `Bash`, `Grep`, `Glob`) Claude leans on most often.
  - **Session Durations:** Analyze session lengths through customized distribution buckets.
  - **Activity Heatmap:** A beautiful GitHub-style contributions heatmap visualizing your daily prompt frequency over the past 52 weeks.
  
- **📁 Multi-Project Navigation:**
  - View all projects Claude Code has worked on.
  - Search, sort, and filter projects by name, path, recent activity, token count, session count, or message count.
  - View individual project dashboards showing started times, branches, duration, prompt previews, models, and error statuses.

- **⏱️ Detailed Session Timelines:**
  - Explore every prompt, assistant response, thinking process (with **thinking/ultrathink effort** indicators), tool call, and tool result.
  - **Inline Code Diffs:** On-the-fly rendering of file diffs for `Edit`, `MultiEdit`, and `NotebookEdit` tool calls (showing precise additions and removals with syntax highlighting).
  - Side-navigation Table of Contents for jumping to specific prompts instantly.

- **🔍 Global Instant Search:**
  - Full-text search powered by **Lunr.js** across every user prompt, assistant reply, and tool input in all projects.
  - Quickly filter results by project, tool, date, or errors.

- **⚡ Blazing Fast & Offline-First (PWA):**
  - **Off-the-main-thread Parsing:** Handled via a background **Web Worker** (`worker.js`) to keep the UI smooth and responsive even with thousands of files.
  - **Incremental Caching:** Leverages **IndexedDB** (`claude-sessions-cache`) to cache parsed transcripts. Re-opening a folder only parses new or modified files in milliseconds.
  - **PWA Ready:** Installable as a standalone desktop app with full offline support.

- **⌨️ Keyboard Shortcuts:**
  - Press `?` to show the shortcuts overlay.
  - Press `/` to focus search instantly.
  - Press `g` then `s` to jump to Stats.
  - Press `g` then `p` to jump to Projects.
  - Press `g` then `h` or `/` to jump to Search/History.
  - Press `Esc` to close modals or unfocus inputs.

---

## 🚀 Getting Started

### 1. Open the App
Launch the app in your browser or install it as a Progressive Web App (PWA).

### 2. Open your `.claude` Folder
Click **Open folder** (or **Switch folder**) and pick the directory where Claude Code stores transcripts:
- 🍎 **macOS / Linux:** `~/.claude` (or select the `projects` folder directly)
- 🪟 **Windows:** `C:\Users\<YourUsername>\.claude` (or select the `projects` folder directly)

*Note: Chromium-based browsers (Chrome, Edge, Arc) will remember your directory permissions across visits so you only have to grant it once. Firefox and Safari will ask you to select the folder on each visit.*

---

## 🛠️ Local Development

To run the application locally without any build steps:

```sh
# Start a simple static server
python -m http.server 8765

# Open http://localhost:8765
```

> 💡 **Why HTTPS/Localhost?** The modern File System Access API requires a secure context (HTTPS). `localhost` is considered secure by default, so the folder picker works perfectly during local development.

---

## 🌐 Deploy Your Own

Since the application consists entirely of a few static files (`index.html`, `styles.css`, `core.js`, `app.js`, `worker.js`, `sw.js`), it can be deployed anywhere for free in seconds.

### **Option A: GitHub Pages (Recommended)**
1. Create a public GitHub repository and push this folder.
2. Go to **Repo → Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`, and select the `main` branch, `/ (root)` folder.
4. Your dashboard will be live at `https://<your-username>.github.io/<repo-name>/` in under a minute!

### **Option B: One-Click Drag & Drop**
Drag the project folder directly onto **Vercel**, **Netlify**, or **Cloudflare Pages** dashboards. Done!

---

## 🔒 Privacy Architecture

- **No Server, No Cloud:** 100% of the computation happens in your local browser sandbox.
- **No Third-Party Cookies:** Only uses IndexedDB to store folder handles and incremental index caches locally on your device.
- **Minimal Dependencies:** Zero analytics trackers. Only fetches standard open-source libraries via secure CDNs (Tailwind, Chart.js, Marked, Highlight.js, Lunr.js) and Google Fonts.
