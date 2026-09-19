import { COOKIE_NAME, SESSION_TTL_MS } from "./protocol";
import { b64urlToBytes, bytesToB64url, hmacSha256B64url, timingSafeEqual } from "./crypto";
import { getUserById, type UserRow } from "./db";

export type SessionPayload = { userId: string; exp: number; iat?: number; sub?: string };

const JWT_HEADER_JSON = JSON.stringify({ alg: "HS256", typ: "JWT" });

function isHttps(request: Request): boolean {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  return proto === "https";
}

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const header = bytesToB64url(new TextEncoder().encode(JWT_HEADER_JSON));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const sig = await hmacSha256B64url(secret, signingInput);
  return `${signingInput}.${sig}`;
}

function parseSessionPayload(json: string): SessionPayload | null {
  try {
    const payload = JSON.parse(json) as { userId?: unknown; sub?: unknown; exp?: unknown; iat?: unknown };
    const userId =
      typeof payload.userId === "string"
        ? payload.userId
        : typeof payload.sub === "string"
          ? payload.sub
          : "";
    if (!userId || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    const out: SessionPayload = { userId, exp: payload.exp };
    if (typeof payload.iat === "number") out.iat = payload.iat;
    return out;
  } catch {
    return null;
  }
}

export async function verifySession(secret: string, token: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length === 3) {
    const [header, body, sig] = parts;
    if (!header || !body || !sig) return null;
    const expected = await hmacSha256B64url(secret, `${header}.${body}`);
    if (!timingSafeEqual(sig, expected)) return null;
    return parseSessionPayload(new TextDecoder().decode(b64urlToBytes(body)));
  }
  if (parts.length === 2) {
    const [body, sig] = parts;
    if (!body || !sig) return null;
    const expected = await hmacSha256B64url(secret, body);
    if (!timingSafeEqual(sig, expected)) return null;
    return parseSessionPayload(new TextDecoder().decode(b64urlToBytes(body)));
  }
  return null;
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m?.[1] || null;
}

export function sessionTokenFromRequest(request: Request): string | null {
  const cookie = getCookie(request, COOKIE_NAME);
  if (cookie) return cookie;
  const bearer = readBearerToken(request);
  if (bearer) return bearer;
  try {
    const q = new URL(request.url).searchParams.get("access_token");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return null;
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(token: string, request: Request, maxAgeSec = SESSION_TTL_MS / 1000): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSec)}`,
  ];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(request: Request): string {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

export async function readSessionUser(env: Env, request: Request): Promise<UserRow | null> {
  const token = sessionTokenFromRequest(request);
  if (!token || !env.AUTH_SECRET) return null;
  const payload = await verifySession(env.AUTH_SECRET, token);
  if (!payload) return null;
  return getUserById(env.DB, payload.userId);
}

export async function issueSession(
  env: Env,
  request: Request,
  userId: string,
): Promise<{ token: string; exp: number; cookie: string }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.floor((Date.now() + SESSION_TTL_MS) / 1000);
  const token = await signSession(env.AUTH_SECRET, { userId, sub: userId, exp, iat });
  return { token, exp, cookie: sessionCookieHeader(token, request) };
}

export async function issueSessionCookie(
  env: Env,
  request: Request,
  userId: string,
): Promise<string> {
  const issued = await issueSession(env, request, userId);
  return issued.cookie;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateEmail(email: string): string | null {
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return "请输入有效邮箱";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "密码至少 8 位";
  if (password.length > 200) return "密码过长";
  return null;
}
