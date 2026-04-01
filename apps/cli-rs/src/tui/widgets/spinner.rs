use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::Span,
    widgets::Widget,
};

use crate::tui::theme;

const FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub struct Spinner<'a> {
    tick: usize,
    label: &'a str,
    style: Style,
}

impl<'a> Spinner<'a> {
    pub fn new(tick: usize, label: &'a str) -> Self {
        Self {
            tick,
            label,
            style: theme::style_primary(),
        }
    }
}

impl Widget for Spinner<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width < 4 {
            return;
        }

        let frame = FRAMES[self.tick % FRAMES.len()];
        let spinner = Span::styled(frame, self.style);
        let label = Span::styled(format!(" {}", self.label), theme::style_dim());

        buf.set_span(area.x, area.y, &spinner, 2);
        buf.set_span(area.x + 2, area.y, &label, area.width.saturating_sub(2));
    }
}
