import { MachineRelay } from "./relay";
import {
  clearSessionCookieHeader,
  issueSessionCookie,
  normalizeEmail,
  readSessionUser,
  validateEmail,
  validatePassword,
} from "./auth";
import { hashPassword, randomHex, sha256Hex, verifyPassword } from "./crypto";
import {
  consumePairing,
  getMachineById,
  getMachineByTokenHash,
  getPairingByCode,
  getUserByEmail,
  insertUser,
  listMachinesByUser,
  pairingExpiresAt,
  upsertMachine,
  upsertPairing,
  type PairingRow,
} from "./db";
import { isUserCode, normalizeUserCode } from "./protocol";

export { MachineRelay };

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function errorJson(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, { status });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await request.json().catch(() => null);
    if (data && typeof data === "object") return data as Record<string, unknown>;
    return {};
  }
  const text = await request.text();
  if (!text) return {};
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    /* form */
  }
  const params = new URLSearchParams(text);
  const out: Record<string, unknown> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function wantUpgrade(request: Request): boolean {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

function machinePublic(row: {
  id: string;
  hostname: string;
  os: string;
  cwd: string | null;
  label: string | null;
  last_seen: number | null;
  created_at: number;
}) {
  return {
    id: row.id,
    hostname: row.hostname,
    os: row.os,
    cwd: row.cwd,
    label: row.label || row.hostname,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

function pairingPublic(row: PairingRow) {
  const now = Date.now();
  return {
    userCode: row.user_code,
    pairingId: row.pairing_id,
    machineId: row.machine_id,
    hostname: row.hostname,
    os: row.os,
    cwd: row.cwd,
    expiresAt: row.expires_at,
    consumed: !!row.consumed,
    expired: row.expires_at < now,
  };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");
  const emailErr = validateEmail(email);
  if (emailErr) return errorJson(400, emailErr);
  const pwErr = validatePassword(password);
  if (pwErr) return errorJson(400, pwErr);

  const existing = await getUserByEmail(env.DB, email);
  if (existing) return errorJson(409, "该邮箱已注册");

  const id = crypto.randomUUID();
  const password_hash = await hashPassword(password);
  try {
    await insertUser(env.DB, { id, email, password_hash, created_at: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("unique")) return errorJson(409, "该邮箱已注册");
    return errorJson(500, "注册失败");
  }
  const cookie = await issueSessionCookie(env, request, id);
  return json(
    { id, email },
    { status: 201, headers: { "Set-Cookie": cookie } },
  );
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");
  if (!email || !password) return errorJson(400, "请输入邮箱和密码");

  const user = await getUserByEmail(env.DB, email);
  const dummy =
    "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, user?.password_hash || dummy);
  if (!user || !ok) return errorJson(401, "邮箱或密码不正确");

  const cookie = await issueSessionCookie(env, request, user.id);
  return json({ id: user.id, email: user.email }, { headers: { "Set-Cookie": cookie } });
}

async function handleLogout(request: Request): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookieHeader(request) } });
}

async function handleMe(env: Env, request: Request): Promise<Response> {
  const user = await readSessionUser(env, request);
  if (!user) return errorJson(401, "未登录");
  return json({ id: user.id, email: user.email });
}

async function handleMachines(env: Env, request: Request): Promise<Response> {
  const user = await readSessionUser(env, request);
  if (!user) return errorJson(401, "未登录");
  const rows = await listMachinesByUser(env.DB, user.id);
  return json({ machines: rows.map(machinePublic) });
}

async function handlePairStatus(env: Env, request: Request, url: URL): Promise<Response> {
  const user = await readSessionUser(env, request);
  if (!user) return errorJson(401, "未登录");
  const code = normalizeUserCode(url.searchParams.get("code") || "");
  if (!isUserCode(code)) return errorJson(400, "无效的配对码");
  const row = await getPairingByCode(env.DB, code);
  if (!row) return errorJson(404, "未找到配对请求");
  return json(pairingPublic(row));
}

async function handlePairAuthorize(env: Env, request: Request): Promise<Response> {
  const user = await readSessionUser(env, request);
  if (!user) return errorJson(401, "未登录");
  const body = await readBody(request);
  const code = normalizeUserCode(String(body.userCode ?? body.code ?? ""));
  if (!isUserCode(code)) return errorJson(400, "无效的配对码");

  const pairing = await getPairingByCode(env.DB, code);
  if (!pairing) return errorJson(404, "未找到配对请求，请确认本机 Grok TUI 仍在运行");
  if (pairing.consumed) return errorJson(409, "该配对码已使用");
  if (pairing.expires_at < Date.now()) return errorJson(410, "配对码已过期，请在 TUI 重新输入 /grokcraft");

  const machineId = pairing.machine_id;
  const machineToken = randomHex(32);
  const token_hash = await sha256Hex(machineToken);
  const now = Date.now();
  const hostname = pairing.hostname || "unknown";
  const os = pairing.os || "unknown";
  const cwd = pairing.cwd;
  const label = hostname;

  await upsertMachine(env.DB, {
    id: machineId,
    user_id: user.id,
    hostname,
    os,
    cwd,
    label,
    token_hash,
    last_seen: now,
    created_at: now,
  });

  const stub = env.MACHINE_RELAY.getByName(machineId);
  const notified = await stub.notifyPaired({ machineToken, userId: user.id, machineId });
  if (!notified.ok) {
    return errorJson(409, "电脑已离线，请保持 Grok TUI 运行后重试");
  }
  await consumePairing(env.DB, code);

  return json({
    machineId,
    hostname,
    os,
    cwd,
    label,
  });
}

async function handleAgentWs(env: Env, request: Request, url: URL): Promise<Response> {
  if (!wantUpgrade(request)) {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const machineToken = url.searchParams.get("machineToken") || "";
  const pairingId = url.searchParams.get("pairingId") || "";
  const userCodeRaw = url.searchParams.get("userCode") || "";
  const machineIdParam = url.searchParams.get("machineId") || "";

  if (machineToken) {
    const token_hash = await sha256Hex(machineToken);
    const machine = await getMachineByTokenHash(env.DB, token_hash);
    if (!machine) return new Response("invalid machine token", { status: 401 });
    const stub = env.MACHINE_RELAY.getByName(machine.id);
    const headers = new Headers(request.headers);
    headers.set("X-Grokcraft-Role", "agent");
    headers.set("X-Grokcraft-Auth", "token");
    headers.set("X-Grokcraft-User-Id", machine.user_id);
    return stub.fetch(new Request(request, { headers }));
  }

  const userCode = normalizeUserCode(userCodeRaw);
  if (!pairingId || !isUserCode(userCode)) {
    return new Response("pairingId and userCode required", { status: 400 });
  }

  const machineId = machineIdParam || pairingId;
  await upsertPairing(env.DB, {
    user_code: userCode,
    pairing_id: pairingId,
    machine_id: machineId,
    expires_at: pairingExpiresAt(),
  });

  const stub = env.MACHINE_RELAY.getByName(machineId);
  const headers = new Headers(request.headers);
  headers.set("X-Grokcraft-Role", "agent");
  headers.set("X-Grokcraft-Auth", "pairing");
  headers.set("X-Grokcraft-Pairing-Id", pairingId);
  headers.set("X-Grokcraft-User-Code", userCode);
  return stub.fetch(new Request(request, { headers }));
}

async function handleBrowserWs(env: Env, request: Request, url: URL): Promise<Response> {
  if (!wantUpgrade(request)) {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }
  const user = await readSessionUser(env, request);
  if (!user) return new Response("unauthorized", { status: 401 });
  const machineId = url.searchParams.get("machineId") || "";
  if (!machineId) return new Response("machineId required", { status: 400 });
  const machine = await getMachineById(env.DB, machineId);
  if (!machine || machine.user_id !== user.id) {
    return new Response("forbidden", { status: 403 });
  }
  const stub = env.MACHINE_RELAY.getByName(machine.id);
  const headers = new Headers(request.headers);
  headers.set("X-Grokcraft-Role", "browser");
  headers.set("X-Grokcraft-Auth", "session");
  headers.set("X-Grokcraft-User-Id", user.id);
  return stub.fetch(new Request(request, { headers }));
}

async function serveAsset(env: Env, request: Request, assetPath: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = assetPath;
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

async function handleApp(env: Env, request: Request): Promise<Response> {
  const user = await readSessionUser(env, request);
  if (!user) {
    const next = encodeURIComponent("/app" + new URL(request.url).search);
    return Response.redirect(new URL(`/login?next=${next}`, request.url).toString(), 302);
  }
  return serveAsset(env, request, "/app.html");
}

async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "POST" && path === "/api/register") return handleRegister(request, env);
  if (method === "POST" && path === "/api/login") return handleLogin(request, env);
  if (method === "POST" && path === "/api/logout") return handleLogout(request);
  if (method === "GET" && path === "/api/me") return handleMe(env, request);
  if (method === "GET" && path === "/api/machines") return handleMachines(env, request);
  if (method === "GET" && path === "/api/pair/status") return handlePairStatus(env, request, url);
  if (method === "POST" && path === "/api/pair/authorize") return handlePairAuthorize(env, request);

  return errorJson(404, "not_found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/api/")) return await handleApi(env, request, url);
      if (path === "/agent/ws") return await handleAgentWs(env, request, url);
      if (path === "/browser/ws") return await handleBrowserWs(env, request, url);
      if (path === "/app" || path.startsWith("/app/")) return await handleApp(env, request);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      console.error("fetch error", message);
      if (path.startsWith("/api/")) return errorJson(500, "服务器错误");
      return new Response("Internal Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
