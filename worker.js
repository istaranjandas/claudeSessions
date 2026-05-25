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

function buildManifest(results) {
  const byProject = new Map();
  for (const r of results) {
    if (!r) continue;
    const slug = r.meta.project_slug;
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug).push(r);
  }

  const projects = [];
  const toolFreq = {};
  const dailyPrompts = {};
  const durationBuckets = {};
  const globalFiles = {};
  const dailyTokens = {};
  const dailyModelTokens = {};
  const grandTokens = { input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0 };
  const sessionsById = new Map();

  for (const [slug, rs] of byProject) {
    const sessionsMeta = [];
    for (const { full, meta } of rs) {
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
      const sessModel = meta.model || "unknown";
      for (const [day, parts] of Object.entries(full.usage_by_day || {})) {
        if (!dailyTokens[day]) dailyTokens[day] = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
        for (const k of Object.keys(dailyTokens[day])) dailyTokens[day][k] += Number(parts[k]) || 0;
        const dayTotal = (Number(parts.input) || 0) + (Number(parts.output) || 0) + (Number(parts.cache_create) || 0) + (Number(parts.cache_read) || 0);
        if (dayTotal) {
          if (!dailyModelTokens[day]) dailyModelTokens[day] = {};
          dailyModelTokens[day][sessModel] = (dailyModelTokens[day][sessModel] || 0) + dayTotal;
        }
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
      dailyModelTokens: Object.entries(dailyModelTokens)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, tokensByModel]) => ({ date, tokensByModel })),
    },
  };
  return { manifest, sessionsById };
}

async function indexAll(entries, getFile) {
  const total = entries.length;
  const parsed = [];
  let processed = 0;

  for (const entry of entries) {
    let file;
    try { file = await getFile(entry); } catch { processed++; continue; }
    let text;
    try { text = await file.text(); } catch { processed++; continue; }
    const result = indexSession(text, entry.sessionId, entry.slug);
    if (result) parsed.push(result);
    processed++;
    if (processed % 3 === 0 || processed === total) {
      self.postMessage({ type: "progress", processed, total });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return { parsed };
}

function parseHistory(historyText) {
  if (!historyText) return [];
  const entries = [];
  for (const line of historyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      entries.push({
        display: e.display || "",
        timestamp: Number(e.timestamp) || 0,
        project: e.project || "",
        sessionId: e.sessionId || "",
        pasted: e.pastedContents && Object.keys(e.pastedContents).length > 0,
      });
    } catch {}
  }
  return entries;
}

async function tryReadFileText(rootHandle, name) {
  try {
    const fh = await rootHandle.getFileHandle(name);
    const f = await fh.getFile();
    return await f.text();
  } catch { return null; }
}

self.onmessage = async (e) => {
  try {
    const { type, payload } = e.data || {};

    let entries = [];
    let getFile;
    let historyText = null;

    if (type === "index-handle") {
      const rootHandle = payload.handle;
      let projHandle = rootHandle;
      try {
        projHandle = await rootHandle.getDirectoryHandle("projects");
        historyText = await tryReadFileText(rootHandle, "history.jsonl");
      } catch {}
      for await (const [name, child] of projHandle.entries()) {
        if (child.kind !== "directory") continue;
        for await (const [fname, fh] of child.entries()) {
          if (fh.kind !== "file" || !fname.toLowerCase().endsWith(".jsonl")) continue;
          entries.push({ slug: name, sessionId: fname.slice(0, -".jsonl".length), fileHandle: fh });
        }
      }
      getFile = (en) => en.fileHandle.getFile();
    } else if (type === "index-files") {
      entries = payload.sessions || [];
      if (payload.history) { try { historyText = await payload.history.text(); } catch {} }
      getFile = (en) => Promise.resolve(en.file);
    } else {
      throw new Error("Unknown message type: " + type);
    }

    const history = parseHistory(historyText);

    if (!entries.length) {
      const { manifest } = buildManifest([]);
      self.postMessage({ type: "done", manifest, sessionsById: {}, history });
      return;
    }

    const { parsed } = await indexAll(entries, getFile);
    const { manifest, sessionsById } = buildManifest(parsed);
    const sessionsObj = {};
    for (const [k, v] of sessionsById) sessionsObj[k] = v;
    self.postMessage({
      type: "done",
      manifest,
      sessionsById: sessionsObj,
      history,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
