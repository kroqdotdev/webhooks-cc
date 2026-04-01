use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::io::Read;

const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/kroqdotdev/webhooks-cc/releases/latest";
const MAX_BINARY_SIZE: u64 = 100 * 1024 * 1024; // 100 MB

#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub archive_url: String,
    pub checksums_url: String,
    pub archive_name: String,
}

/// Check GitHub for a newer release. Returns None if already on latest or dev build.
pub async fn check(current_version: &str) -> Result<Option<Release>> {
    if current_version == "dev" {
        return Ok(None);
    }

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .get(GITHUB_RELEASES_URL)
        .header("User-Agent", format!("whk-cli/{current_version}"))
        .send()
        .await
        .context("failed to check for updates")?
        .json()
        .await
        .context("failed to parse release response")?;

    let tag = resp["tag_name"]
        .as_str()
        .context("no tag_name in release")?;

    let latest = tag.trim_start_matches('v');
    let current = current_version.trim_start_matches('v');

    let latest_ver = semver::Version::parse(latest).ok();
    let current_ver = semver::Version::parse(current).ok();

    match (latest_ver, current_ver) {
        (Some(l), Some(c)) if l <= c => return Ok(None),
        _ => {}
    }

    let archive_name = archive_name_for_platform(tag);
    let assets = resp["assets"].as_array().context("no assets in release")?;

    let archive_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some(&archive_name))
        .and_then(|a| a["browser_download_url"].as_str())
        .map(String::from)
        .context(format!("no matching archive for platform: {archive_name}"))?;

    let checksums_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("checksums.txt"))
        .and_then(|a| a["browser_download_url"].as_str())
        .map(String::from)
        .context("no checksums.txt in release")?;

    Ok(Some(Release {
        version: tag.to_string(),
        archive_url,
        checksums_url,
        archive_name,
    }))
}

/// Download, verify, and install the update.
pub async fn apply(release: &Release) -> Result<()> {
    let client = reqwest::Client::new();

    // Download checksums
    let checksums_text = client
        .get(&release.checksums_url)
        .send()
        .await?
        .text()
        .await?;

    let expected_hash = checksums_text
        .lines()
        .find(|line| line.contains(&release.archive_name))
        .and_then(|line| line.split_whitespace().next())
        .context("checksum not found for archive")?
        .to_string();

    // Download archive
    let archive_bytes = client
        .get(&release.archive_url)
        .send()
        .await?
        .bytes()
        .await?;

    if archive_bytes.len() as u64 > MAX_BINARY_SIZE {
        anyhow::bail!("archive too large ({} bytes)", archive_bytes.len());
    }

    // Verify checksum
    let mut hasher = Sha256::new();
    hasher.update(&archive_bytes);
    let actual_hash = hex::encode(hasher.finalize());

    if actual_hash != expected_hash {
        anyhow::bail!(
            "checksum mismatch:\n  expected: {expected_hash}\n  actual:   {actual_hash}"
        );
    }

    // Extract binary
    let binary_bytes = extract_binary(&archive_bytes, &release.archive_name)?;

    // Replace current binary
    let current_exe = std::env::current_exe().context("failed to find current executable")?;

    // Write to temp file next to current binary, then rename
    let tmp_path = current_exe.with_extension("update-tmp");
    std::fs::write(&tmp_path, &binary_bytes).context("failed to write update binary")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))?;
    }

    // Rename: current -> .old, tmp -> current
    let old_path = current_exe.with_extension("old");
    let _ = std::fs::remove_file(&old_path);
    std::fs::rename(&current_exe, &old_path)
        .context("failed to move current binary aside")?;
    std::fs::rename(&tmp_path, &current_exe)
        .context("failed to install new binary")?;
    let _ = std::fs::remove_file(&old_path);

    Ok(())
}

fn archive_name_for_platform(tag: &str) -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        a => a,
    };

    let target = match os {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        _ => format!("{arch}-unknown-{os}"),
    };

    let ext = if os == "windows" { "zip" } else { "tar.gz" };
    format!("whk-{tag}-{target}.{ext}")
}

fn extract_binary(archive_bytes: &[u8], archive_name: &str) -> Result<Vec<u8>> {
    if archive_name.ends_with(".zip") {
        extract_from_zip(archive_bytes)
    } else {
        extract_from_tar_gz(archive_bytes)
    }
}

fn extract_from_tar_gz(data: &[u8]) -> Result<Vec<u8>> {
    let decoder = flate2::read::GzDecoder::new(data);
    let mut archive = tar::Archive::new(decoder);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if name == "whk" || name == "whk.exe" {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }

    anyhow::bail!("whk binary not found in archive")
}

fn extract_from_zip(data: &[u8]) -> Result<Vec<u8>> {
    // Simple zip extraction — find the whk binary
    // We don't have the zip crate, so fall back to tar.gz only platforms
    // Windows users would need the zip crate added
    anyhow::bail!("zip extraction not supported — use tar.gz archives")
}
