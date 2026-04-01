use crossterm::event::KeyEvent;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::auth;
use crate::tui::{keys, theme};
use crate::types::Token;

use super::{Action, Message, Screen};

enum State {
    Idle,
    Polling {
        device_code: String,
        user_code: String,
        verification_url: String,
    },
    Success(String), // email
    Error(String),
}

pub struct AuthScreen {
    state: State,
    auth_email: Option<String>,
    tick: usize,
    tx: Option<mpsc::UnboundedSender<Message>>,
}

impl AuthScreen {
    pub fn new(auth_email: Option<String>) -> Self {
        Self {
            state: State::Idle,
            auth_email,
            tick: 0,
            tx: None,
        }
    }

}

impl Screen for AuthScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        match &self.state {
            State::Idle => {
                if self.auth_email.is_some() {
                    // Logged in — press 'o' to logout
                    if keys::is_char(key, 'o') {
                        let _ = auth::clear_token();
                        self.auth_email = None;
                        self.state = State::Idle;
                        return Some(Action::SetAuthEmail(None));
                    }
                } else {
                    // Not logged in — press 'l' to login
                    if keys::is_char(key, 'l') {
                        if let Some(ref tx) = self.tx {
                            let tx = tx.clone();
                            let client = self.get_client_for_login();
                            if let Some(client) = client {
                                tokio::spawn(async move {
                                    let result = client.create_device_code().await;
                                    let _ = tx.send(Message::DeviceCode(result));
                                });
                            }
                        }
                    }
                }
            }
            State::Polling { user_code, .. } => {
                if keys::is_char(key, 'c') {
                    copy_to_clipboard(user_code);
                }
            }
            State::Success(_) | State::Error(_) => {
                // Any key goes back to idle
                if keys::is_enter(key) {
                    self.state = State::Idle;
                }
            }
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::DeviceCode(Ok(device)) => {
                if device.verification_url.starts_with("https://") {
                    let _ = open::that(&device.verification_url);
                }

                let dc = device.device_code.clone();
                self.state = State::Polling {
                    device_code: device.device_code,
                    user_code: device.user_code,
                    verification_url: device.verification_url,
                };

                // Start polling
                if let Some(ref tx) = self.tx {
                    let tx = tx.clone();
                    let client = self.get_client_for_login();
                    if let Some(client) = client {
                        tokio::spawn(async move {
                            loop {
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                let result = client.poll_device_code(&dc).await;
                                let done = matches!(&result, Ok(r) if r.status != "pending");
                                let _ = tx.send(Message::AuthPoll(result));
                                if done {
                                    break;
                                }
                            }
                        });
                    }
                }
            }
            Message::DeviceCode(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::AuthPoll(Ok(poll)) => {
                if poll.status == "authorized" {
                    // Claim the code
                    if let State::Polling { ref device_code, .. } = self.state {
                        let dc = device_code.clone();
                        if let Some(ref tx) = self.tx {
                            let tx = tx.clone();
                            let client = self.get_client_for_login();
                            if let Some(client) = client {
                                tokio::spawn(async move {
                                    let result = client.claim_device_code(&dc).await;
                                    let _ = tx.send(Message::AuthClaimed(result));
                                });
                            }
                        }
                    }
                } else if poll.status == "expired" {
                    self.state = State::Error("Code expired. Press Enter and try again.".into());
                }
            }
            Message::AuthPoll(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::AuthClaimed(Ok(claim)) => {
                let token = Token {
                    access_token: claim.api_key,
                    user_id: claim.user_id,
                    email: claim.email.clone(),
                };
                let _ = auth::save_token(&token);
                self.auth_email = Some(claim.email.clone());
                self.state = State::Success(claim.email.clone());
            }
            Message::AuthClaimed(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let chunks = Layout::vertical([
            Constraint::Length(2),
            Constraint::Min(0),
        ])
        .split(area);

        let content_area = centered_rect(60, 12, chunks[1]);

        match &self.state {
            State::Idle => {
                if let Some(ref email) = self.auth_email {
                    let lines = vec![
                        Line::from(""),
                        Line::from(vec![
                            Span::styled("  Logged in as ", theme::style_dim()),
                            Span::styled(email, theme::style_bold()),
                        ]),
                        Line::from(""),
                        Line::from(Span::styled(
                            "  Press  o  to logout",
                            theme::style_muted(),
                        )),
                    ];
                    let block = Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(theme::SUCCESS))
                        .title(Span::styled(" Authenticated ", theme::style_success()))
                        .padding(Padding::vertical(1));
                    frame.render_widget(Paragraph::new(lines).block(block), content_area);
                } else {
                    let lines = vec![
                        Line::from(""),
                        Line::from(Span::styled(
                            "  Not logged in",
                            theme::style_muted(),
                        )),
                        Line::from(""),
                        Line::from(Span::styled(
                            "  Press  l  to login via browser",
                            theme::style_dim(),
                        )),
                    ];
                    let block = Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(theme::BORDER))
                        .title(Span::styled(" Authentication ", theme::style_bold()))
                        .padding(Padding::vertical(1));
                    frame.render_widget(Paragraph::new(lines).block(block), content_area);
                }
            }
            State::Polling {
                user_code,
                verification_url,
                ..
            } => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Your code:  ", theme::style_dim()),
                        Span::styled(
                            user_code,
                            Style::default()
                                .fg(theme::PRIMARY)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Open ", theme::style_dim()),
                        Span::styled(verification_url, Style::default().fg(theme::ACCENT)),
                    ]),
                    Line::from(Span::styled(
                        "  and enter the code above.",
                        theme::style_dim(),
                    )),
                    Line::from(""),
                    Line::from(Span::styled(
                        format!("  {} Waiting for authorization...", spinner_frame(self.tick)),
                        theme::style_primary(),
                    )),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::PRIMARY))
                    .title(Span::styled(" Login ", theme::style_primary_bold()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content_area);
            }
            State::Success(email) => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✓ ", theme::style_success()),
                        Span::styled("Logged in as ", theme::style_dim()),
                        Span::styled(email, theme::style_bold()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Press Enter to continue.",
                        theme::style_muted(),
                    )),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::SUCCESS))
                    .title(Span::styled(" Success ", theme::style_success()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content_area);
            }
            State::Error(msg) => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✗ ", theme::style_danger()),
                        Span::styled(msg, theme::style_dim()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Press Enter to try again.",
                        theme::style_muted(),
                    )),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::DANGER))
                    .title(Span::styled(" Error ", theme::style_danger()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content_area);
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
        vec!["Auth"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        if self.auth_email.is_some() {
            vec![("o", "logout"), ("esc", "back")]
        } else {
            match &self.state {
                State::Idle => vec![("l", "login"), ("esc", "back")],
                State::Polling { .. } => vec![("c", "copy code"), ("esc", "cancel")],
                _ => vec![("esc", "cancel")],
            }
        }
    }

    fn tick(&mut self) {
        self.tick += 1;
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl AuthScreen {
    fn get_client_for_login(&self) -> Option<ApiClient> {
        ApiClient::new(None, None).ok()
    }
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect::new(
        x.max(area.x),
        y.max(area.y),
        width.min(area.width),
        height.min(area.height),
    )
}

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

fn spinner_frame(tick: usize) -> &'static str {
    SPINNER_FRAMES[tick % SPINNER_FRAMES.len()]
}

fn copy_to_clipboard(text: &str) {
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        if let Ok(mut child) = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        // Try xclip first, then xsel
        let result = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .spawn();
        if let Ok(mut child) = result {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
}
