pub mod menu;
pub mod auth;
pub mod endpoints;
pub mod endpoint_detail;
pub mod tunnel;
pub mod listen;
pub mod request_detail;
pub mod search;
pub mod send;
pub mod usage;
pub mod update;

use crossterm::event::KeyEvent;
use ratatui::{layout::Rect, Frame};
use tokio::sync::mpsc;

use crate::api::ApiClient;

/// Messages from async tasks back to the TUI.
#[derive(Debug)]
pub enum Message {
    // Endpoint operations
    EndpointsLoaded(anyhow::Result<crate::types::EndpointList>),
    EndpointCreated(anyhow::Result<crate::types::Endpoint>),
    EndpointDeleted(anyhow::Result<String>),
    EndpointLoaded(anyhow::Result<crate::types::Endpoint>),

    // Request operations
    RequestsLoaded(anyhow::Result<crate::types::RequestList>),
    RequestLoaded(anyhow::Result<crate::types::CapturedRequest>),

    // SSE
    SseEvent(crate::types::SseEvent),
    SseError(String),

    // Tunnel
    ForwardResult {
        request_id: String,
        result: crate::types::ForwardResult,
    },

    // Auth
    DeviceCode(anyhow::Result<crate::types::DeviceCodeResponse>),
    AuthPoll(anyhow::Result<crate::types::PollResponse>),
    AuthClaimed(anyhow::Result<crate::types::ClaimResponse>),

    // Usage
    UsageLoaded(anyhow::Result<crate::types::UsageInfo>),

    // Send
    SendResult(anyhow::Result<crate::types::SendResponse>),
}

/// Actions that screens emit to the app.
#[derive(Debug, Clone)]
pub enum Action {
    Navigate(ScreenId),
    NavigateBack,
    Quit,
    SetAuthEmail(Option<String>),
}

/// Screen identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenId {
    Menu,
    Auth,
    Endpoints,
    EndpointDetail(String), // slug
    Tunnel,
    Listen,
    ListenSlug(String), // slug
    RequestDetail(String), // request ID
    Search,
    Send,
    Usage,
    Update,
}

/// Trait that all TUI screens implement.
pub trait Screen {
    /// Handle a key event. Return an action if needed.
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action>;

    /// Handle an async message.
    fn handle_message(&mut self, msg: Message);

    /// Render the screen.
    fn render(&mut self, frame: &mut Frame, area: Rect);

    /// Called when the screen becomes active.
    fn on_enter(&mut self, client: &ApiClient, tx: mpsc::UnboundedSender<Message>);

    /// Called when leaving the screen.
    fn on_leave(&mut self) {}

    /// Current breadcrumb segments.
    fn breadcrumb(&self) -> Vec<&str>;

    /// Status bar key hints.
    fn status_keys(&self) -> Vec<(&str, &str)>;

    /// Tick counter for animations (called on each Tick event).
    fn tick(&mut self) {}

    /// For downcasting.
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}
