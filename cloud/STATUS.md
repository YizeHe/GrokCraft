# Grokcraft cloud status

Deployed 2026-09-18 (Worker version `29d0922c-ed4f-4f17-8cab-03846181f33c`). Login/register Turnstile + visible auth buttons + terms. Previous: `e4610882-4c87-41ef-9938-b2bc9ab1869f`.

## URLs

- Custom domain: https://grokcraft.tanyuntech.cn
- workers.dev: https://grokcraft.tangent2533.workers.dev

## Resources

- Account: `e2faa83dabc3a1998c5286947eb71b0b` (tangent2533)
- D1 `grokcraft` id: `d3fd89e7-57a6-4976-829f-aa71f97c901d` (schema applied remote + local)
- Durable Object class `MachineRelay`, migration tag `v1` (`new_sqlite_classes`)
- Secret `AUTH_SECRET` set in production (also in gitignored `cloud/.dev.vars`)

## Smoke checks

- `GET /` `/login` `/register` `/oauth-login` `/css/app.css` → 200
- `GET /app` unauthenticated → 302 `/login?next=...`
- Logged-in `GET /app` must be 200 HTML (never 307 `/app.html` → `/app`)
- `GET /api/me` unauthenticated → 401
- `POST /api/register` + `/api/login` + `/api/me` + `/api/machines` → 201/200
- Custom domain route is live (`grokcraft.tanyuntech.cn`)

## Notes / remaining

- Cloudflare custom domains **cannot** use `pattern: "host/*"`. wrangler.jsonc uses `grokcraft.tanyuntech.cn` (hostname only). Same origin still serves all paths.
- Agent pairing WebSocket is accepted on `getByName(machineIdQuery || pairingId)`. That value is `pairings.machine_id` and is sent back as `paired.machineId`. The TUI should persist that id (and pass `machineId` on the pairing URL if it already has a stable uuid).
- Hibernation: `ctx.acceptWebSocket` + `setWebSocketAutoResponse("ping","pong")`. Do not use `server.accept()`.
- Grok Build TUI client (`/grokcraft`) is out of scope for this folder.
- `.dev.vars` / `.auth_secret` / `worker-configuration.d.ts` are gitignored. Do not commit them.
