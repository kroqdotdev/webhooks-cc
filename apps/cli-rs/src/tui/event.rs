use crossterm::event::{self, Event, KeyEvent, KeyEventKind};
use std::time::Duration;
use tokio::sync::mpsc;

/// Terminal events enriched with app-level ticks.
#[derive(Debug, Clone)]
pub enum AppEvent {
    Key(KeyEvent),
    Resize,
    Tick,
}

/// Spawn a background thread that reads crossterm events and sends them
/// over an mpsc channel. Also sends periodic ticks for animations.
pub fn spawn_event_reader(tick_rate: Duration) -> mpsc::UnboundedReceiver<AppEvent> {
    let (tx, rx) = mpsc::unbounded_channel();

    std::thread::spawn(move || {
        loop {
            if event::poll(tick_rate).unwrap_or(false) {
                let next = match event::read() {
                    Ok(Event::Key(key)) if key.kind == KeyEventKind::Press => {
                        Some(AppEvent::Key(key))
                    }
                    Ok(Event::Resize(_, _)) => Some(AppEvent::Resize),
                    _ => None,
                };
                if let Some(event) = next
                    && tx.send(event).is_err()
                {
                    break;
                }
            } else {
                // No event within tick_rate — send a tick for animations
                if tx.send(AppEvent::Tick).is_err() {
                    break;
                }
            }
        }
    });

    rx
}
