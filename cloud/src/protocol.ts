/** Shared types matching PROTOCOL.md. JSON field names are the wire contract. */

export type OsKind = "windows" | "macos" | "linux" | string;

export type BlockKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "subagent"
  | "system"
  | "session_event"
  | "bg_task"
  | "workflow"
  | "btw"
  | "context"
  | "permission";

export type BlockStatus = "running" | "done" | "error" | "cancelled" | "idle";
export type DisplayMode = "collapsed" | "truncated" | "expanded";
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export type MachineInfo = {
  id: string;
  hostname: string;
  os: OsKind;
  cwd: string;
  grokVersion: string;
  label: string;
};

export type TranscriptBlock = {
  id: string;
  sessionId: string;
  parentSessionId: string | null;
  kind: BlockKind;
  title: string;
  status: BlockStatus;
  displayMode: DisplayMode;
  foldable: boolean;
  openChildSession: boolean;
  childSessionId: string | null;
  toolName: string | null;
  isBackground: boolean;
  content: string;
  detail: string | null;
  activityLabel: string | null;
  isRunning: boolean;
  pinned: boolean;
};

export type SubagentInfo = {
  childSessionId: string;
  description: string;
  subagentType: string;
  persona: string | null;
  role: string | null;
  model: string | null;
  isBackground: boolean;
  status: SubagentStatus;
  activityLabel: string | null;
  error: string | null;
  durationMs: number;
  toolCalls: number;
  turns: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  isChild: boolean;
  parentId: string | null;
};

export type SlashCommandInfo = {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  takesArgs: boolean;
  argsRequired: boolean;
};

export type ModelOption = {
  id: string;
  name: string;
};

export type PermissionOption = { id: string; label: string };

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  title: string;
  detail: string;
  options: PermissionOption[];
};

export type TaskInfo = {
  id: string;
  title?: string;
  label?: string;
  description?: string;
  status?: string;
  progress?: number;
  sessionId?: string;
  activityLabel?: string | null;
};

export type InstanceInfo = {
  instanceId: string;
  pid: number;
  cwd: string;
  hostname: string;
  label: string;
  grokVersion: string;
  activeSessionId: string | null;
  turnRunning: boolean;
  sessions: SessionSummary[];
};

export type AgentToCloud =
  | { type: "hello"; machine: MachineInfo; instanceId: string; pid: number }
  | {
      type: "session_catalog";
      instanceId: string;
      cwd: string;
      activeSessionId: string | null;
      turnRunning: boolean;
      sessions: SessionSummary[];
    }
  | { type: "commands"; instanceId: string; commands: SlashCommandInfo[] }
  | {
      type: "models";
      instanceId: string;
      models: ModelOption[];
      current: string | null;
      reasoningEffort: string | null;
    }
  | { type: "pairing_ready"; pairingId: string; userCode: string }
  | {
      type: "status";
      online: boolean;
      cwd: string;
      model: string | null;
      sessionId: string | null;
      turnRunning: boolean;
      connectedBrowsers: number;
    }
  | {
      type: "snapshot";
      sessions: SessionSummary[];
      activeSessionId: string | null;
      blocks: TranscriptBlock[];
      subagents: SubagentInfo[];
      tasks: TaskInfo[];
      permission: PermissionRequest | null;
    }
  | { type: "block_upsert"; block: TranscriptBlock }
  | { type: "block_remove"; sessionId: string; id: string }
  | { type: "subagent_upsert"; subagent: SubagentInfo }
  | { type: "task_upsert"; task: TaskInfo }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_clear"; requestId: string }
  | { type: "pong"; ts: number }
  | { type: "error"; message: string }
  | { type: "usage"; text: string }
  | { type: "reveal"; instanceId: string };

export type CloudToAgent =
  | { type: "paired"; machineToken: string; userId: string; machineId: string }
  | { type: "subscribe" }
  | { type: "unsubscribe" }
  | { type: "prompt"; sessionId: string | null; text: string; promptId: string }
  | { type: "cancel"; sessionId: string | null }
  | { type: "set_fold"; sessionId: string; blockId: string; displayMode: DisplayMode }
  | { type: "open_subagent"; childSessionId: string }
  | { type: "close_subagent" }
  | { type: "permission_response"; requestId: string; optionId: string }
  | { type: "request_block"; sessionId: string; blockId: string }
  | { type: "ping"; ts: number }
  | { type: "request_usage" }
  | { type: "load_session"; sessionId: string; cwd?: string | null };

export type RelayToBrowser =
  | AgentToCloud
  | { type: "machine_offline" }
  | { type: "machine_online" }
  | { type: "instance_offline"; instanceId: string }
  | { type: "catalog"; instances: InstanceInfo[]; machineOnline: boolean }
  | { type: "paired_ok" };

export type BrowserToRelay =
  | Exclude<CloudToAgent, { type: "paired" }>
  | { type: "watch"; instanceId: string; sessionId: string };

export type WsAttachment = {
  role: "agent" | "browser";
  userId?: string;
  pairingId?: string;
  userCode?: string;
  auth: "pairing" | "token" | "session";
  instanceId?: string;
  watchInstanceId?: string;
  watchSessionId?: string;
};

export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = "gc_session";
export const PBKDF2_ITERATIONS = 100_000;

export function isUserCode(value: string): boolean {
  return value.length === 8 && [...value].every((c) => USER_CODE_ALPHABET.includes(c));
}

export function normalizeUserCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}
