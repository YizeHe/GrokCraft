//! Project the pager transcript into Grokcraft snapshot / block frames.

use std::sync::Mutex;

use crate::app::agent::AgentState;
use crate::app::agent_view::AgentView;
use crate::app::app_view::{ActiveView, AppView};
use crate::scrollback::block::RenderBlock;
use crate::scrollback::blocks::{
    BgTaskKind, SubagentBlockKind, ToolCallBlock, WorkflowBlockStatus,
};
use crate::scrollback::entry::ScrollbackEntry;
use crate::scrollback::types::DisplayMode as TuiDisplayMode;
use crate::slash::commands::builtin_commands;
use xai_grokcraft::{
    AgentToCloud, BlockKind, BlockStatus, DisplayMode, ModelOption, PermissionOption,
    PermissionRequest, SessionSummary, SlashCommandInfo, SubagentInfo, SubagentStatus, TaskInfo,
    TranscriptBlock, UsageContextTab, UsageLimitTab, UsageSessionField, UsageSessionTab,
};

const CONTENT_CAP: usize = 8_000;
static LAST_CATALOG: Mutex<String> = Mutex::new(String::new());

pub fn push_catalog_if_connected(app: &AppView) {
    let hub = xai_grokcraft::hub::global();
    if !hub.is_connected() {
        return;
    }
    let (sessions, active_session_id, _blocks, _subagents, _tasks, _permission) = snapshot(app);
    let (cwd, _model, _session_id, turn_running) = status_fields(app);
    let key = format!(
        "{cwd}|{turn_running}|{}|{}",
        active_session_id.as_deref().unwrap_or(""),
        sessions
            .iter()
            .map(|s| format!("{}:{}", s.id, s.title))
            .collect::<Vec<_>>()
            .join(",")
    );
    if let Ok(mut last) = LAST_CATALOG.lock() {
        if *last == key {
            return;
        }
        *last = key;
    }
    hub.emit(AgentToCloud::SessionCatalog {
        instance_id: hub.instance_id().to_string(),
        cwd,
        active_session_id,
        turn_running,
        sessions,
    });
    emit_commands_and_models(app);
}

fn emit_commands_and_models(app: &AppView) {
    let hub = xai_grokcraft::hub::global();
    if !hub.is_connected() {
        return;
    }
    let commands: Vec<SlashCommandInfo> = builtin_commands()
        .into_iter()
        .filter(|c| c.name() != "gboom" && c.name() != "scroll-debug")
        .map(|c| SlashCommandInfo {
            name: c.name().to_string(),
            aliases: c.aliases().iter().map(|s| (*s).to_string()).collect(),
            description: c.description().to_string(),
            usage: c.usage().to_string(),
            takes_args: c.takes_args(),
            args_required: c.args_required(),
        })
        .collect();
    hub.emit(AgentToCloud::Commands {
        instance_id: hub.instance_id().to_string(),
        commands,
    });
    let (models, current, reasoning_effort) = model_catalog(app);
    hub.emit(AgentToCloud::Models {
        instance_id: hub.instance_id().to_string(),
        models,
        current,
        reasoning_effort,
    });
}

fn model_catalog(app: &AppView) -> (Vec<ModelOption>, Option<String>, Option<String>) {
    let Some(agent) = visible_agent(app) else {
        return (Vec::new(), None, None);
    };
    let models = agent
        .session
        .models
        .available
        .iter()
        .map(|(id, info)| ModelOption {
            id: id.to_string(),
            name: info.name.clone(),
        })
        .collect();
    let current = agent.session.models.current_model_name();
    let reasoning_effort = agent
        .session
        .models
        .reasoning_effort
        .map(|e| format!("{e:?}").to_lowercase());
    (models, current, reasoning_effort)
}

pub fn emit_usage_if_connected(app: &AppView) {
    let hub = xai_grokcraft::hub::global();
    if !hub.is_connected() {
        return;
    }
    let (text, context, limit, session) = format_usage_panel(app);
    hub.emit(AgentToCloud::Usage {
        text,
        context,
        limit,
        session,
    });
}

fn format_usage_panel(
    app: &AppView,
) -> (
    String,
    Option<UsageContextTab>,
    Option<UsageLimitTab>,
    Option<UsageSessionTab>,
) {
    let agent = visible_agent(app);
    let modal = usage_modal(app, agent);
    let context = context_tab(agent, modal);
    let limit = limit_tab(app, agent, modal);
    let session = session_tab(agent, modal);
    let text = [
        section_text("Context usage", &context.lines),
        section_text("Usage limit", &limit.lines),
        section_text("Session info", &session.lines),
    ]
    .join("\n\n");
    (text, Some(context), Some(limit), Some(session))
}

fn section_text(title: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n{}", lines.join("\n"))
    }
}

fn usage_modal<'a>(
    app: &'a AppView,
    agent: Option<&'a AgentView>,
) -> Option<&'a crate::views::usage_modal::UsageInfoModalState> {
    use crate::views::modal::ActiveModal;
    if let Some(agent) = agent
        && let Some(ActiveModal::UsageInfo { state }) = agent.active_modal.as_ref()
    {
        return Some(state.as_ref());
    }
    app.dashboard
        .as_ref()
        .and_then(|d| d.usage_modal.as_deref())
}

fn session_id_of(
    agent: Option<&AgentView>,
    modal: Option<&crate::views::usage_modal::UsageInfoModalState>,
) -> Option<String> {
    modal
        .and_then(|m| m.ctx.session_id.clone())
        .or_else(|| agent.and_then(|a| a.session.session_id.as_ref().map(|s| s.to_string())))
}

fn context_tab(
    agent: Option<&AgentView>,
    modal: Option<&crate::views::usage_modal::UsageInfoModalState>,
) -> UsageContextTab {
    if let Some(err) = modal.and_then(|m| m.context_error.as_deref()) {
        return UsageContextTab {
            error: Some(err.to_string()),
            lines: vec![format!("Couldn't load context usage: {err}")],
            ..Default::default()
        };
    }
    if let Some(block) = modal.and_then(|m| m.context.as_ref()) {
        let s = &block.snapshot;
        let lines = block
            .lines_for_width(&crate::theme::Theme::current(), 80)
            .into_iter()
            .map(|line| line.to_string())
            .collect();
        return UsageContextTab {
            model: Some(block.model.clone()),
            used: Some(s.used),
            total: Some(s.total),
            usage_pct: Some(f64::from(s.usage_pct)),
            system_prompt_tokens: Some(s.system_prompt_tokens),
            tool_definitions_tokens: Some(s.tool_definitions_tokens),
            tool_definitions_count: Some(s.tool_definitions_count),
            message_tokens: Some(s.message_tokens),
            free_tokens: Some(s.free_tokens),
            turn_count: Some(s.turn_count),
            tool_call_count: Some(s.tool_call_count),
            compaction_count: Some(s.compaction_count),
            auto_compact_threshold_percent: Some(s.auto_compact_threshold_percent),
            categories: s
                .usage_categories
                .iter()
                .map(|c| xai_grokcraft::UsageCategory {
                    label: c.label.clone(),
                    tokens: c.tokens,
                    detail: c.detail.clone(),
                })
                .collect(),
            lines,
            ..Default::default()
        };
    }
    if session_id_of(agent, modal).is_none() {
        return UsageContextTab {
            no_session: true,
            lines: vec!["No active session.".into()],
            ..Default::default()
        };
    }
    UsageContextTab {
        loading: true,
        lines: vec!["Loading context usage\u{2026}".into()],
        ..Default::default()
    }
}

fn limit_tab(
    app: &AppView,
    agent: Option<&AgentView>,
    modal: Option<&crate::views::usage_modal::UsageInfoModalState>,
) -> UsageLimitTab {
    use crate::views::credit_bar::format_usage_summary;

    let chat_kind = modal
        .map(|m| m.ctx.chat_kind)
        .unwrap_or_else(|| agent.map(|a| a.chat_kind).unwrap_or(app.chat_mode));
    let usage_visible = modal
        .map(|m| m.ctx.usage_visible)
        .unwrap_or(app.usage_visible);
    let billing_redirect_url = modal
        .and_then(|m| m.ctx.billing_redirect_url.clone())
        .or_else(|| app.usage_billing_redirect_url.clone());
    let plan = app
        .subscription_tier
        .clone()
        .or_else(|| modal.and_then(|m| m.ctx.subscription_tier.clone()));
    let session_usage_text = modal.and_then(|m| m.session_usage_text.clone());
    let has_session = session_id_of(agent, modal).is_some();

    let mut tab = UsageLimitTab {
        chat_kind,
        team_managed: !usage_visible,
        billing_redirect_url: billing_redirect_url.clone(),
        plan: plan.clone(),
        session_usage_text: session_usage_text.clone(),
        ..Default::default()
    };
    let mut lines: Vec<String> = Vec::new();

    if chat_kind {
        // Gateway chat sessions have no Build coding credits to show.
    } else if !usage_visible {
        lines.push("Usage limits are managed by your team.".into());
    } else if let Some(url) = &billing_redirect_url {
        lines.push(format!("Please check your usage on {url}"));
    } else if let Some(bal) = agent
        .and_then(|a| a.credit_balance.as_ref())
        .or(app.credit_balance.as_ref())
    {
        let topup = agent
            .and_then(|a| a.auto_topup.as_ref())
            .or(app.auto_topup.as_ref());
        tab.usage_label = Some(bal.usage_label().to_string());
        tab.usage_pct = Some(bal.usage_pct);
        tab.period_end_display = bal.period_end_display.clone();
        tab.prepaid_cents = bal.prepaid_balance_cents.map(i64::abs).filter(|c| *c > 0);
        tab.pay_as_you_go = bal.pay_as_you_go;
        if bal.pay_as_you_go {
            tab.pay_as_you_go_used_cents = Some(bal.on_demand_used_cents.unwrap_or(0).abs());
            tab.pay_as_you_go_cap_cents = Some(bal.on_demand_cap_cents.unwrap_or(0).abs());
        }
        tab.summary = Some(format_usage_summary(bal, topup));
        lines.extend(allowance_text_lines(plan.as_deref(), bal));
    } else if let Some(err) = modal.and_then(|m| m.billing_error.as_deref()) {
        tab.error = Some(err.to_string());
        lines.push(format!("Couldn't load usage: {err}"));
    } else if modal.is_some_and(|m| m.billing_loading) {
        tab.loading = true;
        lines.push("Loading usage\u{2026}".into());
    } else {
        lines.push("No billing data available.".into());
    }

    if let Some(usage_text) = &session_usage_text {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.extend(usage_text.lines().map(str::to_string));
    } else if has_session {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("Loading session usage\u{2026}".into());
    }

    tab.lines = lines;
    tab
}

fn allowance_text_lines(
    plan: Option<&str>,
    bal: &crate::views::credit_bar::CreditBalance,
) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let header = match plan {
        Some(tier) => format!("{} ({tier})", bal.usage_label()),
        None => bal.usage_label().to_string(),
    };
    lines.push(header);
    lines.push(String::new());

    const BAR_WIDTH: usize = 30;
    let pct = bal.usage_pct.clamp(0.0, 100.0);
    let filled = (((pct / 100.0) * BAR_WIDTH as f64).round() as usize).min(BAR_WIDTH);
    lines.push(format!(
        "{}{}  {}%",
        "\u{2588}".repeat(filled),
        "\u{2591}".repeat(BAR_WIDTH - filled),
        bal.usage_pct.floor() as i64
    ));

    if let Some(reset) = &bal.period_end_display {
        lines.push(format!("Resets: {reset}"));
    }
    if let Some(prepaid) = bal.prepaid_balance_cents.map(i64::abs).filter(|c| *c > 0) {
        lines.push(String::new());
        lines.push(format!("Credits: ${:.2}", prepaid as f64 / 100.0));
    }
    if bal.pay_as_you_go {
        let used = bal.on_demand_used_cents.unwrap_or(0).abs() as f64 / 100.0;
        let cap = bal.on_demand_cap_cents.unwrap_or(0).abs() as f64 / 100.0;
        lines.push(String::new());
        lines.push("Pay as you go: Enabled".into());
        lines.push(format!("Usage: ${used:.2} / ${cap:.2} per month"));
    }
    lines
}

fn session_tab(
    agent: Option<&AgentView>,
    modal: Option<&crate::views::usage_modal::UsageInfoModalState>,
) -> UsageSessionTab {
    if let Some(err) = modal.and_then(|m| m.session_error.as_deref()) {
        return UsageSessionTab {
            error: Some(err.to_string()),
            lines: vec![format!("Couldn't load session info: {err}")],
            ..Default::default()
        };
    }
    let fields = modal
        .and_then(|m| m.session_fields.as_ref())
        .filter(|f| !f.is_empty());
    if let Some(fields) = fields {
        let proto_fields: Vec<UsageSessionField> = fields
            .iter()
            .map(|f| UsageSessionField {
                label: f.label.to_string(),
                value: f.value.clone(),
                compact: f.compact,
            })
            .collect();
        let mut lines: Vec<String> = Vec::new();
        let mut prev_compact = false;
        for field in fields {
            if !(field.compact && prev_compact) && !lines.is_empty() {
                lines.push(String::new());
            }
            if field.compact {
                lines.push(format!("{}: {}", field.label, field.value));
            } else {
                lines.push(format!("{}:", field.label));
                lines.push(field.value.clone());
            }
            prev_compact = field.compact;
        }
        let session_usage_text = modal.and_then(|m| m.session_usage_text.clone());
        return UsageSessionTab {
            fields: proto_fields,
            session_usage_text,
            lines,
            ..Default::default()
        };
    }
    if session_id_of(agent, modal).is_none() {
        return UsageSessionTab {
            no_session: true,
            lines: vec!["No active session.".into()],
            ..Default::default()
        };
    }
    UsageSessionTab {
        loading: true,
        lines: vec!["Loading session info\u{2026}".into()],
        ..Default::default()
    }
}

pub fn push_snapshot_if_connected(app: &AppView) {
    let hub = xai_grokcraft::hub::global();
    if !hub.is_connected() {
        return;
    }
    push_catalog_if_connected(app);
    emit_commands_and_models(app);
    if !hub.is_watching() {
        return;
    }
    let (sessions, active_session_id, blocks, subagents, tasks, permission) = snapshot(app);
    hub.emit(AgentToCloud::Snapshot {
        sessions,
        active_session_id,
        blocks,
        subagents,
        tasks,
        permission,
    });
    emit_status(app);
}

pub fn push_block_detail(app: &AppView, session_id: &str, block_id: &str) {
    if !xai_grokcraft::hub::global().is_connected() {
        return;
    }
    let Some(block) = find_block(app, session_id, block_id) else {
        return;
    };
    xai_grokcraft::hub::global().emit(AgentToCloud::BlockUpsert { block });
}

fn emit_status(app: &AppView) {
    let (cwd, model, session_id, turn_running) = status_fields(app);
    xai_grokcraft::hub::global().emit(AgentToCloud::Status {
        online: true,
        cwd,
        model,
        session_id,
        turn_running,
        connected_browsers: 0,
    });
}

fn status_fields(app: &AppView) -> (String, Option<String>, Option<String>, bool) {
    if let Some(agent) = visible_agent(app) {
        let cwd = agent.session.cwd.display().to_string();
        let model = agent.session.models.current.as_ref().map(|m| m.to_string());
        let session_id = agent.session.session_id.as_ref().map(|s| s.to_string());
        let turn_running = matches!(
            agent.session.state,
            AgentState::TurnRunning | AgentState::TurnCancelling
        );
        return (cwd, model, session_id, turn_running);
    }
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    (cwd, None, None, false)
}

fn visible_agent(app: &AppView) -> Option<&AgentView> {
    match app.active_view {
        ActiveView::Agent(id) => {
            let agent = app.agents.get(&id)?;
            if let Some(ref child_sid) = agent.active_subagent
                && let Some(child) = agent.subagent_views.get(child_sid)
            {
                return Some(child);
            }
            Some(agent)
        }
        _ => app.agents.values().next(),
    }
}

fn snapshot(
    app: &AppView,
) -> (
    Vec<SessionSummary>,
    Option<String>,
    Vec<TranscriptBlock>,
    Vec<SubagentInfo>,
    Vec<TaskInfo>,
    Option<PermissionRequest>,
) {
    let mut sessions = Vec::new();
    let mut blocks = Vec::new();
    let mut subagents = Vec::new();
    let mut tasks = Vec::new();
    let mut permission = None;

    for agent in app.agents.values() {
        collect_agent(
            agent,
            None,
            &mut sessions,
            &mut blocks,
            &mut subagents,
            &mut tasks,
            &mut permission,
        );
    }

    let active_session_id = match app.active_view {
        ActiveView::Agent(id) => app.agents.get(&id).and_then(|agent| {
            agent
                .active_subagent
                .clone()
                .or_else(|| agent.session.session_id.as_ref().map(|s| s.to_string()))
        }),
        _ => sessions.first().map(|s| s.id.clone()),
    };

    (
        sessions,
        active_session_id,
        blocks,
        subagents,
        tasks,
        permission,
    )
}

fn collect_agent(
    agent: &AgentView,
    parent_id: Option<String>,
    sessions: &mut Vec<SessionSummary>,
    blocks: &mut Vec<TranscriptBlock>,
    subagents: &mut Vec<SubagentInfo>,
    tasks: &mut Vec<TaskInfo>,
    permission: &mut Option<PermissionRequest>,
) {
    let Some(sid) = agent.session.session_id.as_ref().map(|s| s.to_string()) else {
        return;
    };
    let title = agent
        .display_name
        .clone()
        .or_else(|| agent.generated_session_title.clone())
        .unwrap_or_else(|| sid.clone());
    sessions.push(SessionSummary {
        id: sid.clone(),
        title,
        cwd: agent.session.cwd.display().to_string(),
        is_child: parent_id.is_some(),
        parent_id: parent_id.clone(),
    });

    for (_id, entry) in agent.scrollback.iter_entries() {
        blocks.push(transcript_block(entry, &sid, parent_id.as_deref(), false));
    }

    for info in agent.subagent_sessions.values() {
        subagents.push(map_subagent(info));
        tasks.push(TaskInfo {
            id: info.child_session_id.to_string(),
            title: Some(info.description.to_string()),
            label: Some(info.subagent_type.to_string()),
            description: Some(info.description.to_string()),
            status: Some(
                info.attempt
                    .status
                    .as_deref()
                    .unwrap_or("running")
                    .to_string(),
            ),
            progress: None,
            session_id: Some(info.child_session_id.to_string()),
            activity_label: info.attempt.activity_label.clone(),
        });
    }

    if permission.is_none()
        && let Some(front) = agent.permission_queue.front()
    {
        *permission = Some(PermissionRequest {
            request_id: front.id.to_string(),
            session_id: sid.clone(),
            title: front.title.clone(),
            detail: front.description.join("\n"),
            options: front
                .options
                .iter()
                .map(|o| PermissionOption {
                    id: o.option_id.0.to_string(),
                    label: o.name.clone(),
                })
                .collect(),
        });
    }

    for (child_id, child) in &agent.subagent_views {
        collect_agent(
            child,
            Some(sid.clone()),
            sessions,
            blocks,
            subagents,
            tasks,
            permission,
        );
        let _ = child_id;
    }
}

fn find_block(app: &AppView, session_id: &str, block_id: &str) -> Option<TranscriptBlock> {
    for agent in app.agents.values() {
        if let Some(block) = find_block_in_agent(agent, session_id, block_id, None) {
            return Some(block);
        }
        for child in agent.subagent_views.values() {
            if let Some(block) = find_block_in_agent(child, session_id, block_id, Some(session_id))
            {
                return Some(block);
            }
        }
    }
    None
}

fn find_block_in_agent(
    agent: &AgentView,
    session_id: &str,
    block_id: &str,
    parent_id: Option<&str>,
) -> Option<TranscriptBlock> {
    let sid = agent.session.session_id.as_ref()?.to_string();
    if sid != session_id {
        return None;
    }
    let (_id, entry) = agent
        .scrollback
        .iter_entries()
        .find(|(id, _)| id.value().to_string() == block_id)?;
    Some(transcript_block(entry, &sid, parent_id, true))
}

fn transcript_block(
    entry: &ScrollbackEntry,
    session_id: &str,
    parent_session_id: Option<&str>,
    include_detail: bool,
) -> TranscriptBlock {
    let kind = block_kind(&entry.block);
    let (title, tool_name, child_session_id, is_background, activity_label, full) =
        block_fields(&entry.block);
    let (content, detail) = split_content(&full, include_detail);
    let display_mode = if entry.display_mode_pinned {
        map_tui_mode(entry.display_mode)
    } else {
        default_display_mode(kind, tool_name.as_deref(), entry.is_running)
    };
    let foldable = match kind {
        BlockKind::Thinking | BlockKind::Tool => true,
        BlockKind::User
        | BlockKind::Assistant
        | BlockKind::System
        | BlockKind::SessionEvent
        | BlockKind::Subagent
        | BlockKind::BgTask
        | BlockKind::Workflow
        | BlockKind::Btw
        | BlockKind::Context
        | BlockKind::Permission => false,
    };
    let open_child_session = kind == BlockKind::Subagent;
    let status = block_status(&entry.block, entry.is_running);

    TranscriptBlock {
        id: entry.id.value().to_string(),
        session_id: session_id.to_string(),
        parent_session_id: parent_session_id.map(str::to_string),
        kind,
        title,
        status,
        display_mode,
        foldable,
        open_child_session,
        child_session_id,
        tool_name,
        is_background,
        content,
        detail,
        activity_label,
        is_running: entry.is_running,
        pinned: entry.display_mode_pinned,
    }
}

fn block_kind(block: &RenderBlock) -> BlockKind {
    match block {
        RenderBlock::UserPrompt(_) => BlockKind::User,
        RenderBlock::AgentMessage(_) => BlockKind::Assistant,
        RenderBlock::Thinking(_) => BlockKind::Thinking,
        RenderBlock::ToolCall(_) => BlockKind::Tool,
        RenderBlock::Subagent(_) => BlockKind::Subagent,
        RenderBlock::System(_) => BlockKind::System,
        RenderBlock::SessionEvent(_) => BlockKind::SessionEvent,
        RenderBlock::BgTask(_) => BlockKind::BgTask,
        RenderBlock::Workflow(_) => BlockKind::Workflow,
        RenderBlock::Btw(_) => BlockKind::Btw,
        RenderBlock::ContextInfo(_) => BlockKind::Context,
        RenderBlock::MemoryCapture(_) => BlockKind::System,
        RenderBlock::Stub(_) => BlockKind::System,
    }
}

fn default_display_mode(
    kind: BlockKind,
    _tool_name: Option<&str>,
    is_running: bool,
) -> DisplayMode {
    match kind {
        BlockKind::Thinking => {
            if is_running {
                DisplayMode::Truncated
            } else {
                DisplayMode::Collapsed
            }
        }
        BlockKind::Tool => DisplayMode::Collapsed,
        BlockKind::Subagent | BlockKind::BgTask => DisplayMode::Collapsed,
        BlockKind::Btw => DisplayMode::Collapsed,
        _ => DisplayMode::Expanded,
    }
}

fn map_tui_mode(mode: TuiDisplayMode) -> DisplayMode {
    match mode {
        TuiDisplayMode::Collapsed => DisplayMode::Collapsed,
        TuiDisplayMode::Truncated => DisplayMode::Truncated,
        TuiDisplayMode::Expanded => DisplayMode::Expanded,
    }
}

fn block_status(block: &RenderBlock, is_running: bool) -> BlockStatus {
    if is_running {
        return BlockStatus::Running;
    }
    match block {
        RenderBlock::Subagent(b) => match b.kind {
            SubagentBlockKind::Failed { .. } => BlockStatus::Error,
            SubagentBlockKind::Cancelled { .. } => BlockStatus::Cancelled,
            SubagentBlockKind::Completed { .. } => BlockStatus::Done,
            SubagentBlockKind::Started => BlockStatus::Idle,
        },
        RenderBlock::BgTask(b) => match b.kind {
            BgTaskKind::Failed { .. } => BlockStatus::Error,
            BgTaskKind::Completed { .. } => BlockStatus::Done,
            BgTaskKind::Started => BlockStatus::Idle,
        },
        RenderBlock::Workflow(b) => match b.status {
            WorkflowBlockStatus::Failed { .. } => BlockStatus::Error,
            WorkflowBlockStatus::Cancelled { .. } => BlockStatus::Cancelled,
            WorkflowBlockStatus::Running => BlockStatus::Running,
            _ => BlockStatus::Done,
        },
        _ => BlockStatus::Done,
    }
}

fn block_fields(
    block: &RenderBlock,
) -> (
    String,
    Option<String>,
    Option<String>,
    bool,
    Option<String>,
    String,
) {
    match block {
        RenderBlock::UserPrompt(b) => ("User".into(), None, None, false, None, b.copy_text()),
        RenderBlock::AgentMessage(b) => (
            "Assistant".into(),
            None,
            None,
            false,
            None,
            b.copy_text(true),
        ),
        RenderBlock::Thinking(b) => (
            "Thinking".into(),
            None,
            None,
            false,
            None,
            b.copy_text(true),
        ),
        RenderBlock::ToolCall(tc) => {
            let title = tool_summary(tc);
            let name = tool_name(tc);
            let body = block
                .copy_text(true)
                .or_else(|| block.copy_meta())
                .unwrap_or_else(|| title.clone());
            (title, Some(name), None, false, None, body)
        }
        RenderBlock::Subagent(b) => (
            format!("Subagent {}", b.description),
            None,
            Some(b.child_session_id.clone()),
            b.is_background,
            b.activity_label.clone(),
            b.description.clone(),
        ),
        RenderBlock::System(b) => ("System".into(), None, None, false, None, b.text.clone()),
        RenderBlock::SessionEvent(b) => {
            let text = b.event.message();
            let title = if text.starts_with("Worked for") {
                "Worked for".into()
            } else if text.starts_with("Switched to") {
                "Switched".into()
            } else {
                "Session event".into()
            };
            (title, None, None, false, None, text)
        }
        RenderBlock::BgTask(b) => (
            format!("Background {}", b.command),
            None,
            None,
            true,
            None,
            b.command.clone(),
        ),
        RenderBlock::Workflow(b) => (b.name.clone(), None, None, false, None, b.objective.clone()),
        RenderBlock::Btw(b) => (
            format!("/btw {}", b.question),
            None,
            None,
            false,
            None,
            b.content().text(),
        ),
        RenderBlock::ContextInfo(_) => (
            "Context".into(),
            None,
            None,
            false,
            None,
            "Context usage".into(),
        ),
        RenderBlock::MemoryCapture(_) => (
            "Memory".into(),
            None,
            None,
            false,
            None,
            "Memory capture".into(),
        ),
        RenderBlock::Stub(b) => ("Stub".into(), None, None, false, None, b.text.clone()),
    }
}

fn tool_name(tc: &ToolCallBlock) -> String {
    match tc {
        ToolCallBlock::Read(_) => "Read".into(),
        ToolCallBlock::Edit(_) => "Edit".into(),
        ToolCallBlock::Execute(_) => "Execute".into(),
        ToolCallBlock::ListDir(_) => "ListDir".into(),
        ToolCallBlock::Search(_) => "Search".into(),
        ToolCallBlock::WebFetch(_) => "WebFetch".into(),
        ToolCallBlock::WebSearch(_) => "WebSearch".into(),
        ToolCallBlock::UseTool(u) => u.tool_name.clone(),
        ToolCallBlock::IntegrationSearch(_) => "IntegrationSearch".into(),
        ToolCallBlock::MemorySearch(_) => "MemorySearch".into(),
        ToolCallBlock::SentMessage(_) => "SentMessage".into(),
        ToolCallBlock::Skill(o) | ToolCallBlock::Other(o) => o.name.clone(),
    }
}

fn tool_summary(tc: &ToolCallBlock) -> String {
    match tc {
        ToolCallBlock::Read(r) => format!("Read {}", r.path),
        ToolCallBlock::Edit(e) => format!("Edit {}", e.path),
        ToolCallBlock::Execute(ex) => format!("Execute {}", ex.command),
        ToolCallBlock::ListDir(l) => format!("ListDir {}", l.path),
        ToolCallBlock::Search(s) => format!("Search {}", s.pattern),
        ToolCallBlock::WebFetch(w) => format!("WebFetch {}", w.url),
        ToolCallBlock::WebSearch(w) => format!("WebSearch {}", w.query),
        ToolCallBlock::UseTool(u) => format!("UseTool {}", u.tool_name),
        ToolCallBlock::IntegrationSearch(_) => "IntegrationSearch".into(),
        ToolCallBlock::MemorySearch(_) => "MemorySearch".into(),
        ToolCallBlock::SentMessage(message) => message.header_text(),
        ToolCallBlock::Skill(o) | ToolCallBlock::Other(o) => format!("Tool {}", o.name),
    }
}

fn split_content(full: &str, include_detail: bool) -> (String, Option<String>) {
    let truncated: String = full.chars().take(CONTENT_CAP).collect();
    if include_detail && full.chars().count() > CONTENT_CAP {
        (truncated, Some(full.to_string()))
    } else if include_detail {
        (truncated, Some(full.to_string()))
    } else if full.chars().count() > CONTENT_CAP {
        (truncated, None)
    } else {
        (truncated, None)
    }
}

fn map_subagent(info: &crate::app::subagent::SubagentInfo) -> SubagentInfo {
    let status = match info.attempt.status.as_deref() {
        Some("completed") => SubagentStatus::Completed,
        Some("failed") => SubagentStatus::Failed,
        Some("cancelled") => SubagentStatus::Cancelled,
        _ => SubagentStatus::Running,
    };
    SubagentInfo {
        child_session_id: info.child_session_id.to_string(),
        description: info.description.to_string(),
        subagent_type: info.subagent_type.to_string(),
        persona: info.attempt.persona.as_ref().map(|s| s.to_string()),
        role: info.attempt.role.as_ref().map(|s| s.to_string()),
        model: info.attempt.model.as_ref().map(|s| s.to_string()),
        is_background: info.attempt.is_background,
        status,
        activity_label: info.attempt.activity_label.clone(),
        error: info.attempt.error.as_ref().map(|s| s.to_string()),
        duration_ms: info.attempt.duration_ms.unwrap_or(0),
        tool_calls: info.attempt.tool_calls.unwrap_or(0) as u64,
        turns: info.attempt.turns.unwrap_or(0) as u64,
    }
}
