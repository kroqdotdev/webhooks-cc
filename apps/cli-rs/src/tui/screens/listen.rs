use crossterm::event::KeyEvent;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Row, Table, TableState},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::request_list::{RequestList, RequestListState};
use crate::tui::widgets::spinner::Spinner;
use crate::types::{Endpoint, SseEvent};

use super::{Action, Message, Screen, ScreenId};

enum State {
    LoadingEndpoints,
    Picking,
    Connecting,
    Streaming,
    Error(String),
}

pub struct ListenScreen {
    state: State,
    endpoints: Vec<Endpoint>,
    table_state: TableState,
    slug: Option<String>,
    requests: RequestListState,
    webhook_url: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    client: Option<ApiClient>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

impl ListenScreen {
    pub fn new(webhook_url: String) -> Self {
        Self {
            state: State::LoadingEndpoints,
            endpoints: Vec::new(),
            table_state: TableState::default(),
            slug: None,
            requests: RequestListState::new(),
            webhook_url,
            tx: None,
            client: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }

}

impl Screen for ListenScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        match &self.state {
            State::Picking => {
                if keys::is_back(key) {
                    return Some(Action::NavigateBack);
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
                            self.slug = Some(ep.slug.clone());
                            self.state = State::Connecting;
                            self.start_stream();
                        }
                    }
                    return None;
                }
            }
            State::Streaming => {
                if keys::is_back(key) {
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
            State::Error(_) => {
                if keys::is_back(key) || keys::is_enter(key) {
                    return Some(Action::NavigateBack);
                }
            }
            _ => {
                if keys::is_back(key) {
                    return Some(Action::NavigateBack);
                }
            }
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::EndpointsLoaded(Ok(list)) => {
                self.endpoints = list.owned;
                self.endpoints.extend(list.shared);
                if !self.endpoints.is_empty() {
                    self.table_state.select(Some(0));
                }
                self.state = State::Picking;
            }
            Message::EndpointsLoaded(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::SseEvent(SseEvent::Connected) => {
                self.state = State::Streaming;
            }
            Message::SseEvent(SseEvent::Request(req)) => {
                self.state = State::Streaming;
                self.requests.push(req);
            }
            Message::SseEvent(SseEvent::EndpointDeleted) => {
                self.state = State::Error("Endpoint was deleted.".into());
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        match &self.state {
            State::LoadingEndpoints => {
                frame.render_widget(
                    Spinner::new(self.tick, "Loading endpoints..."),
                    Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
                );
            }
            State::Picking => {
                let rows: Vec<Row> = self
                    .endpoints
                    .iter()
                    .map(|ep| {
                        Row::new(vec![
                            format!("  {}", ep.slug),
                            ep.name.clone().unwrap_or_else(|| "—".into()),
                        ])
                    })
                    .collect();

                let header = Row::new(vec!["  SLUG", "NAME"]).style(theme::style_muted());
                let widths = [Constraint::Length(24), Constraint::Min(20)];

                let table = Table::new(rows, widths)
                    .header(header)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(theme::BORDER))
                            .title(Span::styled(" Select Endpoint ", theme::style_bold())),
                    )
                    .row_highlight_style(theme::style_highlight());

                frame.render_stateful_widget(table, area, &mut self.table_state);
            }
            State::Connecting => {
                frame.render_widget(
                    Spinner::new(self.tick, "Connecting to stream..."),
                    Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
                );
            }
            State::Streaming => {
                let chunks = Layout::vertical([
                    Constraint::Length(3), // Info
                    Constraint::Min(8),   // Request list
                ])
                .split(area);

                let slug = self.slug.as_deref().unwrap_or("—");
                let url = format!("{}/w/{}", self.webhook_url, slug);

                let info = Paragraph::new(vec![
                    Line::from(vec![
                        Span::styled("  ● ", theme::style_success()),
                        Span::styled(format!("Listening on {slug}"), theme::style_success()),
                    ]),
                    Line::from(vec![
                        Span::styled("  Webhook URL: ", theme::style_muted()),
                        Span::styled(&url, theme::style_bold()),
                    ]),
                ]);
                frame.render_widget(info, chunks[0]);

                let list = RequestList::new("Incoming Requests");
                frame.render_stateful_widget(list, chunks[1], &mut self.requests);
            }
            State::Error(msg) => {
                let p = Paragraph::new(vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✗ ", theme::style_danger()),
                        Span::styled(msg.as_str(), theme::style_dim()),
                    ]),
                ]);
                frame.render_widget(p, area);
            }
        }
    }

    fn on_enter(&mut self, client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx.clone());
        self.client = Some(client.clone());

        if self.slug.is_some() {
            // Direct slug — start streaming
            self.start_stream();
        } else {
            // Load endpoints for picker
            let client = client.clone();
            let handle = tokio::spawn(async move {
                let result = client.list_endpoints().await;
                let _ = tx.send(Message::EndpointsLoaded(result));
            });
            self.tasks.push(handle);
        }
    }

    fn on_leave(&mut self) {
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        match &self.slug {
            Some(_) => vec!["Listen"],
            None => vec!["Listen"],
        }
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        match &self.state {
            State::Picking => vec![("↑↓", "navigate"), ("enter", "select"), ("esc", "back")],
            State::Streaming => vec![("↑↓", "navigate"), ("enter", "inspect"), ("esc", "stop")],
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

impl ListenScreen {
    fn start_stream(&mut self) {
        if let (Some(slug), Some(tx), Some(client)) = (&self.slug, &self.tx, &self.client) {
            let slug = slug.clone();
            let tx = tx.clone();
            let client = client.clone();

            let handle = tokio::spawn(async move {
                let (sse_tx, mut sse_rx) = mpsc::channel(64);
                let stream_handle = tokio::spawn({
                    let slug = slug.clone();
                    async move {
                        let _ = client.stream_requests(&slug, sse_tx).await;
                    }
                });

                while let Some(event) = sse_rx.recv().await {
                    if tx.send(Message::SseEvent(event)).is_err() {
                        break;
                    }
                }
                stream_handle.abort();
            });
            self.tasks.push(handle);
        }
    }
}
