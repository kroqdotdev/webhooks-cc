use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph, Row, Table, TableState},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::spinner::Spinner;
use crate::types::{CreateEndpointRequest, Endpoint};

use super::{Action, Message, Screen, ScreenId};

enum State {
    Loading,
    Loaded,
    Creating(String), // input buffer
    Deleting(usize),  // index to delete
    Error(String),
}

pub struct EndpointsScreen {
    state: State,
    endpoints: Vec<Endpoint>,
    table_state: TableState,
    webhook_url: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    tick: usize,
}

impl EndpointsScreen {
    pub fn new(webhook_url: String) -> Self {
        Self {
            state: State::Loading,
            endpoints: Vec::new(),
            table_state: TableState::default(),
            webhook_url,
            tx: None,
            tick: 0,
        }
    }
}

impl Screen for EndpointsScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        // Handle creating state first
        if let State::Creating(ref mut input) = self.state {
            match key.code {
                KeyCode::Enter => {
                    let name = if input.is_empty() {
                        None
                    } else {
                        Some(input.clone())
                    };
                    if let Some(ref tx) = self.tx {
                        let tx = tx.clone();
                        let client = ApiClient::new(None, None).ok();
                        if let Some(client) = client {
                            tokio::spawn(async move {
                                let req = CreateEndpointRequest {
                                    name,
                                    is_ephemeral: None,
                                    expires_at: None,
                                    mock_response: None,
                                };
                                let result = client.create_endpoint(&req).await;
                                let _ = tx.send(Message::EndpointCreated(result));
                            });
                        }
                    }
                    self.state = State::Loading;
                    return None;
                }
                KeyCode::Esc => {
                    self.state = State::Loaded;
                    return None;
                }
                KeyCode::Char(c) => {
                    input.push(c);
                    return None;
                }
                KeyCode::Backspace => {
                    input.pop();
                    return None;
                }
                _ => return None,
            }
        }

        // Handle confirming delete
        if let State::Deleting(idx) = self.state {
            if keys::is_char(key, 'y') {
                if let Some(ep) = self.endpoints.get(idx) {
                    let slug = ep.slug.clone();
                    if let Some(ref tx) = self.tx {
                        let tx = tx.clone();
                        let client = ApiClient::new(None, None).ok();
                        if let Some(client) = client {
                            tokio::spawn(async move {
                                let result = client.delete_endpoint(&slug).await.map(|_| slug);
                                let _ = tx.send(Message::EndpointDeleted(result));
                            });
                        }
                    }
                }
                self.state = State::Loading;
                return None;
            } else {
                self.state = State::Loaded;
                return None;
            }
        }

        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        if keys::is_up(key) {
            let i = self.table_state.selected().unwrap_or(0);
            self.table_state.select(Some(i.saturating_sub(1)));
            return None;
        }
        if keys::is_down(key) {
            let i = self.table_state.selected().unwrap_or(0);
            let max = self.endpoints.len().saturating_sub(1);
            self.table_state.select(Some((i + 1).min(max)));
            return None;
        }

        if keys::is_enter(key) {
            if let Some(i) = self.table_state.selected() {
                if let Some(ep) = self.endpoints.get(i) {
                    return Some(Action::Navigate(ScreenId::EndpointDetail(ep.slug.clone())));
                }
            }
            return None;
        }

        // 'n' for new
        if keys::is_char(key, 'n') {
            self.state = State::Creating(String::new());
            return None;
        }

        // 'd' for delete
        if keys::is_char(key, 'd') {
            if let Some(i) = self.table_state.selected() {
                self.state = State::Deleting(i);
            }
            return None;
        }

        // 'r' to refresh
        if keys::is_char(key, 'r') {
            if let Some(ref tx) = self.tx {
                self.state = State::Loading;
                let tx = tx.clone();
                let client = ApiClient::new(None, None).ok();
                if let Some(client) = client {
                    tokio::spawn(async move {
                        let result = client.list_endpoints().await;
                        let _ = tx.send(Message::EndpointsLoaded(result));
                    });
                }
            }
            return None;
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::EndpointsLoaded(Ok(list)) => {
                self.endpoints = list.owned;
                self.endpoints.extend(list.shared);
                self.endpoints.sort_by(|a, b| a.slug.cmp(&b.slug));
                if !self.endpoints.is_empty() && self.table_state.selected().is_none() {
                    self.table_state.select(Some(0));
                }
                self.state = State::Loaded;
            }
            Message::EndpointsLoaded(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::EndpointCreated(Ok(_ep)) => {
                // Refresh the list
                if let Some(ref tx) = self.tx {
                    let tx = tx.clone();
                    let client = ApiClient::new(None, None).ok();
                    if let Some(client) = client {
                        tokio::spawn(async move {
                            let result = client.list_endpoints().await;
                            let _ = tx.send(Message::EndpointsLoaded(result));
                        });
                    }
                }
            }
            Message::EndpointCreated(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::EndpointDeleted(Ok(_slug)) => {
                // Refresh
                if let Some(ref tx) = self.tx {
                    let tx = tx.clone();
                    let client = ApiClient::new(None, None).ok();
                    if let Some(client) = client {
                        tokio::spawn(async move {
                            let result = client.list_endpoints().await;
                            let _ = tx.send(Message::EndpointsLoaded(result));
                        });
                    }
                }
            }
            Message::EndpointDeleted(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        match &self.state {
            State::Loading => {
                frame.render_widget(
                    Spinner::new(self.tick, "Loading endpoints..."),
                    Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
                );
                return;
            }
            State::Error(msg) => {
                let p = Paragraph::new(Line::from(vec![
                    Span::styled("  Error: ", theme::style_danger()),
                    Span::styled(msg, theme::style_dim()),
                ]));
                frame.render_widget(p, area);
                return;
            }
            _ => {}
        }

        let chunks = Layout::vertical([
            Constraint::Min(0),   // Table
            Constraint::Length(2), // Footer
        ])
        .split(area);

        // Endpoint table
        let header = Row::new(vec!["  SLUG", "NAME", "REQUESTS", "URL"])
            .style(theme::style_muted());

        let rows: Vec<Row> = self
            .endpoints
            .iter()
            .map(|ep| {
                let name = ep.name.as_deref().unwrap_or("—");
                let url = format!("{}/w/{}", self.webhook_url, ep.slug);
                let count = ep.request_count.to_string();
                Row::new(vec![
                    format!("  {}", ep.slug),
                    name.to_string(),
                    count,
                    url,
                ])
            })
            .collect();

        let widths = [
            Constraint::Length(22),
            Constraint::Length(20),
            Constraint::Length(10),
            Constraint::Min(30),
        ];

        let table = Table::new(rows, widths)
            .header(header)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::BORDER))
                    .title(Span::styled(
                        format!(" Endpoints ({}) ", self.endpoints.len()),
                        theme::style_bold(),
                    ))
                    .padding(Padding::vertical(0)),
            )
            .row_highlight_style(theme::style_highlight());

        frame.render_stateful_widget(table, chunks[0], &mut self.table_state);

        // Creating / Deleting overlay
        match &self.state {
            State::Creating(input) => {
                let line = Line::from(vec![
                    Span::styled("  Name: ", theme::style_dim()),
                    Span::styled(input, theme::style_bold()),
                    Span::styled("█", theme::style_primary()),
                    Span::styled("  (Enter to create, Esc to cancel)", theme::style_muted()),
                ]);
                frame.render_widget(Paragraph::new(line), chunks[1]);
            }
            State::Deleting(idx) => {
                let slug = self
                    .endpoints
                    .get(*idx)
                    .map(|e| e.slug.as_str())
                    .unwrap_or("?");
                let line = Line::from(vec![
                    Span::styled("  Delete ", theme::style_danger()),
                    Span::styled(slug, theme::style_bold()),
                    Span::styled("? (y/n)", theme::style_dim()),
                ]);
                frame.render_widget(Paragraph::new(line), chunks[1]);
            }
            _ => {}
        }
    }

    fn on_enter(&mut self, _client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx.clone());
        self.state = State::Loading;

        let client = ApiClient::new(None, None).ok();
        if let Some(client) = client {
            tokio::spawn(async move {
                let result = client.list_endpoints().await;
                let _ = tx.send(Message::EndpointsLoaded(result));
            });
        }
    }

    fn on_leave(&mut self) {
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Endpoints"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![
            ("↑↓", "navigate"),
            ("enter", "detail"),
            ("n", "new"),
            ("d", "delete"),
            ("r", "refresh"),
            ("esc", "back"),
        ]
    }

    fn tick(&mut self) {
        self.tick += 1;
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
