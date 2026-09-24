//! Wire types matching PROTOCOL.md / cloud `protocol.ts`.
//! Internally tagged with `"type"` (snake_case); field names are camelCase.

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::DEFAULT_ORIGIN;

pub const USER_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayMode {
    Collapsed,
    Truncated,
    Expanded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Subagent,
    System,
    SessionEvent,
    BgTask,
    Workflow,
    Btw,
    Context,
    Permission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockStatus {
    Running,
    Done,
    Error,
    Cancelled,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub id: String,
    pub hostname: String,
    pub os: String,
    pub cwd: String,
    pub grok_version: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptBlock {
    pub id: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub kind: BlockKind,
    pub title: String,
    pub status: BlockStatus,
    pub display_mode: DisplayMode,
    pub foldable: bool,
    pub open_child_session: bool,
    pub child_session_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_background: bool,
    pub content: String,
    pub detail: Option<String>,
    pub activity_label: Option<String>,
    pub is_running: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub child_session_id: String,
    pub description: String,
    pub subagent_type: String,
    pub persona: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub is_background: bool,
    pub status: SubagentStatus,
    pub activity_label: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub tool_calls: u64,
    pub turns: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub is_child: bool,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInfo {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub usage: String,
    pub takes_args: bool,
    pub args_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_label: Option<String>,
}

/// Context-usage tab of `/usage`, matching the TUI `UsageInfoTab::ContextUsage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageContextTab {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_session: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_definitions_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_definitions_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_threshold_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<UsageCategory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
}

/// One Context-usage legend row (Skills, MCP servers, AGENTS.md, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageCategory {
    pub label: String,
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Usage-limit tab of `/usage`, matching the TUI `UsageInfoTab::UsageLimit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitTab {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub chat_kind: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team_managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing_redirect_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_end_display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepaid_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pay_as_you_go: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pay_as_you_go_used_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pay_as_you_go_cap_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_usage_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
}

/// One Session-info row (`label` / `value` / `compact`), matching TUI `SessionInfoField`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSessionField {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compact: bool,
}

/// Session-info tab of `/usage`, matching the TUI `UsageInfoTab::SessionInfo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSessionTab {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_session: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<UsageSessionField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_usage_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sessions: Vec<SessionSummary>,
    pub active_session_id: Option<String>,
    pub blocks: Vec<TranscriptBlock>,
    pub subagents: Vec<SubagentInfo>,
    pub tasks: Vec<TaskInfo>,
    pub permission: Option<PermissionRequest>,
}

/// Agent → relay. Type tags are snake_case; fields camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentToCloud {
    Hello {
        machine: MachineInfo,
        instance_id: String,
        pid: u32,
    },
    SessionCatalog {
        instance_id: String,
        cwd: String,
        active_session_id: Option<String>,
        turn_running: bool,
        sessions: Vec<SessionSummary>,
    },
    Commands {
        instance_id: String,
        commands: Vec<SlashCommandInfo>,
    },
    Models {
        instance_id: String,
        models: Vec<ModelOption>,
        current: Option<String>,
        reasoning_effort: Option<String>,
    },
    PairingReady {
        pairing_id: String,
        user_code: String,
    },
    Status {
        online: bool,
        cwd: String,
        model: Option<String>,
        session_id: Option<String>,
        turn_running: bool,
        connected_browsers: u32,
    },
    Snapshot {
        sessions: Vec<SessionSummary>,
        active_session_id: Option<String>,
        blocks: Vec<TranscriptBlock>,
        subagents: Vec<SubagentInfo>,
        tasks: Vec<TaskInfo>,
        permission: Option<PermissionRequest>,
    },
    BlockUpsert {
        block: TranscriptBlock,
    },
    BlockRemove {
        session_id: String,
        id: String,
    },
    SubagentUpsert {
        subagent: SubagentInfo,
    },
    TaskUpsert {
        task: TaskInfo,
    },
    PermissionRequest {
        request: PermissionRequest,
    },
    PermissionClear {
        request_id: String,
    },
    Pong {
        ts: u64,
    },
    Error {
        message: String,
    },
    Usage {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<UsageContextTab>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<UsageLimitTab>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<UsageSessionTab>,
    },
    Reveal {
        instance_id: String,
    },
}

/// Relay → agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CloudToAgent {
    Paired {
        machine_token: String,
        user_id: String,
        machine_id: String,
    },
    Subscribe,
    Unsubscribe,
    Prompt {
        session_id: Option<String>,
        text: String,
        prompt_id: String,
    },
    Cancel {
        session_id: Option<String>,
    },
    SetFold {
        session_id: String,
        block_id: String,
        display_mode: DisplayMode,
    },
    OpenSubagent {
        child_session_id: String,
    },
    CloseSubagent,
    PermissionResponse {
        request_id: String,
        option_id: String,
    },
    RequestBlock {
        session_id: String,
        block_id: String,
    },
    Ping {
        ts: u64,
    },
    RequestUsage,
    LoadSession {
        session_id: String,
        cwd: Option<String>,
    },
}

/// Inbound events surfaced to the pager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrokcraftEvent {
    PairingReady {
        user_code: String,
        url: String,
    },
    Paired,
    Status(String),
    InboundPrompt {
        session_id: Option<String>,
        text: String,
        prompt_id: String,
    },
    InboundCancel {
        session_id: Option<String>,
    },
    InboundFold {
        session_id: String,
        block_id: String,
        display_mode: DisplayMode,
    },
    InboundOpenSubagent {
        child_session_id: String,
    },
    InboundCloseSubagent,
    InboundPermission {
        request_id: String,
        option_id: String,
    },
    RequestSnapshot,
    StopWatching,
    RequestBlock {
        session_id: String,
        block_id: String,
    },
    RequestUsage,
    LoadSession {
        session_id: String,
        cwd: Option<String>,
    },
    Error(String),
}

pub fn generate_user_code() -> String {
    let mut rng = rand::rng();
    (0..8)
        .map(|_| {
            let i = rng.random_range(0..USER_CODE_ALPHABET.len());
            USER_CODE_ALPHABET.as_bytes()[i] as char
        })
        .collect()
}

pub fn default_origin() -> String {
    std::env::var("GROKCRAFT_URL")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ORIGIN.to_string())
}

pub fn agent_ws_url(
    origin: &str,
    pairing_id: &str,
    user_code: &str,
    machine_id: &str,
    machine_token: Option<&str>,
    instance_id: &str,
) -> String {
    let trimmed = origin.trim_end_matches('/');
    let ws_origin = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if trimmed.starts_with("wss://") || trimmed.starts_with("ws://") {
        trimmed.to_string()
    } else {
        format!("wss://{trimmed}")
    };
    let mut url = url::Url::parse(&format!("{ws_origin}/agent/ws")).unwrap_or_else(|_| {
        url::Url::parse("wss://grokcraft.tanyuntech.cn/agent/ws").expect("static url")
    });
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("role", "agent");
        if !instance_id.is_empty() {
            q.append_pair("instanceId", instance_id);
        }
        if let Some(token) = machine_token.filter(|t| !t.is_empty()) {
            q.append_pair("machineToken", token);
        } else {
            q.append_pair("pairingId", pairing_id);
            q.append_pair("userCode", user_code);
            q.append_pair("machineId", machine_id);
        }
    }
    url.to_string()
}

pub fn event_from_cloud(msg: CloudToAgent) -> Option<GrokcraftEvent> {
    match msg {
        CloudToAgent::Paired { .. } => Some(GrokcraftEvent::Paired),
        CloudToAgent::Subscribe => Some(GrokcraftEvent::RequestSnapshot),
        CloudToAgent::Unsubscribe => Some(GrokcraftEvent::StopWatching),
        CloudToAgent::Prompt {
            session_id,
            text,
            prompt_id,
        } => Some(GrokcraftEvent::InboundPrompt {
            session_id,
            text,
            prompt_id,
        }),
        CloudToAgent::Cancel { session_id } => Some(GrokcraftEvent::InboundCancel { session_id }),
        CloudToAgent::SetFold {
            session_id,
            block_id,
            display_mode,
        } => Some(GrokcraftEvent::InboundFold {
            session_id,
            block_id,
            display_mode,
        }),
        CloudToAgent::OpenSubagent { child_session_id } => {
            Some(GrokcraftEvent::InboundOpenSubagent { child_session_id })
        }
        CloudToAgent::CloseSubagent => Some(GrokcraftEvent::InboundCloseSubagent),
        CloudToAgent::PermissionResponse {
            request_id,
            option_id,
        } => Some(GrokcraftEvent::InboundPermission {
            request_id,
            option_id,
        }),
        CloudToAgent::RequestBlock {
            session_id,
            block_id,
        } => Some(GrokcraftEvent::RequestBlock {
            session_id,
            block_id,
        }),
        CloudToAgent::Ping { .. } => None,
        CloudToAgent::RequestUsage => Some(GrokcraftEvent::RequestUsage),
        CloudToAgent::LoadSession { session_id, cwd } => {
            Some(GrokcraftEvent::LoadSession { session_id, cwd })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hello_roundtrip() {
        let msg = AgentToCloud::Hello {
            machine: MachineInfo {
                id: "mid".into(),
                hostname: "box".into(),
                os: "windows".into(),
                cwd: "D:/work".into(),
                grok_version: "1.0.0".into(),
                label: "box".into(),
            },
            instance_id: "inst".into(),
            pid: 1,
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "hello");
        assert_eq!(v["machine"]["grokVersion"], "1.0.0");
        assert_eq!(v["instanceId"], "inst");
        let back: AgentToCloud = serde_json::from_value(v).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn prompt_roundtrip() {
        let raw = json!({
            "type": "prompt",
            "sessionId": null,
            "text": "/help",
            "promptId": "p1"
        });
        let msg: CloudToAgent = serde_json::from_value(raw).unwrap();
        assert_eq!(
            msg,
            CloudToAgent::Prompt {
                session_id: None,
                text: "/help".into(),
                prompt_id: "p1".into(),
            }
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["promptId"], "p1");
    }

    #[test]
    fn paired_roundtrip() {
        let raw = json!({
            "type": "paired",
            "machineToken": "tok",
            "userId": "u1",
            "machineId": "m1"
        });
        let msg: CloudToAgent = serde_json::from_value(raw).unwrap();
        assert_eq!(
            msg,
            CloudToAgent::Paired {
                machine_token: "tok".into(),
                user_id: "u1".into(),
                machine_id: "m1".into(),
            }
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "paired");
        assert_eq!(v["machineToken"], "tok");
    }

    #[test]
    fn pairing_ready_type_is_snake_case() {
        let msg = AgentToCloud::PairingReady {
            pairing_id: "pid".into(),
            user_code: "ABCD2345".into(),
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "pairing_ready");
        assert_eq!(v["pairingId"], "pid");
        assert_eq!(v["userCode"], "ABCD2345");
    }

    #[test]
    fn user_code_is_eight_alphabet_chars() {
        let code = generate_user_code();
        assert_eq!(code.len(), 8);
        assert!(code.chars().all(|c| USER_CODE_ALPHABET.contains(c)));
    }

    #[test]
    fn agent_ws_url_pairing_and_reconnect() {
        let pairing = agent_ws_url(
            "https://grokcraft.tanyuntech.cn",
            "pid",
            "ABCD2345",
            "mid",
            None,
            "inst1",
        );
        assert!(pairing.starts_with("wss://grokcraft.tanyuntech.cn/agent/ws?"));
        assert!(pairing.contains("role=agent"));
        assert!(pairing.contains("pairingId=pid"));
        assert!(pairing.contains("userCode=ABCD2345"));
        assert!(pairing.contains("machineId=mid"));
        assert!(pairing.contains("instanceId=inst1"));

        let recon = agent_ws_url(
            "https://grokcraft.tanyuntech.cn",
            "pid",
            "ABCD2345",
            "mid",
            Some("tok"),
            "inst1",
        );
        assert!(recon.contains("machineToken=tok"));
        assert!(!recon.contains("pairingId="));
    }

    #[test]
    fn event_from_cloud_maps_subscribe_and_prompt() {
        assert!(matches!(
            event_from_cloud(CloudToAgent::Subscribe),
            Some(GrokcraftEvent::RequestSnapshot)
        ));
        assert!(matches!(
            event_from_cloud(CloudToAgent::Unsubscribe),
            Some(GrokcraftEvent::StopWatching)
        ));
        assert!(event_from_cloud(CloudToAgent::Ping { ts: 1 }).is_none());
    }

    #[test]
    fn usage_old_client_text_only_roundtrip() {
        let raw = json!({ "type": "usage", "text": "Context usage\nNo active session." });
        let msg: AgentToCloud = serde_json::from_value(raw).unwrap();
        assert_eq!(
            msg,
            AgentToCloud::Usage {
                text: "Context usage\nNo active session.".into(),
                context: None,
                limit: None,
                session: None,
            }
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "usage");
        assert_eq!(v["text"], "Context usage\nNo active session.");
        assert!(v.get("context").is_none());
        assert!(v.get("limit").is_none());
        assert!(v.get("session").is_none());
    }

    #[test]
    fn usage_structured_tabs_roundtrip() {
        let msg = AgentToCloud::Usage {
            text: "Context usage\nLoading context usage…".into(),
            context: Some(UsageContextTab {
                loading: true,
                lines: vec!["Loading context usage…".into()],
                ..Default::default()
            }),
            limit: Some(UsageLimitTab {
                plan: Some("SuperGrok".into()),
                usage_label: Some("Weekly limit".into()),
                usage_pct: Some(50.67),
                period_end_display: Some("May 29, 00:00".into()),
                summary: Some("Weekly limit: 50%".into()),
                lines: vec!["Weekly limit (SuperGrok)".into()],
                ..Default::default()
            }),
            session: Some(UsageSessionTab {
                fields: vec![UsageSessionField {
                    label: "Session ID".into(),
                    value: "sid-123".into(),
                    compact: false,
                }],
                lines: vec!["Session ID:".into(), "sid-123".into()],
                ..Default::default()
            }),
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "usage");
        assert_eq!(v["context"]["loading"], true);
        assert_eq!(v["limit"]["usageLabel"], "Weekly limit");
        assert_eq!(v["limit"]["usagePct"], 50.67);
        assert_eq!(v["session"]["fields"][0]["label"], "Session ID");
        let back: AgentToCloud = serde_json::from_value(v).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn session_catalog_roundtrip() {
        let msg = AgentToCloud::SessionCatalog {
            instance_id: "inst".into(),
            cwd: "D:/work".into(),
            active_session_id: Some("s1".into()),
            turn_running: true,
            sessions: vec![SessionSummary {
                id: "s1".into(),
                title: "hello".into(),
                cwd: "D:/work".into(),
                is_child: false,
                parent_id: None,
            }],
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "session_catalog");
        assert_eq!(v["instanceId"], "inst");
        assert_eq!(v["activeSessionId"], "s1");
        let back: AgentToCloud = serde_json::from_value(v).unwrap();
        assert_eq!(back, msg);
    }
}
