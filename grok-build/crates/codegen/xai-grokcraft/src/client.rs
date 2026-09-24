//! Outbound WebSocket loop to the Grokcraft relay.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::hub::{self, global};
use crate::protocol::{
    agent_ws_url, event_from_cloud, generate_user_code, AgentToCloud, CloudToAgent, GrokcraftEvent,
    MachineInfo,
};
use crate::store::{self, hostname};

const BACKOFF: &[u64] = &[1, 2, 5, 10];

pub async fn run_client() {
    let mut backoff_idx = 0usize;
    loop {
        match run_once().await {
            Ok(()) => {
                backoff_idx = 0;
            }
            Err(err) => {
                tracing::warn!(error = %err, "grokcraft client disconnected");
                global().push_inbound(GrokcraftEvent::Error(format!("Grokcraft: {err}")));
            }
        }
        global().set_connected(false);
        let secs = BACKOFF[backoff_idx.min(BACKOFF.len() - 1)];
        backoff_idx = (backoff_idx + 1).min(BACKOFF.len() - 1);
        tokio::time::sleep(Duration::from_secs(secs)).await;
    }
}

async fn run_once() -> anyhow::Result<()> {
    let mut store = store::load_or_create()?;
    let pairing_id = uuid::Uuid::new_v4().to_string();
    let user_code = generate_user_code();
    let pairing = store.machine_token.is_none();
    let url = agent_ws_url(
        &store.origin,
        &pairing_id,
        &user_code,
        &store.machine_id,
        store.machine_token.as_deref(),
        hub::global().instance_id(),
    );

    tracing::info!(%url, pairing, "grokcraft connecting");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await?;
    let (mut sink, mut stream) = ws.split();
    let hub = global();
    hub.set_connected(true);

    let hello = AgentToCloud::Hello {
        machine: current_machine(&store),
        instance_id: hub.instance_id().to_string(),
        pid: std::process::id(),
    };
    sink.send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;

    if pairing {
        let ready = AgentToCloud::PairingReady {
            pairing_id: pairing_id.clone(),
            user_code: user_code.clone(),
        };
        sink.send(Message::Text(serde_json::to_string(&ready)?.into()))
            .await?;
        let oauth = format!("{}/oauth-login?code={user_code}", store.origin.trim_end_matches('/'));
        hub.push_inbound(GrokcraftEvent::PairingReady {
            user_code,
            url: oauth,
        });
    } else {
        hub.push_inbound(GrokcraftEvent::Status("Grokcraft 已连接".into()));
    }

    let mut outbound_rx = hub.outbound.subscribe();
    // Edge auto-responds "pong" without waking the Durable Object. ~50s keeps
    // home NAT mappings alive without burning Workers CPU/D1.
    let mut keepalive = tokio::time::interval(Duration::from_secs(50));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await;

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                sink.send(Message::Text("ping".into())).await?;
            }
            msg = outbound_rx.recv() => {
                match msg {
                    Ok(frame) => {
                        let json = serde_json::to_string(&frame)?;
                        sink.send(Message::Text(json.into())).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            frame = stream.next() => {
                match frame {
                    None => anyhow::bail!("websocket closed"),
                    Some(Err(err)) => return Err(err.into()),
                    Some(Ok(Message::Close(_))) => anyhow::bail!("websocket close frame"),
                    Some(Ok(Message::Ping(p))) => {
                        sink.send(Message::Pong(p)).await?;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Text(text))) => {
                        if text == "ping" {
                            sink.send(Message::Text("pong".into())).await?;
                            continue;
                        }
                        if text == "pong" {
                            continue;
                        }
                        let parsed: CloudToAgent = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(err) => {
                                tracing::warn!(%text, %err, "grokcraft bad frame");
                                continue;
                            }
                        };
                        if let CloudToAgent::Ping { ts } = &parsed {
                            let pong = AgentToCloud::Pong { ts: *ts };
                            sink.send(Message::Text(serde_json::to_string(&pong)?.into())).await?;
                        }
                        if let CloudToAgent::Paired { machine_token, machine_id, .. } = &parsed {
                            store.machine_token = Some(machine_token.clone());
                            store.machine_id = machine_id.clone();
                            if let Err(err) = store::save(&store) {
                                tracing::warn!(%err, "failed to persist grokcraft pairing");
                            }
                        }
                        if let Some(ev) = event_from_cloud(parsed) {
                            hub.push_inbound(ev);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn current_machine(store: &store::GrokcraftStore) -> MachineInfo {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    };
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    MachineInfo {
        id: store.machine_id.clone(),
        hostname: hostname(),
        os: os.into(),
        cwd,
        grok_version: xai_grok_version::installed(),
        label: store.label.clone(),
    }
}
