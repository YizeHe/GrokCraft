import { COOKIE_NAME, SESSION_TTL_MS } from "./protocol";
import { b64urlToBytes, bytesToB64url, hmacSha256B64url, timingSafeEqual } from "./crypto";
import { getUserById, type UserRow } from "./db";

export type SessionPayload = { userId: string; exp: number };

function isHttps(request: Request): boolean {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  return proto === "https";
}

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256B64url(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256B64url(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(body));
    const payload = JSON.parse(json) as SessionPayload;
    if (!payload || typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
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
  const token = getCookie(request, COOKIE_NAME);
  if (!token || !env.AUTH_SECRET) return null;
  const payload = await verifySession(env.AUTH_SECRET, token);
  if (!payload) return null;
  return getUserById(env.DB, payload.userId);
}

export async function issueSessionCookie(
  env: Env,
  request: Request,
  userId: string,
): Promise<string> {
  const exp = Math.floor((Date.now() + SESSION_TTL_MS) / 1000);
  const token = await signSession(env.AUTH_SECRET, { userId, exp });
  return sessionCookieHeader(token, request);
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
