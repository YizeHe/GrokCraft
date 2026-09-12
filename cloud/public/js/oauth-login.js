import { api, qs } from "./api.js";

const code = (qs("code") || "").trim().toUpperCase();
const errEl = document.getElementById("err");
const waitEl = document.getElementById("wait");
const metaEl = document.getElementById("meta");
const btn = document.getElementById("authorize");

function setMeta(row) {
  document.getElementById("hostname").textContent = row.hostname || "—";
  document.getElementById("os").textContent = row.os || "—";
  document.getElementById("cwd").textContent = row.cwd || "—";
  if (row.hostname || row.os || row.cwd) {
    metaEl.hidden = false;
    waitEl.textContent = "确认是你正在使用的这台电脑后授权。";
  }
}

async function ensureSession() {
  try {
    await api("/api/me");
  } catch (err) {
    if (err.status === 401) {
      const next = `/oauth-login?code=${encodeURIComponent(code)}`;
      location.href = `/login?next=${encodeURIComponent(next)}`;
      return false;
    }
    throw err;
  }
  return true;
}

async function loadStatus() {
  return api(`/api/pair/status?code=${encodeURIComponent(code)}`);
}

async function main() {
  if (!code) {
    errEl.textContent = "缺少配对码。请从 Grok TUI 的 /grokcraft 打开此页。";
    return;
  }
  const ok = await ensureSession();
  if (!ok) return;

  let row;
  try {
    row = await loadStatus();
  } catch (err) {
    errEl.textContent = err.message || "找不到配对请求";
    return;
  }
  setMeta(row);
  if (row.expired) {
    errEl.textContent = "配对码已过期，请在 TUI 重新输入 /grokcraft。";
    return;
  }
  if (row.consumed) {
    waitEl.textContent = "这台电脑已经授权。";
    btn.disabled = false;
    btn.textContent = "打开会话";
    btn.addEventListener("click", () => {
      location.href = `/app?machineId=${encodeURIComponent(row.machineId)}`;
    });
    return;
  }

  btn.disabled = false;

  if (!row.hostname) {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 45_000) {
        clearInterval(timer);
        return;
      }
      try {
        const next = await loadStatus();
        setMeta(next);
        if (next.hostname) clearInterval(timer);
      } catch {
        /* keep waiting */
      }
    }, 1000);
  }

  btn.addEventListener("click", async () => {
    errEl.textContent = "";
    btn.disabled = true;
    try {
      const res = await api("/api/pair/authorize", {
        method: "POST",
        body: { userCode: code },
      });
      location.href = `/app?machineId=${encodeURIComponent(res.machineId)}`;
    } catch (err) {
      errEl.textContent = err.message || "授权失败";
      btn.disabled = false;
    }
  });
}

main();
