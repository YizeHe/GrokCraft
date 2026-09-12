# Grokcraft protocol

Grok Build TUI stays as the local control plane. A Cloudflare Worker at
`https://grokcraft.tanyuntech.cn` is the public relay. The local pager opens an
**outbound** WebSocket to the Worker (no inbound ports). A browser on any
machine talks to the same Worker and drives the same live session.

Default origin: `https://grokcraft.tanyuntech.cn`
Override: env `GROKCRAFT_URL` (no trailing slash).

## User flow

1. Register an account at `/register` (email + password).
2. In the Grok TUI, type `/grokcraft`.
3. The TUI starts (or reuses) the agent WebSocket and opens the system browser
   to `/oauth-login?code=<USER_CODE>`.
4. The user signs in (if needed) and clicks **Authorize this computer**.
5. The Worker binds the machine to the account and sends `paired` to the agent.
6. The agent stores `$GROK_HOME/grokcraft.json` (never `auth.json`).
7. Later TUI launches auto-reconnect with `machineToken`. `/grokcraft` again
   shows status and re-opens the Web UI.
8. At `/app` the user picks a machine and chats. TUI and WebUI stay in sync.

The computer must stay on **and** the grok TUI process must keep running.

## HTTP routes (Worker)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | public | Marketing / sign-in landing |
| GET | `/register` | public | Create account |
| GET | `/login` | public | Sign in |
| GET | `/oauth-login` | public, then session | Pairing authorize page |
| GET | `/app` | session cookie | WebUI |
| GET | `/app/*` | session cookie | SPA |
| POST | `/api/register` | public | `{email,password}` |
| POST | `/api/login` | public | `{email,password}` → Set-Cookie |
| POST | `/api/logout` | session | clear cookie |
| GET | `/api/me` | session | `{id,email}` |
| GET | `/api/machines` | session | list bound machines |
| POST | `/api/pair/authorize` | session | `{userCode}` bind machine |
| GET | `/api/pair/status?code=` | session | pending pairing metadata |
| GET | `/agent/ws` | pairing or machine token | agent WebSocket |
| GET | `/browser/ws?machineId=` | session cookie | browser WebSocket |

Static assets under `public/` (HTML/CSS/JS). Worker runs first for `/api/*`,
`/agent/*`, `/browser/*`, `/oauth-login` (can be static with JS), `/register`,
`/login`, `/app`.

Cookie: `gc_session` HttpOnly Secure SameSite=Lax, HMAC-signed payload
`{userId, exp}` using `AUTH_SECRET`. 30 day expiry.

Passwords: PBKDF2-SHA256, 100_000 iterations, 16-byte random salt, stored as
`pbkdf2$100000$<salt_b64>$<hash_b64>`.

## WebSocket: agent

URL: `wss://grokcraft.tanyuntech.cn/agent/ws`

Query:

- First pairing: `?role=agent&pairingId=<uuid>&userCode=<8chars>`
- Reconnect: `?role=agent&machineToken=<token>`

All frames are JSON text. Max ~900KB; truncate tool bodies, send full on
`request_block`.

### Agent → relay (`AgentToCloud`)

```jsonc
// First frame after connect
{ "type": "hello", "machine": {
    "id": "uuid",            // stable, from grokcraft.json
    "hostname": "string",
    "os": "windows|macos|linux",
    "cwd": "string",
    "grokVersion": "string",
    "label": "string"        // hostname by default
}}

{ "type": "pairing_ready", "pairingId": "uuid", "userCode": "ABCD2345" }

{ "type": "status",
  "online": true,
  "cwd": "string",
  "model": "string|null",
  "sessionId": "string|null",
  "turnRunning": false,
  "connectedBrowsers": 0 }

{ "type": "snapshot",
  "sessions": [ /* SessionSummary */ ],
  "activeSessionId": "string|null",
  "blocks": [ /* TranscriptBlock */ ],
  "subagents": [ /* SubagentInfo */ ],
  "tasks": [ /* TaskInfo */ ],
  "permission": /* PermissionRequest | null */ }

{ "type": "block_upsert", "block": { /* TranscriptBlock */ } }
{ "type": "block_remove", "sessionId": "s", "id": "entry-id" }
{ "type": "subagent_upsert", "subagent": { /* SubagentInfo */ } }
{ "type": "task_upsert", "task": { /* TaskInfo */ } }
{ "type": "permission_request", "request": { /* PermissionRequest */ } }
{ "type": "permission_clear", "requestId": "string" }
{ "type": "pong", "ts": 0 }
{ "type": "error", "message": "string" }
```

### Relay → agent (`CloudToAgent`)

```jsonc
{ "type": "paired", "machineToken": "string", "userId": "string", "machineId": "string" }
{ "type": "subscribe" }          // browser joined; agent MUST send snapshot
{ "type": "unsubscribe" }
{ "type": "prompt", "sessionId": "string|null", "text": "string", "promptId": "uuid" }
{ "type": "cancel", "sessionId": "string|null" }
{ "type": "set_fold", "sessionId": "string", "blockId": "string", "displayMode": "collapsed|truncated|expanded" }
{ "type": "open_subagent", "childSessionId": "string" }
{ "type": "close_subagent" }
{ "type": "permission_response", "requestId": "string", "optionId": "string" }
{ "type": "request_block", "sessionId": "string", "blockId": "string" }
{ "type": "ping", "ts": 0 }
```

On `paired`, persist `machineToken` + `machineId` in grokcraft.json.

On `prompt`, the pager injects the text through the same `Action::SendPrompt`
path as the TUI composer (slash commands work).

On `set_fold`, pin `display_mode` on the matching scrollback entry
(`display_mode_pinned = true`).

On `open_subagent`, switch the WebUI's focused session to the child view
(agent sends a snapshot of that child's scrollback). TUI also opens the
child view when possible.

## WebSocket: browser

URL: `wss://grokcraft.tanyuntech.cn/browser/ws?machineId=<id>`
Cookie: `gc_session`.

Browser → relay: same as `CloudToAgent` except `paired` is never sent by the
browser. Plus:

```jsonc
{ "type": "prompt", "sessionId": null, "text": "string", "promptId": "uuid" }
```

Relay → browser: same as `AgentToCloud` plus:

```jsonc
{ "type": "machine_offline" }
{ "type": "machine_online" }
{ "type": "paired_ok" }   // only on oauth-login wait socket if used
```

The Durable Object tagged `agent` vs `browser` forwards:

- agent frames → all browser sockets
- browser frames → the single agent socket
- `subscribe` is injected by the DO when the first browser connects
- ping/pong via `setWebSocketAutoResponse("ping","pong")`

## TranscriptBlock (TUI parity)

```jsonc
{
  "id": "string",                 // EntryId as decimal string
  "sessionId": "string",
  "parentSessionId": "string|null",
  "kind": "user|assistant|thinking|tool|subagent|system|session_event|bg_task|workflow|btw|context|permission",
  "title": "string",
  "status": "running|done|error|cancelled|idle",
  "displayMode": "collapsed|truncated|expanded",
  "foldable": true,
  "openChildSession": false,      // true for subagent rows
  "childSessionId": "string|null",
  "toolName": "string|null",      // Read/Edit/Execute/...
  "isBackground": false,
  "content": "string",            // markdown or plain; collapsed preview may be truncated
  "detail": "string|null",        // full body when expanded / request_block
  "activityLabel": "string|null",
  "isRunning": false,
  "pinned": false
}
```

Default display modes (must match TUI):

| kind | default | on finish | foldable |
|---|---|---|---|
| thinking | truncated | collapsed | yes (3-way) |
| tool Execute | collapsed | keep / no auto-open stdout | yes |
| tool others | collapsed | keep | yes |
| user | expanded | — | no |
| assistant | expanded | — | no |
| subagent | collapsed | n/a | **false** (open child session) |
| bg_task | collapsed | — | false |
| system / session_event | expanded | — | no |

WebUI: clicking a folded block sends `set_fold` with the next mode.
Clicking a subagent row sends `open_subagent` and shows the nested
transcript (back button → parent snapshot).

## SubagentInfo

```jsonc
{
  "childSessionId": "string",
  "description": "string",
  "subagentType": "string",
  "persona": "string|null",
  "role": "string|null",
  "model": "string|null",
  "isBackground": false,
  "status": "running|completed|failed|cancelled",
  "activityLabel": "string|null",
  "error": "string|null",
  "durationMs": 0,
  "toolCalls": 0,
  "turns": 0
}
```

## SessionSummary

```jsonc
{ "id": "string", "title": "string", "cwd": "string", "isChild": false, "parentId": "string|null" }
```

## PermissionRequest

```jsonc
{
  "requestId": "string",
  "sessionId": "string",
  "title": "string",
  "detail": "string",
  "options": [{ "id": "string", "label": "string" }]
}
```

## Pairing user code

- 8 characters from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I).
- Expires in 10 minutes.
- Stored on the Durable Object keyed by `userCode` (also indexed in D1
  `pairings` so `/api/pair/status` works before the DO is woken).

## D1 schema

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  cwd TEXT,
  label TEXT,
  token_hash TEXT NOT NULL,
  last_seen INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pairings (
  user_code TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  hostname TEXT,
  os TEXT,
  cwd TEXT,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_machines_user ON machines(user_id);
```

`token_hash` is SHA-256 hex of the raw machine token. Raw token is shown
once in `paired`.

## grokcraft.json (`$GROK_HOME/grokcraft.json`)

```jsonc
{
  "machineId": "uuid",
  "machineToken": "string|null",
  "origin": "https://grokcraft.tanyuntech.cn",
  "label": "hostname"
}
```

Owner-only permissions on Unix. Atomic write.

## Durable Object

Class `MachineRelay`, SQLite, one instance per `machineId` (`getByName`).

Hibernation WebSockets: `ctx.acceptWebSocket(server)` with attachment
`{ role: "agent"|"browser" }`.

Constructor: `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`.

## WebUI rendering

Match the TUI, not a generic chatbot:

- Dark grok-like chrome, accent column on the left of each block.
- Running blocks: animated accent.
- Folded tools: one-line title (`Read path`, `Execute command`).
- Thinking: truncated while streaming, collapsed when done; chevron to expand.
- Subagents: always one-line in the parent transcript; full nested view on click.
- Left (desktop) / top (mobile) panel: machine name, session title, subagent list, tasks.
- Bottom composer: prompt + send. Enter sends, Shift+Enter newline.
- Permission card overlays the composer when `permission_request` is active.
- Do **not** put implementation notes, layout fractions, or "per the spec"
  language in user-visible copy.

## Slash command

`/grokcraft` pager builtin:

- Description: `Connect this computer to Grokcraft WebUI`
- Usage: `/grokcraft`
- Returns `Action::GrokcraftConnect`
- Register in `builtin_commands()` and `PAGER_COMMAND_KEYS` (`"grokcraft"`).
