const INSTALL_CMD = "irm https://grokcraft.tanyuntech.cn/install.ps1 | iex";

const DONATE = [
  { name: "BTC", value: "bc1pdat29sz3jsgl9xl7gm32d75mvnzze9fnc5v3879ke2hxmwg60k0sjdht33" },
  { name: "ETH 及兼容链", value: "0xa62936fdffae590971e60c09c2a40eb9b31c7546" },
  { name: "Solana", value: "CNURnaQcTjcuMxd2c5Ukowy8SxsGrBEvc1PJu86yyKaJ" },
  { name: "TRON", value: "THQ4maci9Z3LJoyuvFLMEUqpnQoHSH3uYy" },
  { name: "DOGE", value: "DEgr17bFcxJKE3bifXCaKZjkSoabgkxpbS" },
  { name: "Monero", value: "43uYWSAmXB9LBvMd3dPgAR5Us6hSP6FcEeteRv1uLjVTiVkTaZ5L79y5AaHmykukiFEZKNs9EpVPT85MK4e1yM3wLXwn9Xi" },
];

function ensureOverlay() {
  let el = document.getElementById("site-overlay");
  if (el) return el;
  el = document.createElement("div");
  el.id = "site-overlay";
  el.className = "overlay";
  el.hidden = true;
  el.innerHTML = `<div class="picker" id="site-overlay-card"></div>`;
  el.addEventListener("click", (e) => {
    if (e.target === el) el.hidden = true;
  });
  document.body.append(el);
  return el;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } finally {
      ta.remove();
    }
  }
}

function showDownload() {
  const overlay = ensureOverlay();
  const card = document.getElementById("site-overlay-card");
  card.innerHTML = `
    <h2>Download</h2>
    <p>必须先安装 Grok Build。本命令只安装 Grokcraft 启动器，<b>不会替换</b>已有 Grok Build，也不会改它的任何设置或环境变量。</p>
    <p>复制后在 PowerShell 运行：</p>
    <pre class="install-cmd"></pre>
    <p class="hint">装好后用 <code>gcagent</code>（或 <code>&amp; $env:gcagent</code>）启动 Grokcraft。</p>
    <button class="btn block" type="button" id="copy-install">复制命令</button>
  `;
  card.querySelector(".install-cmd").textContent = INSTALL_CMD;
  card.querySelector("#copy-install").addEventListener("click", async () => {
    const ok = await copyText(INSTALL_CMD);
    card.querySelector("#copy-install").textContent = ok ? "已复制" : "复制失败";
  });
  overlay.hidden = false;
}

function showDonate() {
  const overlay = ensureOverlay();
  const card = document.getElementById("site-overlay-card");
  card.innerHTML = `<h2>Donate</h2><p>点击地址即可复制。</p><div class="donate-list"></div>`;
  const list = card.querySelector(".donate-list");
  for (const row of DONATE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "donate-row";
    b.innerHTML = `<span class="k"></span><span class="v"></span>`;
    b.querySelector(".k").textContent = row.name;
    b.querySelector(".v").textContent = row.value;
    b.addEventListener("click", async () => {
      const ok = await copyText(row.value);
      b.querySelector(".k").textContent = ok ? `${row.name} · 已复制` : row.name;
      setTimeout(() => {
        b.querySelector(".k").textContent = row.name;
      }, 1200);
    });
    list.append(b);
  }
  overlay.hidden = false;
}

document.getElementById("nav-download")?.addEventListener("click", (e) => {
  e.preventDefault();
  showDownload();
});
document.getElementById("nav-donate")?.addEventListener("click", (e) => {
  e.preventDefault();
  showDonate();
});
