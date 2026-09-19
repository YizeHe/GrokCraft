import { api, nextTarget, qs } from "./api.js";

const form = document.getElementById("form");
const errEl = document.getElementById("err");

function nextHref() {
  const n = qs("next");
  const login = "/login" + (n ? `?next=${encodeURIComponent(n)}` : "");
  const register = "/register" + (n ? `?next=${encodeURIComponent(n)}` : "");
  for (const a of document.querySelectorAll('a[href="/login"]')) a.setAttribute("href", login);
  for (const a of document.querySelectorAll('a[href="/register"]')) a.setAttribute("href", register);
}

nextHref();

function turnstileValue(root) {
  const input = root.querySelector('input[name="cf-turnstile-response"]');
  return (input && input.value) || "";
}

function resetTurnstile(root) {
  const slot = root.querySelector(".cf-turnstile");
  if (slot && window.turnstile) {
    try {
      window.turnstile.reset(slot);
    } catch {
      /* ignore */
    }
  }
}

let lockTimer = null;

function clearLockTimer() {
  if (lockTimer) {
    clearInterval(lockTimer);
    lockTimer = null;
  }
}

function setFormLocked(on) {
  if (!form) return;
  if (on) form.dataset.locked = "1";
  else delete form.dataset.locked;
}

function submitBtn() {
  return form?.querySelector('button[type="submit"]');
}

function startCooldown(retryAfterSec) {
  const btn = submitBtn();
  let left = Math.max(1, Math.floor(Number(retryAfterSec) || 0));
  setFormLocked(true);
  if (btn) btn.disabled = true;
  const tick = () => {
    if (left <= 0) {
      clearLockTimer();
      setFormLocked(false);
      if (btn && !form?.dataset.submitting) btn.disabled = false;
      if (errEl) errEl.textContent = "";
      return;
    }
    const mins = Math.floor(left / 60);
    const secs = left % 60;
    const wait = mins > 0 ? `${mins} 分 ${String(secs).padStart(2, "0")} 秒` : `${secs} 秒`;
    if (errEl) errEl.textContent = `连续输错 3 次，请 ${wait}后再试`;
    left -= 1;
  };
  clearLockTimer();
  tick();
  lockTimer = setInterval(tick, 1000);
}

form?.email?.addEventListener("input", () => {
  if (!form.dataset.locked) return;
  clearLockTimer();
  setFormLocked(false);
  const btn = submitBtn();
  if (btn && !form.dataset.submitting) btn.disabled = false;
});

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (form.dataset.locked === "1") return;
  errEl.textContent = "";
  const mode = form.dataset.mode;
  const email = form.email.value.trim();
  const password = form.password.value;
  const cfTurnstileResponse = turnstileValue(form);
  if (!cfTurnstileResponse) {
    errEl.textContent = "请完成人机验证";
    return;
  }
  const btn = submitBtn();
  btn.disabled = true;
  form.dataset.submitting = "1";
  try {
    await api(mode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: { email, password, cfTurnstileResponse },
    });
    location.href = nextTarget();
  } catch (err) {
    const data = err.data || {};
    errEl.textContent = err.message || "失败";
    resetTurnstile(form);
    if (mode === "login" && data.lock === "cooldown" && data.retryAfterSec) {
      startCooldown(data.retryAfterSec);
    } else if (mode === "login" && data.lock === "day") {
      setFormLocked(true);
      const lockBtn = submitBtn();
      if (lockBtn) lockBtn.disabled = true;
    }
  } finally {
    delete form.dataset.submitting;
    if (form.dataset.locked !== "1") btn.disabled = false;
  }
});
