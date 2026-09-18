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
  instanceId: "",
  turnRunning: false,
  sessions: [],
  instances: [],
  expanded: {},
  blocks: new Map(),
  blockOrder: [],
  subagents: new Map(),
  tasks: new Map(),
  permission: null,
  viewChildId: null,
  stickBottom: true,
  ws: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  pingTimer: null,
};

function currentSessionId() {
  return state.viewChildId || state.sessionId;
}

function forSelectedInstance(msg) {
  if (!msg.instanceId) return true;
  if (!state.instanceId) return false;
  return msg.instanceId === state.instanceId;
}

function cwdLabel(cwd) {
  if (!cwd) return "本机会话";
  const parts = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function sessionLabel(s) {
  if (s?.title && s.title !== s.id) return s.title;
  if (s?.id) return s.id.slice(0, 8);
  return "对话";
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
  if (state.instanceId && msg.instanceId == null) msg.instanceId = state.instanceId;
  state.ws.send(JSON.stringify(msg));
}

function watchSelection() {
  if (!state.instanceId) return;
  sendJson({ type: "watch", instanceId: state.instanceId, sessionId: state.sessionId || "" });
}

function selectSession(instanceId, sessionId) {
  const changed = state.instanceId !== instanceId || state.sessionId !== sessionId;
  state.instanceId = instanceId;
  state.sessionId = sessionId;
  state.viewChildId = null;
  if (changed) {
    state.blocks.clear();
    state.blockOrder = [];
    state.subagents.clear();
    state.tasks.clear();
    state.permission = null;
  }
  const inst = state.instances.find((i) => i.instanceId === instanceId);
  if (inst) {
    state.hostname = inst.hostname || state.hostname;
    state.cwd = inst.cwd || "";
    state.turnRunning = !!inst.turnRunning;
  }
  watchSelection();
  renderTree();
  renderChrome();
  renderTranscript();
}

function renderTree() {
  const root = $("project-tree");
  if (!root) return;
  root.innerHTML = "";
  const list = state.instances || [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = state.online
      ? "还没有对话。在本机 Grok TUI 开一个会话即可出现在这里。"
      : "电脑离线。保持 Grok TUI 运行，配对过一次后会自动连上。";
    root.append(empty);
    return;
  }
  const usedNames = {};
  for (const inst of list) {
    const base = cwdLabel(inst.cwd) || inst.label || inst.hostname || "窗口";
    usedNames[base] = (usedNames[base] || 0) + 1;
    inst._displayName = usedNames[base] > 1 ? `${base} · ${usedNames[base]}` : base;
  }
  const counts = {};
  for (const inst of list) {
    const base = cwdLabel(inst.cwd) || inst.label || inst.hostname || "窗口";
    counts[base] = (counts[base] || 0) + 1;
  }
  const seen = {};
  for (const inst of list) {
    const base = cwdLabel(inst.cwd) || inst.label || inst.hostname || "窗口";
    seen[base] = (seen[base] || 0) + 1;
    const name = counts[base] > 1 ? `${base} · ${seen[base]}` : base;
    const open = state.expanded[inst.instanceId] !== false;
    const box = document.createElement("div");
    box.className = "proj";
    const head = document.createElement("div");
    head.className = "proj-head";
    head.innerHTML = `<span class="chev"></span><span class="folder-ico" aria-hidden="true"></span><span class="folder"></span><span class="meta"></span>`;
    head.querySelector(".chev").textContent = open ? "▾" : "▸";
    head.querySelector(".folder").textContent = name;
    const n = (inst.sessions || []).filter((s) => !s.isChild).length;
    head.querySelector(".meta").textContent = n ? `${n}` : "";
    head.addEventListener("click", () => {
      state.expanded[inst.instanceId] = !open;
      renderTree();
    });
    box.append(head);
    if (open) {
      const sessions = (inst.sessions || []).filter((s) => !s.isChild);
      if (!sessions.length) {
        const row = document.createElement("div");
        row.className = "sess-row";
        row.innerHTML = `<span class="title">当前窗口</span>`;
        if (state.instanceId === inst.instanceId) row.classList.add("active");
        row.addEventListener("click", () => selectSession(inst.instanceId, inst.activeSessionId || ""));
        box.append(row);
      }
      for (const s of sessions) {
        const row = document.createElement("div");
        row.className = "sess-row";
        if (state.instanceId === inst.instanceId && state.sessionId === s.id) row.classList.add("active");
        row.innerHTML = `<span class="title"></span>`;
        row.querySelector(".title").textContent = sessionLabel(s);
        if (inst.turnRunning && inst.activeSessionId === s.id) {
          const busy = document.createElement("span");
          busy.className = "busy";
          row.append(busy);
        }
        row.addEventListener("click", () => selectSession(inst.instanceId, s.id));
        box.append(row);
      }
    }
    root.append(box);
  }
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
    empty.innerHTML = !state.online
      ? "<strong>电脑离线</strong><br />请保持本机 Grok TUI 运行。"
      : !state.sessionId
        ? "<strong>选择一个对话</strong><br />左侧项目列表里点开即可。"
        : "<strong>开始对话</strong><br />输入消息发给 Grok Build。";
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
  const section = $("subagent-section");
  root.innerHTML = "";
  const list = [...state.subagents.values()];
  if (section) section.hidden = !list.length;
  if (!list.length) {
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
  const section = $("task-section");
  root.innerHTML = "";
  const list = [...state.tasks.values()];
  if (section) section.hidden = !list.length;
  if (!list.length) {
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
  $("view-title").textContent = state.viewChildId ? sessionTitle() : sessionTitle();
  $("back-btn").hidden = !state.viewChildId;
  $("cancel").hidden = !state.turnRunning;
  $("send").disabled = !state.online || !state.sessionId;
  $("prompt").disabled = !state.online || !state.sessionId;
  renderTree();
  renderSubagents();
  renderTasks();
  renderPermission();
}

function applySnapshot(msg) {
  if (msg.sessions) state.sessions = msg.sessions;
  if (msg.activeSessionId && !state.sessionId) state.sessionId = msg.activeSessionId;
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
  renderChrome();
  renderTranscript();
}

function firstSessionId(inst) {
  const first = (inst?.sessions || []).find((s) => !s.isChild);
  return first?.id || inst?.activeSessionId || "";
}

function applyCatalog(msg) {
  state.instances = msg.instances || [];
  const any = !!msg.machineOnline && state.instances.length > 0;
  setOnline(any);
  if (state.instanceId && !state.instances.some((i) => i.instanceId === state.instanceId)) {
    state.instanceId = "";
    state.sessionId = "";
    state.blocks.clear();
    state.blockOrder = [];
  }
  if (!state.instanceId && state.instances.length === 1) {
    const inst = state.instances[0];
    selectSession(inst.instanceId, firstSessionId(inst));
    return;
  }
  if (state.instanceId && !state.sessionId) {
    const inst = state.instances.find((i) => i.instanceId === state.instanceId);
    const sid = firstSessionId(inst);
    if (sid) {
      selectSession(state.instanceId, sid);
      return;
    }
  }
  renderChrome();
}

function onMessage(msg) {
  switch (msg.type) {
    case "catalog":
      applyCatalog(msg);
      break;
    case "hello":
      setOnline(true);
      break;
    case "status":
      if (!forSelectedInstance(msg)) break;
      setOnline(!!msg.online);
      if (msg.cwd) state.cwd = msg.cwd;
      state.model = msg.model;
      state.turnRunning = !!msg.turnRunning;
      renderChrome();
      break;
    case "snapshot":
      if (!forSelectedInstance(msg)) break;
      setOnline(true);
      applySnapshot(msg);
      break;
    case "block_upsert":
      if (!forSelectedInstance(msg)) break;
      upsertBlock(msg.block, true);
      break;
    case "block_remove":
      if (!forSelectedInstance(msg)) break;
      state.blocks.delete(msg.id);
      state.blockOrder = state.blockOrder.filter((id) => id !== msg.id);
      document.getElementById(`block-${msg.id}`)?.remove();
      if (!visibleBlocks().length) renderTranscript();
      break;
    case "subagent_upsert":
      if (!forSelectedInstance(msg)) break;
      state.subagents.set(msg.subagent.childSessionId, msg.subagent);
      renderSubagents();
      break;
    case "task_upsert":
      if (!forSelectedInstance(msg)) break;
      state.tasks.set(msg.task.id, msg.task);
      renderTasks();
      break;
    case "permission_request":
      if (!forSelectedInstance(msg)) break;
      state.permission = msg.request;
      renderPermission();
      break;
    case "permission_clear":
      if (!forSelectedInstance(msg)) break;
      if (!state.permission || state.permission.requestId === msg.requestId) {
        state.permission = null;
        renderPermission();
      }
      break;
    case "machine_offline":
      setOnline(false);
      renderTree();
      renderTranscript();
      break;
    case "machine_online":
      setOnline(true);
      renderTree();
      break;
    case "instance_offline":
      if (msg.instanceId === state.instanceId) {
        state.instanceId = "";
        state.sessionId = "";
        renderChrome();
        renderTranscript();
      }
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
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
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
    state.reconnectAttempt = 0;
    if (state.pingTimer) clearInterval(state.pingTimer);
    // Hibernation auto-response: does not wake the isolate / D1.
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 50000);
    if (state.instanceId) watchSelection();
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
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    if (state.ws !== ws) return;
    setOnline(false);
    $("status-text").textContent = "重连中";
    const delay = Math.min(15000, 2000 * Math.pow(2, state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      if (state.machineId) connectWs();
    }, delay);
  });
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

function sendPrompt() {
  const text = $("prompt").value;
  if (!text.trim() || !state.online || !state.sessionId) return;
  sendJson({
    type: "prompt",
    instanceId: state.instanceId,
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
