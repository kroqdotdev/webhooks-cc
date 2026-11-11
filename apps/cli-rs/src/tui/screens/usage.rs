use crossterm::event::KeyEvent;
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, Padding, Paragraph},
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::widgets::spinner::Spinner;
use crate::tui::{keys, theme};
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

impl Default for UsageScreen {
    fn default() -> Self {
        Self::new()
    }
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

        let allowances = allowance_rows(usage);
        // Each row is a label line and a gauge, with a blank line between rows.
        let allowance_height = if allowances.is_empty() {
            0
        } else {
            (allowances.len() * 3 - 1 + 4) as u16
        };
        let chunks = Layout::vertical([
            Constraint::Length(2),                // Title
            Constraint::Length(8),                // Usage card
            Constraint::Length(allowance_height), // Other allowances
            Constraint::Min(0),                   // Spacer
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
                Span::styled(format!("{}", usage.used), theme::style_primary_bold()),
                Span::styled(format!(" / {} requests", usage.limit), theme::style_dim()),
                Span::styled(
                    format!("  ({} remaining)", usage.remaining),
                    theme::style_muted(),
                ),
            ]);
            frame.render_widget(
                Paragraph::new(stats),
                Rect::new(card_inner.x, card_inner.y, card_inner.width, 1),
            );

            // Progress bar
            let ratio = if usage.limit > 0 {
                (usage.used as f64 / usage.limit as f64).min(1.0)
            } else {
                0.0
            };

            let bar_color = bar_color(ratio);

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

        if !allowances.is_empty() {
            let card = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(" Other Allowances ", theme::style_bold()))
                .padding(Padding::new(2, 2, 1, 1));
            let inner = card.inner(chunks[2]);
            frame.render_widget(card, chunks[2]);
            // A short terminal loses the blank lines, then the gauges, before it
            // loses a row: the counts stay readable at one line each.
            let rows = allowances.len();
            if (inner.height as usize) < rows {
                // Too short even for a line each: every allowance on one line.
                if inner.height > 0 {
                    let summary = allowances
                        .iter()
                        .map(|row| format!("{} {}", row.label, row.amount))
                        .collect::<Vec<_>>()
                        .join("   ");
                    frame.render_widget(
                        Paragraph::new(Line::from(Span::styled(summary, theme::style()))),
                        Rect::new(inner.x, inner.y, inner.width, 1),
                    );
                }
                return;
            }
            let stride: u16 = if inner.height as usize >= rows * 3 - 1 {
                3
            } else if inner.height as usize >= rows * 2 {
                2
            } else {
                1
            };
            for (i, row) in allowances.iter().enumerate() {
                let y = inner.y + (i as u16) * stride;
                if y >= inner.y + inner.height {
                    break;
                }
                let line = Line::from(vec![
                    Span::styled(format!("{:<14}", row.label), theme::style_bold()),
                    Span::styled(row.amount.clone(), theme::style()),
                    Span::styled(format!("  {}", row.when), theme::style_muted()),
                ]);
                frame.render_widget(Paragraph::new(line), Rect::new(inner.x, y, inner.width, 1));
                let gauge = Gauge::default()
                    .ratio(row.ratio)
                    .gauge_style(
                        Style::default()
                            .fg(bar_color(row.ratio))
                            .bg(theme::SURFACE_RAISED),
                    )
                    .label("");
                if stride > 1 {
                    frame.render_widget(gauge, Rect::new(inner.x, y + 1, inner.width, 1));
                }
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

fn bar_color(ratio: f64) -> ratatui::style::Color {
    if ratio > 0.9 {
        theme::DANGER
    } else if ratio > 0.7 {
        theme::ACCENT
    } else {
        theme::SUCCESS
    }
}

/// One allowance beside requests, as the screen draws it.
struct AllowanceRow {
    label: &'static str,
    ratio: f64,
    amount: String,
    when: String,
}

fn ratio(used: u64, limit: u64) -> f64 {
    if limit > 0 {
        (used as f64 / limit as f64).min(1.0)
    } else if used > 0 {
        1.0
    } else {
        0.0
    }
}

/// Parsed pages, preview data and AI assists, each with when it frees up;
/// ones the server did not report are left out.
fn allowance_rows(usage: &UsageInfo) -> Vec<AllowanceRow> {
    let mut rows = Vec::new();
    if let Some(pages) = &usage.parsed_pages {
        rows.push(AllowanceRow {
            label: "Parsed pages",
            ratio: ratio(pages.used, pages.limit),
            amount: format!("{} / {} pages", pages.used, pages.limit),
            when: match &pages.resets_at {
                Some(at) => format!("resets {}", at.display()),
                None => "a month from your first parse".to_string(),
            },
        });
    }
    if let Some(preview) = &usage.preview_data {
        let at = preview.resets_at.as_ref().map(|t| t.display());
        rows.push(AllowanceRow {
            label: "Preview data",
            ratio: if preview.over {
                1.0
            } else {
                ratio(preview.bytes, preview.limit_bytes)
            },
            amount: format!(
                "{} / {}",
                crate::cli::share::data(preview.bytes),
                crate::cli::share::data(preview.limit_bytes)
            ),
            when: match (preview.over, at) {
                (true, Some(at)) => format!("previews paused until {at}"),
                (true, None) => "previews paused".to_string(),
                (false, Some(at)) => format!("resets {at}"),
                (false, None) => String::new(),
            },
        });
    }
    if let Some(assists) = &usage.ai_assists {
        rows.push(AllowanceRow {
            label: "AI assists",
            ratio: ratio(assists.used, assists.allowed),
            amount: format!("{} / {}", assists.used, assists.allowed),
            when: match (&assists.next_at, assists.used >= assists.allowed) {
                (Some(next), true) => format!("next one back {}", next.display()),
                _ => "over the last 30 days".to_string(),
            },
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_screen_draws_the_other_allowances() {
        use ratatui::{Terminal, backend::TestBackend};
        let usage: UsageInfo = serde_json::from_str(
            r#"{"used":31420,"limit":50000,"remaining":18580,"plan":"pro",
                "parsedPages":{"used":87,"limit":100,"creditPages":0,"resetsAt":null},
                "previewData":{"bytes":1024,"limitBytes":1073741824,"over":false},
                "aiAssists":{"used":3,"allowed":20,"nextAt":null}}"#,
        )
        .unwrap();
        let mut screen = UsageScreen::new();
        screen.usage = Some(usage);
        screen.state = State::Loaded;
        let mut terminal = Terminal::new(TestBackend::new(90, 30)).unwrap();
        terminal
            .draw(|frame| screen.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        assert!(text.contains("Other Allowances"), "{text}");
        assert!(
            text.contains("Parsed pages  87 / 100 pages  a month from your first parse"),
            "{text}"
        );
        assert!(text.contains("Preview data  1.0 KB / 1.00 GB"), "{text}");
        assert!(
            text.contains("AI assists    3 / 20  over the last 30 days"),
            "{text}"
        );
    }

    #[test]
    fn a_short_terminal_still_shows_every_allowance() {
        use ratatui::{Terminal, backend::TestBackend};
        let usage: UsageInfo = serde_json::from_str(
            r#"{"used":1,"limit":50,"remaining":49,"plan":"free",
                "parsedPages":{"used":2,"limit":20},
                "previewData":{"bytes":0,"limitBytes":1073741824},
                "aiAssists":{"used":0,"allowed":5}}"#,
        )
        .unwrap();
        let mut screen = UsageScreen::new();
        screen.usage = Some(usage);
        screen.state = State::Loaded;
        // Title 2 + request card 8 leaves 7 lines: an inner card of 3.
        let mut terminal = Terminal::new(TestBackend::new(90, 17)).unwrap();
        terminal
            .draw(|frame| screen.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        for label in ["Parsed pages", "Preview data", "AI assists"] {
            assert!(text.contains(label), "{label} missing:\n{text}");
        }

        // A 20-line terminal less the TUI's header and status bar: 16 lines,
        // a card of two inner lines, so the allowances share one line.
        let mut terminal = Terminal::new(TestBackend::new(110, 16)).unwrap();
        terminal
            .draw(|frame| screen.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        for label in ["Parsed pages", "Preview data", "AI assists"] {
            assert!(text.contains(label), "{label} missing at 16 lines:\n{text}");
        }
    }

    #[test]
    fn an_older_server_draws_no_allowance_card() {
        let usage: UsageInfo =
            serde_json::from_str(r#"{"used":1,"limit":50,"remaining":49,"plan":"free"}"#).unwrap();
        assert!(allowance_rows(&usage).is_empty());
    }
}
