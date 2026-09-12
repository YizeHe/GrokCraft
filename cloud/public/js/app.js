import { api, qs } from "./api.js";
import { renderMarkdown, truncate } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  machineId: qs("machineId") || "",
  machines: [],
  online: false,
  hostname: "",
  cwd: "",
  model: null,
  sessionId: null,
  turnRunning: false,
  sessions: [],
  blocks: new Map(),
  blockOrder: [],
  subagents: new Map(),
  tasks: new Map(),
  permission: null,
  viewChildId: null,
  stickBottom: true,
  ws: null,
  pingTimer: null,
};

function currentSessionId() {
  return state.viewChildId || state.sessionId;
}

function sessionTitle() {
  const id = currentSessionId();
  const s = state.sessions.find((x) => x.id === id);
  if (s?.title) return s.title;
  if (state.viewChildId) {
    const sub = state.subagents.get(state.viewChildId);
    if (sub?.description) return sub.description;
    return "子代理";
  }
  return "当前会话";
}

function setOnline(on) {
  state.online = on;
  $("status-dot").className = "dot " + (on ? "live" : "off");
  $("status-text").textContent = on ? "在线" : "离线";
  $("send").disabled = !on;
  $("prompt").disabled = !on;
}

function sendJson(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(msg));
}

function nextDisplayMode(block) {
  if (block.kind === "thinking") {
    if (block.displayMode === "truncated") return "expanded";
    if (block.displayMode === "expanded") return "collapsed";
    return "truncated";
  }
  return block.displayMode === "expanded" ? "collapsed" : "expanded";
}

function kindLabel(block) {
  if (block.kind === "thinking") return "思考";
  if (block.kind === "subagent") return block.title || "子代理";
  if (block.kind === "tool") return block.toolName || "工具";
  if (block.kind === "bg_task") return "后台";
  if (block.kind === "workflow") return "流程";
  if (block.kind === "permission") return "许可";
  return block.title || block.kind;
}

function renderBlock(block) {
  const el = document.createElement("article");
  el.className = `block ${block.kind}`;
  el.dataset.id = block.id;
  el.id = `block-${block.id}`;
  if (block.status === "error") el.classList.add("error");
  if (block.isRunning || block.status === "running") el.classList.add("running");
  const openChild = block.openChildSession || block.kind === "subagent";
  if (block.foldable && !openChild) el.classList.add("foldable");

  const body = document.createElement("div");
  body.className = "block-body";

  const isUser = block.kind === "user";
  const isAssistant = block.kind === "assistant" || block.kind === "system" || block.kind === "session_event";
  const collapsed = block.displayMode === "collapsed";
  const truncated = block.displayMode === "truncated";
  const expanded = block.displayMode === "expanded" || (!block.foldable && !openChild);

  const showChrome = block.foldable || openChild || block.kind === "thinking" || block.kind === "tool" || block.kind === "bg_task";

  if (showChrome) {
    const line = document.createElement("div");
    line.className = "block-line";
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = openChild ? "›" : collapsed ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = kindLabel(block);
    const title = document.createElement("span");
    title.className = "block-title";
    title.textContent = block.title && block.title !== kindLabel(block) ? block.title : block.activityLabel || "";
    const meta = document.createElement("span");
    meta.className = "block-meta";
    meta.textContent = block.status === "running" ? block.activityLabel || "进行中" : block.status === "error" ? "错误" : "";
    line.append(chev, name, title, meta);
    body.append(line);

    line.addEventListener("click", () => {
      if (openChild && block.childSessionId) {
        openChildSession(block.childSessionId);
        return;
      }
      if (!block.foldable) return;
      const next = nextDisplayMode(block);
      block.displayMode = next;
      sendJson({
        type: "set_fold",
        sessionId: block.sessionId,
        blockId: block.id,
        displayMode: next,
      });
      if (next === "expanded" && !block.detail && (block.content || "").length < 8) {
        sendJson({ type: "request_block", sessionId: block.sessionId, blockId: block.id });
      }
      upsertBlock(block, true);
    });
  }

  if (openChild && collapsed) {
    /* one-line only */
  } else if (collapsed && block.foldable) {
    /* folded */
  } else if (truncated) {
    const prev = document.createElement("div");
    prev.className = "preview";
    prev.textContent = truncate(block.content || block.activityLabel || "", 220);
    body.append(prev);
  } else if (expanded || isUser || isAssistant || !block.foldable) {
    if (isUser) {
      const t = document.createElement("div");
      t.className = "user-text";
      t.textContent = block.content || block.title || "";
      body.append(t);
    } else {
      const html = renderMarkdown(block.detail || block.content || "");
      const wrap = document.createElement("div");
      wrap.innerHTML = html || "";
      if (wrap.childNodes.length) body.append(wrap);
    }
  }

  const accent = document.createElement("div");
  accent.className = "accent";
  el.append(accent, body);
  return el;
}

function visibleBlocks() {
  const sid = currentSessionId();
  const out = [];
  for (const id of state.blockOrder) {
    const b = state.blocks.get(id);
    if (!b) continue;
    if (sid && b.sessionId && b.sessionId !== sid) continue;
    out.push(b);
  }
  return out;
}

function maybeScroll() {
  const root = $("transcript");
  if (state.stickBottom) root.scrollTop = root.scrollHeight;
}

function renderTranscript() {
  const root = $("transcript");
  const blocks = visibleBlocks();
  root.innerHTML = "";
  if (!blocks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = state.online
      ? "<strong>这台电脑已连接</strong><br />输入消息发给 Grok Build。"
      : "<strong>电脑未在线</strong><br />请保持本机 Grok TUI 运行。";
    root.append(empty);
    return;
  }
  for (const b of blocks) root.append(renderBlock(b));
  maybeScroll();
}

function upsertBlock(block, inPlace = false) {
  const existed = state.blocks.has(block.id);
  state.blocks.set(block.id, block);
  if (!existed) state.blockOrder.push(block.id);
  if (!inPlace) {
    renderTranscript();
    return;
  }
  const sid = currentSessionId();
  if (sid && block.sessionId && block.sessionId !== sid) return;
  const node = document.getElementById(`block-${block.id}`);
  const next = renderBlock(block);
  if (node) node.replaceWith(next);
  else {
    const empty = $("transcript").querySelector(".empty");
    if (empty) empty.remove();
    $("transcript").append(next);
  }
  maybeScroll();
}

function renderSubagents() {
  const root = $("subagent-list");
  root.innerHTML = "";
  const list = [...state.subagents.values()];
  if (!list.length) {
    root.innerHTML = `<div class="side-item"><div class="t"><div class="m">暂无</div></div></div>`;
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "side-item";
    const pill = document.createElement("span");
    pill.className =
      "pill " + (s.status === "running" ? "run" : s.status === "completed" ? "ok" : s.status === "failed" ? "err" : "");
    pill.textContent = s.status === "running" ? "运行中" : s.status === "completed" ? "完成" : s.status === "failed" ? "失败" : s.status || "";
    const t = document.createElement("div");
    t.className = "t";
    t.innerHTML = `<div class="d"></div><div class="m"></div>`;
    t.querySelector(".d").textContent = s.description || s.subagentType || s.childSessionId;
    t.querySelector(".m").textContent = [s.subagentType, s.model, s.activityLabel].filter(Boolean).join(" · ");
    row.append(t, pill);
    row.addEventListener("click", () => openChildSession(s.childSessionId));
    root.append(row);
  }
}

function renderTasks() {
  const root = $("task-list");
  root.innerHTML = "";
  const list = [...state.tasks.values()];
  if (!list.length) {
    root.innerHTML = `<div class="side-item"><div class="t"><div class="m">暂无</div></div></div>`;
    return;
  }
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "side-item";
    const title = t.title || t.label || t.description || t.id;
    row.innerHTML = `<div class="t"><div class="d"></div><div class="m"></div></div>`;
    row.querySelector(".d").textContent = title;
    row.querySelector(".m").textContent = t.status || t.activityLabel || "";
    root.append(row);
  }
}

function renderPermission() {
  const root = $("permission");
  if (!state.permission) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const p = state.permission;
  root.hidden = false;
  root.innerHTML = `<h3></h3><div class="detail"></div><div class="perm-opts"></div>`;
  root.querySelector("h3").textContent = p.title || "需要许可";
  root.querySelector(".detail").textContent = p.detail || "";
  const opts = root.querySelector(".perm-opts");
  for (const opt of p.options || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small";
    b.textContent = opt.label;
    b.addEventListener("click", () => {
      sendJson({ type: "permission_response", requestId: p.requestId, optionId: opt.id });
      state.permission = null;
      renderPermission();
    });
    opts.append(b);
  }
}

function renderChrome() {
  $("hostname").textContent = state.hostname || "未连接";
  $("cwd").textContent = state.cwd || "";
  $("session-title").textContent = sessionTitle();
  $("view-title").textContent = state.viewChildId ? sessionTitle() : "Grokcraft";
  $("back-btn").hidden = !state.viewChildId;
  $("cancel").hidden = !state.turnRunning;
  renderSubagents();
  renderTasks();
  renderPermission();
}

function applySnapshot(msg) {
  state.sessions = msg.sessions || [];
  state.sessionId = msg.activeSessionId;
  state.blocks.clear();
  state.blockOrder = [];
  for (const b of msg.blocks || []) {
    state.blocks.set(b.id, b);
    state.blockOrder.push(b.id);
  }
  state.subagents.clear();
  for (const s of msg.subagents || []) state.subagents.set(s.childSessionId, s);
  state.tasks.clear();
  for (const t of msg.tasks || []) state.tasks.set(t.id, t);
  state.permission = msg.permission || null;
  if (state.viewChildId && state.sessionId && state.sessionId !== state.viewChildId) {
    /* agent switched us */
  }
  renderChrome();
  renderTranscript();
}

function onMessage(msg) {
  switch (msg.type) {
    case "hello":
      if (msg.machine) {
        state.hostname = msg.machine.hostname || state.hostname;
        state.cwd = msg.machine.cwd || state.cwd;
        renderChrome();
      }
      setOnline(true);
      break;
    case "status":
      setOnline(!!msg.online);
      if (msg.cwd) state.cwd = msg.cwd;
      state.model = msg.model;
      if (msg.sessionId) state.sessionId = msg.sessionId;
      state.turnRunning = !!msg.turnRunning;
      renderChrome();
      break;
    case "snapshot":
      setOnline(true);
      applySnapshot(msg);
      break;
    case "block_upsert":
      upsertBlock(msg.block, true);
      break;
    case "block_remove":
      state.blocks.delete(msg.id);
      state.blockOrder = state.blockOrder.filter((id) => id !== msg.id);
      document.getElementById(`block-${msg.id}`)?.remove();
      if (!visibleBlocks().length) renderTranscript();
      break;
    case "subagent_upsert":
      state.subagents.set(msg.subagent.childSessionId, msg.subagent);
      renderSubagents();
      break;
    case "task_upsert":
      state.tasks.set(msg.task.id, msg.task);
      renderTasks();
      break;
    case "permission_request":
      state.permission = msg.request;
      renderPermission();
      break;
    case "permission_clear":
      if (!state.permission || state.permission.requestId === msg.requestId) {
        state.permission = null;
        renderPermission();
      }
      break;
    case "machine_offline":
      setOnline(false);
      renderTranscript();
      break;
    case "machine_online":
      setOnline(true);
      renderTranscript();
      break;
    case "error":
      console.warn(msg.message);
      break;
    default:
      break;
  }
}

function openChildSession(childSessionId) {
  state.viewChildId = childSessionId;
  sendJson({ type: "open_subagent", childSessionId });
  renderChrome();
  renderTranscript();
}

function closeChildSession() {
  state.viewChildId = null;
  sendJson({ type: "close_subagent" });
  renderChrome();
  renderTranscript();
}

function connectWs() {
  const prev = state.ws;
  state.ws = null;
  if (prev) {
    try {
      prev.close();
    } catch {
      /* ignore */
    }
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/browser/ws?machineId=${encodeURIComponent(state.machineId)}`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  });
  ws.addEventListener("message", (ev) => {
    if (ev.data === "pong" || ev.data === "ping") return;
    try {
      onMessage(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    setOnline(false);
    $("status-text").textContent = "重连中";
    setTimeout(() => {
      if (state.ws === ws && state.machineId) connectWs();
    }, 1500);
  });
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

function sendPrompt() {
  const text = $("prompt").value;
  if (!text.trim() || !state.online) return;
  sendJson({
    type: "prompt",
    sessionId: currentSessionId(),
    text,
    promptId: crypto.randomUUID(),
  });
  $("prompt").value = "";
  autoGrow($("prompt"));
}

function showPicker(machines, msg) {
  const box = $("picker");
  $("picker-msg").textContent = msg;
  const list = $("machine-list");
  list.innerHTML = "";
  if (!machines.length) {
    list.innerHTML = `<p class="hint">还没有绑定电脑。在本机 Grok TUI 输入 /grokcraft。</p>`;
    box.hidden = false;
    return;
  }
  for (const m of machines) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "machine-row";
    const seen = m.lastSeen ? new Date(m.lastSeen).toLocaleString() : "";
    b.innerHTML = `<div><div class="h"></div><div class="m"></div></div>`;
    b.querySelector(".h").textContent = m.label || m.hostname;
    b.querySelector(".m").textContent = [m.os, m.cwd, seen].filter(Boolean).join(" · ");
    b.addEventListener("click", () => {
      state.machineId = m.id;
      history.replaceState(null, "", `/app?machineId=${encodeURIComponent(m.id)}`);
      box.hidden = true;
      applyMachine(m);
      connectWs();
    });
    list.append(b);
  }
  box.hidden = false;
}

function applyMachine(m) {
  state.hostname = m.hostname || m.label || "";
  state.cwd = m.cwd || "";
  renderChrome();
}

$("transcript").addEventListener("scroll", () => {
  const el = $("transcript");
  state.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendPrompt();
});

$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$("prompt").addEventListener("input", () => autoGrow($("prompt")));

$("cancel").addEventListener("click", () => {
  sendJson({ type: "cancel", sessionId: currentSessionId() });
});

$("back-btn").addEventListener("click", () => closeChildSession());

$("menu-btn").addEventListener("click", () => document.body.classList.add("drawer-open"));
$("drawer-backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.href = "/login";
});

$("switch-machine").addEventListener("click", () => {
  showPicker(state.machines, "选择一台已授权的电脑。");
});

async function boot() {
  try {
    state.me = await api("/api/me");
    $("me-email").textContent = state.me.email;
  } catch (err) {
    if (err.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
  }
  const data = await api("/api/machines");
  state.machines = data.machines || [];
  if (!state.machineId) {
    if (state.machines.length === 1) {
      state.machineId = state.machines[0].id;
      history.replaceState(null, "", `/app?machineId=${encodeURIComponent(state.machineId)}`);
    } else {
      showPicker(state.machines, state.machines.length ? "选择一台电脑开始对话。" : "还没有绑定电脑。在本机 Grok TUI 输入 /grokcraft。");
      renderChrome();
      renderTranscript();
      return;
    }
  }
  const mine = state.machines.find((m) => m.id === state.machineId);
  if (mine) applyMachine(mine);
  renderChrome();
  renderTranscript();
  connectWs();
}

boot();
