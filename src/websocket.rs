use fastwebsockets::{Frame, Payload, WebSocketError, WebSocketWrite};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::WriteHalf;
use tokio::sync::{Mutex, mpsc};

pub struct WebSocket {
    pub state: ConnectionState,
    pub socket: Option<WebSocketWrite<WriteHalf<TokioIo<Upgraded>>>>,
    pub message_sender: mpsc::UnboundedSender<Frame<'static>>,
}

impl WebSocket {
    pub fn new(socket: WebSocketWrite<WriteHalf<TokioIo<Upgraded>>>) -> Self {
        let (message_sender, _) = mpsc::unbounded_channel();
        Self {
            state: ConnectionState::new(),
            socket: Some(socket),
            message_sender,
        }
    }

    pub fn get_socket_id(&self) -> &SocketId {
        &self.state.socket_id
    }

    pub async fn close(&mut self, code: u16, reason: String) -> crate::error::Result<()> {
        if let Some(mut socket) = self.socket.take() {
            let close_message = PusherMessage::error(code, reason.clone(), None);
            self.send_json(close_message).await?;
            let frame = Frame::close(code, &reason.into_bytes());
            socket.write_frame(frame).await?;
            Ok(())
        } else {
            Err(Error::ConnectionError(format!(
                "Failed to close connection: {}, reason: {}",
                code, reason
            )))
        }
    }
    pub async fn send_json(
        &mut self,
        message: impl serde::Serialize + Deserialize<'_> + Debug,
    ) -> crate::error::Result<()> {
        if let Some(socket) = &mut self.socket {
            let payload = Payload::from(serde_json::to_vec(&message)?);
            let frame = Frame::text(payload);
            socket.write_frame(frame).await?;
            Ok(())
        } else {
            Err(Error::ConnectionError(format!(
                "Failed to send message: {:?}",
                message
            )))
        }
    }
}

impl PartialEq for ConnectionState {
    fn eq(&self, other: &Self) -> bool {
        self.socket_id == other.socket_id
    }
}

impl PartialEq for WebSocket {
    fn eq(&self, other: &Self) -> bool {
        self.state == other.state
    }
}

impl Eq for WebSocket {
    fn assert_receiver_is_total_eq(&self) {
        self.state.socket_id.assert_receiver_is_total_eq();
    }
}

use crate::app::config::App;
use crate::channel::PresenceMemberInfo;
use crate::error::Error;
use crate::protocol::messages::PusherMessage;
use dashmap::DashMap;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::hash::Hash;
use std::sync::Arc;
use std::time::Instant;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub struct SocketId(pub String);

// Optional but recommended - implement Display for better debugging
impl std::fmt::Display for SocketId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

// Optional - implement AsRef for convenient string operations
impl AsRef<str> for SocketId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Default for SocketId {
    fn default() -> Self {
        Self::new()
    }
}

impl SocketId {
    pub fn new() -> Self {
        Self(Self::generate_socket_id())
    }

    pub(crate) fn generate_socket_id() -> String {
        let mut rng = rand::rng(); // Get a random number generator

        // Define min and max as u64, since Rust requires specifying the integer type
        let min: u64 = 0;
        let max: u64 = 10000000000;

        // Rust's rand crate handles generating a random number between min and max differently
        let mut random_number = |min: u64, max: u64| -> u64 { rng.random_range(min..=max) };

        // Format the random numbers into a String with a dot separator
        format!("{}.{}", random_number(min, max), random_number(min, max))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub id: String,
    pub watchlist: Option<Vec<String>>, // Add watchlist field
    pub info: Option<Value>,            // Additional user info
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionState {
    pub socket_id: SocketId,
    pub app: Option<App>,
    pub subscribed_channels: HashSet<String>,
    pub user_id: Option<String>,
    pub user_info: Option<UserInfo>, // Enhanced user info with watchlist
    pub last_ping: String,
    pub presence: Option<HashMap<String, PresenceMemberInfo>>,
    pub user: Option<Value>,
    #[serde(skip)] // Don't serialize task handles
    pub activity_timeout_handle: Option<JoinHandle<()>>, // Add this
    #[serde(skip)]
    pub auth_timeout_handle: Option<JoinHandle<()>>, // Add this
}

impl ConnectionState {
    pub fn new() -> Self {
        Self {
            socket_id: SocketId::new(),
            app: None,
            subscribed_channels: HashSet::new(),
            user_id: None,
            last_ping: String::new(),
            presence: None,
            user: None,
            user_info: None, // Initialize with None
            activity_timeout_handle: None,
            auth_timeout_handle: None,
        }
    }

    pub fn is_presence(&self) -> bool {
        self.presence.is_some()
    }

    pub fn is_subscribed(&self, channel: &str) -> bool {
        self.subscribed_channels.contains(channel)
    }

    pub fn add_subscription(&mut self, channel: String) {
        self.subscribed_channels.insert(channel);
    }

    pub fn remove_subscription(&mut self, channel: &str) {
        self.subscribed_channels.remove(channel);
    }

    pub fn update_ping(&mut self) {
        self.last_ping = chrono::Utc::now().to_rfc3339();
    }

    pub fn get_app_key(&self) -> String {
        match &self.app {
            Some(app) => app.key.clone(),
            None => String::new(),
        }
    }
}

impl PartialEq<String> for SocketId {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl Hash for WebSocket {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.state.socket_id.hash(state);
    }
}

#[derive(Clone)]
pub struct WebSocketRef(pub Arc<Mutex<WebSocket>>);

impl Hash for WebSocketRef {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        // Hash based on the Arc's pointer address
        std::ptr::addr_of!(self.0).hash(state);
    }
}

impl PartialEq for WebSocketRef {
    fn eq(&self, other: &Self) -> bool {
        // Compare based on Arc pointer equality
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for WebSocketRef {}
