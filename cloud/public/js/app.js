import { api, clearJwt, getJwt, qs } from "./api.js";
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
  commands: [],
  models: [],
  effort: null,
  slashIndex: 0,
  slashItems: [],
  hiddenIds: [],
  notifiedTurn: false,
  usageTab: "limit",
  usagePayload: null,
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
  const send = $("send");
  const prompt = $("prompt");
  if (send) send.disabled = !on;
  if (prompt) prompt.disabled = !on;
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

function hiddenKey() {
  return `gc_hidden_${state.machineId || "na"}`;
}

function loadHidden() {
  try {
    return JSON.parse(localStorage.getItem(hiddenKey()) || "[]");
  } catch {
    return [];
  }
}

function saveHidden(ids) {
  state.hiddenIds = ids;
  localStorage.setItem(hiddenKey(), JSON.stringify(ids));
}

function hideInstance(id) {
  const ids = loadHidden();
  if (!ids.includes(id)) ids.push(id);
  saveHidden(ids);
  if (state.instanceId === id) {
    state.instanceId = "";
    state.sessionId = "";
  }
  renderTree();
  renderChrome();
}

function revealInstance(id) {
  saveHidden(loadHidden().filter((x) => x !== id));
  renderTree();
}

function openAppModal(title, bodyNode) {
  const overlay = $("app-modal");
  const card = $("app-modal-card");
  if (!overlay || !card) return;
  card.classList.remove("usage-picker");
  delete card.dataset.kind;
  card.innerHTML = `<h2></h2><div class="modal-body"></div>`;
  card.querySelector("h2").textContent = title;
  card.querySelector(".modal-body").append(bodyNode);
  overlay.hidden = false;
}

function closeAppModal() {
  const overlay = $("app-modal");
  if (overlay) overlay.hidden = true;
  const card = $("app-modal-card");
  if (card) {
    card.classList.remove("usage-picker");
    delete card.dataset.kind;
  }
}

function openResumeModal() {
  const box = document.createElement("div");
  box.className = "machine-list";
  const rows = [];
  for (const inst of state.instances || []) {
    const sessions = (inst.sessions || []).filter((s) => !s.isChild);
    if (!sessions.length) {
      rows.push({ inst, session: { id: inst.activeSessionId || "", title: "当前窗口" } });
    } else {
      for (const s of sessions) rows.push({ inst, session: s });
    }
  }
  if (!rows.length) {
    box.innerHTML = `<p class="hint">没有可恢复的对话。保持本机 TUI 运行。</p>`;
  }
  for (const row of rows) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "machine-row";
    b.innerHTML = `<div><div class="h"></div><div class="m"></div></div>`;
    b.querySelector(".h").textContent = sessionLabel(row.session);
    b.querySelector(".m").textContent = [cwdLabel(row.inst.cwd), row.session.id.slice(0, 8)].filter(Boolean).join(" · ");
    b.addEventListener("click", () => {
      selectSession(row.inst.instanceId, row.session.id || row.inst.activeSessionId || "");
      if (row.session.id) {
        sendJson({ type: "load_session", sessionId: row.session.id, cwd: row.inst.cwd || "" });
      }
      closeAppModal();
    });
    box.append(b);
  }
  openAppModal("恢复会话", box);
}

function pickVal(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function fmtTok(n) {
  const v = asNum(n);
  if (v == null) return "—";
  if (v >= 99_500) return `${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtTokBig(n) {
  const v = asNum(n);
  if (v == null) return "—";
  if (v >= 999_950) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 99_500) return `${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtUsd(v) {
  if (typeof v === "string" && v.trim()) return v.startsWith("$") ? v : v;
  const n = asNum(v);
  if (n == null) return null;
  const dollars = Math.abs(n) >= 100 && Number.isInteger(n) ? n / 100 : n;
  return `$${dollars.toFixed(2)}`;
}

function mergeUsage(prev, next) {
  const base = prev && typeof prev === "object" ? prev : {};
  const incoming = next && typeof next === "object" ? next : {};
  return {
    text: incoming.text || base.text || "",
    context: incoming.context != null ? incoming.context : base.context,
    limit: incoming.limit != null ? incoming.limit : base.limit,
    session: incoming.session != null ? incoming.session : base.session,
  };
}

function isUsageModalOpen() {
  const overlay = $("app-modal");
  const card = $("app-modal-card");
  return !!(overlay && !overlay.hidden && card?.dataset.kind === "usage");
}

function usageMuted(text) {
  const p = document.createElement("p");
  p.className = "usage-muted";
  p.textContent = text;
  return p;
}

function usagePre(text) {
  const pre = document.createElement("pre");
  pre.className = "install-cmd usage-fallback";
  pre.textContent = text || "无用量数据";
  return pre;
}

function usagePctOf(used, total, explicit) {
  const p = asNum(explicit);
  if (p != null) return Math.max(0, Math.min(100, p));
  const u = asNum(used);
  const t = asNum(total);
  if (u == null || t == null || t <= 0) return 0;
  return Math.max(0, Math.min(100, (u / t) * 100));
}

function stackedBar(segments) {
  const bar = document.createElement("div");
  bar.className = "usage-bar";
  bar.setAttribute("role", "img");
  const total = segments.reduce((s, x) => s + Math.max(0, x.pct || 0), 0) || 1;
  for (const seg of segments) {
    const pct = Math.max(0, seg.pct || 0);
    if (pct <= 0) continue;
    const slice = document.createElement("span");
    slice.className = `usage-bar-seg ${seg.cls || ""}`;
    slice.style.width = `${(pct / total) * 100}%`;
    slice.title = seg.label || "";
    bar.append(slice);
  }
  return bar;
}

function meterBar(pct) {
  const wrap = document.createElement("div");
  wrap.className = "usage-meter";
  const fill = document.createElement("span");
  fill.className = "usage-meter-fill";
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  wrap.append(fill);
  return wrap;
}

function breakdownRow(dotCls, label, tokens, extra) {
  const row = document.createElement("div");
  row.className = "usage-row";
  const left = document.createElement("div");
  left.className = "usage-row-label";
  const dot = document.createElement("span");
  dot.className = `usage-dot ${dotCls}`;
  const name = document.createElement("span");
  name.textContent = label;
  left.append(dot, name);
  const right = document.createElement("div");
  right.className = "usage-row-val";
  right.textContent = extra ? `${fmtTok(tokens)} tokens  ·  ${extra}` : `${fmtTok(tokens)} tokens`;
  row.append(left, right);
  return row;
}

function fillContextPane(pane, payload) {
  pane.replaceChildren();
  const ctx = payload.context;
  const text = payload.text || "";
  if (ctx?.error) {
    pane.append(usageMuted(`Couldn't load context usage: ${ctx.error}`));
    return;
  }
  if (ctx?.noSession) {
    pane.append(usageMuted("No active session."));
    return;
  }
  const used = asNum(pickVal(ctx, "used"));
  const total = asNum(pickVal(ctx, "total"));
  const hasNums = used != null && total != null;
  if (!hasNums) {
    if (ctx?.loading || !ctx) {
      pane.append(usageMuted(ctx ? "Loading context usage…" : text || "Loading context usage…"));
      if (!ctx && text) pane.append(usagePre(text));
      return;
    }
    pane.append(usagePre(text || "无用量数据"));
    return;
  }
  const pct = usagePctOf(used, total, pickVal(ctx, "usagePct", "usage_pct"));
  const model = pickVal(ctx, "model") || "";
  const head = document.createElement("div");
  head.className = "usage-head";
  const title = document.createElement("div");
  title.className = "usage-kicker";
  title.textContent = "Context";
  const nums = document.createElement("div");
  nums.className = "usage-hero";
  nums.textContent = `${fmtTokBig(used)} / ${fmtTokBig(total)} tokens (${pct.toFixed(2)}%)`;
  head.append(title, nums);
  if (model) {
    const m = document.createElement("div");
    m.className = "usage-model";
    m.textContent = String(model);
    head.append(m);
  }
  pane.append(head);

  const system = asNum(pickVal(ctx, "systemPromptTokens", "systemPrompt", "system_prompt", "system_prompt_tokens")) || 0;
  const messages = asNum(pickVal(ctx, "messageTokens", "messages", "message", "message_tokens")) || 0;
  const tools = asNum(pickVal(ctx, "toolDefinitionsTokens", "toolDefinitions", "tool_definitions", "tool_definitions_tokens")) || 0;
  const toolCount = asNum(pickVal(ctx, "toolDefinitionsCount", "tool_definitions_count"));
  const free = asNum(pickVal(ctx, "freeTokens", "free", "free_tokens"));
  const freeTok = free != null ? free : Math.max(0, total - used);
  const overhead = Math.max(0, used - system - messages - tools);
  const sysPct = total ? (system / total) * 100 : 0;
  const msgPct = total ? (messages / total) * 100 : 0;
  const toolPct = total ? (tools / total) * 100 : 0;
  const ohPct = total ? (overhead / total) * 100 : 0;
  const freePct = total ? (freeTok / total) * 100 : 0;
  pane.append(
    stackedBar([
      { pct: sysPct, cls: "sys", label: "System prompt" },
      { pct: toolPct, cls: "tools", label: "Tool definitions" },
      { pct: msgPct, cls: "msg", label: "Messages" },
      { pct: ohPct, cls: "oh", label: "Other" },
      { pct: freePct, cls: "free", label: "Free" },
    ]),
  );

  const list = document.createElement("div");
  list.className = "usage-breakdown";
  list.append(breakdownRow("sys", "System prompt", system));
  const toolExtra = toolCount != null ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "";
  list.append(breakdownRow("tools", "Tool definitions", tools, toolExtra));
  list.append(breakdownRow("msg", "Messages", messages));
  if (overhead > 0) list.append(breakdownRow("oh", "Other", overhead));
  list.append(breakdownRow("free", "Free", freeTok));
  const cats = pickVal(ctx, "categories", "usage_categories") || [];
  if (Array.isArray(cats)) {
    for (const c of cats) {
      if (!c) continue;
      list.append(breakdownRow("tools", c.label || "Category", c.tokens, c.detail || ""));
    }
  }
  pane.append(list);

  const turns = asNum(pickVal(ctx, "turnCount", "turns", "turn_count"));
  const calls = asNum(pickVal(ctx, "toolCallCount", "toolCalls", "tool_calls", "tool_call_count"));
  const comps = asNum(pickVal(ctx, "compactionCount", "compactions", "compaction_count"));
  if (turns != null || calls != null || comps != null) {
    const foot = document.createElement("div");
    foot.className = "usage-foot";
    foot.textContent = `Turns: ${turns ?? "—"}  ·  Tool calls: ${calls ?? "—"}  ·  Compactions: ${comps ?? "—"}`;
    pane.append(foot);
  }
  const autoCompact = asNum(pickVal(ctx, "autoCompactThresholdPercent", "auto_compact_threshold_percent"));
  if (autoCompact != null) {
    const ac = document.createElement("div");
    ac.className = "usage-foot";
    ac.textContent = `Auto-compact at ${autoCompact}%`;
    pane.append(ac);
  }
}

function fillLimitPane(pane, payload) {
  pane.replaceChildren();
  const lim = payload.limit;
  const text = payload.text || "";
  if (!lim) {
    if (text) pane.append(usagePre(text));
    else pane.append(usageMuted("Loading usage…"));
    return;
  }
  if (lim.chatKind || lim.chat_kind) {
    /* gateway chat: no build credits */
  } else if (lim.teamManaged || lim.team_managed) {
    pane.append(usageMuted("Usage limits are managed by your team."));
  } else {
    const url = pickVal(lim, "billingRedirectUrl", "redirectUrl", "redirect_url");
    if (url) {
      const p = document.createElement("p");
      p.className = "usage-muted";
      p.append("Please check your usage on ");
      const a = document.createElement("a");
      a.href = String(url);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = String(url);
      p.append(a);
      pane.append(p);
    } else if (lim.error) {
      pane.append(usageMuted(`Couldn't load usage: ${lim.error}`));
    } else if (lim.loading && asNum(pickVal(lim, "usagePct", "usage_pct")) == null) {
      pane.append(usageMuted("Loading usage…"));
    } else if (asNum(pickVal(lim, "usagePct", "usage_pct")) == null && !pickVal(lim, "usageLabel", "usage_label", "plan")) {
      pane.append(usageMuted("No billing data available."));
    } else {
      const label = pickVal(lim, "usageLabel", "usage_label") || "Usage";
      const plan = pickVal(lim, "plan", "subscription_tier");
      const header = document.createElement("div");
      header.className = "usage-kicker";
      header.textContent = plan ? `${label} (${plan})` : String(label);
      pane.append(header);
      const pct = usagePctOf(null, null, pickVal(lim, "usagePct", "usage_pct"));
      const meterRow = document.createElement("div");
      meterRow.className = "usage-meter-row";
      meterRow.append(meterBar(pct));
      const pctEl = document.createElement("span");
      pctEl.className = "usage-pct";
      pctEl.textContent = `${Math.floor(pct)}%`;
      meterRow.append(pctEl);
      pane.append(meterRow);
      const resets = pickVal(lim, "resets", "period_end_display", "periodEndDisplay");
      if (resets) {
        const r = document.createElement("div");
        r.className = "usage-muted";
        r.textContent = `Resets: ${resets}`;
        pane.append(r);
      }
      const prepaidCents = asNum(pickVal(lim, "prepaidCents", "prepaid_cents"));
      const credits = pickVal(lim, "credits", "prepaid_balance_cents", "prepaidBalanceCents");
      if (prepaidCents != null && prepaidCents > 0) {
        const line = document.createElement("div");
        line.className = "usage-line";
        line.textContent = `Credits: $${(prepaidCents / 100).toFixed(2)}`;
        pane.append(line);
      } else if (credits != null && credits !== 0 && credits !== "0") {
        const line = document.createElement("div");
        line.className = "usage-line";
        const dollars = typeof credits === "string" ? credits : fmtUsd(credits);
        line.textContent = `Credits: ${dollars}`;
        pane.append(line);
      }
      const topup = pickVal(lim, "autoTopup", "auto_topup");
      if (topup && typeof topup === "object") {
        const line = document.createElement("div");
        line.className = "usage-muted";
        if (topup.enabled && (topup.amount != null || topup.topup_amount_cents != null)) {
          line.textContent = `Auto topup: ${fmtUsd(pickVal(topup, "amount", "topup_amount_cents")) || ""}`;
        } else if (topup.enabled === false) {
          line.textContent = "Auto topup: disabled";
        }
        if (line.textContent) pane.append(line);
      } else if (typeof topup === "string" && topup) {
        const line = document.createElement("div");
        line.className = "usage-muted";
        line.textContent = topup.includes(":") ? topup : `Auto topup: ${topup}`;
        pane.append(line);
      }
      const payg = pickVal(lim, "payAsYouGo", "pay_as_you_go", "payg");
      const paygUsedCents = asNum(pickVal(lim, "payAsYouGoUsedCents", "pay_as_you_go_used_cents"));
      const paygCapCents = asNum(pickVal(lim, "payAsYouGoCapCents", "pay_as_you_go_cap_cents"));
      if (payg || paygUsedCents != null || paygCapCents != null) {
        const title = document.createElement("div");
        title.className = "usage-kicker";
        title.textContent = "Pay as you go: Enabled";
        pane.append(title);
        let used;
        let cap;
        if (typeof payg === "object") {
          used = fmtUsd(pickVal(payg, "used", "on_demand_used_cents"));
          cap = fmtUsd(pickVal(payg, "cap", "on_demand_cap_cents"));
        } else {
          used = paygUsedCents != null ? `$${(paygUsedCents / 100).toFixed(2)}` : null;
          cap = paygCapCents != null ? `$${(paygCapCents / 100).toFixed(2)}` : null;
        }
        if (used || cap) {
          const sub = document.createElement("div");
          sub.className = "usage-muted";
          sub.textContent = `Usage: ${used || "$0.00"} / ${cap || "$0.00"} per month`;
          pane.append(sub);
        }
      }
    }
  }
  const sessionUsage = pickVal(lim, "sessionUsageText", "session_usage_text");
  if (sessionUsage) {
    const block = document.createElement("pre");
    block.className = "usage-session-text";
    block.textContent = String(sessionUsage);
    pane.append(block);
  } else if (!lim.error && currentSessionId()) {
    const pending = document.createElement("div");
    pending.className = "usage-muted";
    pending.textContent = "Loading session usage…";
    pane.append(pending);
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function flashCopied(el) {
  el.classList.add("copied");
  const prev = el.querySelector(".usage-copy-hint");
  if (prev) prev.textContent = "已复制";
  setTimeout(() => {
    el.classList.remove("copied");
    if (prev) prev.textContent = "点击复制";
  }, 1200);
}

function fillSessionPane(pane, payload) {
  pane.replaceChildren();
  const sess = payload.session;
  const text = payload.text || "";
  if (sess?.error) {
    pane.append(usageMuted(`Couldn't load session info: ${sess.error}`));
    return;
  }
  if (sess?.noSession) {
    pane.append(usageMuted("No active session."));
    return;
  }
  const fields = pickVal(sess, "fields", "session_fields");
  if (!Array.isArray(fields) || !fields.length) {
    if (sess?.loading || !sess) {
      pane.append(usageMuted("Loading session info…"));
      if (!sess && text) pane.append(usagePre(text));
      return;
    }
    pane.append(usagePre(text || "无会话信息"));
    return;
  }
  const toolbar = document.createElement("div");
  toolbar.className = "usage-toolbar";
  const hint = document.createElement("span");
  hint.className = "usage-muted";
  hint.textContent = "click to copy";
  const copyAll = document.createElement("button");
  copyAll.type = "button";
  copyAll.className = "btn small ghost";
  copyAll.textContent = "复制全部";
  copyAll.addEventListener("click", async () => {
    const blob = fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    if (await copyText(blob)) flashCopied(copyAll);
  });
  toolbar.append(hint, copyAll);
  pane.append(toolbar);
  const list = document.createElement("div");
  list.className = "usage-fields";
  for (const f of fields) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = f.compact ? "usage-field compact" : "usage-field";
    const lab = document.createElement("span");
    lab.className = "k";
    lab.textContent = f.label;
    const val = document.createElement("span");
    val.className = "v";
    val.textContent = f.value;
    const tip = document.createElement("span");
    tip.className = "usage-copy-hint";
    tip.textContent = "点击复制";
    row.append(lab, val, tip);
    const copied = f.compact ? `${f.label}: ${f.value}` : f.value;
    row.addEventListener("click", async () => {
      if (await copyText(copied)) flashCopied(row);
    });
    list.append(row);
  }
  pane.append(list);
  const usageText = pickVal(sess, "sessionUsageText", "usageText", "usage_text", "session_usage_text");
  if (usageText) {
    const block = document.createElement("pre");
    block.className = "usage-session-text";
    block.textContent = String(usageText);
    pane.append(block);
  }
}

function syncUsageTabs() {
  const card = $("app-modal-card");
  const panel = card?.querySelector(".usage-panel");
  if (!panel) return;
  const tab = state.usageTab || "context";
  for (const btn of panel.querySelectorAll("[data-tab]")) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const pane of panel.querySelectorAll("[data-pane]")) {
    pane.hidden = pane.dataset.pane !== tab;
  }
}

function fillUsagePanes() {
  const card = $("app-modal-card");
  const panel = card?.querySelector(".usage-panel");
  if (!panel) return;
  const payload = state.usagePayload || { text: "" };
  const ctxPane = panel.querySelector('[data-pane="context"]');
  const limPane = panel.querySelector('[data-pane="limit"]');
  const sessPane = panel.querySelector('[data-pane="session"]');
  if (ctxPane) fillContextPane(ctxPane, payload);
  if (limPane) fillLimitPane(limPane, payload);
  if (sessPane) fillSessionPane(sessPane, payload);
}

function openUsageModal(payload) {
  const data = typeof payload === "string" ? { text: payload } : payload || {};
  const already = isUsageModalOpen();
  if (already) {
    state.usagePayload = mergeUsage(state.usagePayload, data);
    fillUsagePanes();
    syncUsageTabs();
    return;
  }
  state.usageTab = "limit";
  state.usagePayload = mergeUsage(null, data);
  const box = document.createElement("div");
  box.className = "usage-panel";
  const tabs = document.createElement("div");
  tabs.className = "usage-tabs";
  tabs.setAttribute("role", "tablist");
  const defs = [
    ["context", "Context usage"],
    ["limit", "Usage limit"],
    ["session", "Session info"],
  ];
  for (const [id, label] of defs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "usage-tab";
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.textContent = label;
    b.addEventListener("click", () => {
      state.usageTab = id;
      syncUsageTabs();
    });
    tabs.append(b);
  }
  box.append(tabs);
  for (const [id] of defs) {
    const pane = document.createElement("div");
    pane.className = "usage-pane";
    pane.dataset.pane = id;
    pane.setAttribute("role", "tabpanel");
    box.append(pane);
  }
  openAppModal("Usage", box);
  const card = $("app-modal-card");
  if (card) {
    card.dataset.kind = "usage";
    card.classList.add("usage-picker");
  }
  fillUsagePanes();
  syncUsageTabs();
}

function notifyDone(body) {
  if (!document.hidden) return;
  if (!window.Notification || Notification.permission !== "granted") return;
  const title = "Grokcraft";
  const payload = { type: "notify", title, body: body || "任务已完成", tag: "grok-done" };
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
  } else {
    try {
      new Notification(title, { body: payload.body, icon: "/favicon.svg" });
    } catch {
      /* ignore */
    }
  }
}

function closeCtxMenu() {
  document.querySelector(".ctx-menu")?.remove();
}

function showCtxMenu(event, items) {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.label;
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeCtxMenu();
      item.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const pad = 8;
  const w = menu.offsetWidth || 132;
  const h = menu.offsetHeight || 44;
  let x = event.clientX;
  let y = event.clientY;
  if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

document.addEventListener("click", closeCtxMenu);
document.addEventListener("scroll", closeCtxMenu, true);

function renderTree() {
  const root = $("project-tree");
  if (!root) return;
  root.innerHTML = "";
  state.hiddenIds = loadHidden();
  const list = (state.instances || []).filter((inst) => !state.hiddenIds.includes(inst.instanceId));
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
    head.innerHTML = `<span class="chev"></span><span class="folder-ico" aria-hidden="true"></span><span class="folder"></span><span class="meta"></span><button class="more-btn" type="button" aria-label="更多">⋯</button>`;
    head.querySelector(".chev").textContent = open ? "▾" : "▸";
    head.querySelector(".folder").textContent = name;
    const n = (inst.sessions || []).filter((s) => !s.isChild).length;
    head.querySelector(".meta").textContent = n ? `${n}` : "";
    head.querySelector(".more-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e, [{ label: "隐藏", run: () => hideInstance(inst.instanceId) }]);
    });
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
        row.innerHTML = `<span class="title"></span><button class="more-btn" type="button" aria-label="隐藏">⋯</button>`;
        row.querySelector(".title").textContent = sessionLabel(s);
        if (inst.turnRunning && inst.activeSessionId === s.id) {
          const busy = document.createElement("span");
          busy.className = "busy";
          row.querySelector(".title").after(busy);
        }
        row.querySelector(".more-btn").addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showCtxMenu(e, [{ label: "隐藏", run: () => hideInstance(inst.instanceId) }]);
        });
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

function blockText(block) {
  return (block.detail || block.content || block.activityLabel || "").trim();
}

function isNoticeKind(kind) {
  return kind === "session_event" || kind === "system" || kind === "context";
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
  const text = blockText(block);
  const collapsed = block.displayMode === "collapsed";
  const truncated = block.displayMode === "truncated";
  const showChrome = block.foldable || openChild || block.kind === "thinking" || block.kind === "tool" || block.kind === "bg_task";

  if (isNoticeKind(block.kind)) {
    const notice = document.createElement("div");
    notice.className = "notice";
    const raw = text || block.title || "";
    if (/fail|error|required|too large|disk full/i.test(raw)) notice.classList.add("warn");
    notice.textContent = raw;
    body.append(notice);
    el.append(body);
    return el;
  }

  if (block.kind === "user") {
    const bubble = document.createElement("div");
    const raw = text || block.title || "";
    bubble.className = "bubble";
    if (raw.length <= 24 && !raw.includes("\n")) bubble.classList.add("short");
    bubble.textContent = raw;
    body.append(bubble);
    el.append(body);
    return el;
  }

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
    const extra = block.title && block.title !== kindLabel(block) && block.title.toLowerCase() !== kindLabel(block).toLowerCase()
      && !["thinking", "user", "assistant", "system"].includes(block.title.toLowerCase())
      ? block.title
      : block.activityLabel || "";
    title.textContent = extra;
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
    /* one-line */
  } else if (collapsed && block.foldable) {
    /* folded */
  } else if (truncated) {
    const prev = document.createElement("div");
    prev.className = "preview";
    prev.textContent = truncate(text || "", 220);
    body.append(prev);
  } else {
    const html = renderMarkdown(block.detail || block.content || "");
    const wrap = document.createElement("div");
    wrap.className = "md";
    wrap.innerHTML = html || "";
    if (wrap.childNodes.length) body.append(wrap);
  }

  el.append(body);
  return el;
}

function visibleBlocks() {
  const sid = currentSessionId();
  const out = [];
  for (const id of state.blockOrder) {
    const b = state.blocks.get(id);
    if (!b) continue;
    if (sid && b.sessionId && b.sessionId !== sid) continue;
    const text = blockText(b);
    const title = (b.title || "").trim();
    if (!text && !title) continue;
    if (b.kind === "stub") continue;
    if (!text && (b.kind === "session_event" || b.kind === "context" || b.kind === "system") && (title === "Session event" || title === "Stub" || title === "Context")) {
      continue;
    }
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
  $("view-title").textContent = sessionTitle();
  const sub = $("view-sub");
  if (sub) {
    const bits = [state.model, state.effort, cwdLabel(state.cwd)].filter(Boolean);
    sub.textContent = bits.join(" · ");
  }
  const chip = $("model-chip");
  if (chip) {
    chip.textContent = state.model ? `${state.model}${state.effort ? " · " + state.effort : ""}` : "模型";
  }
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
      if (msg.turnRunning && !state.turnRunning) {
        state.notifiedTurn = false;
      }
      if (!msg.turnRunning && state.turnRunning && !state.notifiedTurn) {
        state.notifiedTurn = true;
        notifyDone("Grok 本轮已完成");
      }
      state.turnRunning = !!msg.turnRunning;
      renderChrome();
      break;
    case "usage":
      openUsageModal(msg);
      break;
    case "reveal":
      if (msg.instanceId) revealInstance(msg.instanceId);
      break;
    case "commands":
      if (!forSelectedInstance(msg) && state.instanceId) break;
      state.commands = msg.commands || [];
      break;
    case "models":
      if (!forSelectedInstance(msg) && state.instanceId) break;
      state.models = msg.models || [];
      if (msg.current) state.model = msg.current;
      if (msg.reasoningEffort) state.effort = msg.reasoningEffort;
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
      if (msg.block?.kind === "session_event" && /^Worked for /i.test(blockText(msg.block))) {
        if (!state.notifiedTurn) {
          state.notifiedTurn = true;
          notifyDone(blockText(msg.block));
        }
      }
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
  const params = new URLSearchParams({ machineId: state.machineId });
  const jwt = getJwt();
  if (jwt) params.set("access_token", jwt);
  const ws = new WebSocket(`${proto}//${location.host}/browser/ws?${params}`);
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

const FALLBACK_COMMANDS = [
  { name: "model", aliases: ["m"], description: "切换模型", usage: "/model <name> [effort]", takesArgs: true, argsRequired: true },
  { name: "resume", aliases: ["re"], description: "恢复会话", usage: "/resume", takesArgs: false, argsRequired: false },
  { name: "new", aliases: ["n"], description: "新会话", usage: "/new", takesArgs: false, argsRequired: false },
  { name: "compact", aliases: [], description: "压缩上下文", usage: "/compact", takesArgs: false, argsRequired: false },
  { name: "plan", aliases: [], description: "计划模式", usage: "/plan", takesArgs: false, argsRequired: false },
  { name: "help", aliases: ["h"], description: "命令帮助", usage: "/help", takesArgs: false, argsRequired: false },
  { name: "usage", aliases: ["cost"], description: "查看用量", usage: "/usage", takesArgs: true, argsRequired: false },
  { name: "effort", aliases: [], description: "推理强度", usage: "/effort <level>", takesArgs: true, argsRequired: true },
];

function commandList() {
  return state.commands.length ? state.commands : FALLBACK_COMMANDS;
}

function slashQuery(text) {
  if (!text.startsWith("/")) return null;
  const m = text.match(/^\/(\S*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1] || "", args: m[2] ?? null };
}

function matchCommands(cmd) {
  const q = cmd.toLowerCase();
  return commandList()
    .filter((c) => {
      if (!q) return true;
      if (c.name.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)) return true;
      return (c.aliases || []).some((a) => a.toLowerCase().startsWith(q) || a.toLowerCase().includes(q));
    })
    .slice(0, 8);
}

function hideSlash() {
  const pop = $("slash-pop");
  if (!pop) return;
  pop.hidden = true;
  pop.innerHTML = "";
  state.slashItems = [];
}

function showSlash(items, kind) {
  const pop = $("slash-pop");
  if (!pop) return;
  state.slashItems = items;
  if (state.slashIndex >= items.length) state.slashIndex = 0;
  if (!items.length) {
    hideSlash();
    return;
  }
  pop.hidden = false;
  pop.innerHTML = "";
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "slash-row" + (i === state.slashIndex ? " active" : "");
    const left = kind === "model" ? item.name || item.id : `/${item.name}`;
    const right = kind === "model" ? item.id || "" : item.description || item.usage || "";
    row.innerHTML = `<span class="cmd"></span><span class="desc"></span>`;
    row.querySelector(".cmd").textContent = left;
    row.querySelector(".desc").textContent = right;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      state.slashIndex = i;
      applySlashItem(kind);
    });
    pop.append(row);
  });
}

function refreshSlash() {
  const text = $("prompt").value;
  const q = slashQuery(text);
  if (!q) {
    hideSlash();
    return;
  }
  const exact = commandList().find((c) => c.name === q.cmd || (c.aliases || []).includes(q.cmd));
  if (exact && (exact.name === "model" || exact.aliases?.includes("m")) && q.args !== null) {
    const needle = (q.args || "").trim().toLowerCase();
    const models = (state.models || []).filter((m) => {
      if (!needle) return true;
      return m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle);
    });
    showSlash(models.length ? models : state.models, "model");
    return;
  }
  showSlash(matchCommands(q.cmd), "cmd");
}

function applySlashItem(kind) {
  const item = state.slashItems[state.slashIndex];
  if (!item) return;
  const prompt = $("prompt");
  if (kind === "model") {
    prompt.value = `/model ${item.name} `;
    hideSlash();
    autoGrow(prompt);
    prompt.focus();
    refreshSlash();
    return;
  }
  prompt.value = item.takesArgs ? `/${item.name} ` : `/${item.name}`;
  hideSlash();
  autoGrow(prompt);
  prompt.focus();
  if (item.takesArgs) refreshSlash();
}

function sendPrompt() {
  const prompt = $("prompt");
  let text = prompt.value;
  const trimmed = text.trim();
  const q0 = slashQuery(trimmed);
  if (q0 && (q0.cmd === "resume" || q0.cmd === "re") && !(q0.args || "").trim()) {
    prompt.value = "";
    hideSlash();
    openResumeModal();
    return;
  }
  if (q0 && (q0.cmd === "usage" || q0.cmd === "cost")) {
    prompt.value = "";
    hideSlash();
    sendJson({ type: "request_usage", sessionId: currentSessionId() });
    openUsageModal({ text: "Loading usage…" });
    return;
  }
  const pop = $("slash-pop");
  const open = pop && !pop.hidden && state.slashItems.length;
  if (open) {
    const q = slashQuery(text);
    const kind = q && (q.cmd === "model" || q.cmd === "m") && q.args !== null ? "model" : "cmd";
    applySlashItem(kind);
    text = prompt.value;
    const next = slashQuery(text);
    if (kind === "model") {
      text = text.trim();
    } else {
      const cmd = commandList().find((c) => c.name === next?.cmd || (c.aliases || []).includes(next?.cmd));
      if (cmd?.takesArgs && !(next.args || "").trim()) return;
    }
  }
  if (!text.trim() || !state.online || !state.sessionId) return;
  sendJson({
    type: "prompt",
    instanceId: state.instanceId,
    sessionId: currentSessionId(),
    text: text.trim(),
    promptId: crypto.randomUUID(),
  });
  prompt.value = "";
  hideSlash();
  autoGrow(prompt);
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
  const pop = $("slash-pop");
  const open = pop && !pop.hidden && state.slashItems.length;
  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = state.slashItems.length;
    state.slashIndex = e.key === "ArrowDown" ? (state.slashIndex + 1) % n : (state.slashIndex - 1 + n) % n;
    refreshSlash();
    return;
  }
  if (open && e.key === "Tab") {
    e.preventDefault();
    const q = slashQuery($("prompt").value);
    const kind = q && (q.cmd === "model" || q.cmd === "m") && q.args !== null ? "model" : "cmd";
    applySlashItem(kind);
    return;
  }
  if (open && e.key === "Escape") {
    e.preventDefault();
    hideSlash();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$("prompt").addEventListener("input", () => {
  autoGrow($("prompt"));
  refreshSlash();
});
$("model-chip")?.addEventListener("click", () => {
  if (!state.models.length) {
    $("prompt").value = "/model ";
    $("prompt").focus();
    refreshSlash();
    return;
  }
  $("prompt").value = "/model ";
  $("prompt").focus();
  refreshSlash();
});

$("cancel").addEventListener("click", () => {
  sendJson({ type: "cancel", sessionId: currentSessionId() });
});

$("back-btn").addEventListener("click", () => closeChildSession());

$("menu-btn").addEventListener("click", () => document.body.classList.add("drawer-open"));
$("drawer-backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* still leave */
  }
  clearJwt();
  location.href = "/login";
});

$("switch-machine").addEventListener("click", () => {
  showPicker(state.machines, "选择一台已授权的电脑。");
});

$("app-modal")?.addEventListener("click", (e) => {
  if (e.target === $("app-modal")) closeAppModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const overlay = $("app-modal");
  if (overlay && !overlay.hidden) {
    e.preventDefault();
    closeAppModal();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

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
