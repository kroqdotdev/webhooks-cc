pub mod event;
pub mod keys;
pub mod screens;
pub mod theme;
pub mod widgets;

use std::time::Duration;

use anyhow::Result;
use crossterm::{
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    layout::{Constraint, Layout},
    widgets::Widget,
    DefaultTerminal, Frame,
};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::auth;

use self::event::{spawn_event_reader, AppEvent};
use self::screens::*;
use self::widgets::header::Header;
use self::widgets::status_bar::StatusBar;

const TICK_RATE: Duration = Duration::from_millis(100);

pub async fn run(client: ApiClient) -> Result<()> {
    // Install panic hook to restore terminal
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::io::stdout().execute(LeaveAlternateScreen);
        let _ = disable_raw_mode();
        original_hook(info);
    }));

    enable_raw_mode()?;
    std::io::stdout().execute(EnterAlternateScreen)?;
    let mut terminal = ratatui::init();

    let result = run_app(&mut terminal, client).await;

    ratatui::restore();

    result
}

async fn run_app(terminal: &mut DefaultTerminal, client: ApiClient) -> Result<()> {
    let mut event_rx = spawn_event_reader(TICK_RATE);
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Message>();

    // Load auth email
    let auth_email = auth::load_token().ok().flatten().map(|t| t.email);

    let mut app = App::new(client, auth_email, msg_tx.clone());

    loop {
        terminal.draw(|frame| app.render(frame))?;

        tokio::select! {
            Some(event) = event_rx.recv() => {
                match event {
                    AppEvent::Key(key) => {
                        if let Some(action) = app.handle_key(&key) {
                            match action {
                                Action::Quit => break,
                                Action::NavigateBack => app.navigate_back(),
                                Action::Navigate(screen) => app.navigate_to(screen),
                                Action::SetAuthEmail(email) => app.set_auth_email(email),
                            }
                        }
                    }
                    AppEvent::Resize => {
                        // ratatui handles resize automatically
                    }
                    AppEvent::Tick => {
                        app.tick();
                    }
                }
            }
            Some(msg) = msg_rx.recv() => {
                app.handle_message(msg);
            }
        }
    }

    Ok(())
}

struct App {
    client: ApiClient,
    screen_stack: Vec<Box<dyn Screen>>,
    auth_email: Option<String>,
    msg_tx: mpsc::UnboundedSender<Message>,
}

impl App {
    fn new(
        client: ApiClient,
        auth_email: Option<String>,
        msg_tx: mpsc::UnboundedSender<Message>,
    ) -> Self {
        let menu = Box::new(screens::menu::MenuScreen::new(auth_email.clone()));
        Self {
            client,
            screen_stack: vec![menu],
            auth_email,
            msg_tx,
        }
    }

    fn current_screen(&self) -> &dyn Screen {
        self.screen_stack.last().unwrap().as_ref()
    }

    fn current_screen_mut(&mut self) -> &mut dyn Screen {
        self.screen_stack.last_mut().unwrap().as_mut()
    }

    fn handle_key(&mut self, key: &crossterm::event::KeyEvent) -> Option<Action> {
        self.current_screen_mut().handle_key(key)
    }

    fn handle_message(&mut self, msg: Message) {
        self.current_screen_mut().handle_message(msg);
    }

    fn tick(&mut self) {
        self.current_screen_mut().tick();
    }

    fn navigate_to(&mut self, screen_id: ScreenId) {
        let webhook_url = self.client.webhook_url.clone();

        let mut screen: Box<dyn Screen> = match screen_id {
            ScreenId::Auth => Box::new(screens::auth::AuthScreen::new(self.auth_email.clone())),
            ScreenId::Endpoints => Box::new(screens::endpoints::EndpointsScreen::new(webhook_url)),
            ScreenId::EndpointDetail(slug) => {
                Box::new(screens::endpoint_detail::EndpointDetailScreen::new(slug, webhook_url))
            }
            ScreenId::Tunnel => Box::new(screens::tunnel::TunnelScreen::new(webhook_url)),
            ScreenId::Listen => Box::new(screens::listen::ListenScreen::new(webhook_url)),
            ScreenId::RequestDetail(id) => {
                Box::new(screens::request_detail::RequestDetailScreen::new(id))
            }
            ScreenId::Search => Box::new(screens::search::SearchScreen::new()),
            ScreenId::Send => Box::new(screens::send::SendScreen::new()),
            ScreenId::Usage => Box::new(screens::usage::UsageScreen::new()),
            ScreenId::Update => Box::new(screens::update::UpdateScreen::new()),
        };

        screen.on_enter(&self.client, self.msg_tx.clone());
        self.screen_stack.push(screen);
    }

    fn navigate_back(&mut self) {
        if self.screen_stack.len() > 1 {
            let mut screen = self.screen_stack.pop().unwrap();
            screen.on_leave();

            // Refresh the menu auth email when returning
            if let Some(menu) = self.screen_stack.last_mut() {
                if let Some(menu_screen) = menu.as_any_mut().downcast_mut::<screens::menu::MenuScreen>() {
                    menu_screen.set_auth_email(self.auth_email.clone());
                }
            }
        }
    }

    fn set_auth_email(&mut self, email: Option<String>) {
        self.auth_email = email;
    }

    fn render(&mut self, frame: &mut Frame) {
        let area = frame.area();

        // Background
        frame.render_widget(
            ratatui::widgets::Block::default().style(theme::style_surface()),
            area,
        );

        let chunks = Layout::vertical([
            Constraint::Length(2),  // Header
            Constraint::Min(0),    // Content
            Constraint::Length(2),  // Status bar
        ])
        .split(area);

        // Header
        let breadcrumb = self.current_screen().breadcrumb();
        let header = Header::new(breadcrumb)
            .auth_status(self.auth_email.as_deref());
        header.render(chunks[0], frame.buffer_mut());

        // Content
        self.current_screen_mut().render(frame, chunks[1]);

        // Status bar
        let keys = self.current_screen().status_keys();
        let version = format!("v{}", env!("WHK_VERSION"));
        let bar = StatusBar::new(keys).right(&version);
        bar.render(chunks[2], frame.buffer_mut());
    }
}
