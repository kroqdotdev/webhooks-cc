use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, StatefulWidget, Widget},
};

use crate::tui::theme;
use crate::types::CapturedRequest;
use crate::util::format::format_bytes;

/// State for the scrollable request list.
pub struct RequestListState {
    pub selected: usize,
    pub offset: usize,
    pub items: Vec<CapturedRequest>,
}

impl RequestListState {
    pub fn new() -> Self {
        Self {
            selected: 0,
            offset: 0,
            items: Vec::new(),
        }
    }

    pub fn select_next(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + 1).min(self.items.len() - 1);
        }
    }

    pub fn select_prev(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn selected_item(&self) -> Option<&CapturedRequest> {
        self.items.get(self.selected)
    }

    pub fn push(&mut self, req: CapturedRequest) {
        self.items.insert(0, req);
        // Keep selection stable
        if self.selected > 0 {
            self.selected += 1;
        }
    }
}

/// Widget that renders a scrollable list of captured requests.
pub struct RequestList<'a> {
    title: &'a str,
    show_forward_status: bool,
}

impl<'a> RequestList<'a> {
    pub fn new(title: &'a str) -> Self {
        Self {
            title,
            show_forward_status: false,
        }
    }

    pub fn show_forward_status(mut self) -> Self {
        self.show_forward_status = true;
        self
    }
}

impl StatefulWidget for RequestList<'_> {
    type State = RequestListState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        let block = Block::default()
            .title(Span::styled(
                format!(" {} ", self.title),
                theme::style_bold(),
            ))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER))
            .padding(Padding::horizontal(1));

        let inner = block.inner(area);
        block.render(area, buf);

        if inner.height == 0 || inner.width == 0 || state.items.is_empty() {
            if state.items.is_empty() {
                let msg = Span::styled("  Waiting for requests...", theme::style_muted());
                if inner.height > 0 {
                    buf.set_span(inner.x, inner.y, &msg, inner.width);
                }
            }
            return;
        }

        let visible_height = inner.height as usize;

        // Adjust scroll offset to keep selection visible
        if state.selected < state.offset {
            state.offset = state.selected;
        }
        if state.selected >= state.offset + visible_height {
            state.offset = state.selected - visible_height + 1;
        }

        for (i, idx) in (state.offset..state.items.len())
            .take(visible_height)
            .enumerate()
        {
            let req = &state.items[idx];
            let is_selected = idx == state.selected;
            let y = inner.y + i as u16;

            // Time
            let time = chrono::DateTime::from_timestamp_millis(req.received_at)
                .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                .unwrap_or_else(|| "??:??:??".to_string());

            // Method with color
            let method_style = Style::default().fg(theme::method_color(&req.method));
            let method = format!("{:<7}", req.method);

            // Path (truncated to fit)
            let size_str = format_bytes(req.size);

            let bg = if is_selected {
                theme::SURFACE_RAISED
            } else {
                theme::SURFACE
            };

            // Render row
            let indicator = if is_selected { "▸ " } else { "  " };
            let indicator_style = if is_selected {
                Style::default().fg(theme::PRIMARY).bg(bg)
            } else {
                Style::default().fg(theme::SURFACE).bg(bg)
            };

            let line = Line::from(vec![
                Span::styled(indicator, indicator_style),
                Span::styled(&time, Style::default().fg(theme::TEXT_DIM).bg(bg)),
                Span::styled("  ", Style::default().bg(bg)),
                Span::styled(&method, method_style.bg(bg)),
                Span::styled(&req.path, Style::default().fg(theme::TEXT).bg(bg)),
                Span::styled("  ", Style::default().bg(bg)),
                Span::styled(&size_str, Style::default().fg(theme::MUTED).bg(bg)),
            ]);

            buf.set_line(inner.x, y, &line, inner.width);

            // Fill remaining width with bg
            let rendered_width: u16 = line.width() as u16;
            if rendered_width < inner.width && inner.width > 0 {
                let end = inner.x + inner.width.saturating_sub(1);
                for x in (inner.x + rendered_width)..=end {
                    buf[(x, y)].set_bg(bg);
                }
            }
        }
    }
}
