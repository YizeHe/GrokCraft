export const JWT_KEY = "gc_jwt";

export function getJwt() {
  try {
    return localStorage.getItem(JWT_KEY) || "";
  } catch {
    return "";
  }
}

export function setJwt(token) {
  if (!token) return;
  try {
    localStorage.setItem(JWT_KEY, token);
  } catch {
    /* private mode */
  }
}

export function clearJwt() {
  try {
    localStorage.removeItem(JWT_KEY);
  } catch {
    /* ignore */
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  const opts = { method, headers, credentials: "same-origin" };
  const token = getJwt();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (typeof data.token === "string" && data.token) setJwt(data.token);
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login" && path !== "/api/register") clearJwt();
    const err = new Error(data.error || res.statusText || "请求失败");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function sessionUser() {
  try {
    const me = await api("/api/me");
    return me && me.id ? me : null;
  } catch {
    return null;
  }
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function nextTarget() {
  const n = qs("next");
  if (!n) return "/app";
  if (!n.startsWith("/") || n.startsWith("//")) return "/app";
  return n;
}
