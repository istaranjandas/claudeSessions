const App = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const app = $("#app");
  const state = {
    manifest: null,
    sessionsById: null,
    pickerHandle: null,
    projectsView: { sort: "recent", q: "" },
    pendingHash: null,
    history: null,
    historyView: { q: "", proj: "" },
    searchIndex: null,
    lastRefreshAt: null,
    refreshing: false,
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, {
      year: sameYear ? undefined : "numeric",
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };
  const fmtHistoryTime = (ts) => {
    if (!ts) return "—";
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d)) return String(ts);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, {
      year: sameYear ? undefined : "numeric",
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };
  const fmtDay = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  };
  const fmtRel = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 30) return `${days}d ago`;
    const mo = Math.floor(days / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  };
  const fmtDur = (ms) => {
    if (!ms || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };
  const fmtTokens = (n) => {
    n = Number(n) || 0;
    if (n < 1000) return n.toString();
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.0+$/, "") + "K";
    if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.0+$/, "") + "M";
    return (n / 1_000_000_000).toFixed(2).replace(/\.0+$/, "") + "B";
  };
  const escapeHtml = (s) => (s ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : (s || ""));
  const projShortName = (p) => {
    const dec = p.decoded_path || p.slug;
    const parts = dec.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || dec;
  };
  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const toast = (msg) => {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 2400);
  };

  if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true, headerIds: false, mangle: false });
    if (typeof hljs !== "undefined") {
      const renderer = new marked.Renderer();
      renderer.code = (code, lang) => {
        const codeText = typeof code === "string" ? code : (code?.text || "");
        const language = typeof lang === "string" ? lang : (code?.lang || "");
        try {
          if (language && hljs.getLanguage(language)) {
            return `<pre><code class="hljs language-${language}">${hljs.highlight(codeText, { language, ignoreIllegals: true }).value}</code></pre>`;
          }
          return `<pre><code class="hljs">${hljs.highlightAuto(codeText).value}</code></pre>`;
        } catch {
          return `<pre><code>${escapeHtml(codeText)}</code></pre>`;
        }
      };
      marked.use({ renderer });
    }
  }

  function renderMarkdown(text) {
    if (!text) return "";
    if (typeof marked === "undefined") return escapeHtml(text).replace(/\n/g, "<br>");
    try { return marked.parse(text); } catch { return escapeHtml(text); }
  }

  function isEditLike(name) {
    return name === "Edit" || name === "MultiEdit" || name === "NotebookEdit";
  }

  function lineDiff(a, b) {
    const A = (a || "").split("\n");
    const B = (b || "").split("\n");
    const m = A.length, n = B.length;
    if (m * n > 80000) return [...A.map(l => ["-", l]), ...B.map(l => ["+", l])];
    const lcs = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (A[i] === B[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
        else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { ops.push(["=", A[i]]); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(["-", A[i]]); i++; }
      else { ops.push(["+", B[j]]); j++; }
    }
    while (i < m) ops.push(["-", A[i++]]);
    while (j < n) ops.push(["+", B[j++]]);
    return ops;
  }

  function renderDiff(input, name) {
    const file = input.file_path || input.notebook_path || "";
    let ops = [];
    if (name === "MultiEdit" && Array.isArray(input.edits)) {
      input.edits.forEach((e, idx) => {
        if (idx > 0) ops.push(["hunk", ""]);
        ops.push(...lineDiff(e.old_string || "", e.new_string || ""));
      });
    } else {
      ops = lineDiff(input.old_string || "", input.new_string || "");
    }
    let adds = 0, rms = 0;
    for (const [k] of ops) { if (k === "+") adds++; else if (k === "-") rms++; }
    return `
      <div class="diff-card">
        <div class="diff-head">
          <span class="tname">${escapeHtml(name)}</span>
          <span class="file" title="${escapeHtml(file)}">${escapeHtml(file || "(no path)")}</span>
          <span class="stats"><span style="color:var(--ok)">+${adds}</span> <span style="color:var(--err)">−${rms}</span></span>
        </div>
        <div class="diff-body scroll-thin">
          ${ops.map(([k, line]) => {
            if (k === "hunk") return `<div class="diff-line hunk">⋯</div>`;
            const mark = k === "+" ? "+" : k === "-" ? "−" : " ";
            const cls = k === "+" ? "add" : k === "-" ? "rm" : "eq";
            return `<div class="diff-line ${cls}"><span class="mark">${mark}</span><span class="content">${escapeHtml(line)}</span></div>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderHeatmap(dailyPromptsArr) {
    const map = Object.fromEntries(dailyPromptsArr || []);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const lastSat = new Date(today);
    lastSat.setDate(lastSat.getDate() + (6 - dow));
    const startSun = new Date(lastSat);
    startSun.setDate(startSun.getDate() - (52 * 7 + 6));
    const cells = [];
    const cur = new Date(startSun);
    while (cur <= lastSat) {
      const iso = cur.toISOString().slice(0, 10);
      cells.push({ date: iso, count: map[iso] || 0, future: cur > today });
      cur.setDate(cur.getDate() + 1);
    }
    const past = cells.filter(c => !c.future).map(c => c.count);
    const max = Math.max(1, ...past);
    const totalDays = past.filter(c => c > 0).length;
    const totalPrompts = past.reduce((a, b) => a + b, 0);
    const cellsHtml = cells.map(c => {
      if (c.future) return `<div class="heatmap-cell" style="opacity:0"></div>`;
      const level = c.count === 0 ? 0 : Math.min(4, Math.ceil((c.count / max) * 4));
      const cls = level === 0 ? "" : `l${level}`;
      const label = c.count === 0 ? "no prompts" : `${c.count} prompt${c.count === 1 ? "" : "s"}`;
      return `<div class="heatmap-cell ${cls}" title="${c.date} · ${label}"></div>`;
    }).join("");
    return `
      <div class="heatmap-wrap"><div class="heatmap">${cellsHtml}</div></div>
      <div class="heatmap-foot">
        <span>${totalDays} active day${totalDays === 1 ? "" : "s"} · ${totalPrompts.toLocaleString()} prompts</span>
        <span class="heatmap-legend">less <span class="heatmap-cell"></span><span class="heatmap-cell l1"></span><span class="heatmap-cell l2"></span><span class="heatmap-cell l3"></span><span class="heatmap-cell l4"></span> more</span>
      </div>
    `;
  }

  function buildSearchIndex(sessionsById) {
    if (typeof lunr === "undefined") return null;
    try {
      const docs = [];
      for (const session of sessionsById.values()) {
        const parts = [];
        for (const turn of (session.turns || [])) {
          if (turn.kind === "prompt" || turn.kind === "feedback") parts.push(turn.text || "");
          else if (turn.kind === "assistant") {
            for (const b of (turn.blocks || [])) {
              if (b.kind === "text") parts.push(b.text || "");
              else if (b.kind === "tool_use") parts.push(b.name + " " + JSON.stringify(b.input || ""));
            }
          }
        }
        docs.push({ id: session.session_id, text: parts.join(" ").slice(0, 200000) });
      }
      return lunr(function () {
        this.ref("id");
        this.field("text");
        docs.forEach(d => this.add(d));
      });
    } catch (e) { console.warn("lunr index build failed", e); return null; }
  }

  function openShortcutsModal() {
    const root = $("#modal-root");
    if (root.querySelector(".modal-backdrop")) return;
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>Keyboard shortcuts</h3>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="shortcuts-list">
            <div class="shortcut-row"><span class="label">Jump to search</span><span class="keys"><span class="kbd">/</span></span></div>
            <div class="shortcut-row"><span class="label">Go to Stats</span><span class="keys"><span class="kbd">g</span> <span class="kbd">s</span></span></div>
            <div class="shortcut-row"><span class="label">Go to Projects</span><span class="keys"><span class="kbd">g</span> <span class="kbd">p</span></span></div>
            <div class="shortcut-row"><span class="label">Go to Search</span><span class="keys"><span class="kbd">g</span> <span class="kbd">/</span></span></div>
            <div class="shortcut-row"><span class="label">Show this overlay</span><span class="keys"><span class="kbd">?</span></span></div>
            <div class="shortcut-row"><span class="label">Close overlay / blur field</span><span class="keys"><span class="kbd">Esc</span></span></div>
          </div>
        </div>
      </div>
    `;
    const close = () => { root.innerHTML = ""; };
    root.querySelector(".modal-close").addEventListener("click", close);
    root.querySelector(".modal-backdrop").addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) close(); });
  }

  function closeShortcutsModal() {
    const root = $("#modal-root");
    if (root) root.innerHTML = "";
  }

  async function loadSession(id) {
    if (!state.sessionsById) throw new Error("No folder loaded — choose your .claude/projects folder first");
    const s = state.sessionsById.get(id);
    if (!s) throw new Error("Session not found in current folder");
    return s;
  }

  function updateHeaderControls(loaded) {
    $$(".nav-tab").forEach(n => n.classList.toggle("hidden", !loaded));
    const meta = $("#manifest-meta");
    if (meta) meta.classList.toggle("hidden", !loaded);
    const search = $("#search-shortcut");
    if (search) search.classList.toggle("hidden", !loaded);
    const refreshBtn = $("#refresh-data-btn");
    if (refreshBtn) refreshBtn.classList.toggle("hidden", !loaded || !state.pickerHandle);
    const btn = $("#refresh-btn");
    if (btn) {
      btn.innerHTML = loaded
        ? `<span style="font-size:14px;line-height:1">⇄</span><span class="hidden sm:inline">Switch folder</span>`
        : `<span style="font-size:14px;line-height:1">⌂</span><span class="hidden sm:inline">Open folder</span>`;
      btn.title = loaded ? "Pick a different folder" : "Choose your .claude/projects folder";
    }
  }

  function freshnessLabel(at) {
    if (!at) return "";
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }

  function updateManifestMeta() {
    const meta = $("#manifest-meta");
    if (!meta || !state.manifest) return;
    const base = `${state.manifest.session_count} sessions · ${state.manifest.project_count} projects`;
    const folder = state.pickerHandle?.name ? ` · ${state.pickerHandle.name}` : "";
    const fresh = state.lastRefreshAt ? ` · fresh ${freshnessLabel(state.lastRefreshAt)}` : "";
    const busy = state.refreshing ? " · refreshing…" : "";
    meta.textContent = base + folder + fresh + busy;
    meta.title = `Folder handle: ${state.pickerHandle?.name || "(no handle)"} · last indexed ${state.lastRefreshAt ? new Date(state.lastRefreshAt).toLocaleString() : "never"}`;
  }

  async function refreshIndex({ silent = false } = {}) {
    if (state.refreshing) {
      console.warn("[refresh] already in progress — ignoring click");
      if (!silent) toast("Refresh already in progress");
      return;
    }
    console.group(`[refresh] start (silent=${silent})`);
    console.log("handle:", state.pickerHandle?.name || "(none)", state.pickerHandle);
    if (!state.pickerHandle) {
      console.warn("[refresh] no handle");
      console.groupEnd();
      if (!silent) toast("Refresh needs the original folder handle. Use Switch folder to reopen it.");
      return;
    }
    if (Picker.HAS_FS_ACCESS) {
      const ok = await Picker.ensurePermission(state.pickerHandle, !silent);
      console.log("[refresh] permission granted:", ok);
      if (!ok) {
        console.warn("[refresh] permission denied");
        console.groupEnd();
        if (!silent) toast("Folder permission was revoked. Switch folder to reopen.");
        return;
      }
    }
    state.refreshing = true;
    updateManifestMeta();
    const btn = $("#refresh-data-btn");
    if (btn) btn.disabled = true;
    const scrollY = window.scrollY;
    const oldCount = state.manifest?.session_count || 0;
    try {
      const entries = await Picker.collectFromHandle(state.pickerHandle);
      console.log("[refresh] entries collected:", entries.length);
      if (!entries.length) {
        if (!silent) toast("No sessions found in folder");
        return;
      }
      if (!silent) renderIndexingProgress(0, entries.length);
      const result = await IndexerClient.build(
        { handle: state.pickerHandle, entries },
        ({ processed, total }) => {
          if (!silent) renderIndexingProgress(processed, total);
        }
      );
      console.log("[refresh] build result:", result.manifest.session_count, "sessions,", result.manifest.project_count, "projects");
      if (!result.manifest.session_count) {
        if (!silent) toast("Folder has no readable sessions");
        return;
      }
      const sig = (m) => m
        ? `${m.session_count}:${(m.projects || []).reduce((a, p) => a + (p.total_messages || 0), 0)}:${(m.projects || []).map(p => p.last_active || "").sort().pop() || ""}`
        : "";
      const oldSig = sig(state.manifest);
      const newSig = sig(result.manifest);
      const changed = oldSig !== newSig;
      console.log("[refresh] sig old=", oldSig, "new=", newSig, "changed=", changed);
      state.manifest = result.manifest;
      state.sessionsById = result.sessionsById;
      state.history = result.history || [];
      state.searchIndex = null;
      setTimeout(() => { state.searchIndex = buildSearchIndex(result.sessionsById); }, 50);
      state.lastRefreshAt = Date.now();
      if (changed || !silent) {
        await route();
        window.scrollTo({ top: scrollY, behavior: "instant" });
      }
      const newCount = result.manifest.session_count;
      const diff = newCount - oldCount;
      const msg = changed
        ? `Refreshed · ${newCount} sessions${diff > 0 ? ` (+${diff} new)` : diff < 0 ? ` (${diff})` : ""}`
        : `No new data · ${newCount} sessions`;
      if (!silent) toast(msg);
      console.log("[refresh] done:", msg);
    } catch (e) {
      console.error("[refresh] failed", e);
      if (!silent) toast("Refresh failed: " + (e?.message || "unknown"));
    } finally {
      state.refreshing = false;
      if (btn) btn.disabled = false;
      updateManifestMeta();
      console.groupEnd();
    }
  }

  async function runIndexer(entries, handle) {
    if (!entries.length) {
      toast("No .jsonl session files in that folder. Try ~/.claude/projects");
      renderLanding();
      return;
    }
    renderIndexingProgress(0, entries.length);
    const result = await IndexerClient.build({ handle, entries }, ({ processed, total }) => {
      renderIndexingProgress(processed, total);
    });
    if (!result.manifest.session_count) {
      toast("That folder had no readable sessions");
      renderLanding();
      return;
    }
    state.manifest = result.manifest;
    state.sessionsById = result.sessionsById;
    state.history = result.history || [];
    state.searchIndex = null;
    setTimeout(() => { state.searchIndex = buildSearchIndex(result.sessionsById); }, 50);
    if (handle) {
      state.pickerHandle = handle;
      await Picker.saveHandle(handle);
    }
    state.lastRefreshAt = Date.now();
    updateManifestMeta();
    updateHeaderControls(true);
    const target = state.pendingHash;
    state.pendingHash = null;
    if (target && target !== location.hash) location.hash = target;
    else await route();
  }

  async function openPicker() {
    try {
      const { handle, entries } = await Picker.pick();
      await runIndexer(entries, handle);
    } catch (e) {
      if (e && e.message === "cancelled") return;
      if (e && e.name === "AbortError") return;
      console.error(e);
      toast(e?.message || "Could not open folder");
    }
  }

  async function resumeStoredHandle(prompt) {
    if (!state.pickerHandle && Picker.HAS_FS_ACCESS) {
      state.pickerHandle = await Picker.loadHandle();
    }
    if (!state.pickerHandle) return false;
    const ok = await Picker.ensurePermission(state.pickerHandle, prompt);
    if (!ok) return false;
    try {
      const entries = await Picker.collectFromHandle(state.pickerHandle);
      await runIndexer(entries, state.pickerHandle);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async function switchFolder() {
    await Picker.clearStoredHandle();
    state.manifest = null;
    state.sessionsById = null;
    state.pickerHandle = null;
    const meta = $("#manifest-meta");
    if (meta) meta.textContent = "";
    updateHeaderControls(false);
    await openPicker();
  }

  function setActiveNav(route) {
    let key;
    if (!route) key = "";
    else if (route.startsWith("project")) key = "projects";
    else key = route.split("/")[0];
    $$(".nav-tab").forEach(n => n.classList.toggle("active", (n.dataset.route || "") === key));
  }

  function tokenBar(u) {
    const total = (u?.total || 0) || ((u?.input || 0) + (u?.output || 0) + (u?.cache_create || 0) + (u?.cache_read || 0));
    if (!total) return `<div class="token-bar"></div>`;
    const pct = (n) => ((n / total) * 100).toFixed(2) + "%";
    return `<div class="token-bar" title="input ${(u.input||0).toLocaleString()} · output ${(u.output||0).toLocaleString()} · cache create ${(u.cache_create||0).toLocaleString()} · cache read ${(u.cache_read||0).toLocaleString()}">
      <span class="seg-in" style="width:${pct(u.input||0)}"></span>
      <span class="seg-out" style="width:${pct(u.output||0)}"></span>
      <span class="seg-cc" style="width:${pct(u.cache_create||0)}"></span>
      <span class="seg-cr" style="width:${pct(u.cache_read||0)}"></span>
    </div>`;
  }

  function tokenLegend() {
    return `<div class="legend">
      <span><span class="legend-dot" style="background:var(--feedback)"></span>input</span>
      <span><span class="legend-dot" style="background:var(--ok)"></span>output</span>
      <span><span class="legend-dot" style="background:var(--think)"></span>cache create</span>
      <span><span class="legend-dot" style="background:#38bdf8"></span>cache read</span>
    </div>`;
  }

  function renderStats(m) {
    const stats = m.stats || {};
    const tt = stats.tokens_total || { input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0 };
    const totalTurns = m.projects.reduce((a, p) => a + (p.total_messages || 0), 0);
    const totalTools = m.projects.reduce((a, p) => a + (p.total_tool_calls || 0), 0);
    const recentProjects = [...m.projects].sort((a, b) => (b.last_active || "").localeCompare(a.last_active || "")).slice(0, 6);
    const topByTokens = [...m.projects].sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0)).slice(0, 6);

    const topFiles = (stats.top_files || []).slice(0, 10);
    const topProj5 = topByTokens.slice(0, 5);
    const recent5 = recentProjects.slice(0, 5);

    app.innerHTML = `
      <div class="page fade-in" style="padding-top:20px">
        <div class="flex items-end justify-between gap-4 flex-wrap mb-4">
          <div>
            <div class="eyebrow">Overview</div>
            <h1 class="h1 mt-1">Your Claude activity</h1>
          </div>
          <p class="text-xs" style="color:var(--text-mute)">indexed from <span class="mono" style="color:var(--text-dim)">${escapeHtml(m.root)}</span></p>
        </div>

        <div class="grid gap-3 grid-cols-2 lg:grid-cols-5" style="grid-auto-rows:1fr">
          <div class="surface kpi kpi-hero col-span-2 lg:row-span-2" title="All tokens Claude has processed — your prompts in, replies out, plus cached chunks reused between turns. (Tokens ≈ words split into small chunks.)">
            <div>
              <div class="kpi-label">Total tokens</div>
              <div class="kpi-value">${fmtTokens(tt.total)}</div>
              <div class="kpi-sub">${m.session_count.toLocaleString()} sessions · ${totalTools.toLocaleString()} tool calls · ${fmtTokens(totalTurns)} turns</div>
            </div>
            <div class="mt-3">${tokenBar(tt)}</div>
            <div class="mt-2">${tokenLegend()}</div>
          </div>
          <div class="surface kpi" title="Each session is one continuous conversation with Claude Code. A new session starts when you launch Claude in a folder; closing the terminal ends it."><div class="kpi-label">Sessions</div><div class="kpi-value">${m.session_count}</div></div>
          <div class="surface kpi" title="Each project is a folder where you've used Claude Code at least once."><div class="kpi-label">Projects</div><div class="kpi-value">${m.project_count}</div></div>
          <div class="surface kpi" title="One turn = one entry in the transcript: your prompt, Claude's reply, a tool call, or a tool result."><div class="kpi-label">Turns</div><div class="kpi-value" title="${totalTurns.toLocaleString()} turns · One turn = one entry in the transcript: your prompt, Claude's reply, a tool call, or a tool result.">${fmtTokens(totalTurns)}</div></div>
          <div class="surface kpi" title="Tokens Claude read from you this period — your prompts plus any fresh conversation context sent on each turn."><div class="kpi-label">Input</div><div class="kpi-value" title="${tt.input.toLocaleString()} input tokens · Text Claude read from you this period — your prompts plus any fresh conversation context sent on each turn.">${fmtTokens(tt.input)}</div></div>
          <div class="surface kpi" title="Tokens Claude wrote back to you — its replies, explanations, and generated code."><div class="kpi-label">Output</div><div class="kpi-value" title="${tt.output.toLocaleString()} output tokens · Text Claude wrote back to you — its replies, explanations, and generated code.">${fmtTokens(tt.output)}</div></div>
          <div class="surface kpi" title="Cache = repeated context Claude stashes so it doesn't have to re-send everything each turn. W = chunks newly written into the cache; R = chunks reused from the cache (much cheaper than re-sending)."><div class="kpi-label">Cache R/W</div><div class="kpi-value" title="${tt.cache_read.toLocaleString()} read + ${tt.cache_create.toLocaleString()} created · Repeated context Claude stashes so it doesn't have to re-send everything each turn.">${fmtTokens(tt.cache_read + tt.cache_create)}</div></div>
        </div>

        <div class="grid gap-3 mt-3 lg:grid-cols-2">
          <div class="surface p-4" title="How much text Claude processed each day, broken down by model. Tall bars = heavy days. Stacks let you see which model did the work.">
            <div class="section-title"><h2 id="c-tokens-title">Tokens per day</h2><div id="c-tokens-legend" class="legend">${stats.dailyModelTokens ? "" : `<span><span class="legend-dot" style="background:var(--feedback)"></span>input</span><span><span class="legend-dot" style="background:var(--ok)"></span>output</span><span><span class="legend-dot" style="background:var(--think)"></span>cache create</span><span><span class="legend-dot" style="background:#38bdf8"></span>cache read</span>`}</div></div>
            <div class="chart-box"><canvas id="c-tokens"></canvas></div>
          </div>
          <div class="surface p-4" title="How often each tool (Read, Edit, Bash, Grep, Glob, etc.) was called across every session. The bigger the bar, the more Claude leans on that tool.">
            <div class="section-title"><h2>Tool usage</h2><span class="badge">${(stats.tool_frequency || []).length}</span></div>
            <div class="chart-box"><canvas id="c-tools"></canvas></div>
          </div>
          <div class="surface p-4" title="How many prompts you sent Claude on each day.">
            <div class="section-title"><h2>Prompts per day</h2></div>
            <div class="chart-box"><canvas id="c-daily"></canvas></div>
          </div>
          <div class="surface p-4" title="How long your sessions typically last. Lots of short sessions = quick fixes. Long sessions = deep coding marathons.">
            <div class="section-title"><h2>Session duration</h2></div>
            <div class="chart-box"><canvas id="c-dur"></canvas></div>
          </div>
        </div>

        <div class="grid gap-3 mt-3 lg:grid-cols-3">
          <div class="surface p-4" title="Projects ranked by total token usage. The bigger the project, the more you've worked in it.">
            <div class="section-title">
              <h2>Top projects</h2>
              <a class="section-link" href="#/projects">all <span>→</span></a>
            </div>
            <ol class="space-y-0.5">
              ${topProj5.map((p, i) => `
                <li>
                  <a href="#/project/${encodeURIComponent(p.slug)}" class="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-1 hover:bg-white/[.03] transition">
                    <span style="color:var(--text-mute);font-variant-numeric:tabular-nums;font-size:11px;width:14px;text-align:right">${i + 1}</span>
                    <span class="text-xs font-medium truncate flex-1" title="${escapeHtml(p.decoded_path)}">${escapeHtml(projShortName(p))}</span>
                    <span class="badge badge-token shrink-0" style="padding:1px 7px;font-size:10px" title="${(p.usage?.total||0).toLocaleString()}">${fmtTokens(p.usage?.total || 0)}</span>
                  </a>
                </li>`).join("")}
            </ol>
          </div>
          <div class="surface p-4" title="Projects sorted by when you last used Claude in them. The top one is what you're working on right now.">
            <div class="section-title">
              <h2>Recently active</h2>
              <a class="section-link" href="#/projects">all <span>→</span></a>
            </div>
            <ul class="space-y-0.5">
              ${recent5.map(p => `
                <li>
                  <a href="#/project/${encodeURIComponent(p.slug)}" class="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-1 hover:bg-white/[.03] transition">
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-medium truncate">${escapeHtml(projShortName(p))}</div>
                      <div class="text-[10px]" style="color:var(--text-mute)">${fmtRel(p.last_active)}</div>
                    </div>
                    <span class="badge shrink-0" style="padding:1px 7px;font-size:10px">${fmtTokens(p.usage?.total || 0)}</span>
                  </a>
                </li>`).join("")}
            </ul>
          </div>
          <div class="surface p-4" title="Files Claude has read, written, or edited most often across every session.">
            <div class="section-title"><h2>Top files</h2><span class="badge">${(stats.top_files || []).length}</span></div>
            <ol class="space-y-0.5">
              ${topFiles.map(([f, c], i) => `
                <li class="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/[.02]">
                  <span style="color:var(--text-mute);font-variant-numeric:tabular-nums;font-size:10px;width:14px;text-align:right">${i + 1}</span>
                  <span class="mono text-[11px] truncate flex-1" title="${escapeHtml(f)}">${escapeHtml(f.split(/[\\/]/).pop() || f)}</span>
                  <span style="color:var(--text-mute);font-size:10px;font-variant-numeric:tabular-nums">${c}</span>
                </li>`).join("") || `<li style="color:var(--text-mute)" class="text-xs">no data</li>`}
            </ol>
          </div>
        </div>

        <div class="surface p-3 mt-3" style="overflow:hidden" title="Days you've been active with Claude over the last 52 weeks. Each square is one day; darker = more prompts that day.">
          <div class="flex items-center justify-between mb-1.5">
            <div class="kpi-label">Activity · last 52 weeks</div>
          </div>
          ${renderHeatmap(stats.daily_prompts)}
        </div>
      </div>
    `;

    drawStatsCharts(stats);
  }

  function drawStatsCharts(stats) {
    const axis = { color: "#a6a7b6", font: { size: 11 } };
    const grid = { color: "rgba(255,255,255,0.04)" };
    const baseOpts = {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#1c1c28", borderColor: "#303044", borderWidth: 1, padding: 10, titleFont: { size: 12 }, bodyFont: { size: 12 }, cornerRadius: 8 } },
    };

    const tf = (stats.tool_frequency || []).slice(0, 15);
    new Chart($("#c-tools"), {
      type: "bar",
      data: { labels: tf.map(x => x[0]), datasets: [{ data: tf.map(x => x[1]), backgroundColor: "#fb923c", borderRadius: 6, borderSkipped: false }] },
      options: { ...baseOpts, indexAxis: "y", scales: { x: { ticks: axis, grid }, y: { ticks: { ...axis, font: { size: 10 } }, grid: { display: false } } } }
    });

    const dp = stats.daily_prompts || [];
    new Chart($("#c-daily"), {
      type: "line",
      data: { labels: dp.map(x => x[0]), datasets: [{ data: dp.map(x => x[1]), borderColor: "#60a5fa", backgroundColor: "rgba(96,165,250,0.18)", fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2 }] },
      options: { ...baseOpts, scales: { x: { ticks: axis, grid: { display: false } }, y: { ticks: axis, grid, beginAtZero: true } } }
    });

    const order = ["<1m", "1-5m", "5-30m", "30m-2h", "2-8h", ">8h"];
    const buckets = Object.fromEntries(stats.duration_buckets || []);
    new Chart($("#c-dur"), {
      type: "bar",
      data: { labels: order, datasets: [{ data: order.map(k => buckets[k] || 0), backgroundColor: "#34d399", borderRadius: 6, borderSkipped: false }] },
      options: { ...baseOpts, scales: { x: { ticks: axis, grid: { display: false } }, y: { ticks: axis, grid, beginAtZero: true } } }
    });

    const modelDaily = stats.dailyModelTokens;
    if (Array.isArray(modelDaily) && modelDaily.length) {
      const labels = modelDaily.map(d => d.date);
      const modelTotals = new Map();
      for (const d of modelDaily) {
        for (const [m, v] of Object.entries(d.tokensByModel || {})) {
          modelTotals.set(m, (modelTotals.get(m) || 0) + (Number(v) || 0));
        }
      }
      const topModels = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m]) => m);
      const palette = ["#818cf8", "#34d399", "#fbbf24", "#fb923c", "#38bdf8", "#f472b6", "#a78bfa"];
      const datasets = topModels.map((m, i) => ({
        label: shortenModel(m),
        data: modelDaily.map(d => Number((d.tokensByModel || {})[m]) || 0),
        backgroundColor: palette[i % palette.length],
        stack: "t",
        borderRadius: 2,
      }));
      const tokensChartTitle = $("#c-tokens-title");
      if (tokensChartTitle) tokensChartTitle.textContent = "Tokens per day · by model";
      const tokensChartLegend = $("#c-tokens-legend");
      if (tokensChartLegend) {
        tokensChartLegend.innerHTML = topModels.map((m, i) => `<span><span class="legend-dot" style="background:${palette[i % palette.length]}"></span>${escapeHtml(shortenModel(m))}</span>`).join("");
      }
      new Chart($("#c-tokens"), {
        type: "bar",
        data: { labels, datasets },
        options: {
          ...baseOpts,
          plugins: { ...baseOpts.plugins, tooltip: { ...baseOpts.plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toLocaleString()}` } } },
          scales: { x: { stacked: true, ticks: axis, grid: { display: false } }, y: { stacked: true, ticks: { ...axis, callback: v => fmtTokens(v) }, grid, beginAtZero: true } },
        },
      });
      return;
    }

    const dt = stats.daily_tokens || [];
    const labels = dt.map(x => x[0]);
    const series = (k) => dt.map(x => (x[1] || {})[k] || 0);
    new Chart($("#c-tokens"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "cache read", data: series("cache_read"), backgroundColor: "#38bdf8", stack: "t", borderRadius: 2 },
          { label: "cache create", data: series("cache_create"), backgroundColor: "#a78bfa", stack: "t", borderRadius: 2 },
          { label: "input", data: series("input"), backgroundColor: "#fbbf24", stack: "t", borderRadius: 2 },
          { label: "output", data: series("output"), backgroundColor: "#34d399", stack: "t", borderRadius: 2 },
        ],
      },
      options: {
        ...baseOpts,
        plugins: { ...baseOpts.plugins, tooltip: { ...baseOpts.plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toLocaleString()}` } } },
        scales: { x: { stacked: true, ticks: axis, grid: { display: false } }, y: { stacked: true, ticks: { ...axis, callback: v => fmtTokens(v) }, grid, beginAtZero: true } },
      },
    });
  }

  function shortenModel(m) {
    if (!m) return "?";
    return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  }

  function projectCardHtml(p) {
    return `
      <a href="#/project/${encodeURIComponent(p.slug)}" class="surface surface-hover proj-card">
        <div class="title">
          <div class="min-w-0">
            <h3 class="truncate" title="${escapeHtml(p.decoded_path)}">${escapeHtml(projShortName(p))}</h3>
            <div class="slug mono truncate">${escapeHtml(p.decoded_path)}</div>
          </div>
          <span class="badge badge-token shrink-0" title="${(p.usage?.total||0).toLocaleString()} tokens">${fmtTokens(p.usage?.total || 0)}</span>
        </div>
        <div>${tokenBar(p.usage || {})}</div>
        <div class="stat-grid">
          <div>Sessions<b>${p.session_count}</b></div>
          <div>Turns<b>${fmtTokens(p.total_messages || 0)}</b></div>
          <div>Tools<b>${fmtTokens(p.total_tool_calls || 0)}</b></div>
          <div>Active<b>${fmtDay(p.last_active)}</b></div>
        </div>
      </a>
    `;
  }

  function renderProjects(m) {
    app.innerHTML = `
      <div class="page fade-in">
        <div class="page-head">
          <div>
            <div class="crumbs"><a href="#/">Stats</a><span class="sep">/</span><span>Projects</span></div>
            <h1 class="h1">${m.project_count} project${m.project_count === 1 ? "" : "s"}</h1>
            <p class="text-sm mt-2" style="color:var(--text-dim)">${m.session_count.toLocaleString()} total sessions</p>
          </div>
        </div>

        <div class="toolbar mb-4">
          <div class="input-icon" style="flex:1;min-width:240px">
            <span class="icon">⌕</span>
            <input id="proj-q" class="input" placeholder="Filter projects by name or path…" value="${escapeHtml(state.projectsView.q)}" />
            <button id="proj-q-clear" class="clear ${state.projectsView.q ? "" : "hidden"}" title="Clear">✕</button>
          </div>
          <div class="toolbar-sep"></div>
          <label class="text-xs" style="color:var(--text-mute)">Sort</label>
          <select id="proj-sort" class="input" style="width:auto;min-width:170px">
            <option value="recent" ${state.projectsView.sort === "recent" ? "selected" : ""}>Recently active</option>
            <option value="tokens" ${state.projectsView.sort === "tokens" ? "selected" : ""}>Most tokens</option>
            <option value="sessions" ${state.projectsView.sort === "sessions" ? "selected" : ""}>Most sessions</option>
            <option value="turns" ${state.projectsView.sort === "turns" ? "selected" : ""}>Most turns</option>
            <option value="name" ${state.projectsView.sort === "name" ? "selected" : ""}>Name (A–Z)</option>
          </select>
          <span id="proj-count" class="badge ml-auto"></span>
        </div>

        <div id="proj-grid" class="card-grid"></div>
      </div>
    `;

    const render = () => {
      const q = state.projectsView.q.toLowerCase().trim();
      let list = m.projects.slice();
      if (q) list = list.filter(p => (p.decoded_path + " " + p.slug + " " + projShortName(p)).toLowerCase().includes(q));
      const sort = state.projectsView.sort;
      list.sort((a, b) => {
        if (sort === "recent") return (b.last_active || "").localeCompare(a.last_active || "");
        if (sort === "tokens") return (b.usage?.total || 0) - (a.usage?.total || 0);
        if (sort === "sessions") return (b.session_count || 0) - (a.session_count || 0);
        if (sort === "turns") return (b.total_messages || 0) - (a.total_messages || 0);
        if (sort === "name") return projShortName(a).localeCompare(projShortName(b));
        return 0;
      });
      $("#proj-count").textContent = `${list.length} of ${m.projects.length}`;
      const grid = $("#proj-grid");
      grid.innerHTML = list.length
        ? list.map(projectCardHtml).join("")
        : `<div class="empty" style="grid-column:1/-1">
            <div class="empty-icon">⌕</div>
            <div class="empty-title">No projects match "${escapeHtml(state.projectsView.q)}"</div>
            <div class="empty-sub">Clear the filter or try a shorter query.</div>
          </div>`;
    };

    const qInput = $("#proj-q");
    const clearBtn = $("#proj-q-clear");
    qInput.addEventListener("input", debounce(() => {
      state.projectsView.q = qInput.value;
      clearBtn.classList.toggle("hidden", !qInput.value);
      render();
    }, 120));
    clearBtn.addEventListener("click", () => { qInput.value = ""; state.projectsView.q = ""; clearBtn.classList.add("hidden"); render(); qInput.focus(); });
    $("#proj-sort").addEventListener("change", e => { state.projectsView.sort = e.target.value; render(); });
    render();
  }

  function renderProject(m, slug) {
    const p = m.projects.find(x => x.slug === slug);
    if (!p) {
      app.innerHTML = `<div class="page"><div class="surface error-card p-6"><p class="font-semibold" style="color:var(--err)">Project not found</p><p class="text-sm mt-2" style="color:var(--text-dim)">Slug: <span class="mono">${escapeHtml(slug)}</span></p><a class="btn btn-sm mt-4 inline-flex" href="#/projects">← All projects</a></div></div>`;
      return;
    }
    const view = { q: "", sort: { col: "started_at", dir: "desc" } };
    app.innerHTML = `
      <div class="page fade-in">
        <div class="page-head">
          <div class="min-w-0" style="flex:1">
            <div class="crumbs"><a href="#/">Stats</a><span class="sep">/</span><a href="#/projects">Projects</a><span class="sep">/</span><span class="truncate">${escapeHtml(projShortName(p))}</span></div>
            <h1 class="h1 truncate" title="${escapeHtml(p.decoded_path)}">${escapeHtml(projShortName(p))}</h1>
            <p class="text-xs mono mt-2" style="color:var(--text-mute)">${escapeHtml(p.decoded_path)}</p>
          </div>
          <div class="flex gap-2 flex-wrap">
            <span class="badge">${p.session_count} sessions</span>
            <span class="badge">${p.total_messages.toLocaleString()} turns</span>
            <span class="badge">${p.total_tool_calls.toLocaleString()} tools</span>
            <span class="badge badge-token" title="${(p.usage?.total||0).toLocaleString()}">${fmtTokens(p.usage?.total || 0)} tokens</span>
          </div>
        </div>

        <div class="toolbar mb-4">
          <div class="input-icon" style="flex:1;min-width:240px">
            <span class="icon">⌕</span>
            <input id="sess-q" class="input" placeholder="Filter sessions by first prompt, branch, or session id…" />
            <button id="sess-q-clear" class="clear hidden" title="Clear">✕</button>
          </div>
          <span id="sess-count" class="badge"></span>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr id="sess-head">
                <th class="sortable" data-col="started_at">Started <span class="sort-arrow">↓</span></th>
                <th class="sortable" data-col="duration_ms">Duration <span class="sort-arrow"></span></th>
                <th>Branch</th>
                <th>First prompt</th>
                <th class="text-right sortable" data-col="turns">Turns <span class="sort-arrow"></span></th>
                <th class="text-right sortable" data-col="tools">Tools <span class="sort-arrow"></span></th>
                <th class="text-right sortable" data-col="tokens">Tokens <span class="sort-arrow"></span></th>
                <th>Model</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="sess-body"></tbody>
          </table>
        </div>
      </div>
    `;

    const render = () => {
      const q = view.q.toLowerCase().trim();
      let rows = p.sessions.slice();
      if (q) rows = rows.filter(s => ((s.first_prompt || "") + " " + (s.git_branch || "") + " " + (s.session_id || "")).toLowerCase().includes(q));
      const { col, dir } = view.sort;
      const k = {
        started_at: s => s.started_at || "",
        duration_ms: s => s.duration_ms || 0,
        turns: s => s.counts?.turns || 0,
        tools: s => s.counts?.tool_calls || 0,
        tokens: s => s.usage?.total || 0,
      }[col];
      rows.sort((a, b) => {
        const A = k(a), B = k(b);
        if (A < B) return dir === "asc" ? -1 : 1;
        if (A > B) return dir === "asc" ? 1 : -1;
        return 0;
      });
      $("#sess-count").textContent = `${rows.length} of ${p.sessions.length}`;
      $("#sess-body").innerHTML = rows.length ? rows.map(s => `
        <tr data-id="${escapeHtml(s.session_id)}">
          <td class="whitespace-nowrap" style="color:var(--text-dim)" title="${escapeHtml(s.started_at || "")}">${fmtDate(s.started_at)}</td>
          <td class="whitespace-nowrap">${fmtDur(s.duration_ms)}</td>
          <td class="mono text-xs" style="color:var(--text-dim)">${escapeHtml(s.git_branch || "—")}</td>
          <td class="col-prompt"><span class="first-prompt">${escapeHtml(s.first_prompt || "(no prompt captured)")}</span></td>
          <td class="text-right tabular-nums">${s.counts.turns}</td>
          <td class="text-right tabular-nums">${s.counts.tool_calls}</td>
          <td class="text-right tabular-nums" style="color:#6ee7b7" title="input ${(s.usage?.input||0).toLocaleString()} · output ${(s.usage?.output||0).toLocaleString()} · cache create ${(s.usage?.cache_create||0).toLocaleString()} · cache read ${(s.usage?.cache_read||0).toLocaleString()}">${fmtTokens(s.usage?.total || 0)}</td>
          <td class="mono text-xs" style="color:var(--text-dim)">${escapeHtml(s.model || "—")}</td>
          <td>${s.has_error ? `<span class="badge badge-err">err</span>` : ""}</td>
        </tr>`).join("") : `<tr><td colspan="9"><div class="empty"><div class="empty-icon">⌕</div><div class="empty-title">No sessions match</div><div class="empty-sub">Try a different filter.</div></div></td></tr>`;
      $$("#sess-head th").forEach(th => {
        const col = th.dataset.col;
        if (!col) return;
        const active = col === view.sort.col;
        th.classList.toggle("sort-active", active);
        const arrow = $(".sort-arrow", th);
        if (arrow) arrow.textContent = active ? (view.sort.dir === "asc" ? "↑" : "↓") : "";
      });
    };

    $$("#sess-head th.sortable").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (view.sort.col === col) view.sort.dir = view.sort.dir === "asc" ? "desc" : "asc";
        else { view.sort.col = col; view.sort.dir = "desc"; }
        render();
      });
    });
    const qInput = $("#sess-q");
    const clearBtn = $("#sess-q-clear");
    qInput.addEventListener("input", debounce(() => {
      view.q = qInput.value;
      clearBtn.classList.toggle("hidden", !qInput.value);
      render();
    }, 120));
    clearBtn.addEventListener("click", () => { qInput.value = ""; view.q = ""; clearBtn.classList.add("hidden"); render(); qInput.focus(); });
    $("#sess-body").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) location.hash = `#/session/${encodeURIComponent(tr.dataset.id)}`;
    });
    render();
  }

  function avatar(kind, ch) {
    return `<span class="avatar ${kind}">${ch}</span>`;
  }

  function renderToolUse(b) {
    if (isEditLike(b.name) && b.input && (b.input.old_string != null || Array.isArray(b.input.edits))) {
      return renderDiff(b.input, b.name);
    }
    const inputStr = JSON.stringify(b.input ?? {}, null, 2);
    const preview = (() => {
      const inp = b.input || {};
      if (inp.file_path) return inp.file_path;
      if (inp.command) return truncate(inp.command, 90);
      if (inp.pattern) return inp.pattern;
      if (inp.url) return inp.url;
      if (inp.path) return inp.path;
      return "";
    })();
    return `
      <details class="tool-card">
        <summary>
          <span class="caret">▸</span>
          <span class="tname">${escapeHtml(b.name || "tool")}</span>
          ${preview ? `<span class="mono" style="color:var(--text-dim);font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(preview)}</span>` : ""}
          <span class="tid">${escapeHtml(b.id || "")}</span>
        </summary>
        <pre class="mono scroll-thin whitespace-pre-wrap">${escapeHtml(inputStr)}</pre>
      </details>`;
  }

  function renderAssistantBlocks(blocks) {
    return blocks.map(b => {
      if (b.kind === "text") {
        return `<div class="body markdown-body">${renderMarkdown(b.text || "")}</div>`;
      }
      if (b.kind === "tool_use") return renderToolUse(b);
      if (b.kind === "thinking") {
        return `<details class="my-1">
          <summary class="text-[11px] inline-flex items-center gap-2" style="color:var(--text-mute)"><span class="caret">▸</span>thinking</summary>
          <div class="body markdown-body text-xs mt-1" style="color:var(--text-dim)">${renderMarkdown(b.text || "")}</div>
        </details>`;
      }
      return "";
    }).join("");
  }

  function renderTurn(turn, session) {
    const ts = turn.ts ? `<span class="ts">${escapeHtml(turn.ts.replace("T", " ").replace("Z", "").slice(0, 19))}</span>` : "";
    if (turn.kind === "prompt") {
      return `<div class="turn user" data-kind="prompt" data-uuid="${escapeHtml(turn.uuid || "")}">${avatar("user", "U")}<div class="min-w-0">
        <div class="turn-head"><span class="tag" style="color:#93c5fd">Prompt</span>${ts}</div>
        <div class="fade-text body markdown-body" data-expandable>${renderMarkdown(turn.text)}</div>
        <button class="show-more" data-toggle-expand>show more</button>
      </div></div>`;
    }
    if (turn.kind === "feedback") {
      return `<div class="turn feedback" data-kind="feedback" data-uuid="${escapeHtml(turn.uuid || "")}">${avatar("feedback", "F")}<div class="min-w-0">
        <div class="turn-head"><span class="tag" style="color:#fcd34d">Feedback</span>${ts}</div>
        <div class="fade-text body markdown-body" data-expandable>${renderMarkdown(turn.text)}</div>
        <button class="show-more" data-toggle-expand>show more</button>
      </div></div>`;
    }
    if (turn.kind === "assistant") {
      return `<div class="turn assistant" data-kind="assistant">${avatar("asst", "A")}<div class="min-w-0">
        <div class="turn-head"><span class="tag" style="color:#cbd5e1">Assistant</span>${ts}</div>
        <div class="mt-1">${renderAssistantBlocks(turn.blocks || [])}</div>
      </div></div>`;
    }
    if (turn.kind === "tool_result") {
      const cls = turn.is_error ? "tool-result-err" : "tool-result";
      const av = turn.is_error ? avatar("err", "!") : avatar("ok", "✓");
      const label = turn.is_error ? "Tool error" : "Tool result";
      const name = session.tool_use_index?.[turn.tool_use_id] || "";
      const text = turn.text || "";
      return `<div class="turn ${cls}" data-kind="tool_result">${av}<div class="min-w-0">
        <details>
          <summary class="turn-head"><span class="caret">▸</span><span class="tag" style="color:${turn.is_error ? '#fca5a5' : '#6ee7b7'}">${label}</span>${name ? `<span class="mono meta">${escapeHtml(name)}</span>` : ""}<span class="right"><span class="meta">${text.length.toLocaleString()} chars</span>${ts}</span></summary>
          <pre class="mono body text-xs scroll-thin" style="max-height:24rem;overflow:auto;margin-top:8px">${escapeHtml(truncate(text, 8000))}</pre>
        </details>
      </div></div>`;
    }
    if (turn.kind === "system") {
      return `<div class="turn system" data-kind="system">${avatar("sys", "S")}<div class="min-w-0">
        <details>
          <summary class="turn-head"><span class="caret">▸</span><span class="tag">system reminder</span><span class="right">${ts}</span></summary>
          <pre class="mono body text-xs scroll-thin" style="max-height:18rem;overflow:auto;margin-top:8px">${escapeHtml(truncate(turn.text || "", 4000))}</pre>
        </details>
      </div></div>`;
    }
    if (turn.kind === "attachment") {
      return `<div class="turn attachment" data-kind="attachment">${avatar("attach", "@")}<div class="min-w-0">
        <div class="turn-head"><span class="tag" style="color:#c4b5fd">attachment</span><span class="mono meta">${escapeHtml(turn.attachment_type || "")}</span>${ts}</div>
        <div class="text-xs mt-1" style="color:var(--text-dim)">${escapeHtml(turn.summary || "")}</div>
      </div></div>`;
    }
    if (turn.kind === "queue") {
      return `<div class="turn queue" data-kind="queue">${avatar("queue", "Q")}<div class="min-w-0">
        <div class="turn-head"><span class="tag" style="color:#67e8f9">queue ${escapeHtml(turn.operation || "")}</span>${ts}</div>
        <div class="body text-xs mt-1" style="color:var(--text-dim)">${escapeHtml(truncate(turn.text || "", 600))}</div>
      </div></div>`;
    }
    return "";
  }

  async function renderSession(id) {
    app.innerHTML = `<div class="page"><div class="surface p-6"><div class="skeleton" style="height:24px;width:60%"></div><div class="skeleton mt-3" style="height:14px;width:40%"></div><div class="skeleton mt-4" style="height:120px"></div><div class="skeleton mt-3" style="height:80px"></div></div></div>`;
    let s;
    try { s = await loadSession(id); } catch (e) {
      app.innerHTML = `<div class="page"><div class="surface error-card p-6"><p class="font-semibold" style="color:var(--err)">${escapeHtml(e.message)}</p><a class="btn btn-sm mt-4 inline-flex" href="#/projects">← All projects</a></div></div>`;
      return;
    }
    const counts = s.counts || {};
    const promptTurns = (s.turns || []).filter(t => t.kind === "prompt" || t.kind === "feedback");
    app.innerHTML = `
      <div class="page fade-in">
        <div class="page-head">
          <div class="min-w-0" style="flex:1">
            <div class="crumbs"><a href="#/projects">Projects</a><span class="sep">/</span><a href="#/project/${encodeURIComponent(s.project_slug)}" class="truncate">${escapeHtml(s.project_path || s.project_slug)}</a><span class="sep">/</span><span>Session</span></div>
            <h1 class="h1 mono" style="font-size:18px;font-weight:600">${escapeHtml(s.session_id)}</h1>
            <p class="text-xs mt-2" style="color:var(--text-dim)">
              ${fmtDate(s.started_at)} → ${fmtDate(s.ended_at)} · <span style="color:var(--text)">${fmtDur(s.duration_ms)}</span>
            </p>
            <p class="text-[11px] mono mt-1" style="color:var(--text-mute)">cwd: ${escapeHtml(s.cwd || "—")} · branch: ${escapeHtml(s.git_branch || "—")} · model: ${escapeHtml(s.model || "—")} · perm: ${escapeHtml(s.permission_mode || "—")}</p>
          </div>
        </div>

        <div class="grid gap-3 grid-cols-3 md:grid-cols-6">
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Prompts</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${counts.prompts || 0}</div></div>
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Feedback</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${counts.feedback || 0}</div></div>
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Assistant</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${counts.assistant || 0}</div></div>
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Tool calls</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${counts.tool_calls || 0}</div></div>
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Errors</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums;color:${counts.errors ? 'var(--err)' : 'var(--text)'}">${counts.errors || 0}</div></div>
          <div class="surface kpi" style="padding:14px"><div class="kpi-label">Turns</div><div style="font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${counts.turns || 0}</div></div>
        </div>

        <div class="surface p-4 mt-4">
          <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div><span class="kpi-label">Tokens</span> <span style="font-size:18px;font-weight:700;margin-left:8px;font-variant-numeric:tabular-nums">${fmtTokens(s.usage?.total || 0)}</span></div>
            ${tokenLegend()}
          </div>
          ${tokenBar(s.usage || {})}
          <div class="grid gap-3 mt-3 grid-cols-2 md:grid-cols-4 text-xs" style="color:var(--text-dim)">
            <div>Input <b style="color:var(--text)" title="${(s.usage?.input||0).toLocaleString()}">${fmtTokens(s.usage?.input || 0)}</b></div>
            <div>Output <b style="color:var(--text)" title="${(s.usage?.output||0).toLocaleString()}">${fmtTokens(s.usage?.output || 0)}</b></div>
            <div>Cache create <b style="color:var(--text)" title="${(s.usage?.cache_create||0).toLocaleString()}">${fmtTokens(s.usage?.cache_create || 0)}</b></div>
            <div>Cache read <b style="color:var(--text)" title="${(s.usage?.cache_read||0).toLocaleString()}">${fmtTokens(s.usage?.cache_read || 0)}</b></div>
          </div>
        </div>

        <div class="mt-6 grid gap-5" style="grid-template-columns:minmax(0,1fr) ${promptTurns.length > 1 ? "240px" : "0"}">
          <div class="min-w-0">
            <div class="timeline-bar">
              <span class="count-chip badge" id="turns-count"></span>
              <label class="chk"><input type="checkbox" id="hide-system"> system</label>
              <label class="chk"><input type="checkbox" id="hide-toolresults"> tool results</label>
              <label class="chk"><input type="checkbox" id="hide-thinking" checked> thinking</label>
              <div class="input-icon ml-auto" style="min-width:200px">
                <span class="icon">⌕</span>
                <input id="session-find" placeholder="Find in turns…" class="input" />
              </div>
            </div>
            <div id="turns" class="turn-list"></div>
          </div>
          ${promptTurns.length > 1 ? `
            <aside class="session-toc surface p-3">
              <div class="kpi-label mb-2">Prompts (${promptTurns.length})</div>
              <ol id="toc-list" class="space-y-0.5"></ol>
            </aside>
          ` : ""}
        </div>
      </div>
    `;

    const tocList = $("#toc-list");
    if (tocList) {
      tocList.innerHTML = promptTurns.map(t => `
        <li data-uuid="${escapeHtml(t.uuid || "")}" data-kind="${t.kind}">
          <span class="truncate" style="color:${t.kind === 'feedback' ? '#fcd34d' : 'var(--text-dim)'}">${escapeHtml(truncate((t.text || "").replace(/\s+/g, " "), 80))}</span>
        </li>`).join("");
      tocList.addEventListener("click", e => {
        const li = e.target.closest("li[data-uuid]");
        if (!li) return;
        const target = $(`#turns [data-uuid="${CSS.escape(li.dataset.uuid)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          target.style.outline = "2px solid rgba(129,140,248,0.6)";
          setTimeout(() => { target.style.outline = ""; }, 1200);
        }
      });
    }

    const renderTurns = () => {
      const hideSys = $("#hide-system").checked;
      const hideTR = $("#hide-toolresults").checked;
      const hideThink = $("#hide-thinking").checked;
      const q = ($("#session-find").value || "").trim().toLowerCase();
      const filtered = s.turns.filter(t => {
        if (hideSys && t.kind === "system") return false;
        if (hideTR && t.kind === "tool_result") return false;
        if (!q) return true;
        const hay = t.text || JSON.stringify(t.blocks || "") || "";
        return hay.toLowerCase().includes(q);
      });
      const turnsHtml = filtered.map(t => {
        if (hideThink && t.kind === "assistant") {
          const blocks = (t.blocks || []).filter(b => b.kind !== "thinking");
          return renderTurn({ ...t, blocks }, s);
        }
        return renderTurn(t, s);
      }).join("");
      $("#turns").innerHTML = turnsHtml || `<div class="empty"><div class="empty-icon">⌕</div><div class="empty-title">No turns match</div><div class="empty-sub">Try clearing filters or your search query.</div></div>`;
      $("#turns-count").textContent = `${filtered.length} of ${s.turns.length} turns`;
      $$("#turns [data-toggle-expand]").forEach(btn => {
        btn.addEventListener("click", () => {
          const node = btn.previousElementSibling;
          node.classList.toggle("expanded");
          btn.textContent = node.classList.contains("expanded") ? "show less" : "show more";
        });
      });
    };
    renderTurns();
    ["hide-system", "hide-toolresults", "hide-thinking"].forEach(id => $("#" + id).addEventListener("change", renderTurns));
    $("#session-find").addEventListener("input", debounce(renderTurns, 140));
  }

  function highlight(text, q) {
    const safe = escapeHtml(truncate(text || "", 320));
    if (!q) return safe;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    return safe.replace(re, m => `<mark>${m}</mark>`);
  }

  async function renderSearch(m) {
    const initial = new URLSearchParams(location.hash.split("?")[1] || "");
    app.innerHTML = `
      <div class="page fade-in">
        <div class="page-head" style="margin-bottom:16px">
          <div>
            <div class="eyebrow">Search</div>
            <h1 class="h1">Find anything</h1>
          </div>
        </div>

        <div class="surface" style="padding:10px 12px">
          <div class="flex flex-wrap gap-2 items-center">
            <div class="input-icon" style="flex:1 1 280px;min-width:240px">
              <span class="icon">⌕</span>
              <input id="q" autofocus class="input" placeholder="Search prompts, replies, tool inputs…" value="${escapeHtml(initial.get("q") || "")}" />
              <button id="q-clear" class="clear ${initial.get("q") ? "" : "hidden"}" title="Clear">✕</button>
            </div>
            <select id="proj" class="input" style="flex:0 0 auto;width:170px">
              <option value="">All projects</option>
              ${m.projects.map(p => `<option value="${escapeHtml(p.slug)}" ${initial.get("proj") === p.slug ? "selected" : ""}>${escapeHtml(projShortName(p))}</option>`).join("")}
            </select>
            <select id="tool" class="input" style="flex:0 0 auto;width:150px">
              <option value="">Any tool</option>
              ${(m.stats?.tool_frequency || []).map(([n, c]) => `<option value="${escapeHtml(n)}" ${initial.get("tool") === n ? "selected" : ""}>${escapeHtml(n)} (${c})</option>`).join("")}
            </select>
            <input type="date" id="from" class="input" style="flex:0 0 auto;width:140px" title="From" value="${escapeHtml(initial.get("from") || "")}" />
            <input type="date" id="to" class="input" style="flex:0 0 auto;width:140px" title="To" value="${escapeHtml(initial.get("to") || "")}" />
            <label class="chk" style="flex:0 0 auto;padding:0 4px"><input type="checkbox" id="errs" ${initial.get("errs") === "1" ? "checked" : ""}/> errors only</label>
            <button id="reset" class="btn btn-ghost btn-sm">Reset</button>
            <button id="go" class="btn btn-primary">Search</button>
          </div>
        </div>

        <div id="progress" class="hidden mt-4">
          <div class="text-xs mb-2" style="color:var(--text-dim)" id="progress-label"></div>
          <div class="progress-bar"><span style="width:0%"></span></div>
        </div>

        <div id="results" class="mt-4 text-sm" style="color:var(--text-dim)">
          <div class="empty">
            <div class="empty-icon">⌕</div>
            <div class="empty-title">Type a query to begin</div>
            <div class="empty-sub">Filter by project, tool, date, or errors only.</div>
          </div>
        </div>
      </div>
    `;

    let cancel = false;

    const persistHash = () => {
      const params = new URLSearchParams();
      const q = $("#q").value.trim();
      const p = $("#proj").value;
      const t = $("#tool").value;
      const fr = $("#from").value;
      const to = $("#to").value;
      const er = $("#errs").checked;
      if (q) params.set("q", q);
      if (p) params.set("proj", p);
      if (t) params.set("tool", t);
      if (fr) params.set("from", fr);
      if (to) params.set("to", to);
      if (er) params.set("errs", "1");
      const qs = params.toString();
      const newHash = "#/search" + (qs ? "?" + qs : "");
      if (location.hash !== newHash) history.replaceState(null, "", newHash);
    };

    const run = async () => {
      cancel = true;
      await new Promise(r => setTimeout(r, 0));
      cancel = false;
      persistHash();
      const q = $("#q").value.trim();
      const projSlug = $("#proj").value;
      const toolName = $("#tool").value;
      const from = $("#from").value;
      const to = $("#to").value;
      const errsOnly = $("#errs").checked;
      const ql = q.toLowerCase();
      let allowedIds = null;
      if (q && state.searchIndex && typeof lunr !== "undefined") {
        try {
          const escaped = q.replace(/[~^:*+\-?]/g, " ").trim();
          if (escaped) {
            const hits = state.searchIndex.search(escaped.split(/\s+/).map(t => `${t}*`).join(" "));
            allowedIds = new Set(hits.map(h => h.ref));
          }
        } catch { allowedIds = null; }
      }
      const candidates = [];
      for (const p of m.projects) {
        if (projSlug && p.slug !== projSlug) continue;
        for (const s of p.sessions) {
          if (errsOnly && !s.has_error) continue;
          if (from && (s.started_at || "") < from) continue;
          if (to && (s.started_at || "") > to + "T23:59:59") continue;
          if (allowedIds && !allowedIds.has(s.session_id)) continue;
          candidates.push({ proj: p, meta: s });
        }
      }
      const prog = $("#progress");
      const progBar = $("#progress .progress-bar > span");
      const progLabel = $("#progress-label");
      prog.classList.remove("hidden");
      progLabel.textContent = `Scanning ${candidates.length} sessions…`;
      progBar.style.width = "0%";
      $("#results").innerHTML = "";
      const hits = [];
      let i = 0;
      for (const c of candidates) {
        if (cancel) return;
        i++;
        if (i % 4 === 0) {
          progBar.style.width = `${(i / candidates.length) * 100}%`;
          progLabel.textContent = `Scanning ${i} / ${candidates.length} — ${hits.length} match${hits.length === 1 ? "" : "es"}`;
          await new Promise(r => setTimeout(r, 0));
        }
        let session;
        try { session = await loadSession(c.meta.session_id); } catch { continue; }
        let matched = false;
        let snippet = "";
        if (toolName) {
          const has = (session.turns || []).some(t => t.kind === "assistant" && (t.blocks || []).some(b => b.kind === "tool_use" && b.name === toolName));
          if (!has) continue;
        }
        if (!q) {
          if (toolName || errsOnly || projSlug || from || to) { matched = true; snippet = c.meta.first_prompt || ""; }
        } else {
          for (const t of session.turns || []) {
            if (t.kind === "prompt" || t.kind === "feedback") {
              if ((t.text || "").toLowerCase().includes(ql)) { matched = true; snippet = t.text; break; }
            } else if (t.kind === "assistant") {
              for (const b of (t.blocks || [])) {
                if (b.kind === "text" && (b.text || "").toLowerCase().includes(ql)) { matched = true; snippet = b.text; break; }
                if (b.kind === "tool_use") {
                  const inp = JSON.stringify(b.input || {});
                  if (inp.toLowerCase().includes(ql)) { matched = true; snippet = `${b.name}: ${inp}`; break; }
                }
              }
              if (matched) break;
            }
          }
        }
        if (matched) hits.push({ proj: c.proj, meta: c.meta, snippet });
        if (hits.length >= 200) break;
      }
      progBar.style.width = "100%";
      setTimeout(() => prog.classList.add("hidden"), 400);
      if (!hits.length) {
        $("#results").innerHTML = `<div class="empty"><div class="empty-icon">∅</div><div class="empty-title">No matches</div><div class="empty-sub">Try a different query or widen your filters.</div></div>`;
        return;
      }
      $("#results").innerHTML = `
        <p class="text-xs mb-3" style="color:var(--text-mute)">${hits.length} session${hits.length === 1 ? "" : "s"} matched${hits.length === 200 ? " (capped)" : ""}.</p>
        <ul class="space-y-2">
          ${hits.map(h => `
            <li class="surface p-4 surface-hover">
              <div class="flex items-center gap-2 text-[11px] flex-wrap" style="color:var(--text-mute)">
                <a class="hover:text-white" href="#/project/${encodeURIComponent(h.proj.slug)}">${escapeHtml(projShortName(h.proj))}</a>
                <span>·</span><span>${fmtDate(h.meta.started_at)}</span>
                <span>·</span><span class="mono">${escapeHtml(h.meta.git_branch || "—")}</span>
                <span>·</span><span class="badge badge-token" style="padding:1px 7px">${fmtTokens(h.meta.usage?.total || 0)}</span>
                ${h.meta.has_error ? `<span class="badge badge-err" style="padding:1px 7px">err</span>` : ""}
              </div>
              <a class="block mt-1.5 font-medium hover:underline" style="color:var(--accent-2)" href="#/session/${encodeURIComponent(h.meta.session_id)}">${escapeHtml(truncate(h.meta.first_prompt || "(no prompt)", 140))}</a>
              <div class="mt-2 text-xs whitespace-pre-wrap" style="color:var(--text-dim);line-height:1.55">${highlight(h.snippet, q)}</div>
            </li>`).join("")}
        </ul>`;
    };

    const debouncedRun = debounce(run, 280);

    $("#go").addEventListener("click", run);
    $("#q").addEventListener("keydown", e => { if (e.key === "Enter") run(); });
    $("#q").addEventListener("input", e => {
      $("#q-clear").classList.toggle("hidden", !e.target.value);
      if (e.target.value.length >= 2) debouncedRun();
    });
    $("#q-clear").addEventListener("click", () => { $("#q").value = ""; $("#q-clear").classList.add("hidden"); $("#q").focus(); persistHash(); });
    $("#reset").addEventListener("click", () => {
      $("#q").value = ""; $("#proj").value = ""; $("#tool").value = "";
      $("#from").value = ""; $("#to").value = ""; $("#errs").checked = false;
      $("#q-clear").classList.add("hidden");
      persistHash();
      $("#results").innerHTML = `<div class="empty"><div class="empty-icon">⌕</div><div class="empty-title">Type a query to begin</div></div>`;
    });

    if (initial.get("q") || initial.get("proj") || initial.get("tool") || initial.get("from") || initial.get("to") || initial.get("errs")) {
      run();
    }
  }

  function renderLanding(opts = {}) {
    updateHeaderControls(false);
    const stored = opts.canResume;
    const fsSupported = Picker.HAS_FS_ACCESS;
    app.innerHTML = `
      <section class="landing fade-in">
        <div class="landing-hero">
          <div class="landing-mark"></div>
          <div class="eyebrow">Claude Dashboard</div>
          <h1 class="h-mega">Every prompt, reply,<br>and tool call —<br><span class="grad">visualised</span>.</h1>
          <p class="sub">A private, in-browser dashboard for your Claude Code transcripts. Pick your <span class="mono">.claude</span> folder for full stats — or just <span class="mono">.claude/projects</span> for the basics.</p>

          <div class="landing-actions">
            ${stored ? `<button id="resume-folder" class="btn btn-primary btn-lg">Resume last folder</button>` : ""}
            <button id="open-folder" class="btn ${stored ? "" : "btn-primary"} btn-lg">
              <span>${stored ? "Open a different folder" : "Open your .claude folder"}</span>
            </button>
          </div>

          <div class="landing-hint">
            <div><span class="kbd">~</span>/<span class="mono">.claude</span> &nbsp;·&nbsp; macOS &amp; Linux</div>
            <div><span class="mono">C:\\Users\\&lt;you&gt;\\.claude</span> &nbsp;·&nbsp; Windows</div>
            <div style="margin-top:8px;font-size:11px">Picking the full <span class="mono">.claude</span> folder unlocks the History tab (from <span class="mono">history.jsonl</span>).</div>
          </div>
        </div>

        <div class="landing-features">
          <div class="feature">
            <div class="feature-icon" style="color:var(--ok)">●</div>
            <h3>100% private</h3>
            <p>Files are read directly in your browser. Nothing is uploaded, stored, or tracked. Close the tab and it's gone.</p>
          </div>
          <div class="feature">
            <div class="feature-icon" style="color:var(--accent)">●</div>
            <h3>Deep search</h3>
            <p>Find any prompt, reply, or tool input across every session — filter by project, tool, date, or errors.</p>
          </div>
          <div class="feature">
            <div class="feature-icon" style="color:var(--feedback)">●</div>
            <h3>Real stats</h3>
            <p>Token usage, tool frequency, top files touched, prompts per day, session duration distribution.</p>
          </div>
        </div>

        <div class="landing-foot">
          ${fsSupported
            ? `<span class="badge" style="color:var(--ok);border-color:rgba(52,211,153,0.3);background:rgba(52,211,153,0.06)">✓ Chrome / Edge / Arc — folder is remembered between visits</span>`
            : `<span class="badge badge-warn">Firefox / Safari — you'll re-pick the folder each visit (one click)</span>`}
        </div>
      </section>
    `;
    $("#open-folder").addEventListener("click", openPicker);
    const resume = $("#resume-folder");
    if (resume) resume.addEventListener("click", () => resumeStoredHandle(true));
    installDropZone();
  }

  function installDropZone() {
    if (document._dropZoneInstalled) return;
    document._dropZoneInstalled = true;
    const overlay = document.createElement("div");
    overlay.className = "drop-zone-overlay";
    overlay.innerHTML = `<div class="drop-zone-card">Drop your <span class="mono">.claude/projects</span> folder<div class="hint">Release to index</div></div>`;
    document.body.appendChild(overlay);
    let dragCounter = 0;
    window.addEventListener("dragenter", (e) => {
      if (state.manifest) return;
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
      dragCounter++;
      overlay.classList.add("active");
    });
    window.addEventListener("dragover", (e) => {
      if (state.manifest) return;
      e.preventDefault();
    });
    window.addEventListener("dragleave", () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) overlay.classList.remove("active");
    });
    window.addEventListener("drop", async (e) => {
      if (state.manifest) return;
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.remove("active");
      const items = Array.from(e.dataTransfer?.items || []);
      if (!items.length) return;
      try {
        if (typeof items[0].getAsFileSystemHandle === "function") {
          for (const item of items) {
            const handle = await item.getAsFileSystemHandle();
            if (handle && handle.kind === "directory") {
              const entries = await Picker.collectFromHandle(handle);
              await runIndexer(entries, handle);
              return;
            }
          }
        }
        const entries = [];
        const walkers = items.map(it => it.webkitGetAsEntry?.()).filter(Boolean);
        for (const root of walkers) {
          await walkEntry(root, "", entries);
        }
        if (!entries.length) {
          toast("Drop the projects folder containing your session .jsonl files");
          return;
        }
        await runIndexer(entries, null);
      } catch (err) {
        console.error(err);
        toast("Could not read dropped folder");
      }
    });
  }

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        if (entry.name === "history.jsonl") {
          entry.file(f => { out.push({ role: "history", getFile: () => Promise.resolve(f) }); resolve(); }, () => resolve());
          return;
        }
        if (!entry.name.toLowerCase().endsWith(".jsonl")) { resolve(); return; }
        entry.file(f => {
          const parts = (prefix + entry.name).split("/").filter(Boolean);
          if (parts.length < 2) { resolve(); return; }
          const slug = parts[parts.length - 2];
          if (slug === "projects" || slug === ".claude") { resolve(); return; }
          const sessionId = entry.name.slice(0, -".jsonl".length);
          out.push({ slug, sessionId, getFile: () => Promise.resolve(f) });
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const read = () => {
          reader.readEntries(async (es) => {
            if (!es.length) {
              await Promise.all(all.map(e => walkEntry(e, prefix + entry.name + "/", out)));
              resolve();
            } else {
              all.push(...es);
              read();
            }
          }, () => resolve());
        };
        read();
      } else {
        resolve();
      }
    });
  }

  function renderIndexingProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    if (!$("#indexing-view")) {
      app.innerHTML = `
        <section id="indexing-view" class="landing fade-in" style="gap:32px">
          <div class="landing-hero" style="max-width:520px">
            <div class="landing-mark spinning"></div>
            <h1 class="h-mega" style="font-size:36px">Indexing sessions…</h1>
            <p class="sub" id="indexing-status" style="font-size:14px">Reading files</p>
            <div class="progress-bar mt-5"><span id="indexing-bar" style="width:0%"></span></div>
            <p class="text-xs mt-3" style="color:var(--text-mute)">Reading every session fresh from disk · no cache</p>
          </div>
        </section>
      `;
    }
    const bar = $("#indexing-bar");
    const status = $("#indexing-status");
    if (bar) bar.style.width = pct + "%";
    if (status) status.textContent = `Indexed ${done.toLocaleString()} / ${total.toLocaleString()} sessions`;
  }

  function buildPromptHistory(m) {
    const prompts = [];
    let sessionCount = 0;
    if (state.sessionsById) {
      const projBySlug = new Map();
      for (const p of (m.projects || [])) projBySlug.set(p.slug, p);
      for (const session of state.sessionsById.values()) {
        sessionCount++;
        const projObj = projBySlug.get(session.project_slug);
        const projShort = projObj ? projShortName(projObj) : (session.project_path || session.project_slug || "?").split(/[\\/]/).pop();
        const projPath = (projObj && projObj.decoded_path) || session.project_path || session.project_slug || "";
        for (const turn of (session.turns || [])) {
          if (turn.kind !== "prompt" && turn.kind !== "feedback") continue;
          const text = (turn.text || "").trim();
          if (!text) continue;
          prompts.push({
            timestamp: turn.ts ? new Date(turn.ts).getTime() : 0,
            ts: turn.ts || null,
            text,
            sessionId: session.session_id,
            projectSlug: session.project_slug,
            projectShort: projShort,
            projectPath: projPath,
            kind: turn.kind,
            source: "session",
          });
        }
      }
    }
    const knownSessions = state.sessionsById ? new Set(state.sessionsById.keys()) : new Set();
    let orphanCount = 0;
    for (const h of (state.history || [])) {
      if (h.sessionId && knownSessions.has(h.sessionId)) continue;
      const display = (h.display || "").trim();
      if (!display) continue;
      const projShort = h.project ? (h.project.split(/[\\/]/).pop() || h.project) : "—";
      prompts.push({
        timestamp: h.timestamp || 0,
        ts: h.timestamp ? new Date(h.timestamp).toISOString() : null,
        text: display,
        sessionId: h.sessionId || null,
        projectSlug: null,
        projectShort: projShort,
        projectPath: h.project || "",
        kind: "prompt",
        source: "history.jsonl",
        pasted: !!h.pasted,
      });
      orphanCount++;
    }
    return { prompts, sessionCount, orphanCount };
  }

  function renderHistory(m) {
    const { prompts, sessionCount, orphanCount } = buildPromptHistory(m);
    if (!prompts.length) {
      app.innerHTML = `
        <div class="page fade-in">
          <div class="page-head">
            <div>
              <div class="eyebrow">History</div>
              <h1 class="h1">Prompt history</h1>
              <p class="text-sm mt-2" style="color:var(--text-dim)">No prompts found in the loaded sessions.</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const projectsByPath = new Map();
    for (const p of prompts) {
      if (!p.projectPath) continue;
      if (!projectsByPath.has(p.projectPath)) projectsByPath.set(p.projectPath, p.projectShort);
    }
    const projectOptions = [...projectsByPath.entries()].sort((a, b) => a[1].localeCompare(b[1]));

    app.innerHTML = `
      <div class="page fade-in">
        <div class="page-head">
          <div>
            <div class="eyebrow">History</div>
            <h1 class="h1">${prompts.length.toLocaleString()} prompt${prompts.length === 1 ? "" : "s"}</h1>
            <p class="text-sm mt-2" style="color:var(--text-dim)">
              Aggregated from every <span class="mono">prompt</span> + <span class="mono">feedback</span> turn across ${sessionCount.toLocaleString()} loaded session${sessionCount === 1 ? "" : "s"}${orphanCount ? ` &middot; +${orphanCount} from <span class="mono">history.jsonl</span> for sessions not in the loaded folder` : ""}.
            </p>
          </div>
        </div>

        <div class="toolbar mb-4">
          <div class="input-icon" style="flex:1;min-width:240px">
            <span class="icon">⌕</span>
            <input id="hist-q" class="input" placeholder="Filter prompts…" value="${escapeHtml(state.historyView.q)}" />
            <button id="hist-q-clear" class="clear ${state.historyView.q ? "" : "hidden"}" title="Clear">✕</button>
          </div>
          <div class="toolbar-sep"></div>
          <label class="text-xs" style="color:var(--text-mute)">Project</label>
          <select id="hist-proj" class="input" style="width:auto;min-width:200px;max-width:380px">
            <option value="">All projects</option>
            ${projectOptions.map(([path, short]) => `<option value="${escapeHtml(path)}" ${state.historyView.proj === path ? "selected" : ""}>${escapeHtml(short)}</option>`).join("")}
          </select>
          <label class="chk" style="margin-left:6px"><input type="checkbox" id="hist-feedback" ${state.historyView.hideFeedback ? "checked" : ""}/> hide feedback</label>
          <span id="hist-count" class="badge ml-auto"></span>
        </div>

        <div class="surface" style="overflow:hidden">
          <ul id="hist-list" class="history-list"></ul>
        </div>
      </div>
    `;

    const render = () => {
      const q = state.historyView.q.toLowerCase().trim();
      const proj = state.historyView.proj;
      const hideFb = !!state.historyView.hideFeedback;
      let rows = prompts.slice();
      if (proj) rows = rows.filter(e => e.projectPath === proj);
      if (hideFb) rows = rows.filter(e => e.kind !== "feedback");
      if (q) rows = rows.filter(e => e.text.toLowerCase().includes(q));
      rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const cap = 800;
      const capped = rows.slice(0, cap);
      $("#hist-count").textContent = `${rows.length} of ${prompts.length}${rows.length > capped.length ? ` · showing ${cap}` : ""}`;
      $("#hist-list").innerHTML = capped.length ? capped.map(e => {
        const linked = e.sessionId;
        const tsLabel = fmtHistoryTime(e.timestamp);
        const display = e.text.replace(/\s+/g, " ").trim();
        const badge = e.kind === "feedback" ? `<span class="badge badge-warn" style="margin-right:6px;padding:1px 7px;font-size:10px">feedback</span>` : (e.pasted ? `<span class="badge" style="margin-right:6px;padding:1px 7px;font-size:10px">pasted</span>` : (e.source === "history.jsonl" ? `<span class="badge" style="margin-right:6px;padding:1px 7px;font-size:10px">orphan</span>` : ""));
        return `
          <li class="history-row${linked ? " is-linked" : ""}" ${linked ? `data-session="${escapeHtml(e.sessionId)}"` : ""}>
            <span class="ts mono">${escapeHtml(tsLabel)}</span>
            <span class="proj" title="${escapeHtml(e.projectPath || "")}">${escapeHtml(e.projectShort || "—")}</span>
            <span class="prompt">${badge}${escapeHtml(truncate(display, 280))}</span>
          </li>`;
      }).join("") : `<li class="history-empty"><div class="empty"><div class="empty-icon">⌕</div><div class="empty-title">No matches</div></div></li>`;
    };

    const qInput = $("#hist-q");
    const clearBtn = $("#hist-q-clear");
    qInput.addEventListener("input", debounce(() => {
      state.historyView.q = qInput.value;
      clearBtn.classList.toggle("hidden", !qInput.value);
      render();
    }, 120));
    clearBtn.addEventListener("click", () => { qInput.value = ""; state.historyView.q = ""; clearBtn.classList.add("hidden"); render(); qInput.focus(); });
    $("#hist-proj").addEventListener("change", e => { state.historyView.proj = e.target.value; render(); });
    $("#hist-feedback").addEventListener("change", e => { state.historyView.hideFeedback = e.target.checked; render(); });
    $("#hist-list").addEventListener("click", e => {
      const row = e.target.closest(".history-row.is-linked");
      if (row && row.dataset.session) location.hash = `#/session/${encodeURIComponent(row.dataset.session)}`;
    });
    render();
  }

  async function route() {
    const raw = location.hash.replace(/^#\/?/, "");
    const h = raw.split("?")[0];
    if (!state.manifest) {
      state.pendingHash = location.hash;
      const canResume = Picker.HAS_FS_ACCESS && Boolean(await Picker.loadHandle().catch(() => null));
      renderLanding({ canResume });
      return;
    }
    const m = state.manifest;
    setActiveNav(h);
    window.scrollTo({ top: 0, behavior: "instant" });
    if (!h) return renderStats(m);
    if (h === "projects") return renderProjects(m);
    if (h.startsWith("project/")) return renderProject(m, decodeURIComponent(h.slice("project/".length)));
    if (h.startsWith("session/")) return renderSession(decodeURIComponent(h.slice("session/".length)));
    if (h === "search") return renderSearch(m);
    if (h === "history") return renderHistory(m);
    if (h === "stats") return renderStats(m);
    renderStats(m);
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const inField = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") {
        if ($("#modal-root").querySelector(".modal-backdrop")) { closeShortcutsModal(); e.preventDefault(); return; }
        if (inField) { e.target.blur(); return; }
      }
      if (e.key === "?" && !inField) {
        e.preventDefault();
        openShortcutsModal();
        return;
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        if (location.hash !== "#/search") location.hash = "#/search";
        setTimeout(() => $("#q")?.focus(), 60);
      } else if (e.key === "g" && !inField && !e.metaKey && !e.ctrlKey) {
        document._lastG = Date.now();
      } else if (!inField && document._lastG && Date.now() - document._lastG < 500) {
        document._lastG = 0;
        if (e.key === "p") location.hash = "#/projects";
        else if (e.key === "s") location.hash = "#/";
        else if (e.key === "/") location.hash = "#/search";
      }
    });
  }

  async function bootstrap() {
    updateHeaderControls(false);
    state.pendingHash = location.hash;
    try { indexedDB.deleteDatabase("claude-sessions-cache"); } catch {}
    if (Picker.HAS_FS_ACCESS) {
      const stored = await Picker.loadHandle().catch(() => null);
      if (stored) {
        state.pickerHandle = stored;
        const granted = await Picker.ensurePermission(stored, false);
        if (granted) {
          try {
            const entries = await Picker.collectFromHandle(stored);
            if (entries.length) {
              await runIndexer(entries, stored);
              return;
            }
          } catch (e) { console.warn("resume failed", e); }
        }
        renderLanding({ canResume: true });
        return;
      }
    }
    renderLanding({ canResume: false });
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("DOMContentLoaded", () => {
    $("#refresh-btn").addEventListener("click", () => {
      if (state.manifest) switchFolder();
      else openPicker();
    });
    $("#refresh-data-btn")?.addEventListener("click", () => refreshIndex({ silent: false }));
    $("#search-shortcut")?.addEventListener("click", () => { location.hash = "#/search"; });
    $("#shortcuts-btn")?.addEventListener("click", openShortcutsModal);
    bindKeyboard();
    bootstrap();

    let lastVisibleAt = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const away = Date.now() - lastVisibleAt;
        if (state.manifest && state.pickerHandle && away > 15_000) {
          refreshIndex({ silent: true });
        }
      } else {
        lastVisibleAt = Date.now();
      }
    });

    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!state.manifest || !state.pickerHandle) return;
      refreshIndex({ silent: true });
    }, 60_000);

    setInterval(updateManifestMeta, 10_000);
  });

  window._diag = {
    state,
    refreshIndex,
    picker: () => Picker,
    indexer: () => IndexerClient,
    handle: () => state.pickerHandle,
    clearHandle: async () => { await Picker.clearStoredHandle(); console.log("handle cleared — switch folder to repick"); },
    listEntries: async () => {
      if (!state.pickerHandle) { console.warn("no handle"); return []; }
      const entries = await Picker.collectFromHandle(state.pickerHandle);
      console.table(entries.map(e => ({ slug: e.slug, sessionId: e.sessionId, role: e.role || "" })));
      return entries;
    },
  };
})();
