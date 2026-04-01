use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Widget},
};

use crate::tui::theme;

/// Bottom status bar showing keybinding hints.
pub struct StatusBar<'a> {
    keys: Vec<(&'a str, &'a str)>,
    right: Option<&'a str>,
}

impl<'a> StatusBar<'a> {
    pub fn new(keys: Vec<(&'a str, &'a str)>) -> Self {
        Self { keys, right: None }
    }

    pub fn right(mut self, text: &'a str) -> Self {
        self.right = Some(text);
        self
    }
}

impl Widget for StatusBar<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(theme::BORDER))
            .padding(Padding::horizontal(1));

        let inner = block.inner(area);
        block.render(area, buf);

        if inner.height == 0 {
            return;
        }

        let mut spans: Vec<Span> = Vec::new();

        for (i, (key, desc)) in self.keys.iter().enumerate() {
            if i > 0 {
                spans.push(Span::styled("  ", theme::style_muted()));
            }
            spans.push(Span::styled(
                format!(" {key} "),
                Style::default()
                    .fg(theme::SURFACE)
                    .bg(theme::MUTED),
            ));
            spans.push(Span::styled(format!(" {desc}"), theme::style_dim()));
        }

        if let Some(right) = self.right {
            let left_len: u16 = spans.iter().map(|s| s.width() as u16).sum();
            let right_len = right.len() as u16;
            let gap = inner.width.saturating_sub(left_len + right_len + 1);
            if gap > 0 {
                spans.push(Span::raw(" ".repeat(gap as usize)));
                spans.push(Span::styled(right, theme::style_muted()));
            }
        }

        let line = Line::from(spans);
        buf.set_line(inner.x, inner.y, &line, inner.width);
    }
}
