use anyhow::Result;

use crate::api::update;
use crate::cli::output::{bold, dim, green};

pub async fn run(json: bool) -> Result<()> {
    let version = env!("WHK_VERSION");
    if version == "dev" {
        if json {
            println!("{}", serde_json::json!({ "error": "dev_build" }));
        } else {
            println!("  {} Cannot update a dev build.", dim("●"));
        }
        return Ok(());
    }

    if !json {
        println!("  Checking for updates...");
    }

    match update::check(version).await? {
        None => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "current": version, "latest": version, "update_available": false })
                );
            } else {
                println!("  {} Already on latest version (v{version})", green("✓"));
            }
        }
        Some(release) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "current": version,
                        "latest": release.version,
                        "update_available": true,
                    })
                );
            } else {
                println!(
                    "  Update available: {} → {}",
                    dim(&format!("v{version}")),
                    bold(&release.version)
                );
                println!("  Downloading and installing...");
            }

            update::apply(&release).await?;

            if !json {
                println!("  {} Updated to {}", green("✓"), bold(&release.version));
                println!("  Restart whk to use the new version.");
            }
        }
    }

    Ok(())
}
