//! Grokcraft agent client: protocol types, local machine store, and WebSocket hub.

pub mod client;
pub mod hub;
pub mod protocol;
pub mod store;

pub use client::run_client;
pub use hub::Hub;
pub use protocol::*;
pub use store::{load, load_or_create, save, store_path, GrokcraftStore};

pub const DEFAULT_ORIGIN: &str = "https://grokcraft.tanyuntech.cn";
