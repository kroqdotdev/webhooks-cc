use anyhow::Result;

use crate::api::update;
use crate::cli::output::{bold, dim, green};

pub async fn run(json: bool) -> Result<()> {
    let version = env!("WHK_VERSION");
    if version == "dev" {
        if json {
            crate::outln!("{}", serde_json::json!({ "error": "dev_build" }));
        } else {
            crate::outln!("  {} Cannot update a dev build.", dim("●"));
        }
        return Ok(());
    }

    if !json {
        crate::outln!("  Checking for updates...");
    }

    match update::check(version).await? {
        None => {
            if json {
                crate::outln!(
                    "{}",
                    serde_json::json!({ "current": version, "latest": version, "update_available": false })
                );
            } else {
                crate::outln!("  {} Already on latest version (v{version})", green("✓"));
            }
        }
        Some(release) => {
            if json {
                crate::outln!(
                    "{}",
                    serde_json::json!({
                        "current": version,
                        "latest": release.version,
                        "update_available": true,
                    })
                );
            } else {
                crate::outln!(
                    "  Update available: {} → {}",
                    dim(&format!("v{version}")),
                    bold(&release.version)
                );
                crate::outln!("  Downloading and installing...");
            }

            update::apply(&release).await?;

            if !json {
                crate::outln!("  {} Updated to {}", green("✓"), bold(&release.version));
                crate::outln!("  Restart whk to use the new version.");
            }
        }
    }

    Ok(())
}
