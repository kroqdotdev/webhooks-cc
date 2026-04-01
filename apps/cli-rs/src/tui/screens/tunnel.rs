use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph},
    Frame,
};
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tunnel::{parse_target, Tunnel};
use crate::tui::{keys, theme};
use crate::tui::widgets::request_list::{RequestList, RequestListState};
use crate::tui::widgets::spinner::Spinner;
use crate::types::{CreateEndpointRequest, ForwardResult, SseEvent};

use super::{Action, Message, Screen, ScreenId};

enum State {
    Input,
    Connecting,
    Active,
    Error(String),
}

pub struct TunnelScreen {
    state: State,
    input: String,
    slug: Option<String>,
    webhook_url_str: Option<String>,
    target_url: Option<String>,
    requests: RequestListState,
    forward_results: HashMap<String, ForwardResult>,
    webhook_url: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    tick: usize,
}

impl TunnelScreen {
    pub fn new(webhook_url: String) -> Self {
        Self {
            state: State::Input,
            input: String::new(),
            slug: None,
            webhook_url_str: None,
            target_url: None,
            requests: RequestListState::new(),
            forward_results: HashMap::new(),
            webhook_url,
            tx: None,
            tick: 0,
        }
    }
}

impl Screen for TunnelScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        match &self.state {
            State::Input => {
                match key.code {
                    KeyCode::Enter => {
                        match parse_target(&self.input) {
                            Ok(target) => {
                                self.target_url = Some(target);
                                self.state = State::Connecting;
                                self.start_tunnel();
                            }
                            Err(e) => {
                                self.state = State::Error(e.to_string());
                            }
                        }
                        return None;
                    }
                    KeyCode::Esc => return Some(Action::NavigateBack),
                    KeyCode::Char(c) if c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.' || c == ':' => {
                        self.input.push(c);
                        return None;
                    }
                    KeyCode::Backspace => {
                        self.input.pop();
                        return None;
                    }
                    _ => {}
                }
                if keys::is_quit(key) {
                    return Some(Action::Quit);
                }
            }
            State::Active => {
                if keys::is_back(key) || keys::is_quit(key) {
                    // Cleanup: delete ephemeral endpoint
                    if let Some(ref slug) = self.slug {
                        let slug = slug.clone();
                        if let Ok(client) = ApiClient::new(None, None) {
                            tokio::spawn(async move {
                                let _ = client.delete_endpoint(&slug).await;
                            });
                        }
                    }
                    return Some(Action::NavigateBack);
                }

                if keys::is_up(key) {
                    self.requests.select_prev();
                    return None;
                }
                if keys::is_down(key) {
                    self.requests.select_next();
                    return None;
                }
                if keys::is_enter(key) {
                    if let Some(req) = self.requests.selected_item() {
                        return Some(Action::Navigate(ScreenId::RequestDetail(req.id.clone())));
                    }
                }
            }
            State::Connecting => {
                if keys::is_back(key) {
                    return Some(Action::NavigateBack);
                }
            }
            State::Error(_) => {
                if keys::is_enter(key) || keys::is_back(key) {
                    self.state = State::Input;
                    return None;
                }
            }
        }
        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::EndpointCreated(Ok(ep)) => {
                let slug = ep.slug.clone();
                let url = format!("{}/w/{}", self.webhook_url, slug);
                self.slug = Some(slug.clone());
                self.webhook_url_str = Some(url);
                self.state = State::Active;

                // Start SSE stream
                if let Some(ref tx) = self.tx {
                    let tx = tx.clone();
                    if let Ok(client) = ApiClient::new(None, None) {
                        let stream_slug = slug.clone();
                        tokio::spawn(async move {
                            let (sse_tx, mut sse_rx) = mpsc::channel(64);
                            let stream_handle = tokio::spawn(async move {
                                let _ = client.stream_requests(&stream_slug, sse_tx).await;
                            });

                            while let Some(event) = sse_rx.recv().await {
                                if tx.send(Message::SseEvent(event)).is_err() {
                                    break;
                                }
                            }
                            stream_handle.abort();
                        });
                    }
                }
            }
            Message::EndpointCreated(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::SseEvent(SseEvent::Request(req)) => {
                let req_id = req.id.clone();
                let req_for_fwd = req.clone();
                self.requests.push(req);

                // Forward the request
                if let Some(ref target) = self.target_url {
                    let Ok(tunnel) = Tunnel::new(target.clone(), HashMap::new()) else { return };
                    if let Some(ref tx) = self.tx {
                        let tx = tx.clone();
                        let rid = req_id.clone();
                        tokio::spawn(async move {
                            let result = tunnel.forward(&req_for_fwd).await;
                            let _ = tx.send(Message::ForwardResult {
                                request_id: rid,
                                result,
                            });
                        });
                    }
                }
            }
            Message::SseEvent(SseEvent::EndpointDeleted) => {
                self.state = State::Error("Endpoint was deleted.".into());
            }
            Message::ForwardResult { request_id, result } => {
                self.forward_results.insert(request_id, result);
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        match &self.state {
            State::Input => {
                let chunks = Layout::vertical([
                    Constraint::Length(3),
                    Constraint::Length(5),
                    Constraint::Min(0),
                ])
                .split(area);

                let hint = Paragraph::new(Line::from(vec![
                    Span::styled("  Enter port", theme::style_dim()),
                    Span::styled(" (e.g. 8080 or 3000/api/webhooks)", theme::style_muted()),
                ]));
                frame.render_widget(hint, chunks[0]);

                let input_block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::PRIMARY))
                    .title(Span::styled(" Target ", theme::style_primary_bold()))
                    .padding(Padding::horizontal(1));

                let input_text = Paragraph::new(Line::from(vec![
                    Span::styled("localhost:", theme::style_dim()),
                    Span::styled(&self.input, theme::style_bold()),
                    Span::styled("█", theme::style_primary()),
                ]))
                .block(input_block);

                frame.render_widget(input_text, chunks[1]);
            }
            State::Connecting => {
                frame.render_widget(
                    Spinner::new(self.tick, "Creating endpoint and connecting..."),
                    Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
                );
            }
            State::Active => {
                let chunks = Layout::vertical([
                    Constraint::Length(4), // Connection info
                    Constraint::Min(8),   // Request list
                ])
                .split(area);

                // Connection info
                let url = self.webhook_url_str.as_deref().unwrap_or("—");
                let target = self.target_url.as_deref().unwrap_or("—");

                let info = Paragraph::new(vec![
                    Line::from(vec![
                        Span::styled("  ● ", theme::style_success()),
                        Span::styled("Tunnel active", theme::style_success()),
                    ]),
                    Line::from(vec![
                        Span::styled("  Webhook URL:   ", theme::style_muted()),
                        Span::styled(url, theme::style_bold()),
                    ]),
                    Line::from(vec![
                        Span::styled("  Forwarding to: ", theme::style_muted()),
                        Span::styled(target, theme::style()),
                    ]),
                ]);
                frame.render_widget(info, chunks[0]);

                // Request list with forward status
                let list = RequestList::new("Requests").show_forward_status();
                frame.render_stateful_widget(list, chunks[1], &mut self.requests);
            }
            State::Error(msg) => {
                let p = Paragraph::new(vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✗ ", theme::style_danger()),
                        Span::styled(msg.as_str(), theme::style_dim()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled("  Press Enter to try again.", theme::style_muted())),
                ]);
                frame.render_widget(p, area);
            }
        }
    }

    fn on_enter(&mut self, _client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx);
    }

    fn on_leave(&mut self) {
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Tunnel"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        match &self.state {
            State::Input => vec![("enter", "connect"), ("esc", "back")],
            State::Active => vec![("↑↓", "navigate"), ("enter", "inspect"), ("esc", "stop")],
            _ => vec![("esc", "back")],
        }
    }

    fn tick(&mut self) {
        self.tick += 1;
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl TunnelScreen {
    fn start_tunnel(&self) {
        if let Some(ref tx) = self.tx {
            let tx = tx.clone();
            if let Ok(client) = ApiClient::new(None, None) {
                tokio::spawn(async move {
                    let req = CreateEndpointRequest {
                        name: None,
                        is_ephemeral: Some(true),
                        expires_at: None,
                        mock_response: None,
                    };
                    let result = client.create_endpoint(&req).await;
                    let _ = tx.send(Message::EndpointCreated(result));
                });
            }
        }
    }
}
