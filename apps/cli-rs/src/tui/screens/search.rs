use crossterm::event::{KeyCode, KeyEvent};
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
use crate::types::CapturedRequest;
use crate::util::format::{format_bytes, format_timestamp};

use super::{Action, Message, Screen, ScreenId};

#[derive(Clone, Copy, PartialEq)]
enum Field {
    Query,
    Method,
    Slug,
}

const FIELDS: &[Field] = &[Field::Query, Field::Method, Field::Slug];

enum State {
    Editing,
    Loading,
    Results,
    Error(String),
}

pub struct SearchScreen {
    state: State,
    active_field: Field,
    query: String,
    method: String,
    slug: String,
    results: Vec<CapturedRequest>,
    total: u64,
    table_state: TableState,
    tx: Option<mpsc::UnboundedSender<Message>>,
    client: Option<ApiClient>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    tick: usize,
}

impl SearchScreen {
    pub fn new() -> Self {
        Self {
            state: State::Editing,
            active_field: Field::Query,
            query: String::new(),
            method: String::new(),
            slug: String::new(),
            results: Vec::new(),
            total: 0,
            table_state: TableState::default(),
            tx: None,
            client: None,
            tasks: Vec::new(),
            tick: 0,
        }
    }

    fn active_input(&mut self) -> &mut String {
        match self.active_field {
            Field::Query => &mut self.query,
            Field::Method => &mut self.method,
            Field::Slug => &mut self.slug,
        }
    }

    fn run_search(&mut self) {
        if let (Some(tx), Some(client)) = (&self.tx, &self.client) {
            self.state = State::Loading;
            let tx = tx.clone();
            let client = client.clone();
            let q = if self.query.is_empty() { None } else { Some(self.query.clone()) };
            let method = if self.method.is_empty() { None } else { Some(self.method.clone()) };
            let slug = if self.slug.is_empty() { None } else { Some(self.slug.clone()) };

            let handle = tokio::spawn(async move {
                let result = client
                    .search_requests(
                        slug.as_deref(),
                        method.as_deref(),
                        q.as_deref(),
                        None,
                        None,
                        Some(50),
                        None,
                        Some("desc"),
                    )
                    .await;

                match result {
                    Ok(sr) => {
                        // Reuse RequestsLoaded for simplicity
                        let _ = tx.send(Message::RequestsLoaded(Ok(crate::types::RequestList {
                            requests: sr.requests,
                            count: Some(sr.total),
                        })));
                    }
                    Err(e) => {
                        let _ = tx.send(Message::RequestsLoaded(Err(e)));
                    }
                }
            });
            self.tasks.push(handle);
        }
    }
}

impl Screen for SearchScreen {
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
                        self.run_search();
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
            State::Results => {
                if keys::is_back(key) {
                    self.state = State::Editing;
                    return None;
                }

                if keys::is_up(key) {
                    let i = self.table_state.selected().unwrap_or(0);
                    self.table_state.select(Some(i.saturating_sub(1)));
                    return None;
                }
                if keys::is_down(key) {
                    let i = self.table_state.selected().unwrap_or(0);
                    let max = self.results.len().saturating_sub(1);
                    self.table_state.select(Some((i + 1).min(max)));
                    return None;
                }
                if keys::is_enter(key) {
                    if let Some(i) = self.table_state.selected() {
                        if let Some(req) = self.results.get(i) {
                            return Some(Action::Navigate(ScreenId::RequestDetail(req.id.clone())));
                        }
                    }
                    return None;
                }

                // '/' to go back to editing
                if keys::is_char(key, '/') {
                    self.state = State::Editing;
                    return None;
                }
            }
            State::Error(_) => {
                if keys::is_back(key) || keys::is_enter(key) {
                    self.state = State::Editing;
                    return None;
                }
            }
            State::Loading => {}
        }

        None
    }

    fn handle_message(&mut self, msg: Message) {
        if let Message::RequestsLoaded(result) = msg {
            match result {
                Ok(list) => {
                    self.results = list.requests;
                    self.total = list.count.unwrap_or(self.results.len() as u64);
                    if !self.results.is_empty() {
                        self.table_state.select(Some(0));
                    }
                    self.state = State::Results;
                }
                Err(e) => {
                    self.state = State::Error(e.to_string());
                }
            }
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let chunks = Layout::vertical([
            Constraint::Length(7), // Search fields
            Constraint::Min(0),   // Results
        ])
        .split(area);

        // Search fields
        render_search_fields(
            frame,
            chunks[0],
            &self.query,
            &self.method,
            &self.slug,
            self.active_field,
            matches!(self.state, State::Editing),
        );

        // Results area
        match &self.state {
            State::Loading => {
                frame.render_widget(
                    Spinner::new(self.tick, "Searching..."),
                    Rect::new(chunks[1].x + 2, chunks[1].y + 1, chunks[1].width.saturating_sub(4), 1),
                );
            }
            State::Results => {
                render_results(frame, chunks[1], &self.results, self.total, &mut self.table_state);
            }
            State::Error(msg) => {
                let p = Paragraph::new(Line::from(vec![
                    Span::styled("  Error: ", theme::style_danger()),
                    Span::styled(msg.as_str(), theme::style_dim()),
                ]));
                frame.render_widget(p, chunks[1]);
            }
            State::Editing => {
                if !self.results.is_empty() {
                    render_results(frame, chunks[1], &self.results, self.total, &mut self.table_state);
                } else {
                    let p = Paragraph::new(Line::from(Span::styled(
                        "  Press Enter to search.",
                        theme::style_muted(),
                    )));
                    frame.render_widget(p, chunks[1]);
                }
            }
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
        vec!["Search"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        match &self.state {
            State::Editing => vec![("tab", "next field"), ("enter", "search"), ("esc", "back")],
            State::Results => vec![("↑↓", "navigate"), ("enter", "inspect"), ("/", "edit"), ("esc", "back")],
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

fn render_search_fields(
    frame: &mut Frame,
    area: Rect,
    query: &str,
    method: &str,
    slug: &str,
    active: Field,
    editing: bool,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::BORDER))
        .title(Span::styled(" Search Requests ", theme::style_bold()))
        .padding(Padding::horizontal(1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height < 3 {
        return;
    }

    let fields = [
        ("Query:  ", query, Field::Query),
        ("Method: ", method, Field::Method),
        ("Slug:   ", slug, Field::Slug),
    ];

    for (i, (label, value, field)) in fields.iter().enumerate() {
        if i as u16 >= inner.height {
            break;
        }
        let y = inner.y + i as u16;
        let is_active = editing && active == *field;

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
}

fn render_results(
    frame: &mut Frame,
    area: Rect,
    results: &[CapturedRequest],
    total: u64,
    table_state: &mut TableState,
) {
    if results.is_empty() {
        let p = Paragraph::new(Line::from(Span::styled(
            "  No matching requests found.",
            theme::style_muted(),
        )));
        frame.render_widget(p, area);
        return;
    }

    let header = Row::new(vec!["  TIME", "METHOD", "PATH", "SIZE"])
        .style(theme::style_muted());

    let rows: Vec<Row> = results
        .iter()
        .map(|r| {
            let time = format_timestamp(r.received_at);
            Row::new(vec![
                format!("  {}", time.get(11..19).unwrap_or("??:??:??")),
                r.method.clone(),
                r.path.clone(),
                format_bytes(r.size),
            ])
            .style(Style::default().fg(theme::TEXT))
        })
        .collect();

    let widths = [
        Constraint::Length(12),
        Constraint::Length(8),
        Constraint::Min(20),
        Constraint::Length(10),
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    format!(" Results ({total}) "),
                    theme::style_bold(),
                )),
        )
        .row_highlight_style(theme::style_highlight());

    frame.render_stateful_widget(table, area, table_state);
}
