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

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.textContent = "";
  const mode = form.dataset.mode;
  const email = form.email.value.trim();
  const password = form.password.value;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api(mode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: { email, password },
    });
    location.href = nextTarget();
  } catch (err) {
    errEl.textContent = err.message || "失败";
  } finally {
    btn.disabled = false;
  }
});
