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
use crate::tui::{keys, theme};

use super::{Action, Message, Screen, ScreenId};

struct MenuItem {
    key: &'static str,
    label: &'static str,
    desc: &'static str,
    icon: &'static str,
    screen: ScreenId,
}

const ITEMS: &[MenuItem] = &[
    MenuItem {
        key: "t",
        label: "Tunnel",
        desc: "Forward webhooks to localhost",
        icon: "⇋",
        screen: ScreenId::Tunnel,
    },
    MenuItem {
        key: "l",
        label: "Listen",
        desc: "Stream incoming requests",
        icon: "◉",
        screen: ScreenId::Listen,
    },
    MenuItem {
        key: "e",
        label: "Endpoints",
        desc: "Manage webhook endpoints",
        icon: "◆",
        screen: ScreenId::Endpoints,
    },
    MenuItem {
        key: "s",
        label: "Send",
        desc: "Send a test webhook",
        icon: "➤",
        screen: ScreenId::Send,
    },
    MenuItem {
        key: "/",
        label: "Search",
        desc: "Search captured requests",
        icon: "⌕",
        screen: ScreenId::Search,
    },
    MenuItem {
        key: "i",
        label: "Usage",
        desc: "Plan, quota, and billing",
        icon: "◧",
        screen: ScreenId::Usage,
    },
    MenuItem {
        key: "a",
        label: "Auth",
        desc: "Login / logout",
        icon: "◈",
        screen: ScreenId::Auth,
    },
    MenuItem {
        key: "u",
        label: "Update",
        desc: "Check for updates",
        icon: "↻",
        screen: ScreenId::Update,
    },
];

pub struct MenuScreen {
    selected: usize,
    auth_email: Option<String>,
}

impl MenuScreen {
    pub fn new(auth_email: Option<String>) -> Self {
        Self {
            selected: 0,
            auth_email,
        }
    }

    pub fn set_auth_email(&mut self, email: Option<String>) {
        self.auth_email = email;
    }
}

impl Screen for MenuScreen {
    fn handle_key(&mut self, key: &KeyEvent) -> Option<Action> {
        if keys::is_quit(key) {
            return Some(Action::Quit);
        }
        if keys::is_up(key) {
            self.selected = self.selected.saturating_sub(1);
            return None;
        }
        if keys::is_down(key) {
            self.selected = (self.selected + 1).min(ITEMS.len() - 1);
            return None;
        }
        if keys::is_enter(key) {
            return Some(Action::Navigate(ITEMS[self.selected].screen.clone()));
        }

        // Shortcut keys
        for (i, item) in ITEMS.iter().enumerate() {
            if keys::is_char(key, item.key.chars().next().unwrap()) {
                self.selected = i;
                return Some(Action::Navigate(item.screen.clone()));
            }
        }

        None
    }

    fn handle_message(&mut self, _msg: Message) {}

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let chunks = Layout::vertical([
            Constraint::Length(5),  // Logo
            Constraint::Length(1),  // Spacer
            Constraint::Min(10),   // Menu items
            Constraint::Length(3), // Auth status
        ])
        .split(area);

        // Logo / branding
        render_logo(frame, chunks[0]);

        // Menu items
        render_menu_items(frame, chunks[2], self.selected);

        // Auth status bar
        render_auth_status(frame, chunks[3], self.auth_email.as_deref());
    }

    fn on_enter(&mut self, _client: &ApiClient, _tx: mpsc::UnboundedSender<Message>) {}

    fn breadcrumb(&self) -> Vec<&str> {
        vec![]
    }

    fn status_keys(&self) -> Vec<(&str, &str)> {
        vec![
            ("↑↓", "navigate"),
            ("enter", "select"),
            ("q", "quit"),
        ]
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

fn render_logo(frame: &mut Frame, area: Rect) {
    let logo = vec![
        Line::from(vec![
            Span::styled("  ╔══════════════════════════╗", Style::default().fg(theme::BORDER)),
        ]),
        Line::from(vec![
            Span::styled("  ║  ", Style::default().fg(theme::BORDER)),
            Span::styled("webhooks", theme::style_primary_bold()),
            Span::styled(".", theme::style_dim()),
            Span::styled("cc", theme::style_primary_bold()),
            Span::styled("  ", Style::default()),
            Span::styled("cli", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled("  ║", Style::default().fg(theme::BORDER)),
        ]),
        Line::from(vec![
            Span::styled("  ╚══════════════════════════╝", Style::default().fg(theme::BORDER)),
        ]),
    ];

    let p = Paragraph::new(logo);
    frame.render_widget(p, area);
}

fn render_menu_items(frame: &mut Frame, area: Rect, selected: usize) {
    let block = Block::default()
        .padding(Padding::horizontal(2));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    for (i, item) in ITEMS.iter().enumerate() {
        if i as u16 >= inner.height {
            break;
        }

        let is_selected = i == selected;
        let y = inner.y + (i as u16 * 2).min(inner.height.saturating_sub(1));

        if y >= inner.y + inner.height {
            break;
        }

        let (indicator, ind_style) = if is_selected {
            ("▸ ", Style::default().fg(theme::PRIMARY))
        } else {
            ("  ", theme::style_dim())
        };

        let label_style = if is_selected {
            theme::style_primary_bold()
        } else {
            theme::style_bold()
        };

        let line = Line::from(vec![
            Span::styled(indicator, ind_style),
            Span::styled(item.icon, Style::default().fg(if is_selected { theme::PRIMARY } else { theme::MUTED })),
            Span::styled("  ", Style::default()),
            Span::styled(item.label, label_style),
            Span::styled("  ", Style::default()),
            Span::styled(item.desc, theme::style_muted()),
        ]);

        frame.render_widget(Paragraph::new(line), Rect::new(inner.x, y, inner.width, 1));
    }
}

fn render_auth_status(frame: &mut Frame, area: Rect, email: Option<&str>) {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(theme::BORDER))
        .padding(Padding::horizontal(2));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height == 0 {
        return;
    }

    let line = match email {
        Some(e) => Line::from(vec![
            Span::styled("● ", theme::style_success()),
            Span::styled(e, theme::style_dim()),
        ]),
        None => Line::from(vec![
            Span::styled("● ", theme::style_danger()),
            Span::styled("Not logged in", theme::style_muted()),
        ]),
    };

    frame.render_widget(Paragraph::new(line), inner);
}
