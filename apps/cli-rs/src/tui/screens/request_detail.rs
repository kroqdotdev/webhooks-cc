use crossterm::event::KeyEvent;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph, Wrap},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::spinner::Spinner;
use crate::types::CapturedRequest;
use crate::util::format::{format_bytes, format_timestamp};

use super::{Action, Message, Screen};

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Overview,
    Headers,
    Body,
}

const TABS: &[(&str, Tab)] = &[
    ("Overview", Tab::Overview),
    ("Headers", Tab::Headers),
    ("Body", Tab::Body),
];

pub struct RequestDetailScreen {
    request_id: String,
    request: Option<CapturedRequest>,
    active_tab: Tab,
    scroll: u16,
    loading: bool,
    error: Option<String>,
    tx: Option<mpsc::UnboundedSender<Message>>,
    tick: usize,
}

impl RequestDetailScreen {
    pub fn new(request_id: String) -> Self {
        Self {
            request_id,
            request: None,
            active_tab: Tab::Overview,
            scroll: 0,
            loading: true,
            error: None,
            tx: None,
            tick: 0,
        }
    }
}

impl Screen for RequestDetailScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        // Tab switching with Tab key or 1/2/3
        if keys::is_tab(key) {
            self.active_tab = match self.active_tab {
                Tab::Overview => Tab::Headers,
                Tab::Headers => Tab::Body,
                Tab::Body => Tab::Overview,
            };
            self.scroll = 0;
            return None;
        }
        if keys::is_backtab(key) {
            self.active_tab = match self.active_tab {
                Tab::Overview => Tab::Body,
                Tab::Headers => Tab::Overview,
                Tab::Body => Tab::Headers,
            };
            self.scroll = 0;
            return None;
        }
        if keys::is_char(key, '1') {
            self.active_tab = Tab::Overview;
            self.scroll = 0;
            return None;
        }
        if keys::is_char(key, '2') {
            self.active_tab = Tab::Headers;
            self.scroll = 0;
            return None;
        }
        if keys::is_char(key, '3') {
            self.active_tab = Tab::Body;
            self.scroll = 0;
            return None;
        }

        // Scrolling
        if keys::is_up(key) {
            self.scroll = self.scroll.saturating_sub(1);
            return None;
        }
        if keys::is_down(key) {
            self.scroll += 1;
            return None;
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        if let Message::RequestLoaded(result) = msg {
            self.loading = false;
            match result {
                Ok(req) => self.request = Some(req),
                Err(e) => self.error = Some(e.to_string()),
            }
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        if self.loading {
            frame.render_widget(
                Spinner::new(self.tick, "Loading request..."),
                Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), 1),
            );
            return;
        }

        if let Some(ref msg) = self.error {
            let p = Paragraph::new(Line::from(vec![
                Span::styled("  Error: ", theme::style_danger()),
                Span::styled(msg.as_str(), theme::style_dim()),
            ]));
            frame.render_widget(p, area);
            return;
        }

        let req = match &self.request {
            Some(r) => r,
            None => return,
        };

        let chunks = Layout::vertical([
            Constraint::Length(3), // Tab bar
            Constraint::Min(0),   // Content
        ])
        .split(area);

        // Tab bar
        render_tabs(frame, chunks[0], self.active_tab);

        // Content based on active tab
        let content_area = chunks[1];
        match self.active_tab {
            Tab::Overview => render_overview(frame, content_area, req, self.scroll),
            Tab::Headers => render_headers(frame, content_area, req, self.scroll),
            Tab::Body => render_body(frame, content_area, req, self.scroll),
        }
    }

    fn on_enter(&mut self, _client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx.clone());
        self.loading = true;

        let id = self.request_id.clone();
        if let Ok(client) = ApiClient::new(None, None) {
            tokio::spawn(async move {
                let result = client.get_request(&id).await;
                let _ = tx.send(Message::RequestLoaded(result));
            });
        }
    }

    fn on_leave(&mut self) {
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Request"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![
            ("tab", "switch tab"),
            ("1-3", "jump tab"),
            ("↑↓", "scroll"),
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

fn render_tabs(frame: &mut Frame, area: Rect, active: Tab) {
    let mut spans: Vec<Span> = vec![Span::raw("  ")];

    for (i, (label, tab)) in TABS.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled("  │  ", theme::style_muted()));
        }

        if *tab == active {
            spans.push(Span::styled(
                format!(" {label} "),
                Style::default()
                    .fg(theme::SURFACE)
                    .bg(theme::PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(format!(" {label} "), theme::style_dim()));
        }
    }

    let block = Block::default()
        .borders(Borders::BOTTOM)
        .border_style(Style::default().fg(theme::BORDER));

    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height > 0 {
        frame.render_widget(Paragraph::new(Line::from(spans)), inner);
    }
}

fn render_overview(frame: &mut Frame, area: Rect, req: &CapturedRequest, scroll: u16) {
    let method_style = Style::default()
        .fg(theme::method_color(&req.method))
        .add_modifier(Modifier::BOLD);

    let mut lines = vec![
        Line::from(""),
        Line::from(vec![
            Span::styled("  Method:       ", theme::style_muted()),
            Span::styled(&req.method, method_style),
        ]),
        Line::from(vec![
            Span::styled("  Path:         ", theme::style_muted()),
            Span::styled(&req.path, theme::style_bold()),
        ]),
        Line::from(vec![
            Span::styled("  IP:           ", theme::style_muted()),
            Span::styled(&req.ip, theme::style()),
        ]),
        Line::from(vec![
            Span::styled("  Size:         ", theme::style_muted()),
            Span::styled(format_bytes(req.size), theme::style()),
        ]),
        Line::from(vec![
            Span::styled("  Received:     ", theme::style_muted()),
            Span::styled(format_timestamp(req.received_at), theme::style()),
        ]),
    ];

    if let Some(ref ct) = req.content_type {
        lines.push(Line::from(vec![
            Span::styled("  Content-Type: ", theme::style_muted()),
            Span::styled(ct.as_str(), theme::style()),
        ]));
    }

    if !req.query_params.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("  Query Parameters", theme::style_primary_bold())));
        for (k, v) in &req.query_params {
            lines.push(Line::from(vec![
                Span::styled(format!("    {k}"), theme::style_bold()),
                Span::styled(" = ", theme::style_muted()),
                Span::styled(v.as_str(), theme::style()),
            ]));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("  ID: ", theme::style_muted()),
        Span::styled(&req.id, theme::style_dim()),
    ]));

    let p = Paragraph::new(lines)
        .scroll((scroll, 0));
    frame.render_widget(p, area);
}

fn render_headers(frame: &mut Frame, area: Rect, req: &CapturedRequest, scroll: u16) {
    let mut headers: Vec<_> = req.headers.iter().collect();
    headers.sort_by_key(|(k, _)| k.to_lowercase());

    let mut lines = vec![Line::from("")];
    for (k, v) in headers {
        lines.push(Line::from(vec![
            Span::styled(format!("  {k}"), theme::style_bold()),
            Span::styled(": ", theme::style_muted()),
            Span::styled(v.as_str(), theme::style()),
        ]));
    }

    if lines.len() == 1 {
        lines.push(Line::from(Span::styled("  No headers.", theme::style_muted())));
    }

    let p = Paragraph::new(lines)
        .scroll((scroll, 0));
    frame.render_widget(p, area);
}

fn render_body(frame: &mut Frame, area: Rect, req: &CapturedRequest, scroll: u16) {
    let body = match &req.body {
        Some(b) if !b.is_empty() => b.clone(),
        _ => {
            let p = Paragraph::new(Line::from(Span::styled("  No body.", theme::style_muted())));
            frame.render_widget(p, area);
            return;
        }
    };

    // Try to pretty-print JSON
    let formatted = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
        serde_json::to_string_pretty(&val).unwrap_or(body)
    } else {
        body
    };

    let lines: Vec<Line> = std::iter::once(Line::from(""))
        .chain(formatted.lines().map(|l| {
            Line::from(Span::styled(format!("  {l}"), theme::style()))
        }))
        .collect();

    let block = Block::default().padding(Padding::new(0, 0, 0, 0));

    let p = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(p, area);
}
