//! Process-wide Grokcraft fan-out: outbound frames + inbound pager events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tokio::sync::{broadcast, mpsc};

use crate::protocol::{AgentToCloud, GrokcraftEvent};

const OUTBOUND_CAP: usize = 256;

pub struct Hub {
    pub outbound: broadcast::Sender<AgentToCloud>,
    inbound_tx: mpsc::UnboundedSender<GrokcraftEvent>,
    inbound_rx: Mutex<Option<mpsc::UnboundedReceiver<GrokcraftEvent>>>,
    connected: AtomicBool,
    client_started: AtomicBool,
    watching: AtomicBool,
    instance_id: String,
}

impl Hub {
    fn new() -> Self {
        let (outbound, _) = broadcast::channel(OUTBOUND_CAP);
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        Self {
            outbound,
            inbound_tx,
            inbound_rx: Mutex::new(Some(inbound_rx)),
            connected: AtomicBool::new(false),
            client_started: AtomicBool::new(false),
            watching: AtomicBool::new(false),
            instance_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn take_inbound_rx(&self) -> Option<mpsc::UnboundedReceiver<GrokcraftEvent>> {
        self.inbound_rx.lock().ok().and_then(|mut g| g.take())
    }

    pub fn emit(&self, msg: AgentToCloud) {
        let _ = self.outbound.send(msg);
    }

    pub fn push_inbound(&self, ev: GrokcraftEvent) {
        let _ = self.inbound_tx.send(ev);
    }

    pub fn set_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::SeqCst);
        if !connected {
            self.watching.store(false, Ordering::SeqCst);
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn set_watching(&self, watching: bool) {
        self.watching.store(watching, Ordering::SeqCst);
    }

    pub fn is_watching(&self) -> bool {
        self.watching.load(Ordering::SeqCst)
    }

    /// Returns `true` if the caller should spawn [`crate::client::run_client`].
    pub fn mark_client_started(&self) -> bool {
        !self.client_started.swap(true, Ordering::SeqCst)
    }
}

pub fn global() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(Hub::new)
}
