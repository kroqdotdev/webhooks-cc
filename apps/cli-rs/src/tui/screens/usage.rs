use crossterm::event::KeyEvent;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, Padding, Paragraph},
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};
use crate::tui::widgets::spinner::Spinner;
use crate::types::UsageInfo;

use super::{Action, Message, Screen};

enum State {
    Loading,
    Loaded,
    Error(String),
}

pub struct UsageScreen {
    state: State,
    usage: Option<UsageInfo>,
    tx: Option<mpsc::UnboundedSender<Message>>,
    client: Option<ApiClient>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

impl UsageScreen {
    pub fn new() -> Self {
        Self {
            state: State::Loading,
            usage: None,
            tx: None,
            client: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }
}

impl Screen for UsageScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_back(key) {
            return Some(Action::NavigateBack);
        }
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }
        if keys::is_char(key, 'r') {
            self.load_usage();
        }
        None
    }

    fn handle_message(&mut self, msg: Message) {
        if let Message::UsageLoaded(result) = msg {
            match result {
                Ok(usage) => {
                    self.usage = Some(usage);
                    self.state = State::Loaded;
                }
                Err(e) => {
                    self.state = State::Error(e.to_string());
                }
            }
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        if let State::Loading = &self.state {
            frame.render_widget(
                Spinner::new(self.tick, "Loading usage info..."),
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

        let usage = match &self.usage {
            Some(u) => u,
            None => return,
        };

        let chunks = Layout::vertical([
            Constraint::Length(2),  // Title
            Constraint::Length(8),  // Usage card
            Constraint::Min(0),    // Spacer
        ])
        .split(area);

        // Plan badge
        let plan_style = if usage.plan == "pro" {
            Style::default()
                .fg(theme::SURFACE)
                .bg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .fg(theme::TEXT)
                .bg(theme::MUTED)
                .add_modifier(Modifier::BOLD)
        };

        let title_line = Line::from(vec![
            Span::raw("  "),
            Span::styled(format!(" {} ", usage.plan.to_uppercase()), plan_style),
            Span::styled("  Plan", theme::style_bold()),
        ]);
        frame.render_widget(Paragraph::new(title_line), chunks[0]);

        // Usage card
        let card = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER))
            .title(Span::styled(" Request Usage ", theme::style_bold()))
            .padding(Padding::new(2, 2, 1, 1));

        let card_inner = card.inner(chunks[1]);
        frame.render_widget(card, chunks[1]);

        if card_inner.height >= 4 {
            // Usage stats
            let stats = Line::from(vec![
                Span::styled(
                    format!("{}", usage.used),
                    theme::style_primary_bold(),
                ),
                Span::styled(
                    format!(" / {} requests", usage.limit),
                    theme::style_dim(),
                ),
                Span::styled(
                    format!("  ({} remaining)", usage.remaining),
                    theme::style_muted(),
                ),
            ]);
            frame.render_widget(Paragraph::new(stats), Rect::new(card_inner.x, card_inner.y, card_inner.width, 1));

            // Progress bar
            let ratio = if usage.limit > 0 {
                (usage.used as f64 / usage.limit as f64).min(1.0)
            } else {
                0.0
            };

            let bar_color = if ratio > 0.9 {
                theme::DANGER
            } else if ratio > 0.7 {
                theme::ACCENT
            } else {
                theme::SUCCESS
            };

            let gauge = Gauge::default()
                .ratio(ratio)
                .gauge_style(Style::default().fg(bar_color).bg(theme::SURFACE_RAISED))
                .label("");

            frame.render_widget(
                gauge,
                Rect::new(card_inner.x, card_inner.y + 2, card_inner.width, 1),
            );

            // Period end
            if let Some(pe) = usage.period_end {
                let period_line = Line::from(vec![
                    Span::styled("Period ends: ", theme::style_muted()),
                    Span::styled(crate::util::format::format_timestamp(pe), theme::style()),
                ]);
                frame.render_widget(
                    Paragraph::new(period_line),
                    Rect::new(card_inner.x, card_inner.y + 4, card_inner.width, 1),
                );
            }
        }
    }

    fn on_enter(&mut self, client: &ApiClient, tx: mpsc::UnboundedSender<Message>) {
        self.tx = Some(tx);
        self.client = Some(client.clone());
        self.load_usage();
    }

    fn on_leave(&mut self) {
        for handle in self.tasks.drain(..) {
            handle.abort();
        }
        self.tx = None;
    }

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Usage"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![("r", "refresh"), ("esc", "back")]
    }

    fn tick(&mut self) {
        self.tick += 1;
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl UsageScreen {
    fn load_usage(&mut self) {
        self.state = State::Loading;
        if let (Some(tx), Some(client)) = (&self.tx, &self.client) {
            let tx = tx.clone();
            let client = client.clone();
            let handle = tokio::spawn(async move {
                let result = client.get_usage().await;
                let _ = tx.send(Message::UsageLoaded(result));
            });
            self.tasks.push(handle);
        }
    }
}
