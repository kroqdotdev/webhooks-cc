use crossterm::event::KeyEvent;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::request_list::{RequestList, RequestListState};
use crate::tui::widgets::spinner::Spinner;
use crate::types::Endpoint;

use super::{Action, Message, Screen, ScreenId};

enum State {
    Loading,
    Loaded,
    Error(String),
}

pub struct EndpointDetailScreen {
    slug: String,
    state: State,
    endpoint: Option<Endpoint>,
    requests: RequestListState,
    webhook_url: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    client: Option<ApiClient>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

impl EndpointDetailScreen {
    pub fn new(slug: String, webhook_url: String) -> Self {
        Self {
            slug,
            state: State::Loading,
            endpoint: None,
            requests: RequestListState::new(),
            webhook_url,
            tx: None,
            client: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }
}

impl Screen for EndpointDetailScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
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
            return None;
        }

        // 'r' to refresh
        if keys::is_char(key, 'r') {
            self.load_data();
            return None;
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::EndpointLoaded(Ok(ep)) => {
                self.endpoint = Some(ep);
                self.state = State::Loaded;
            }
            Message::EndpointLoaded(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::RequestsLoaded(Ok(list)) => {
                self.requests.items = list.requests;
                if !self.requests.items.is_empty() && self.requests.selected == 0 {
                    self.requests.selected = 0;
                }
            }
            Message::RequestsLoaded(Err(_)) => {}
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        if let State::Loading = &self.state {
            frame.render_widget(
                Spinner::new(self.tick, "Loading endpoint..."),
                Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
            );
            return;
        }

        if let State::Error(msg) = &self.state {
            let p = Paragraph::new(Line::from(vec![
                Span::styled("  Error: ", theme::style_danger()),
                Span::styled(msg.as_str(), theme::style_dim()),
            ]));
            frame.render_widget(p, area);
            return;
        }

        let chunks = Layout::vertical([
            Constraint::Length(6), // Endpoint info
            Constraint::Min(8),   // Request list
        ])
        .split(area);

        // Endpoint info panel
        if let Some(ref ep) = self.endpoint {
            let url = format!("{}/w/{}", self.webhook_url, ep.slug);
            let mut lines = vec![
                Line::from(vec![
                    Span::styled("  URL:       ", theme::style_muted()),
                    Span::styled(&url, theme::style_bold()),
                ]),
                Line::from(vec![
                    Span::styled("  Name:      ", theme::style_muted()),
                    Span::styled(
                        ep.name.as_deref().unwrap_or("—"),
                        theme::style(),
                    ),
                ]),
                Line::from(vec![
                    Span::styled("  Requests:  ", theme::style_muted()),
                    Span::styled(ep.request_count.unwrap_or(0).to_string(), theme::style()),
                ]),
            ];

            if let Some(ref mock) = ep.mock_response {
                lines.push(Line::from(vec![
                    Span::styled("  Mock:      ", theme::style_muted()),
                    Span::styled(
                        format!("{} — {}", mock.status, &mock.body.chars().take(40).collect::<String>()),
                        Style::default().fg(theme::ACCENT),
                    ),
                ]));
            }

            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    format!(" {} ", ep.slug),
                    theme::style_primary_bold(),
                ))
                .padding(Padding::new(0, 0, 0, 0));

            frame.render_widget(Paragraph::new(lines).block(block), chunks[0]);
        }

        // Request list
        let list = RequestList::new("Recent Requests");
        frame.render_stateful_widget(list, chunks[1], &mut self.requests);
    }

    fn on_enter(&mut self, client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx);
        self.client = Some(client.clone());
        self.load_data();
    }

    fn on_leave(&mut self) {
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Endpoints", &self.slug]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![
            ("↑↓", "navigate"),
            ("enter", "inspect"),
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

impl EndpointDetailScreen {
    fn load_data(&mut self) {
        // Abort any in-flight tasks before spawning new ones
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.state = State::Loading;
        if let (Some(tx), Some(client)) = (&self.tx, &self.client) {
            let tx1 = tx.clone();
            let tx2 = tx.clone();
            let slug = self.slug.clone();
            let slug2 = self.slug.clone();
            let client = client.clone();
            let c2 = client.clone();

            let h1 = tokio::spawn(async move {
                let result = client.get_endpoint(&slug).await;
                let _ = tx1.send(Message::EndpointLoaded(result));
            });
            let h2 = tokio::spawn(async move {
                let result = c2.list_requests(&slug2, Some(50), None).await;
                let _ = tx2.send(Message::RequestsLoaded(result));
            });
            self.tasks.push(h1);
            self.tasks.push(h2);
        }
    }
}
