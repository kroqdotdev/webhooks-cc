// Self-update: check GitHub releases, download, verify, replace binary.
// Implemented in Phase 4 — this is a placeholder for module resolution.

use super::ApiClient;

impl ApiClient {
    pub async fn check_update(&self, _current_version: &str) -> anyhow::Result<Option<String>> {
        // TODO: Phase 4
        Ok(None)
    }
}
