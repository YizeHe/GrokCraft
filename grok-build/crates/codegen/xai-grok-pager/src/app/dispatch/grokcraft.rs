//! `/grokcraft` connect + inbound WebUI events.

use std::sync::Arc;

use agent_client_protocol as acp;
use xai_grokcraft::GrokcraftEvent;

use super::ctx::open_url_or_show;
use super::dispatch;
use crate::app::actions::Action;
use crate::app::actions::Effect;
use crate::app::app_view::{ActiveView, AppView};
use crate::scrollback::entry::EntryId;
use crate::scrollback::types::DisplayMode;

pub(super) fn dispatch_connect(app: &mut AppView) -> Vec<Effect> {
    app.show_toast("正在连接 Grokcraft…");
    let hub = xai_grokcraft::hub::global();
    if hub.is_connected() {
        hub.emit(xai_grokcraft::AgentToCloud::Reveal {
            instance_id: hub.instance_id().to_string(),
        });
        crate::grokcraft_mirror::push_catalog_if_connected(app);
    }
    if let Ok(store) = xai_grokcraft::store::load()
        && store.machine_token.as_ref().is_some_and(|t| !t.is_empty())
    {
        let origin = store.origin.trim_end_matches('/');
        open_url_or_show(app, &format!("{origin}/app"));
        return vec![Effect::GrokcraftConnect {
            open_browser: false,
        }];
    }
    vec![Effect::GrokcraftConnect { open_browser: true }]
}

pub(crate) fn handle_event(app: &mut AppView, ev: GrokcraftEvent) -> Vec<Effect> {
    match ev {
        GrokcraftEvent::PairingReady { url, user_code } => {
            app.show_toast(&format!("配对码 {user_code}"));
            open_url_or_show(app, &url);
            vec![]
        }
        GrokcraftEvent::Paired => {
            app.show_toast("Grokcraft 已授权");
            let hub = xai_grokcraft::hub::global();
            hub.emit(xai_grokcraft::AgentToCloud::Reveal {
                instance_id: hub.instance_id().to_string(),
            });
            crate::grokcraft_mirror::push_catalog_if_connected(app);
            crate::grokcraft_mirror::push_snapshot_if_connected(app);
            vec![]
        }
        GrokcraftEvent::Status(s) => {
            app.show_toast(&s);
            crate::grokcraft_mirror::push_catalog_if_connected(app);
            vec![]
        }
        GrokcraftEvent::InboundPrompt {
            text, session_id, ..
        } => {
            let mut effects = ensure_agent_for_prompt(app, session_id.as_deref());
            if matches!(app.active_view, ActiveView::Agent(_)) {
                effects.extend(dispatch(Action::SendPrompt(text), app));
            } else {
                effects.extend(super::prompt::dispatch_initial_prompt(app, text));
            }
            effects
        }
        GrokcraftEvent::RequestUsage => {
            let effects = dispatch(Action::ShowUsage, app);
            crate::grokcraft_mirror::emit_usage_if_connected(app);
            effects
        }
        GrokcraftEvent::LoadSession { session_id, cwd } => dispatch(
            Action::LoadSession(
                session_id,
                cwd.filter(|s| !s.is_empty()).map(std::path::PathBuf::from),
                false,
            ),
            app,
        ),
        GrokcraftEvent::InboundCancel { session_id, .. } => {
            if let Some(sid) = session_id.as_deref() {
                focus_session(app, sid);
            }
            dispatch(Action::CancelTurn, app)
        }
        GrokcraftEvent::InboundFold {
            session_id,
            block_id,
            display_mode,
        } => {
            apply_fold(app, &session_id, &block_id, display_mode);
            vec![]
        }
        GrokcraftEvent::InboundOpenSubagent { child_session_id } => {
            open_subagent_view(app, &child_session_id);
            app.show_toast("WebUI 打开了子代理");
            crate::grokcraft_mirror::push_snapshot_if_connected(app);
            vec![]
        }
        GrokcraftEvent::InboundCloseSubagent => {
            close_subagent_view(app);
            crate::grokcraft_mirror::push_snapshot_if_connected(app);
            vec![]
        }
        GrokcraftEvent::InboundPermission { option_id, .. } => dispatch(
            Action::PermissionSelect(acp::PermissionOptionId::new(Arc::from(option_id))),
            app,
        ),
        GrokcraftEvent::RequestSnapshot => {
            xai_grokcraft::hub::global().set_watching(true);
            crate::grokcraft_mirror::push_snapshot_if_connected(app);
            vec![]
        }
        GrokcraftEvent::StopWatching => {
            xai_grokcraft::hub::global().set_watching(false);
            vec![]
        }
        GrokcraftEvent::RequestBlock {
            session_id,
            block_id,
        } => {
            crate::grokcraft_mirror::push_block_detail(app, &session_id, &block_id);
            vec![]
        }
        GrokcraftEvent::Error(e) => {
            app.show_toast(&e);
            vec![]
        }
    }
}

/// Web prompts must land on an agent view. The dashboard and welcome screen
/// otherwise stash the text and never send it.
fn ensure_agent_for_prompt(app: &mut AppView, session_id: Option<&str>) -> Vec<Effect> {
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        focus_session(app, sid);
    }
    if matches!(app.active_view, ActiveView::Agent(_)) {
        return vec![];
    }
    let mut effects = Vec::new();
    if matches!(app.active_view, ActiveView::AgentDashboard) {
        effects.extend(dispatch(Action::ExitDashboard, app));
    }
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        focus_session(app, sid);
    }
    if matches!(app.active_view, ActiveView::Agent(_)) {
        return effects;
    }
    if let Some(id) = app.agents.iter().find_map(|(id, agent)| {
        agent.session.session_id.is_some().then_some(*id)
    }) {
        app.active_view = ActiveView::Agent(id);
    }
    effects
}

fn focus_session(app: &mut AppView, session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    let mut found = None;
    let mut as_child = false;
    for (id, agent) in &app.agents {
        if agent
            .session
            .session_id
            .as_ref()
            .is_some_and(|s| s.to_string() == session_id)
        {
            found = Some(*id);
            as_child = false;
            break;
        }
        if agent.subagent_views.contains_key(session_id) {
            found = Some(*id);
            as_child = true;
            break;
        }
    }
    let Some(id) = found else {
        return;
    };
    app.active_view = ActiveView::Agent(id);
    if let Some(agent) = app.agents.get_mut(&id) {
        agent.active_subagent = if as_child {
            Some(session_id.to_string())
        } else {
            None
        };
    }
}

fn apply_fold(
    app: &mut AppView,
    session_id: &str,
    block_id: &str,
    mode: xai_grokcraft::DisplayMode,
) {
    let Some(id) = parse_entry_id(block_id) else {
        return;
    };
    let mode = map_display_mode(mode);
    for agent in app.agents.values_mut() {
        pin_entry(
            &mut agent.scrollback,
            session_id,
            &agent.session.session_id,
            id,
            mode,
        );
        for child in agent.subagent_views.values_mut() {
            pin_entry(
                &mut child.scrollback,
                session_id,
                &child.session.session_id,
                id,
                mode,
            );
        }
    }
}

fn pin_entry(
    scrollback: &mut crate::scrollback::state::ScrollbackState,
    want_session: &str,
    have_session: &Option<acp::SessionId>,
    id: EntryId,
    mode: DisplayMode,
) {
    let matches = have_session
        .as_ref()
        .is_some_and(|sid| sid.to_string() == want_session);
    if !matches {
        return;
    }
    if let Some(entry) = scrollback.get_by_id_mut(id) {
        entry.display_mode = mode;
        entry.display_mode_pinned = true;
    }
}

fn open_subagent_view(app: &mut AppView, child_session_id: &str) {
    for agent in app.agents.values_mut() {
        if agent.subagent_views.contains_key(child_session_id) {
            agent.active_subagent = Some(child_session_id.to_string());
            return;
        }
    }
}

fn close_subagent_view(app: &mut AppView) {
    let ActiveView::Agent(id) = app.active_view else {
        return;
    };
    if let Some(agent) = app.agents.get_mut(&id) {
        agent.active_subagent = None;
    }
}

fn parse_entry_id(block_id: &str) -> Option<EntryId> {
    block_id.parse::<u64>().ok().map(EntryId::new)
}

fn map_display_mode(mode: xai_grokcraft::DisplayMode) -> DisplayMode {
    match mode {
        xai_grokcraft::DisplayMode::Collapsed => DisplayMode::Collapsed,
        xai_grokcraft::DisplayMode::Truncated => DisplayMode::Truncated,
        xai_grokcraft::DisplayMode::Expanded => DisplayMode::Expanded,
    }
}
