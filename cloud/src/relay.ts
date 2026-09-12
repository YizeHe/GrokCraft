import { DurableObject } from "cloudflare:workers";
import { touchMachine, updatePairingMeta } from "./db";
import type { MachineInfo, WsAttachment } from "./protocol";

const AGENT_TAG = "agent";
const BROWSER_TAG = "browser";

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

export class MachineRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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

    const attach: WsAttachment = {
      role,
      auth: (request.headers.get("X-Grokcraft-Auth") as WsAttachment["auth"]) || "session",
      userId: request.headers.get("X-Grokcraft-User-Id") || undefined,
      pairingId: request.headers.get("X-Grokcraft-Pairing-Id") || undefined,
      userCode: request.headers.get("X-Grokcraft-User-Code") || undefined,
    };

    if (role === "agent") {
      for (const old of this.ctx.getWebSockets(AGENT_TAG)) {
        try {
          old.close(4002, "replaced");
        } catch {
          /* ignore */
        }
      }
    }

    const hadBrowsers = this.ctx.getWebSockets(BROWSER_TAG).some(isOpen);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(attach);

    if (role === "agent") {
      this.broadcastBrowsers({ type: "machine_online" });
      if (hadBrowsers) this.sendAgent({ type: "subscribe" });
    } else {
      const agent = this.agentSocket();
      if (agent) this.sendAgent({ type: "subscribe" });
      else jsonSend(server, { type: "machine_offline" });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async notifyPaired(payload: {
    machineToken: string;
    userId: string;
    machineId: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const agent = this.agentSocket();
    if (!agent) return { ok: false, reason: "agent_offline" };
    jsonSend(agent, {
      type: "paired",
      machineToken: payload.machineToken,
      userId: payload.userId,
      machineId: payload.machineId,
    });
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
      this.onBrowserMessage(ws, msg, message);
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
      this.broadcastBrowsers({ type: "machine_offline" });
      return;
    }
    if (attach?.role === "browser") {
      const browsers = this.ctx.getWebSockets(BROWSER_TAG).filter((s) => s !== ws && isOpen(s));
      if (browsers.length === 0) this.sendAgent({ type: "unsubscribe" });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  private agentSocket(): WebSocket | null {
    const list = this.ctx.getWebSockets(AGENT_TAG).filter(isOpen);
    return list.length ? list[list.length - 1] : null;
  }

  private sendAgent(data: unknown): void {
    const agent = this.agentSocket();
    if (agent) jsonSend(agent, data);
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

  private async onAgentMessage(ws: WebSocket, msg: { type: string; [k: string]: unknown }): Promise<void> {
    const attach = attachmentOf(ws);

    if (msg.type === "hello") {
      const machine = msg.machine as MachineInfo | undefined;
      if (machine && typeof machine === "object") {
        await this.ctx.storage.put("machine", machine);
        if (attach?.userCode) {
          // Do not rewrite pairings.machine_id here: it is the Durable Object
          // name chosen at connect time. Changing it would strand the agent WS.
          await updatePairingMeta(this.env.DB, attach.userCode, {
            hostname: machine.hostname,
            os: machine.os,
            cwd: machine.cwd,
          });
        }
        const name = this.ctx.id.name;
        if (name) {
          await touchMachine(this.env.DB, name, {
            hostname: machine.hostname,
            os: machine.os,
            cwd: machine.cwd,
            label: machine.label || machine.hostname,
            last_seen: Date.now(),
          }).catch(() => {
            /* machine row may not exist until authorize */
          });
        }
      }
    }

    if (msg.type === "status" || msg.type === "hello") {
      const name = this.ctx.id.name;
      if (name) {
        await touchMachine(this.env.DB, name, { last_seen: Date.now() }).catch(() => {
          /* ignore */
        });
      }
    }

    this.broadcastBrowsers(msg);
  }

  private onBrowserMessage(
    ws: WebSocket,
    msg: { type: string; [k: string]: unknown },
    raw: string,
  ): void {
    if (msg.type === "paired") {
      jsonSend(ws, { type: "error", message: "paired_not_allowed" });
      return;
    }

    const agent = this.agentSocket();
    if (!agent) {
      jsonSend(ws, { type: "machine_offline" });
      return;
    }
    try {
      agent.send(raw);
    } catch {
      jsonSend(ws, { type: "machine_offline" });
    }
  }
}
