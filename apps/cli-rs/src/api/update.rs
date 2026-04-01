use anyhow::{Context, Result};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::time::Duration;

const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/kroqdotdev/webhooks-cc/releases/latest";
const MAX_BINARY_SIZE: u64 = 100 * 1024 * 1024; // 100 MB
const ALLOWED_DOWNLOAD_HOST: &str = "github.com";
const ALLOWED_DOWNLOAD_CDN: &str = ".githubusercontent.com";

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

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

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

    // Validate download URLs point to GitHub only
    validate_github_url(&archive_url)?;
    validate_github_url(&checksums_url)?;

    Ok(Some(Release {
        version: tag.to_string(),
        archive_url,
        checksums_url,
        archive_name,
    }))
}

/// Download, verify, and install the update.
pub async fn apply(release: &Release) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;

    // Download checksums (small file, OK to buffer)
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

    // Download archive with streaming + size limit
    let resp = client.get(&release.archive_url).send().await?;

    // Check Content-Length before downloading
    if let Some(content_length) = resp.content_length() && content_length > MAX_BINARY_SIZE {
        anyhow::bail!("archive too large ({content_length} bytes, max {MAX_BINARY_SIZE})");
    }

    let mut archive_bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download error")?;
        archive_bytes.extend_from_slice(&chunk);
        if archive_bytes.len() as u64 > MAX_BINARY_SIZE {
            anyhow::bail!("archive exceeds maximum size ({MAX_BINARY_SIZE} bytes)");
        }
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

    let tmp_path = current_exe.with_extension("update-tmp");
    std::fs::write(&tmp_path, &binary_bytes).context("failed to write update binary")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))?;
    }

    let old_path = current_exe.with_extension("old");
    let _ = std::fs::remove_file(&old_path);
    std::fs::rename(&current_exe, &old_path)
        .context("failed to move current binary aside")?;
    std::fs::rename(&tmp_path, &current_exe)
        .context("failed to install new binary")?;
    let _ = std::fs::remove_file(&old_path);

    Ok(())
}

fn validate_github_url(url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(url).context("invalid download URL")?;
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() != "https" {
        anyhow::bail!("download URL must use HTTPS: {url}");
    }
    if host != ALLOWED_DOWNLOAD_HOST
        && !host.ends_with(ALLOWED_DOWNLOAD_CDN)
    {
        anyhow::bail!("download URL must be from github.com: {url}");
    }
    Ok(())
}

fn archive_name_for_platform(tag: &str) -> String {
    let arch = std::env::consts::ARCH;

    let target = match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        os => format!("{arch}-unknown-{os}"),
    };

    let ext = if std::env::consts::OS == "windows" { "zip" } else { "tar.gz" };
    format!("whk-{tag}-{target}.{ext}")
}

fn extract_binary(archive_bytes: &[u8], archive_name: &str) -> Result<Vec<u8>> {
    if archive_name.ends_with(".zip") {
        anyhow::bail!("zip extraction not supported — use tar.gz archives")
    } else {
        extract_from_tar_gz(archive_bytes)
    }
}

fn extract_from_tar_gz(data: &[u8]) -> Result<Vec<u8>> {
    let decoder = flate2::read::GzDecoder::new(data);
    let mut archive = tar::Archive::new(decoder);

    for entry in archive.entries()? {
        let mut entry = entry?;

        // Only extract regular files
        if entry.header().entry_type() != tar::EntryType::Regular {
            continue;
        }

        let path = entry.path()?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if name == "whk" || name == "whk.exe" {
            let size = entry.header().size()?;
            if size > MAX_BINARY_SIZE {
                anyhow::bail!("binary in archive too large ({size} bytes)");
            }
            let mut buf = Vec::with_capacity(size as usize);
            entry.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }

    anyhow::bail!("whk binary not found in archive")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_github_url_accepts_valid() {
        assert!(validate_github_url("https://github.com/kroqdotdev/webhooks-cc/releases/download/v1.0.0/whk.tar.gz").is_ok());
        assert!(validate_github_url("https://objects.githubusercontent.com/some-asset").is_ok());
    }

    #[test]
    fn test_validate_github_url_rejects_http() {
        assert!(validate_github_url("http://github.com/foo").is_err());
    }

    #[test]
    fn test_validate_github_url_rejects_other_hosts() {
        assert!(validate_github_url("https://evil.com/whk.tar.gz").is_err());
        assert!(validate_github_url("https://github.com.evil.com/whk.tar.gz").is_err());
    }

    #[test]
    fn test_archive_name_for_platform() {
        let name = archive_name_for_platform("v1.0.0");
        assert!(name.starts_with("whk-v1.0.0-"));
        assert!(name.ends_with(".tar.gz") || name.ends_with(".zip"));
    }
}
