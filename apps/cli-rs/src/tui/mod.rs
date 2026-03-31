pub mod event;
pub mod keys;
pub mod screens;
pub mod theme;
pub mod widgets;

// TUI implementation — Phase 5+
// For now, just a placeholder that shows a message.

use anyhow::Result;

use crate::api::ApiClient;

pub async fn run(_client: ApiClient) -> Result<()> {
    println!("TUI mode coming soon. Use --nogui or a subcommand for now.");
    println!("Try: whk --help");
    Ok(())
}
