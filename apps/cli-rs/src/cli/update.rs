use anyhow::Result;

use crate::cli::output::dim;

pub async fn run(_json: bool) -> Result<()> {
    let version = env!("WHK_VERSION");
    if version == "dev" {
        println!("  {} Cannot update a dev build.", dim("●"));
        return Ok(());
    }

    // TODO: Phase 4 — full self-update implementation
    println!("  Self-update not yet implemented in Rust CLI.");
    println!("  Current version: {version}");

    Ok(())
}
