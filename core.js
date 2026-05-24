const Indexer = (() => {
  const SCHEMA_TYPES = new Set(["user", "assistant", "attachment", "queue-operation", "summary"]);
  const SYSTEM_REMINDER_RE = /<(system-reminder|command-message|command-name|local-command-stdout|user-prompt-submit-hook)\b/i;
  const FEEDBACK_PREFIXES = ["no", "stop", "don", "instead", "wait", "actually", "wrong", "undo", "revert", "fix", "why", "that", "not"];

  function decodeSlug(slug) {
    if (!slug) return slug;
    let s = slug;
    if (s.length >= 2 && s[1] === "-" && /[a-zA-Z]/.test(s[0])) {
      s = s[0] + ":" + s.slice(2);
    }
    return s.replace(/-/g, "\\").replace(/\\\\/g, "\\.");
  }

  function classifyUserContent(content) {
    if (typeof content === "string") {
      if (SYSTEM_REMINDER_RE.test(content)) return ["system_injected", content];
      return ["prompt", content];
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_result") return ["tool_result", content];
      }
      const texts = [];
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "text") texts.push(b.text || "");
      }
      if (texts.length) {
        const joined = texts.join("\n");
        if (SYSTEM_REMINDER_RE.test(joined)) return ["system_injected", joined];
        return ["prompt", joined];
      }
    }
    return ["unknown", content];
  }

  function extractAssistantBlocks(content) {
    const out = [];
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const t = block.type;
      if (t === "text") out.push({ kind: "text", text: block.text || "" });
      else if (t === "tool_use") out.push({ kind: "tool_use", id: block.id, name: block.name, input: block.input || {} });
      else if (t === "thinking") out.push({ kind: "thinking", text: block.thinking || "" });
    }
    return out;
  }

  function attachmentSummary(att) {
    const t = att.type || "";
    if (t === "ultrathink_effort") return `ultrathink: ${att.effort}`;
    if (t === "deferred_tools_delta") return `deferred tools: +${(att.added || []).length} / -${(att.removed || []).length}`;
    if (t === "image") return "image";
    return t || "attachment";
  }

  function detectFeedback(assistantCount, text) {
    if (!assistantCount || !text) return false;
    const stripped = text.trim().toLowerCase();
    if (stripped.length >= 200) return false;
    return FEEDBACK_PREFIXES.some(p => stripped.startsWith(p));
  }

  function indexSession(text, sessionId, projectSlug) {
    const turns = [];
    const toolUseById = {};
    let startedAt = null, endedAt = null;
    let cwd = null, gitBranch = null, version = null, model = null, permMode = null;
    let toolCalls = 0, promptCount = 0, feedbackCount = 0, assistantCount = 0, errorCount = 0;
    const fileTouch = {};
    let firstPrompt = null;
    const summaries = [];
    let tokIn = 0, tokOut = 0, tokCC = 0, tokCR = 0;
    const tokByDay = {};

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const t = obj.type;
      if (!SCHEMA_TYPES.has(t)) continue;
      const ts = obj.timestamp;
      if (ts) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }
      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
      if (obj.version && !version) version = obj.version;
      if (obj.permissionMode && !permMode) permMode = obj.permissionMode;

      if (t === "summary") {
        summaries.push({ summary: obj.summary, leafUuid: obj.leafUuid });
        continue;
      }

      if (t === "user") {
        const msg = obj.message || {};
        const content = msg.content;
        const [kind, payload] = classifyUserContent(content);
        if (kind === "prompt") {
          promptCount++;
          const promptText = typeof payload === "string" ? payload : "";
          if (firstPrompt === null && promptText && !SYSTEM_REMINDER_RE.test(promptText)) {
            firstPrompt = promptText.slice(0, 240);
          }
          const fb = detectFeedback(assistantCount, promptText);
          if (fb) feedbackCount++;
          turns.push({ kind: fb ? "feedback" : "prompt", uuid: obj.uuid, ts, text: promptText });
        } else if (kind === "tool_result") {
          for (const block of content) {
            if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
            const isErr = Boolean(block.is_error);
            if (isErr) errorCount++;
            const body = block.content;
            let bodyText = "";
            if (Array.isArray(body)) {
              const parts = [];
              for (const b of body) {
                if (b && typeof b === "object" && b.type === "text") parts.push(b.text || "");
              }
              bodyText = parts.join("\n");
            } else if (typeof body === "string") {
              bodyText = body;
            } else if (body != null) {
              try { bodyText = JSON.stringify(body).slice(0, 8000); } catch { bodyText = ""; }
            }
            turns.push({
              kind: "tool_result", uuid: obj.uuid, ts,
              tool_use_id: block.tool_use_id, is_error: isErr,
              text: bodyText || "",
            });
          }
        } else if (kind === "system_injected") {
          turns.push({
            kind: "system", uuid: obj.uuid, ts,
            text: typeof payload === "string" ? payload : "",
          });
        }
      } else if (t === "assistant") {
        assistantCount++;
        const msg = obj.message || {};
        if (msg.model && !model) model = msg.model;
        const usage = msg.usage || {};
        if (usage && typeof usage === "object") {
          const ti = Number(usage.input_tokens) || 0;
          const to = Number(usage.output_tokens) || 0;
          const tcc = Number(usage.cache_creation_input_tokens) || 0;
          const tcr = Number(usage.cache_read_input_tokens) || 0;
          tokIn += ti; tokOut += to; tokCC += tcc; tokCR += tcr;
          const day = (ts || "").slice(0, 10);
          if (day) {
            if (!tokByDay[day]) tokByDay[day] = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
            tokByDay[day].input += ti;
            tokByDay[day].output += to;
            tokByDay[day].cache_create += tcc;
            tokByDay[day].cache_read += tcr;
          }
        }
        const blocks = extractAssistantBlocks(msg.content);
        for (const b of blocks) {
          if (b.kind === "tool_use") {
            toolCalls++;
            toolUseById[b.id] = b.name;
            const inp = b.input || {};
            for (const key of ["file_path", "path", "notebook_path"]) {
              const v = inp[key];
              if (typeof v === "string" && v) fileTouch[v] = (fileTouch[v] || 0) + 1;
            }
          }
        }
        turns.push({ kind: "assistant", uuid: obj.uuid, ts, blocks });
      } else if (t === "attachment") {
        const att = obj.attachment || {};
        turns.push({
          kind: "attachment", uuid: obj.uuid, ts,
          attachment_type: att.type, summary: attachmentSummary(att),
        });
      } else if (t === "queue-operation") {
        turns.push({
          kind: "queue", ts,
          operation: obj.operation, text: obj.content || "",
        });
      }
    }

    if (!startedAt) return null;

    const durationMs = (startedAt && endedAt)
      ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : 0;
    const topFiles = Object.entries(fileTouch).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, c]) => ({ path: p, count: c }));
    const tokTotal = tokIn + tokOut + tokCC + tokCR;
    const usage = { input: tokIn, output: tokOut, cache_create: tokCC, cache_read: tokCR, total: tokTotal };

    const full = {
      session_id: sessionId, project_slug: projectSlug,
      project_path: decodeSlug(projectSlug),
      started_at: startedAt, ended_at: endedAt, duration_ms: durationMs,
      cwd, git_branch: gitBranch, version, model, permission_mode: permMode,
      counts: {
        prompts: promptCount, feedback: feedbackCount, assistant: assistantCount,
        tool_calls: toolCalls, errors: errorCount, turns: turns.length,
      },
      first_prompt: firstPrompt || "",
      summaries, top_files: topFiles,
      usage, usage_by_day: tokByDay,
      turns, tool_use_index: toolUseById,
    };

    const meta = {
      session_id: sessionId, project_slug: projectSlug,
      started_at: startedAt, ended_at: endedAt, duration_ms: durationMs,
      git_branch: gitBranch, version, model, permission_mode: permMode,
      counts: full.counts, usage,
      first_prompt: firstPrompt || "",
      has_error: errorCount > 0, cwd,
    };
    return { full, meta };
  }

  async function build(entries, onProgress) {
    const byProject = new Map();
    for (const e of entries) {
      if (!byProject.has(e.slug)) byProject.set(e.slug, []);
      byProject.get(e.slug).push(e);
    }

    const projects = [];
    const toolFreq = {};
    const dailyPrompts = {};
    const durationBuckets = {};
    const globalFiles = {};
    const dailyTokens = {};
    const grandTokens = { input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0 };
    const sessionsById = new Map();
    const total = entries.length;
    let processed = 0;

    for (const [slug, slugEntries] of byProject) {
      const sessionsMeta = [];
      for (const entry of slugEntries) {
        let text;
        try {
          const file = await entry.getFile();
          text = await file.text();
        } catch {
          processed++;
          continue;
        }
        const result = indexSession(text, entry.sessionId, slug);
        processed++;
        if (onProgress && (processed % 3 === 0 || processed === total)) {
          onProgress({ processed, total, slug });
          await new Promise(r => setTimeout(r, 0));
        }
        if (!result) continue;
        const { full, meta } = result;
        sessionsById.set(full.session_id, full);
        sessionsMeta.push(meta);

        for (const turn of full.turns) {
          if (turn.kind === "assistant") {
            for (const b of (turn.blocks || [])) {
              if (b.kind === "tool_use") toolFreq[b.name] = (toolFreq[b.name] || 0) + 1;
            }
          }
        }
        if (meta.started_at) {
          const day = meta.started_at.slice(0, 10);
          dailyPrompts[day] = (dailyPrompts[day] || 0) + (meta.counts.prompts || 0);
        }
        const dm = meta.duration_ms || 0;
        const bucket = dm < 60_000 ? "<1m" : dm < 5*60_000 ? "1-5m" : dm < 30*60_000 ? "5-30m" : dm < 2*3600_000 ? "30m-2h" : dm < 8*3600_000 ? "2-8h" : ">8h";
        durationBuckets[bucket] = (durationBuckets[bucket] || 0) + 1;
        for (const f of full.top_files || []) {
          globalFiles[f.path] = (globalFiles[f.path] || 0) + f.count;
        }
        const u = full.usage || {};
        for (const k of Object.keys(grandTokens)) grandTokens[k] += Number(u[k]) || 0;
        for (const [day, parts] of Object.entries(full.usage_by_day || {})) {
          if (!dailyTokens[day]) dailyTokens[day] = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
          for (const k of Object.keys(dailyTokens[day])) dailyTokens[day][k] += Number(parts[k]) || 0;
        }
      }
      if (!sessionsMeta.length) continue;
      sessionsMeta.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
      const lastActive = sessionsMeta[0].ended_at || sessionsMeta[0].started_at;
      const totalMessages = sessionsMeta.reduce((a, s) => a + s.counts.turns, 0);
      const totalToolCalls = sessionsMeta.reduce((a, s) => a + s.counts.tool_calls, 0);
      const projUsage = { input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0 };
      for (const s of sessionsMeta) {
        for (const k of Object.keys(projUsage)) projUsage[k] += Number((s.usage || {})[k]) || 0;
      }
      const cwds = sessionsMeta.map(s => s.cwd).filter(Boolean);
      projects.push({
        slug,
        decoded_path: cwds[0] || decodeSlug(slug),
        session_count: sessionsMeta.length,
        last_active: lastActive,
        total_messages: totalMessages,
        total_tool_calls: totalToolCalls,
        usage: projUsage,
        sessions: sessionsMeta,
      });
    }

    projects.sort((a, b) => (b.last_active || "").localeCompare(a.last_active || ""));

    const manifest = {
      generated_at: new Date().toISOString(),
      root: "(local folder)",
      project_count: projects.length,
      session_count: projects.reduce((a, p) => a + p.session_count, 0),
      projects,
      stats: {
        tool_frequency: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]),
        daily_prompts: Object.entries(dailyPrompts).sort(),
        duration_buckets: Object.entries(durationBuckets),
        top_files: Object.entries(globalFiles).sort((a, b) => b[1] - a[1]).slice(0, 25),
        tokens_total: grandTokens,
        daily_tokens: Object.entries(dailyTokens).sort(),
      },
    };

    if (onProgress) onProgress({ processed: total, total, done: true });
    return { manifest, sessionsById };
  }

  return { build, indexSession, decodeSlug };
})();

const Picker = (() => {
  const HAS_FS_ACCESS = typeof window.showDirectoryPicker === "function";
  const DB_NAME = "claude-sessions-fs";
  const STORE = "handles";

  async function collectFromHandle(rootHandle) {
    const entries = [];
    let projHandle = rootHandle;
    let isClaudeRoot = false;
    try {
      projHandle = await rootHandle.getDirectoryHandle("projects");
      isClaudeRoot = true;
    } catch {}
    if (isClaudeRoot) {
      try {
        const fh = await rootHandle.getFileHandle("stats-cache.json");
        entries.push({ role: "stats-cache", getFile: () => fh.getFile() });
      } catch {}
      try {
        const fh = await rootHandle.getFileHandle("history.jsonl");
        entries.push({ role: "history", getFile: () => fh.getFile() });
      } catch {}
    }
    for await (const [name, child] of projHandle.entries()) {
      if (child.kind !== "directory") continue;
      const slug = name;
      for await (const [fname, fileHandle] of child.entries()) {
        if (fileHandle.kind !== "file" || !fname.toLowerCase().endsWith(".jsonl")) continue;
        const sessionId = fname.slice(0, -".jsonl".length);
        entries.push({
          slug, sessionId,
          getFile: () => fileHandle.getFile(),
        });
      }
    }
    return entries;
  }

  async function pickViaFSAccess() {
    const handle = await window.showDirectoryPicker({ id: "claude-projects", mode: "read" });
    const entries = await collectFromHandle(handle);
    return { handle, entries };
  }

  function pickViaInput() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.webkitdirectory = true;
      input.multiple = true;
      input.style.display = "none";
      let settled = false;
      input.addEventListener("change", () => {
        settled = true;
        const files = Array.from(input.files || []);
        const entries = [];
        for (const f of files) {
          if (f.name === "stats-cache.json") {
            entries.push({ role: "stats-cache", getFile: () => Promise.resolve(f) });
            continue;
          }
          if (f.name === "history.jsonl") {
            entries.push({ role: "history", getFile: () => Promise.resolve(f) });
            continue;
          }
          if (!f.name.toLowerCase().endsWith(".jsonl")) continue;
          const parts = (f.webkitRelativePath || "").split("/");
          if (parts.length < 2) continue;
          const slug = parts[parts.length - 2];
          if (slug === "projects" || slug === ".claude") continue;
          const sessionId = f.name.slice(0, -".jsonl".length);
          entries.push({ slug, sessionId, getFile: () => Promise.resolve(f) });
        }
        if (input.parentNode) document.body.removeChild(input);
        resolve({ handle: null, entries });
      });
      input.addEventListener("cancel", () => {
        settled = true;
        if (input.parentNode) document.body.removeChild(input);
        reject(new Error("cancelled"));
      });
      window.addEventListener("focus", () => {
        setTimeout(() => {
          if (!settled && input.parentNode) {
            document.body.removeChild(input);
            reject(new Error("cancelled"));
          }
        }, 500);
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  async function pick() {
    if (HAS_FS_ACCESS) return pickViaFSAccess();
    return pickViaInput();
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    if (!handle || !HAS_FS_ACCESS) return;
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(handle, "root");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function loadHandle() {
    if (!HAS_FS_ACCESS) return null;
    try {
      const db = await openDB();
      const handle = await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get("root");
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
      db.close();
      return handle;
    } catch { return null; }
  }

  async function clearStoredHandle() {
    if (!HAS_FS_ACCESS) return;
    try {
      const db = await openDB();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete("root");
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      db.close();
    } catch {}
  }

  async function ensurePermission(handle, doPrompt) {
    if (!handle || !handle.queryPermission) return true;
    try {
      const opts = { mode: "read" };
      const cur = await handle.queryPermission(opts);
      if (cur === "granted") return true;
      if (!doPrompt) return false;
      return (await handle.requestPermission(opts)) === "granted";
    } catch { return false; }
  }

  return { HAS_FS_ACCESS, pick, collectFromHandle, saveHandle, loadHandle, clearStoredHandle, ensurePermission };
})();

const IndexerClient = (() => {
  let worker = null;
  let workerSupported = typeof Worker !== "undefined";

  function getWorker() {
    if (!workerSupported) return null;
    if (worker) return worker;
    try {
      worker = new Worker("worker.js");
      worker.addEventListener("error", (e) => {
        console.warn("worker error", e.message || e);
        try { worker?.terminate(); } catch {}
        worker = null;
      });
      return worker;
    } catch (e) {
      console.warn("Worker creation failed:", e);
      workerSupported = false;
      return null;
    }
  }

  function buildViaWorker(input, onProgress) {
    const w = getWorker();
    if (!w) return Promise.reject(new Error("worker unavailable"));
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        const { type } = e.data;
        if (type === "progress") {
          if (onProgress) onProgress(e.data);
        } else if (type === "done") {
          w.removeEventListener("message", handler);
          const sessionsById = new Map();
          for (const [k, v] of Object.entries(e.data.sessionsById || {})) sessionsById.set(k, v);
          resolve({
            manifest: e.data.manifest,
            sessionsById,
            history: e.data.history || [],
            cacheHits: e.data.cacheHits || 0,
          });
        } else if (type === "error") {
          w.removeEventListener("message", handler);
          reject(new Error(e.data.message));
        }
      };
      w.addEventListener("message", handler);
      const send = async () => {
        try {
          if (input.handle) {
            w.postMessage({ type: "index-handle", payload: { handle: input.handle } });
          } else if (input.entries && input.entries.length) {
            const sessions = [];
            let statsCache = null;
            let history = null;
            for (const en of input.entries) {
              const f = await en.getFile();
              if (en.role === "stats-cache" || f.name === "stats-cache.json") { statsCache = f; continue; }
              if (en.role === "history" || f.name === "history.jsonl") { history = f; continue; }
              if (!en.slug || !en.sessionId) continue;
              sessions.push({ slug: en.slug, sessionId: en.sessionId, file: f });
            }
            w.postMessage({ type: "index-files", payload: { sessions, statsCache, history } });
          } else {
            throw new Error("nothing to index");
          }
        } catch (err) {
          w.removeEventListener("message", handler);
          reject(err);
        }
      };
      send();
    });
  }

  async function buildOnMain(input, onProgress) {
    let entries = input.handle ? await Picker.collectFromHandle(input.handle) : input.entries;
    entries = (entries || []).filter(e => e.slug && e.sessionId);
    const result = await Indexer.build(entries, p => onProgress && onProgress({ ...p, cacheHits: 0 }));
    return { ...result, history: [], cacheHits: 0 };
  }

  async function build(input, onProgress) {
    if (workerSupported) {
      try { return await buildViaWorker(input, onProgress); }
      catch (e) {
        console.warn("worker indexing failed, falling back to main thread:", e?.message || e);
        workerSupported = false;
      }
    }
    return buildOnMain(input, onProgress);
  }

  async function clearCache() {
    const w = getWorker();
    if (!w) {
      try {
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase("claude-sessions-cache");
          req.onsuccess = req.onerror = req.onblocked = resolve;
        });
      } catch {}
      return;
    }
    return new Promise((resolve) => {
      const handler = (e) => {
        if (e.data.type === "cache-cleared") {
          w.removeEventListener("message", handler);
          resolve();
        }
      };
      w.addEventListener("message", handler);
      w.postMessage({ type: "clear-cache" });
    });
  }

  return { build, clearCache };
})();
