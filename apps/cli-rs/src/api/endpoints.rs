use anyhow::{Context, Result};

use super::ApiClient;
use super::client::Fetched;
use crate::types::{
    CreateEndpointRequest, Endpoint, EndpointList, FavoriteState, UpdateEndpointRequest,
};

impl ApiClient {
    pub async fn create_endpoint(&self, req: &CreateEndpointRequest) -> Result<Fetched<Endpoint>> {
        self.require_auth()?;
        let resp = self.post("/api/endpoints", req).await?;
        resp.parse("endpoint")
    }

    pub async fn list_endpoints(&self) -> Result<Fetched<EndpointList>> {
        self.require_auth()?;
        let resp = self.get("/api/endpoints").await?;
        resp.parse("endpoint list")
    }

    pub async fn get_endpoint(&self, slug: &str) -> Result<Fetched<Endpoint>> {
        self.require_auth()?;
        let resp = self
            .get(&format!("/api/endpoints/{}", urlencoding::encode(slug)))
            .await?;
        resp.parse("endpoint")
    }

    pub async fn update_endpoint(
        &self,
        slug: &str,
        req: &UpdateEndpointRequest,
    ) -> Result<Fetched<Endpoint>> {
        self.require_auth()?;
        let resp = self
            .patch(
                &format!("/api/endpoints/{}", urlencoding::encode(slug)),
                req,
            )
            .await?;
        resp.parse("endpoint")
    }

    pub async fn delete_endpoint(&self, slug: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!("/api/endpoints/{}", urlencoding::encode(slug)))
            .await?;
        Ok(())
    }

    /// Mark (`favorite: true`) or unmark the endpoint as one of the caller's
    /// favourites. Idempotent; answers the state it ended in.
    pub async fn set_endpoint_favorite(&self, slug: &str, favorite: bool) -> Result<FavoriteState> {
        self.require_auth()?;
        let path = favorite_path(slug);
        let resp = if favorite {
            self.put(&path).await?
        } else {
            self.delete(&path).await?
        };
        serde_json::from_str(&resp.body).context("failed to parse favorite state")
    }
}

fn favorite_path(slug: &str) -> String {
    format!("/api/endpoints/{}/favorite", urlencoding::encode(slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorite_path_encodes_the_slug() {
        assert_eq!(
            favorite_path("acme-hooks"),
            "/api/endpoints/acme-hooks/favorite"
        );
        assert_eq!(favorite_path("a/b c"), "/api/endpoints/a%2Fb%20c/favorite");
    }
}
