use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{CreateEndpointRequest, Endpoint, EndpointList, UpdateEndpointRequest};

impl ApiClient {
    pub async fn create_endpoint(&self, req: &CreateEndpointRequest) -> Result<Endpoint> {
        self.require_auth()?;
        let resp = self.post("/api/endpoints", req).await?;
        serde_json::from_str(&resp.body).context("failed to parse endpoint")
    }

    pub async fn list_endpoints(&self) -> Result<EndpointList> {
        self.require_auth()?;
        let resp = self.get("/api/endpoints").await?;
        serde_json::from_str(&resp.body).context("failed to parse endpoint list")
    }

    pub async fn get_endpoint(&self, slug: &str) -> Result<Endpoint> {
        self.require_auth()?;
        let resp = self.get(&format!("/api/endpoints/{}", urlencoding::encode(slug))).await?;
        serde_json::from_str(&resp.body).context("failed to parse endpoint")
    }

    pub async fn update_endpoint(&self, slug: &str, req: &UpdateEndpointRequest) -> Result<Endpoint> {
        self.require_auth()?;
        let resp = self.patch(&format!("/api/endpoints/{}", urlencoding::encode(slug)), req).await?;
        serde_json::from_str(&resp.body).context("failed to parse endpoint")
    }

    pub async fn delete_endpoint(&self, slug: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!("/api/endpoints/{}", urlencoding::encode(slug))).await?;
        Ok(())
    }
}
