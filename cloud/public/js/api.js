export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  const opts = { method, headers, credentials: "same-origin" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "请求失败");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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
