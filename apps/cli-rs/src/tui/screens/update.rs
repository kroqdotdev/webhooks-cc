use crossterm::event::KeyEvent;
use ratatui::{
    layout::Rect,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::tui::{keys, theme};

use super::{Action, Message, Screen};

pub struct UpdateScreen {
    version: String,
}

impl UpdateScreen {
    pub fn new() -> Self {
        Self {
            version: env!("WHK_VERSION").to_string(),
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
        None
    }

    fn handle_message(&mut self, _msg: Message) {}

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let lines = vec![
            Line::from(""),
            Line::from(vec![
                Span::styled("  Current version: ", theme::style_muted()),
                Span::styled(&self.version, theme::style_bold()),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "  Self-update will be available in a future release.",
                theme::style_dim(),
            )),
        ];
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn on_enter(&mut self, _client: &ApiClient, _tx: mpsc::UnboundedSender<Message>) {}

    fn breadcrumb(&self) -> Vec<&str> {
        vec!["Update"]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![("esc", "back")]
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
