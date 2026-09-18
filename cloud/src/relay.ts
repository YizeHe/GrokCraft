import { DurableObject } from "cloudflare:workers";
import { touchMachine, updatePairingMeta } from "./db";
import type { MachineInfo, SessionSummary, WsAttachment } from "./protocol";

const AGENT_TAG = "agent";
const BROWSER_TAG = "browser";
const LAST_TOUCH_KEY = "lastTouch";
const CATALOG_KEY = "catalog";
/** D1 last_seen at most once per 5 minutes — WS hibernation ping does not wake us. */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export type InstanceInfo = {
  instanceId: string;
  pid: number;
  cwd: string;
  hostname: string;
  label: string;
  grokVersion: string;
  activeSessionId: string | null;
  turnRunning: boolean;
  sessions: SessionSummary[];
};

type Catalog = Record<string, InstanceInfo>;

function jsonSend(ws: WebSocket, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* closed */
  }
}

function attachmentOf(ws: WebSocket): WsAttachment | null {
  const raw = ws.deserializeAttachment();
  if (!raw || typeof raw !== "object") return null;
  return raw as WsAttachment;
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.READY_STATE_OPEN || ws.readyState === WebSocket.OPEN;
}

function agentTag(instanceId: string): string {
  return `agent:${instanceId}`;
}

export class MachineRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernation-level ping/pong: does not wake the isolate, does not hit D1.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const role = request.headers.get("X-Grokcraft-Role");
    if (role !== "agent" && role !== "browser") {
      return new Response("Missing role", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const instanceId = request.headers.get("X-Grokcraft-Instance-Id") || "";

    const attach: WsAttachment = {
      role,
      auth: (request.headers.get("X-Grokcraft-Auth") as WsAttachment["auth"]) || "session",
      userId: request.headers.get("X-Grokcraft-User-Id") || undefined,
      pairingId: request.headers.get("X-Grokcraft-Pairing-Id") || undefined,
      userCode: request.headers.get("X-Grokcraft-User-Code") || undefined,
      instanceId: instanceId || undefined,
    };

    if (role === "agent") {
      // Replace only this CLI process reconnecting — never kick sibling grok windows.
      if (instanceId) {
        for (const old of this.ctx.getWebSockets(agentTag(instanceId))) {
          try {
            old.close(4002, "replaced");
          } catch {
            /* ignore */
          }
        }
      }
      const tags = instanceId ? [AGENT_TAG, agentTag(instanceId)] : [AGENT_TAG];
      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment(attach);
      const hadBrowsers = this.ctx.getWebSockets(BROWSER_TAG).some(isOpen);
      this.broadcastBrowsers({ type: "machine_online" });
      await this.broadcastCatalog();
      if (hadBrowsers) {
        // Do not auto-subscribe: browsers pick a session. Catalog is enough.
      }
    } else {
      this.ctx.acceptWebSocket(server, [BROWSER_TAG]);
      server.serializeAttachment(attach);
      const agents = this.ctx.getWebSockets(AGENT_TAG).filter(isOpen);
      if (!agents.length) jsonSend(server, { type: "machine_offline" });
      else jsonSend(server, { type: "machine_online" });
      jsonSend(server, { type: "catalog", instances: Object.values(await this.loadCatalog()), machineOnline: agents.length > 0 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async notifyPaired(payload: {
    machineToken: string;
    userId: string;
    machineId: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const agents = this.ctx.getWebSockets(AGENT_TAG).filter(isOpen);
    if (!agents.length) return { ok: false, reason: "agent_offline" };
    const frame = {
      type: "paired",
      machineToken: payload.machineToken,
      userId: payload.userId,
      machineId: payload.machineId,
    };
    for (const agent of agents) jsonSend(agent, frame);
    this.broadcastBrowsers({ type: "paired_ok" });
    return { ok: true };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === "ping" || message === "pong") return;

    let parsed: { type?: string; [k: string]: unknown };
    try {
      parsed = JSON.parse(message) as { type?: string };
    } catch {
      jsonSend(ws, { type: "error", message: "invalid_json" });
      return;
    }
    if (!parsed || typeof parsed.type !== "string") return;
    const msg = parsed as { type: string; [k: string]: unknown };

    const attach = attachmentOf(ws);
    const role = attach?.role;
    if (role === "agent") {
      await this.onAgentMessage(ws, msg);
      return;
    }
    if (role === "browser") {
      await this.onBrowserMessage(ws, msg, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attach = attachmentOf(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    if (attach?.role === "agent") {
      const instanceId = attach.instanceId;
      if (instanceId) {
        const stillHere = this.ctx
          .getWebSockets(agentTag(instanceId))
          .some((s) => s !== ws && isOpen(s));
        if (!stillHere) {
          const catalog = await this.loadCatalog();
          delete catalog[instanceId];
          await this.saveCatalog(catalog);
          this.broadcastBrowsers({ type: "instance_offline", instanceId });
        }
      }
      const remaining = this.ctx.getWebSockets(AGENT_TAG).filter((s) => s !== ws && isOpen(s));
      await this.broadcastCatalog();
      if (!remaining.length) this.broadcastBrowsers({ type: "machine_offline" });
      return;
    }
    if (attach?.role === "browser") {
      await this.recomputeSubscriptions();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  private agentByInstance(instanceId: string): WebSocket | null {
    const list = this.ctx.getWebSockets(agentTag(instanceId)).filter(isOpen);
    return list.length ? list[list.length - 1] : null;
  }

  private sendAgentInstance(instanceId: string, data: unknown): boolean {
    const agent = this.agentByInstance(instanceId);
    if (!agent) return false;
    jsonSend(agent, data);
    return true;
  }

  private broadcastBrowsers(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets(BROWSER_TAG)) {
      if (!isOpen(ws)) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private async loadCatalog(): Promise<Catalog> {
    return ((await this.ctx.storage.get<Catalog>(CATALOG_KEY)) as Catalog) || {};
  }

  private async saveCatalog(catalog: Catalog): Promise<void> {
    await this.ctx.storage.put(CATALOG_KEY, catalog);
  }

  private async broadcastCatalog(): Promise<void> {
    const catalog = await this.loadCatalog();
    const agentsOnline = this.ctx.getWebSockets(AGENT_TAG).some(isOpen);
    this.broadcastBrowsers({
      type: "catalog",
      instances: Object.values(catalog),
      machineOnline: agentsOnline,
    });
  }

  private watchedInstanceIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets(BROWSER_TAG)) {
      if (!isOpen(ws)) continue;
      const a = attachmentOf(ws);
      if (a?.watchInstanceId) ids.add(a.watchInstanceId);
    }
    return ids;
  }

  private async recomputeSubscriptions(): Promise<void> {
    const watched = this.watchedInstanceIds();
    for (const agent of this.ctx.getWebSockets(AGENT_TAG)) {
      if (!isOpen(agent)) continue;
      const a = attachmentOf(agent);
      const id = a?.instanceId;
      if (!id) continue;
      jsonSend(agent, watched.has(id) ? { type: "subscribe" } : { type: "unsubscribe" });
    }
  }

  private async maybeTouch(fields?: {
    hostname?: string;
    os?: string;
    cwd?: string;
    label?: string;
  }): Promise<void> {
    const name = this.ctx.id.name;
    if (!name) return;
    const last = (await this.ctx.storage.get<number>(LAST_TOUCH_KEY)) || 0;
    if (Date.now() - last < TOUCH_EVERY_MS && !fields?.hostname) return;
    await this.ctx.storage.put(LAST_TOUCH_KEY, Date.now());
    await touchMachine(this.env.DB, name, {
      last_seen: Date.now(),
      hostname: fields?.hostname,
      os: fields?.os,
      cwd: fields?.cwd,
      label: fields?.label,
    }).catch(() => {
      /* machine row may not exist until authorize */
    });
  }

  private async onAgentMessage(ws: WebSocket, msg: { type: string; [k: string]: unknown }): Promise<void> {
    const attach = attachmentOf(ws) || { role: "agent" as const, auth: "session" as const };
    const instanceId =
      (typeof msg.instanceId === "string" && msg.instanceId) || attach.instanceId || "";

    if (msg.type === "hello") {
      const machine = msg.machine as MachineInfo | undefined;
      const pid = typeof msg.pid === "number" ? msg.pid : 0;
      if (instanceId) {
        attach.instanceId = instanceId;
        ws.serializeAttachment(attach);
      }
      if (machine && typeof machine === "object") {
        await this.ctx.storage.put("machine", machine);
        if (attach.userCode) {
          await updatePairingMeta(this.env.DB, attach.userCode, {
            hostname: machine.hostname,
            os: machine.os,
            cwd: machine.cwd,
          });
        }
        const catalog = await this.loadCatalog();
        const prev = catalog[instanceId];
        catalog[instanceId] = {
          instanceId,
          pid,
          cwd: machine.cwd,
          hostname: machine.hostname,
          label: machine.label || machine.hostname,
          grokVersion: machine.grokVersion,
          activeSessionId: prev?.activeSessionId ?? null,
          turnRunning: prev?.turnRunning ?? false,
          sessions: prev?.sessions ?? [],
        };
        await this.saveCatalog(catalog);
        await this.maybeTouch({
          hostname: machine.hostname,
          os: machine.os,
          cwd: machine.cwd,
          label: machine.label || machine.hostname,
        });
        await this.broadcastCatalog();
      }
      return;
    }

    if (msg.type === "session_catalog") {
      const catalog = await this.loadCatalog();
      const id = instanceId || Object.keys(catalog)[0] || "";
      if (!id) return;
      const prev = catalog[id] || {
        instanceId: id,
        pid: 0,
        cwd: "",
        hostname: "",
        label: "",
        grokVersion: "",
        activeSessionId: null,
        turnRunning: false,
        sessions: [],
      };
      catalog[id] = {
        ...prev,
        instanceId: id,
        cwd: typeof msg.cwd === "string" ? msg.cwd : prev.cwd,
        activeSessionId: (msg.activeSessionId as string | null) ?? prev.activeSessionId,
        turnRunning: !!msg.turnRunning,
        sessions: Array.isArray(msg.sessions) ? (msg.sessions as SessionSummary[]) : prev.sessions,
      };
      await this.saveCatalog(catalog);
      await this.broadcastCatalog();
      return;
    }

    if (msg.type === "status") {
      await this.maybeTouch();
      const watched = this.watchedInstanceIds();
      if (instanceId && watched.has(instanceId)) {
        this.broadcastBrowsers({ ...msg, instanceId });
      }
      return;
    }

    if (msg.type === "commands" || msg.type === "models") {
      this.broadcastBrowsers({ ...msg, instanceId });
      return;
    }

    const live = ["snapshot", "block_upsert", "block_remove", "subagent_upsert", "task_upsert", "permission_request", "permission_clear"];
    if (live.includes(msg.type)) {
      const watched = this.watchedInstanceIds();
      if (!instanceId || !watched.has(instanceId)) return;
      this.broadcastBrowsers({ ...msg, instanceId });
      return;
    }

    if (msg.type === "pairing_ready" || msg.type === "error" || msg.type === "pong") {
      this.broadcastBrowsers({ ...msg, instanceId });
    }
  }

  private async onBrowserMessage(
    ws: WebSocket,
    msg: { type: string; [k: string]: unknown },
    raw: string,
  ): Promise<void> {
    if (msg.type === "paired") {
      jsonSend(ws, { type: "error", message: "paired_not_allowed" });
      return;
    }

    if (msg.type === "watch") {
      const instanceId = typeof msg.instanceId === "string" ? msg.instanceId : "";
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
      const attach = attachmentOf(ws) || { role: "browser" as const, auth: "session" as const };
      attach.watchInstanceId = instanceId || undefined;
      attach.watchSessionId = sessionId || undefined;
      ws.serializeAttachment(attach);
      await this.recomputeSubscriptions();
      if (instanceId && !this.sendAgentInstance(instanceId, { type: "subscribe" })) {
        jsonSend(ws, { type: "instance_offline", instanceId });
      }
      return;
    }

    const attach = attachmentOf(ws);
    const catalog = await this.loadCatalog();
    let instanceId = attach?.watchInstanceId || (typeof msg.instanceId === "string" ? msg.instanceId : "");
    if (!instanceId && typeof msg.sessionId === "string" && msg.sessionId) {
      for (const inst of Object.values(catalog)) {
        if (inst.sessions.some((s) => s.id === msg.sessionId) || inst.activeSessionId === msg.sessionId) {
          instanceId = inst.instanceId;
          break;
        }
      }
    }
    if (!instanceId) {
      const ids = Object.keys(catalog);
      if (ids.length === 1) instanceId = ids[0];
    }

    if (!instanceId) {
      jsonSend(ws, { type: "machine_offline" });
      return;
    }
    if (!this.sendAgentInstance(instanceId, JSON.parse(raw))) {
      jsonSend(ws, { type: "instance_offline", instanceId });
    }
  }
}
