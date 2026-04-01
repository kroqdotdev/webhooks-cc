use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Widget},
};

use crate::tui::theme;

/// Top header bar with branding and breadcrumb navigation.
pub struct Header<'a> {
    breadcrumb: Vec<&'a str>,
    auth_status: Option<&'a str>,
}

impl<'a> Header<'a> {
    pub fn new(breadcrumb: Vec<&'a str>) -> Self {
        Self {
            breadcrumb,
            auth_status: None,
        }
    }

    pub fn auth_status(mut self, email: Option<&'a str>) -> Self {
        self.auth_status = email;
        self
    }
}

impl Widget for Header<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::BORDER))
            .padding(Padding::horizontal(1));

        let inner = block.inner(area);
        block.render(area, buf);

        if inner.height == 0 {
            return;
        }

        // Build breadcrumb: "whk" > "Endpoints" > "abc-123"
        let mut spans = vec![Span::styled(
            " whk ",
            Style::default()
                .fg(theme::SURFACE)
                .bg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )];

        for (i, crumb) in self.breadcrumb.iter().enumerate() {
            spans.push(Span::styled(" > ", theme::style_muted()));
            let style = if i == self.breadcrumb.len() - 1 {
                theme::style_bold()
            } else {
                theme::style_dim()
            };
            spans.push(Span::styled(*crumb, style));
        }

        // Auth status on the right
        if let Some(email) = self.auth_status {
            let right_text = format!(" {} ", email);
            let right_len = right_text.len() as u16;
            let left_len: u16 = spans.iter().map(|s| s.width() as u16).sum();

            if left_len + right_len + 2 < inner.width {
                let gap = inner.width.saturating_sub(left_len + right_len);
                spans.push(Span::raw(" ".repeat(gap as usize)));
                spans.push(Span::styled(
                    format!("● {email}"),
                    theme::style_success(),
                ));
            }
        }

        let line = Line::from(spans);
        buf.set_line(inner.x, inner.y, &line, inner.width);
    }
}
