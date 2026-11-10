use std::net::SocketAddr;

/// The edge's settings, from the environment.
#[derive(Clone, Debug)]
pub struct Config {
    /// Where to listen for plain HTTP; TLS ends at the Caddy in front.
    pub listen: SocketAddr,
    /// Previews live at `<name>.<preview_domain>`: "sharehooks.cc", or
    /// "sharehooks.localhost:4000" in development.
    pub preview_domain: String,
    /// "https" behind Cloudflare, "http" in development.
    pub public_scheme: String,
    /// The web app, for /api/edge/*, over the private network.
    pub web_url: String,
    /// Where the web app tells the edge to close shares (`control.rs`).
    /// Never routed by Caddy: the private network only.
    pub control_listen: SocketAddr,
    /// Where the receiver relays `whk tunnel --live` captures (relay.rs);
    /// none turns the relay off. Never routed by Caddy.
    pub relay_listen: Option<SocketAddr>,
    /// The site's public address, for links on visitor pages:
    /// "https://webhooks.cc".
    pub app_url: String,
    /// Shared with the web app.
    pub edge_secret: String,
    /// Where the access log for previews goes (`access_log.rs`); none in
    /// development.
    pub access_log_dir: Option<std::path::PathBuf>,
    /// The brands and lure words the phishing look uses (inject.rs,
    /// words.rs): EDGE_WORDS_FILE. Kept private on the box in production.
    pub words_file: Option<std::path::PathBuf>,
    /// How often the edge syncs with the web app (control.rs): 30 seconds,
    /// shorter in the browser tests.
    pub sync_every: std::time::Duration,
    /// How fast shares, sites and accounts may send visitors (pace.rs):
    /// SHARE_MIB_PER_SECOND and SHARE_BURST_MIB, ACCOUNT_MIB_PER_SECOND and
    /// ACCOUNT_BURST_MIB; and all of them together, the line (line.rs):
    /// LINE_MIB_PER_SECOND and LINE_BURST_MIB. A rate of 0 is no limit.
    pub pace: crate::pace::Rates,
    /// The most answers held up for visitors who fell behind, all told
    /// (held.rs): HELD_UP_MAX.
    pub held_up_max: usize,
}

/// The label under the preview domain that is the control host, never a
/// preview.
pub const CONTROL_LABEL: &str = "tunnel";

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |name: &str, default: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        let preview_domain = get("PREVIEW_DOMAIN", "sharehooks.localhost:4000").to_lowercase();
        // `name.sharehooks.localhost:4000` and the like: plain HTTP.
        let local = preview_domain
            .split(':')
            .next()
            .is_some_and(|host| host == "localhost" || host.ends_with(".localhost"));
        let public_scheme = if local {
            "http".to_string()
        } else {
            "https".to_string()
        };
        let edge_secret = get("EDGE_SECRET", "");
        if edge_secret.is_empty() {
            anyhow::bail!("EDGE_SECRET is not set");
        }
        let web_url = get("WEB_URL", "http://localhost:3000");
        let paced = crate::pace::Rates::default();
        let mib = |name: &str, default_bytes: f64| -> anyhow::Result<f64> {
            match std::env::var(name).ok().filter(|v| !v.trim().is_empty()) {
                None => Ok(default_bytes / (1024.0 * 1024.0)),
                Some(v) => v
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| anyhow::anyhow!("{name} is not a number of MiB: {v}")),
            }
        };
        let pace = crate::pace::Rates {
            door: crate::pace::Rate::mib(
                mib("SHARE_MIB_PER_SECOND", paced.door.per_second)?,
                mib("SHARE_BURST_MIB", paced.door.burst)?,
            ),
            account: crate::pace::Rate::mib(
                mib("ACCOUNT_MIB_PER_SECOND", paced.account.per_second)?,
                mib("ACCOUNT_BURST_MIB", paced.account.burst)?,
            ),
            line: crate::pace::Rate::mib(
                mib("LINE_MIB_PER_SECOND", paced.line.per_second)?,
                mib("LINE_BURST_MIB", paced.line.burst)?,
            ),
        };
        Ok(Self {
            listen: get("LISTEN", "0.0.0.0:4000").parse()?,
            control_listen: get("CONTROL_LISTEN", "127.0.0.1:4001").parse()?,
            relay_listen: Some(get("RELAY_LISTEN", ""))
                .filter(|v| !v.is_empty())
                .map(|v| v.parse())
                .transpose()?,
            app_url: get("APP_URL", &web_url).trim_end_matches('/').to_string(),
            access_log_dir: Some(get("ACCESS_LOG_DIR", ""))
                .filter(|d| !d.is_empty())
                .map(Into::into),
            words_file: Some(get("EDGE_WORDS_FILE", ""))
                .filter(|d| !d.is_empty())
                .map(Into::into),
            sync_every: std::time::Duration::from_secs(
                get("SYNC_SECONDS", "30").parse::<u64>()?.max(1),
            ),
            preview_domain,
            public_scheme,
            web_url,
            edge_secret,
            pace,
            held_up_max: get("HELD_UP_MAX", &crate::held::HELD_UP_MAX.to_string())
                .parse()
                .map_err(|_| anyhow::anyhow!("HELD_UP_MAX is not a number of answers"))?,
        })
    }

    pub fn secure(&self) -> bool {
        self.public_scheme == "https"
    }

    /// Settings for tests, asking the web app at `web_url`.
    #[cfg(test)]
    pub fn testing(web_url: &str) -> Self {
        Self {
            listen: "127.0.0.1:0".parse().unwrap(),
            preview_domain: "sharehooks.localhost:4000".into(),
            public_scheme: "http".into(),
            web_url: web_url.into(),
            control_listen: "127.0.0.1:0".parse().unwrap(),
            relay_listen: None,
            app_url: "http://localhost:3000".into(),
            edge_secret: "s".into(),
            access_log_dir: None,
            words_file: None,
            sync_every: std::time::Duration::from_secs(30),
            pace: crate::pace::Rates::default(),
            held_up_max: crate::held::HELD_UP_MAX,
        }
    }

    /// The name in a preview host: `calm-otter-4821` for
    /// `calm-otter-4821.sharehooks.cc`. One label only.
    /// Whether the host is the preview domain itself, with no name: it
    /// sends visitors to the docs (main.rs).
    pub fn is_bare_domain(&self, host: &str) -> bool {
        host.trim_end_matches('.')
            .eq_ignore_ascii_case(&self.preview_domain)
    }

    /// The preview name a host asks for: one label under the preview
    /// domain. `tunnel` is never a preview (the web app keeps the name
    /// reserved): under the preview domain it is the control host, which a
    /// staging edge without a second domain uses for `/v1/connect`.
    pub fn name_of(&self, host: &str) -> Option<String> {
        let host = host.trim_end_matches('.').to_lowercase();
        let name = host.strip_suffix(&format!(".{}", self.preview_domain))?;
        if name.is_empty() || name.contains('.') || name == CONTROL_LABEL {
            return None;
        }
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_name_is_one_label_under_the_domain() {
        let mut config = Config::testing("http://web");
        config.preview_domain = "sharehooks.cc".into();
        assert_eq!(
            config.name_of("acme.sharehooks.cc").as_deref(),
            Some("acme")
        );
        assert_eq!(
            config
                .name_of("Calm-River-7F2A-Free.Sharehooks.CC.")
                .as_deref(),
            Some("calm-river-7f2a-free")
        );
        assert_eq!(config.name_of("sharehooks.cc"), None);
        assert_eq!(config.name_of("a.b.sharehooks.cc"), None);
        assert_eq!(config.name_of("evil-sharehooks.cc"), None);
        assert_eq!(config.name_of("tunnel.webhooks.cc"), None);
        assert_eq!(config.name_of("tunnel.sharehooks.cc"), None);
        assert_eq!(config.name_of("Tunnel.Sharehooks.cc"), None);
        assert!(config.is_bare_domain("Sharehooks.cc"));
        assert!(!config.is_bare_domain("acme.sharehooks.cc"));
    }
}
