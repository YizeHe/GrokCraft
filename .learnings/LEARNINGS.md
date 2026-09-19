# Grokcraft learnings

- Grok Build TUI is `xai-grok-pager`; slash builtins live in `slash/commands/` and must also be listed in `xai-grok-shell` `PAGER_COMMAND_KEYS`.
- Pairing tokens go in `$GROK_HOME/grokcraft.json`, never `auth.json`.
- TUI-safe URL open is `Action::OpenUrl` → `open_url_or_show` / `link_opener`, not `webbrowser` from the pager thread.
- WebUI mirrors ACP/scrollback events from the **same** pager process (outbound WS to Cloudflare Durable Object). Do not spawn a second agent.
- Wrangler on this machine: `npx.cmd wrangler` (never bare `npx` / `npm`). Logged-in account is `tangent2533@gmail.com`.
- Rust toolchain lives at `D:\rustup` + `D:\cargo` (`RUSTUP_HOME` / `CARGO_HOME`).
- Windows grok-build builds need `PROTOC=D:\grokbuild\grokcraft\grok-build\target\protoc-win\bin\protoc.exe` (extracted by the first cargo run). `xai-proto-build` skips `/dev/stdout` depfiles on Windows.
- Debug TUI binary: `grok-build\target\debug\xai-grok-pager.exe`. `/grokcraft` pairs with https://grokcraft.tanyuntech.cn.
- One machine token, many TUI **instanceId** sockets. DO must not close sibling agents. Catalog is cheap; snapshots only for the watched instance. Clients send the text `"ping"` ~50s; DO `setWebSocketAutoResponse("ping","pong")` answers at the edge (no isolate wake, no D1). D1 `last_seen` ≤ 5 min. On agent close, drop that instance from the catalog only if no replacement socket for the same `instanceId` is already open.
- Login/register Turnstile widget `grokcraft-auth` (managed). Sitekey is public in HTML + `TURNSTILE_SITE_KEY` var. Secret is Worker secret `TURNSTILE_SECRET_KEY`; verify in `/api/login` and `/api/register` against `challenges.cloudflare.com/turnstile/v0/siteverify` (never from the browser). CSP on those pages must allow `challenges.cloudflare.com` script/frame/connect.
- `RenderBlock::SessionEvent` must copy `event.message()` into TranscriptBlock content. Empty content + 3px accent = leftover gray bars; "Worked for …" is a session event.
- Web workbench should follow grok-app: user bubbles, no accent rails on chat, floating rounded composer, slash palette on `/`. Commands/models frames from the TUI feed the picker; `/model Name` is sent as a normal prompt.
- `a { color: var(--accent) }` beats `.btn { color }`, so `a.btn` text vanished on the accent fill. Submit `<button class="btn block">` also stacked CJK because `inline-flex` + percentage width inside a shrink-to-fit flex card. Use `a.btn, button.btn` with `flex-direction: row`, `white-space: nowrap`, and `.auth-card { align-items: stretch }`.
- Official grok-build remote is fetch-only (`origin` = xai-org/grok-build). Never push that remote. Grokcraft lives on nested branch `grokcraft`. Latest merged official main at this writing: `a28ee2b2`.
- Web `/usage` must send TUI-parity tabs, not a stub pointing at the local overlay. TUI `/usage` opens the **Usage limit** tab; `/context` and `/session-info` open the other two. Wire: `AgentToCloud::Usage { text, context, limit, session }`. Re-emit after billing/context/session-info fetches land so the open web modal updates in place.
- Login lockout is D1 `login_lockouts` keyed by normalized email (Asia/Shanghai calendar day). 3 consecutive fails → 10 min cooldown (streak does not reset on cooldown). 10 consecutive fails that day → no more tries until tomorrow. Success deletes the row. Locked attempts do not increment. Turnstile still runs first.
- Web session is an HS256 JWT in HttpOnly `gc_session` plus `localStorage.gc_jwt`. Login/register/`/api/me` return `token`; `api.js` sends Bearer. Clicking 登录 with a live session goes to `/app` (Worker cookie redirect and client auto-resume). Logout must clear both cookie and `gc_jwt`.
