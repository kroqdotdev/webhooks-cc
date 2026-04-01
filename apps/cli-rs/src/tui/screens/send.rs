use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph, Wrap},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::spinner::Spinner;
use crate::types::{SendResponse, SendWebhookRequest};

use super::{Action, Message, Screen};

#[derive(Clone, Copy, PartialEq)]
enum Field {
    Slug,
    Method,
    Body,
}

const FIELDS: &[Field] = &[Field::Slug, Field::Method, Field::Body];

enum State {
    Editing,
    Sending,
    Done(SendResponse),
    Error(String),
}

pub struct SendScreen {
    state: State,
    active_field: Field,
    slug: String,
    method: String,
    body: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    client: Option<ApiClient>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

impl SendScreen {
    pub fn new() -> Self {
        Self {
            state: State::Editing,
            active_field: Field::Slug,
            slug: String::new(),
            method: "POST".into(),
            body: String::new(),
            tx: None,
            client: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }

    fn active_input(&mut self) -> &mut String {
        match self.active_field {
            Field::Slug => &mut self.slug,
            Field::Method => &mut self.method,
            Field::Body => &mut self.body,
        }
    }

    fn send_webhook(&mut self) {
        if self.slug.is_empty() {
            self.state = State::Error("Slug is required.".into());
            return;
        }

        if let (Some(tx), Some(client)) = (&self.tx, &self.client) {
            self.state = State::Sending;
            let tx = tx.clone();
            let client = client.clone();
            let req = SendWebhookRequest {
                method: self.method.clone(),
                slug: self.slug.clone(),
                path: None,
                headers: None,
                body: if self.body.is_empty() {
                    None
                } else {
                    Some(self.body.clone())
                },
            };

            let handle = tokio::spawn(async move {
                let result = client.send_webhook(&req).await;
                let _ = tx.send(Message::SendResult(result));
            });
            self.tasks.push(handle);
        }
    }
}

impl Screen for SendScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        match &self.state {
            State::Editing => {
                if keys::is_back(key) {
                    return Some(Action::NavigateBack);
                }
                match key.code {
                    KeyCode::Tab => {
                        let idx = FIELDS.iter().position(|f| *f == self.active_field).unwrap_or(0);
                        self.active_field = FIELDS[(idx + 1) % FIELDS.len()];
                        return None;
                    }
                    KeyCode::BackTab => {
                        let idx = FIELDS.iter().position(|f| *f == self.active_field).unwrap_or(0);
                        self.active_field = FIELDS[(idx + FIELDS.len() - 1) % FIELDS.len()];
                        return None;
                    }
                    KeyCode::Enter => {
                        self.send_webhook();
                        return None;
                    }
                    KeyCode::Char(c) => {
                        self.active_input().push(c);
                        return None;
                    }
                    KeyCode::Backspace => {
                        self.active_input().pop();
                        return None;
                    }
                    _ => {}
                }
            }
            State::Done(_) | State::Error(_) => {
                if keys::is_enter(key) || keys::is_back(key) {
                    self.state = State::Editing;
                    return None;
                }
            }
            State::Sending => {}
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        if let Message::SendResult(result) = msg {
            match result {
                Ok(resp) => self.state = State::Done(resp),
                Err(e) => self.state = State::Error(e.to_string()),
            }
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let chunks = Layout::vertical([
            Constraint::Length(9), // Form
            Constraint::Min(0),   // Result
        ])
        .split(area);

        // Form
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER))
            .title(Span::styled(" Send Test Webhook ", theme::style_bold()))
            .padding(Padding::horizontal(1));

        let inner = block.inner(chunks[0]);
        frame.render_widget(block, chunks[0]);

        let fields = [
            ("Slug:   ", &self.slug as &str, Field::Slug),
            ("Method: ", &self.method, Field::Method),
            ("Body:   ", &self.body, Field::Body),
        ];

        let editing = matches!(self.state, State::Editing);

        for (i, (label, value, field)) in fields.iter().enumerate() {
            if i as u16 >= inner.height {
                break;
            }
            let y = inner.y + i as u16;
            let is_active = editing && self.active_field == *field;

            let cursor = if is_active { "█" } else { "" };
            let label_style = if is_active { theme::style_primary() } else { theme::style_muted() };
            let value_style = if is_active { theme::style_bold() } else { theme::style() };

            let line = Line::from(vec![
                Span::styled(if is_active { "▸ " } else { "  " }, label_style),
                Span::styled(*label, label_style),
                Span::styled(*value, value_style),
                Span::styled(cursor, theme::style_primary()),
            ]);

            frame.render_widget(Paragraph::new(line), Rect::new(inner.x, y, inner.width, 1));
        }

        // Result area
        match &self.state {
            State::Sending => {
                frame.render_widget(
                    Spinner::new(self.tick, "Sending..."),
                    Rect::new(chunks[1].x + 2, chunks[1].y + 1, chunks[1].width.saturating_sub(4), 1),
                );
            }
            State::Done(resp) => {
                let status_color = if resp.status < 400 { theme::SUCCESS } else { theme::DANGER };
                let mut lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Status: ", theme::style_muted()),
                        Span::styled(
                            format!("{} {}", resp.status, resp.status_text),
                            Style::default().fg(status_color),
                        ),
                    ]),
                ];

                if let Some(ref body) = resp.body {
                    if !body.is_empty() {
                        lines.push(Line::from(""));
                        lines.push(Line::from(Span::styled("  Response:", theme::style_muted())));

                        // Pretty-print JSON if possible
                        let formatted = if let Ok(val) = serde_json::from_str::<serde_json::Value>(body) {
                            serde_json::to_string_pretty(&val).unwrap_or_else(|_| body.clone())
                        } else {
                            body.clone()
                        };
                        for line in formatted.lines().take(20) {
                            lines.push(Line::from(Span::styled(
                                format!("  {line}"),
                                theme::style_dim(),
                            )));
                        }
                    }
                }

                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    "  Press Enter to send another.",
                    theme::style_muted(),
                )));

                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(status_color))
                    .title(Span::styled(" Response ", Style::default().fg(status_color)));

                frame.render_widget(
                    Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
                    chunks[1],
                );
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
                frame.render_widget(p, chunks[1]);
            }
            State::Editing => {}
        }
    }

    fn on_enter(&mut self, client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx);
        self.client = Some(client.clone());
    }

    fn on_leave(&mut self) {
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Send"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        match &self.state {
            State::Editing => vec![("tab", "next field"), ("enter", "send"), ("esc", "back")],
            _ => vec![("enter", "continue"), ("esc", "back")],
        }
    }

    fn tick(&mut self) {
        self.tick += 1;
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
