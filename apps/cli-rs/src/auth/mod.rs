use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use crate::types::Token;

/// Returns `~/.config/whk`
pub fn config_dir() -> Result<PathBuf> {
    let base = dirs::config_dir().context("could not determine config directory")?;
    Ok(base.join("whk"))
}

/// Returns `~/.config/whk/token.json`
fn token_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("token.json"))
}

/// Save token to disk with restrictive permissions.
pub fn save_token(token: &Token) -> Result<()> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).context("failed to create config directory")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o700);
        fs::set_permissions(&dir, perms).ok();
    }

    let path = token_path()?;
    let json = serde_json::to_string_pretty(token)?;
    fs::write(&path, json).context("failed to write token file")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms).ok();
    }

    Ok(())
}

/// Load token from disk. Returns `None` if not found.
pub fn load_token() -> Result<Option<Token>> {
    let path = token_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path).context("failed to read token file")?;
    let token: Token = serde_json::from_str(&contents).context("failed to parse token file")?;
    Ok(Some(token))
}

/// Delete the stored token.
pub fn clear_token() -> Result<()> {
    let path = token_path()?;
    if path.exists() {
        fs::remove_file(&path).context("failed to remove token file")?;
    }
    Ok(())
}

/// Check whether a valid token exists on disk.
pub fn is_logged_in() -> bool {
    load_token().ok().flatten().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_config_dir_returns_path() {
        let dir = config_dir().unwrap();
        assert!(dir.ends_with("whk"));
    }

    #[test]
    fn test_roundtrip_token() {
        // Use a temp dir to avoid touching the real config
        let tmp = env::temp_dir().join("whk-test-auth");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.join("token.json");
        let token = Token {
            access_token: "test-key".into(),
            user_id: "user-123".into(),
            email: "test@example.com".into(),
        };

        let json = serde_json::to_string_pretty(&token).unwrap();
        fs::write(&path, json).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let loaded: Token = serde_json::from_str(&contents).unwrap();
        assert_eq!(loaded.access_token, "test-key");
        assert_eq!(loaded.email, "test@example.com");

        let _ = fs::remove_dir_all(&tmp);
    }
}
