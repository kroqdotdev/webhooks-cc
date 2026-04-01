use crossterm::event::KeyEvent;
use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::{update, ApiClient};
use crate::tui::{keys, theme};
use crate::tui::widgets::spinner::Spinner;

use super::{Action, Message, Screen};

enum State {
    Checking,
    UpToDate,
    Available(update::Release),
    Applying,
    Done(String),
    Error(String),
}

pub struct UpdateScreen {
    state: State,
    version: String,
    tx: Option<mpsc::UnboundedSender<Message>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

// We reuse UsageLoaded message to carry update results since we don't
// want to add more message variants. Use a simple channel instead.
// Actually, let's just use tokio::spawn with a flag.

impl UpdateScreen {
    pub fn new() -> Self {
        Self {
            state: State::Checking,
            version: env!("WHK_VERSION").to_string(),
            tx: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }
}

impl Screen for UpdateScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }

        match &self.state {
            State::Available(release) => {
                if keys::is_char(key, 'u') {
                    let release = release.clone();
                    self.state = State::Applying;
                    if let Some(ref tx) = self.tx {
                        let tx = tx.clone();
                        let handle = tokio::spawn(async move {
                            match update::apply(&release).await {
                                Ok(()) => {
                                    let _ = tx.send(Message::UpdateResult(Ok(release.version)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Message::UpdateResult(Err(e)));
                                }
                            }
                        });
                        self.tasks.push(handle);
                    }
                }
            }
            State::Done(_) | State::Error(_) | State::UpToDate => {
                if keys::is_enter(key) {
                    return Some(Action::NavigateBack);
                }
            }
            _ => {}
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::UpdateCheck(Ok(None)) => {
                self.state = State::UpToDate;
            }
            Message::UpdateCheck(Ok(Some(release))) => {
                self.state = State::Available(release);
            }
            Message::UpdateCheck(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            Message::UpdateResult(Ok(version)) => {
                self.state = State::Done(version);
            }
            Message::UpdateResult(Err(e)) => {
                self.state = State::Error(e.to_string());
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let content = Rect::new(area.x + 2, area.y + 1, area.width.saturating_sub(4), area.height.saturating_sub(2));

        match &self.state {
            State::Checking => {
                frame.render_widget(
                    Spinner::new(self.tick, "Checking for updates..."),
                    content,
                );
            }
            State::UpToDate => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✓ ", theme::style_success()),
                        Span::styled(
                            format!("Already on latest version (v{})", self.version),
                            theme::style(),
                        ),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled("  Press Enter to go back.", theme::style_muted())),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::SUCCESS))
                    .title(Span::styled(" Up to date ", theme::style_success()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content);
            }
            State::Available(release) => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Current: ", theme::style_muted()),
                        Span::styled(format!("v{}", self.version), theme::style_dim()),
                    ]),
                    Line::from(vec![
                        Span::styled("  Latest:  ", theme::style_muted()),
                        Span::styled(&release.version, theme::style_primary_bold()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Press  u  to update.",
                        theme::style(),
                    )),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::PRIMARY))
                    .title(Span::styled(" Update Available ", theme::style_primary_bold()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content);
            }
            State::Applying => {
                frame.render_widget(
                    Spinner::new(self.tick, "Downloading and installing..."),
                    content,
                );
            }
            State::Done(version) => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✓ ", theme::style_success()),
                        Span::styled(format!("Updated to {version}"), theme::style_bold()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Restart whk to use the new version.",
                        theme::style_muted(),
                    )),
                    Line::from(""),
                    Line::from(Span::styled("  Press Enter to go back.", theme::style_muted())),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::SUCCESS))
                    .title(Span::styled(" Updated ", theme::style_success()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content);
            }
            State::Error(msg) => {
                let lines = vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  ✗ ", theme::style_danger()),
                        Span::styled(msg.as_str(), theme::style_dim()),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled("  Press Enter to go back.", theme::style_muted())),
                ];
                let block = Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::DANGER))
                    .title(Span::styled(" Error ", theme::style_danger()))
                    .padding(Padding::vertical(1));
                frame.render_widget(Paragraph::new(lines).block(block), content);
            }
        }
    }

    fn on_enter(&mut self, _client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx.clone());

        if self.version == "dev" {
            self.state = State::Error("Cannot update a dev build.".into());
            return;
        }

        let version = self.version.clone();
        let handle = tokio::spawn(async move {
            let result = update::check(&version).await;
            let _ = tx.send(Message::UpdateCheck(result));
        });
        self.tasks.push(handle);
    }

    fn on_leave(&mut self) {
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Update"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        match &self.state {
            State::Available(_) => vec![("u", "update"), ("esc", "back")],
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
