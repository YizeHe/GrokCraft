# Grokcraft errors

- `npx wrangler` / bare `npm` on this Windows host can exit 0 with no output. Use `npx.cmd wrangler` and `npm.cmd`.
- Chrome port 6000 is ERR_UNSAFE_PORT; local HTTP uses 6001/8080.
- Windows MSVC default stack is 1 MiB. Debug `xai-grok-pager` dies with `thread 'main' has overflowed its stack`. `main()` re-enters on a 16 MiB thread after mermaid/voice subprocess checks.
- Two `/grokcraft` CLIs stole each other because `MachineRelay` closed every other `agent` socket with 4002 `replaced`. Fix: tag `agent:<instanceId>`, replace only the same process reconnecting; persist a session catalog; browsers `watch` one instance. On reconnect, do not delete the catalog row if a replacement socket for that `instanceId` is already open.
- `GET /app` used to 307 to `/app.html` which 307s back to `/app` (`ERR_TOO_MANY_REDIRECTS`). Serve ASSETS `/app` with `redirect:manual` and `not_found_handling: 404-page`.
