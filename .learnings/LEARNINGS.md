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
